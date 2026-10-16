import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from './fs.js'

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

export async function saveState(file: string, state: MonthState): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(state, null, 2) + '\n')
}
