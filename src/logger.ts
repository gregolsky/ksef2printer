import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export interface Logger {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
  debug(msg: string): void
}

let logDir: string | null = null

/**
 * Also appends every log line to `<dir>/YYYY-MM-DD.log`, picked by the line's own (UTC) date, so a
 * listener running for weeks still writes each day to its own file. The container is removed after
 * each one-off run, taking its output with it.
 */
export function logToDailyFiles(dir: string): void {
  mkdirSync(dir, { recursive: true })
  logDir = dir
}

function write(print: (line: string) => void, level: string, msg: string): void {
  const time = new Date().toISOString()
  const line = `[${time}] ${level} ${msg}`
  print(line)
  if (logDir == null) return
  try {
    appendFileSync(join(logDir, `${time.slice(0, 10)}.log`), line + '\n')
  } catch (err) {
    logDir = null
    console.warn(`log file disabled: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export const consoleLogger: Logger = {
  info: (msg) => write(console.log, 'INFO ', msg),
  warn: (msg) => write(console.warn, 'WARN ', msg),
  error: (msg) => write(console.error, 'ERROR', msg),
  debug: (msg) => {
    if (process.env['DEBUG'] != null) write(console.debug, 'DEBUG', msg)
  },
}

export const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
}
