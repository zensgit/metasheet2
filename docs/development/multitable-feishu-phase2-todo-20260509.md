# Multitable Feishu Phase 2 TODO - 2026-05-09

## Status

- Baseline: `origin/main@c74c15a2b` after PR #1446.
- Refreshed baseline before merge: `origin/main@3a484622c`.
- B1 implementation baseline: `origin/main@013797fc3` after PR #1448, K3 token auth #1459, and DingTalk no-email admission #1460.
- Prior RC: `multitable-rc-20260508b-08c6036284`.
- Goal: continue Feishu-parity development after the signed RC without reopening the RC smoke scope.
- Rule: every completed item must include PR, merge commit, development MD, verification MD, and verification summary.
- Worktree rule: all implementation work must start from clean worktrees based on `origin/main`; do not develop from a root checkout that has unrelated untracked docs or an unrelated branch checked out.

## Completion Rules

Mark an item complete only after all are true:

- Code is merged or explicitly accepted as docs-only.
- Focused backend and frontend tests are recorded.
- `git diff --check` passes.
- OpenAPI parity is updated when route/schema contracts change.
- Staging claims include an artifact path or a redacted command transcript.
- Secrets, JWTs, SMTP credentials, public form tokens, and webhook URLs are not written to docs or logs.

## Phase 0 - Local Hygiene

- [ ] Move root checkout back to a safe base or use only clean worktrees.
  - Current observation: root checkout contains unrelated untracked docs and `.claude/`.
  - Acceptance: new feature work happens in `/private/tmp/ms2-*` or `.worktrees/*` worktrees from `origin/main`.
- [ ] Classify existing untracked docs into archive, delete, or hand off.
  - Acceptance: no new multitable Phase 2 PR accidentally includes integration/K3/DingTalk docs.
- [x] Create Phase 2 planning docs.
  - Development MD: `docs/development/multitable-feishu-phase2-development-20260509.md`
  - Verification MD: `docs/development/multitable-feishu-phase2-verification-20260509.md`
  - Verification summary: docs-only plan created from `origin/main@c74c15a2b`; scoped to three non-overlapping lanes plus a hygiene gate.

## Lane A - Long Text Field

Owner recommendation: Claude can implement; Codex reviews.

Status: complete. PR #1449 `test(multitable): audit-only test coverage for longText field` merged at `2082f169e879e088ffd09f7e1f3cc5124b3f4dc7`; current main already has end-to-end `longText` implementation and coverage.

### Objective

Add a native `longText` field type for multi-line plain text. This is not rich text, not Markdown rendering, and not a full collaborative document editor. It closes the high-frequency Feishu parity gap where users need notes, descriptions, and multi-line imported content.

### File Boundary

Likely backend files:

- `packages/core-backend/src/multitable/field-codecs.ts`
- `packages/core-backend/src/multitable/field-type-registry.ts`
- `packages/core-backend/src/multitable/field-validation.ts`
- `packages/core-backend/src/multitable/xlsx-service.ts`
- `packages/openapi/**`
- Focused backend tests under `packages/core-backend/tests/**`

Likely frontend files:

- `apps/web/src/multitable/types.ts`
- `apps/web/src/multitable/utils/field-display.ts`
- `apps/web/src/multitable/utils/field-config.ts`
- `apps/web/src/multitable/components/MetaFieldManager.vue`
- `apps/web/src/multitable/components/cells/MetaCellEditor.vue`
- `apps/web/src/multitable/components/cells/MetaCellRenderer.vue`
- `apps/web/src/multitable/components/MetaFormView.vue`
- `apps/web/src/multitable/components/MetaRecordDrawer.vue`
- Focused frontend tests under `apps/web/tests/**`

### Requirements

- [x] `longText`, `long_text`, and `multiline` normalize to canonical `longText`.
- [x] Stored raw value is a string; non-string values sanitize consistently with string field behavior unless validation explicitly rejects.
- [x] Grid editor uses `<textarea>` or equivalent multi-line control.
- [x] Renderer preserves newlines with `white-space: pre-wrap` or equivalent.
- [x] Form view and record drawer render/edit long text without collapsing newlines.
- [x] Import/export preserves embedded newlines.
- [x] OpenAPI field type enum includes `longText`.
- [x] Existing `string` field behavior remains unchanged.

