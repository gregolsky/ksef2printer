import { z } from 'zod'
import { noopLogger, type Logger } from '../logger.js'
import { encryptKsefToken } from './crypto.js'
import { warsawOffset } from './time.js'

export type KsefEnv = 'prod' | 'demo' | 'test'

export const BASE_URLS: Record<KsefEnv, string> = {
  prod: 'https://api.ksef.mf.gov.pl/v2',
  demo: 'https://api-demo.ksef.mf.gov.pl/v2',
  test: 'https://api-test.ksef.mf.gov.pl/v2',
}

/** Subject1 = we are the seller (sales), Subject2 = we are the buyer (purchases). */
export type SubjectType = 'Subject1' | 'Subject2'

export class KsefError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

const TokenInfo = z.object({ token: z.string(), validUntil: z.string() })

const Challenge = z.object({ challenge: z.string(), timestampMs: z.number() })

const Certificates = z.array(
  z.object({
    certificate: z.string(),
    publicKeyId: z.string(),
    validFrom: z.string(),
    validTo: z.string(),
    usage: z.array(z.string()),
  }),
)

const AuthInit = z.object({ referenceNumber: z.string(), authenticationToken: TokenInfo })

const AuthStatus = z.object({
  status: z.object({ code: z.number(), description: z.string(), details: z.array(z.string()).nullish() }),
})

const Tokens = z.object({ accessToken: TokenInfo, refreshToken: TokenInfo })
const Refreshed = z.object({ accessToken: TokenInfo })

export const InvoiceMetadata = z.object({
  // Used in file names, so only the characters a KSeF number can contain are accepted.
  ksefNumber: z.string().regex(/^[0-9A-Za-z-]+$/, 'not a KSeF number'),
  invoiceNumber: z.string(),
  issueDate: z.string(),
  seller: z.object({ nip: z.string(), name: z.string().nullish() }),
  buyer: z.object({
    identifier: z.object({ type: z.string(), value: z.string().nullish() }),
    name: z.string().nullish(),
  }),
  grossAmount: z.number(),
  currency: z.string(),
  formCode: z.object({ systemCode: z.string(), schemaVersion: z.string(), value: z.string() }),
  /** SHA-256 of the invoice XML, Base64. */
  invoiceHash: z.string(),
})
export type InvoiceMetadata = z.infer<typeof InvoiceMetadata>

const MetadataPage = z.object({
  hasMore: z.boolean(),
  isTruncated: z.boolean(),
  invoices: z.array(InvoiceMetadata),
})

export interface KsefClientOptions {
  env: KsefEnv
  nip: string
  token: string
  baseUrl?: string
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  logger?: Logger
}

interface Session {
  accessToken: string
  accessValidUntil: number
  refreshToken: string
}

const PAGE_SIZE = 250
const AUTH_POLLS = 30
const MAX_ATTEMPTS = 4

export class KsefClient {
  readonly base: string
  private readonly fetch: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private readonly logger: Logger
  private session: Session | null = null

  constructor(private readonly opts: KsefClientOptions) {
    this.base = opts.baseUrl ?? BASE_URLS[opts.env]
    this.fetch = opts.fetch ?? globalThis.fetch
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.now = opts.now ?? Date.now
    this.logger = opts.logger ?? noopLogger
  }

