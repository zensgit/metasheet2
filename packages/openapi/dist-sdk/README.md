# @metasheet/sdk (preview)

Generated TypeScript types plus a small runtime client for MetaSheet V2.

## Build

- Build OpenAPI first: `pnpm exec tsx packages/openapi/tools/build.ts`
- Package SDK: `pnpm --dir packages/openapi/dist-sdk build`

## Type usage

```ts
import type { paths } from '@metasheet/sdk'

type GetApproval = paths['/api/approvals/{id}']['get']
```

## Low-level client

```ts
import { createClient } from '@metasheet/sdk/client'

const client = createClient({
  baseUrl: 'http://localhost:8910',
  getToken: async () => 'YOUR_TOKEN',
})

const approval = await client.request('GET', '/api/approvals/demo-1')
const approved = await client.requestWithRetry(
  'POST',
  '/api/approvals/demo-1/approve',
  { note: 'ok' },
  approval.etag,
)
```

## PLM federation helpers

```ts
import { createPlmFederationClient } from '@metasheet/sdk/client'

const plm = createPlmFederationClient({
  baseUrl: 'http://localhost:8910',
  getToken: async () => 'YOUR_TOKEN',
})

const products = await plm.listProducts({
  query: 'motor',
  itemType: 'part',
  limit: 25,
})

const detail = await plm.getProduct('ITEM-1000', {
  itemType: 'part',
})

const bom = await plm.getBom('ITEM-1000', {
  depth: 3,
  effectiveAt: '2026-03-08T00:00:00Z',
})

const approvals = await plm.listApprovals({
  productId: 'ITEM-1000',
  status: 'pending',
})

const documents = await plm.listDocuments({
  productId: 'ITEM-1000',
  role: 'primary',
})

const approvalHistory = await plm.getApprovalHistory('ECO-42')
await plm.approveApproval({ approvalId: 'ECO-42', comment: 'ok' })
const whereUsed = await plm.getWhereUsed({ itemId: 'COMP-200', recursive: true, maxLevels: 5 })
const diff = await plm.compareBom({ leftId: 'ITEM-1000', rightId: 'ITEM-1001' })
const schema = await plm.getBomCompareSchema()
const substitutes = await plm.listSubstitutes('BOM-LINE-001')
await plm.addSubstitute({ bomLineId: 'BOM-LINE-001', substituteItemId: 'ITEM-2000' })
const cad = await plm.getCadProperties('FILE-1000')
```

Available PLM helper methods:

- `listProducts`
- `getProduct`
- `getBom`
- `listDocuments`
- `listApprovals`
- `getApprovalHistory`
- `approveApproval`
- `rejectApproval`
- `getWhereUsed`
- `compareBom`
- `getBomCompareSchema`
- `listSubstitutes`
- `addSubstitute`
- `removeSubstitute`
- `getCadProperties`
- `getCadViewState`
- `getCadReview`
- `getCadHistory`
- `getCadDiff`
- `getCadMeshStats`
- `updateCadProperties`
- `updateCadViewState`
- `updateCadReview`
