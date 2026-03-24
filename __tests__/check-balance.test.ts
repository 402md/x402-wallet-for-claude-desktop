import { describe, it, expect, vi, beforeEach } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AppConfig } from '../src/types.js'
import { registerCheckBalance } from '../src/tools/check-balance.js'

vi.mock('../src/clients.js', () => ({
  getWalletAddress: vi.fn(),
  getUsdcBalance: vi.fn()
}))

import { getWalletAddress, getUsdcBalance } from '../src/clients.js'

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    stellarSecret: undefined,
    evmPrivateKey: undefined,
    network: 'stellar-testnet',
    budget: { maxPerCall: '1.00', maxPerDay: '20.00' },
    canPay: false,
    canPayStellar: false,
    canPayEvm: false,
    mode: 'READ_ONLY',
    reload: vi.fn(),
    ...overrides
  }
}

// Extract the tool handler from McpServer
function extractToolHandler(
  server: McpServer
): (...args: unknown[]) => Promise<unknown> {
  const calls = vi.mocked(server.tool).mock.calls
  const call = calls.find(c => c[0] === 'check_balance')
  // Handler is the last argument
  return call![call!.length - 1] as (...args: unknown[]) => Promise<unknown>
}

describe('check_balance tool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers the tool with correct name', () => {
    const server = { tool: vi.fn() } as unknown as McpServer
    const config = makeConfig()
    registerCheckBalance(server, config)
    expect(server.tool).toHaveBeenCalledWith(
      'check_balance',
      expect.any(String),
      expect.any(Object),
      expect.any(Function)
    )
  })

  it('returns error when no wallet configured', async () => {
    const server = { tool: vi.fn() } as unknown as McpServer
    const config = makeConfig({ canPay: false })
    registerCheckBalance(server, config)

    const handler = extractToolHandler(server)
    const result = (await handler({})) as {
      isError: boolean
      content: { text: string }[]
    }

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('No wallet configured')
  })

  it('returns balance and address on success', async () => {
    vi.mocked(getWalletAddress).mockResolvedValue('GABC...XYZ')
    vi.mocked(getUsdcBalance).mockResolvedValue('100.5000000')

    const server = { tool: vi.fn() } as unknown as McpServer
    const config = makeConfig({
      canPay: true,
      canPayStellar: true,
      stellarSecret: 'STEST...',
      mode: 'STELLAR_ONLY'
    })
    registerCheckBalance(server, config)

    const handler = extractToolHandler(server)
    const result = (await handler({})) as { content: { text: string }[] }

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.address).toBe('GABC...XYZ')
    expect(parsed.balance).toBe('100.5000000 USDC')
    expect(parsed.network).toBe('stellar-testnet')
    expect(parsed.mode).toBe('STELLAR_ONLY')
  })

  it('returns error when balance fetch fails', async () => {
    vi.mocked(getWalletAddress).mockRejectedValue(new Error('Network error'))

    const server = { tool: vi.fn() } as unknown as McpServer
    const config = makeConfig({
      canPay: true,
      canPayStellar: true,
      stellarSecret: 'STEST...'
    })
    registerCheckBalance(server, config)

    const handler = extractToolHandler(server)
    const result = (await handler({})) as {
      isError: boolean
      content: { text: string }[]
    }

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Network error')
  })
})
