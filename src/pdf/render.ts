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
  onload: ((e: { target: NodeFileReader }) => void) | null = null
  readAsText(blob: Blob, encoding = 'utf-8'): void {
    void blob.arrayBuffer().then((buf) => {
      this.result = new TextDecoder(encoding).decode(buf)
      this.onload?.({ target: this })
    })
  }
}

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
  const base64 = await renderer.generateInvoice(file, { nrKSeF: ksefNumber, qrCode }, 'base64')
  return Buffer.from(base64, 'base64')
}
