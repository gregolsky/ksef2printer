import { describe, expect, it } from 'vitest'
import { listen, ndjson, parseCommand, type Command, type ListenDeps } from '../src/listen.js'
import { noopLogger } from '../src/logger.js'

describe('parseCommand', () => {
  it('accepts the two commands and help, case and spacing aside', () => {
    expect(parseCommand('print 2026-09')).toEqual({ kind: 'print', month: { year: 2026, month: 9 } })
    expect(parseCommand('  Dry-Run   2026-10 \n')).toEqual({ kind: 'dry-run', month: { year: 2026, month: 10 } })
    expect(parseCommand('help')).toEqual({ kind: 'help' })
  })

  it('rejects anything else', () => {
    for (const text of ['print 2026-13', 'print 2026-9', 'print 2026-09 now', 'print 2026-09; rm -rf /', 'printer 2026-09', '', 'print']) {
      expect(parseCommand(text)).toBeNull()
    }
  })
})

const NOW = Date.parse('2026-10-17T10:00:00Z')
const sec = (ms: number) => Math.floor(ms / 1000)

type Event = Record<string, unknown>

/** A fake ntfy: each connection streams the next batch of events, then closes. */
function harness(batches: Event[][], opts: { executeMs?: Promise<void>; otherRun?: string } = {}) {
  const urls: string[] = []
  const replies: string[] = []
  const executed: string[] = []
  const controller = new AbortController()
  let connections = 0
  const deps: ListenDeps = {
    fetch: (async (input: string | URL | Request) => {
      urls.push(String(input))
      const batch = batches[connections++]
      if (batch == null) {
        controller.abort()
        throw new Error('done')
      }
      const body = [{ event: 'open' }, ...batch].map((e) => JSON.stringify(e) + '\n').join('')
      return new Response(body)
    }) as typeof fetch,
    now: () => NOW,
    sleep: async () => {},
    logger: noopLogger,
    reply: async (title) => void replies.push(title),
    otherRun: async () => opts.otherRun ?? null,
    execute: async (c: Extract<Command, { kind: 'print' | 'dry-run' }>) => {
      executed.push(`${c.kind} ${c.month.year}-${c.month.month}`)
      await opts.executeMs
    },
  }
  const run = () => listen({ url: 'https://ntfy.example/', topic: 'secret-topic' }, deps, controller.signal)
  return { run, urls, replies, executed }
}

const msg = (id: string, message: string, extra: Event = {}): Event => ({ event: 'message', id, time: sec(NOW) - 5, message, ...extra })

describe('listen', () => {
  it('runs a command and confirms it started', async () => {
    const h = harness([[msg('m1', 'dry-run 2026-10')]])
    await h.run()
    expect(h.executed).toEqual(['dry-run 2026-10'])
    expect(h.replies).toEqual(['▶ dry-run 2026-10 started'])
    expect(h.urls[0]).toBe('https://ntfy.example/secret-topic/json')
  })

  it('ignores its own titled notifications and answers unknown text', async () => {
    const h = harness([[msg('m1', '2026-10: 3 printed', { title: 'ksef2printer 2026-10' }), msg('m2', 'print everything')]])
    await h.run()
    expect(h.executed).toEqual([])
    expect(h.replies).toEqual(['Unknown command'])
  })

  it('ignores commands older than ten minutes', async () => {
    const h = harness([[msg('m1', 'print 2026-10', { time: sec(NOW - 11 * 60_000) })]])
    await h.run()
    expect(h.executed).toEqual([])
  })

  it('answers busy while a run is in progress', async () => {
    let finish!: () => void
    const h = harness([[msg('m1', 'print 2026-10'), msg('m2', 'print 2026-09')]], { executeMs: new Promise((r) => (finish = r)) })
    await h.run()
    finish()
    expect(h.executed).toEqual(['print 2026-10'])
    expect(h.replies).toEqual(['▶ print 2026-10 started', 'Busy: print 2026-10 is running'])
  })

  it('answers busy while a run started outside the listener holds the lock', async () => {
    const h = harness([[msg('m1', 'print 2026-10')]], { otherRun: '2026-09 (since 09:58 UTC)' })
    await h.run()
    expect(h.executed).toEqual([])
    expect(h.replies).toEqual(['Busy: 2026-09 (since 09:58 UTC) is running'])
  })

  it('reconnects after the stream ends, resuming after the last message', async () => {
    const h = harness([[msg('m1', 'help')], [msg('m2', 'dry-run 2026-09')]])
    await h.run()
    expect(h.urls[1]).toBe('https://ntfy.example/secret-topic/json?since=m1')
    expect(h.executed).toEqual(['dry-run 2026-9'])
  })

  it('reconnects when the stream goes silent', async () => {
    const urls: string[] = []
    const controller = new AbortController()
    const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input))
      if (urls.length > 1) {
        controller.abort()
        throw new Error('done')
      }
      // Sends "open", then nothing, and only ends when the listener aborts the request.
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"event":"open"}\n'))
          init?.signal?.addEventListener('abort', () => c.error(init.signal?.reason))
        },
      })
      return new Response(body)
    }) as typeof fetch
    const deps: ListenDeps = {
      fetch: fetchFake,
      now: () => NOW,
      sleep: async () => {},
      logger: noopLogger,
      reply: async () => {},
      otherRun: async () => null,
      execute: async () => {},
    }
    await listen({ url: 'https://ntfy.example', topic: 't', stallMs: 50 }, deps, controller.signal)
    expect(urls).toHaveLength(2)
  })

  it('answers unknown commands at most once a minute', async () => {
    const h = harness([[msg('m1', 'hello'), msg('m2', 'hi'), msg('m3', 'print please')]])
    await h.run()
    expect(h.replies).toEqual(['Unknown command'])
  })
})

describe('ndjson', () => {
  it('parses lines split across chunks and skips non-JSON', async () => {
    const chunks = ['{"event":"op', 'en"}\nnot json\n{"event":"message","message":"x"}\n']
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch))
        c.close()
      },
    })
    const events = []
    for await (const e of ndjson(body, () => {})) events.push(e)
    expect(events).toEqual([{ event: 'open' }, { event: 'message', message: 'x' }])
  })

  it('stops on a line longer than any ntfy message', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('x'.repeat(70 * 1024)))
        c.close()
      },
    })
    await expect(async () => {
      for await (const _ of ndjson(body, () => {})) void _
    }).rejects.toThrow('line over')
  })
})
