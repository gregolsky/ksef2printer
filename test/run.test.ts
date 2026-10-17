import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { InvoiceMetadata, SubjectType } from '../src/ksef/client.js'
import { invoiceQrUrl } from '../src/ksef/qr.js'
import { noopLogger } from '../src/logger.js'
import type { JobOutcome } from '../src/printer/cups.js'
import { pruneRetention, runMonth, type RunDeps, type RunOptions } from '../src/run.js'

const fakeXml = (ksefNumber: string) => Buffer.from(`\ufeff<Faktura>${ksefNumber}</Faktura>`)
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('base64')

function meta(n: number, issueDate: string, seller = '1111111111'): InvoiceMetadata {
  const ksefNumber = `${seller}-20261015-${n}`
  return {
    ksefNumber,
    invoiceNumber: `FV/${n}`,
    issueDate,
    seller: { nip: seller, name: `Seller ${n}` },
    buyer: { identifier: { type: 'Nip', value: '2222222222' }, name: `Buyer ${n}` },
    grossAmount: 100 + n,
    currency: 'PLN',
    formCode: { systemCode: 'FA (3)', schemaVersion: '1-0E', value: 'FA' },
    invoiceHash: sha256(fakeXml(ksefNumber)),
  }
}

interface Fake {
  deps: RunDeps
  downloads: string[]
  rendered: string[]
  submitted: string[]
  notes: string[]
  bodies: string[]
  outcomes: JobOutcome[]
  printerChecks: number
  printerUp: boolean
}

function fake(invoices: Partial<Record<SubjectType, InvoiceMetadata[]>>): Fake {
  const f: Fake = { downloads: [], rendered: [], submitted: [], notes: [], bodies: [], outcomes: [], printerChecks: 0, printerUp: true, deps: undefined as unknown as RunDeps }
  let job = 0
  f.deps = {
    ksef: {
      queryMetadata: async (subject) => invoices[subject] ?? [],
      downloadXml: async (k) => {
        f.downloads.push(k)
        return fakeXml(k)
      },
    },
    render: async (xml, _k, qr) => {
      f.rendered.push(qr)
      return Buffer.concat([Buffer.from('%PDF-'), xml])
    },
    printer: {
      submit: async (file) => {
        f.submitted.push(file)
        return `ksef-${++job}`
      },
      waitForJob: async () => ({ outcome: f.outcomes.shift() ?? 'completed', reasons: '' }),
      cancel: async () => {},
    },
    checkPrinter: async () => {
      f.printerChecks++
      if (!f.printerUp) throw new Error('printer not reachable at 192.168.1.50:9100')
    },
    notifier: {
      send: async (title, body) => {
        f.notes.push(title)
        f.bodies.push(body)
      },
    },
    logger: noopLogger,
    sleep: async () => {},
    now: () => new Date('2026-10-20T10:00:00Z'),
  }
  return f
}

let dataDir: string
let opts: RunOptions

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'ksef2printer-'))
  opts = { month: { year: 2026, month: 10 }, env: 'test', dataDir, dryRun: false, printTimeoutMs: 1000, retryDelaysMs: [10, 30] }
})

