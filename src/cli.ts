import { access, mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { loadPrinterConfig, loadRunConfig, type PrinterConfig } from './config.js'
import { run } from './exec.js'
import { KsefClient } from './ksef/client.js'
import { parseMonth } from './ksef/time.js'
import { consoleLogger as log } from './logger.js'
import { noopNotifier, ntfyNotifier } from './notify.js'
import { renderInvoicePdf } from './pdf/render.js'
import { CupsPrinter, PrintError } from './printer/cups.js'
import { browsePrinters, type FoundPrinter } from './printer/discover.js'
import { parseModels, suggestSettings, toEnv, type PrinterSettings } from './printer/suggest.js'
import { runMonth } from './run.js'

const USAGE = `Usage:
  ksef2printer YYYY-MM [--limit N] [--dry-run]
                                  print the month's KSeF invoices (purchases, then sales)
  ksef2printer setup [n]          find printers on the network and save settings for one
  ksef2printer discover           list printers on the network with suggested settings
  ksef2printer test-page          print a CUPS test page on the configured printer
  ksef2printer print-pdf <file>   print one PDF on the configured printer
  ksef2printer drivers [query]    list installed printer models (filter by text)`

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

  const cfg = loadRunConfig()
  const printerCfg = loadPrinterConfig()
  const ksef = new KsefClient({ ...cfg.ksef, logger: log })
  const printer = cupsPrinter(printerCfg)
  try {
    const summary = await runMonth(
      {
        month,
        env: cfg.ksef.env,
        dataDir: cfg.dataDir,
        ...(limit != null ? { limit } : {}),
        dryRun,
        printTimeoutMs: printerCfg.timeoutMs,
        retryDelaysMs: cfg.retryDelaysMs,
      },
      {
        ksef,
        render: (xml, ksefNumber, qr) => renderInvoicePdf(cfg.pdfRenderer, xml, ksefNumber, qr),
        printer,
        notifier: cfg.ntfy != null ? ntfyNotifier(cfg.ntfy, log) : noopNotifier,
        logger: log,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: () => new Date(),
      },
    )
    return summary.failed > 0 ? EXIT_FAILED : EXIT_OK
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err))
    return EXIT_CONFIG
  }
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
    default:
      console.log(USAGE)
      return cmd == null || cmd === '--help' || cmd === '-h' ? EXIT_OK : EXIT_CONFIG
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    log.error(err instanceof Error ? err.message : String(err))
    process.exit(EXIT_CONFIG)
  },
)
