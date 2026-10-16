import { describe, expect, it } from 'vitest'
import { KsefClient, KsefError, type InvoiceMetadata } from '../src/ksef/client.js'

// Self-signed throwaway certificate (public part only), so the real token encryption runs.
const TEST_CERT = 'MIIDKTCCAhGgAwIBAgIUcea+T7tpAs2KJyg2wKzFRyAzZi8wDQYJKoZIhvcNAQELBQAwJDEiMCAGA1UEAwwZa3NlZjJwcmludGVyIHRlc3QgZml4dHVyZTAeFw0yNjEwMTYxODExMDFaFw0zNjEwMTMxODExMDFaMCQxIjAgBgNVBAMMGWtzZWYycHJpbnRlciB0ZXN0IGZpeHR1cmUwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDSrp6smzY80c47M1/5tKFbAXsL6zFzWEhWPF+fx4DhpU3VvHJEPYSwo4sQKoZlIREaUxaeW0N4ZzFlvYB4O2sBoaW8vO7oMQ3fxQbDPcd571V5hSCDZRprkwObUpFZL6JGvjSEqJJJ/V/i2SPFA9l4Y3jIl0u7AZ66k2lTRKzpD5j0JD/GEyfEd1jr3s1N1+s9K732B/vZfi51thu+4OfeBOauEY51uedeEIJuNpkNb2VnsY8y+z/k/B8DbPi44V7tXyYYfIF5iAqpIzk6/2rFk6VUgYiZpOENHJcTRzTQrlznyh8VyHSyl/dNOlt+uEmwdR2na7nV2TsRrBHDFBGbAgMBAAGjUzBRMB0GA1UdDgQWBBS8uoXqHx0CGn1YY+h1w3i4lkxavzAfBgNVHSMEGDAWgBS8uoXqHx0CGn1YY+h1w3i4lkxavzAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQCAW/dEpoz6nMe1kKHrbfLi9clINX+UNgDWmAfa3iRBX4fqjjU0MltQnORunSx9qDFApQJ4KZ75VJG/C12nUQQ1/zcIeWDY+ECOjBF1tbdTBxeezwOukXnqLd3dsd+lr3HqE24eYCTDcoAcOiIf3oovK2jmYLSnqTD/JbKKky/w4iZnJwdTCPhFOy1uiFMsKEAdAwmi4ElsqCsJi/Pwhl2jpHhso2bC/D3nBBMoVpLj0MR9BqX2P+qOxBf6Lz9wRA3ad+JxSODqNGlOdFew8tJKDXp/Thz1Tc5QUvP6JhSY6G8iySyASMY66Qn+Sc7uDG+I4Cx3n4jOl3ucKhQew/ve'

interface Call {
  method: string
  path: string
  query: URLSearchParams
  body: unknown
  bearer: string | undefined
}

type Handler = (call: Call) => Response | Promise<Response>

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

const token = (t: string, validUntil = '2026-10-20T12:00:00Z') => ({ token: t, validUntil })

