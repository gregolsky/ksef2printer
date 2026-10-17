import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { exists, writeFileAtomic } from './fs.js'
import type { InvoiceMetadata, KsefEnv, SubjectType } from './ksef/client.js'
import { invoiceQrUrl } from './ksef/qr.js'
import { formatMonth, monthBounds, type Month } from './ksef/time.js'
import type { Logger } from './logger.js'
import { sendLong, type Notifier, type NotifyOptions } from './notify.js'
import type { JobOutcome } from './printer/cups.js'
import { loadState, saveState, type DocState, type MonthState } from './state.js'

export interface RunDeps {
  ksef: {
    queryMetadata(subject: SubjectType, from: string, to: string): Promise<InvoiceMetadata[]>
    downloadXml(ksefNumber: string): Promise<Buffer>
  }
  render(xml: Buffer, ksefNumber: string, qrCode: string): Promise<Buffer>
  printer: {
    submit(file: string, title: string): Promise<string>
    waitForJob(jobId: string, timeoutMs: number): Promise<{ outcome: JobOutcome; reasons: string }>
    cancel(jobId: string): Promise<void>
  }
  /** Throws if the printer cannot be reached; checked before printing and after a job times out. */
  checkPrinter(): Promise<void>
  notifier: Notifier
  logger: Logger
  sleep(ms: number): Promise<void>
  now(): Date
}

export interface RunOptions {
  month: Month
  env: KsefEnv
  dataDir: string
  /** Print at most this many invoices in this run. */
  limit?: number
  dryRun: boolean
  printTimeoutMs: number
  /** Waits between print attempts; attempts = delays + 1. */
  retryDelaysMs: readonly number[]
  retentionMonths?: number
}

export interface RunSummary {
  printed: number
  failed: number
  alreadyPrinted: number
  left: number
  /** One line per invoice of the month, as logged and sent in the summary notification. */
  lines: string[]
  /** Why printing stopped part way (printer gone, disk error…); the rest prints on the next run. */
  stopped?: string
}

type Kind = 'purchase' | 'sale'

interface Doc {
  kind: Kind
  meta: InvoiceMetadata
}

function label(d: Doc): string {
  const who = d.kind === 'purchase' ? d.meta.seller.name : d.meta.buyer.name
  return `${d.kind === 'purchase' ? 'ZAKUP' : 'SPRZEDAŻ'} ${d.meta.invoiceNumber}${who != null ? ` (${who})` : ''}`
}

type Mark = 'printed' | 'WILL PRINT' | 'later' | 'PRINTED' | 'FAILED' | 'NOT YET'

/** `[WILL PRINT] 2026-09-05  SPRZEDAŻ FV/7/2026 (Client s.c.)  500.00 PLN  <KSeF number>` */
export function invoiceLine(d: Doc, mark: Mark): string {
  const { issueDate, grossAmount, currency, ksefNumber } = d.meta
  return `[${mark.padEnd(10)}] ${issueDate.slice(0, 10)}  ${label(d)}  ${grossAmount.toFixed(2)} ${currency}  ${ksefNumber}`
}

/** Deletes invoice files, print state and run logs for months that ended more than `months` months ago. */
export async function pruneRetention(dataDir: string, now: Date, months: number, logger: Logger): Promise<void> {
  const cutoff = now.getUTCFullYear() * 12 + now.getUTCMonth() - months
  const old = (name: string) => {
    const m = /^(\d{4})-(\d{2})/.exec(name)
    return m != null && Number(m[1]) * 12 + Number(m[2]) - 1 < cutoff
  }
  for (const [dir, suffix] of [
    [join(dataDir, 'invoices'), ''],
    [join(dataDir, 'state'), '.json'],
    [join(dataDir, 'logs'), '.log'],
  ] as const) {
    let entries: string[] = []
    try {
      entries = await readdir(dir)
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.endsWith(suffix) && old(e)) {
        await rm(join(dir, e), { recursive: true, force: true })
        logger.info(`retention: removed ${join(dir, e)}`)
      }
    }
  }
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('base64')

/**
 * Downloads the XML and renders the PDF, reusing files left by an earlier run. The XML must match the
 * hash KSeF reports for the invoice: that hash is what the printed QR code (KOD I) verifies.
 * Returns the PDF path.
 */
async function preparePdf(d: Doc, dir: string, env: KsefEnv, deps: RunDeps): Promise<string> {
  const k = d.meta.ksefNumber
  const xmlPath = join(dir, `${k}.xml`)
  const pdfPath = join(dir, `${k}.pdf`)
  let xml: Buffer | null = (await exists(xmlPath)) ? await readFile(xmlPath) : null
  if (xml == null || sha256(xml) !== d.meta.invoiceHash) {
    xml = await deps.ksef.downloadXml(k)
    if (sha256(xml) !== d.meta.invoiceHash) throw new Error('downloaded XML does not match the hash KSeF reports for it')
    await writeFileAtomic(xmlPath, xml)
    await rm(pdfPath, { force: true })
  }
  if (!(await exists(pdfPath))) {
    const qr = invoiceQrUrl(env, d.meta.seller.nip, d.meta.issueDate, d.meta.invoiceHash)
    await writeFileAtomic(pdfPath, await deps.render(xml, k, qr))
  }
  return pdfPath
}