  /** One HTTP call with retry on network errors, 429 (honouring Retry-After) and 5xx. */
  private async call(method: string, path: string, init: { bearer?: string; body?: unknown; accept?: string } = {}): Promise<Response> {
    const headers: Record<string, string> = { Accept: init.accept ?? 'application/json' }
    if (init.bearer != null) headers['Authorization'] = `Bearer ${init.bearer}`
    if (init.body !== undefined) headers['Content-Type'] = 'application/json'
    for (let attempt = 1; ; attempt++) {
      const reqInit: RequestInit = { method, headers, signal: AbortSignal.timeout(30_000) }
      if (init.body !== undefined) reqInit.body = JSON.stringify(init.body)
      let res: Response
      try {
        res = await this.fetch(`${this.base}${path}`, reqInit)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        if (attempt >= MAX_ATTEMPTS) throw new KsefError(`${method} ${path} failed: ${reason}`)
        const waitMs = 1000 * 2 ** attempt
        this.logger.warn(`${method} ${path} failed (${reason}), retrying in ${waitMs / 1000}s`)
        await this.sleep(waitMs)
        continue
      }
      const retryable = res.status === 429 || res.status >= 500
      if (res.ok || !retryable || attempt >= MAX_ATTEMPTS) {
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new KsefError(`${method} ${path} → ${res.status}: ${text.slice(0, 500)}`, res.status)
        }
        return res
      }
      const retryAfter = Number(res.headers.get('Retry-After'))
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt
      this.logger.warn(`${method} ${path} → ${res.status}, retrying in ${waitMs / 1000}s`)
      await this.sleep(waitMs)
    }
  }

  private async json<T>(schema: z.ZodType<T>, method: string, path: string, init: { bearer?: string; body?: unknown } = {}): Promise<T> {
    const res = await this.call(method, path, init)
    const parsed = schema.safeParse(await res.json())
    if (!parsed.success) throw new KsefError(`${method} ${path}: unexpected response: ${parsed.error.message}`)
    return parsed.data
  }

  /** Authenticates with the KSeF token: challenge → encrypted token → poll → redeem. */
  async authenticate(): Promise<void> {
    const challenge = await this.json(Challenge, 'POST', '/auth/challenge')
    const certs = await this.json(Certificates, 'GET', '/security/public-key-certificates')
    const t = this.now()
    const cert = certs.find(
      (c) => c.usage.includes('KsefTokenEncryption') && Date.parse(c.validFrom) <= t && t < Date.parse(c.validTo),
    )
    if (cert == null) throw new KsefError('no valid KsefTokenEncryption certificate')

    const init = await this.json(AuthInit, 'POST', '/auth/ksef-token', {
      body: {
        challenge: challenge.challenge,
        contextIdentifier: { type: 'Nip', value: this.opts.nip },
        encryptedToken: encryptKsefToken(this.opts.token, challenge.timestampMs, cert.certificate),
        publicKeyId: cert.publicKeyId,
      },
    })
    const authToken = init.authenticationToken.token

    for (let i = 0; ; i++) {
      const st = await this.json(AuthStatus, 'GET', `/auth/${init.referenceNumber}`, { bearer: authToken })
      if (st.status.code === 200) break
      if (st.status.code >= 400) {
        const details = st.status.details?.join('; ') ?? ''
        throw new KsefError(`authentication failed: ${st.status.code} ${st.status.description} ${details}`.trim())
      }
      if (i >= AUTH_POLLS) throw new KsefError('authentication did not finish in time')
      await this.sleep(1000)
    }

    const tokens = await this.json(Tokens, 'POST', '/auth/token/redeem', { bearer: authToken })
    this.session = {
      accessToken: tokens.accessToken.token,
      accessValidUntil: Date.parse(tokens.accessToken.validUntil),
      refreshToken: tokens.refreshToken.token,
    }
    this.logger.info(`authenticated to KSeF (${this.opts.env})`)
  }

  /** Returns a valid access token, refreshing it a minute before it expires. */
  async accessToken(): Promise<string> {
    if (this.session == null) await this.authenticate()
    const s = this.session!
    if (this.now() > s.accessValidUntil - 60_000) {
      const r = await this.json(Refreshed, 'POST', '/auth/token/refresh', { bearer: s.refreshToken })
      s.accessToken = r.accessToken.token
      s.accessValidUntil = Date.parse(r.accessToken.validUntil)
    }
    return s.accessToken
  }

  /** All invoice metadata for one subject type in a date range (by issue date), oldest first. */
  async queryMetadata(subjectType: SubjectType, from: string, to: string): Promise<InvoiceMetadata[]> {
    const out: InvoiceMetadata[] = []
    const seen = new Set<string>()
    let rangeFrom = from
    let pageOffset = 0
    for (;;) {
      const page = await this.json(
        MetadataPage,
        'POST',
        `/invoices/query/metadata?pageOffset=${pageOffset}&pageSize=${PAGE_SIZE}&sortOrder=Asc`,
        {
          bearer: await this.accessToken(),
          body: { subjectType, dateRange: { dateType: 'Issue', from: rangeFrom, to } },
        },
      )
      for (const inv of page.invoices) {
        if (!seen.has(inv.ksefNumber)) {
          seen.add(inv.ksefNumber)
          out.push(inv)
        }
      }
      if (page.isTruncated && page.invoices.length > 0) {
        // Result set capped: restart the query from the last date seen (duplicates are skipped above).
        const last = page.invoices[page.invoices.length - 1]!.issueDate
        const next = last.length === 10 ? `${last}T00:00:00${warsawOffset(new Date(`${last}T12:00:00Z`))}` : last
        if (next === rangeFrom) throw new KsefError(`more invoices on ${last} than one query can return`)
        rangeFrom = next
        pageOffset = 0
        continue
      }
      if (!page.hasMore) return out
      pageOffset++
    }
  }

  /** The invoice XML exactly as stored in KSeF (raw bytes: decoding would drop a BOM and change the hash). */
  async downloadXml(ksefNumber: string): Promise<Buffer> {
    const res = await this.call('GET', `/invoices/ksef/${encodeURIComponent(ksefNumber)}`, {
      bearer: await this.accessToken(),
      accept: 'application/xml',
    })
    return Buffer.from(await res.arrayBuffer())
  }
}
