# Approval/automation — final-4 parallel build & verification (2026-07-03)

> `/goal`: plan & sequence the 4 remaining approval-line items for **parallel development**, complete all 4,
> deliver a dev + verification MD. All four are **built, independently re-verified, and PR-for-review**.

## Sequencing & why it parallelizes (4 concurrent lanes, no shared hot file)

| Item | Lane / subsystem | Design basis | PR |
|---|---|---|---|
| **T3-6** approvals-as-multitable-records | backend — new projection svc + `createApproval` hook | design-lock #3504 | **#3519** |
| **T3-2** business-calendar SLA | backend — `WorkdayCalendarPort` + `ApprovalMetricsService` | design-lock #3513 | **#3521** |
| **T3-1** mobile approval surface (v0) | frontend — `apps/web` approval views | ballot T3-1 Q1–Q11 | **#3517** |
| **A3** BPMN egress destination authz | test/evidence — egress guard suites | ballot A3/A4 | **#3516** |

Genuinely parallel because T3-6 (`createApproval` + new service) and T3-2 (`recordNodeActivation` + new port)
touch **different backend files**, T3-1 is `apps/web`, and A3 is egress tests. Each agent built in an isolated
worktree with its own DB; I re-ran every suite myself before opening each PR.
**Merge note:** T3-6 and T3-2 both touch `index.ts` + `ApprovalProductService.ts` (adjacent init/normalizer
edits, no logical conflict) — merge the two backend PRs **sequentially**, rebasing the second.

## Per-item as-built + verification

### T3-6 — approvals-as-multitable-records projection runtime (#3519)
One-way read-model projection; engine stays authoritative. A single `reconcile(instanceId)` core (re-reads
`approval_instances` + `approval_records`, upserts) is shared by the **create hook** (awaited, best-effort —
never fails the approval; auto-approve-at-create → the SAME row), the **completion-event subscription**, the
**leader-gated sweep**, and the on-demand path.
- **Event-silent (design-lock P1):** the projected write is **direct SQL** on `meta_records`, never touching
  `eventBus` → no `record.*` fires. **Proven** by a system-sheet rule staying `executionCount===0` **with a
  positive control** (a real `record.created` DOES fire it) + a bus spy capturing zero events.
- **Idempotent (P2):** `projected_version = instance.version`; a per-instance `pg_advisory_xact_lock`
  serializes; a stale/redelivered reconcile writes neither table (never clobbers a newer projection). Sweep
  catches drift + a lost create write.
- **Verify:** tsc 0 · new real-DB **14/14** · **fail-first proven** (reconcile neutralized → 10/14 fail) ·
  regressions approval-unit 91/91, T1-3 7/7, T2-6 7/7, lifecycle 3/3.
- **Flagged for review:** visibility is the standard capability gate, **not** a hard per-sheet admin-only DENY
  (the multitable read model is global-permission-driven — a user with global `multitable:read` could read
  the system sheet); on-demand HTTP route + `approval_projection_stale_total` counter deferred (callable core
  + per-row observability delivered).

### T3-2 — business-calendar SLA runtime (#3521)
A `WorkdayCalendarPort` in core-backend; the **attendance plugin registers a provider** wrapping
`resolveEffectiveCalendar`. **Approval never reads `attendance_*`** (grep-proven — only comments mention it;
`ApprovalMetricsService` has zero references).
- Deadline computed at activation via the port, **snapshotted `asOf` activation** (later calendar edits don't
  move an armed deadline); 366-day cap. Opt-in via `NodeTimeoutConfig.unit:'business'` (default `wall_clock` =
  **byte-identical**). **Fail-open:** provider absent/throws/null → elapsed arithmetic, log, never block.
  Additive nullable columns + new partial index; **legacy `sla_hours` + its index untouched, no backfill**.
- **Verify:** tsc 0 · new real-DB **10/10** (weekend pushes `sla_due_at` past naive via the **real
  approval-start + metrics SQL path**; **RED-before** no-provider→naive; fail-open ×3; snapshot; 366-cap;
  legacy byte-identical + **index-served via EXPLAIN**) · port unit 6/6 · regressions node-sla 5/5,
  timeout-effects 13/13, full unit 4169/4169, attendance plugin 149/149.
- **Flagged for review:** org mapping is degenerate today (`ApprovalRequesterSnapshot` has no `orgId` →
  always `'default'`; deliberately no `tenant_id` fallback to avoid wrong-calendar risk); a business node
  emits two signals at `sla_due_at` (node-timeout effect + instance breach) — decouple if only one was intended.

