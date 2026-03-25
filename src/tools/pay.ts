import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AppConfig } from '@/types.js'
import type { SpendingTracker } from '@/spending.js'
import {
  createHttpClient,
  getCaip2Network,
  isStellarNetwork,
  isEvmNetwork
} from '@/clients.js'
import type { PaymentNetwork } from '@/types.js'

export function registerPay(
  server: McpServer,
  config: AppConfig,
  spending: SpendingTracker
): void {
  server.tool(
    'pay',
    'Sign and create an x402 payment header (USDC transfer authorization). Returns the X-PAYMENT header value to attach to your HTTP request.',
    {
      amount: z.string().describe('USDC amount as decimal string, e.g. "0.05"'),
      recipient: z
        .string()
        .describe('Recipient address (EVM 0x... or Stellar G.../C...)'),
      network: z
        .enum(['stellar', 'stellar-testnet', 'base', 'base-sepolia'])
        .describe('Payment network'),
      resource: z
        .string()
        .optional()
        .describe('URL of the resource being paid for')
    },
    async ({ amount, recipient, network, resource }) => {
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

      const net = network as PaymentNetwork

      if (isStellarNetwork(net) && !config.canPayStellar) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Stellar key not configured. Set STELLAR_SECRET to pay on Stellar.'
            }
          ],
          isError: true
        }
      }

      if (isEvmNetwork(net) && !config.canPayEvm) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'EVM key not configured. Set EVM_PRIVATE_KEY to pay on Base.'
            }
          ],
          isError: true
        }
      }

      try {
        spending.check(amount)

        const httpClient = await createHttpClient(net, config)
        const caip2 = getCaip2Network(net) as `${string}:${string}`

        // Build a PaymentRequired response as the server would send it
        const paymentRequired = {
          x402Version: 2,
          error: '',
          resource: {
            url: resource ?? '',
            description: '',
            mimeType: ''
          },
          accepts: [
            {
              scheme: 'exact',
              network: caip2,
              asset: getAssetAddress(net),
              amount: toAtomicUnits(amount, net),
              payTo: recipient,
              maxTimeoutSeconds: 300,
              extra: getExtra(net)
            }
          ]
        }

        const payload = await httpClient.createPaymentPayload(paymentRequired)
        const signatureHeaders =
          httpClient.encodePaymentSignatureHeader(payload)

        if (!signatureHeaders || Object.keys(signatureHeaders).length === 0) {
          throw new Error('Failed to generate payment header')
        }

        spending.record(amount, recipient, network)

        // v1 returns X-PAYMENT, v2 returns PAYMENT-SIGNATURE
        const [[headerName, headerValue]] = Object.entries(signatureHeaders)

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  paymentHeader: headerValue,
                  headerName,
                  amount: `${amount} USDC`,
                  recipient,
                  network,
                  resource: resource ?? null,
                  hint: `Set this as the ${headerName} header in your HTTP request.`
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
              text: `Payment failed: ${err instanceof Error ? err.message : String(err)}`
            }
          ],
          isError: true
        }
      }
    }
  )
}

function getAssetAddress(network: PaymentNetwork): string {
  const addresses: Record<PaymentNetwork, string> = {
    stellar: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
    'stellar-testnet':
      'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
  }
  return addresses[network]
}

function getExtra(network: PaymentNetwork): Record<string, unknown> {
  if (isStellarNetwork(network)) {
    return { areFeesSponsored: true }
  }
  // EIP-712 domain params required by signEIP3009Authorization
  const eip712: Record<PaymentNetwork, { name: string; version: string }> = {
    base: { name: 'USD Coin', version: '2' },
    'base-sepolia': { name: 'USDC', version: '2' },
    stellar: { name: '', version: '' },
    'stellar-testnet': { name: '', version: '' }
  }
  return eip712[network]
}

function toAtomicUnits(amount: string, network: PaymentNetwork): string {
  const decimals = isStellarNetwork(network) ? 7 : 6
  const parts = amount.split('.')
  const whole = parts[0] || '0'
  const frac = (parts[1] || '').padEnd(decimals, '0').slice(0, decimals)
  return (BigInt(whole) * BigInt(10 ** decimals) + BigInt(frac)).toString()
}
