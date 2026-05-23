# Multitable Issue #1780 Closure Verification

Date: 2026-05-23
Branch: `runtime/multitable-issue-1780-closure-20260523`
Base: `origin/main@675afd560`
Issue: <https://github.com/zensgit/metasheet2/issues/1780> (CLOSED)

## Background

Issue #1780 ("多维表功能回归：需补充确认的闭环验收项") tracked a multi-checkbox
regression sweep across the multitable surface after the recent landings. The
issue was closed on 2026-05-23 after the comments declared 7-of-7 RC + 4-of-4
admin link smoke PASS, but two structural gaps remained that the comment thread
itself flagged:

1. The seven checkboxes in the issue body were never formally ticked off,
   leaving the closure traceable only through prose in comments.
2. The "登录态 UI 回归未形成可复现的可持续脚本回放" gap was explicitly
   acknowledged — the existing `verify:multitable-rc:ui` smoke covers the
   Gantt view only, while the issue clause "Grid/Calendar/Gallery/Kanban/
   Timeline 等视图切换" expects the basic view-mode set to have logged-in UI
   coverage too.

This document closes (1) by recording the per-clause PASS/PARTIAL/DEFERRED
status with traceable references, and adds the durable artifacts that close
the basic-views half of (2). Timeline-view UI smoke is recorded as a residual
deferred item (see §6).

## What this PR adds

### Test artifact

`packages/core-backend/tests/e2e/multitable-basic-views-smoke.spec.ts` — five
Playwright tests, one per view type (grid / calendar / kanban / gallery / form),
sharing a single base/sheet fixture via `test.describe.serial`. Each test:

- asserts `.mt-workbench` (the workbench root, defined at
  `apps/web/src/multitable/views/MultitableWorkbench.vue:2`) is visible
- creates its own view of the target type and navigates via
  `injectTokenAndGo` (from the shared `multitable-helpers.ts`)
- asserts a view-type-specific selector is visible and, where applicable,
  that record data renders

Reuses the existing `multitable-helpers.ts` scaffold (no new auth mechanism)
and follows the same `injectTokenAndGo + makeAuthClient + create*` primitives
used by the Gantt / hierarchy / public-form / formula / lifecycle smokes.

### Wrapper script

`scripts/verify-multitable-views-ui-smoke.sh` mirrors
`verify-multitable-rc-ui-smoke.sh` line-for-line on the safety contract:

- `set -euo pipefail`
- required env: `FE_BASE_URL`, `API_BASE_URL`, `AUTH_TOKEN`
- `reject_unsafe_url` rejects URLs containing `@`, `?`, or `#`
- token redaction via three-pattern `sed`: `Authorization: Bearer …`, bare
  `Bearer …`, and the literal `AUTH_TOKEN` value (with `.` escaped for the
  JWT base64url joiner)
- `PIPESTATUS[0]` preserves Playwright's exit code through the redacting pipe
- artifact archival into `OUTPUT_DIR` (default `output/multitable-views-ui-smoke`)
- exit codes: `0` 5/5 PASS, `1` test failure, `2` env/fatal

### Wiring

`package.json` adds `verify:multitable-views:ui` alongside
`verify:multitable-rc:ui` (one new line, no other changes).

### No business code touched

This PR does not modify any code under `apps/web/src/`,
`packages/core-backend/src/`, or any migrations. The change is scoped to
e2e/spec + wrapper script + package.json wiring + this verification doc.

## Issue checklist — status & evidence

For each of the seven clauses in the issue body, status is one of:

- **PASS** — verified, with a code/PR reference
- **PARTIAL** — partially verified, with explicit residual called out
- **DEFERRED** — known gap, tracked as residual

### 1. 入口与默认路径收敛

**PASS.** Code-confirmed:

- `apps/web/src/router/appRoutes.ts:54-57` — `/grid` redirects to `/multitable`
  with `meta: { deprecated: true, retireBy: '2026-06-30' }`.
- `apps/web/src/router/appRoutes.ts:113-117` — `ROUTE_PATHS.MULTITABLE_HOME` is
  the canonical entry, no `deprecated` flag.
- Legacy `/kanban`, `/calendar`, `/gallery`, `/form` retained with
  `deprecated: true` (`appRoutes.ts:59-81`); `/spreadsheets`
  retained without a deprecated flag (`appRoutes.ts:132-143`). Acceptable
  per the issue clause "保留兼容".

### 2. 多维表新建成功率

**PASS via API smoke.** Confirmed by `@adharamans` comments:
"创建 Base PASS (201) … 创建 Sheet PASS (200) … 创建字段 PASS … 创建记录 PASS"
and by the lifecycle smoke
(`packages/core-backend/tests/e2e/multitable-lifecycle-smoke.spec.ts`).

### 3. 视图切换稳定性

**PARTIAL → PASS after this PR (Timeline still DEFERRED).** Coverage matrix:

| View type | Coverage source | Status |
|-----------|----------------|--------|
| grid      | `multitable-lifecycle-smoke.spec.ts` + this PR | PASS |
| calendar  | this PR (`multitable-basic-views-smoke.spec.ts`) | PASS |
| kanban    | this PR | PASS |
| gallery   | this PR | PASS |
| form      | this PR | PASS |
| gantt     | `multitable-gantt-smoke.spec.ts` (existing RC UI) | PASS |
| hierarchy | `multitable-hierarchy-smoke.spec.ts` (existing RC) | PASS |
| **timeline** | none | **DEFERRED** (see §6) |

Issue body explicitly named "Timeline 等"; absence of timeline UI smoke is the
last named clause without a durable artifact.

### 4. 日历展示与假期/农历完整性

