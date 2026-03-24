import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const WALLET_DIR = path.join(os.homedir(), '.x402')
const WALLET_PATH = path.join(WALLET_DIR, 'wallet.json')

vi.mock('node:fs')

const { loadWalletConfig, saveWalletConfig, getWalletPath } =
  await import('../src/wallet-store.js')

describe('wallet-store', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('getWalletPath', () => {
    it('returns ~/.x402/wallet.json', () => {
      expect(getWalletPath()).toBe(WALLET_PATH)
    })
  })

  describe('loadWalletConfig', () => {
    it('returns null when file does not exist', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT')
      })
      expect(loadWalletConfig()).toBeNull()
    })

    it('returns parsed config when file exists', () => {
      const config = {
        stellarSecret: 'STEST...',
        network: 'stellar-testnet'
      }
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config))
      expect(loadWalletConfig()).toEqual(config)
    })

    it('returns null on invalid JSON', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('not json')
      expect(loadWalletConfig()).toBeNull()
    })
  })

  describe('saveWalletConfig', () => {
    it('creates directory and writes file with correct permissions', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT')
      })
      vi.mocked(fs.mkdirSync).mockReturnValue(undefined)
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined)

      saveWalletConfig({ stellarSecret: 'SNEW...', network: 'stellar-testnet' })

      expect(fs.mkdirSync).toHaveBeenCalledWith(WALLET_DIR, {
        recursive: true,
        mode: 0o700
      })
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        WALLET_PATH,
        expect.stringContaining('SNEW...'),
        { mode: 0o600 }
      )
    })

    it('merges with existing config', () => {
      const existing = { stellarSecret: 'SOLD...', network: 'stellar' }
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(existing))
      vi.mocked(fs.mkdirSync).mockReturnValue(undefined)
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined)

      saveWalletConfig({ evmPrivateKey: '0xNEW...' })

      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string
      const parsed = JSON.parse(written)
      expect(parsed.stellarSecret).toBe('SOLD...')
      expect(parsed.evmPrivateKey).toBe('0xNEW...')
    })
  })
})
