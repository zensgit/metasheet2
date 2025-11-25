import { HTTPAdapter } from './packages/core-backend/src/data-adapters/HTTPAdapter.ts'
import { cache } from './packages/core-backend/src/cache/index.ts'

;(async () => {
  // HTTPAdapter success request to a public API
  const adapter = new HTTPAdapter({
    type: 'http',
    connection: { baseURL: 'https://jsonplaceholder.typicode.com' },
    options: {},
    credentials: {},
    name: 'public'
  } as any)
  await adapter.connect().catch(()=>{})
  const res = await adapter.query('/posts/1').catch(e => ({ error: e }))
  console.log('HTTPAdapter result keys:', Object.keys(res || {}))

  // Simple NullCache implementation
  await cache.get('phase5:test:key')
  console.log('Cache get invoked')
})()
