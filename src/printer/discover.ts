import makeMdns from 'multicast-dns'

/** Service types printers advertise over mDNS / Bonjour. */
export const PRINTER_SERVICES = ['_ipp._tcp.local', '_ipps._tcp.local', '_pdl-datastream._tcp.local'] as const

export interface MdnsRecord {
  name: string
  type: string
  data: unknown
}

export interface FoundService {
  instance: string
  service: 'ipp' | 'ipps' | 'pdl'
  host: string
  port: number
  txt: Record<string, string>
}

export interface FoundPrinter {
  /** Human-readable name, e.g. "Brother HL-1210W series". */
  name: string
  host: string
  addresses: string[]
  services: FoundService[]
}

const SERVICE_KIND: Record<string, FoundService['service']> = {
  '_ipp._tcp.local': 'ipp',
  '_ipps._tcp.local': 'ipps',
  '_pdl-datastream._tcp.local': 'pdl',
}

function txtToMap(data: unknown): Record<string, string> {
  const parts = Array.isArray(data) ? data : [data]
  const out: Record<string, string> = {}
  for (const p of parts) {
    const s = Buffer.isBuffer(p) ? p.toString('utf8') : typeof p === 'string' ? p : ''
    const eq = s.indexOf('=')
    if (eq > 0) out[s.slice(0, eq).toLowerCase()] = s.slice(eq + 1)
  }
  return out
}

const lc = (s: string) => s.toLowerCase().replace(/\.$/, '')

/** Turns raw mDNS answer/additional records into printers grouped by host. */
export function collectPrinters(records: readonly MdnsRecord[]): FoundPrinter[] {
  const instances = new Map<string, FoundService['service']>()
  const srv = new Map<string, { host: string; port: number }>()
  const txt = new Map<string, Record<string, string>>()
  const addrs = new Map<string, Set<string>>()

  for (const r of records) {
    const name = lc(r.name)
    if (r.type === 'PTR' && typeof r.data === 'string' && SERVICE_KIND[name] != null) {
      instances.set(lc(r.data), SERVICE_KIND[name])
    } else if (r.type === 'SRV' && r.data != null && typeof r.data === 'object') {
      const d = r.data as { target?: string; port?: number }
      if (d.target != null && d.port != null) srv.set(name, { host: lc(d.target), port: d.port })
    } else if (r.type === 'TXT') {
      txt.set(name, { ...txt.get(name), ...txtToMap(r.data) })
    } else if (r.type === 'A' && typeof r.data === 'string') {
      if (!addrs.has(name)) addrs.set(name, new Set())
      addrs.get(name)!.add(r.data)
    }
  }

  const byHost = new Map<string, FoundPrinter>()
  for (const [instance, service] of instances) {
    const s = srv.get(instance)
    if (s == null) continue
    const t = txt.get(instance) ?? {}
    let p = byHost.get(s.host)
    if (p == null) {
      p = { name: t['ty'] ?? instanceLabel(instance), host: s.host, addresses: [...(addrs.get(s.host) ?? [])], services: [] }
      byHost.set(s.host, p)
    }
    if (t['ty'] != null && p.name === instanceLabel(instance)) p.name = t['ty']
    p.services.push({ instance, service, host: s.host, port: s.port, txt: t })
  }
  return [...byHost.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function instanceLabel(instance: string): string {
  return instance.split('._')[0] ?? instance
}

/** Browses the local network for printers for `timeoutMs`. */
export async function browsePrinters(timeoutMs = 4000): Promise<FoundPrinter[]> {
  const mdns = makeMdns()
  const records: MdnsRecord[] = []
  const pending = new Set<string>()

  mdns.on('response', (res) => {
    for (const a of [...(res.answers ?? []), ...(res.additionals ?? [])]) {
      records.push({ name: a.name, type: a.type, data: (a as { data?: unknown }).data })
      // Follow up on hosts whose address was not in the additionals.
      if (a.type === 'SRV') {
        const target = (a.data as { target: string }).target
        if (!pending.has(target)) {
          pending.add(target)
          mdns.query({ questions: [{ name: target, type: 'A' }] })
        }
      }
    }
  })
  mdns.query({ questions: PRINTER_SERVICES.map((name) => ({ name, type: 'PTR' as const })) })
  await new Promise((r) => setTimeout(r, timeoutMs / 2))
  mdns.query({ questions: PRINTER_SERVICES.map((name) => ({ name, type: 'PTR' as const })) })
  await new Promise((r) => setTimeout(r, timeoutMs / 2))
  mdns.destroy()
  return collectPrinters(records)
}
