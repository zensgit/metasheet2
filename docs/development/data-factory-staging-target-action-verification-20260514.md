# Data Factory staging target action - verification - 2026-05-14

## Scope

This verification covers the Data Factory workbench UI action that turns an
installed staging multitable into a `metasheet:multitable` target system.

It does not validate arbitrary user-owned table permissions or live K3 writes.

## Checks

### Frontend workbench test

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/IntegrationWorkbenchView.spec.ts --watch=false
```

Expected coverage:

- adapter inventory includes `metasheet:multitable`;
- installed staging cards render `作为写入目标`;
- clicking the action posts a `metasheet:multitable` external system;
- generated target config includes `sheetId`, `viewId`, `openLink`, fields,
  inferred key fields, and write mode;
- the target select and target object select switch to the generated MetaSheet
  target system;
- existing K3 target object loading still works after switching back.

Result: PASS.

### Frontend integration service test

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/integrationWorkbench.spec.ts --watch=false
```

Expected coverage:

- `upsertWorkbenchExternalSystem()` still posts through the existing
  `/api/integration/external-systems` endpoint;
- staging source service behavior remains unchanged.

Result: PASS.

### Frontend build

Command:

```bash
pnpm --filter @metasheet/web build
```

Expected coverage:

- Vue template and TypeScript checks compile;
- the Data Factory workbench bundle is emitted successfully.

Result: PASS.

Observed note: Vite reported the existing large-chunk warning. The build exited
`0`.

### Backend plugin regression

Command:

```bash
pnpm -F plugin-integration-core test
```

Expected coverage:

- `metasheet:staging` remains registered as source-only;
- `metasheet:multitable` remains registered as target-only;
- adapter metadata and runtime smoke still assert both adapter kinds.

Result: PASS.

### K3 offline PoC regression

Command:

```bash
pnpm verify:integration-k3wise:poc
```

Expected coverage:

- K3 WISE Material/BOM mock chain remains PASS;
- the MetaSheet target UI action does not change K3 WebAPI behavior.

Result: PASS.

### Diff hygiene

Command:

```bash
git diff --check origin/main...HEAD
```

Result: PASS.

## Manual review checklist

- No migration added.
- No secret values added.
- K3 WISE remains a preset, not the whole product surface.
- SQL channel remains an advanced connector.
- Save-only remains explicit and Submit / Audit remains opt-in.
