import { describe, it, expect, vi, beforeEach } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AppConfig } from '../src/types.js'
import { SpendingTracker } from '../src/spending.js'
import { registerPay } from '../src/tools/pay.js'

const mockCreatePaymentPayload = vi.fn()
const mockEncodePaymentSignatureHeader = vi.fn()
const mockEnsurePermit2 = vi.fn()

vi.mock('../src/permit2.js', () => ({
  ensurePermit2Allowance: (...args: unknown[]) => mockEnsurePermit2(...args)
}))

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
      'base-sepolia': 'eip155:84532',
      solana: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      'solana-devnet': 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
    }
    return map[net]
  }),
  isStellarNetwork: vi.fn((net: string) => net.startsWith('stellar')),
  isEvmNetwork: vi.fn((net: string) => net.startsWith('base')),
  isSolanaNetwork: vi.fn((net: string) => net.startsWith('solana'))
}))

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    stellarSecret: undefined,
    evmPrivateKey: undefined,
    solanaSecret: undefined,
    network: 'stellar-testnet',
    budget: { maxPerCall: '1.00', maxPerDay: '20.00' },
    canPay: false,
    canPayStellar: false,
    canPayEvm: false,
    canPaySolana: false,
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
    mockEnsurePermit2.mockResolvedValue({ status: 'sufficient' })
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

  describe('upto scheme', () => {
    function evmConfig(): AppConfig {
      return makeConfig({
        canPay: true,
        canPayEvm: true,
        evmPrivateKey: '0xabc',
        mode: 'EVM_ONLY'
      })
    }

    it('signs an upto payment and records the authorized maximum', async () => {
      mockCreatePaymentPayload.mockResolvedValue({
        x402Version: 2,
        payload: 'data'
      })
      mockEncodePaymentSignatureHeader.mockReturnValue({
        'PAYMENT-SIGNATURE': 'header-value'
      })

      const server = { tool: vi.fn() } as unknown as McpServer
      const config = evmConfig()
      const spending = new SpendingTracker(config.budget)
      registerPay(server, config, spending)

      const handler = extractToolHandler(server)
      const result = (await handler({
        amount: '0.05',
        recipient: '0xRecipient',
        network: 'base-sepolia',
        scheme: 'upto',
        extra: { facilitatorAddress: '0xFacilitator', foo: 'bar' }
      })) as { content: { text: string }[] }

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.scheme).toBe('upto')
      expect(parsed.paymentHeader).toBe('header-value')
      expect(parsed.note).toContain('UP TO')

      // the caller's extra is passed through exactly
      const paymentRequired = mockCreatePaymentPayload.mock.calls[0][0]
      expect(paymentRequired.accepts[0].scheme).toBe('upto')
      expect(paymentRequired.accepts[0].extra).toEqual({
        facilitatorAddress: '0xFacilitator',
        foo: 'bar'
      })

      // manual flow never assumes gasless sponsorship
      expect(mockEnsurePermit2).toHaveBeenCalledWith(
        expect.objectContaining({
          requiredAmount: 50000n,
          gaslessDeclared: false
        })
      )

      const summary = spending.getSummary()
      expect(parseFloat(summary.spentSession)).toBeCloseTo(0.05)
      expect(summary.recentPayments[0].scheme).toBe('upto')
      expect(summary.recentPayments[0].authorizedAmount).toBe('0.05')
    })

    it('rejects upto without facilitatorAddress in extra', async () => {
      const server = { tool: vi.fn() } as unknown as McpServer
      const config = evmConfig()
      const spending = new SpendingTracker(config.budget)
      registerPay(server, config, spending)

      const handler = extractToolHandler(server)
      const result = (await handler({
        amount: '0.05',
        recipient: '0xRecipient',
        network: 'base-sepolia',
        scheme: 'upto'
      })) as { isError: boolean; content: { text: string }[] }

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('facilitatorAddress')
      expect(mockEnsurePermit2).not.toHaveBeenCalled()
      expect(mockCreatePaymentPayload).not.toHaveBeenCalled()
    })

    it('rejects upto on Stellar networks', async () => {
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
        scheme: 'upto',
        extra: { facilitatorAddress: 'GFAC...' }
      })) as { isError: boolean; content: { text: string }[] }

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('EVM networks')
    })

    it('does not record spending when the Permit2 approval fails', async () => {
      mockEnsurePermit2.mockRejectedValue(
        new Error('wallet has no ETH on base-sepolia to pay for gas')
      )

      const server = { tool: vi.fn() } as unknown as McpServer
      const config = evmConfig()
      const spending = new SpendingTracker(config.budget)
      registerPay(server, config, spending)

      const handler = extractToolHandler(server)
      const result = (await handler({
        amount: '0.05',
        recipient: '0xRecipient',
        network: 'base-sepolia',
        scheme: 'upto',
        extra: { facilitatorAddress: '0xFacilitator' }
      })) as { isError: boolean; content: { text: string }[] }

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('no ETH')
      expect(parseFloat(spending.getSummary().spentSession)).toBe(0)
    })
  })

  describe('auth-capture scheme', () => {
    const authCaptureExtra = {
      name: 'USDC',
      version: '2',
      captureAuthorizer: '0xOperator',
      feeRecipient: '0xFee',
      captureDeadline: 9999999999,
      refundDeadline: 9999999999,
      minFeeBps: 0,
      maxFeeBps: 100
    }

    function evmConfig(): AppConfig {
      return makeConfig({
        canPay: true,
        canPayEvm: true,
        evmPrivateKey: '0xabc',
        mode: 'EVM_ONLY'
      })
    }

    it('signs an auth-capture payment without any on-chain approval', async () => {
      mockCreatePaymentPayload.mockResolvedValue({
        x402Version: 2,
        payload: 'data'
      })
      mockEncodePaymentSignatureHeader.mockReturnValue({
        'PAYMENT-SIGNATURE': 'header-value'
      })

      const server = { tool: vi.fn() } as unknown as McpServer
      const config = evmConfig()
      const spending = new SpendingTracker(config.budget)
      registerPay(server, config, spending)

      const handler = extractToolHandler(server)
      const result = (await handler({
        amount: '0.05',
        recipient: '0xRecipient',
        network: 'base-sepolia',
        scheme: 'auth-capture',
        extra: authCaptureExtra
      })) as { content: { text: string }[] }

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.scheme).toBe('auth-capture')
      expect(parsed.note).toContain('HOLD')

      const paymentRequired = mockCreatePaymentPayload.mock.calls[0][0]
      expect(paymentRequired.accepts[0].scheme).toBe('auth-capture')
      expect(paymentRequired.accepts[0].extra).toEqual(authCaptureExtra)
      expect(mockEnsurePermit2).not.toHaveBeenCalled()

      const summary = spending.getSummary()
      expect(summary.recentPayments[0].scheme).toBe('auth-capture')
      expect(summary.recentPayments[0].authorizedAmount).toBe('0.05')
    })

    it('rejects auth-capture without the extra object', async () => {
      const server = { tool: vi.fn() } as unknown as McpServer
      const config = evmConfig()
      const spending = new SpendingTracker(config.budget)
      registerPay(server, config, spending)

      const handler = extractToolHandler(server)
      const result = (await handler({
        amount: '0.05',
        recipient: '0xRecipient',
        network: 'base-sepolia',
        scheme: 'auth-capture'
      })) as { isError: boolean; content: { text: string }[] }

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('extra')
      expect(mockCreatePaymentPayload).not.toHaveBeenCalled()
    })

    it('rejects auth-capture on Stellar networks', async () => {
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
        scheme: 'auth-capture',
        extra: authCaptureExtra
      })) as { isError: boolean; content: { text: string }[] }

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('EVM networks')
    })
  })

  describe('solana', () => {
    function solanaConfig(): AppConfig {
      return makeConfig({
        canPay: true,
        canPaySolana: true,
        solanaSecret: 'base58secret',
        mode: 'SOLANA_ONLY'
      })
    }

    it('signs a solana payment when extra.feePayer is provided', async () => {
      mockCreatePaymentPayload.mockResolvedValue({
        x402Version: 2,
        payload: 'data'
      })
      mockEncodePaymentSignatureHeader.mockReturnValue({
        'PAYMENT-SIGNATURE': 'header-value'
      })

      const server = { tool: vi.fn() } as unknown as McpServer
      const config = solanaConfig()
      const spending = new SpendingTracker(config.budget)
      registerPay(server, config, spending)

      const handler = extractToolHandler(server)
      const result = (await handler({
        amount: '0.05',
        recipient: 'So1anaRecipient',
        network: 'solana-devnet',
        extra: { feePayer: 'FaciL1tatorFeePayer' }
      })) as { content: { text: string }[] }

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.paymentHeader).toBe('header-value')
      expect(parsed.network).toBe('solana-devnet')

      const paymentRequired = mockCreatePaymentPayload.mock.calls[0][0]
      expect(paymentRequired.accepts[0].network).toBe(
        'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
      )
      expect(paymentRequired.accepts[0].asset).toBe(
        '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
      )
      expect(paymentRequired.accepts[0].extra).toEqual({
        feePayer: 'FaciL1tatorFeePayer'
      })
    })

    it('rejects solana payments without extra.feePayer', async () => {
      const server = { tool: vi.fn() } as unknown as McpServer
      const config = solanaConfig()
      const spending = new SpendingTracker(config.budget)
      registerPay(server, config, spending)

      const handler = extractToolHandler(server)
      const result = (await handler({
        amount: '0.05',
        recipient: 'So1anaRecipient',
        network: 'solana-devnet'
      })) as { isError: boolean; content: { text: string }[] }

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('feePayer')
      expect(mockCreatePaymentPayload).not.toHaveBeenCalled()
    })

    it('returns error when solana key is not configured', async () => {
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
      const result = (await handler({
        amount: '0.05',
        recipient: 'So1anaRecipient',
        network: 'solana-devnet',
        extra: { feePayer: 'FaciL1tatorFeePayer' }
      })) as { isError: boolean; content: { text: string }[] }

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Solana key not configured')
    })
  })
})
