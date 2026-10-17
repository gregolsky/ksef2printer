import { access, mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { loadPrinterConfig, loadRunConfig, ntfyWarnings, type PrinterConfig } from './config.js'
import { run } from './exec.js'
import { KsefClient } from './ksef/client.js'
import { formatMonth, parseMonth, type Month } from './ksef/time.js'
import { listen } from './listen.js'
import { readRunLock, releaseLocksSync, RunLockedError, withRunLock } from './fs.js'
import { consoleLogger as log, logToDailyFiles } from './logger.js'
import { noopNotifier, ntfyNotifier } from './notify.js'
import { renderInvoicePdf } from './pdf/render.js'
import { CupsPrinter, PrintError } from './printer/cups.js'
import { assertReachable } from './printer/reachable.js'
import { browsePrinters, type FoundPrinter } from './printer/discover.js'
import { parseModels, suggestSettings, toEnv, type PrinterSettings } from './printer/suggest.js'
import { runMonth, type RunDeps, type RunOptions } from './run.js'

const USAGE = `Usage:
  ksef2printer YYYY-MM [--limit N] [--dry-run]
                                  print the month's KSeF invoices (purchases, then sales)
  ksef2printer setup [n]          find printers on the network and save settings for one
  ksef2printer discover           list printers on the network with suggested settings
  ksef2printer test-page          print a CUPS test page on the configured printer
  ksef2printer print-pdf <file>   print one PDF on the configured printer
  ksef2printer drivers [query]    list installed printer models (filter by text)
  ksef2printer listen             run "print YYYY-MM" / "dry-run YYYY-MM" sent to the ntfy topic`

const TEST_PAGE = '/usr/share/cups/data/default-testpage.pdf'
const SETUP_QUEUE = 'ksef-setup-check'

export const EXIT_OK = 0
export const EXIT_FAILED = 1
export const EXIT_CONFIG = 2

const NO_PRINTERS = 'No printers found. The container needs host networking (network_mode: host) and the printer must be on.'

function cupsPrinter(cfg: PrinterConfig): CupsPrinter {
  return new CupsPrinter({ queue: cfg.queue, options: cfg.options, jobStateTest: cfg.jobStateTest, logger: log })
}

async function printPdf(file: string | undefined): Promise<number> {
  if (file == null) {
    log.error('print-pdf needs a file')
    return EXIT_CONFIG
  }
  try {
    await access(file)
  } catch {
    log.error(`file not found: ${file}`)
    return EXIT_CONFIG
  }
  const cfg = loadPrinterConfig()
  const printer = cupsPrinter(cfg)
  try {
    const jobId = await printer.submit(file, basename(file))
    log.info(`submitted ${file} as ${jobId}`)
    const { outcome, reasons } = await printer.waitForJob(jobId, cfg.timeoutMs)
    if (outcome === 'completed') {
      log.info(`${jobId} completed`)
      return EXIT_OK
    }
    if (outcome === 'timeout') {
      await printer.cancel(jobId)
      log.error(`${jobId} not finished after ${cfg.timeoutMs / 1000}s — is the printer on and reachable at PRINTER_URI?`)
    } else {
      log.error(`${jobId} ${outcome} (${reasons})`)
    }
    return EXIT_FAILED
  } catch (err) {
    log.error(err instanceof PrintError ? err.message : String(err))
    return EXIT_FAILED
  }
}

async function scan(): Promise<Array<{ printer: FoundPrinter; settings: PrinterSettings }>> {
  log.info('scanning the network for printers…')
  const [printers, models] = await Promise.all([browsePrinters(5000), run('lpinfo', ['-m'])])
  const driverModels = parseModels(models.stdout)
  return printers.map((printer) => ({ printer, settings: suggestSettings(printer, driverModels) }))
}

function show(found: Array<{ printer: FoundPrinter; settings: PrinterSettings }>): void {
  found.forEach(({ printer, settings }, i) => {
    console.log(`  ${i + 1}) ${printer.name}  [${printer.addresses[0] ?? printer.host}]`)
    console.log(`     PRINTER_URI=${settings.uri}`)
    console.log(`     PRINTER_MODEL=${settings.model}`)
    console.log(`     ${settings.reason}`)
  })
}

async function discover(): Promise<number> {
  const found = await scan()
  if (found.length === 0) {
    console.log(NO_PRINTERS)
    return EXIT_FAILED
  }
  show(found)
  return EXIT_OK
}

async function choose(count: number, arg: string | undefined): Promise<number | null> {
  const pick = (s: string) => {
    const n = Number(s)
    return Number.isInteger(n) && n >= 1 && n <= count ? n : null
  }
  if (arg != null) return pick(arg)
  if (!process.stdin.isTTY) return count === 1 ? 1 : null
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(`Which printer? [1-${count}] `)).trim()
    return pick(answer === '' && count === 1 ? '1' : answer)
  } finally {
    rl.close()
  }
}

