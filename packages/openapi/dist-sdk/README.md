# @metasheet/sdk (preview)

Generated TypeScript types from MetaSheet V2 OpenAPI.

Local workspace build:
- Generate the upstream OpenAPI output first from the repo root.
- Package the SDK with `pnpm --dir packages/openapi/dist-sdk build`.

Usage:
```ts
import type { paths } from '@metasheet/sdk'
type GetApproval = paths['/api/approvals/{id}']['get']
```

// Example fetch helper
```ts
async function getApproval(id: string, token: string): Promise<unknown> {
  const res = await fetch(`http://localhost:8910/api/approvals/${id}`, { headers: { authorization: `Bearer ${token}` } })
  return res.json()
}
```

Tiny client with If-Match retry:
```ts
import { createClient } from '@metasheet/sdk/client'

const client = createClient({ baseUrl: 'http://localhost:8910', getToken: async () => 'YOUR_TOKEN' })
const g = await client.request('GET', '/api/approvals/demo-1')
const ok = await client.requestWithRetry('POST', '/api/approvals/demo-1/approve', { note: 'ok' }, g.etag)
```

Package exports:
- `@metasheet/sdk`: generated OpenAPI types from `index.d.ts`
- `@metasheet/sdk/client`: lightweight runtime client from `client.js`
