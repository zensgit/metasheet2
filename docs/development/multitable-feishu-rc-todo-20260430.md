# Multitable Feishu RC TODO - 2026-04-30

## Status

- Baseline: `origin/main@08f4ff920`
- Latest RC worktree base used by Phase 3: `origin/main@751cb8439` after clean rebase.
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
  - PR: #1270
  - Merge commit: `08f4ff920`
  - Development MD: `docs/development/multitable-feishu-rc-development-20260430.md`
  - Verification MD: `docs/development/multitable-feishu-rc-verification-20260430.md`
  - Verification summary: docs-only PR CI passed and merged.
- [x] Confirm root worktree dirty state is unrelated to this RC stream.
  - PR: pending
  - Merge commit: pending
  - Development MD: `docs/development/multitable-feishu-rc-audit-development-20260430.md`
  - Verification MD: `docs/development/multitable-feishu-rc-audit-verification-20260430.md`
  - Verification summary: root status reviewed; dirty files are public-form/DingTalk/docs paths outside this RC audit worktree.
- [x] Create all RC work in clean `/tmp` or `.worktrees` branches from `origin/main`.
  - PR: pending
  - Merge commit: pending
  - Development MD: `docs/development/multitable-feishu-rc-audit-development-20260430.md`
  - Verification MD: `docs/development/multitable-feishu-rc-audit-verification-20260430.md`
  - Verification summary: Phase 1 worktree created at `/tmp/ms2-feishu-rc-audit-20260430` from `origin/main@08f4ff920`.
- [x] Do not touch DingTalk/public-form dirty files unless the task explicitly requires it.
  - PR: pending
  - Merge commit: pending
  - Development MD: `docs/development/multitable-feishu-rc-audit-development-20260430.md`
  - Verification MD: `docs/development/multitable-feishu-rc-audit-verification-20260430.md`
  - Verification summary: Phase 1 changes are docs-only under `docs/development`.

## Phase 1 - RC Audit + Staging Smoke

- [x] Create RC audit checklist for current merged multitable capabilities.
  - PR: pending
  - Merge commit: pending
  - Development MD: `docs/development/multitable-feishu-rc-audit-development-20260430.md`
  - Verification MD: `docs/development/multitable-feishu-rc-audit-verification-20260430.md`
  - Verification summary: checklist added at `docs/development/multitable-feishu-rc-audit-checklist-20260430.md`.
- [x] Create staging smoke checklist for manual tester.
  - PR: pending
  - Merge commit: pending
  - Development MD: `docs/development/multitable-feishu-rc-audit-development-20260430.md`
  - Verification MD: `docs/development/multitable-feishu-rc-audit-verification-20260430.md`
  - Verification summary: checklist added at `docs/development/multitable-feishu-staging-smoke-checklist-20260430.md`.
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
- [x] Produce RC audit result MD with P0/P1/P2 defects.
  - PR: pending
  - Merge commit: pending
  - Development MD: `docs/development/multitable-feishu-rc-audit-development-20260430.md`
  - Verification MD: `docs/development/multitable-feishu-rc-audit-verification-20260430.md`
  - Verification summary: result added at `docs/development/multitable-feishu-rc-audit-result-20260430.md`; staging-only smoke items remain unchecked.

Expected docs:

- `docs/development/multitable-feishu-rc-audit-development-20260430.md`
- `docs/development/multitable-feishu-rc-audit-verification-20260430.md`

## Phase 2 - P0 Gap: Backend XLSX Route Layer

- [x] Decide backend `xlsx` dependency policy.
  - PR: #1275
  - Merge commit: `5c4130913`
  - Development MD: `docs/development/multitable-xlsx-backend-routes-development-20260430.md`
  - Verification MD: `docs/development/multitable-xlsx-backend-routes-verification-20260430.md`
  - Verification summary: `xlsx` added as explicit `@metasheet/core-backend` runtime dependency; lockfile updated.
- [x] Add backend xlsx import adapter or optional dependency seam.
  - PR: #1275
  - Merge commit: `5c4130913`
  - Development MD: `docs/development/multitable-xlsx-backend-routes-development-20260430.md`
  - Verification MD: `docs/development/multitable-xlsx-backend-routes-verification-20260430.md`
  - Verification summary: `xlsx-service.ts` added with parse/build/map helpers; 5 focused unit tests pass.
