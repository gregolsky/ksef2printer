import { describe, expect, it } from 'vitest'
import { collectPrinters, type MdnsRecord } from '../src/printer/discover.js'
import { suggestSettings as suggest, toEnv } from '../src/printer/suggest.js'
import { findDriver, parseModels, suggestSettings } from '../src/printer/suggest.js'

const txt = (...kv: string[]) => kv.map((s) => Buffer.from(s))

// Records as the Brother HL-1210W announces itself (host-based printer, empty pdl).
const brother: MdnsRecord[] = [
  { name: '_ipp._tcp.local', type: 'PTR', data: 'Brother HL-1210W series._ipp._tcp.local' },
  { name: 'Brother HL-1210W series._ipp._tcp.local', type: 'SRV', data: { target: 'BRN001122334455.local', port: 631 } },
  {
    name: 'Brother HL-1210W series._ipp._tcp.local',
    type: 'TXT',
    data: txt('ty=Brother HL-1210W series', 'pdl=', 'rp=ipp/print', 'usb_MFG=Brother', 'usb_MDL=HL-1210W series'),
  },
  { name: '_pdl-datastream._tcp.local', type: 'PTR', data: 'Brother HL-1210W series._pdl-datastream._tcp.local' },
  { name: 'Brother HL-1210W series._pdl-datastream._tcp.local', type: 'SRV', data: { target: 'BRN001122334455.local', port: 9100 } },
  { name: 'BRN001122334455.local', type: 'A', data: '192.168.1.50' },
]

// A typical driverless office printer.
const hp: MdnsRecord[] = [
  { name: '_ipp._tcp.local', type: 'PTR', data: 'HP LaserJet MFP M234dw._ipp._tcp.local' },
  { name: 'HP LaserJet MFP M234dw._ipp._tcp.local', type: 'SRV', data: { target: 'NPI1A2B3C.local', port: 631 } },
  {
    name: 'HP LaserJet MFP M234dw._ipp._tcp.local',
    type: 'TXT',
    data: txt('ty=HP LaserJet MFP M234dw', 'pdl=application/pdf,image/urf,image/pwg-raster', 'rp=ipp/print', 'URF=W8,SRGB24,RS600'),
  },
  { name: 'NPI1A2B3C.local', type: 'A', data: '192.168.1.40' },
]

const models = parseModels(
  [
    'everywhere IPP Everywhere',
    'drv:///brlaser.drv/br1110.ppd Brother HL-1110 series, using brlaser v6.2.7',
    'drv:///brlaser.drv/br1200.ppd Brother HL-1200 series, using brlaser v6.2.7',
    'gutenprint.5.3://brother-hl-1250/expert Brother HL-1250 - CUPS+Gutenprint v5.3.5',
    'gutenprint.5.3://canon-pixma-ip7200/expert Canon PIXMA iP7200 - CUPS+Gutenprint v5.3.5',
    'gutenprint.5.3://canon-pixma-ip7200/simple Canon PIXMA iP7200 - CUPS+Gutenprint v5.3.5 Simplified',
  ].join('\n'),
)

describe('collectPrinters', () => {
  it('groups services of one host into one printer with its address', () => {
    const [p] = collectPrinters(brother)
    expect(p).toMatchObject({ name: 'Brother HL-1210W series', host: 'brn001122334455.local', addresses: ['192.168.1.50'] })
    expect(p!.services.map((s) => [s.service, s.port])).toEqual([
      ['ipp', 631],
      ['pdl', 9100],
    ])
  })
  it('separates different printers', () => {
    expect(collectPrinters([...brother, ...hp]).map((p) => p.name)).toEqual(['Brother HL-1210W series', 'HP LaserJet MFP M234dw'])
  })
})

describe('suggestSettings', () => {
  it('uses driverless IPP when the printer renders PWG raster or URF', () => {
    expect(suggestSettings(collectPrinters(hp)[0]!, models)).toMatchObject({
      uri: 'ipp://192.168.1.40:631/ipp/print',
      model: 'everywhere',
    })
  })
  it('falls back to a family driver over raw port 9100 for host-based printers', () => {
    expect(suggestSettings(collectPrinters(brother)[0]!, models)).toMatchObject({
      uri: 'socket://192.168.1.50:9100',
      model: 'drv:///brlaser.drv/br1200.ppd',
    })
  })
  it('says so when no driver matches', () => {
    const s = suggestSettings(collectPrinters(brother)[0]!, parseModels('everywhere IPP Everywhere'))
    expect(s.model).toBe('everywhere')
    expect(s.reason).toMatch(/no installed driver/)
  })
})

describe('findDriver', () => {
  it('prefers simplified Gutenprint PPDs over expert ones', () => {
    expect(findDriver('Canon', 'PIXMA iP7200', models)?.model).toBe('gutenprint.5.3://canon-pixma-ip7200/simple')
  })
  it('does not match another make', () => {
    expect(findDriver('Canon', 'HL-1210W', models)).toBeNull()
  })
})

describe('untrusted mDNS announcements', () => {
  // Any device on the network can announce this; before the fix the newline added NODE_OPTIONS to printer.env.
  const hostile: MdnsRecord[] = [
    { name: '_ipp._tcp.local', type: 'PTR', data: 'Office Printer._ipp._tcp.local' },
    { name: 'Office Printer._ipp._tcp.local', type: 'SRV', data: { target: 'office.local', port: 631 } },
    {
      name: 'Office Printer._ipp._tcp.local',
      type: 'TXT',
      data: [
        Buffer.from('ty=Brother\nKSEF_ENV=test'),
        Buffer.from('pdl=image/urf'),
        Buffer.from('rp=ipp/print\nNODE_OPTIONS=--import=data:text/javascript,process.exit(9)'),
      ],
    },
    { name: 'office.local', type: 'A', data: '192.168.1.66' },
  ]

  it('cannot add variables to the saved env file', () => {
    const [p] = collectPrinters(hostile)
    const env = toEnv(p!, suggest(p!, []), 'media=A4')
    const vars = env.split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split('=')[0])
    expect(vars).toEqual(['PRINTER_URI', 'PRINTER_MODEL', 'PRINTER_OPTIONS'])
    expect(env).toContain('PRINTER_URI=ipp://192.168.1.66:631/ipp/print\n')
    expect(env).not.toContain('NODE_OPTIONS')
  })

  it('drops services whose host or address is not a plain name or IPv4 address', () => {
    const bad: MdnsRecord[] = [
      { name: '_ipp._tcp.local', type: 'PTR', data: 'X._ipp._tcp.local' },
      { name: 'X._ipp._tcp.local', type: 'SRV', data: { target: 'evil\n.local', port: 631 } },
    ]
    expect(collectPrinters(bad)).toEqual([])
    const [p] = collectPrinters([...hostile.slice(0, 3), { name: 'office.local', type: 'A', data: '1.2.3.4\nX=1' }])
    expect(p!.addresses).toEqual([])
  })

  it('refuses to write a value containing a newline', () => {
    const [p] = collectPrinters(hostile)
    expect(() => toEnv(p!, { uri: 'socket://x\nA=1', model: 'everywhere', reason: '' }, 'media=A4')).toThrow('control characters')
  })
})
