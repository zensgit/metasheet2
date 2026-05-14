# Data Factory staging metadata supports - development notes - 2026-05-14

## Purpose

This slice tightens the adapter discovery contract for the local MetaSheet
staging source.

`metasheet:staging` is source-only and its guardrails already declare
`write.supported: false`. Before this change, the generic adapter metadata
fallback still gave it the default supports list, which included `upsert`.
That was misleading for consumers that inspect `supports` before reading the
guardrails block.

## Change

`GET /api/integration/adapters` now reports `metasheet:staging` with an
explicit read-only supports list:

```text
testConnection, listObjects, getSchema, read
```

`metasheet:multitable` remains unchanged as the target-only adapter with:

```text
testConnection, listObjects, getSchema, upsert
```

## Compatibility

This does not change the staging adapter runtime behavior. The adapter already
rejects writes. The change only makes the discovery metadata match the runtime
contract, reducing the chance that a future UI or SDK enables a write action
from the fallback supports list.

## Files changed

- `plugins/plugin-integration-core/lib/http-routes.cjs`
  - added explicit read-only `supports` for `metasheet:staging`.
- `plugins/plugin-integration-core/__tests__/http-routes.test.cjs`
  - asserted the read-only supports list in adapter discovery;
  - asserted `guardrails.write.supported: false` so the read-only contract is
    locked by both capability and guardrail metadata.

## Non-goals

- No new adapter operation.
- No migration.
- No frontend behavior change in this slice.
- No change to `metasheet:multitable` target metadata.