async function setup(arg: string | undefined): Promise<number> {
  const found = await scan()
  if (found.length === 0) {
    console.log(NO_PRINTERS)
    return EXIT_FAILED
  }
  show(found)
  const n = await choose(found.length, arg)
  if (n == null) {
    log.error(`pick a printer: setup <1-${found.length}>`)
    return EXIT_CONFIG
  }
  const { printer, settings } = found[n - 1]!

  // Creating a throwaway queue proves CUPS accepts this URI and model before anything is saved.
  const check = await run('lpadmin', ['-p', SETUP_QUEUE, '-v', settings.uri, '-m', settings.model])
  await run('lpadmin', ['-x', SETUP_QUEUE])
  if (check.code !== 0) {
    log.error(`CUPS rejected these settings: ${check.stderr.trim()}`)
    return EXIT_FAILED
  }

  const file = process.env['PRINTER_ENV_FILE'] ?? '/config/printer.env'
  const options = process.env['PRINTER_OPTIONS'] || 'media=A4'
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, toEnv(printer, settings, options))
  console.log(`\nSaved ${printer.name} to ${file}. Next: ./print.sh test-page`)
  return EXIT_OK
}

async function printMonth(args: readonly string[]): Promise<number> {
  const month = parseMonth(args[0] ?? '')
  if (month == null) {
    log.error('month must be YYYY-MM')
    return EXIT_CONFIG
  }
  let limit: number | undefined
  let dryRun = false
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!
    if (a === '--dry-run') dryRun = true
    else if (a === '--limit' || a.startsWith('--limit=')) {
      const v = a.includes('=') ? a.slice('--limit='.length) : args[++i]
      limit = Number(v)
      if (!Number.isInteger(limit) || limit < 1) {
        log.error('--limit needs a positive whole number')
        return EXIT_CONFIG
      }
    } else {
      log.error(`unknown option: ${a}`)
      return EXIT_CONFIG
    }
  }

  return executeMonth(month, { dryRun, ...(limit != null ? { limit } : {}) })
}

/** One month run, shared by the CLI and ntfy commands: lock, log file, run, summary or "stopped" alert. */
async function executeMonth(month: Month, { dryRun, limit }: { dryRun: boolean; limit?: number }): Promise<number> {
  const cfg = loadRunConfig()
  const printerCfg = loadPrinterConfig()
  const what = `${formatMonth(month)}${dryRun ? ' --dry-run' : ''}${limit != null ? ` --limit ${limit}` : ''}`
  logToDailyFiles(join(cfg.dataDir, 'logs'))
  log.info(`run ${what}`)
  const notifier = cfg.ntfy != null ? ntfyNotifier(cfg.ntfy, log) : noopNotifier
  const options: RunOptions = {
    month,
    env: cfg.ksef.env,
    dataDir: cfg.dataDir,
    ...(limit != null ? { limit } : {}),
    dryRun,
    printTimeoutMs: printerCfg.timeoutMs,
    retryDelaysMs: cfg.retryDelaysMs,
  }
  const deps: RunDeps = {
    ksef: new KsefClient({ ...cfg.ksef, logger: log }),
    render: (xml, ksefNumber, qr) => renderInvoicePdf(cfg.pdfRenderer, xml, ksefNumber, qr),
    printer: cupsPrinter(printerCfg),
    checkPrinter: () => assertReachable(printerCfg.uri),
    notifier,
    logger: log,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
  }
  try {
    const summary = await withRunLock(cfg.dataDir, what, () => runMonth(options, deps), {
      onStale: (held) => log.warn(`taking over a stale run lock: ${held}`),
    })
    return summary.failed > 0 ? EXIT_FAILED : EXIT_OK
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    log.error(error)
    // Nothing ran, so there is nothing to alert about; the caller sees the error.
    if (err instanceof RunLockedError) return EXIT_FAILED
    // KSeF unreachable, authentication rejected…: the run stopped part way.
    await notifier.send(`✗ ksef2printer ${what} stopped`, error, { priority: 'high', tags: ['x'] })
    return EXIT_FAILED
  }
}

