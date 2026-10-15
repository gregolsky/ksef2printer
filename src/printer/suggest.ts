import type { FoundPrinter, FoundService } from './discover.js'

export interface PrinterSettings {
  uri: string
  model: string
  /** Why these settings were chosen, shown to the user. */
  reason: string
}

/** Formats the printer can render itself; any of them means IPP Everywhere / AirPrint works. */
const DRIVERLESS_FORMATS = ['image/pwg-raster', 'image/urf']

export function isDriverless(svc: FoundService): boolean {
  const pdl = (svc.txt['pdl'] ?? '').toLowerCase()
  const urf = svc.txt['urf'] ?? ''
  return DRIVERLESS_FORMATS.some((f) => pdl.includes(f)) || (urf !== '' && urf.toLowerCase() !== 'none')
}

/** One `lpinfo -m` line: "<model value> <make and model description>". */
export interface DriverModel {
  model: string
  description: string
}

export function parseModels(lpinfoOutput: string): DriverModel[] {
  return lpinfoOutput
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((l) => {
      const sp = l.indexOf(' ')
      return sp < 0 ? { model: l, description: '' } : { model: l.slice(0, sp), description: l.slice(sp + 1) }
    })
}

/** Make and model (e.g. "Brother", "HL-1210W") from the IEEE 1284 keys or the `ty` text record. */
function makeAndModel(p: FoundPrinter): { make: string; model: string } {
  const txt = Object.assign({}, ...p.services.map((s) => s.txt)) as Record<string, string>
  const ty = (txt['ty'] ?? p.name).replace(/\s+series$/i, '').trim()
  const make = txt['usb_mfg'] ?? ty.split(/\s+/)[0] ?? ''
  const rawModel = txt['usb_mdl'] ?? ty.slice(make.length)
  return { make, model: rawModel.replace(/\s+series$/i, '').trim() }
}

/**
 * Finds a driver for a model, trying the full model name first, then shorter prefixes so
 * "HL-1210W" falls back to a family entry such as "HL-1200 series". Matches must share the make.
 */
export function findDriver(make: string, model: string, models: readonly DriverModel[]): DriverModel | null {
  const candidates = models.filter(
    (m) => m.model !== 'everywhere' && !m.model.startsWith('driverless:') && m.description.toLowerCase().includes(make.toLowerCase()),
  )
  const norm = model.toLowerCase()
  const minLen = Math.min(norm.length, Math.max(4, norm.search(/\d/) + 2))
  for (let len = norm.length; len >= minLen; len--) {
    const prefix = norm.slice(0, len)
    const hits = candidates.filter((m) => m.description.toLowerCase().includes(prefix))
    if (hits.length > 0) return hits.sort((a, b) => driverRank(a) - driverRank(b))[0]!
  }
  return null
}

/** Prefers dedicated drivers over Gutenprint's generic ones, and Gutenprint's simplified PPDs over expert ones. */
function driverRank(m: DriverModel): number {
  if (!m.model.startsWith('gutenprint')) return 0
  return m.model.endsWith('/expert') ? 2 : 1
}

function addressOf(p: FoundPrinter): string {
  return p.addresses[0] ?? p.host
}

/** Picks a device URI and model for a discovered printer. */
export function suggestSettings(p: FoundPrinter, models: readonly DriverModel[]): PrinterSettings {
  const addr = addressOf(p)
  const ipp = p.services.find((s) => s.service === 'ipp') ?? p.services.find((s) => s.service === 'ipps')

  if (ipp != null && isDriverless(ipp)) {
    const scheme = ipp.service === 'ipps' ? 'ipps' : 'ipp'
    const rp = ipp.txt['rp'] ?? 'ipp/print'
    return {
      uri: `${scheme}://${addr}:${ipp.port}/${rp}`,
      model: 'everywhere',
      reason: 'driverless (IPP Everywhere / AirPrint), no driver needed',
    }
  }

  const { make, model } = makeAndModel(p)
  const driver = findDriver(make, model, models)
  const pdl = p.services.find((s) => s.service === 'pdl')
  const uri = `socket://${addr}:${pdl?.port ?? 9100}`
  if (driver != null) {
    return { uri, model: driver.model, reason: `needs a driver: ${driver.description}` }
  }
  return {
    uri: ipp != null ? `ipp://${addr}:${ipp.port}/${ipp.txt['rp'] ?? 'ipp/print'}` : uri,
    model: 'everywhere',
    reason: `no installed driver matches "${make} ${model}"; trying driverless, which may not work. ` +
      'Add a driver with EXTRA_DRIVER_PACKAGES or a PPD in /config/printer.ppd',
  }
}

/** Renders settings as lines for an env file. */
export function toEnv(p: FoundPrinter, s: PrinterSettings, options: string): string {
  return [
    `# ${p.name} (${p.host}) — ${s.reason}`,
    `PRINTER_URI=${s.uri}`,
    `PRINTER_MODEL=${s.model}`,
    `PRINTER_OPTIONS=${options}`,
    '',
  ].join('\n')
}
