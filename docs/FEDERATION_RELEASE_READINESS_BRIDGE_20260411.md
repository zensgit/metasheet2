# Federation Release Readiness Bridge

Date: 2026-04-11

## Problem

Yuantus mainline already exposes a real release-readiness API:

- `GET /api/v1/release-readiness/items/{item_id}`

That surface was already used in Yuantus native workspace and had been validated
in previous live integration work, but `metasheet2` federation still had no
adapter method, no federation query operation, and no capability advertisement
for it.

The result was an avoidable product gap:

- Pact/CI protected documents, BOM, approvals, substitutes, and CAD
- live Yuantus governance had release-readiness
- federation could not expose the same governance result to Metasheet callers

## Decision

Implement the smallest viable bridge on the consumer side only:

1. Add `PLMAdapter.getReleaseReadiness(itemId, options)` in `yuantus` mode.
2. Add `release_readiness` to `POST /api/federation/plm/query`.
3. Advertise `release_readiness` in PLM supported operations.
4. Keep Yuantus unchanged because the provider API already exists.

This intentionally does **not** create a new dedicated route. It extends the
existing federation query surface, which keeps the API model aligned with the
rest of the PLM bridge.

## Response Shape

Federation now returns:

```json
{
  "ok": true,
  "data": {
    "productId": "prod-1001",
    "item_id": "prod-1001",
    "generated_at": "2026-04-11T00:00:00.000Z",
    "ruleset_id": "readiness",
    "summary": {
      "ok": false,
      "resources": 3,
      "ok_resources": 2,
      "error_count": 1,
      "warning_count": 1,
      "by_kind": {
        "mbom": {
          "resources": 1,
          "ok_resources": 0,
          "error_count": 1,
          "warning_count": 0
        }
      }
    },
    "resources": [],
    "links": {
      "summary": "/api/v1/release-readiness/items/prod-1001?ruleset_id=readiness",
      "export": "/api/v1/release-readiness/items/prod-1001/export?export_format=zip&ruleset_id=readiness"
    }
  }
}
```

Key choice:

- preserve Yuantus fields such as `item_id`, `ruleset_id`, `summary`, and
  `resources`
- add `productId` at the federation layer for consistency with existing PLM
  query responses
- surface canonical Yuantus links so the caller can deep-link or export

## Why This Slice

This was the next highest-leverage slice because:

- it uses an already deployed Yuantus API rather than inventing a new one
- it closes a real governance gap instead of extending already-covered Pact
  surfaces
- it is small enough to land in one consumer-side change set
- it gives Metasheet a direct answer to the most important downstream question:
  “is this object ready to release?”

## Files Changed

- `packages/core-backend/src/data-adapters/PLMAdapter.ts`
- `packages/core-backend/src/routes/federation.ts`
- `packages/core-backend/tests/fixtures/federation/contracts.ts`
- `packages/core-backend/tests/unit/plm-adapter-yuantus.test.ts`
- `packages/core-backend/tests/unit/federation.contract.test.ts`

## Verification

Commands run:

```bash
pnpm --dir packages/core-backend exec vitest run \
  tests/unit/plm-adapter-yuantus.test.ts \
  tests/unit/federation.contract.test.ts \
  --reporter=dot

pnpm --dir packages/core-backend test:contract
```

Observed results:

- targeted unit tests: `30 passed`
- contract tests: `16 passed`

Live provider validation:

```bash
# 1. Start Yuantus locally
./.venv/bin/uvicorn yuantus.api.app:create_app --factory --host 127.0.0.1 --port 7910

# 2. Verify provider endpoint directly
curl -s -X POST http://127.0.0.1:7910/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: tenant-1" \
  -H "x-org-id: org-1" \
  -d '{"tenant_id":"tenant-1","username":"phase0-test","password":"phase0pass","org_id":"org-1"}'

curl -s \
  -H "Authorization: Bearer <token>" \
  -H "x-tenant-id: tenant-1" \
  -H "x-org-id: org-1" \
  "http://127.0.0.1:7910/api/v1/release-readiness/items/b5ecee24-5ce8-4b59-9551-446e1c50b608?ruleset_id=readiness"

# 3. Verify the new Metasheet adapter path against the same provider
PLM_BASE_URL=http://127.0.0.1:7910 \
PLM_API_MODE=yuantus \
PLM_TENANT_ID=tenant-1 \
PLM_ORG_ID=org-1 \
PLM_USERNAME=phase0-test \
PLM_PASSWORD=phase0pass \
PLM_ITEM_TYPE=Part \
pnpm exec tsx --eval "import { PLMAdapter } from './src/data-adapters/PLMAdapter.ts'; void (async () => { const configService={get: async ()=>undefined}; const logger={info:()=>{},warn:()=>{},error:console.error}; const adapter=new PLMAdapter(configService as any, logger as any); await adapter.connect(); const result=await adapter.getReleaseReadiness('b5ecee24-5ce8-4b59-9551-446e1c50b608',{rulesetId:'readiness'}); console.log(JSON.stringify(result.data[0], null, 2)); await adapter.disconnect(); })().catch((error) => { console.error(error); process.exit(1); });"
```

Observed live result:

- provider health responded `ok=true`
- login returned a valid JWT
- direct provider readiness call returned `ok=true`
- adapter live call returned `count=1`, `error=null`
- the adapter emitted canonical `summary` / `export` links that point back to
  the provider surface

The concrete sample object currently returns an empty readiness summary
(`resources=0`), which is acceptable for bridge verification. A richer demo
fixture is a separate data task, not a bridge correctness issue.

## Deferred

This bridge is intentionally **not** added to Pact yet.

Reason:

- current Pact scope protects the established mainline surfaces up through the
  existing Wave 5 set
- `release_readiness` is now a real federation surface, but the right next step
  is to let the consumer call pattern settle and then add a targeted Pact
  interaction, not to expand Pact speculatively

The likely next contract step is a small follow-up Wave that locks:

- `GET /api/v1/release-readiness/items/{item_id}`

once the federation/UI caller becomes part of the stable mainline workflow.
