# Multitable RC Lifecycle Smoke · Development

> Date: 2026-05-07
> Branch: `codex/multitable-rc-smoke-lifecycle-20260507`
> Base: `origin/main@d291bc4d1` (after #1414 dead-letter docs merge)
> Closes RC TODO line 80: `Smoke test basic multitable sheet lifecycle: create base, sheet, view, fields, records.`

## Background

The RC TODO (`docs/development/multitable-feishu-rc-todo-20260430.md`) carried 6 unchecked manual smoke-test items as of `8c2dc9f79` (Gantt self-table dependency merge). All six are end-to-end verification tasks against a deployed environment. The lifecycle smoke is the first of the six and is the easiest to convert into a repeatable, server-agnostic Playwright spec because it only exercises the multitable REST surface plus a workbench DOM assertion — no PLM federation, formula editor, public-form share token, or automation send_email plumbing required.

## Scope

### In

- New Playwright spec `packages/core-backend/tests/e2e/multitable-lifecycle-smoke.spec.ts` containing two `test.describe` cases:
  1. **Lifecycle**: `POST /api/multitable/bases` → `POST /api/multitable/sheets` → `POST /api/multitable/fields` (string field `Title`) → `GET /api/multitable/views?sheetId=…` (reuse seeded grid view, fall back to `POST /api/multitable/views` if absent) → `POST /api/multitable/records` with `{[fieldId]: 'smoke-record-<ts>'}`. Final assertion: navigate browser to `/multitable/{sheetId}/{viewId}` with `phase0@test.local` token injected to localStorage and assert the cell value renders.
  2. **autoNumber raw-write regression guard**: create an `autoNumber` field, attempt `POST /api/multitable/records` with `data: {[fieldId]: 999}`. Expect `403 FIELD_READONLY`. Demonstrates that the smoke also covers the `RecordFieldForbiddenError` path landed in PR #1406 hardening.
- README update at `packages/core-backend/tests/e2e/README.md` listing the new spec under "What's tested".
- RC TODO update marking the lifecycle smoke as covered by PR #1415 while preserving the live-stack execution caveat.

### Out

- The other 5 smoke items (formula editor, Gantt rendering, Hierarchy rendering, public form submit, automation send_email). Each can fork this spec's pattern in a follow-up PR.
- Playwright auto-start of dev servers. The existing `playwright.config.ts` is intentionally minimal and skips suite when servers are unreachable; this PR keeps that contract.
- Frontend dev-server wait/health-check beyond `await page.goto`. The 15-second `toContainText` timeout absorbs Vite cold-start drift.
- Test data cleanup. Following the pattern in `handoff-journey.spec.ts`, this smoke leaves the created base/sheet/field/record in place. They are timestamp-suffixed so reruns do not collide.

## K3 PoC Stage 1 Lock applicability

- Does NOT modify `plugins/plugin-integration-core/*`.
- Adds a test harness for already-shipped multitable surface — no new platform capability.
- Touches no DingTalk / public-form / runtime / migration code.
- The autoNumber regression guard merely calls existing endpoints; no schema change.

## Implementation notes

### Why the test uses `request` for setup and `page` only for the final assertion

API-only setup is faster, more deterministic, and avoids brittleness against UI changes (the workbench's "+ create base" button text, drawer layout, and form selectors evolve across phases; the REST surface is openapi-frozen). The single browser assertion at the end is sufficient to catch the class of regressions where the backend persists a record but the frontend cannot render it (e.g. permission derivation drift, view config corruption, race in realtime patch publishing).

### Why bother with the autoNumber regression guard

Adding the regression test adds ~25 lines and exercises `RecordService.createRecord`'s `RecordFieldForbiddenError` path through a real HTTP boundary. This complements the existing unit test at `packages/core-backend/tests/unit/record-service.test.ts:243` which mocks the pool. Two layers of coverage for the same invariant is justified given the autoNumber feature's hardening history (PR #1406 + #1412).

### `view` reuse vs `view` create

`POST /api/multitable/sheets` may seed an initial grid view (depends on the `seed` flag default and downstream service behavior). The spec defensively `GET`s views first and only creates one explicitly if no grid view is found. This makes the test robust to seed-default flips.

## Files changed

| File | Lines |
|---|---|
| `packages/core-backend/tests/e2e/multitable-lifecycle-smoke.spec.ts` | +new |
| `packages/core-backend/tests/e2e/README.md` | +1 |
| `docs/development/multitable-feishu-rc-todo-20260430.md` | lifecycle smoke marked complete |
| `docs/development/multitable-rc-lifecycle-smoke-development-20260507.md` | +new |
| `docs/development/multitable-rc-lifecycle-smoke-verification-20260507.md` | +new |

## Known limitations

1. **Server bootstrap is manual**: tests skip if `:7778` or `:8899` is not reachable. CI does not currently spin up a multitable dev stack for Playwright. Skipped result counts as `passed` in default Playwright reporters; running this in CI requires either dev-stack provisioning or pinning an `expect-skipped: false` gate. Out of scope for this PR.
2. **No multi-user / permission scenario**: the smoke runs as `phase0@test.local` (admin). RC items relating to permission boundaries belong to a separate spec.
3. **Race on parallel runs**: timestamp-suffixed names prevent collision but the same `phase0@test.local` user is used; if the suite is run in parallel against the same backend, base/sheet creation rate-limits could fire. Acceptable for nightly smoke.

## Cross-references

- RC TODO master: `docs/development/multitable-feishu-rc-todo-20260430.md` (line 80, "Smoke test basic multitable sheet lifecycle")
- E2E config: `packages/core-backend/tests/e2e/playwright.config.ts`
- Existing pattern: `packages/core-backend/tests/e2e/handoff-journey.spec.ts`
- Recent autoNumber merges: PR #1406 + #1412 (`8c2dc9f79`)