describe('runMonth', () => {
  it('prints only `limit` invoices, purchases first, oldest first', async () => {
    const f = fake({ Subject1: [meta(1, '2026-10-02')], Subject2: [meta(3, '2026-10-09', '3333333333'), meta(2, '2026-10-05', '3333333333')] })
    const summary = await runMonth({ ...opts, limit: 1 }, f.deps)
    expect(summary).toMatchObject({ printed: 1, failed: 0, alreadyPrinted: 0, left: 2 })
    expect(f.submitted).toEqual([join(dataDir, 'invoices', '2026-10', '3333333333-20261015-2.pdf')])
  })

  it('skips invoices already printed on a rerun', async () => {
    const invoices = { Subject1: [meta(1, '2026-10-02'), meta(2, '2026-10-03')] }
    await runMonth({ ...opts, limit: 1 }, fake(invoices).deps)
    const second = fake(invoices)
    const summary = await runMonth(opts, second.deps)
    expect(summary).toMatchObject({ printed: 1, alreadyPrinted: 1, left: 0 })
    expect(second.submitted).toEqual([join(dataDir, 'invoices', '2026-10', '1111111111-20261015-2.pdf')])
  })

  it('writes XML, PDF and state for each printed invoice', async () => {
    await runMonth(opts, fake({ Subject1: [meta(1, '2026-10-02')] }).deps)
    const dir = join(dataDir, 'invoices', '2026-10')
    expect((await readdir(dir)).sort()).toEqual(['1111111111-20261015-1.pdf', '1111111111-20261015-1.xml'])
    const state = JSON.parse(await readFile(join(dataDir, 'state', '2026-10.json'), 'utf8'))
    expect(state['1111111111-20261015-1']).toMatchObject({ status: 'printed', attempts: 1, jobId: 'ksef-1', invoiceNumber: 'FV/1' })
  })

  it('retries a failed print and records success', async () => {
    const f = fake({ Subject1: [meta(1, '2026-10-02')] })
    f.outcomes.push('aborted')
    const summary = await runMonth(opts, f.deps)
    expect(summary.printed).toBe(1)
    expect(f.submitted).toHaveLength(2)
  })

  it('marks an invoice failed after all attempts and keeps going', async () => {
    const f = fake({ Subject1: [meta(1, '2026-10-02'), meta(2, '2026-10-03')] })
    f.outcomes.push('aborted', 'timeout', 'aborted')
    const summary = await runMonth(opts, f.deps)
    expect(summary).toMatchObject({ printed: 1, failed: 1 })
    expect(f.submitted).toHaveLength(4)
    const state = JSON.parse(await readFile(join(dataDir, 'state', '2026-10.json'), 'utf8'))
    expect(state['1111111111-20261015-1']).toMatchObject({ status: 'failed', attempts: 3 })
    expect(f.notes).toEqual(['ksef2printer 2026-10'])
    expect(f.bodies[0]).toContain('1 printed, 1 failed')
    expect(f.bodies[0]).toMatch(/\[FAILED {4}\] 2026-10-02 {2}SPRZEDAŻ FV\/1 \(Buyer 1\) {2}101\.00 PLN {2}1111111111-20261015-1\n {4}↳ not printed after 3 attempts: job ksef-3 aborted/)
    expect(f.bodies[0]).toContain('[PRINTED   ] 2026-10-03  SPRZEDAŻ FV/2 (Buyer 2)')
  })

  it('prints nothing on a dry run and sends the list marked as a dry run', async () => {
    const f = fake({ Subject1: [meta(1, '2026-10-02'), meta(2, '2026-10-03')] })
    const summary = await runMonth({ ...opts, dryRun: true, limit: 1 }, f.deps)
    expect(summary).toMatchObject({ printed: 0, left: 1 })
    expect(f.submitted).toEqual([])
    expect(f.downloads).toEqual([])
    expect(f.printerChecks).toBe(0)
    expect(f.notes).toEqual(['ksef2printer 2026-10 — DRY RUN'])
    expect(f.bodies[0]!.split('\n').slice(0, 4)).toEqual([
      'Dry run: nothing was printed.',
      '2026-10: 1 would print, 0 already printed, 1 left for a later run (limit)',
      '',
      '[WILL PRINT] 2026-10-02  SPRZEDAŻ FV/1 (Buyer 1)  101.00 PLN  1111111111-20261015-1',
    ])
    expect(f.bodies[0]).toContain('[later     ] 2026-10-03')
  })

  it('sends one summary listing every invoice, and none per invoice', async () => {
    const invoices = { Subject1: [meta(1, '2026-10-02'), meta(2, '2026-10-03')], Subject2: [meta(3, '2026-10-01', '3333333333')] }
    await runMonth({ ...opts, limit: 1 }, fake(invoices).deps)
    const f = fake(invoices)
    const summary = await runMonth(opts, f.deps)
    expect(f.notes).toEqual(['ksef2printer 2026-10'])
    expect(summary.lines).toEqual([
      '[printed   ] 2026-10-01  ZAKUP FV/3 (Seller 3)  103.00 PLN  3333333333-20261015-3',
      '[PRINTED   ] 2026-10-02  SPRZEDAŻ FV/1 (Buyer 1)  101.00 PLN  1111111111-20261015-1',
      '[PRINTED   ] 2026-10-03  SPRZEDAŻ FV/2 (Buyer 2)  102.00 PLN  1111111111-20261015-2',
    ])
    expect(f.bodies[0]).toBe(['2026-10: 2 printed, 0 failed, 1 already printed', '', ...summary.lines].join('\n'))
  })

  it('still reports when the month has nothing to print', async () => {
    const f = fake({})
    await runMonth(opts, f.deps)
    expect(f.bodies).toEqual(['2026-10: 0 printed, 0 failed, 0 already printed\nNo invoices in KSeF for this month.'])
  })

  it('keeps the XML byte for byte and puts the KSeF hash in the QR code', async () => {
    const f = fake({ Subject1: [meta(1, '2026-10-02')] })
    await runMonth(opts, f.deps)
    const xml = await readFile(join(dataDir, 'invoices', '2026-10', '1111111111-20261015-1.xml'))
    expect(xml.equals(fakeXml('1111111111-20261015-1'))).toBe(true)
    expect(f.rendered).toEqual([invoiceQrUrl('test', '1111111111', '2026-10-02', meta(1, '2026-10-02').invoiceHash)])
  })

  it('does not print an invoice whose XML does not match the KSeF hash', async () => {
    const f = fake({ Subject1: [{ ...meta(1, '2026-10-02'), invoiceHash: sha256(Buffer.from('other')) }] })
    const summary = await runMonth(opts, f.deps)
    expect(summary.failed).toBe(1)
    expect(f.submitted).toEqual([])
  })

  it('downloads again and re-renders when a saved XML is damaged', async () => {
    const dir = join(dataDir, 'invoices', '2026-10')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '1111111111-20261015-1.xml'), '<Fak')
    await writeFile(join(dir, '1111111111-20261015-1.pdf'), 'stale')
    const f = fake({ Subject1: [meta(1, '2026-10-02')] })
    await runMonth(opts, f.deps)
    expect(f.downloads).toEqual(['1111111111-20261015-1'])
    expect(f.rendered).toHaveLength(1)
  })

  it('reuses saved XML and PDF on a retry run', async () => {
    const invoices = { Subject1: [meta(1, '2026-10-02')] }
    const first = fake(invoices)
    first.outcomes.push('aborted', 'aborted', 'aborted')
    await runMonth(opts, first.deps)
    const second = fake(invoices)
    await runMonth(opts, second.deps)
    expect(second.downloads).toEqual([])
    expect(second.rendered).toEqual([])
    expect(second.submitted).toHaveLength(1)
  })

  it('checks the printer once before printing', async () => {
    const f = fake({ Subject1: [meta(1, '2026-10-02'), meta(2, '2026-10-03')] })
    await runMonth(opts, f.deps)
    expect(f.printerChecks).toBe(1)
  })

  it('stops before printing anything when the printer is unreachable', async () => {
    const f = fake({ Subject1: [meta(1, '2026-10-02')] })
    f.printerUp = false
    const summary = await runMonth(opts, f.deps)
    expect(summary.stopped).toContain('printer not reachable')
    expect(f.downloads).toEqual([])
    expect(f.submitted).toEqual([])
    expect(f.notes).toEqual(['✗ ksef2printer 2026-10 stopped'])
  })

  it('does not check the printer when there is nothing to print', async () => {
    const f = fake({})
    await runMonth(opts, f.deps)
    expect(f.printerChecks).toBe(0)
  })

  it('stops at the first timeout when the printer has gone away', async () => {
    const f = fake({ Subject1: [meta(1, '2026-10-02'), meta(2, '2026-10-03')] })
    f.outcomes.push('timeout')
    f.deps.printer.cancel = async () => {
      f.printerUp = false
    }
    expect((await runMonth(opts, f.deps)).stopped).toContain('printer not reachable')
    expect(f.submitted).toHaveLength(1)
    const state = JSON.parse(await readFile(join(dataDir, 'state', '2026-10.json'), 'utf8'))
    expect(state['1111111111-20261015-1']).toMatchObject({ status: 'failed', attempts: 1 })
  })

  it('stops the run when every attempt times out, instead of waiting on each invoice', async () => {
    const f = fake({ Subject1: [meta(1, '2026-10-02'), meta(2, '2026-10-03')] })
    f.outcomes.push('timeout', 'timeout', 'timeout')
    expect((await runMonth(opts, f.deps)).stopped).toContain('printer stopped responding')
    expect(f.submitted).toHaveLength(3)
  })

  it('lists what printed and what did not when printing stops part way', async () => {
    const f = fake({ Subject1: [meta(1, '2026-10-02'), meta(2, '2026-10-03'), meta(3, '2026-10-04')] })
    f.outcomes.push('completed', 'timeout', 'timeout', 'timeout')
    const summary = await runMonth(opts, f.deps)
    expect(summary).toMatchObject({ printed: 1, failed: 0 })
    expect(f.notes).toEqual(['✗ ksef2printer 2026-10 stopped'])
    const body = f.bodies[0]!.split('\n')
    expect(body[0]).toBe('Stopped: printer stopped responding: SPRZEDAŻ FV/2 (Buyer 2) timed out on all 3 attempts')
    expect(body[2]).toBe('2026-10: 1 printed, 0 failed, 2 not printed yet, 0 already printed')
    expect(body.slice(4).map((l) => l.slice(0, 12))).toEqual(['[PRINTED   ]', '[NOT YET   ]', '[NOT YET   ]'])
  })

  it('does not print when the PDF cannot be produced', async () => {
    const f = fake({ Subject1: [meta(1, '2026-10-02')] })
    f.deps.render = async () => {
      throw new Error('Unknown XML Version')
    }
    const summary = await runMonth(opts, f.deps)
    expect(summary.failed).toBe(1)
    expect(f.submitted).toEqual([])
  })
})

