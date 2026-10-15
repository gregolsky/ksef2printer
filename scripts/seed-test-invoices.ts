/**
 * Issues a few fictitious FA(3) invoices on the KSeF TEST environment so the print flow can be
 * tried end to end. Refuses to run against any other environment.
 *
 *   KSEF_NIP=<test nip> KSEF_TOKEN=<test token with InvoiceWrite> pnpm tsx scripts/seed-test-invoices.ts [count]
 *
 * The invoices are issued by KSEF_NIP (so they show up as sales) to a random buyer NIP.
 */
import { X509Certificate, constants, createCipheriv, createHash, publicEncrypt, randomBytes, randomInt } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { KsefClient } from '../src/ksef/client.js'
import { consoleLogger as log } from '../src/logger.js'

const FORM_CODE = { systemCode: 'FA (3)', schemaVersion: '1-0E', value: 'FA' }
const ITEMS = ['Ryza papieru A4', 'Toner czarny', 'Serwis drukarki', 'Bęben światłoczuły']

function randomNip(): string {
  const w = [6, 5, 7, 2, 3, 4, 5, 6, 7]
  for (;;) {
    const d = [randomInt(1, 10), ...Array.from({ length: 8 }, () => randomInt(0, 10))]
    const c = d.reduce((s, x, i) => s + x * w[i]!, 0) % 11
    if (c < 10) return [...d, c].join('')
  }
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('base64')

async function main(): Promise<void> {
  const nip = process.env['KSEF_NIP']
  const token = process.env['KSEF_TOKEN']
  if (nip == null || token == null) throw new Error('set KSEF_NIP and KSEF_TOKEN (test environment)')
  const count = Number(process.argv[2] ?? 3)

  const client = new KsefClient({ env: 'test', nip, token, logger: log })
  const accessToken = await client.accessToken()
  const api = async (method: string, path: string, body?: unknown): Promise<any> => {
    const res = await fetch(`${client.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`)
    return text === '' ? null : JSON.parse(text)
  }

  const certs: Array<{ certificate: string; publicKeyId: string; usage: string[] }> = await api('GET', '/security/public-key-certificates')
  const cert = certs.find((c) => c.usage.includes('SymmetricKeyEncryption'))
  if (cert == null) throw new Error('no SymmetricKeyEncryption certificate')
  const key = randomBytes(32)
  const iv = randomBytes(16)
  const encryptedKey = publicEncrypt(
    { key: new X509Certificate(Buffer.from(cert.certificate, 'base64')).publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    key,
  )

  const session = await api('POST', '/sessions/online', {
    formCode: FORM_CODE,
    encryption: { encryptedSymmetricKey: encryptedKey.toString('base64'), initializationVector: iv.toString('base64'), publicKeyId: cert.publicKeyId },
  })
  log.info(`online session ${session.referenceNumber}`)

  const template = await readFile(new URL('./templates/invoice-fa-3.xml', import.meta.url), 'utf8')
  const today = new Date().toISOString().slice(0, 10)
  for (let i = 1; i <= count; i++) {
    const net = (randomInt(1000, 50000) / 100).toFixed(2)
    const vat = (Number(net) * 0.23).toFixed(2)
    const values: Record<string, string> = {
      createdAt: new Date().toISOString(),
      sellerNip: nip,
      buyerNip: randomNip(),
      issueDate: today,
      invoiceNumber: `TEST/${today}/${randomInt(1000, 9999)}-${i}`,
      net,
      vat,
      gross: (Number(net) + Number(vat)).toFixed(2),
      item: ITEMS[(i - 1) % ITEMS.length]!,
    }
    const xml = Buffer.from(template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => values[k] ?? ''), 'utf8')
    const cipher = createCipheriv('aes-256-cbc', key, iv)
    const encrypted = Buffer.concat([cipher.update(xml), cipher.final()])
    const sent = await api('POST', `/sessions/online/${session.referenceNumber}/invoices`, {
      invoiceHash: sha256(xml),
      invoiceSize: xml.length,
      encryptedInvoiceHash: sha256(encrypted),
      encryptedInvoiceSize: encrypted.length,
      encryptedInvoiceContent: encrypted.toString('base64'),
    })
    log.info(`sent ${values['invoiceNumber']} (${values['gross']} PLN) → ${sent.referenceNumber}`)
  }

  await api('POST', `/sessions/online/${session.referenceNumber}/close`)
  log.info('session closed; waiting for KSeF to process the invoices…')

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 4000))
    const st = await api('GET', `/sessions/${session.referenceNumber}/invoices`)
    const invoices: Array<{ invoiceNumber?: string; ksefNumber?: string; status: { code: number; description: string; details?: string[] } }> =
      st.invoices ?? []
    const done = invoices.filter((x) => x.status.code !== 100 && x.status.code !== 150)
    if (done.length === invoices.length && invoices.length > 0) {
      for (const x of invoices) {
        log.info(`${x.invoiceNumber ?? '?'}: ${x.status.code} ${x.status.description} ${x.ksefNumber ?? ''} ${x.status.details?.join('; ') ?? ''}`)
      }
      return
    }
  }
  log.warn('invoices still processing; check again later')
}

main().catch((err: unknown) => {
  log.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
