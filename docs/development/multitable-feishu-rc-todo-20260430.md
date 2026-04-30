# Multitable Feishu RC TODO - 2026-04-30

## Status

- Baseline: `origin/main@0e059ce99`
- Goal: Feishu-parity RC for staging and internal trial.
- Current phase: RC audit first, then P0 gaps.
- Rule: every completed item must be marked `[x]` and linked to PR, commit, development MD, and verification MD.
- Worktree rule: do RC work from clean worktrees based on `origin/main`; do not use the currently dirty root checkout.

## Completion Rules

For each completed item, update the checklist like this:

```md
- [x] Task title
  - PR: #xxxx
  - Merge commit: abc123
  - Development MD: docs/development/...
  - Verification MD: docs/development/...
  - Verification summary: focused tests + CI/staging status
```

Do not mark an item done if:

- Code is only local and not merged.
- Verification MD is missing.
- OpenAPI generated dist is stale.
- Staging-only steps are claimed without evidence.
- The item is blocked but has no `Blocked:` reason.

## Phase 0 - Worktree Hygiene

- [x] Create this master TODO MD and companion development/verification MDs.
  - PR: pending
  - Merge commit: pending
  - Development MD: `docs/development/multitable-feishu-rc-development-20260430.md`
  - Verification MD: `docs/development/multitable-feishu-rc-verification-20260430.md`
  - Verification summary: docs-only local validation pending PR CI.
- [ ] Confirm root worktree dirty state is unrelated to this RC stream.
- [ ] Create all RC work in clean `/tmp` or `.worktrees` branches from `origin/main`.
- [ ] Do not touch DingTalk/public-form dirty files unless the task explicitly requires it.

## Phase 1 - RC Audit + Staging Smoke

- [ ] Create RC audit checklist for current merged multitable capabilities.
- [ ] Create staging smoke checklist for manual tester.
- [ ] Verify staging deployment target version and document exact commit.
- [ ] Smoke test basic multitable sheet lifecycle: create base, sheet, view, fields, records.
- [ ] Smoke test xlsx frontend import/export with a real file.
- [ ] Smoke test field types: currency, percent, rating, url, email, phone, longText, multiSelect.
- [ ] Smoke test conditional formatting persistence and reload.
- [ ] Smoke test formula editor: field token insertion, function insertion, diagnostics.
- [ ] Smoke test filter builder typed controls and saved view behavior.
- [ ] Smoke test Gantt view rendering.
- [ ] Smoke test Hierarchy view rendering and child creation.
- [ ] Smoke test public form submit path.
- [ ] Smoke test automation send_email save/execute path.
- [ ] Produce RC audit result MD with P0/P1/P2 defects.

Expected docs:

- `docs/development/multitable-feishu-rc-audit-development-20260430.md`
- `docs/development/multitable-feishu-rc-audit-verification-20260430.md`

## Phase 2 - P0 Gap: Backend XLSX Route Layer

- [ ] Decide backend `xlsx` dependency policy.
- [ ] Add backend xlsx import adapter or optional dependency seam.
- [ ] Implement `POST /api/multitable/sheets/:sheetId/import-xlsx`.
- [ ] Implement `GET /api/multitable/sheets/:sheetId/export-xlsx`.
- [ ] Ensure import writes go through the authoritative record write path.
- [ ] Ensure export respects current sheet/view permissions.
- [ ] Add backend tests for import mapping, invalid file, permission denial, and export.
- [ ] Update OpenAPI source and generated dist.
- [ ] Mark frontend-only xlsx limitation as closed or explicitly narrowed.

Expected docs:

- `docs/development/multitable-xlsx-backend-routes-development-20260430.md`
- `docs/development/multitable-xlsx-backend-routes-verification-20260430.md`

## Phase 3 - P0 Gap: OpenAPI / Contract Cleanup

- [ ] Audit OpenAPI coverage for new field types.
- [ ] Audit OpenAPI coverage for new view types: `gantt`, `hierarchy`.
- [ ] Audit OpenAPI coverage for xlsx routes after Phase 2.
- [ ] Regenerate and commit OpenAPI dist artifacts.
- [ ] Run OpenAPI contract guard.
- [ ] Add a verification doc listing schema additions and generated outputs.

Expected docs:

- `docs/development/multitable-openapi-rc-contract-cleanup-development-20260430.md`
- `docs/development/multitable-openapi-rc-contract-cleanup-verification-20260430.md`

## Phase 4 - P0/P1 Gap: System Fields Batch

- [ ] Add `autoNumber` field type.
- [ ] Add `createdTime` field type mapped to record `created_at`.
- [ ] Add `modifiedTime` field type mapped to record `updated_at`.
- [ ] Add `createdBy` field type mapped to record `created_by`.
- [ ] Add `modifiedBy` storage if missing, then expose `modifiedBy`.
- [ ] Make all system fields readonly from normal patch/create payloads.
- [ ] Add frontend renderer/editor behavior: render-only for readonly system fields.
- [ ] Add field manager support for creating/configuring allowed system fields.
- [ ] Add tests for create, patch rejection, render, sorting/filtering where applicable.
- [ ] Update OpenAPI source and generated dist.

Expected docs:

- `docs/development/multitable-system-fields-batch-development-20260501.md`
- `docs/development/multitable-system-fields-batch-verification-20260501.md`

## Phase 5 - P1 Gap: Record Version History

- [ ] Add record revision persistence table.
- [ ] Record revision after successful authoritative writes.
- [ ] Capture actor, source, version, changed fields, and timestamp.
- [ ] Add API to list record history.
- [ ] Add record drawer History tab.
- [ ] Add tests for single-field patch, multi-field patch, actor attribution, and permission denial.
- [ ] Document retention default: no cleanup in v1.

Expected docs:

- `docs/development/multitable-record-history-development-20260502.md`
- `docs/development/multitable-record-history-verification-20260502.md`

## Phase 6 - P1 Gap: Record Subscription Notifications

- [ ] Add record subscription table or reuse existing notification model if already sufficient.
- [ ] Add subscribe/unsubscribe/list APIs.
- [ ] Add record drawer watch/unwatch control.
- [ ] Notify watchers on record update and comment events.
- [ ] Do not notify the actor for their own write by default.
- [ ] Add tests for subscribe, unsubscribe, update notification, comment notification, and self-notification suppression.

Expected docs:

- `docs/development/multitable-record-subscription-development-20260503.md`
- `docs/development/multitable-record-subscription-verification-20260503.md`

## Phase 7 - Optional Deep Parity Backlog

These are not RC blockers.

- [ ] Gantt dependencies and dependency arrows.
- [ ] Gantt drag resize.
- [ ] Hierarchy drag-to-reparent.
- [ ] Hierarchy server-side cycle prevention.
- [ ] DateTime field with timezone.
- [ ] Number format: decimals, thousands, unit.
- [ ] Template library V1.
- [ ] Native person field migration.
- [ ] Barcode field.
- [ ] Location field.

## Global Verification Commands

Run the relevant subset per PR:

```bash
git diff --check
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
pnpm --filter @metasheet/core-backend exec vitest run <focused backend tests> --reporter=dot
pnpm --filter @metasheet/web exec vitest run <focused frontend tests> --watch=false --reporter=dot
./scripts/ops/attendance-run-gate-contract-case.sh openapi
```

## Merge Discipline

- Merge order for initial docs: TODO docs first.
- Merge order for P0 gaps: xlsx backend -> contract cleanup -> system fields.
- After every merge, rebase the next branch onto latest `origin/main`.
- Do not mark TODO complete until the branch is merged or explicitly accepted as docs-only/local-only.
