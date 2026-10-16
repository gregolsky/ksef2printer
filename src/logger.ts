import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Logger {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
  debug(msg: string): void
}

let logFile: string | null = null

/** Also appends every log line to `file` (the container is removed after each run, taking its output with it). */
export function logToFile(file: string): void {
  mkdirSync(dirname(file), { recursive: true })
  logFile = file
}

function write(print: (line: string) => void, level: string, msg: string): void {
  const line = `[${new Date().toISOString()}] ${level} ${msg}`
  print(line)
  if (logFile == null) return
  try {
    appendFileSync(logFile, line + '\n')
  } catch (err) {
    logFile = null
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
