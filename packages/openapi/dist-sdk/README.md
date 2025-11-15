# @metasheet/sdk (preview)

Generated TypeScript types from MetaSheet V2 OpenAPI.

Install (local workspace):
- Build OpenAPI in repo: npm -w @metasheet/openapi run build
- Package SDK: npm --prefix metasheet-v2/packages/openapi/dist-sdk run build

Usage:
import type { paths } from '@metasheet/sdk'
type GetApproval = paths['/api/approvals/{id}']['get']

// Example fetch helper
async function getApproval(id: string, token: string): Promise<any> {
  const res = await fetch(`http://localhost:8910/api/approvals/${id}`, { headers: { authorization: `Bearer ${token}` } })
  return res.json()
}

Tiny client with If-Match retry:
import { createClient } from '@metasheet/sdk/client'
const client = createClient({ baseUrl: 'http://localhost:8910', getToken: async () => 'YOUR_TOKEN' })
const g = await client.request('GET', '/api/approvals/demo-1')
const ok = await client.requestWithRetry('POST', '/api/approvals/demo-1/approve', { note: 'ok' }, g.etag)
