# Generic Integration Workbench SQL Guardrails Verification - 2026-05-12

## Scope

Verification for M3 SQL advanced-channel closeout:

- Adapter discovery exposes SQL read/write/UI guardrails.
- Unknown adapters do not inherit SQL guardrails.
- Existing K3 WISE SQL adapter runtime guard tests remain green.
- Workbench frontend still hides SQL connectors from normal UI by default.

## Results

| Command | Result | Notes |
| --- | --- | --- |
| `node plugins/plugin-integration-core/__tests__/http-routes.test.cjs` | PASS | Direct metadata contract suite passed. |
| `node plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs` | PASS | Runtime SQL allowlist and middle-table guard regression passed. |
| `pnpm -F plugin-integration-core test` | PASS | Full plugin package regression passed. |
| `pnpm --filter @metasheet/web exec vitest run tests/IntegrationWorkbenchView.spec.ts tests/integrationWorkbench.spec.ts --watch=false` | PASS | 2 files / 3 tests passed. Vitest emitted the existing `--localstorage-file` warning. |
| `pnpm --filter @metasheet/web exec vue-tsc --noEmit` | PASS | Frontend type check passed after adapter metadata type expansion. |
| `pnpm --filter @metasheet/web build` | PASS | Frontend production build passed. Existing Vite dynamic-import and chunk-size warnings remained. |
| `git diff --check` | PASS | No whitespace errors. |

## Contract Assertions

- `erp:k3-wise-sqlserver` remains `advanced: true`.
- SQL metadata advertises read table allowlist requirements.
- SQL metadata advertises middle-table write mode requirements.
- SQL metadata advertises normal UI direct core-table writes as disabled.
- Unknown adapter metadata does not include SQL guardrails.
- Existing K3 SQL adapter tests still reject disallowed reads, read-only writes, write-only reads, and direct table writes.

## Notes

- Runtime SQL guard enforcement was already implemented in `k3-wise-sqlserver-channel.cjs`; this slice made the safety contract discoverable through adapter metadata.
- The generic Workbench still keeps SQL adapters hidden until the advanced connector toggle is enabled.