type Attempt = { ok: true; jobId: string } | { ok: false; error: string; jobId?: string; timedOut?: boolean }

/** Submits the PDF once and waits for the job to finish; a job that times out is cancelled. */
async function printOnce(printer: RunDeps['printer'], pdfPath: string, title: string, timeoutMs: number): Promise<Attempt> {
  let jobId: string | undefined
  try {
    jobId = await printer.submit(pdfPath, title)
    const { outcome, reasons } = await printer.waitForJob(jobId, timeoutMs)
    if (outcome === 'completed') return { ok: true, jobId }
    if (outcome === 'timeout') await printer.cancel(jobId)
    const error = `job ${jobId} ${outcome}${reasons !== '' ? ` (${reasons})` : ''}`
    return { ok: false, jobId, error, timedOut: outcome === 'timeout' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), ...(jobId != null ? { jobId } : {}) }
  }
}

interface PrintContext {
  opts: RunOptions
  deps: RunDeps
  key: string
  state: MonthState
  stateFile: string
  summary: RunSummary
  marks: Map<Doc, Mark>
  reasons: Map<Doc, string>
}

/** Prints the selected invoices in order, recording each outcome. Throws when printing can't go on. */
async function printSelected(selected: readonly Doc[], ctx: PrintContext): Promise<void> {
  const { opts, deps, key, state, stateFile, summary, marks, reasons } = ctx
  const { logger: log } = deps
  if (selected.length === 0) return
  await deps.checkPrinter()
  const dir = join(opts.dataDir, 'invoices', key)
  await mkdir(dir, { recursive: true })

  for (const [i, d] of selected.entries()) {
    const k = d.meta.ksefNumber
    const record = (s: Omit<DocState, 'issueDate' | 'invoiceNumber' | 'updatedAt'>): DocState => ({
      ...s,
      issueDate: d.meta.issueDate,
      invoiceNumber: d.meta.invoiceNumber,
      updatedAt: deps.now().toISOString(),
    })

    let pdfPath: string
    try {
      pdfPath = await preparePdf(d, dir, opts.env, deps)
    } catch (err) {
      const error = `could not prepare PDF: ${err instanceof Error ? err.message : String(err)}`
      state[k] = record({ status: 'failed', attempts: 0, error })
      await saveState(stateFile, state)
      summary.failed++
      marks.set(d, 'FAILED')
      reasons.set(d, error)
      log.error(`${invoiceLine(d, 'FAILED')}: ${error}`)
      continue
    }

    log.info(`printing ${i + 1}/${selected.length}: ${label(d)}`)
    const attempts = opts.retryDelaysMs.length + 1
    let last = ''
    let printed = false
    let timeouts = 0
    let jobId: string | undefined
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const result = await printOnce(deps.printer, pdfPath, d.meta.invoiceNumber, opts.printTimeoutMs)
      jobId = result.jobId ?? jobId
      if (result.ok) {
        printed = true
        state[k] = record({ status: 'printed', attempts: attempt, jobId: result.jobId })
        break
      }
      last = result.error
      log.warn(`${label(d)}: attempt ${attempt}/${attempts} failed: ${last}`)
      state[k] = record({ status: 'failed', attempts: attempt, error: last, ...(jobId != null ? { jobId } : {}) })
      await saveState(stateFile, state)
      // A printer that went away would make every remaining invoice wait out its timeouts: stop instead.
      if (result.timedOut === true) {
        timeouts++
        await deps.checkPrinter()
      }
      const delay = opts.retryDelaysMs[attempt - 1]
      if (delay != null) await deps.sleep(delay)
    }
    await saveState(stateFile, state)

    if (!printed && timeouts === attempts) {
      throw new Error(`printer stopped responding: ${label(d)} timed out on all ${attempts} attempts`)
    }

    if (printed) {
      summary.printed++
      marks.set(d, 'PRINTED')
      log.info(invoiceLine(d, 'PRINTED'))
    } else {
      summary.failed++
      marks.set(d, 'FAILED')
      reasons.set(d, `not printed after ${attempts} attempts: ${last}`)
      log.error(`${invoiceLine(d, 'FAILED')}: not printed after ${attempts} attempts: ${last}`)
    }
  }
}

