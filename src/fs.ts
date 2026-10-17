import { readFileSync, rmSync } from 'node:fs'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

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

/** A lock older than this is left over from a crash or power loss and is taken over. */
const STALE_LOCK_MS = 6 * 60 * 60 * 1000

const heldLocks = new Set<string>()

/** Removes locks held by this process; for signal and exit handlers, which cannot wait for `finally`. */
export function releaseLocksSync(): void {
  for (const file of heldLocks) rmSync(file, { force: true })
  heldLocks.clear()
}

export class RunLockedError extends Error {}

export interface HeldLock {
  what: string
  since: string
}

/**
 * Changes on every boot of the host kernel (containers share it), so a lock left by a power cut is
 * recognised as stale as soon as the machine is back. Null where the kernel doesn't provide it.
 */
export function currentBootId(): string | null {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  } catch {
    return null
  }
}

interface LockOptions {
  now?: () => number
  bootId?: string | null
}

/**
 * A lock that is missing, unreadable, older than `STALE_LOCK_MS` or written before the last reboot
 * doesn't count as held.
 */
export async function readRunLock(dataDir: string, { now = Date.now, bootId = currentBootId() }: LockOptions = {}): Promise<HeldLock | null> {
  const raw = await readFile(join(dataDir, 'run.lock'), 'utf8').catch(() => null)
  if (raw == null) return null
  let held: { what?: unknown; since?: unknown; bootId?: unknown } = {}
  try {
    held = JSON.parse(raw) as typeof held
  } catch {
    return null
  }
  const since = typeof held.since === 'string' ? Date.parse(held.since) : NaN
  if (!Number.isFinite(since) || now() - since >= STALE_LOCK_MS) return null
  if (bootId != null && typeof held.bootId === 'string' && held.bootId !== bootId) return null
  return { what: typeof held.what === 'string' ? held.what : 'unknown', since: held.since as string }
}

/**
 * Runs `fn` while holding `<dataDir>/run.lock`, so a manual run and a run started over ntfy never
 * print the same month at once. Throws `RunLockedError` if another run holds a fresh lock.
 */
export async function withRunLock<T>(
  dataDir: string,
  what: string,
  fn: () => Promise<T>,
  opts: LockOptions & { onStale?: (held: string) => void } = {},
): Promise<T> {
  const now = opts.now ?? Date.now
  const bootId = opts.bootId !== undefined ? opts.bootId : currentBootId()
  const file = join(dataDir, 'run.lock')
  const content = JSON.stringify({ what, since: new Date(now()).toISOString(), ...(bootId != null ? { bootId } : {}) }) + '\n'
  await mkdir(dataDir, { recursive: true })
  try {
    await writeFile(file, content, { flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    const held = await readRunLock(dataDir, { now, bootId })
    if (held != null) throw new RunLockedError(`another run is in progress: ${held.what} since ${held.since}`)
    opts.onStale?.((await readFile(file, 'utf8').catch(() => '')).trim())
    await writeFile(file, content)
  }
  heldLocks.add(file)
  try {
    return await fn()
  } finally {
    heldLocks.delete(file)
    await rm(file, { force: true })
  }
}
