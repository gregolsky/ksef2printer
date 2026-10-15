import { access, mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { loadPrinterConfig } from './config.js'
import { run } from './exec.js'
import { consoleLogger as log } from './logger.js'
import { CupsPrinter, PrintError } from './printer/cups.js'
import { browsePrinters, type FoundPrinter } from './printer/discover.js'
import { parseModels, suggestSettings, toEnv, type PrinterSettings } from './printer/suggest.js'

const USAGE = `Usage:
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
  const printer = new CupsPrinter({ queue: cfg.queue, options: cfg.options, jobStateTest: cfg.jobStateTest, logger: log })
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
    console.log('No printers found. The container needs host networking (network_mode: host) and the printer must be on.')
    return EXIT_FAILED
  }
  show(found)
  return EXIT_OK
}

async function choose(count: number, arg: string | undefined): Promise<number | null> {
  if (arg != null) {
    const n = Number(arg)
    return Number.isInteger(n) && n >= 1 && n <= count ? n : null
  }
  if (!process.stdin.isTTY) return count === 1 ? 1 : null
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(`Which printer? [1-${count}] `)
    const n = Number(answer.trim() === '' && count === 1 ? '1' : answer.trim())
    return Number.isInteger(n) && n >= 1 && n <= count ? n : null
  } finally {
    rl.close()
  }
}

async function setup(arg: string | undefined): Promise<number> {
  const found = await scan()
  if (found.length === 0) {
    console.log('No printers found. The container needs host networking (network_mode: host) and the printer must be on.')
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
