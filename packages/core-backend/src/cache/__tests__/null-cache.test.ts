/**
 * NullCache Tests
 */

import { describe, it, expect } from 'vitest'
// To avoid Vite SSR helper issues in Vitest, allow tests to import from built dist
// when TEST_USE_DIST=true (set by npm script). Falls back to source imports otherwise.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { NullCache } = (process.env.TEST_USE_DIST === 'true'
  // dist path after `npm run build`
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ? require('../../../dist-cache/src/cache/implementations/null-cache.js')
  // source path for local IDE runs
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  : require('../implementations/null-cache'))

describe('NullCache', () => {
  it('should always return cache miss on get', async () => {
    const cache = new NullCache()
    const result = await cache.get('test-key')

    expect(result.ok).toBe(true)
    expect(result.value).toBeNull()
  })

  it('should succeed on set without storing', async () => {
    const cache = new NullCache()
    const setResult = await cache.set('test-key', { data: 'value' }, 3600)

    expect(setResult.ok).toBe(true)

    // Verify it didn't actually store
    const getResult = await cache.get('test-key')
    expect(getResult.value).toBeNull()
  })

  it('should succeed on del without doing anything', async () => {
    const cache = new NullCache()
    const result = await cache.del('test-key')

    expect(result.ok).toBe(true)
  })

  it('should handle complex objects', async () => {
    const cache = new NullCache()
    const complexObj = {
      nested: {
        data: [1, 2, 3],
        string: 'test'
      }
    }

    await cache.set('complex', complexObj)
    const result = await cache.get('complex')

    // Should still return null
    expect(result.value).toBeNull()
  })
})
