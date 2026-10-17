import { z } from 'zod'

function parseEnv<T extends z.ZodTypeAny>(schema: T, env: Record<string, string | undefined>): z.infer<T> {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid configuration: ${issues}`)
  }
  return parsed.data
}

const PrinterEnv = z.object({
  PRINTER_QUEUE: z.string().min(1).default('ksef'),
  PRINTER_URI: z.string().default(''),
  PRINTER_OPTIONS: z.string().default(''),
  PRINT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
  JOB_STATE_TEST: z.string().default('/app/job-state.test'),
})

export interface PrinterConfig {
  queue: string
  /** Device URI the queue was created with; empty when the queue is managed outside this app. */
  uri: string
  options: string[]
  timeoutMs: number
  jobStateTest: string
}

export function loadPrinterConfig(env: NodeJS.ProcessEnv = process.env): PrinterConfig {
  const e = parseEnv(PrinterEnv, env)
  return {
    queue: e.PRINTER_QUEUE,
    uri: e.PRINTER_URI,
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
  NTFY_COMMAND_TOPIC: z.string().min(1).optional(),
  NTFY_TOKEN: z.string().min(1).optional(),
  RETRY_DELAYS_SECONDS: z
    .string()
    .default('10,30,90')
    .transform((s) => s.split(',').map((v) => v.trim()).filter((v) => v !== ''))
    .refine((vs) => vs.every((v) => /^\d+(\.\d+)?$/.test(v)), 'must be comma-separated seconds, e.g. 10,30,90')
    .transform((vs) => vs.map((v) => Number(v) * 1000)),
})

export interface RunConfig {
  ksef: { token: string; nip: string; env: 'prod' | 'demo' | 'test' }
  dataDir: string
  pdfRenderer: string
  /** `commandTopic` is where `listen` reads commands; it defaults to `topic`. */
  ntfy?: { url: string; topic: string; commandTopic: string; token?: string }
  retryDelaysMs: number[]
}

export function loadRunConfig(env: NodeJS.ProcessEnv = process.env): RunConfig {
  // Empty values (e.g. `NTFY_URL=` left in .env) count as unset.
  const e = parseEnv(RunEnv, Object.fromEntries(Object.entries(env).filter(([, v]) => v !== '')))
  if (e.NTFY_URL != null && e.NTFY_TOPIC == null) throw new Error('Invalid configuration: NTFY_TOPIC is required with NTFY_URL')
  const cfg: RunConfig = {
    ksef: { token: e.KSEF_TOKEN, nip: e.KSEF_NIP, env: e.KSEF_ENV },
    dataDir: e.DATA_DIR,
    pdfRenderer: e.PDF_RENDERER,
    retryDelaysMs: e.RETRY_DELAYS_SECONDS,
  }
  if (e.NTFY_URL != null && e.NTFY_TOPIC != null) {
    cfg.ntfy = {
      url: e.NTFY_URL,
      topic: e.NTFY_TOPIC,
      commandTopic: e.NTFY_COMMAND_TOPIC ?? e.NTFY_TOPIC,
      ...(e.NTFY_TOKEN != null ? { token: e.NTFY_TOKEN } : {}),
    }
  }
  return cfg
}

/** Shorter topics can be guessed; on public ntfy.sh the topic name is the only protection. */
const MIN_TOPIC_LENGTH = 20

/**
 * Weaknesses in the ntfy setup worth telling the user about. Without a token, anyone who knows the
 * topic can read the invoice lists and, with the listener running, start printing.
 */
export function ntfyWarnings(ntfy: NonNullable<RunConfig['ntfy']>): string[] {
  const warnings: string[] = []
  const url = new URL(ntfy.url)
  const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/.test(url.hostname)
  if (url.protocol !== 'https:' && !local) {
    warnings.push(`NTFY_URL uses ${url.protocol}//: invoice lists and commands cross the internet unencrypted`)
  }
  if (ntfy.token == null) {
    const topics = [['NTFY_TOPIC', ntfy.topic]]
    if (ntfy.commandTopic !== ntfy.topic) topics.push(['NTFY_COMMAND_TOPIC', ntfy.commandTopic])
    for (const [name, topic] of topics as Array<[string, string]>) {
      if (topic.length < MIN_TOPIC_LENGTH) {
        warnings.push(
          `${name} is only ${topic.length} characters: anyone who guesses it can read your invoice lists and start printing. ` +
            'Use a random one, e.g. `openssl rand -hex 16`',
        )
      }
    }
  }
  return warnings
}
