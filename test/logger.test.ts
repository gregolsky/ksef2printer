import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { consoleLogger, logToDailyFiles } from '../src/logger.js'

describe('logToDailyFiles', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('writes each line to the file of its own day', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.useFakeTimers()
    const dir = join(mkdtempSync(join(tmpdir(), 'ksef2printer-log-')), 'logs')
    logToDailyFiles(dir)

    vi.setSystemTime(new Date('2026-10-17T23:59:59Z'))
    consoleLogger.info('before midnight')
    vi.setSystemTime(new Date('2026-10-18T00:00:01Z'))
    consoleLogger.info('after midnight')

    expect(readdirSync(dir).sort()).toEqual(['2026-10-17.log', '2026-10-18.log'])
    expect(readFileSync(join(dir, '2026-10-17.log'), 'utf8')).toBe('[2026-10-17T23:59:59.000Z] INFO  before midnight\n')
    expect(readFileSync(join(dir, '2026-10-18.log'), 'utf8')).toBe('[2026-10-18T00:00:01.000Z] INFO  after midnight\n')
  })
})
