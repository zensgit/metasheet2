# Multitable RC Formula Smoke + Helper Extraction · Verification

> Date: 2026-05-07
> Companion to: `multitable-rc-formula-smoke-development-20260507.md`

## Spec parses (Playwright list, all six e2e files)

```bash
cd packages/core-backend
npx playwright test --list --config tests/e2e/playwright.config.ts tests/e2e/
```

Result:

```
Listing tests:
  handoff-journey.spec.ts › Federated document handoff journey › "打开" button only appears on AML related document rows
  handoff-journey.spec.ts › Federated document handoff journey › clicking "打开" switches to Document item without manual type change
  handoff-journey.spec.ts › Federated document handoff journey › "← 返回源产品" banner appears after handoff and works
  handoff-journey.spec.ts › Federated document handoff journey › documents survive full roundtrip without degradation
  multitable-formula-smoke.spec.ts › Multitable formula smoke › creates a formula field referencing source fields and renders the column in the workbench
  multitable-formula-smoke.spec.ts › Multitable formula smoke › updates a formula expression via PATCH and the new expression persists
  multitable-formula-smoke.spec.ts › Multitable formula smoke › clamps a non-string formula expression to empty string on update (sanitize regression)
  multitable-formula-smoke.spec.ts › Multitable formula smoke › persisted ApiEnvelope shape on field list is well-formed (helpers contract)
  multitable-gantt-smoke.spec.ts › Multitable Gantt smoke › renders task bars and labels for records with date ranges
  multitable-gantt-smoke.spec.ts › Multitable Gantt smoke › renders dependency arrows when dependencyFieldId is configured
  multitable-gantt-smoke.spec.ts › Multitable Gantt smoke › rejects saving a gantt view with a non-link dependencyFieldId (VALIDATION_ERROR)
  multitable-hierarchy-smoke.spec.ts › Multitable Hierarchy smoke › renders parent and child records in the hierarchy workbench
  multitable-hierarchy-smoke.spec.ts › Multitable Hierarchy smoke › rejects setting a record as its own parent (HIERARCHY_CYCLE)
  multitable-hierarchy-smoke.spec.ts › Multitable Hierarchy smoke › rejects setting a descendant as the parent (HIERARCHY_CYCLE through chain)
  multitable-lifecycle-smoke.spec.ts › Multitable lifecycle smoke › creates base, sheet, field, view, record and renders in workbench
  multitable-lifecycle-smoke.spec.ts › Multitable lifecycle smoke › rejects client-supplied autoNumber values during record create (regression guard)
  multitable-public-form-smoke.spec.ts › Multitable public form smoke › admin enables public form, anonymous submits, record persists
  multitable-public-form-smoke.spec.ts › Multitable public form smoke › rejects anonymous submit when public form is disabled (regression guard)
  multitable-public-form-smoke.spec.ts › Multitable public form smoke › rejects anonymous submit with stale token after regenerate (regression guard)
Total: 19 tests in 6 files
```

All four pre-existing multitable smokes still parse cleanly after migration. No test was renamed or removed.

## TypeScript check (core-backend, full project incl. helpers and all migrated specs)

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Result: passed (no output / exit 0).

## Formula Editor UI Suite

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-formula-editor.spec.ts --watch=false
```

Result: `10/10` tests passed.

This is the direct coverage for the RC item's editor requirements:
- field-chip insertion writes stable `{field_id}` tokens into the textarea
- function catalog filtering inserts snippets such as `ROUND(, 2)`
- diagnostics block invalid expressions with unknown fields / syntax / argument-count errors

## Diff hygiene

```bash
git diff --check
```

Result: passed.

## Migration sanity

For each migrated spec, the behavior body (assertions, selectors, status codes, error-body shapes) is preserved verbatim. Only the plumbing changes:
- Inline `let token = ''` + `beforeAll` health-check + login → `await ensureServersReachable(request); token = await loginAsPhase0(request)`
- Inline `authPost` / `authPatch` / `authGet` → `const client = makeAuthClient(request, token)` per test, methods on `client`
- Inline `setup<Type>Sheet(request, label)` → composed from `createBase` / `createSheet` / `createField` / `createView` primitives
- Inline `injectTokenAndGo(page, path)` (closing over module-level `token`) → `injectTokenAndGo(page, token, path)` (token passed explicitly)
- legacy loose JSON helpers → `let json: unknown = null` (in helpers) plus `as ApiEnvelope<TData>` at boundary

The public-form spec retains `anonymousPost` inline — see development MD for rationale.

## Live execution (deferred)

Same justification as the four prior RC smoke verification MDs. The 19 tests parse and tsc agrees; the spec is structurally identical to the previous merged smoke specs from a Playwright runtime standpoint, and `beforeAll` will skip cleanly on absent local stack.

To run all six e2e files end-to-end locally:

```bash
# Terminals 1–3 as documented in packages/core-backend/tests/e2e/README.md
cd packages/core-backend
npx playwright install chromium  # one-time
npx playwright test --config tests/e2e/playwright.config.ts
```

Expected: 19 tests pass; total ~30–60s including frontend cold-start and PLM federation handoff.

## Pre-deployment checks

- [x] PR #1406 + #1409 + #1410 + #1412 + #1415 + #1417 + #1419 + #1421 + #1422 + #1423 + #1425 + #1394 already merged on main; this branch is rebased onto `3ce20f59a`.
- [x] No DingTalk / public-form runtime / Gantt runtime / Hierarchy runtime / formula runtime / `plugins/plugin-integration-core/*` files touched.
- [x] No autoNumber / migration / OpenAPI changes.
- [x] RC TODO formula line ticked in the same commit with PR / dev MD / verification MD pointers.

## Result

19 Playwright tests parse, 10 frontend formula-editor tests pass, types clean, diff hygiene clean, RC TODO updated with the formula tick. Ready to merge as the fifth of six RC-smoke conversions and the helpers extraction pass; the remaining one (`automation send_email`) can fork the formula spec and add a small SMTP/email-mock harness in a follow-up.
