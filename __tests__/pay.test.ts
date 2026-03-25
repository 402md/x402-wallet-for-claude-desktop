import { describe, it, expect, vi, beforeEach } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AppConfig } from '../src/types.js'
import { SpendingTracker } from '../src/spending.js'
import { registerPay } from '../src/tools/pay.js'

const mockCreatePaymentPayload = vi.fn()
const mockEncodePaymentSignatureHeader = vi.fn()

vi.mock('../src/clients.js', () => ({
  createHttpClient: vi.fn().mockResolvedValue({
    createPaymentPayload: (...args: unknown[]) =>
      mockCreatePaymentPayload(...args),
    encodePaymentSignatureHeader: (...args: unknown[]) =>
      mockEncodePaymentSignatureHeader(...args)
  }),
  getCaip2Network: vi.fn((net: string) => {
    const map: Record<string, string> = {
      stellar: 'stellar:pubnet',
      'stellar-testnet': 'stellar:testnet',
      base: 'eip155:8453',
      'base-sepolia': 'eip155:84532'
    }
    return map[net]
  }),
  isStellarNetwork: vi.fn((net: string) => net.startsWith('stellar')),
  isEvmNetwork: vi.fn((net: string) => net.startsWith('base'))
}))

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

function extractToolHandler(
  server: McpServer
): (...args: unknown[]) => Promise<unknown> {
  const calls = vi.mocked(server.tool).mock.calls
  const call = calls.find(c => c[0] === 'pay')
  return call![call!.length - 1] as (...args: unknown[]) => Promise<unknown>
}

