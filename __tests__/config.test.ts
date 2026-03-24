import { describe, it, expect, beforeEach, vi } from 'vitest'
import { loadConfig } from '../src/config.js'

vi.mock('../src/wallet-store.js', () => ({
  loadWalletConfig: vi.fn(() => null)
}))

describe('loadConfig', () => {
  beforeEach(() => {
    delete process.env.STELLAR_SECRET
    delete process.env.EVM_PRIVATE_KEY
    delete process.env.NETWORK
    delete process.env.MAX_PER_CALL
    delete process.env.MAX_PER_DAY
  })

  it('returns READ_ONLY when no keys are set', () => {
    const config = loadConfig()
    expect(config.mode).toBe('READ_ONLY')
    expect(config.canPay).toBe(false)
    expect(config.canPayStellar).toBe(false)
    expect(config.canPayEvm).toBe(false)
  })

  it('returns STELLAR_ONLY when only stellar key is set', () => {
    process.env.STELLAR_SECRET = 'STEST...'
    const config = loadConfig()
    expect(config.mode).toBe('STELLAR_ONLY')
    expect(config.canPay).toBe(true)
    expect(config.canPayStellar).toBe(true)
    expect(config.canPayEvm).toBe(false)
  })

  it('returns EVM_ONLY when only evm key is set', () => {
    process.env.EVM_PRIVATE_KEY = '0xabc123'
    const config = loadConfig()
    expect(config.mode).toBe('EVM_ONLY')
    expect(config.canPay).toBe(true)
    expect(config.canPayStellar).toBe(false)
    expect(config.canPayEvm).toBe(true)
  })

  it('returns FULL when both keys are set', () => {
    process.env.STELLAR_SECRET = 'STEST...'
    process.env.EVM_PRIVATE_KEY = '0xabc123'
    const config = loadConfig()
    expect(config.mode).toBe('FULL')
    expect(config.canPay).toBe(true)
    expect(config.canPayStellar).toBe(true)
    expect(config.canPayEvm).toBe(true)
  })

  it('uses default network stellar', () => {
    const config = loadConfig()
    expect(config.network).toBe('stellar')
  })

  it('respects NETWORK env var', () => {
    process.env.NETWORK = 'base-sepolia'
    const config = loadConfig()
    expect(config.network).toBe('base-sepolia')
  })

  it('uses default budget limits', () => {
    const config = loadConfig()
    expect(config.budget.maxPerCall).toBe('0.10')
    expect(config.budget.maxPerDay).toBe('20.00')
  })

  it('respects budget env vars', () => {
    process.env.MAX_PER_CALL = '5.00'
    process.env.MAX_PER_DAY = '100.00'
    const config = loadConfig()
    expect(config.budget.maxPerCall).toBe('5.00')
    expect(config.budget.maxPerDay).toBe('100.00')
  })

  it('reload refreshes config', () => {
    const config = loadConfig()
    expect(config.mode).toBe('READ_ONLY')

    process.env.STELLAR_SECRET = 'STEST...'
    config.reload()
    expect(config.mode).toBe('STELLAR_ONLY')
  })
})
