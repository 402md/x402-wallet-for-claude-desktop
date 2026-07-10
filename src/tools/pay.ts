import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AppConfig } from '@/types.js'
import type { SpendingTracker } from '@/spending.js'
import {
  createHttpClient,
  getCaip2Network,
  isStellarNetwork,
  isEvmNetwork,
  isSolanaNetwork
} from '@/clients.js'
import { ensurePermit2Allowance } from '@/permit2.js'
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
        .describe(
          'Recipient address (EVM 0x..., Stellar G.../C..., or Solana)'
        ),
      network: z
        .enum([
          'stellar',
          'stellar-testnet',
          'base',
          'base-sepolia',
          'solana',
          'solana-devnet'
        ])
        .describe('Payment network'),
      resource: z
        .string()
        .optional()
        .describe('URL of the resource being paid for'),
      scheme: z
        .enum(['exact', 'upto', 'auth-capture'])
        .default('exact')
        .describe(
          'Payment scheme. "exact" transfers the exact amount; "upto" authorizes a maximum that the server settles against actual usage (EVM only); "auth-capture" authorizes a hold that the server captures later (EVM only). For "upto" and "auth-capture", pass the accept\'s extra exactly as received.'
        ),
      extra: z
        .record(z.unknown())
        .optional()
        .describe(
          'Optional extra metadata from accepts[0].extra in the PAYMENT-REQUIRED header. Must be passed through exactly as received and included in the signed payload. Required for the "upto" and "auth-capture" schemes, and for Solana (needs feePayer).'
        )
    },
    async ({
      amount,
      recipient,
      network,
      resource,
      scheme = 'exact',
      extra
    }) => {
      if (!config.canPay) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No wallet configured. Set STELLAR_SECRET, EVM_PRIVATE_KEY, or SOLANA_SECRET environment variable.'
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

      if (isSolanaNetwork(net) && !config.canPaySolana) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Solana key not configured. Set SOLANA_SECRET to pay on Solana.'
            }
          ],
          isError: true
        }
      }

      if (scheme !== 'exact' && !isEvmNetwork(net)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `The ${scheme} scheme is only supported on EVM networks (base, base-sepolia).`
            }
          ],
          isError: true
        }
      }

      if (scheme === 'upto' && typeof extra?.facilitatorAddress !== 'string') {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'The upto scheme requires extra.facilitatorAddress. Pass the accept\'s "extra" object exactly as received in the PAYMENT-REQUIRED header.'
            }
          ],
          isError: true
        }
      }

      if (scheme === 'auth-capture' && !extra) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'The auth-capture scheme requires the accept\'s "extra" object (captureAuthorizer, feeRecipient, deadlines, fee bps). Pass it exactly as received in the PAYMENT-REQUIRED header.'
            }
          ],
          isError: true
        }
      }

      if (isSolanaNetwork(net) && typeof extra?.feePayer !== 'string') {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Solana payments require extra.feePayer (the facilitator fee payer). Pass the accept\'s "extra" object exactly as received in the PAYMENT-REQUIRED header.'
            }
          ],
          isError: true
        }
      }

      try {
        spending.check(amount)

        // upto settles via Permit2 — make sure the one-time USDC approval
        // exists. The manual flow cannot see the server's extensions, so
        // never assume gasless sponsorship here.
        if (scheme === 'upto') {
          await ensurePermit2Allowance({
            network: net,
            config,
            asset: getAssetAddress(net) as `0x${string}`,
            requiredAmount: BigInt(toAtomicUnits(amount, net)),
            gaslessDeclared: false
          })
        }

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
              scheme,
              network: caip2,
              asset: getAssetAddress(net),
              amount: toAtomicUnits(amount, net),
              payTo: recipient,
              maxTimeoutSeconds: 300,
              // For upto/auth-capture the caller's extra is mandatory
              // (validated above); the EIP-712 defaults only fit exact
              extra: scheme !== 'exact' ? extra! : (extra ?? getExtra(net))
            }
          ]
        }

        const payload = await httpClient.createPaymentPayload(paymentRequired)
        const signatureHeaders =
          httpClient.encodePaymentSignatureHeader(payload)

        if (!signatureHeaders || Object.keys(signatureHeaders).length === 0) {
          throw new Error('Failed to generate payment header')
        }

        spending.record(amount, recipient, network, {
          scheme,
          authorizedAmount: scheme !== 'exact' ? amount : undefined
        })

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
                  scheme,
                  amount: `${amount} USDC`,
                  recipient,
                  network,
                  resource: resource ?? null,
                  hint: `Set this as the ${headerName} header in your HTTP request.`,
                  ...(scheme !== 'exact'
                    ? {
                        note:
                          scheme === 'upto'
                            ? 'This authorizes UP TO this amount; the server settles the actual usage. The full maximum was recorded against your budget since the settled value is unknown for manual payments.'
                            : 'This authorizes a HOLD up to this amount; the server captures the actual charge later. The full maximum was recorded against your budget.'
                      }
                    : {})
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
    'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    solana: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'solana-devnet': '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
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
    'stellar-testnet': { name: '', version: '' },
    solana: { name: '', version: '' },
    'solana-devnet': { name: '', version: '' }
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
