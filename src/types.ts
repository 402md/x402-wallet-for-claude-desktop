export type PaymentNetwork =
  | 'stellar'
  | 'stellar-testnet'
  | 'base'
  | 'base-sepolia'

export interface AppConfig {
  stellarSecret?: string
  evmPrivateKey?: string
  network: PaymentNetwork
  budget: BudgetConfig
  canPay: boolean
  canPayStellar: boolean
  canPayEvm: boolean
  mode: 'READ_ONLY' | 'STELLAR_ONLY' | 'EVM_ONLY' | 'FULL'
  reload(): void
}

export interface BudgetConfig {
  maxPerCall: string
  maxPerDay: string
}

export interface WalletFileConfig {
  stellarSecret?: string
  evmPrivateKey?: string
  network?: string
  createdAt?: string
}

export interface SpendingRecord {
  recipient: string
  amount: string
  network: string
  timestamp: string
}
