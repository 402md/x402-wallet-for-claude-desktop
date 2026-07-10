export type PaymentNetwork =
  | 'stellar'
  | 'stellar-testnet'
  | 'base'
  | 'base-sepolia'
  | 'solana'
  | 'solana-devnet'

export interface AppConfig {
  stellarSecret?: string
  evmPrivateKey?: string
  solanaSecret?: string
  network: PaymentNetwork
  budget: BudgetConfig
  canPay: boolean
  canPayStellar: boolean
  canPayEvm: boolean
  canPaySolana: boolean
  mode: 'READ_ONLY' | 'STELLAR_ONLY' | 'EVM_ONLY' | 'SOLANA_ONLY' | 'FULL'
  reload(): void
}

export interface BudgetConfig {
  maxPerCall: string
  maxPerDay: string
}

export interface WalletFileConfig {
  stellarSecret?: string
  evmPrivateKey?: string
  solanaSecret?: string
  network?: string
  createdAt?: string
}

export interface SpendingRecord {
  recipient: string
  amount: string
  network: string
  timestamp: string
  scheme?: string
  /** Authorized maximum when it differs from the recorded amount (upto scheme) */
  authorizedAmount?: string
}
