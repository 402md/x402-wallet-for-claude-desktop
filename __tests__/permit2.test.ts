import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AppConfig } from '../src/types.js'
import { ensurePermit2Allowance } from '../src/permit2.js'

const mockReadContract = vi.fn()
const mockGetBalance = vi.fn()
const mockSendTransaction = vi.fn()
const mockWaitForTransactionReceipt = vi.fn()

vi.mock('../src/clients.js', () => ({
  createEvmSigner: vi.fn().mockResolvedValue({
    address: '0xWallet',
    chain: { id: 84532 },
    account: { address: '0xWallet' },
    readContract: (...args: unknown[]) => mockReadContract(...args),
    getBalance: (...args: unknown[]) => mockGetBalance(...args),
    sendTransaction: (...args: unknown[]) => mockSendTransaction(...args),
    waitForTransactionReceipt: (...args: unknown[]) =>
      mockWaitForTransactionReceipt(...args)
  })
}))

vi.mock('@x402/evm/upto/client', () => ({
  getPermit2AllowanceReadParams: vi.fn(
    (params: { tokenAddress: string; ownerAddress: string }) => ({
      address: params.tokenAddress,
      abi: [],
      functionName: 'allowance',
      args: [params.ownerAddress, '0xPermit2']
    })
  ),
  createPermit2ApprovalTx: vi.fn(() => ({
    to: '0xUsdc',
    data: '0xapprovedata'
  }))
}))

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    stellarSecret: undefined,
    evmPrivateKey: '0xabc',
    network: 'base-sepolia',
    budget: { maxPerCall: '1.00', maxPerDay: '20.00' },
    canPay: true,
    canPayStellar: false,
    canPayEvm: true,
    mode: 'EVM_ONLY',
    reload: vi.fn(),
    ...overrides
  }
}

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const

function params(overrides: Record<string, unknown> = {}) {
  return {
    network: 'base-sepolia' as const,
    config: makeConfig(),
    asset: USDC,
    requiredAmount: 100000n,
    ...overrides
  }
}

describe('ensurePermit2Allowance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns sufficient when the allowance already covers the amount', async () => {
    mockReadContract.mockResolvedValue(200000n)

    const result = await ensurePermit2Allowance(params())

    expect(result).toEqual({ status: 'sufficient' })
    expect(mockSendTransaction).not.toHaveBeenCalled()
  })

  it('skips the approval when the server sponsors gas', async () => {
    mockReadContract.mockResolvedValue(0n)

    const result = await ensurePermit2Allowance(
      params({ gaslessDeclared: true })
    )

    expect(result).toEqual({ status: 'skipped-gasless' })
    expect(mockGetBalance).not.toHaveBeenCalled()
    expect(mockSendTransaction).not.toHaveBeenCalled()
  })

  it('sends the approval tx when allowance is missing and the wallet has ETH', async () => {
    mockReadContract.mockResolvedValue(0n)
    mockGetBalance.mockResolvedValue(10n ** 16n)
    mockSendTransaction.mockResolvedValue('0xApprovalHash')
    mockWaitForTransactionReceipt.mockResolvedValue({ status: 'success' })

    const result = await ensurePermit2Allowance(params())

    expect(result).toEqual({
      status: 'approved',
      approvalTxHash: '0xApprovalHash'
    })
    expect(mockSendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ to: '0xUsdc', data: '0xapprovedata' })
    )
    expect(mockWaitForTransactionReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ hash: '0xApprovalHash' })
    )
  })

  it('throws a clear error when the wallet has no ETH for gas', async () => {
    mockReadContract.mockResolvedValue(0n)
    mockGetBalance.mockResolvedValue(0n)

    await expect(ensurePermit2Allowance(params())).rejects.toThrow(
      /no ETH.*0xWallet/s
    )
    expect(mockSendTransaction).not.toHaveBeenCalled()
  })

  it('translates insufficient-funds errors into the no-ETH message', async () => {
    mockReadContract.mockResolvedValue(0n)
    mockGetBalance.mockResolvedValue(1n) // dust: passes the zero check
    mockSendTransaction.mockRejectedValue(
      new Error('insufficient funds for gas * price + value')
    )

    await expect(ensurePermit2Allowance(params())).rejects.toThrow(/no ETH/)
  })

  it('throws when the approval transaction reverts', async () => {
    mockReadContract.mockResolvedValue(0n)
    mockGetBalance.mockResolvedValue(10n ** 16n)
    mockSendTransaction.mockResolvedValue('0xApprovalHash')
    mockWaitForTransactionReceipt.mockResolvedValue({ status: 'reverted' })

    await expect(ensurePermit2Allowance(params())).rejects.toThrow(/reverted/)
  })
})
