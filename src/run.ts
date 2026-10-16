import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { InvoiceMetadata, KsefEnv, SubjectType } from './ksef/client.js'
import { invoiceQrUrl } from './ksef/qr.js'
import { formatMonth, monthBounds, type Month } from './ksef/time.js'
import type { Logger } from './logger.js'
import type { Notifier } from './notify.js'
import type { JobOutcome } from './printer/cups.js'
import { loadState, saveState, type DocState } from './state.js'

export interface RunDeps {
  ksef: {
    queryMetadata(subject: SubjectType, from: string, to: string): Promise<InvoiceMetadata[]>
    downloadXml(ksefNumber: string): Promise<string>
  }
  render(xml: Buffer, ksefNumber: string, qrCode: string): Promise<Buffer>
  printer: {
    submit(file: string, title: string): Promise<string>
    waitForJob(jobId: string, timeoutMs: number): Promise<{ outcome: JobOutcome; reasons: string }>
    cancel(jobId: string): Promise<void>
  }
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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Deletes invoice files and print state for months that ended more than `months` months ago. */
export async function pruneRetention(dataDir: string, now: Date, months: number, logger: Logger): Promise<void> {
  const cutoff = now.getUTCFullYear() * 12 + now.getUTCMonth() - months
  const old = (name: string) => {
    const m = /^(\d{4})-(\d{2})/.exec(name)
    return m != null && Number(m[1]) * 12 + Number(m[2]) - 1 < cutoff
  }
  for (const [dir, suffix] of [
    [join(dataDir, 'invoices'), ''],
    [join(dataDir, 'state'), '.json'],
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

/** Downloads the XML and renders the PDF, reusing files left by an earlier run. Returns the PDF path. */
async function preparePdf(d: Doc, dir: string, env: KsefEnv, deps: RunDeps): Promise<string> {
  const k = d.meta.ksefNumber
  const xmlPath = join(dir, `${k}.xml`)
  const pdfPath = join(dir, `${k}.pdf`)
  if (!(await exists(xmlPath))) await writeFile(xmlPath, await deps.ksef.downloadXml(k))
  if (!(await exists(pdfPath))) {
    const xml = await readFile(xmlPath)
    const qr = invoiceQrUrl(env, d.meta.seller.nip, d.meta.issueDate, xml)
    await writeFile(pdfPath, await deps.render(xml, k, qr))
  }
  return pdfPath
}

type Attempt = { ok: true; jobId: string } | { ok: false; error: string; jobId?: string }

/** Submits the PDF once and waits for the job to finish; a job that times out is cancelled. */
async function printOnce(printer: RunDeps['printer'], pdfPath: string, title: string, timeoutMs: number): Promise<Attempt> {
  let jobId: string | undefined
  try {
    jobId = await printer.submit(pdfPath, title)
    const { outcome, reasons } = await printer.waitForJob(jobId, timeoutMs)
    if (outcome === 'completed') return { ok: true, jobId }
    if (outcome === 'timeout') await printer.cancel(jobId)
    return { ok: false, jobId, error: `job ${jobId} ${outcome}${reasons !== '' ? ` (${reasons})` : ''}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), ...(jobId != null ? { jobId } : {}) }
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
  const summary: RunSummary = { printed: 0, failed: 0, alreadyPrinted: docs.length - todo.length, left: todo.length - selected.length }

  log.info(`${key}: ${purchases.length} purchases, ${sales.length} sales, ${summary.alreadyPrinted} already printed, ${selected.length} to print`)

  if (opts.dryRun) {
    for (const d of docs) {
      const mark = state[d.meta.ksefNumber]?.status === 'printed' ? 'printed ' : selected.includes(d) ? 'WILL PRINT' : 'later   '
      console.log(`  [${mark}] ${d.meta.issueDate.slice(0, 10)}  ${label(d)}  ${d.meta.grossAmount} ${d.meta.currency}  ${d.meta.ksefNumber}`)
    }
    return summary
  }

  const dir = join(opts.dataDir, 'invoices', key)
  await mkdir(dir, { recursive: true })

  for (const d of selected) {
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
      log.error(`${label(d)}: ${error}`)
      await deps.notifier.send(`✗ ${label(d)}`, error, { priority: 'high', tags: ['x'] })
      continue
    }

    const attempts = opts.retryDelaysMs.length + 1
    let last = ''
    let printed = false
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
      const delay = opts.retryDelaysMs[attempt - 1]
      if (delay != null) await deps.sleep(delay)
    }
    await saveState(stateFile, state)

    if (printed) {
      summary.printed++
      log.info(`printed ${label(d)}`)
      await deps.notifier.send(`✓ Wydrukowano ${d.meta.invoiceNumber}`, label(d), { tags: ['printer'] })
    } else {
      summary.failed++
      log.error(`${label(d)}: not printed after ${attempts} attempts: ${last}`)
      await deps.notifier.send(`✗ Nie wydrukowano ${d.meta.invoiceNumber}`, `${label(d)}\n${attempts} attempts: ${last}`, {
        priority: 'high',
        tags: ['x'],
      })
    }
  }

  const text = `${key}: ${summary.printed} printed, ${summary.failed} failed, ${summary.alreadyPrinted} already printed` +
    (summary.left > 0 ? `, ${summary.left} left (limit)` : '')
  log.info(text)
  await deps.notifier.send(`ksef2printer ${key}`, text, summary.failed > 0 ? { priority: 'high', tags: ['warning'] } : { tags: ['white_check_mark'] })
  return summary
}
