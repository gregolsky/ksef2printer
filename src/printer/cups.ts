import { run as defaultRun, type Run } from '../exec.js'
import { noopLogger, type Logger } from '../logger.js'

/** Terminal outcome of a print job, as reported by the local CUPS scheduler. */
export type JobOutcome = 'completed' | 'aborted' | 'canceled' | 'stopped' | 'timeout'

export interface JobState {
  state: string
  reasons: string
}

export interface CupsPrinterOptions {
  queue: string
  /** CUPS job options passed as `lp -o`, e.g. `PageSize=A4`, `sides=two-sided-long-edge`. */
  options?: readonly string[]
  /** ipptool test file that DISPLAYs job-state and job-state-reasons. */
  jobStateTest: string
  cupsHost?: string
  pollMs?: number
  run?: Run
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  logger?: Logger
}

export class PrintError extends Error {}

const REQUEST_ID = /request id is (\S+)/

/** Extracts the job id (e.g. `ksef-12`) from `lp` output. */
export function parseRequestId(stdout: string): string | null {
  return REQUEST_ID.exec(stdout)?.[1] ?? null
}

/** Parses `ipptool -c` CSV output: a header line then one value line. */
export function parseJobState(csv: string): JobState | null {
  const lines = csv.trim().split('\n').map((l) => l.trim()).filter((l) => l !== '')
  if (lines.length < 2) return null
  const header = lines[0]!.split(',')
  const values = splitCsvLine(lines[1]!)
  const state = values[header.indexOf('job-state')]
  if (state == null || state === '') return null
  return { state, reasons: values[header.indexOf('job-state-reasons')] ?? '' }
}

function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (const ch of line) {
    if (ch === '"') quoted = !quoted
    else if (ch === ',' && !quoted) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

const TERMINAL: Record<string, JobOutcome> = {
  completed: 'completed',
  aborted: 'aborted',
  canceled: 'canceled',
  'processing-stopped': 'stopped',
}

export class CupsPrinter {
  private readonly run: Run
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private readonly logger: Logger
  private readonly pollMs: number
  private readonly cupsHost: string

  constructor(private readonly opts: CupsPrinterOptions) {
    this.run = opts.run ?? defaultRun
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.now = opts.now ?? Date.now
    this.logger = opts.logger ?? noopLogger
    this.pollMs = opts.pollMs ?? 2000
    this.cupsHost = opts.cupsHost ?? 'localhost'
  }

  /** Submits a file to the queue and returns the CUPS job id. */
  async submit(file: string, title: string): Promise<string> {
    const args = ['-d', this.opts.queue, '-t', title]
    for (const o of this.opts.options ?? []) args.push('-o', o)
    args.push('--', file)
    const res = await this.run('lp', args)
    if (res.code !== 0) throw new PrintError(`lp failed (${res.code}): ${res.stderr.trim()}`)
    const jobId = parseRequestId(res.stdout)
    if (jobId == null) throw new PrintError(`lp returned no job id: ${res.stdout.trim()}`)
    return jobId
  }

  async jobState(jobId: string): Promise<JobState> {
    const num = jobId.slice(jobId.lastIndexOf('-') + 1)
    const uri = `ipp://${this.cupsHost}/jobs/${num}`
    const res = await this.run('ipptool', ['-c', uri, this.opts.jobStateTest])
    const parsed = parseJobState(res.stdout)
    if (parsed == null) {
      throw new PrintError(`cannot read state of job ${jobId}: ${(res.stderr || res.stdout).trim()}`)
    }
    return parsed
  }

  /** Polls the job until it reaches a terminal state or `timeoutMs` elapses. */
  async waitForJob(jobId: string, timeoutMs: number): Promise<{ outcome: JobOutcome; reasons: string }> {
    const deadline = this.now() + timeoutMs
    let last: JobState = { state: 'unknown', reasons: '' }
    for (;;) {
      last = await this.jobState(jobId)
      this.logger.debug(`job ${jobId}: ${last.state} (${last.reasons})`)
      const outcome = TERMINAL[last.state]
      if (outcome != null) return { outcome, reasons: last.reasons }
      if (this.now() >= deadline) return { outcome: 'timeout', reasons: last.reasons }
      await this.sleep(this.pollMs)
    }
  }

  async cancel(jobId: string): Promise<void> {
    await this.run('cancel', [jobId])
  }
}
