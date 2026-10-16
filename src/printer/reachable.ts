import { connect } from 'node:net'

const DEFAULT_PORTS: Record<string, number> = { socket: 9100, ipp: 631, ipps: 631, http: 631, https: 443 }

/** Host and port a device URI connects to, or null for URIs that are not plain TCP (usb://, file:, …). */
export function tcpTarget(uri: string): { host: string; port: number } | null {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return null
  }
  const scheme = url.protocol.replace(/:$/, '')
  const defaultPort = DEFAULT_PORTS[scheme]
  if (defaultPort == null || url.hostname === '') return null
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port !== '' ? Number(url.port) : defaultPort }
}

/**
 * Throws if the printer behind `uri` does not accept a TCP connection within `timeoutMs`.
 * URIs that are not plain TCP are not checked.
 */
export async function assertReachable(uri: string, timeoutMs = 5000): Promise<void> {
  const target = tcpTarget(uri)
  if (target == null) return
  await new Promise<void>((resolve, reject) => {
    const socket = connect(target)
    const fail = (reason: string) => {
      socket.destroy()
      reject(new Error(`printer not reachable at ${target.host}:${target.port} (${reason}) — is it on and connected?`))
    }
    socket.setTimeout(timeoutMs, () => fail('no answer'))
    socket.once('error', (err) => fail(err.message))
    socket.once('connect', () => {
      socket.end()
      resolve()
    })
  })
}
