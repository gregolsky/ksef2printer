import { describe, expect, it } from 'vitest'
import { loadRunConfig, ntfyWarnings } from '../src/config.js'

const base = { KSEF_TOKEN: 't', KSEF_NIP: '1111111111' }

describe('loadRunConfig', () => {
  it('reads retry delays in seconds', () => {
    expect(loadRunConfig({ ...base, RETRY_DELAYS_SECONDS: '5, 20' }).retryDelaysMs).toEqual([5000, 20000])
    expect(loadRunConfig(base).retryDelaysMs).toEqual([10000, 30000, 90000])
  })

  it('rejects retry delays that are not numbers', () => {
    expect(() => loadRunConfig({ ...base, RETRY_DELAYS_SECONDS: '10,abc' })).toThrow('RETRY_DELAYS_SECONDS')
    expect(() => loadRunConfig({ ...base, RETRY_DELAYS_SECONDS: '-5' })).toThrow('RETRY_DELAYS_SECONDS')
  })

  it('treats empty values as unset', () => {
    expect(loadRunConfig({ ...base, NTFY_URL: '', KSEF_ENV: '' })).toMatchObject({ ksef: { env: 'prod' } })
  })
})

describe('ntfyWarnings', () => {
  const ntfy = { url: 'https://ntfy.sh', topic: 'a'.repeat(32), commandTopic: 'a'.repeat(32) }

  it('is quiet for https and a long random topic', () => {
    expect(ntfyWarnings(ntfy)).toEqual([])
  })

  it('warns about a guessable topic once, unless a token protects it', () => {
    const short = { ...ntfy, topic: 'faktury', commandTopic: 'faktury' }
    expect(ntfyWarnings(short)).toHaveLength(1)
    expect(ntfyWarnings(short)[0]).toContain('NTFY_TOPIC is only 7 characters')
    expect(ntfyWarnings({ ...ntfy, commandTopic: 'cmd' })[0]).toContain('NTFY_COMMAND_TOPIC is only 3 characters')
    expect(ntfyWarnings({ ...short, token: 'tk_x' })).toEqual([])
  })

  it('warns about plain http except on the local network', () => {
    expect(ntfyWarnings({ ...ntfy, url: 'http://ntfy.example.com' })[0]).toContain('unencrypted')
    expect(ntfyWarnings({ ...ntfy, url: 'http://192.168.1.10:8080' })).toEqual([])
  })
})
