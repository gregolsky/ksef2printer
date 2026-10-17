import { formatMonth, parseMonth, type Month } from './ksef/time.js'
import type { Logger } from './logger.js'
import type { NotifyOptions } from './notify.js'

export type Command = { kind: 'print' | 'dry-run'; month: Month } | { kind: 'help' }

export const HELP = 'Commands:\n  dry-run YYYY-MM   list what would print\n  print YYYY-MM     print the month\n  help'

/** Strict: the whole message must be one of the known commands. Nothing else is ever acted on. */
export function parseCommand(text: string): Command | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ')
  if (t === 'help') return { kind: 'help' }
  const m = /^(print|dry-run) (\d{4}-\d{2})$/.exec(t)
  if (m == null) return null
  const month = parseMonth(m[2]!)
  return month != null ? { kind: m[1] as 'print' | 'dry-run', month } : null
}

export const commandText = (c: Command) => (c.kind === 'help' ? 'help' : `${c.kind} ${formatMonth(c.month)}`)

interface NtfyEvent {
  id?: string
  time?: number
  event?: string
  message?: string
  title?: string
}

export interface ListenOptions {
  url: string
  topic: string
  token?: string
  /** Commands older than this (by ntfy's timestamp) are ignored, so a reconnect never replays old ones. */
  maxAgeMs?: number
  /** Reconnect when not even a keepalive arrives for this long (ntfy sends one every 45 s). */
  stallMs?: number
}

export interface ListenDeps {
  fetch: typeof fetch
  now(): number
  sleep(ms: number): Promise<void>
  logger: Logger
  reply(title: string, message: string, opts?: NotifyOptions): Promise<void>
  /** Runs a print or dry-run command to completion; the listener keeps reading meanwhile. */
  execute(command: Extract<Command, { kind: 'print' | 'dry-run' }>): Promise<void>
}

const BACKOFF_MS = [5_000, 10_000, 30_000, 60_000]

/** ntfy messages are at most 4 KB; a longer line is not from a well-behaved server. */
const MAX_LINE_CHARS = 64 * 1024
/** Spam on the topic must not turn into a reply per message (and use up the ntfy quota summaries need). */
const UNKNOWN_REPLY_INTERVAL_MS = 60_000

/** Parses ntfy's newline-delimited JSON stream; `onChunk` runs whenever data arrives (keepalives too). */
export async function* ndjson(body: ReadableStream<Uint8Array>, onChunk: () => void): AsyncGenerator<NtfyEvent> {
  let buffer = ''
  for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
    onChunk()
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    if (buffer.length > MAX_LINE_CHARS) throw new Error(`ntfy sent a line over ${MAX_LINE_CHARS} characters`)
    for (const line of lines) {
      if (line.trim() === '') continue
      let event: NtfyEvent
      try {
        event = JSON.parse(line) as NtfyEvent
      } catch {
        continue
      }
      yield event
    }
  }
}

/**
 * Subscribes to the ntfy topic and runs commands sent to it, one at a time. Reconnects forever
 * (until `signal` aborts), resuming after the last message seen.
 */
export async function listen(opts: ListenOptions, deps: ListenDeps, signal?: AbortSignal): Promise<void> {
  const { logger: log } = deps
  const maxAgeMs = opts.maxAgeMs ?? 10 * 60_000
  const stallMs = opts.stallMs ?? 120_000
  const base = `${opts.url.replace(/\/+$/, '')}/${encodeURIComponent(opts.topic)}/json`
  let lastId: string | undefined
  let running: string | null = null
  let failures = 0
  let lastUnknownReply = -Infinity
  const stopped = () => signal?.aborted === true

  const handle = async (e: NtfyEvent): Promise<void> => {
    if (e.event !== 'message') return
    if (e.id != null) lastId = e.id
    // Our own notifications (and anything else with a title) share the topic; only bare text is a command.
    if (e.title != null && e.title !== '') return
    const text = e.message ?? ''
    if (e.time != null && deps.now() - e.time * 1000 > maxAgeMs) {
      log.info(`ignoring old message from ${new Date(e.time * 1000).toISOString()}`)
      return
    }
    const command = parseCommand(text)
    if (command == null) {
      log.warn(`unknown command: ${JSON.stringify(text.slice(0, 80))}`)
      if (deps.now() - lastUnknownReply >= UNKNOWN_REPLY_INTERVAL_MS) {
        lastUnknownReply = deps.now()
        await deps.reply('Unknown command', HELP)
      }
      return
    }
    if (command.kind === 'help') {
      await deps.reply('ksef2printer', HELP)
      return
    }
    if (running != null) {
      await deps.reply(`Busy: ${running} is running`, `Not started: ${commandText(command)}. Send it again when the current run finishes.`)
      return
    }
    running = commandText(command)
    log.info(`command: ${running}`)
    await deps.reply(`▶ ${running} started`, command.kind === 'dry-run' ? 'Listing invoices, nothing will print.' : 'Printing; a summary follows.')
    void deps
      .execute(command)
      .catch((err: unknown) => log.error(`${commandText(command)} failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        running = null
      })
  }

  while (!stopped()) {
    const conn = new AbortController()
    const abortConn = () => conn.abort()
    signal?.addEventListener('abort', abortConn)
    let stall: NodeJS.Timeout | undefined
    const resetStall = () => {
      clearTimeout(stall)
      stall = setTimeout(() => conn.abort(new Error(`no data from ntfy for ${stallMs / 1000}s`)), stallMs)
    }
    try {
      const headers: Record<string, string> = {}
      if (opts.token != null) headers['Authorization'] = `Bearer ${opts.token}`
      resetStall()
      const res = await deps.fetch(lastId != null ? `${base}?since=${encodeURIComponent(lastId)}` : base, { headers, signal: conn.signal })
      if (!res.ok || res.body == null) throw new Error(`ntfy returned ${res.status}`)
      for await (const event of ndjson(res.body, resetStall)) {
        if (event.event === 'open') {
          failures = 0
          log.info(`listening for commands on ntfy topic ${opts.topic.slice(0, 4)}…`)
        }
        await handle(event)
      }
      log.warn('ntfy connection closed')
    } catch (err) {
      if (stopped()) break
      const reason = conn.signal.aborted ? String(conn.signal.reason) : err instanceof Error ? err.message : String(err)
      log.warn(`ntfy connection lost: ${reason}`)
    } finally {
      clearTimeout(stall)
      signal?.removeEventListener('abort', abortConn)
    }
    if (stopped()) break
    const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]!
    failures++
    log.info(`reconnecting in ${wait / 1000}s`)
    await deps.sleep(wait)
  }
}