- [x] Implement `POST /api/multitable/sheets/:sheetId/import-xlsx`.
  - PR: #1275
  - Merge commit: `5c4130913`
  - Development MD: `docs/development/multitable-xlsx-backend-routes-development-20260430.md`
  - Verification MD: `docs/development/multitable-xlsx-backend-routes-verification-20260430.md`
  - Verification summary: multipart route accepts `file`, optional `sheetName`, and optional JSON `mapping`.
- [x] Implement `GET /api/multitable/sheets/:sheetId/export-xlsx`.
  - PR: #1275
  - Merge commit: `5c4130913`
  - Development MD: `docs/development/multitable-xlsx-backend-routes-development-20260430.md`
  - Verification MD: `docs/development/multitable-xlsx-backend-routes-verification-20260430.md`
  - Verification summary: route returns XLSX binary with content-disposition and truncation header.
- [x] Ensure import writes go through the authoritative record write path.
  - PR: #1275
  - Merge commit: `5c4130913`
  - Development MD: `docs/development/multitable-xlsx-backend-routes-development-20260430.md`
  - Verification MD: `docs/development/multitable-xlsx-backend-routes-verification-20260430.md`
  - Verification summary: import delegates row writes to `RecordService.createRecord()`.
- [x] Ensure export respects current sheet/view permissions.
  - PR: #1275
  - Merge commit: `5c4130913`
  - Development MD: `docs/development/multitable-xlsx-backend-routes-development-20260430.md`
  - Verification MD: `docs/development/multitable-xlsx-backend-routes-verification-20260430.md`
  - Verification summary: export requires `canRead` and `canExport`; optional `viewId` is scope-checked.
- [x] Add backend tests for import mapping, invalid file, permission denial, and export.
  - PR: #1275
  - Merge commit: `5c4130913`
  - Development MD: `docs/development/multitable-xlsx-backend-routes-development-20260430.md`
  - Verification MD: `docs/development/multitable-xlsx-backend-routes-verification-20260430.md`
  - Verification summary: `multitable-xlsx-routes.test.ts` covers import mapping, invalid input, permission denial, and export.
- [x] Update OpenAPI source and generated dist.
  - PR: #1275
  - Merge commit: `5c4130913`
  - Development MD: `docs/development/multitable-xlsx-backend-routes-development-20260430.md`
  - Verification MD: `docs/development/multitable-xlsx-backend-routes-verification-20260430.md`
  - Verification summary: OpenAPI source updated and generated dist refreshed.
- [x] Mark frontend-only xlsx limitation as closed or explicitly narrowed.
  - PR: #1275
  - Merge commit: `5c4130913`
  - Development MD: `docs/development/multitable-xlsx-backend-routes-development-20260430.md`
  - Verification MD: `docs/development/multitable-xlsx-backend-routes-verification-20260430.md`
  - Verification summary: limitation narrowed to frontend not yet wired to backend routes; backend capability exists.

Expected docs:

- `docs/development/multitable-xlsx-backend-routes-development-20260430.md`
- `docs/development/multitable-xlsx-backend-routes-verification-20260430.md`

## Phase 3 - P0 Gap: OpenAPI / Contract Cleanup

- [x] Audit OpenAPI coverage for new field types.
  - PR: #1277
  - Merge commit: `e97e22648`
  - Development MD: `docs/development/multitable-openapi-rc-contract-cleanup-development-20260430.md`
  - Verification MD: `docs/development/multitable-openapi-rc-contract-cleanup-verification-20260430.md`
  - Verification summary: `MultitableFieldType` now centralizes all runtime field types including `currency`, `percent`, `rating`, `url`, `email`, and `phone`.
- [x] Audit OpenAPI coverage for new view types: `gantt`, `hierarchy`.
  - PR: #1277
  - Merge commit: `e97e22648`
  - Development MD: `docs/development/multitable-openapi-rc-contract-cleanup-development-20260430.md`
  - Verification MD: `docs/development/multitable-openapi-rc-contract-cleanup-verification-20260430.md`
  - Verification summary: `MultitableViewType` now enumerates `grid`, `form`, `kanban`, `gallery`, `calendar`, `timeline`, `gantt`, and `hierarchy`.
- [x] Audit OpenAPI coverage for xlsx routes after Phase 2.
  - PR: #1277
  - Merge commit: `e97e22648`
  - Development MD: `docs/development/multitable-openapi-rc-contract-cleanup-development-20260430.md`
  - Verification MD: `docs/development/multitable-openapi-rc-contract-cleanup-verification-20260430.md`
  - Verification summary: parity guard checks import/export route presence and export response headers including `Content-Disposition`.
