import { getCacheRegistry } from '../../core/cache/CacheRegistry';

describe('CacheRegistry', () => {
  it('selects MemoryCache when FEATURE_CACHE=true', async () => {
    process.env.FEATURE_CACHE = 'true';
    const registry = getCacheRegistry();
    const info = registry.info?.();
    expect(info?.implName).toMatch(/MemoryCache/i);
  });
});