describe('pruneRetention', () => {
  it('removes months that ended more than a year ago', async () => {
    await mkdir(join(dataDir, 'state'), { recursive: true })
    await mkdir(join(dataDir, 'logs'), { recursive: true })
    for (const m of ['2025-09', '2025-10', '2026-10']) {
      await mkdir(join(dataDir, 'invoices', m), { recursive: true })
      await writeFile(join(dataDir, 'state', `${m}.json`), '{}')
      await writeFile(join(dataDir, 'logs', `${m}-16.log`), '')
    }
    await pruneRetention(dataDir, new Date('2026-10-20T00:00:00Z'), 12, noopLogger)
    expect((await readdir(join(dataDir, 'invoices'))).sort()).toEqual(['2025-10', '2026-10'])
    expect((await readdir(join(dataDir, 'state'))).sort()).toEqual(['2025-10.json', '2026-10.json'])
    expect((await readdir(join(dataDir, 'logs'))).sort()).toEqual(['2025-10-16.log', '2026-10-16.log'])
  })
})

describe('invoiceQrUrl', () => {
  it('builds the KOD I link from seller NIP, issue date and file hash', () => {
    expect(invoiceQrUrl('test', '1111111111', '2026-02-01', sha256(Buffer.from('x')))).toBe(
      'https://qr-test.ksef.mf.gov.pl/invoice/1111111111/01-02-2026/LXEWQrcmsEQBYnyp-6wy9chTD7GQPMTbAiWHF5IaSIE',
    )
  })
})
