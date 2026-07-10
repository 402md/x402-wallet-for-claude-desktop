import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AppConfig, PaymentNetwork } from '@/types.js'
import type { SpendingTracker } from '@/spending.js'
import { createHttpClient, isStellarNetwork, isEvmNetwork } from '@/clients.js'
import { ensurePermit2Allowance } from '@/permit2.js'
import type { EnsurePermit2Result } from '@/permit2.js'

interface PaymentAccept {
  scheme: string
  network: `${string}:${string}`
  asset: string
  amount: string
  payTo: string
  maxTimeoutSeconds: number
  extra: Record<string, unknown>
}

interface PaymentRequiredBody {
  x402Version: number
  error: string
  resource: { url: string; description: string; mimeType: string }
  accepts: PaymentAccept[]
  extensions?: Record<string, unknown>
}

const CAIP2_TO_NETWORK: Record<string, PaymentNetwork> = {
  'stellar:pubnet': 'stellar',
  'stellar:testnet': 'stellar-testnet',
  'eip155:8453': 'base',
  'eip155:84532': 'base-sepolia'
}

function caip2ToNetwork(caip2: string): PaymentNetwork | undefined {
  return CAIP2_TO_NETWORK[caip2]
}

function atomicToUsdc(atomicAmount: string, network: PaymentNetwork): string {
  const decimals = isStellarNetwork(network) ? 7 : 6
  const raw = BigInt(atomicAmount)
  const whole = raw / BigInt(10 ** decimals)
  const frac = raw % BigInt(10 ** decimals)
  return `${whole}.${frac.toString().padStart(decimals, '0')}`
}

function isSchemeSupported(scheme: string, network: PaymentNetwork): boolean {
  if (scheme === 'exact') return true
  // upto settles through Permit2, which only exists on EVM networks
  if (scheme === 'upto') return isEvmNetwork(network)
  return false
}

const GASLESS_EXTENSION_KEYS = [
  'eip2612GasSponsoring',
  'erc20ApprovalGasSponsoring'
]

function hasGaslessExtension(extensions?: Record<string, unknown>): boolean {
  if (!extensions) return false
  return GASLESS_EXTENSION_KEYS.some(key => key in extensions)
}

