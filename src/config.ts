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
