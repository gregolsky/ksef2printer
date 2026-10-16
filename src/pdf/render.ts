import { pathToFileURL } from 'node:url'

/**
 * Renders KSeF invoice XML to PDF with CIRFMF/ksef-pdf-generator (MIT), the Ministry of Finance's
 * visualisation library. It is a browser library, built into the image from a pinned commit
 * (see Dockerfile and scripts/build-pdf-renderer.sh) and loaded at runtime.
 */
interface Renderer {
  generateInvoice(file: File, data: { nrKSeF: string; qrCode?: string }, format: 'base64'): Promise<string>
}

// The library reads the XML through the browser FileReader API, which Node lacks.
class NodeFileReader {
  result: string | null = null
  error: unknown = null
  onload: ((e: { target: NodeFileReader }) => void) | null = null
  onerror: ((e: { target: NodeFileReader }) => void) | null = null
  readAsText(blob: Blob, encoding = 'utf-8'): void {
    blob.arrayBuffer().then(
      (buf) => {
        this.result = new TextDecoder(encoding).decode(buf)
        this.onload?.({ target: this })
      },
      (err: unknown) => {
        this.error = err
        this.onerror?.({ target: this })
      },
    )
  }
}

// The library does not listen for read errors, so a failure inside it could otherwise hang the run.
const RENDER_TIMEOUT_MS = 60_000

let loaded: Promise<Renderer> | null = null

function load(modulePath: string): Promise<Renderer> {
  if (loaded == null) {
    const g = globalThis as { FileReader?: unknown }
    g.FileReader ??= NodeFileReader
    loaded = import(pathToFileURL(modulePath).href) as Promise<Renderer>
  }
  return loaded
}

export async function renderInvoicePdf(
  modulePath: string,
  xml: Buffer,
  ksefNumber: string,
  qrCode: string,
): Promise<Buffer> {
  const renderer = await load(modulePath)
  const file = new File([xml], `${ksefNumber}.xml`, { type: 'application/xml' })
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`rendering did not finish in ${RENDER_TIMEOUT_MS / 1000}s`)), RENDER_TIMEOUT_MS)
  })
  try {
    const base64 = await Promise.race([renderer.generateInvoice(file, { nrKSeF: ksefNumber, qrCode }, 'base64'), timeout])
    return Buffer.from(base64, 'base64')
  } finally {
    clearTimeout(timer)
  }
}
