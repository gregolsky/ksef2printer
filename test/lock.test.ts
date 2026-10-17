import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { exists, readRunLock, RunLockedError, withRunLock } from '../src/fs.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ksef2printer-lock-'))
})

describe('withRunLock', () => {
  it('holds the lock while running and releases it after, also on error', async () => {
    await withRunLock(dir, '2026-10', async () => {
      expect(JSON.parse(await readFile(join(dir, 'run.lock'), 'utf8'))).toMatchObject({ what: '2026-10' })
    })
    expect(await exists(join(dir, 'run.lock'))).toBe(false)
    await expect(withRunLock(dir, 'x', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(await exists(join(dir, 'run.lock'))).toBe(false)
  })

  it('refuses while another run holds a fresh lock', async () => {
    let inner: Promise<unknown> | undefined
    await withRunLock(dir, '2026-10', async () => {
      inner = withRunLock(dir, '2026-09 --dry-run', async () => 'ran')
      await expect(inner).rejects.toThrow('another run is in progress: 2026-10 since')
      await expect(inner).rejects.toBeInstanceOf(RunLockedError)
    })
  })

  it('reports a fresh lock as held, and a missing, damaged or stale one as not', async () => {
    const at = { now: () => Date.parse('2026-10-17T10:00:00Z'), bootId: 'boot-b' }
    expect(await readRunLock(dir, at)).toBeNull()
    await writeFile(join(dir, 'run.lock'), JSON.stringify({ what: '2026-09', since: '2026-10-17T09:58:00.000Z', bootId: 'boot-b' }))
    expect(await readRunLock(dir, at)).toEqual({ what: '2026-09', since: '2026-10-17T09:58:00.000Z' })
    await writeFile(join(dir, 'run.lock'), JSON.stringify({ what: 'old', since: '2026-10-17T03:00:00Z', bootId: 'boot-b' }))
    expect(await readRunLock(dir, at)).toBeNull()
    await writeFile(join(dir, 'run.lock'), 'not json')
    expect(await readRunLock(dir, at)).toBeNull()
  })

  it('takes over a fresh lock written before a reboot (power cut mid-run)', async () => {
    await writeFile(join(dir, 'run.lock'), JSON.stringify({ what: '2026-09', since: '2026-10-17T09:58:00.000Z', bootId: 'boot-a' }))
    const at = { now: () => Date.parse('2026-10-17T10:00:00Z'), bootId: 'boot-b' }
    expect(await readRunLock(dir, at)).toBeNull()
    const stale: string[] = []
    expect(await withRunLock(dir, '2026-10', async () => 'ran', { ...at, onStale: (held) => stale.push(held) })).toBe('ran')
    expect(stale[0]).toContain('boot-a')
  })

  it('records the boot id in the lock', async () => {
    await withRunLock(dir, '2026-10', async () => {
      expect(JSON.parse(await readFile(join(dir, 'run.lock'), 'utf8'))).toMatchObject({ bootId: 'boot-b' })
    }, { bootId: 'boot-b' })
  })

  it('takes over a lock left by a crash', async () => {
    await writeFile(join(dir, 'run.lock'), JSON.stringify({ what: 'old', since: '2026-10-01T00:00:00Z' }))
    const stale: string[] = []
    const result = await withRunLock(dir, 'new', async () => 'ran', {
      now: () => Date.parse('2026-10-17T00:00:00Z'),
      onStale: (held) => stale.push(held),
    })
    expect(result).toBe('ran')
    expect(stale[0]).toContain('"old"')
  })
})