/** Routes requests by "METHOD /path" to handlers; each handler may be a queue consumed one per call. */
function fakeKsef(extra: Record<string, Handler | Handler[]> = {}) {
  const calls: Call[] = []
  const routes: Record<string, Handler | Handler[]> = {
    'POST /auth/challenge': () => json({ challenge: 'CH-1', timestampMs: 1_760_000_000_000 }),
    'GET /security/public-key-certificates': () =>
      json([
        { certificate: TEST_CERT, publicKeyId: 'k1', validFrom: '2020-01-01T00:00:00Z', validTo: '2099-01-01T00:00:00Z', usage: ['KsefTokenEncryption'] },
      ]),
    'POST /auth/ksef-token': () => json({ referenceNumber: 'REF-1', authenticationToken: token('auth-token') }),
    'GET /auth/REF-1': [() => json({ status: { code: 100, description: 'in progress' } }), () => json({ status: { code: 200, description: 'ok' } })],
    'POST /auth/token/redeem': () => json({ accessToken: token('access-1'), refreshToken: token('refresh-1', '2026-10-27T12:00:00Z') }),
    ...extra,
  }
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const path = url.pathname.replace(/^\/v2/, '')
    const auth = (init?.headers as Record<string, string> | undefined)?.['Authorization']
    const call: Call = {
      method: init?.method ?? 'GET',
      path,
      query: url.searchParams,
      body: init?.body != null ? JSON.parse(String(init.body)) : undefined,
      bearer: auth?.replace(/^Bearer /, ''),
    }
    calls.push(call)
    const route = routes[`${call.method} ${path}`]
    const handler = Array.isArray(route) ? (route.length > 1 ? route.shift() : route[0]) : route
    if (handler == null) return json({ error: 'no route' }, 404)
    return handler(call)
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

const sleeps: number[] = []
function client(fetch: typeof globalThis.fetch, now = () => Date.parse('2026-10-16T12:00:00Z')) {
  sleeps.length = 0
  return new KsefClient({
    env: 'test',
    nip: '1111111111',
    token: 'secret-token',
    fetch,
    now,
    sleep: async (ms) => void sleeps.push(ms),
  })
}

function inv(n: number, issueDate: string): InvoiceMetadata {
  return {
    ksefNumber: `1111111111-20261015-${n}`,
    invoiceNumber: `FV/${n}`,
    issueDate,
    seller: { nip: '1111111111', name: 'Seller' },
    buyer: { identifier: { type: 'Nip', value: '2222222222' }, name: 'Buyer' },
    grossAmount: 100,
    currency: 'PLN',
    formCode: { systemCode: 'FA (3)', schemaVersion: '1-0E', value: 'FA' },
    invoiceHash: 'aGFzaA==',
  }
}

const page = (invoices: InvoiceMetadata[], hasMore = false, isTruncated = false) => json({ hasMore, isTruncated, invoices })
const FROM = '2026-10-01T00:00:00+02:00'
const TO = '2026-10-31T23:59:59+01:00'

describe('KsefClient authentication', () => {
  it('sends the encrypted token, polls until done and uses the access token', async () => {
    const k = fakeKsef({ 'POST /invoices/query/metadata': () => page([]) })
    await client(k.fetch).queryMetadata('Subject1', FROM, TO)
    const init = k.calls.find((c) => c.path === '/auth/ksef-token')!
    expect(init.body).toMatchObject({ challenge: 'CH-1', contextIdentifier: { type: 'Nip', value: '1111111111' }, publicKeyId: 'k1' })
    const encrypted = (init.body as { encryptedToken: string }).encryptedToken
    expect(Buffer.from(encrypted, 'base64')).toHaveLength(256)
    expect(encrypted).not.toContain('secret-token')
    expect(k.calls.filter((c) => c.path === '/auth/REF-1')).toHaveLength(2)
    expect(k.calls.find((c) => c.path === '/invoices/query/metadata')!.bearer).toBe('access-1')
  })

  it('reports why authentication was rejected', async () => {
    const k = fakeKsef({ 'GET /auth/REF-1': () => json({ status: { code: 450, description: 'Invalid token', details: ['revoked'] } }) })
    await expect(client(k.fetch).accessToken()).rejects.toThrow('authentication failed: 450 Invalid token revoked')
  })

  it('refreshes the access token shortly before it expires', async () => {
    let now = Date.parse('2026-10-16T12:00:00Z')
    const k = fakeKsef({
      'POST /auth/token/redeem': () => json({ accessToken: token('access-1', '2026-10-16T12:15:00Z'), refreshToken: token('refresh-1') }),
      'POST /auth/token/refresh': () => json({ accessToken: token('access-2', '2026-10-16T12:30:00Z') }),
    })
    const c = client(k.fetch, () => now)
    expect(await c.accessToken()).toBe('access-1')
    now = Date.parse('2026-10-16T12:14:30Z')
    expect(await c.accessToken()).toBe('access-2')
    expect(k.calls.find((x) => x.path === '/auth/token/refresh')!.bearer).toBe('refresh-1')
  })
})

describe('KsefClient.queryMetadata', () => {
  it('reads every page', async () => {
    const k = fakeKsef({ 'POST /invoices/query/metadata': [() => page([inv(1, '2026-10-01')], true), () => page([inv(2, '2026-10-02')])] })
    const result = await client(k.fetch).queryMetadata('Subject2', FROM, TO)
    expect(result.map((i) => i.invoiceNumber)).toEqual(['FV/1', 'FV/2'])
    const queries = k.calls.filter((c) => c.path === '/invoices/query/metadata')
    expect(queries.map((c) => c.query.get('pageOffset'))).toEqual(['0', '1'])
    expect(queries[0]!.body).toEqual({ subjectType: 'Subject2', dateRange: { dateType: 'Issue', from: FROM, to: TO } })
  })

  it('restarts a capped result from the last date and skips duplicates', async () => {
    const k = fakeKsef({
      'POST /invoices/query/metadata': [
        () => page([inv(1, '2026-10-01'), inv(2, '2026-10-10')], true, true),
        () => page([inv(2, '2026-10-10'), inv(3, '2026-10-11')]),
      ],
    })
    const result = await client(k.fetch).queryMetadata('Subject1', FROM, TO)
    expect(result.map((i) => i.invoiceNumber)).toEqual(['FV/1', 'FV/2', 'FV/3'])
    const second = k.calls.filter((c) => c.path === '/invoices/query/metadata')[1]!
    expect(second.query.get('pageOffset')).toBe('0')
    expect(second.body).toMatchObject({ dateRange: { from: '2026-10-10T00:00:00+02:00', to: TO } })
  })

  it('fails rather than loop when one day has more invoices than a query returns', async () => {
    const k = fakeKsef({ 'POST /invoices/query/metadata': () => page([inv(1, '2026-10-10')], true, true) })
    await expect(client(k.fetch).queryMetadata('Subject1', FROM, TO)).rejects.toThrow('more invoices on 2026-10-10')
  })

  it('rejects an invoice number that is not a KSeF number', async () => {
    const k = fakeKsef({ 'POST /invoices/query/metadata': () => page([{ ...inv(1, '2026-10-01'), ksefNumber: '../../etc/x' }]) })
    await expect(client(k.fetch).queryMetadata('Subject1', FROM, TO)).rejects.toThrow('not a KSeF number')
  })
})

describe('KsefClient retries', () => {
  it('waits as long as Retry-After says on 429', async () => {
    const k = fakeKsef({ 'POST /auth/challenge': [() => json({}, 429, { 'Retry-After': '3' }), () => json({ challenge: 'CH-1', timestampMs: 1 })] })
    await client(k.fetch).accessToken()
    expect(sleeps[0]).toBe(3000)
  })

  it('fails instead of waiting when Retry-After is longer than a minute', async () => {
    const k = fakeKsef({ 'POST /auth/challenge': () => json({}, 429, { 'Retry-After': '3600' }) })
    await expect(client(k.fetch).accessToken()).rejects.toThrow('KSeF asks to wait 3600s')
    expect(sleeps).toEqual([])
  })

  it('retries network errors', async () => {
    const k = fakeKsef()
    let failures = 1
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      if (failures-- > 0) throw new TypeError('fetch failed')
      return k.fetch(input, init)
    }) as typeof globalThis.fetch
    expect(await client(flaky).accessToken()).toBe('access-1')
    expect(sleeps[0]).toBe(2000)
  })

  it('gives up after four attempts', async () => {
    const k = fakeKsef({ 'POST /auth/challenge': () => json({}, 503) })
    await expect(client(k.fetch).accessToken()).rejects.toMatchObject({ status: 503 })
    expect(k.calls).toHaveLength(4)
  })

  it('does not retry client errors', async () => {
    const k = fakeKsef({ 'POST /auth/challenge': () => json({ exception: 'bad' }, 400) })
    const err = await client(k.fetch).accessToken().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(KsefError)
    expect(k.calls).toHaveLength(1)
  })
})

describe('KsefClient.downloadXml', () => {
  it('returns the XML bytes unchanged, including a byte order mark', async () => {
    const xml = Buffer.from('﻿<Faktura>zażółć</Faktura>')
    const k = fakeKsef({ 'GET /invoices/ksef/1111111111-20261015-1': () => new Response(xml, { headers: { 'Content-Type': 'application/xml' } }) })
    const got = await client(k.fetch).downloadXml('1111111111-20261015-1')
    expect(got.equals(xml)).toBe(true)
  })
})
