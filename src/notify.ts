import type { Logger } from './logger.js'

export interface NtfyConfig {
  url: string
  topic: string
  token?: string
}

export interface Notifier {
  send(title: string, message: string, opts?: { priority?: 'default' | 'high'; tags?: string[] }): Promise<void>
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
