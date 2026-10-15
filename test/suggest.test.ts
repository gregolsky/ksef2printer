import { describe, expect, it } from 'vitest'
import { collectPrinters, type MdnsRecord } from '../src/printer/discover.js'
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
