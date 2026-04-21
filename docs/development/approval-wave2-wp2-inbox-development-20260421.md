# Approval Wave 2 WP2 — Unified Inbox with PLM Integration (Development)

- Date: 2026-04-21
- Branch: `codex/approval-wave2-wp2-inbox-20260421`
- Worktree: `/Users/chouhua/Downloads/Github/metasheet2/.worktrees/wp2-inbox`
- Baseline: `origin/main@6c5c652d1`
- Scope: Roadmap WP2 acceptance criterion #1 — unified `/api/approvals` feed with `sourceSystem` filter across platform and PLM, matching entry in
  `docs/development/approval-mvp-feishu-gap-matrix-20260411.md` ("审批中心/Inbox — 跨系统统一 Inbox").

## Recon findings (what was already working)

1. `ApprovalBridgeService.listApprovals` already supported filtering by `sourceSystem` —
   `packages/core-backend/src/services/ApprovalBridgeService.ts:226-229` appends
   `WHERE source_system = $n` when the caller passes the option. No change needed in the service.
2. `ApprovalBridgeService.upsertPlmMirror` already writes `source_system='plm'` via
   `bridge.externalSystem` (`packages/core-backend/src/services/ApprovalBridgeService.ts:694`, paired with
   `packages/core-backend/src/federation/plm-approval-bridge.ts:82` where the field is hard-coded to `'plm'`).
   The data contract is correct — no mutation of the bridge's write path is required.
3. The LIST route accepted the `sourceSystem` query parameter as a pass-through string
   (`packages/core-backend/src/routes/approvals.ts:306`) and forwarded it into the service, so new-PLM rows
   inserted through the bridge were already reachable via `?sourceSystem=plm`.

## Recon findings (what was missing)

1. `sourceSystem=all` was not translated — the route passed the literal `'all'` downstream, producing
   `WHERE source_system = 'all'` in SQL and matching zero rows. The acceptance criterion requires `all`
   to mean "mixed feed".
2. The route had no whitelist; any string value would be forwarded verbatim (zero rows for anything
   other than the valid trio) with no 400. We want the contract explicit.
3. The frontend `ApprovalListQuery` type and URL builder (`apps/web/src/approvals/api.ts`) did not
   carry a `sourceSystem` field at all, so the store could not propagate a filter even if the UI were
   extended.
4. `ApprovalCenterView.vue` had no source filter control. The toolbar only exposed search + status.

## Scope decisions

- Route-layer change kept to whitelist + `'all'` translation. Did not touch `ApprovalBridgeService`
  semantics (see follow-ups for the tab × source collision).
- Did NOT introduce a data-migration to backfill `source_system` on historical rows — per task scope,
  only new PLM events flow through the bridge.
- Did NOT modify the approval core engine (`ApprovalGraphExecutor.ts`), PLM data model, or the AfterSales
  bridge.
- Did NOT add an attendance source tab — that is a later WP2 slice.
- Chose a dropdown (not a second tab row) because the four Inbox tabs already consume horizontal space
  and the source filter has only three values; the dropdown matches the existing status-filter visual
  language.

## File changes

### Backend

- `packages/core-backend/src/routes/approvals.ts:298-385`
  - `GET /api/approvals` now validates `sourceSystem` against `['platform', 'plm', 'all']` (400
    `APPROVAL_SOURCE_SYSTEM_INVALID` for unknown values).
  - `'all'` translates to `undefined` at the service layer so no `WHERE` clause is appended.
  - Preserves the legacy default: when the client omits `sourceSystem` but sends a `tab`, the
    effective filter stays `'platform'` to keep tab semantics backwards-compatible.
  - Documented the translation rules inline.

### Frontend

- `apps/web/src/approvals/api.ts:279-296`
  - `ApprovalListQuery.sourceSystem?: 'all' | 'platform' | 'plm'`.
- `apps/web/src/approvals/api.ts:353` (URL builder)
  - Appends `sourceSystem` to `URLSearchParams` when set.
- `apps/web/src/views/approval/ApprovalCenterView.vue`
  - Added `sourceSystemFilter = ref<'all'|'platform'|'plm'>('all')` state and an `<el-select>`
    dropdown (testid `approval-source-filter`) in the toolbar with the three options.
  - Wired the value into `loadCurrentTab`'s query object so the store receives `sourceSystem` on every
    tab load / page change / status change.

### Tests

- `packages/core-backend/tests/unit/plm-approval-bridge.test.ts`
  - Extended with a dedicated WP2-labelled case asserting
    `toPlatformApprovalBridgeRecord(...).externalSystem === 'plm'` for both a minimal and a fully
    populated source payload. This pins the bridge write contract that downstream powers the unified
    Inbox `sourceSystem=plm` filter.
- `packages/core-backend/tests/integration/approval-wp2-source-filter.api.test.ts`
  - Seeds one platform + one PLM row via raw INSERT (schema bootstrap mirrors the pattern from
    `approval-pack1a-lifecycle.api.test.ts`).
  - Four cases: `sourceSystem=all` → both rows, `=platform` → platform only, `=plm` → PLM only,
    `=bogus` → 400.
  - Pre-connects the DI-resolved PLM adapter in `beforeAll` so the test-env HTTP client falls into
    mock mode and the route's `syncPlmApprovals` call is a no-op (see follow-up about injecting a
    dedicated stub).
- `apps/web/tests/approvalCenterSourceFilter.spec.ts`
  - Mocks the store and `useApprovalPermissions` (the latter works around a baseline localStorage
    issue in the existing `approval-center.spec.ts` that our spec also encounters).
  - Drives the `ElSelect` stub with a real `change` event, asserts the latest `loadPending` spy call
    carries `{ sourceSystem: 'plm' }` or `'platform'` respectively.
  - Also covers the `'all'` default on mount.

## Follow-ups (documented, not implemented)

- Tab × source collision: `ApprovalBridgeService.listApprovals` hard-adds
  `COALESCE(source_system,'platform')='platform'` when `tab && actorId` are set
  (`packages/core-backend/src/services/ApprovalBridgeService.ts:264`). Passing `tab=pending &
  sourceSystem=plm` therefore returns zero rows. The WP2 acceptance does not require composing these,
  and the frontend currently serves tabs + filter independently for platform; a proper cross-product
  needs a deeper refactor (likely when attendance is added). Document-only for now.
- Attendance source: not yet in `approval_instances`. When added, extend the whitelist in the route
  and the `ApprovalListQuery` literal, and surface a fourth option in the dropdown.
- PLM adapter in integration tests: the current pattern (pre-connect to force mock mode) depends on
  `IPLMAdapter` accepting a no-URL config path. If PLM env vars leak into CI (PLM_BASE_URL, etc.), the
  adapter will try a real HTTP call and the test would regress. A future hardening: inject a
  dedicated stub adapter via the `approvalsRouter({ plmAdapter })` option and skip the DI round-trip.
- Historical PLM backfill: new events flow through the bridge and carry `source_system='plm'`; legacy
  rows (if any) retain `NULL` or `'platform'`. Out of scope for this slice per the task.

## Verification summary

See `approval-wave2-wp2-inbox-verification-20260421.md` for exact commands and pass/fail counts.
