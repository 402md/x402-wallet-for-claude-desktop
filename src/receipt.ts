import { verifyReceipt } from '@paxiom/receipts'

const DEFAULT_PAXIOM_PUBLIC_KEYS = [
  'hsRfDKd2AWxv0KwTs3gsDLMY7nPtVGky1Tc6NWgSxIY='
]

export interface DeliveryReceiptVerdict {
  valid: boolean
  trustState: string
  checks: Record<string, string>
  receiptHash: string | null
  summary: string
}

interface HeaderReader {
  get(name: string): string | null
}

function readReceiptHeader(headers: HeaderReader | undefined): string | null {
  if (!headers) return null
  return (
    headers.get('X-Paxiom-Receipt') ?? headers.get('x-paxiom-receipt') ?? null
  )
}

function decodeBase64UrlJson(encoded: string): unknown {
  const raw = Buffer.from(encoded.trim(), 'base64url').toString('utf-8')
  return JSON.parse(raw)
}

function tryParseJsonBody(
  body: string
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(body) }
  } catch {
    return { ok: false }
  }
}

export function verifyDeliveryReceipt(
  headers: HeaderReader | undefined,
  responseBody: string
): DeliveryReceiptVerdict | null {
  const headerValue = readReceiptHeader(headers)
  if (!headerValue || !headerValue.trim()) return null

  let parsedReceipt: Record<string, unknown>
  try {
    const decoded = decodeBase64UrlJson(headerValue)
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      return {
        valid: false,
        trustState: 'schema_invalid',
        checks: { schema: 'fail' },
        receiptHash: null,
        summary: 'X-Paxiom-Receipt header did not decode to a JSON object.'
      }
    }
    parsedReceipt = decoded as Record<string, unknown>
  } catch {
    return {
      valid: false,
      trustState: 'schema_invalid',
      checks: { schema: 'fail' },
      receiptHash: null,
      summary: 'Malformed base64url JSON in X-Paxiom-Receipt header.'
    }
  }

  const parsedOutput = tryParseJsonBody(responseBody)
  const result = verifyReceipt(parsedReceipt, {
    ...(parsedOutput.ok ? { output: parsedOutput.value } : {}),
    trustedPaxiomPublicKeys: DEFAULT_PAXIOM_PUBLIC_KEYS
  })

  return {
    valid: result.valid,
    trustState: result.trustState,
    checks: result.checks,
    receiptHash: result.receiptHash,
    summary: result.summary
  }
}