- [x] Regenerate and commit OpenAPI dist artifacts.
  - PR: #1277
  - Merge commit: `e97e22648`
  - Development MD: `docs/development/multitable-openapi-rc-contract-cleanup-development-20260430.md`
  - Verification MD: `docs/development/multitable-openapi-rc-contract-cleanup-verification-20260430.md`
  - Verification summary: `packages/openapi/dist/{combined.openapi.yml,openapi.json,openapi.yaml}` regenerated.
- [x] Run OpenAPI contract guard.
  - PR: #1277
  - Merge commit: `e97e22648`
  - Development MD: `docs/development/multitable-openapi-rc-contract-cleanup-development-20260430.md`
  - Verification MD: `docs/development/multitable-openapi-rc-contract-cleanup-verification-20260430.md`
  - Verification summary: `node --test scripts/ops/multitable-openapi-parity.test.mjs` passes.
- [x] Add a verification doc listing schema additions and generated outputs.
  - PR: #1277
  - Merge commit: `e97e22648`
  - Development MD: `docs/development/multitable-openapi-rc-contract-cleanup-development-20260430.md`
  - Verification MD: `docs/development/multitable-openapi-rc-contract-cleanup-verification-20260430.md`
  - Verification summary: this Phase 3 dev/verification pair records implementation scope and validation commands.

Expected docs:

- `docs/development/multitable-openapi-rc-contract-cleanup-development-20260430.md`
- `docs/development/multitable-openapi-rc-contract-cleanup-verification-20260430.md`

## Phase 4 - P0/P1 Gap: System Fields Batch

- [ ] Add `autoNumber` field type.
  - Blocked: not included in backend seam slice because stable auto-number requires persistent sequence allocation; do not ship a row-index placeholder.
- [x] Add `createdTime` field type mapped to record `created_at`.
  - PR: #1280
  - Merge commit: c45da32c1
  - Development MD: `docs/development/multitable-system-fields-backend-development-20260430.md`
  - Verification MD: `docs/development/multitable-system-fields-backend-verification-20260430.md`
  - Verification summary: query service injects `createdTime` from `meta_records.created_at`.
- [x] Add `modifiedTime` field type mapped to record `updated_at`.
  - PR: #1280
  - Merge commit: c45da32c1
  - Development MD: `docs/development/multitable-system-fields-backend-development-20260430.md`
  - Verification MD: `docs/development/multitable-system-fields-backend-verification-20260430.md`
  - Verification summary: query service injects `modifiedTime` from `meta_records.updated_at`.
- [x] Add `createdBy` field type mapped to record `created_by`.
  - PR: #1280
  - Merge commit: c45da32c1
  - Development MD: `docs/development/multitable-system-fields-backend-development-20260430.md`
  - Verification MD: `docs/development/multitable-system-fields-backend-verification-20260430.md`
  - Verification summary: query service injects `createdBy` from `meta_records.created_by`.
- [x] Add `modifiedBy` storage if missing, then expose `modifiedBy`.
  - PR: #1280
  - Merge commit: c45da32c1
  - Development MD: `docs/development/multitable-system-fields-backend-development-20260430.md`
  - Verification MD: `docs/development/multitable-system-fields-backend-verification-20260430.md`
  - Verification summary: migration adds `meta_records.modified_by`; record write paths set it from the actor and query service injects `modifiedBy`.
- [x] Make all system fields readonly from normal patch/create payloads.
  - PR: #1280
  - Merge commit: c45da32c1
  - Development MD: `docs/development/multitable-system-fields-backend-development-20260430.md`
  - Verification MD: `docs/development/multitable-system-fields-backend-verification-20260430.md`
  - Verification summary: `isFieldAlwaysReadOnly()` treats system field types as readonly, reusing existing write guards.
- [x] Add frontend renderer/editor behavior: render-only for readonly system fields.
  - PR: #1283
  - Merge commit: `8174f26f9`
  - Development MD: `docs/development/multitable-system-fields-frontend-development-20260430.md`
  - Verification MD: `docs/development/multitable-system-fields-frontend-verification-20260430.md`
  - Verification summary: grid, cell editor, record drawer, and form view treat system fields as formatted read-only values.
