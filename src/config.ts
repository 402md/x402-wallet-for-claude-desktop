import type { PaymentNetwork, AppConfig } from '@/types.js'
import { loadWalletConfig } from '@/wallet-store.js'

export function loadConfig(): AppConfig {
  const state = buildState()
  return {
    ...state,
    reload() {
      const fresh = buildState()
      Object.assign(this, fresh)
    }
  }
}

function buildState(): Omit<AppConfig, 'reload'> {
  const wallet = loadWalletConfig()

  const stellarSecret =
    process.env.STELLAR_SECRET ?? wallet?.stellarSecret ?? undefined
  const evmPrivateKey =
    process.env.EVM_PRIVATE_KEY ?? wallet?.evmPrivateKey ?? undefined
  const solanaSecret =
    process.env.SOLANA_SECRET ?? wallet?.solanaSecret ?? undefined
  const network = (process.env.NETWORK ??
    wallet?.network ??
    'stellar') as PaymentNetwork

  const maxPerCall = process.env.MAX_PER_CALL ?? '0.10'
  const maxPerDay = process.env.MAX_PER_DAY ?? '20.00'

  const canPayStellar = !!stellarSecret
  const canPayEvm = !!evmPrivateKey
  const canPaySolana = !!solanaSecret
  const enabled = [canPayStellar, canPayEvm, canPaySolana].filter(Boolean)
  const canPay = enabled.length > 0

  let mode: AppConfig['mode'] = 'READ_ONLY'
  if (enabled.length > 1) mode = 'FULL'
  else if (canPayStellar) mode = 'STELLAR_ONLY'
  else if (canPayEvm) mode = 'EVM_ONLY'
  else if (canPaySolana) mode = 'SOLANA_ONLY'

  return {
    stellarSecret,
    evmPrivateKey,
    solanaSecret,
    network,
    budget: { maxPerCall, maxPerDay },
    canPay,
    canPayStellar,
    canPayEvm,
    canPaySolana,
    mode
  }
}
