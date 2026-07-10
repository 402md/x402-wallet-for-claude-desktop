import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AppConfig } from '@/types.js'
import { getWalletAddress, getUsdcBalance } from '@/clients.js'

export function registerCheckBalance(
  server: McpServer,
  config: AppConfig
): void {
  server.tool(
    'check_balance',
    'Check USDC balance and wallet address on the configured network (Stellar, Base, or Solana).',
    {},
    async () => {
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

      try {
        const address = await getWalletAddress(config.network, config)
        const balance = await getUsdcBalance(config.network, config)

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  address,
                  balance: `${balance} USDC`,
                  network: config.network,
                  mode: config.mode
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
              text: `Error: ${err instanceof Error ? err.message : String(err)}`
            }
          ],
          isError: true
        }
      }
    }
  )
}
