import { describe, expect, it } from 'vitest'
import { loadRunConfig } from '../src/config.js'

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
