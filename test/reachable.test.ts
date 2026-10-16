import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { assertReachable, tcpTarget } from '../src/printer/reachable.js'

describe('tcpTarget', () => {
  it('finds host and port, with each scheme default', () => {
    expect(tcpTarget('socket://192.168.1.50:9100')).toEqual({ host: '192.168.1.50', port: 9100 })
    expect(tcpTarget('socket://192.168.1.50')).toEqual({ host: '192.168.1.50', port: 9100 })
    expect(tcpTarget('ipp://printer.local/ipp/print')).toEqual({ host: 'printer.local', port: 631 })
    expect(tcpTarget('ipps://[fe80::1]:443/ipp/print')).toEqual({ host: 'fe80::1', port: 443 })
  })

  it('skips URIs that are not plain TCP', () => {
    expect(tcpTarget('usb://Brother/HL-1210W')).toBeNull()
    expect(tcpTarget('')).toBeNull()
  })
})

describe('assertReachable', () => {
  let server: Server | undefined
  afterEach(() => server?.close())

  it('passes when the port accepts a connection', async () => {
    server = createServer((s) => s.end())
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    await expect(assertReachable(`socket://127.0.0.1:${port}`)).resolves.toBeUndefined()
  })

  it('fails with the address when nothing listens', async () => {
    server = createServer()
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    await new Promise<void>((r) => server!.close(() => r()))
    server = undefined
    await expect(assertReachable(`socket://127.0.0.1:${port}`)).rejects.toThrow(`printer not reachable at 127.0.0.1:${port}`)
  })

  it('does not check a URI without a TCP target', async () => {
    await expect(assertReachable('')).resolves.toBeUndefined()
  })
})
