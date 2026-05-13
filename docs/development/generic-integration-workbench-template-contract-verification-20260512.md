# Generic Integration Workbench Template Contract Verification - 2026-05-12

## Verification Matrix

| Check | Result | Notes |
| --- | --- | --- |
| `node plugins/plugin-integration-core/__tests__/http-routes.test.cjs` | PASS | Discovery and template route coverage |
| `pnpm -F plugin-integration-core test` | PASS | Full plugin integration-core chain |
| `pnpm --filter @metasheet/web exec vitest run tests/IntegrationWorkbenchView.spec.ts tests/integrationWorkbench.spec.ts --watch=false` | PASS | 3/3 tests |
| `pnpm --filter @metasheet/web exec vue-tsc --noEmit` | PASS | Clean |
| `pnpm --filter @metasheet/web build` | PASS | `vue-tsc -b` plus Vite build |
| `git diff --check` | PASS | Clean |

## Coverage Added

- Custom supplier template discovery asserts stable `id`, `label`, `object`, operations, `template.id`, `template.bodyKey`, and `template.endpointPath`.
- Missing `config.documentTemplates[0].id` rejects with `INVALID_DOCUMENT_TEMPLATE`.
- Missing `config.documentTemplates[0].label` rejects with `INVALID_DOCUMENT_TEMPLATE`.
- Missing `config.documentTemplates[0].object` rejects with `INVALID_DOCUMENT_TEMPLATE`, even if legacy `targetObject` is present.

## Not Covered

- Live external-system configs. This remains mocked route coverage.
- Template authoring UI.

## Warnings Observed

- Frontend Vitest emitted the existing `--localstorage-file was provided without a valid path` warning.
- Vite build emitted existing dynamic/static import and chunk-size warnings.