export async function runMonth(opts: RunOptions, deps: RunDeps): Promise<RunSummary> {
  const { logger: log } = deps
  const key = formatMonth(opts.month)
  if (!opts.dryRun) await pruneRetention(opts.dataDir, deps.now(), opts.retentionMonths ?? 12, log)

  const { from, to } = monthBounds(opts.month)
  const purchases = await deps.ksef.queryMetadata('Subject2', from, to)
  const sales = await deps.ksef.queryMetadata('Subject1', from, to)
  const byDate = (a: Doc, b: Doc) =>
    a.meta.issueDate.localeCompare(b.meta.issueDate) || a.meta.invoiceNumber.localeCompare(b.meta.invoiceNumber)
  const docs: Doc[] = [
    ...purchases.map((meta): Doc => ({ kind: 'purchase', meta })).sort(byDate),
    ...sales.map((meta): Doc => ({ kind: 'sale', meta })).sort(byDate),
  ]

  const stateFile = join(opts.dataDir, 'state', `${key}.json`)
  const state = await loadState(stateFile)
  const todo = docs.filter((d) => state[d.meta.ksefNumber]?.status !== 'printed')
  const selected = opts.limit != null ? todo.slice(0, opts.limit) : todo
  const summary: RunSummary = { printed: 0, failed: 0, alreadyPrinted: docs.length - todo.length, left: todo.length - selected.length, lines: [] }

  log.info(`${key}: ${purchases.length} purchases, ${sales.length} sales, ${summary.alreadyPrinted} already printed, ${selected.length} to print`)

  // Marks before this run; the print loop replaces them with PRINTED / FAILED.
  const marks = new Map<Doc, Mark>()
  const reasons = new Map<Doc, string>()
  const initialMark = (d: Doc): Mark => {
    if (state[d.meta.ksefNumber]?.status === 'printed') return 'printed'
    return selected.includes(d) ? 'WILL PRINT' : 'later'
  }
  for (const d of docs) marks.set(d, initialMark(d))

  if (opts.dryRun) {
    summary.lines = docs.map((d) => invoiceLine(d, marks.get(d)!))
    for (const line of summary.lines) log.info(line)
    await notifySummary(key, summary, { dryRun: true, toPrint: selected.length }, deps)
    return summary
  }

  try {
    await printSelected(selected, { opts, deps, key, state, stateFile, summary, marks, reasons })
  } catch (err) {
    // Printing can't go on (printer gone, disk full…): report what got done, the rest prints next run.
    summary.stopped = err instanceof Error ? err.message : String(err)
    log.error(`${key}: stopped: ${summary.stopped}`)
    for (const d of selected) if (marks.get(d) === 'WILL PRINT') marks.set(d, 'NOT YET')
  }

  summary.lines = docs.flatMap((d) => {
    const reason = reasons.get(d)
    return reason != null ? [invoiceLine(d, marks.get(d)!), `    ↳ ${reason}`] : [invoiceLine(d, marks.get(d)!)]
  })
  await notifySummary(key, summary, { dryRun: false, toPrint: selected.length }, deps)
  return summary
}

function summaryTitle(key: string, dryRun: boolean, summary: RunSummary): string {
  if (dryRun) return `ksef2printer ${key} — DRY RUN`
  if (summary.stopped != null) return `✗ ksef2printer ${key} stopped`
  return `ksef2printer ${key}`
}

function summaryStyle(dryRun: boolean, summary: RunSummary): NotifyOptions {
  if (dryRun) return { tags: ['mag'] }
  if (summary.stopped != null) return { priority: 'high', tags: ['x'] }
  if (summary.failed > 0) return { priority: 'high', tags: ['warning'] }
  return { tags: ['white_check_mark'] }
}

/** Logs the counts and sends one notification listing every invoice of the month. */
async function notifySummary(
  key: string,
  summary: RunSummary,
  { dryRun, toPrint }: { dryRun: boolean; toPrint: number },
  deps: RunDeps,
): Promise<void> {
  const left = summary.left > 0 ? `, ${summary.left} left for a later run (limit)` : ''
  const notYet = toPrint - summary.printed - summary.failed
  const stopped = summary.stopped != null ? `, ${notYet} not printed yet` : ''
  const counts = dryRun
    ? `${key}: ${toPrint} would print, ${summary.alreadyPrinted} already printed${left}`
    : `${key}: ${summary.printed} printed, ${summary.failed} failed${stopped}, ${summary.alreadyPrinted} already printed${left}`
  deps.logger.info(counts)
  let header = [counts]
  if (dryRun) header = ['Dry run: nothing was printed.', counts]
  if (summary.stopped != null) header = [`Stopped: ${summary.stopped}`, 'Run the month again to print the rest.', counts]
  const body = summary.lines.length > 0 ? [...header, '', ...summary.lines] : [...header, 'No invoices in KSeF for this month.']
  await sendLong(deps.notifier, summaryTitle(key, dryRun, summary), body, summaryStyle(dryRun, summary))
}