### Explicit Non-Goals

- Rich text marks, mentions inside long text, Markdown preview, and per-character Yjs collaboration.
- Automatic migration of existing string fields into long text.
- AI summarize/expand actions.

### Minimum Tests

- [x] Backend codec test for aliases and newline preservation.
- [x] Backend import/export test for embedded newlines.
- [x] Frontend renderer test for newline display.
- [x] Frontend editor test that edit/save preserves multi-line value.
- [x] Field manager test for creating a longText field.
- [x] OpenAPI parity test if schema output changes.

### Suggested PR

- Branch: `codex/multitable-phase2-long-text-field-20260509`
- Title: `feat(multitable): add longText field type`
- Merge order: first among Phase 2 lanes.

## Lane B - Real Email Transport Gate

Owner recommendation: Codex should implement or directly review because this touches credentials, logs, and staging gates.

Status: B1 implemented in PR #1461 on branch `codex/multitable-phase2-email-transport-gate-20260511`. B2 real SMTP/provider delivery remains explicitly deferred.

B1 artifacts:

- Development MD: `docs/development/multitable-phase2-lane-b1-email-transport-gate-development-20260511.md`
- Verification MD: `docs/development/multitable-phase2-lane-b1-email-transport-gate-verification-20260511.md`
- Command: `pnpm verify:multitable-email:readiness`

### Objective

Move `send_email` automation from "default mock channel proves the wire path" toward an env-gated real transport path. The first acceptable slice is a safe transport seam plus readiness gate; the second slice may add actual SMTP delivery if dependency and operations policy are approved.

### Current Fact

`EmailNotificationChannel` currently logs and simulates async delivery. There is no `nodemailer`, SendGrid, SES, Mailgun, or SMTP dependency in the workspace. The RC verified `notificationStatus === 'sent'` through the default mock channel, not actual mailbox receipt.

### File Boundary

Likely backend files:

- `packages/core-backend/src/services/NotificationService.ts`
- `packages/core-backend/src/multitable/automation-executor.ts`
- `packages/core-backend/src/multitable/automation-service.ts`
- `packages/core-backend/src/index.ts` or runtime wiring if channel registration becomes configurable
- `scripts/ops/**` for readiness and redacted smoke helpers
- Focused backend tests under `packages/core-backend/tests/**`

Likely frontend files:

- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- Optional tests under `apps/web/tests/**` only if UI copy or validation changes.

### Requirements

- [x] Default local/dev behavior remains mock unless an explicit env enables real email transport.
- [x] Missing SMTP/provider env reports `blocked`, not `pass`, in a release gate.
- [x] Logs and artifacts redact SMTP host credentials, usernames, passwords, tokens, recipient lists if configured sensitive, and bearer tokens.
- [x] Automation logs keep the existing flat logs API contract used by RC smoke.
- [x] Failed transport returns a controlled failed step, not a backend crash.
- [x] Staging can run a no-send readiness check without sending real email.
- [x] Real-send smoke requires an explicit `CONFIRM_SEND_EMAIL=1` style guard.

### Explicit Non-Goals

- Adding a dev-only inspect endpoint that exposes email body history.
- Printing mailbox credentials or raw recipient lists in docs.
- Changing DingTalk notification behavior.

### Minimum Tests

- [x] Unit test: mock channel remains default when env is absent.
- [x] Unit test: enabled real transport with missing required env returns readiness `blocked`.
- [x] Unit test: transport error becomes failed automation step and execution log persists.
- [x] Redaction test: logs/artifacts do not contain SMTP credentials or bearer tokens.
- [ ] Existing `multitable-rc-automation-send-email-smoke` still passes in mock mode.
  - Local live-stack Playwright was not rerun in B1; the RC/staging smoke path is unchanged and default mock behavior is covered by unit tests.

### Suggested PR Split

- B1 branch: `codex/multitable-phase2-email-transport-gate-20260509`
- B1 title: `feat(multitable): add env-gated email transport readiness`
- B2 branch: `codex/multitable-phase2-email-smtp-transport-20260509`
- B2 title: `feat(multitable): add SMTP email notification transport`

