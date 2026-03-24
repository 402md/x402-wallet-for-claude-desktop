import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AppConfig } from '@/types.js'
import { SpendingTracker } from '@/spending.js'
import { registerCheckBalance } from '@/tools/check-balance.js'
import { registerPay } from '@/tools/pay.js'

export function createMcpServer(config: AppConfig): McpServer {
  const server = new McpServer({
    name: 'x402-wallet',
    version: '0.1.0'
  })

  const spending = new SpendingTracker(config.budget)

  registerCheckBalance(server, config)
  registerPay(server, config, spending)

  return server
}
