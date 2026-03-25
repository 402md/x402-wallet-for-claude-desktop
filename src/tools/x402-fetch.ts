import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AppConfig, PaymentNetwork } from '@/types.js'
import type { SpendingTracker } from '@/spending.js'
import { createHttpClient, isStellarNetwork, isEvmNetwork } from '@/clients.js'

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
        const paymentRequired: PaymentRequiredBody =
          await initialResponse.json()

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
        const accept = paymentRequired.accepts.find(a => {
          const net = caip2ToNetwork(a.network)
          if (!net) return false
          if (isStellarNetwork(net) && config.canPayStellar) return true
          if (isEvmNetwork(net) && config.canPayEvm) return true
          return false
        })

        if (!accept) {
          const networks = paymentRequired.accepts
            .map(a => a.network)
            .join(', ')
          return {
            content: [
              {
                type: 'text' as const,
                text: `Cannot fulfill payment. Server accepts networks: [${networks}] but wallet is not configured for any of them.`
              }
            ],
            isError: true
          }
        }

        const network = caip2ToNetwork(accept.network)!
        const usdcAmount = atomicToUsdc(accept.amount, network)

        // Step 4: Check spending limits
        spending.check(usdcAmount)

        // Step 5: Sign the payment
        const httpClient = await createHttpClient(network, config)
        const payload = await httpClient.createPaymentPayload(paymentRequired)
        const paymentHeaders = httpClient.encodePaymentSignatureHeader(payload)
        const paymentHeader =
          paymentHeaders['X-PAYMENT'] ?? paymentHeaders['x-payment']

        if (!paymentHeader) {
          throw new Error('Failed to generate payment header')
        }

        // Step 6: Retry the request with the payment header
        const retryOptions: RequestInit = {
          method,
          headers: {
            ...(headers ?? {}),
            'X-PAYMENT': paymentHeader
          }
        }
        if (body && method !== 'GET') {
          retryOptions.body = body
        }

        const paidResponse = await fetch(url, retryOptions)
        const paidBody = await paidResponse.text()

        // Step 7: Record the spending
        spending.record(usdcAmount, accept.payTo, network)

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
                    amount: `${usdcAmount} USDC`,
                    recipient: accept.payTo,
                    network
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
