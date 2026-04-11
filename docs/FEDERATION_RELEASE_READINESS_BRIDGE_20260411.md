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
