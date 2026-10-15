import { execFile } from 'node:child_process'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export type Run = (cmd: string, args: readonly string[]) => Promise<RunResult>

/** Runs a command and resolves with its exit code and output; never rejects on non-zero exit. */
export const run: Run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, [...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err == null) {
        resolve({ code: 0, stdout, stderr })
        return
      }
      const code = typeof err.code === 'number' ? err.code : 127
      resolve({ code, stdout: stdout ?? '', stderr: stderr || err.message })
    })
  })
