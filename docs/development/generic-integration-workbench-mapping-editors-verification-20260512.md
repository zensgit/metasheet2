# Generic Integration Workbench Mapping Editors Verification - 2026-05-12

## Scope

Verification for Workbench M7 mapping editors:

- Whitelisted transform selector.
- `dictMap` dictionary editor.
- Required/min/max validation rule editor.
- Payload preview and pipeline payload shape after mapping-editor changes.

## Results

| Command | Result | Notes |
| --- | --- | --- |
| `pnpm --filter @metasheet/web exec vitest run tests/IntegrationWorkbenchView.spec.ts tests/integrationWorkbench.spec.ts --watch=false` | PASS | 2 files / 3 tests passed. Vitest emitted the existing `--localstorage-file` warning. |
| `pnpm --filter @metasheet/web exec vitest run tests/k3WiseSetup.spec.ts tests/IntegrationK3WiseSetupView.spec.ts --watch=false` | PASS | 2 files / 31 tests passed, covering the adjacent K3 preset convergence changes. |
| `pnpm --filter @metasheet/web exec vue-tsc --noEmit` | PASS | Frontend type check passed. |
| `pnpm --filter @metasheet/web build` | PASS | Frontend production build passed. Existing Vite dynamic-import and chunk-size warnings remained. |
| `pnpm -F plugin-integration-core test` | PASS | Backend integration-core regression passed. |
| `pnpm verify:integration-k3wise:poc` | PASS | K3 WISE offline PoC preflight, evidence, and mock chain passed. |
| `git diff --check` | PASS | No whitespace errors. |

## Contract Assertions

- The first seeded string mapping defaults to `trim`.
- Number mappings default to `toNumber`.
- Changing a row to `upper` sends `{ fn: "upper" }`.
- Changing a row to `dictMap` sends `{ fn: "dictMap", map: { ... } }`.
- Required mappings send `{ type: "required" }`.
- Min rules send numeric `{ type: "min", value: ... }`.
- Existing pipeline save and run controls still work after mapping editor changes.

## Notes

- The browser-dev-server visual pass was not run in this shell because no local dev server is active; the component-level Vitest and production build gates covered the UI contract and type/build integrity.
- The editor still intentionally excludes user JavaScript transforms.