/** Waits for `print YYYY-MM` / `dry-run YYYY-MM` on the ntfy topic and runs them. */
async function listenForCommands(): Promise<number> {
  const cfg = loadRunConfig()
  if (cfg.ntfy == null) {
    log.error('listen needs NTFY_TOPIC in .env')
    return EXIT_CONFIG
  }
  logToDailyFiles(join(cfg.dataDir, 'logs'))
  for (const w of ntfyWarnings(cfg.ntfy)) log.warn(w)
  const notifier = ntfyNotifier(cfg.ntfy, log)
  await listen(
    { url: cfg.ntfy.url, topic: cfg.ntfy.commandTopic, ...(cfg.ntfy.token != null ? { token: cfg.ntfy.token } : {}) },
    {
      fetch,
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      logger: log,
      reply: (title, message, opts) => notifier.send(title, message, opts),
      otherRun: async () => {
        const held = await readRunLock(cfg.dataDir)
        return held != null ? `${held.what} (since ${held.since.slice(11, 16)} UTC)` : null
      },
      execute: async (command) => {
        await executeMonth(command.month, { dryRun: command.kind === 'dry-run' })
      },
    },
  )
  return EXIT_OK
}

async function drivers(query: string | undefined): Promise<number> {
  const res = await run('lpinfo', ['-m'])
  if (res.code !== 0) {
    log.error(`lpinfo failed: ${res.stderr.trim()}`)
    return EXIT_CONFIG
  }
  const q = query?.toLowerCase()
  const lines = res.stdout.split('\n').filter((l) => l !== '' && (q == null || l.toLowerCase().includes(q)))
  console.log('PRINTER_MODEL value, then description:')
  for (const l of lines) console.log(`  ${l}`)
  if (lines.length === 0) console.log('  no match — try a shorter query, or add a driver via EXTRA_DRIVER_PACKAGES')
  return EXIT_OK
}

export async function main(argv: readonly string[]): Promise<number> {
  const [cmd, arg] = argv
  if (cmd != null && /^\d{4}-\d{2}$/.test(cmd)) return printMonth(argv)
  switch (cmd) {
    case 'print-pdf':
      return printPdf(arg)
    case 'setup':
      return setup(arg)
    case 'discover':
      return discover()
    case 'test-page':
      return printPdf(TEST_PAGE)
    case 'drivers':
      return drivers(arg)
    case 'listen':
      return listenForCommands()
    default:
      console.log(USAGE)
      return cmd == null || cmd === '--help' || cmd === '-h' ? EXIT_OK : EXIT_CONFIG
  }
}

// Node runs as PID 1 in the container, where signals have no default handler: without these,
// Ctrl-C and `docker stop` would be ignored. A held run lock is released before exiting.
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
  process.on(signal, () => {
    releaseLocksSync()
    log.warn(`${signal}: stopping`)
    process.exit(code)
  })
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    log.error(err instanceof Error ? err.message : String(err))
    process.exit(EXIT_CONFIG)
  },
)