describe('pay tool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers the tool with correct name', () => {
    const server = { tool: vi.fn() } as unknown as McpServer
    const config = makeConfig()
    const spending = new SpendingTracker(config.budget)
    registerPay(server, config, spending)
    expect(server.tool).toHaveBeenCalledWith(
      'pay',
      expect.any(String),
      expect.any(Object),
      expect.any(Function)
    )
  })

  it('returns error when no wallet configured', async () => {
    const server = { tool: vi.fn() } as unknown as McpServer
    const config = makeConfig({ canPay: false })
    const spending = new SpendingTracker(config.budget)
    registerPay(server, config, spending)

    const handler = extractToolHandler(server)
    const result = (await handler({
      amount: '0.05',
      recipient: 'GABC...',
      network: 'stellar-testnet'
    })) as { isError: boolean; content: { text: string }[] }

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('No wallet configured')
  })

  it('returns error when stellar key not configured for stellar network', async () => {
    const server = { tool: vi.fn() } as unknown as McpServer
    const config = makeConfig({
      canPay: true,
      canPayEvm: true,
      canPayStellar: false,
      evmPrivateKey: '0xabc',
      mode: 'EVM_ONLY'
    })
    const spending = new SpendingTracker(config.budget)
    registerPay(server, config, spending)

    const handler = extractToolHandler(server)
    const result = (await handler({
      amount: '0.05',
      recipient: 'GABC...',
      network: 'stellar-testnet'
    })) as { isError: boolean; content: { text: string }[] }

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Stellar key not configured')
  })

  it('returns error when evm key not configured for base network', async () => {
    const server = { tool: vi.fn() } as unknown as McpServer
    const config = makeConfig({
      canPay: true,
      canPayStellar: true,
      canPayEvm: false,
      stellarSecret: 'STEST...',
      mode: 'STELLAR_ONLY'
    })
    const spending = new SpendingTracker(config.budget)
    registerPay(server, config, spending)

    const handler = extractToolHandler(server)
    const result = (await handler({
      amount: '0.05',
      recipient: '0xABC...',
      network: 'base-sepolia'
    })) as { isError: boolean; content: { text: string }[] }

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('EVM key not configured')
  })

  it('rejects payment exceeding per-call budget', async () => {
    const server = { tool: vi.fn() } as unknown as McpServer
    const config = makeConfig({
      canPay: true,
      canPayStellar: true,
      stellarSecret: 'STEST...',
      mode: 'STELLAR_ONLY',
      budget: { maxPerCall: '0.01', maxPerDay: '20.00' }
    })
    const spending = new SpendingTracker(config.budget)
    registerPay(server, config, spending)

    const handler = extractToolHandler(server)
    const result = (await handler({
      amount: '0.50',
      recipient: 'GABC...',
      network: 'stellar-testnet'
    })) as { isError: boolean; content: { text: string }[] }

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('exceeds per-call limit')
  })

  it('returns payment header on success', async () => {
    const mockPayload = { x402Version: 2, payload: 'signed-data' }
    mockCreatePaymentPayload.mockResolvedValue(mockPayload)
    mockEncodePaymentSignatureHeader.mockReturnValue({
      'PAYMENT-SIGNATURE': 'base64-payment-header-value'
    })

    const server = { tool: vi.fn() } as unknown as McpServer
    const config = makeConfig({
      canPay: true,
      canPayStellar: true,
      stellarSecret: 'STEST...',
      mode: 'STELLAR_ONLY'
    })
    const spending = new SpendingTracker(config.budget)
    registerPay(server, config, spending)

    const handler = extractToolHandler(server)
    const result = (await handler({
      amount: '0.05',
      recipient: 'GABC...',
      network: 'stellar-testnet',
      resource: 'https://api.example.com/data'
    })) as { content: { text: string }[] }

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.paymentHeader).toBe('base64-payment-header-value')
    expect(parsed.headerName).toBe('PAYMENT-SIGNATURE')
    expect(parsed.amount).toBe('0.05 USDC')
    expect(parsed.recipient).toBe('GABC...')
    expect(parsed.network).toBe('stellar-testnet')
    expect(parsed.hint).toContain('PAYMENT-SIGNATURE')
  })

  it('records spending after successful payment', async () => {
    mockCreatePaymentPayload.mockResolvedValue({
      x402Version: 2,
      payload: 'data'
    })
    mockEncodePaymentSignatureHeader.mockReturnValue({
      'PAYMENT-SIGNATURE': 'header-value'
    })

    const server = { tool: vi.fn() } as unknown as McpServer
    const config = makeConfig({
      canPay: true,
      canPayStellar: true,
      stellarSecret: 'STEST...',
      mode: 'STELLAR_ONLY'
    })
    const spending = new SpendingTracker(config.budget)
    registerPay(server, config, spending)

    const handler = extractToolHandler(server)
    await handler({
      amount: '0.05',
      recipient: 'GABC...',
      network: 'stellar-testnet'
    })

    const summary = spending.getSummary()
    expect(parseFloat(summary.spentSession)).toBeCloseTo(0.05)
    expect(summary.recentPayments).toHaveLength(1)
    expect(summary.recentPayments[0].recipient).toBe('GABC...')
  })

  it('includes areFeesSponsored in extra for Stellar networks', async () => {
    mockCreatePaymentPayload.mockResolvedValue({
      x402Version: 2,
      payload: 'data'
    })
    mockEncodePaymentSignatureHeader.mockReturnValue({
      'PAYMENT-SIGNATURE': 'header-value'
    })

    const server = { tool: vi.fn() } as unknown as McpServer
    const config = makeConfig({
      canPay: true,
      canPayStellar: true,
      stellarSecret: 'STEST...',
      mode: 'STELLAR_ONLY'
    })
    const spending = new SpendingTracker(config.budget)
    registerPay(server, config, spending)

    const handler = extractToolHandler(server)
    await handler({
      amount: '0.05',
      recipient: 'GABC...',
      network: 'stellar-testnet'
    })

    // Verify createPaymentPayload was called with areFeesSponsored in extra
    const paymentRequired = mockCreatePaymentPayload.mock.calls[0][0]
    expect(paymentRequired.accepts[0].extra).toEqual({
      areFeesSponsored: true
    })
  })

  it('includes EIP-712 domain params in extra for EVM networks', async () => {
    mockCreatePaymentPayload.mockResolvedValue({
      x402Version: 2,
      payload: 'data'
    })
    mockEncodePaymentSignatureHeader.mockReturnValue({
      'PAYMENT-SIGNATURE': 'header-value'
    })

    const server = { tool: vi.fn() } as unknown as McpServer
    const config = makeConfig({
      canPay: true,
      canPayEvm: true,
      evmPrivateKey: '0xabc',
      mode: 'EVM_ONLY'
    })
    const spending = new SpendingTracker(config.budget)
    registerPay(server, config, spending)

    const handler = extractToolHandler(server)
    await handler({
      amount: '0.05',
      recipient: '0xRecipient',
      network: 'base-sepolia'
    })

    const paymentRequired = mockCreatePaymentPayload.mock.calls[0][0]
    expect(paymentRequired.accepts[0].extra).toEqual({
      name: 'USDC',
      version: '2'
    })
  })

  it('returns error when payment signing fails', async () => {
    mockCreatePaymentPayload.mockRejectedValue(new Error('Signing failed'))

    const server = { tool: vi.fn() } as unknown as McpServer
    const config = makeConfig({
      canPay: true,
      canPayStellar: true,
      stellarSecret: 'STEST...',
      mode: 'STELLAR_ONLY'
    })
    const spending = new SpendingTracker(config.budget)
    registerPay(server, config, spending)

    const handler = extractToolHandler(server)
    const result = (await handler({
      amount: '0.05',
      recipient: 'GABC...',
      network: 'stellar-testnet'
    })) as { isError: boolean; content: { text: string }[] }

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Signing failed')
  })

  it('does not record spending when payment fails', async () => {
    mockCreatePaymentPayload.mockRejectedValue(new Error('fail'))

    const server = { tool: vi.fn() } as unknown as McpServer
    const config = makeConfig({
      canPay: true,
      canPayStellar: true,
      stellarSecret: 'STEST...',
      mode: 'STELLAR_ONLY'
    })
    const spending = new SpendingTracker(config.budget)
    registerPay(server, config, spending)

    const handler = extractToolHandler(server)
    await handler({
      amount: '0.05',
      recipient: 'GABC...',
      network: 'stellar-testnet'
    })

    const summary = spending.getSummary()
    expect(parseFloat(summary.spentSession)).toBe(0)
    expect(summary.recentPayments).toHaveLength(0)
  })
})
