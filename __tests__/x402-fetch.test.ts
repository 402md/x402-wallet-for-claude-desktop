import { describe, it, expect, vi, beforeEach } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AppConfig } from '../src/types.js'
import { SpendingTracker } from '../src/spending.js'
import { registerX402Fetch } from '../src/tools/x402-fetch.js'

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

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

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
  const call = calls.find(c => c[0] === 'x402_fetch')
  return call![call!.length - 1] as (...args: unknown[]) => Promise<unknown>
}

type ToolResult = {
  isError?: boolean
  content: { type: string; text: string }[]
}

describe('x402_fetch tool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers the tool with correct name', () => {
    const server = { tool: vi.fn() } as unknown as McpServer
    const config = makeConfig()
    const spending = new SpendingTracker(config.budget)
    registerX402Fetch(server, config, spending)
    expect(server.tool).toHaveBeenCalledWith(
      'x402_fetch',
      expect.any(String),
      expect.any(Object),
      expect.any(Function)
    )
  })

  it('returns error when no wallet configured', async () => {
    const server = { tool: vi.fn() } as unknown as McpServer
    const config = makeConfig({ canPay: false })
    const spending = new SpendingTracker(config.budget)
    registerX402Fetch(server, config, spending)

    const handler = extractToolHandler(server)
    const result = (await handler({
      url: 'https://api.example.com/data',
      method: 'GET'
    })) as ToolResult

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('No wallet configured')
  })

  it('returns response directly when status is not 402', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      text: vi.fn().mockResolvedValue('{"result":"success"}')
    })

    const server = { tool: vi.fn() } as unknown as McpServer
    const config = makeConfig({
      canPay: true,
      canPayEvm: true,
      evmPrivateKey: '0xabc',
      mode: 'EVM_ONLY'
    })
    const spending = new SpendingTracker(config.budget)
    registerX402Fetch(server, config, spending)

    const handler = extractToolHandler(server)
    const result = (await handler({
      url: 'https://api.example.com/free',
      method: 'GET'
    })) as ToolResult

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.status).toBe(200)
    expect(parsed.body).toBe('{"result":"success"}')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('handles 402 and retries with payment header', async () => {
    const paymentRequiredBody = {
      x402Version: 2,
      error: '',
      resource: { url: '', description: '', mimeType: '' },
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:84532',
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          amount: '50000', // 0.05 USDC (6 decimals)
          payTo: '0xRecipient',
          maxTimeoutSeconds: 300,
          extra: {}
        }
      ]
    }

    // First call returns 402
    mockFetch.mockResolvedValueOnce({
      status: 402,
      statusText: 'Payment Required',
      headers: { get: () => null },
      json: vi.fn().mockResolvedValue(paymentRequiredBody)
    })

    // Second call returns 200 (after payment)
    mockFetch.mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      text: vi.fn().mockResolvedValue('paid content')
    })

    mockCreatePaymentPayload.mockResolvedValue({ payload: 'signed' })
    mockEncodePaymentSignatureHeader.mockReturnValue({
      'PAYMENT-SIGNATURE': 'signed-header-value'
    })

    const server = { tool: vi.fn() } as unknown as McpServer
    const config = makeConfig({
      canPay: true,
      canPayEvm: true,
      evmPrivateKey: '0xabc',
      mode: 'EVM_ONLY'
    })
    const spending = new SpendingTracker(config.budget)
    registerX402Fetch(server, config, spending)

    const handler = extractToolHandler(server)
    const result = (await handler({
      url: 'https://api.example.com/paid',
      method: 'GET'
    })) as ToolResult

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.status).toBe(200)
    expect(parsed.body).toBe('paid content')
    expect(parsed.payment.amount).toBe('0.050000 USDC')
    expect(parsed.payment.recipient).toBe('0xRecipient')
    expect(parsed.payment.network).toBe('base-sepolia')

    // Verify fetch was called twice
    expect(mockFetch).toHaveBeenCalledTimes(2)

    // Verify retry had PAYMENT-SIGNATURE header (v2)
    const retryCall = mockFetch.mock.calls[1]
    expect(retryCall[1].headers['PAYMENT-SIGNATURE']).toBe(
      'signed-header-value'
    )
  })

  it('parses payment info from base64 Payment-Required header', async () => {
    const paymentRequiredBody = {
      x402Version: 2,
      error: 'Payment required',
      resource: { url: '', description: '', mimeType: '' },
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:84532',
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          amount: '50000',
          payTo: '0xRecipient',
          maxTimeoutSeconds: 300,
          extra: {}
        }
      ]
    }

    const headerValue = Buffer.from(
      JSON.stringify(paymentRequiredBody)
    ).toString('base64')

    // 402 with payment info in header, empty body
    mockFetch.mockResolvedValueOnce({
      status: 402,
      statusText: 'Payment Required',
      headers: {
        get: (name: string) =>
          name === 'Payment-Required' ? headerValue : null
      },
      json: vi.fn().mockResolvedValue({})
    })

    mockFetch.mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      text: vi.fn().mockResolvedValue('paid via header')
    })

    mockCreatePaymentPayload.mockResolvedValue({ payload: 'signed' })
    mockEncodePaymentSignatureHeader.mockReturnValue({
      'PAYMENT-SIGNATURE': 'signed-header-value'
    })

    const server = { tool: vi.fn() } as unknown as McpServer
    const config = makeConfig({
      canPay: true,
      canPayEvm: true,
      evmPrivateKey: '0xabc',
      mode: 'EVM_ONLY'
    })
    const spending = new SpendingTracker(config.budget)
    registerX402Fetch(server, config, spending)

    const handler = extractToolHandler(server)
    const result = (await handler({
      url: 'https://api.example.com/paid',
      method: 'GET'
    })) as ToolResult

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.status).toBe(200)
    expect(parsed.body).toBe('paid via header')
    expect(parsed.payment.amount).toBe('0.050000 USDC')
    expect(parsed.payment.network).toBe('base-sepolia')
  })

  it('returns error when 402 has no accepts', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 402,
      statusText: 'Payment Required',
      headers: { get: () => null },
      json: vi.fn().mockResolvedValue({
        x402Version: 2,
        error: '',
        resource: { url: '', description: '', mimeType: '' },
        accepts: []
      })
    })

    const server = { tool: vi.fn() } as unknown as McpServer
    const config = makeConfig({
      canPay: true,
      canPayEvm: true,
      evmPrivateKey: '0xabc',
      mode: 'EVM_ONLY'
    })
    const spending = new SpendingTracker(config.budget)
    registerX402Fetch(server, config, spending)

    const handler = extractToolHandler(server)
    const result = (await handler({
      url: 'https://api.example.com/paid',
      method: 'GET'
    })) as ToolResult

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('no payment options')
  })

  it('returns error when wallet cannot fulfill any accepted network', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 402,
      statusText: 'Payment Required',
      headers: { get: () => null },
      json: vi.fn().mockResolvedValue({
        x402Version: 2,
        error: '',
        resource: { url: '', description: '', mimeType: '' },
        accepts: [
          {
            scheme: 'exact',
            network: 'stellar:testnet',
            asset: 'CBIELTK6...',
            amount: '500000',
            payTo: 'GABC...',
            maxTimeoutSeconds: 300,
            extra: {}
          }
        ]
      })
    })

    const server = { tool: vi.fn() } as unknown as McpServer
    const config = makeConfig({
      canPay: true,
      canPayEvm: true,
      canPayStellar: false,
      evmPrivateKey: '0xabc',
      mode: 'EVM_ONLY'
    })
    const spending = new SpendingTracker(config.budget)
    registerX402Fetch(server, config, spending)

    const handler = extractToolHandler(server)
    const result = (await handler({
      url: 'https://api.example.com/paid',
      method: 'GET'
    })) as ToolResult

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Cannot fulfill payment')
  })

  it('checks spending limits before signing', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 402,
      statusText: 'Payment Required',
      headers: { get: () => null },
      json: vi.fn().mockResolvedValue({
        x402Version: 2,
        error: '',
        resource: { url: '', description: '', mimeType: '' },
        accepts: [
          {
            scheme: 'exact',
            network: 'eip155:84532',
            asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            amount: '5000000', // 5.0 USDC
            payTo: '0xRecipient',
            maxTimeoutSeconds: 300,
            extra: {}
          }
        ]
      })
    })

    const server = { tool: vi.fn() } as unknown as McpServer
    const config = makeConfig({
      canPay: true,
      canPayEvm: true,
      evmPrivateKey: '0xabc',
      mode: 'EVM_ONLY',
      budget: { maxPerCall: '1.00', maxPerDay: '20.00' }
    })
    const spending = new SpendingTracker(config.budget)
    registerX402Fetch(server, config, spending)

    const handler = extractToolHandler(server)
    const result = (await handler({
      url: 'https://api.example.com/expensive',
      method: 'GET'
    })) as ToolResult

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('exceeds per-call limit')
  })

  it('records spending after successful paid fetch', async () => {
    mockFetch
      .mockResolvedValueOnce({
        status: 402,
        statusText: 'Payment Required',
        headers: { get: () => null },
        json: vi.fn().mockResolvedValue({
          x402Version: 2,
          error: '',
          resource: { url: '', description: '', mimeType: '' },
          accepts: [
            {
              scheme: 'exact',
              network: 'eip155:84532',
              asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
              amount: '50000',
              payTo: '0xRecipient',
              maxTimeoutSeconds: 300,
              extra: {}
            }
          ]
        })
      })
      .mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        text: vi.fn().mockResolvedValue('result')
      })

    mockCreatePaymentPayload.mockResolvedValue({ payload: 'signed' })
    mockEncodePaymentSignatureHeader.mockReturnValue({
      'PAYMENT-SIGNATURE': 'header'
    })

    const server = { tool: vi.fn() } as unknown as McpServer
    const config = makeConfig({
      canPay: true,
      canPayEvm: true,
      evmPrivateKey: '0xabc',
      mode: 'EVM_ONLY'
    })
    const spending = new SpendingTracker(config.budget)
    registerX402Fetch(server, config, spending)

    const handler = extractToolHandler(server)
    await handler({
      url: 'https://api.example.com/paid',
      method: 'GET'
    })

    const summary = spending.getSummary()
    expect(parseFloat(summary.spentSession)).toBeCloseTo(0.05)
    expect(summary.recentPayments).toHaveLength(1)
    expect(summary.recentPayments[0].recipient).toBe('0xRecipient')
  })

  it('passes custom headers and body to fetch', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      text: vi.fn().mockResolvedValue('ok')
    })

    const server = { tool: vi.fn() } as unknown as McpServer
    const config = makeConfig({
      canPay: true,
      canPayEvm: true,
      evmPrivateKey: '0xabc',
      mode: 'EVM_ONLY'
    })
    const spending = new SpendingTracker(config.budget)
    registerX402Fetch(server, config, spending)

    const handler = extractToolHandler(server)
    await handler({
      url: 'https://api.example.com/data',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"key":"value"}'
    })

    const [, options] = mockFetch.mock.calls[0]
    expect(options.method).toBe('POST')
    expect(options.headers['Content-Type']).toBe('application/json')
    expect(options.body).toBe('{"key":"value"}')
  })

  it('handles fetch network errors gracefully', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'))

    const server = { tool: vi.fn() } as unknown as McpServer
    const config = makeConfig({
      canPay: true,
      canPayEvm: true,
      evmPrivateKey: '0xabc',
      mode: 'EVM_ONLY'
    })
    const spending = new SpendingTracker(config.budget)
    registerX402Fetch(server, config, spending)

    const handler = extractToolHandler(server)
    const result = (await handler({
      url: 'https://api.example.com/down',
      method: 'GET'
    })) as ToolResult

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Network error')
  })
})