### T3-1 — mobile approval surface v0 (#3517)
**Responsive web, flag-gated, default OFF** (no native / PWA / push — push waits for a Notification Hub that
doesn't exist). `approvalMobile` in `ProductFeatures`, default `false`, no admin/mode inference → **flag OFF =
desktop byte-identical for every viewport**. A dedicated touch-first `ApprovalMobileList.vue` (no Element Plus)
replaces the `el-table` across the 4 center tabs; detail action bar restricted to **approve/reject/comment +
initiate** (deferred actions hidden on mobile); reuses the version-less `/actions` endpoint + **refresh-on-4xx**.
- **Verify:** vue-tsc 0 · **11 new specs** (gate matrix / action-set / refresh-on-4xx / store default-off) ·
  **RED-before demonstrated** · existing `approval-center*` + detail/e2e/field-visibility all green.
- **Flagged for review:** i18n tension (the approval module has **no i18n infra** — matched convention, new
  strings `加载中…`/`暂无审批`/`审批申请`); the initiate **form** isn't mobile-adapted yet (entry is present).

### A3 — BPMN egress destination authorization evidence (#3516)
The rung is "governance-only"; the buildable slice is **decision A3's values-free evidence** (+ A4 rollback)
for the already-shipped egress runtime (#3455/#3457/#3460). **No runtime changed** — one test file.
- 7 cases through the real env path (`BPMN_HTTP_TASK_EGRESS_POLICY` → `executeHttpTask` →
  `dispatchPinnedEgressRequest`): ALLOW reaches transport · DENY disallowed host · DENY private-via-DNS · DENY
  **redirect-to-private** (net-new) · DENY redirect-to-disallowed-host (net-new) · **A4 rollback** blanked +
  removed env → deny-all. **Values-free:** asserts only allow/deny + full `BPMN_HTTP_EGRESS_DENIED:<REASON>`
  strings + DNS/transport reach counts; never a body/header/secret/real destination. A4 no-DB proven by
  running green with no `DATABASE_URL`.
- **Verify:** tsc 0 · new evidence 7/7 · new + all 6 existing egress suites **121 tests green** · one-file diff.

## Review round (post-verification — findings fixed)

An independent PR review found guard/analytics correctness issues (not architecture — the sharp structural
fences doing their job). All fixed on their branches:
- **#3516 (A3)** — the evidence test imports `BPMNWorkflowEngine`, which the convergence guard requires every
  importer to classify. **Fixed:** added to `BPMN_IMPORT_ALLOWLIST` as disposition `TEST` (values-free
  authorization evidence, not a runtime consumer). Guard 4/4.
- **#3519 (T3-6)** — the projection service writes `meta_records.data` directly; the rich-longText write-sink
  guard requires every writer classified. **Fixed:** disposition `SAFE` (writes only fixed system columns,
  never `form_snapshot`/rich-longText). Guard 3/3.
- **#3521 (T3-2)** — the analytics **candidate denominators** counted only `sla_hours IS NOT NULL`, so a
  business-calendar breached row (`sla_hours` NULL, `sla_due_at` set) inflated the breach rate. **Fixed:** all
  6 denominators (summary/template/requester-dept/breached-report candidate + HAVING + ORDER) now count
  `(sla_hours IS NOT NULL OR sla_due_at IS NOT NULL)`; legacy breach UPDATE untouched. New real-DB assertion,
  RED-before confirmed (candidate=0 pre-fix).
- **#3517 (T3-1)** — **approved** in review (CI green, clear default-off boundary).

## Line status after this batch

**All decision-clean / ratified-runtime slices are built.** With these 4 PRs (guard/analytics review-fixes
applied), every remaining approval-line item has its **runtime built and in review** — nothing on the line is
now blocked on undone development:
- T3-6 + T3-2 runtimes: built (#3519 / #3521), each on a merged design-lock.
- T3-1 v0 responsive: built (#3517); native/push remains gated on a future Notification Hub.
- A3: evidence built (#3516); the actual destination authorization is the operator's env-config act.

Sizing was optimistic build-effort; the flagged reviewer-decisions (T3-6 visibility depth, T3-2 org-mapping /
double-signal, T3-1 i18n) are the review surface, not blockers. Merge order: A3 + T3-1 anytime; T3-6 then
T3-2 (rebase T3-2).
