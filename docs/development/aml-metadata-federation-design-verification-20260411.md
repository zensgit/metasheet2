# AML Metadata Federation Design and Verification

Date: 2026-04-11

## Why This Exists

`aml/metadata` fills a gap in the PLM bridge: callers need item-type schema
discovery, not just item data. The metadata payload drives form rendering,
field validation, and downstream mapping logic, so the federation layer needs a
stable pass-through path from the web service down to Yuantus.

The change set keeps the federation contract contract-first:

1. the consumer asks for metadata through the web service and SDK,
2. federation normalizes the request and response envelope,
3. `PLMAdapter` in `yuantus` mode fetches the provider-side AML metadata route,
4. Pact freezes the consumer-visible interaction so the shape cannot drift.

## Data Flow

The request path is:

`plmService.getMetadata(itemType)`
-> `plmFederationClient.getMetadata(itemType)`
-> `GET /api/federation/plm/metadata/:itemType`
-> `PLMAdapter.getItemMetadata(itemType)`
-> `GET /api/v1/aml/metadata/:itemType`

The adapter maps the provider response into the canonical federation shape and
returns it through the existing `ok/data/error` wrapper. In mock mode it returns
a minimal placeholder object, and in unsupported legacy modes it returns an
empty result plus an explicit error.

## Change Surface

- `PLMAdapter.getItemMetadata` now resolves item-type schema from Yuantus AML.
- Federation exposes both `GET /api/plm/metadata/:itemType` and
  `GET /api/federation/plm/metadata/:itemType` for the same handler.
- The SDK adds `getMetadata(itemType)` on the PLM federation client.
- The web service adds `plmService.getMetadata(itemType)` and a matching local
  type surface.
- The pact consumer interaction now includes the metadata discovery route, so
  the contract tests track the live consumer call site instead of an aspirational
  endpoint.

## Key Contract Shape

Consumer and federation request shape:

```ts
getMetadata(itemType: string): Promise<PlmItemMetadata>
```

Canonical metadata payload:

```ts
interface PlmItemMetadata {
  id: string
  label?: string
  is_relationship?: boolean
  properties: PlmMetadataField[]
}

interface PlmMetadataField {
  name: string
  label?: string
  type?: string
  required?: boolean
  length?: number | null
  default?: unknown
}
```

Federation returns:

```json
{
  "ok": true,
  "data": {
    "id": "Part",
    "label": "Part",
    "is_relationship": false,
    "properties": [
      {
        "name": "item_number",
        "label": "料号",
        "type": "string",
        "required": true,
        "length": 64,
        "default": null
      }
    ]
  }
}
```

The Pact interaction locks the provider-side discovery call:

- `GET /api/v1/aml/metadata/Part`
- response body shape with `id`, `label`, `is_relationship`, and
  `properties[]`

## Verification

Command run:

```bash
pnpm exec vitest run \
  packages/core-backend/tests/contract/plm-adapter-yuantus.pact.test.ts \
  packages/core-backend/tests/unit/plm-adapter-yuantus.test.ts \
  packages/core-backend/tests/unit/federation.contract.test.ts \
  packages/openapi/dist-sdk/tests/client.test.ts \
  apps/web/tests/plmService.spec.ts
```

Result:

- `5` test files passed
- `74` tests passed
- duration `2.99s`

## Live Adapter Smoke

To avoid spending time on full Express auth/rbac bootstrap, the smoke run used
the real `PLMAdapter` against a seeded Yuantus provider started from the Pact
provider test harness. That still proves the non-mock HTTP path and the runtime
response parser for `getItemMetadata`.

Seeded provider launch:

```bash
PYTHONPATH=/tmp/yuantus-aml-metadata-sQmruU/src \
  /Users/huazhou/Downloads/Github/Yuantus/.venv/bin/python - <<'PY'
from yuantus.api.tests.test_pact_provider_yuantus_plm import _isolated_test_database, _running_provider
import signal

with _isolated_test_database():
    with _running_provider() as base_url:
        print(base_url, flush=True)
        signal.pause()
PY
```

Adapter smoke command:

```bash
PLM_BASE_URL=http://localhost:61373 \
PLM_API_MODE=yuantus \
PLM_TENANT_ID=tenant-1 \
PLM_ORG_ID=org-1 \
PLM_USERNAME=metasheet-svc \
PLM_PASSWORD=secret \
PLM_ITEM_TYPE=Part \
  pnpm exec tsx -e "import { PLMAdapter } from './packages/core-backend/src/data-adapters/PLMAdapter'; import { ConfigService } from './packages/core-backend/src/services/ConfigService'; import { Logger } from './packages/core-backend/src/core/logger'; (async () => { const adapter = new PLMAdapter(ConfigService.getInstance(), new Logger('aml-metadata-smoke')); await adapter.connect(); const result = await adapter.getItemMetadata('Part'); console.log(JSON.stringify({ ok: result.error == null, totalCount: result.metadata?.totalCount ?? null, first: result.data[0] ?? null }, null, 2)); })().catch((error) => { console.error(error); process.exit(1); });"
```

Smoke result:

- `ok: true`
- `totalCount: 1`
- returned `Part` metadata with 6 properties:
  `item_number`, `name`, `description`, `state`, `cost`, `weight`

## Known Limitations

- The pact artifact is still hand-authored; it is not yet generated by
  `@pact-foundation/pact`.
- The provider verification depends on seeded Yuantus metadata fixtures, so the
  response is stable for the contract test but still represents a narrow sample
  of the provider's schema space.
- Only the metadata read path is bridged here; there is no write/update schema
  management surface yet.

## Next Steps

- Expand the provider fixture coverage for additional item types once the next
  schema-discovery case is needed.
- Replace the hand-authored pact with generated consumer output when the Pact
  dependency is approved.
- Keep the federation and SDK shapes aligned if more metadata fields are added
  on the provider side.