Do B2 only after B1 lands and dependency choice is agreed.

## Lane C - Grid Bulk Edit

Owner recommendation: Claude can implement; Codex reviews conflict handling and permission behavior.

Status: complete for core scope.

Completed by:

- PR #1451 `feat(multitable): add grid bulk edit action`, merge commit `783695ded05bf7893068efa2aa046dd2e481221a`.
- PR #1456 `feat(multitable): support partial-success bulk edits`, merge commit `f6c8bd435e7c8d154de06d82f1b852d2d8706e3d`.

### Objective

Turn existing grid selection and backend `patchRecords` capability into a user-facing bulk edit flow: select records, choose a writable field, set or clear a value, then apply one batch write with conflict and partial-failure reporting.

### Current Fact

`MetaGridTable.vue` now has the user-facing bulk set/clear flow. `useMultitableGrid.ts` requests `partialSuccess: true` for bulk edits, applies successful rows, and surfaces row-level failures instead of silently dropping them.

### File Boundary

Likely backend files:

- `packages/core-backend/src/multitable/record-write-service.ts`
- Existing tests for `patchRecords` and permissions

Likely frontend files:

- `apps/web/src/multitable/components/MetaGridTable.vue`
- `apps/web/src/multitable/composables/useMultitableGrid.ts`
- `apps/web/src/multitable/api/client.ts`
- New or existing focused frontend tests under `apps/web/tests/**`

### Requirements

- [x] Bulk bar offers "Set field" and "Clear field" only when selected records exist.
- [x] Field picker excludes read-only/system fields and fields the current user cannot write.
- [x] Value editor reuses field-specific editor behavior where practical.
- [x] Apply path uses `patchRecords` with expected versions when available.
- [x] UI reports success count and conflict/failure count.
- [x] Partial failures do not silently disappear.
- [x] Existing bulk delete remains unchanged.
- [x] Default backend patch behavior remains all-or-nothing unless `partialSuccess` is explicitly requested.

### Explicit Non-Goals

- Spreadsheet-like drag fill handle.
- Multi-field bulk edit in one dialog.
- Bulk edits across filtered-out records or all pages.

### Minimum Tests

- [x] Frontend test: selected rows open bulk set dialog and submit batch patch.
- [x] Frontend test: read-only/system fields are absent or disabled.
- [x] Frontend test: row-level failures are surfaced.
- [x] Backend route regression: default patch mode remains all-or-nothing.
- [x] Backend route regression: `partialSuccess: true` reports per-row `VERSION_CONFLICT` while keeping successful rows.

### Suggested PR

- Branch: `codex/multitable-phase2-grid-bulk-edit-20260509`
- Title: `feat(multitable): add grid bulk edit action`
- Result: landed through #1451 and #1456.
- Optional follow-up: replace the compact first-three-failures dialog summary with a richer per-row result table if operators need bulk remediation details.

## Parallelization Plan

Preferred sequence:

1. Phase 0 hygiene.
2. Lane C core is complete through #1451 and #1456.
3. Lane A and Lane B1 can run in parallel because their file boundaries are mostly disjoint.
4. Lane B2 waits for B1 and explicit dependency approval.

Conflict notes:

- Lane A may touch `MetaCellEditor.vue`; avoid reopening Lane C files unless doing explicit UX polish.
- Lane B must not touch DingTalk files unless a shared notification interface truly requires it.
- No lane should touch `plugins/plugin-integration-core/*` or K3 PoC scripts.

## Global Verification Commands

Run the relevant subset per PR:

```bash
git diff --check
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
pnpm --filter @metasheet/core-backend exec vitest run <focused backend tests> --reporter=dot
pnpm --filter @metasheet/web exec vitest run <focused frontend tests> --watch=false --reporter=dot
pnpm verify:multitable-openapi:parity
```

For staging-facing gates:

```bash
pnpm verify:multitable-rc:staging
pnpm verify:multitable-rc:ui
```

Only run real email sends with a dedicated test recipient and an explicit confirmation env.