**PASS via API.** Comment "考勤 `effective-calendar`: 使用 `userId + from/to`
查询返回 200，节假日数据可见" closes the data side. UI side: `.meta-calendar__`
chrome render is now covered by this PR's calendar test; holiday/lunar overlay
remains under the existing
`multitable-final-audit-visual-views-verification-20260522.md` slice.

### 5. 考勤同步与 `effective-calendar` 接口联动

**PASS.** Comment "effective-calendar … 返回 200，节假日数据可见" + the
attendance-side closure recorded in
`docs/development/attendance-effective-calendar-policy-closure-audit-20260523.md`
([[project_attendance_effective_calendar_complete]]).

### 6. 导入导出与附件评论基础链路

**PASS via API smoke.** Comment from `@adharamans`:
"评论生命周期 (创建/列表/read/resolve/delete) PASS … 附件 (upload/download/delete)
PASS … xlsx 导出 PASS". UI side not in scope of this PR; existing
`apps/web/tests/multitable-comment-*.spec.ts` and
`multitable-attachment-*.spec.ts` provide unit-level frontend coverage.

### 7. 生产场景下稳定性

**PASS via observation.** Page-shell reachability: 200 on `/multitable` and
on deep sheet/view URLs (comments from both `@zensgit` and `@adharamans`).
Refresh/back-button stability not explicitly scripted; the new spec's
`injectTokenAndGo → page.goto` exercises the cold-load path for each view.

## Permission boundary (bonus coverage)

The issue body did not include permission boundaries as a numbered clause, but
the comments verified them. Evidence:

- 401 on unauthenticated `/api/multitable/view`, `/api/multitable/sheets`,
  `/api/auth/me`
- 401 on invalid token
- 403 on `POST /api/multitable/sheets` for `attendance_employee` (read 200,
  write 403)

These match the existing route-level guards
(`packages/core-backend/src/routes/univer-meta.ts:3126` for the write side).

## Documentation correctness nits (NOT touched by this PR)

The comment thread noted that an in-flight verification checklist (in the
issue conversation, not in a checked-in doc) referenced `/api/admin/permissions`
which returns 404; the active route is `/api/admin/permission-templates`
(`packages/core-backend/src/routes/permissions.ts:316,340`).
`grep -rn "/api/admin/permissions" docs/` against the working tree returns no
hits other than this verification doc — i.e. no checked-in handbook to fix.
Recorded here so future regression sweeps re-using the comment's checklist
verbatim know to substitute the correct path. Note: `/admin/permissions`
(frontend SPA route, no `/api` prefix) IS a valid route at
`apps/web/src/router/appRoutes.ts:187` and should NOT be touched.

## Residual deferred items

These were explicitly excluded from this PR's scope but should be tracked:

1. **Timeline view UI smoke** — issue body named "Timeline 等" but no spec
   exists. Could be appended to `multitable-basic-views-smoke.spec.ts` once
   a Timeline date/title field config and selector survey are done.
   Estimated < 1 hour of work.

2. **Login throttling parameter audit** — one tester hit
   `Too many login attempts (retryAfter ≈ 1774s)` (~30 min lockout). Threshold
   and trigger conditions for admin/debug usage have not been reviewed. No
   evidence this is a regression vs. prior releases; flagged for record.

3. **Documentation reference fix for `/api/admin/permissions`** — see above.

4. **Anonymous public-form happy-path UI smoke** — covered at the API layer by
   `multitable-public-form-smoke.spec.ts`, no UI flow assertion. Lower
   priority because the existing spec already exercises the token-rotation
   path.

5. **Refresh / back-button continuity scripting** — issue clause 7 noted
   "刷新、重进、返回后关键状态可恢复"; only the cold-load case is covered.

## DoD

- [x] `multitable-basic-views-smoke.spec.ts` exists with 5 view-type tests
- [x] `verify-multitable-views-ui-smoke.sh` exists, executable, with the same
      token-redaction discipline as `verify-multitable-rc-ui-smoke.sh`
- [x] `package.json` wires `verify:multitable-views:ui`
- [x] This verification doc records PASS/PARTIAL/DEFERRED with code refs
- [x] No business code (apps/web/src or packages/core-backend/src) touched
- [x] No migrations changed
- [x] Branch is `runtime/multitable-issue-1780-closure-20260523` off
      `origin/main@675afd560`, not the in-flight attendance PR5 branch

## Local run guide

Against a local stack (backend :7778, frontend :8899):

```bash
cd packages/core-backend
npx playwright test --config tests/e2e/playwright.config.ts \
  multitable-basic-views-smoke.spec.ts --workers=1
```

Against a deployed stack (e.g. via SSH tunnel into staging):

```bash
FE_BASE_URL=http://127.0.0.1:18081 \
API_BASE_URL=http://127.0.0.1:18081 \
AUTH_TOKEN=<admin-bearer-jwt> \
pnpm verify:multitable-views:ui
```

Expected output on success: `[views-ui-smoke] PASS — basic views UI 5/5`.

## Cross-references

- Existing RC UI smoke (Gantt): `scripts/verify-multitable-rc-ui-smoke.sh`,
  `packages/core-backend/tests/e2e/multitable-gantt-smoke.spec.ts`
- Existing API smoke: `scripts/verify-multitable-rc-staging-smoke.mjs`,
  `packages/core-backend/tests/e2e/multitable-lifecycle-smoke.spec.ts`
- Hierarchy UI smoke (existing): `multitable-hierarchy-smoke.spec.ts`
- Shared helper: `packages/core-backend/tests/e2e/multitable-helpers.ts`
- Attendance closure: `docs/development/attendance-effective-calendar-policy-closure-audit-20260523.md`
- Visual-view localization: `docs/development/multitable-final-audit-visual-views-verification-20260522.md`