export function registerX402Fetch(
  server: McpServer,
  config: AppConfig,
  spending: SpendingTracker
): void {
  server.tool(
    'x402_fetch',
    'Fetch a URL with automatic x402 payment. Makes the HTTP request, and if the server responds with 402 Payment Required, automatically signs the USDC payment and retries with the X-PAYMENT header. Returns the final response.',
    {
      url: z.string().url().describe('The URL to fetch'),
      method: z
        .enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
        .default('GET')
        .describe('HTTP method (default: GET)'),
      headers: z
        .record(z.string())
        .optional()
        .describe('Optional HTTP headers as key-value pairs'),
      body: z.string().optional().describe('Optional request body')
    },
    async ({ url, method, headers, body }) => {
      if (!config.canPay) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No wallet configured. Set STELLAR_SECRET or EVM_PRIVATE_KEY environment variable.'
            }
          ],
          isError: true
        }
      }

      try {
        // Step 1: Make the initial request
        const fetchOptions: RequestInit = {
          method,
          headers: headers ?? {}
        }
        if (body && method !== 'GET') {
          fetchOptions.body = body
        }

        const initialResponse = await fetch(url, fetchOptions)

        // If not 402, return the response directly
        if (initialResponse.status !== 402) {
          const responseBody = await initialResponse.text()
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    status: initialResponse.status,
                    statusText: initialResponse.statusText,
                    body: responseBody
                  },
                  null,
                  2
                )
              }
            ]
          }
        }

        // Step 2: Parse the 402 Payment Required response
        // x402 v2 sends payment info in the Payment-Required header (base64-encoded JSON)
        // Fall back to the response body for backwards compatibility
        let paymentRequired: PaymentRequiredBody

        const paymentRequiredHeader =
          initialResponse.headers.get('Payment-Required')

        if (paymentRequiredHeader) {
          const decoded = Buffer.from(paymentRequiredHeader, 'base64').toString(
            'utf-8'
          )
          paymentRequired = JSON.parse(decoded)
        } else {
          paymentRequired = await initialResponse.json()
        }

        if (!paymentRequired.accepts || paymentRequired.accepts.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Server returned 402 but no payment options were provided.'
              }
            ],
            isError: true
          }
        }

        // Step 3: Find a payment option we can fulfill
        // (server preference order, filtered by scheme + network support)
        const accept = paymentRequired.accepts.find(a => {
          const net = caip2ToNetwork(a.network)
          if (!net) return false
          if (!isSchemeSupported(a.scheme, net)) return false
          if (isStellarNetwork(net) && config.canPayStellar) return true
          if (isEvmNetwork(net) && config.canPayEvm) return true
          return false
        })

        if (!accept) {
          const options = paymentRequired.accepts
            .map(a => `${a.network}/${a.scheme}`)
            .join(', ')
          return {
            content: [
              {
                type: 'text' as const,
                text: `Cannot fulfill payment. Server accepts: [${options}] but wallet supports none of them.`
              }
            ],
            isError: true
          }
        }

        const network = caip2ToNetwork(accept.network)!
        const usdcAmount = atomicToUsdc(accept.amount, network)

        if (
          accept.scheme === 'upto' &&
          typeof accept.extra?.facilitatorAddress !== 'string'
        ) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Server offered an upto payment but the accept is missing extra.facilitatorAddress, which the upto scheme requires.'
              }
            ],
            isError: true
          }
        }

        // Step 4: Check spending limits (for upto this is the authorized maximum)
        spending.check(usdcAmount)

        // Step 4b: upto settles via Permit2 — make sure the one-time
        // USDC approval exists (auto-approve unless the server sponsors it)
        let permit2: EnsurePermit2Result | undefined
        if (accept.scheme === 'upto' && isEvmNetwork(network)) {
          permit2 = await ensurePermit2Allowance({
            network,
            config,
            asset: accept.asset as `0x${string}`,
            requiredAmount: BigInt(accept.amount),
            gaslessDeclared: hasGaslessExtension(paymentRequired.extensions)
          })
        }

        // Step 5: Sign the payment — only the accept we validated against
        // the budget, so the SDK cannot pick a different option
        const httpClient = await createHttpClient(network, config)
        const payload = await httpClient.createPaymentPayload({
          ...paymentRequired,
          accepts: [accept]
        })
        const signatureHeaders =
          httpClient.encodePaymentSignatureHeader(payload)

        if (!signatureHeaders || Object.keys(signatureHeaders).length === 0) {
          throw new Error('Failed to generate payment header')
        }

        // Step 6: Retry the request with the payment header
        // v1 returns X-PAYMENT, v2 returns PAYMENT-SIGNATURE
        const retryOptions: RequestInit = {
          method,
          headers: {
            ...(headers ?? {}),
            ...signatureHeaders
          }
        }
        if (body && method !== 'GET') {
          retryOptions.body = body
        }

        const paidResponse = await fetch(url, retryOptions)
        const paidBody = await paidResponse.text()

        // Step 7: Decode the settlement response — for upto the server
        // reports the actual settled amount (≤ the authorized maximum)
        let settle:
          | { success: boolean; transaction: string; amount?: string }
          | undefined
        try {
          settle = httpClient.getPaymentSettleResponse(name =>
            paidResponse.headers.get(name)
          )
        } catch {
          settle = undefined
        }

        const settledUsdc =
          settle?.success && settle.amount
            ? atomicToUsdc(settle.amount, network)
            : usdcAmount

        // Step 8: Record the spending (actual settled amount when known;
        // falls back to the authorized maximum, which never undercounts)
        spending.record(settledUsdc, accept.payTo, network, {
          scheme: accept.scheme,
          authorizedAmount: accept.scheme === 'upto' ? usdcAmount : undefined
        })

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  status: paidResponse.status,
                  statusText: paidResponse.statusText,
                  body: paidBody,
                  payment: {
                    scheme: accept.scheme,
                    amount: `${settledUsdc} USDC`,
                    authorized: `${usdcAmount} USDC`,
                    settled:
                      settle?.success && settle.amount
                        ? `${settledUsdc} USDC`
                        : null,
                    recipient: accept.payTo,
                    network,
                    transaction: settle?.transaction ?? null,
                    permit2Approval: permit2?.approvalTxHash ?? null
                  }
                },
                null,
                2
              )
            }
          ]
        }
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `x402 fetch failed: ${err instanceof Error ? err.message : String(err)}`
            }
          ],
          isError: true
        }
      }
    }
  )
}
