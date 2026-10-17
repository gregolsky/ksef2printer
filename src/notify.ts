import type { Logger } from './logger.js'

export interface NtfyConfig {
  url: string
  topic: string
  token?: string
}

export interface NotifyOptions {
  priority?: 'default' | 'high'
  tags?: string[]
}

export interface Notifier {
  send(title: string, message: string, opts?: NotifyOptions): Promise<void>
}

/** ntfy.sh turns messages over 4096 bytes into attachments; stay under it with room for encoding. */
export const MAX_MESSAGE_BYTES = 3800

/** Groups lines into messages of at most `maxBytes` (UTF-8); a single longer line is cut. */
export function splitMessage(lines: readonly string[], maxBytes = MAX_MESSAGE_BYTES): string[] {
  const parts: string[] = []
  let cur = ''
  for (const raw of lines) {
    let line = raw
    while (Buffer.byteLength(line) > maxBytes) line = line.slice(0, -1)
    const next = cur === '' ? line : `${cur}\n${line}`
    if (cur !== '' && Buffer.byteLength(next) > maxBytes) {
      parts.push(cur)
      cur = line
    } else {
      cur = next
    }
  }
  if (cur !== '' || parts.length === 0) parts.push(cur)
  return parts
}

/** Sends `lines` as one message, or as several titled "(1/3)", "(2/3)"… when too long for one. */
export async function sendLong(notifier: Notifier, title: string, lines: readonly string[], opts?: NotifyOptions): Promise<void> {
  const parts = splitMessage(lines)
  for (const [i, part] of parts.entries()) {
    await notifier.send(parts.length > 1 ? `${title} (${i + 1}/${parts.length})` : title, part, opts)
  }
}

export const noopNotifier: Notifier = { send: async () => {} }

/** Publishes to ntfy. A failed notification is logged and never fails the run. */
export function ntfyNotifier(cfg: NtfyConfig, logger: Logger, fetchFn: typeof fetch = fetch): Notifier {
  const endpoint = `${cfg.url.replace(/\/+$/, '')}/${encodeURIComponent(cfg.topic)}`
  return {
    async send(title, message, opts = {}) {
      const headers: Record<string, string> = { Title: encodeHeader(title), Priority: opts.priority ?? 'default' }
      if (opts.tags != null && opts.tags.length > 0) headers['Tags'] = opts.tags.join(',')
      if (cfg.token != null) headers['Authorization'] = `Bearer ${cfg.token}`
      try {
        const res = await fetchFn(endpoint, { method: 'POST', headers, body: message, signal: AbortSignal.timeout(10_000) })
        if (!res.ok) logger.warn(`ntfy returned ${res.status}`)
      } catch (err) {
        logger.warn(`ntfy failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  }
}

// HTTP headers must be ASCII; ntfy decodes RFC 2047 encoded-words, so Polish characters survive.
function encodeHeader(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`
}
