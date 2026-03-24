import { describe, it, expect } from 'vitest'
import {
  isStellarNetwork,
  isEvmNetwork,
  getCaip2Network
} from '../src/clients.js'

describe('network helpers', () => {
  describe('isStellarNetwork', () => {
    it('returns true for stellar', () => {
      expect(isStellarNetwork('stellar')).toBe(true)
    })

    it('returns true for stellar-testnet', () => {
      expect(isStellarNetwork('stellar-testnet')).toBe(true)
    })

    it('returns false for base', () => {
      expect(isStellarNetwork('base')).toBe(false)
    })

    it('returns false for base-sepolia', () => {
      expect(isStellarNetwork('base-sepolia')).toBe(false)
    })
  })

  describe('isEvmNetwork', () => {
    it('returns true for base', () => {
      expect(isEvmNetwork('base')).toBe(true)
    })

    it('returns true for base-sepolia', () => {
      expect(isEvmNetwork('base-sepolia')).toBe(true)
    })

    it('returns false for stellar', () => {
      expect(isEvmNetwork('stellar')).toBe(false)
    })

    it('returns false for stellar-testnet', () => {
      expect(isEvmNetwork('stellar-testnet')).toBe(false)
    })
  })

  describe('getCaip2Network', () => {
    it('maps stellar to stellar:pubnet', () => {
      expect(getCaip2Network('stellar')).toBe('stellar:pubnet')
    })

    it('maps stellar-testnet to stellar:testnet', () => {
      expect(getCaip2Network('stellar-testnet')).toBe('stellar:testnet')
    })

    it('maps base to eip155:8453', () => {
      expect(getCaip2Network('base')).toBe('eip155:8453')
    })

    it('maps base-sepolia to eip155:84532', () => {
      expect(getCaip2Network('base-sepolia')).toBe('eip155:84532')
    })
  })
})