- [x] Add field manager support for creating/configuring allowed system fields.
  - PR: #1283
  - Merge commit: `8174f26f9`
  - Development MD: `docs/development/multitable-system-fields-frontend-development-20260430.md`
  - Verification MD: `docs/development/multitable-system-fields-frontend-verification-20260430.md`
  - Verification summary: field manager exposes `createdTime`, `modifiedTime`, `createdBy`, and `modifiedBy` as createable no-config fields.
- [x] Add tests for create, patch rejection, render, sorting/filtering where applicable.
  - Partial: backend tests cover metadata projection and actor persistence in `docs/development/multitable-system-fields-backend-verification-20260430.md`.
  - Development MD: `docs/development/multitable-system-fields-frontend-development-20260430.md`
  - Verification MD: `docs/development/multitable-system-fields-frontend-verification-20260430.md`
  - Verification summary: frontend tests cover field-manager create payloads, renderer/editor readonly behavior, and grid no-edit behavior; backend tests continue to cover patch rejection.
- [x] Update OpenAPI source and generated dist.
  - PR: #1280
  - Merge commit: c45da32c1
  - Development MD: `docs/development/multitable-system-fields-backend-development-20260430.md`
  - Verification MD: `docs/development/multitable-system-fields-backend-verification-20260430.md`
  - Verification summary: OpenAPI field type enum and generated dist now include system field types.

Expected docs:

- `docs/development/multitable-system-fields-backend-development-20260430.md`
- `docs/development/multitable-system-fields-backend-verification-20260430.md`
- `docs/development/multitable-system-fields-frontend-development-20260430.md`
- `docs/development/multitable-system-fields-frontend-verification-20260430.md`

## Phase 5 - P1 Gap: Record Version History

- [x] Add record revision persistence table.
  - PR: #1285
  - Merge commit: `3371d8b53`
  - Development MD: `docs/development/multitable-record-history-development-20260430.md`
  - Verification MD: `docs/development/multitable-record-history-verification-20260430.md`
  - Verification summary: migration creates `meta_record_revisions` with revision indexes.
- [x] Record revision after successful authoritative writes.
  - PR: #1285
  - Merge commit: `3371d8b53`
  - Development MD: `docs/development/multitable-record-history-development-20260430.md`
  - Verification MD: `docs/development/multitable-record-history-verification-20260430.md`
  - Verification summary: `RecordService` create/patch/delete and `RecordWriteService.patchRecords()` persist revisions in the same transaction.
- [x] Capture actor, source, version, changed fields, and timestamp.
  - PR: #1285
  - Merge commit: `3371d8b53`
  - Development MD: `docs/development/multitable-record-history-development-20260430.md`
  - Verification MD: `docs/development/multitable-record-history-verification-20260430.md`
  - Verification summary: revision rows include actor, source, action, version, changed field ids, patch, snapshot, and server timestamp.
- [x] Add API to list record history.
  - PR: #1285
  - Merge commit: `3371d8b53`
  - Development MD: `docs/development/multitable-record-history-development-20260430.md`
  - Verification MD: `docs/development/multitable-record-history-verification-20260430.md`
  - Verification summary: `GET /api/multitable/sheets/:sheetId/records/:recordId/history` added with auth/read checks; OpenAPI source and dist regenerated.
- [x] Add record drawer History tab.
  - PR: #1285
  - Merge commit: `3371d8b53`
  - Development MD: `docs/development/multitable-record-history-development-20260430.md`
  - Verification MD: `docs/development/multitable-record-history-verification-20260430.md`
  - Verification summary: drawer adds lazy-loaded `Details` and `History` tabs.
- [x] Add tests for single-field patch, multi-field patch, actor attribution, and permission denial.
  - PR: #1285
  - Merge commit: `3371d8b53`
  - Development MD: `docs/development/multitable-record-history-development-20260430.md`
  - Verification MD: `docs/development/multitable-record-history-verification-20260430.md`
  - Verification summary: focused backend/frontend tests pass; DB route permission integration remains a documented follow-up.
- [x] Document retention default: no cleanup in v1.
  - PR: #1285
  - Merge commit: `3371d8b53`
  - Development MD: `docs/development/multitable-record-history-development-20260430.md`
  - Verification MD: `docs/development/multitable-record-history-verification-20260430.md`
  - Verification summary: retention default documented as indefinite/no cleanup in v1.

Expected docs:

- `docs/development/multitable-record-history-development-20260430.md`
- `docs/development/multitable-record-history-verification-20260430.md`

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
