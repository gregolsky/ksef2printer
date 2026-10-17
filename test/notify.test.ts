import { describe, expect, it } from 'vitest'
import { sendLong, splitMessage } from '../src/notify.js'

describe('splitMessage', () => {
  it('keeps a short message whole', () => {
    expect(splitMessage(['a', 'b'])).toEqual(['a\nb'])
  })

  it('splits on line boundaries, each part within the byte limit', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `${i} zażółć`)
    const parts = splitMessage(lines, 40)
    expect(parts.join('\n')).toBe(lines.join('\n'))
    for (const p of parts) expect(Buffer.byteLength(p)).toBeLessThanOrEqual(40)
    expect(parts.length).toBeGreaterThan(1)
  })

  it('cuts a single line that is longer than the limit', () => {
    expect(splitMessage(['x'.repeat(50)], 10)).toEqual(['x'.repeat(10)])
  })
})

describe('sendLong', () => {
  it('numbers the parts in the title', async () => {
    const sent: string[] = []
    const notifier = { send: async (title: string) => void sent.push(title) }
    await sendLong(notifier, 'ksef2printer 2026-10', Array.from({ length: 300 }, () => 'y'.repeat(40)))
    expect(sent).toEqual(['ksef2printer 2026-10 (1/4)', 'ksef2printer 2026-10 (2/4)', 'ksef2printer 2026-10 (3/4)', 'ksef2printer 2026-10 (4/4)'])
  })
})
