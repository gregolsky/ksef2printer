import type { KsefEnv } from './client.js'

const QR_BASE: Record<KsefEnv, string> = {
  prod: 'https://qr.ksef.mf.gov.pl',
  demo: 'https://qr-demo.ksef.mf.gov.pl',
  test: 'https://qr-test.ksef.mf.gov.pl',
}

/**
 * Verification link for "KOD I" printed on invoice visualisations:
 * <base>/invoice/<seller NIP>/<issue date DD-MM-YYYY>/<SHA-256 of the XML file, Base64URL>.
 * `invoiceHash` is the Base64 SHA-256 that KSeF reports in the invoice metadata.
 */
export function invoiceQrUrl(env: KsefEnv, sellerNip: string, issueDate: string, invoiceHash: string): string {
  const [y, m, d] = issueDate.slice(0, 10).split('-')
  const hash = Buffer.from(invoiceHash, 'base64').toString('base64url')
  return `${QR_BASE[env]}/invoice/${sellerNip}/${d}-${m}-${y}/${hash}`
}
