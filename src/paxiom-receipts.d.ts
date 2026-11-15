declare module '@paxiom/receipts' {
  export interface VerifyReceiptOptions {
    output?: unknown
    trustedPaxiomPublicKeys?: string[]
  }

  export interface VerifyReceiptResult {
    valid: boolean
    trustState: string
    checks: Record<string, string>
    receiptHash: string | null
    summary: string
  }

  export interface GeneratedReceiptKeyPair {
    keyId: string
    algorithm: 'ed25519'
    publicKey: string
    privateKeyPem: string
  }

  export interface IssuedReceipt {
    receipt: Record<string, unknown>
    receiptHeader: string
  }

  export function verifyReceipt(
    receipt: unknown,
    options?: VerifyReceiptOptions
  ): VerifyReceiptResult

  export function generateReceiptKeyPair(options?: {
    keyId?: string
  }): GeneratedReceiptKeyPair

  export function issueReceipt(options: Record<string, unknown>): IssuedReceipt
}
