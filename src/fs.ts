import { access, mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Writes via a temp file and rename, so an interrupted run never leaves a half-written file behind. */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, file)
}
