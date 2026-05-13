# Generic Integration Workbench Template Preview Verification - 2026-05-12

## Files Changed

- `plugins/plugin-integration-core/lib/http-routes.cjs`
- `plugins/plugin-integration-core/__tests__/http-routes.test.cjs`
- `docs/development/generic-integration-workbench-todo-20260512.md`
- `docs/development/generic-integration-workbench-template-preview-design-20260512.md`
- `docs/development/generic-integration-workbench-template-preview-verification-20260512.md`

## Verification Matrix

| Case | Expected | Evidence |
| --- | --- | --- |
| Route registration | `POST /api/integration/templates/preview` registered | `testTemplatePreviewRoute()` |
| K3 Material-style preview | Returns `{ Data: { FNumber, FName, FBaseUnitID, FQty } }` | `testTemplatePreviewRoute()` |
| Transform reuse | `trim`, `upper`, `dictMap`, and `toNumber` applied | `testTemplatePreviewRoute()` |
| Validator reuse | Field-mapping `required` and `min` rules evaluated | `testTemplatePreviewRoute()` |
| Template required fields | Missing schema-required fields return errors | `testTemplatePreviewRoute()` |
| Unsupported transform | Returns structured transform error without throwing 500 | `testTemplatePreviewRoute()` |
| Unsafe body key | `__proto__` rejected with `400 INVALID_TEMPLATE_PREVIEW` | `testTemplatePreviewRoute()` |
| Permission boundary | read-only integration user gets `403` | `testTemplatePreviewRoute()` |
| No service calls | Preview does not call registries, runner, or adapters | `testTemplatePreviewRoute()` |
| Secret redaction | Unmapped source password does not appear in response | `testTemplatePreviewRoute()` |

## Commands

Executed in `/Users/chouhua/Downloads/Github/metasheet2`:

```bash
node plugins/plugin-integration-core/__tests__/http-routes.test.cjs
pnpm -F plugin-integration-core test
git diff --check
```

## Result

PASS.

| Command | Result |
| --- | --- |
| `node plugins/plugin-integration-core/__tests__/http-routes.test.cjs` | PASS - route suite passed, including template preview coverage |
| `node plugins/plugin-integration-core/__tests__/pipelines.test.cjs` | PASS - pipeline registry suite still passes |
| `pnpm -F plugin-integration-core test` | PASS - all plugin-integration-core test files passed |
| `git diff --check` | PASS - no whitespace errors or conflict markers |

The full plugin test run covered runtime smoke, host loader activation, credential store, DB guard, external systems, adapter contracts, HTTP adapter, PLM wrapper, pipelines, transform/validator, runner support, payload redaction, pipeline runner, REST routes, PLM-to-K3 mock chain, K3 WISE adapters, ERP feedback, E2E writeback, staging installer, and migration SQL shape.
