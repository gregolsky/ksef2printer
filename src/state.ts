import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface DocState {
  status: 'printed' | 'failed'
  attempts: number
  jobId?: string
  issueDate: string
  invoiceNumber: string
  error?: string
  updatedAt: string
}

export type MonthState = Record<string, DocState>

export async function loadState(file: string): Promise<MonthState> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as MonthState
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

/** Writes via a temp file and rename, so an interrupted run never leaves a half-written state file. */
export async function saveState(file: string, state: MonthState): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n')
  await rename(tmp, file)
}
