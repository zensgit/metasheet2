# Data Factory issue #1526 UX follow-ups verification - 2026-05-18

## Verification targets

This PR verifies three frontend-only behaviors:

1. `material` target no longer silently proceeds with `bom_cleanse` as the MetaSheet staging source.
2. K3 preset pipeline creation guidance explicitly points staging-first operators to Data Factory when PLM source system ID is absent.
3. SQL executor-missing diagnostics show a concise operator summary, with raw JSON collapsed behind an expandable diagnostic block.

## Automated coverage

### Workbench pairing guard

`apps/web/tests/IntegrationWorkbenchView.spec.ts` now exercises:

- staging install creates `standard_materials` and `bom_cleanse` open targets;
- the operator can intentionally select `bom_cleanse` as source while target is `material`;
- the page renders `source-target-mismatch-notice`;
- save is blocked and readiness includes `确认来源与目标匹配`;
- one-click normalization switches the source back to `standard_materials`;
- the normal material preview/save/dry-run path still uses `standard_materials -> material`.

### K3 preset guidance

`apps/web/tests/k3WiseSetup.spec.ts` now verifies:

- missing `sourceSystemId` still blocks K3 preset pipeline creation;
- the validation message explains that staging-first flows should use Data Factory with MetaSheet staging source;
- the deploy-gate `plm-source` message references MetaSheet staging fallback.

`apps/web/tests/IntegrationK3WiseSetupView.spec.ts` also verifies the visible PLM source fallback hint in the setup page.

### SQL diagnostic summary

`apps/web/tests/IntegrationK3WiseSetupView.spec.ts` now feeds a long synthetic `SQLSERVER_EXECUTOR_MISSING` response through the SQL test UI and verifies:

- the operator summary contains the normalized missing-executor wording;
- the huge diagnostic body is not copied into the summary;
- the raw JSON remains available in a collapsed diagnostic details block.

## Commands to run

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/IntegrationWorkbenchView.spec.ts \
  tests/IntegrationK3WiseSetupView.spec.ts \
  tests/k3WiseSetup.spec.ts \
  --watch=false

pnpm --filter @metasheet/web exec vue-tsc --noEmit

pnpm --filter @metasheet/web build

git diff --check origin/main...HEAD
```

## Local result

Run from branch `codex/data-factory-ux-followups-20260518`:

| Command | Result |
| --- | --- |
| `pnpm --filter @metasheet/web exec vitest run tests/IntegrationWorkbenchView.spec.ts tests/IntegrationK3WiseSetupView.spec.ts tests/k3WiseSetup.spec.ts --watch=false` | PASS, 53/53 tests |
| `pnpm --filter @metasheet/web exec vue-tsc --noEmit` | PASS |
| `pnpm --filter @metasheet/web build` | PASS; Vite emitted existing chunk-size warnings only |
| `git diff --check origin/main...HEAD` | PASS |

## Manual bridge retest expectation

After packaging and redeploying the resulting main commit:

- Gate A/B should remain PASS.
- C2/C4 should remain PASS.
- Workbench material dry-run should guide to `standard_materials -> material`.
- If an operator selects `bom_cleanse -> material`, the page should block save and show the mismatch warning instead of allowing a misleading zero-record dry-run.
- K3 preset page should explain that missing PLM source system ID is a PLM-first limitation and that existing staging tables should be used from Data Factory.
- SQL Server test may still fail with `SQLSERVER_EXECUTOR_MISSING`; that is expected until executor injection is implemented, but the UI should show a concise summary by default.

## Stage 1 Lock check

Touched areas:

- `apps/web/src/views/IntegrationWorkbenchView.vue`
- `apps/web/src/views/IntegrationK3WiseSetupView.vue`
- `apps/web/src/services/integration/k3WiseSetup.ts`
- frontend tests
- docs

Untouched areas:

- `plugins/plugin-integration-core`
- backend migrations
- backend routes/API runtime
- SQL executor runtime
- K3 WebAPI read/list runtime
- relationship resolver runtime
