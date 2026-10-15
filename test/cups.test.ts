import { describe, expect, it } from 'vitest'
import type { Run, RunResult } from '../src/exec.js'
import { CupsPrinter, PrintError, parseJobState, parseRequestId } from '../src/printer/cups.js'

function scripted(results: RunResult[]): { run: Run; calls: Array<[string, readonly string[]]> } {
  const calls: Array<[string, readonly string[]]> = []
  const run: Run = async (cmd, args) => {
    calls.push([cmd, args])
    const next = results.shift()
    if (next == null) throw new Error(`unexpected call: ${cmd} ${args.join(' ')}`)
    return next
  }
  return { run, calls }
}

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' })
const state = (s: string, reasons = 'none'): RunResult => ok(`job-state,job-state-reasons\n${s},${reasons}\n`)

function printer(run: Run, clock = { t: 0 }) {
  return new CupsPrinter({
    queue: 'ksef',
    options: ['PageSize=A4'],
    jobStateTest: '/app/job-state.test',
    run,
    pollMs: 1000,
    sleep: async (ms) => {
      clock.t += ms
    },
    now: () => clock.t,
  })
}

describe('parseRequestId', () => {
  it('reads the job id from lp output', () => {
    expect(parseRequestId('request id is ksef-12 (1 file(s))\n')).toBe('ksef-12')
  })
  it('returns null for unexpected output', () => {
    expect(parseRequestId('lp: error')).toBeNull()
  })
})

describe('parseJobState', () => {
  it('maps CSV columns by header name', () => {
    expect(parseJobState('job-state-reasons,job-state\njob-completed-successfully,completed\n')).toEqual({
      state: 'completed',
      reasons: 'job-completed-successfully',
    })
  })
  it('keeps quoted multi-value reasons intact', () => {
    expect(parseJobState('job-state,job-state-reasons\naborted,"job-aborted-by-system,printer-stopped"\n')).toEqual({
      state: 'aborted',
      reasons: 'job-aborted-by-system,printer-stopped',
    })
  })
  it('returns null when there is no value line', () => {
    expect(parseJobState('job-state,job-state-reasons\n')).toBeNull()
  })
})

describe('CupsPrinter.submit', () => {
  it('passes queue, title and options to lp', async () => {
    const { run, calls } = scripted([ok('request id is ksef-3 (1 file(s))')])
    await expect(printer(run).submit('/data/a.pdf', 'a.pdf')).resolves.toBe('ksef-3')
    expect(calls[0]).toEqual(['lp', ['-d', 'ksef', '-t', 'a.pdf', '-o', 'PageSize=A4', '--', '/data/a.pdf']])
  })
  it('throws PrintError when lp fails', async () => {
    const { run } = scripted([{ code: 1, stdout: '', stderr: 'lp: The printer or class does not exist.' }])
    await expect(printer(run).submit('/data/a.pdf', 'a.pdf')).rejects.toBeInstanceOf(PrintError)
  })
})

describe('CupsPrinter.waitForJob', () => {
  it('polls until the job completes', async () => {
    const { run, calls } = scripted([state('pending'), state('processing'), state('completed', 'job-completed-successfully')])
    await expect(printer(run).waitForJob('ksef-12', 60_000)).resolves.toEqual({
      outcome: 'completed',
      reasons: 'job-completed-successfully',
    })
    expect(calls[0]).toEqual(['ipptool', ['-c', 'ipp://localhost/jobs/12', '/app/job-state.test']])
  })
  it('reports aborted jobs', async () => {
    const { run } = scripted([state('aborted', 'job-aborted-by-system')])
    await expect(printer(run).waitForJob('ksef-1', 60_000)).resolves.toMatchObject({ outcome: 'aborted' })
  })
  it('maps processing-stopped to stopped', async () => {
    const { run } = scripted([state('processing-stopped', 'printer-stopped')])
    await expect(printer(run).waitForJob('ksef-1', 60_000)).resolves.toMatchObject({ outcome: 'stopped' })
  })
  it('times out when the job never finishes', async () => {
    const { run } = scripted([state('processing'), state('processing'), state('processing')])
    await expect(printer(run).waitForJob('ksef-1', 2000)).resolves.toMatchObject({ outcome: 'timeout' })
  })
  it('throws when the job state cannot be read', async () => {
    const { run } = scripted([{ code: 1, stdout: '', stderr: 'ipptool: Unable to connect' }])
    await expect(printer(run).waitForJob('ksef-1', 2000)).rejects.toThrow(/cannot read state/)
  })
})
