import { z } from 'zod'

const PrinterEnv = z.object({
  PRINTER_QUEUE: z.string().min(1).default('ksef'),
  PRINTER_OPTIONS: z.string().default(''),
  PRINT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
  JOB_STATE_TEST: z.string().default('/app/job-state.test'),
})

export interface PrinterConfig {
  queue: string
  options: string[]
  timeoutMs: number
  jobStateTest: string
}

export function loadPrinterConfig(env: NodeJS.ProcessEnv = process.env): PrinterConfig {
  const parsed = PrinterEnv.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid configuration: ${issues}`)
  }
  const e = parsed.data
  return {
    queue: e.PRINTER_QUEUE,
    options: e.PRINTER_OPTIONS.split(/\s+/).filter((o) => o !== ''),
    timeoutMs: e.PRINT_TIMEOUT_SECONDS * 1000,
    jobStateTest: e.JOB_STATE_TEST,
  }
}

const RunEnv = z.object({
  KSEF_TOKEN: z.string().min(1, 'required'),
  KSEF_NIP: z.string().regex(/^\d{10}$/, 'must be 10 digits'),
  KSEF_ENV: z.enum(['prod', 'demo', 'test']).default('prod'),
  DATA_DIR: z.string().default('/data'),
  PDF_RENDERER: z.string().default('/app/vendor/ksef-pdf.js'),
  NTFY_URL: z.string().url().optional(),
  NTFY_TOPIC: z.string().min(1).optional(),
  NTFY_TOKEN: z.string().min(1).optional(),
  RETRY_DELAYS_SECONDS: z.string().default('10,30,90'),
})

export interface RunConfig {
  ksef: { token: string; nip: string; env: 'prod' | 'demo' | 'test' }
  dataDir: string
  pdfRenderer: string
  ntfy?: { url: string; topic: string; token?: string }
  retryDelaysMs: number[]
}

export function loadRunConfig(env: NodeJS.ProcessEnv = process.env): RunConfig {
  const parsed = RunEnv.safeParse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== '')))
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid configuration: ${issues}`)
  }
  const e = parsed.data
  if (e.NTFY_URL != null && e.NTFY_TOPIC == null) throw new Error('Invalid configuration: NTFY_TOPIC is required with NTFY_URL')
  const cfg: RunConfig = {
    ksef: { token: e.KSEF_TOKEN, nip: e.KSEF_NIP, env: e.KSEF_ENV },
    dataDir: e.DATA_DIR,
    pdfRenderer: e.PDF_RENDERER,
    retryDelaysMs: e.RETRY_DELAYS_SECONDS.split(',').filter((s) => s.trim() !== '').map((s) => Number(s) * 1000),
  }
  if (e.NTFY_URL != null && e.NTFY_TOPIC != null) {
    cfg.ntfy = { url: e.NTFY_URL, topic: e.NTFY_TOPIC, ...(e.NTFY_TOKEN != null ? { token: e.NTFY_TOKEN } : {}) }
  }
  return cfg
}
