# Data Factory multitable UI entry - verification - 2026-05-14

## Scope

This verification covers the Data Factory workbench UI entry for local
MetaSheet multitable source/target flows.

Validated behavior:

- adapter inventory renders `metasheet:multitable`;
- installed staging cards expose a target registration action;
- target registration writes an external system using `kind:
  metasheet:multitable` and `role: target`;
- generated object config includes sheet/view/open-link metadata, field
  projection, key fields, and write mode;
- target selector and target object selector are updated after registration.

## Commands

### Frontend targeted spec

Command:

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/IntegrationWorkbenchView.spec.ts --watch=false
```

Expected:

- the existing Data Factory workbench flow remains green;
- the new target action creates `metasheet_target_<projectId>`;
- the target object defaults to the selected staging descriptor;
- the external-system payload keeps `metasheet:staging` and
  `metasheet:multitable` as separate source and target systems.

Result: PASS.

Observed output:

```text
✓ tests/IntegrationWorkbenchView.spec.ts  (3 tests) 201ms
Test Files  1 passed (1)
Tests  3 passed (3)
```

Environment note: Vitest printed `WebSocket server error: Port is already in
use`, but the targeted suite completed with `rc=0`.

### Service targeted spec

Command:

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/integrationWorkbench.spec.ts --watch=false
```

Expected:

- service URL construction and external-system upsert behavior remain stable;
- the added optional object `target` field is type-level only and does not
  change existing request paths.

Result: PASS.

Observed output:

```text
✓ tests/integrationWorkbench.spec.ts  (2 tests) 5ms
Test Files  1 passed (1)
Tests  2 passed (2)
```

### Plugin metadata and adapter contract checks

Commands:

```bash
pnpm -F plugin-integration-core test:http-routes
pnpm -F plugin-integration-core test:metasheet-staging-source
pnpm -F plugin-integration-core test:metasheet-multitable-target
```

Expected:

- `/api/integration/adapters` still exposes both `metasheet:staging` and
  `metasheet:multitable`;
- staging remains read-only;
- multitable target remains write-only and supports append/upsert.

Result: PASS.

Observed output:

```text
http-routes: REST auth/list/upsert/run/dry-run/staging/replay tests passed
✓ metasheet-staging-source-adapter: read-only multitable source tests passed
✓ metasheet-multitable-target-adapter: write-only multitable target tests passed
```

### Type check

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Expected:

- `IntegrationSystemObject.target` is accepted by Vue workbench code;
- no regressions in existing web type surfaces.

Result: PASS.

Observed output:

```text
> @metasheet/web@2.0.0-alpha.1 type-check apps/web
> vue-tsc -b
```

### Frontend production build

Command:

```bash
pnpm --filter @metasheet/web build
```

Expected:

- Vue type check and Vite production build complete;
- Data Factory workbench bundle compiles with the new target action.

Result: PASS.

Observed output:

```text
> vue-tsc -b && vite build
✓ 2389 modules transformed.
✓ built in 6.53s
```

Environment note: Vite reported existing large chunk and dynamic/static import
warnings. The build completed with `rc=0`.

### K3 WISE mock PoC regression

Command:

```bash
pnpm verify:integration-k3wise:poc
```

Expected:

- Save-only K3 mock chain remains PASS;
- adding a local multitable target UI entry does not change K3 preset safety.

Result: PASS.

Observed output:

```text
✓ step 6: K3 Save-only upsert wrote 2 records, 0 Submit, 0 Audit (PoC safety preserved)
✓ step 8-9: evidence compiler returned PASS with 0 issues
✓ K3 WISE PoC mock chain verified end-to-end (PASS)
```

### Diff hygiene

Command:

```bash
git diff --check
```

Expected: PASS.

Result: PASS.

## Manual checklist

- `metasheet:staging` remains source-only in the UI flow.
- `metasheet:multitable` is used only as a target connection.
- The UI still tells operators to dry-run before save-only push.
- The new target action does not expose SQL advanced connectors by default.
- No secrets, tokens, or live credentials are added to docs or tests.
