# Multitable Automation Run Governance TODO

Date: 2026-05-27
Scope: multitable automation run governance + whole-execution retry only
Status: A0-A5 closed (2026-05-29); A6-1 COMPLETE end-to-end (runtime #2130 + enable-writer #2191 + admin UI toggle #2193, 2026-06) — rules can opt into the per-action WorkflowJob plane from the editor, no longer dormant; A6-2 suspend/resume backend (admin-gated v1, webhook/external resume) LANDED #2237 c363a78db (2026-06-03) + A6-2b frontend (admin Resume UI + `wait_for_callback` editor) LANDED #2245 cee99c8e4 (2026-06-04) + operator UAT PASS #2257 (2026-06-04) — A6-2 now closed end-to-end; delay/timer resume deferred; A6-3-1 `condition_branch` exclusive-branch runtime LANDED #2321 `127b29dd9` (2026-06-05; design-lock `multitable-automation-a6-3-branch-parallel-design-20260605.md`) + A6-3-2a editor LANDED #2339 `960ea9315` + A6-3-2b admin-runs readability LANDED #2348 `4b44f25c6`; A6-3 v1 operator/API/UI trial PASS (#2367/#2371), then A6-3-3 branch-local wait scope-gate opened by `multitable-automation-a6-3-3-branch-local-wait-scope-gate-20260615.md` (runtime/frontend not started); A6-3-4/W3 parallel join-all LANDED end-to-end (#2496 runtime `b161080b8`, #2500 editor `4408239d0`, #2501 admin-runs readability `88f5f538a`, 2026-06-12); A6-5 / W6-1 `start_approval` bridge LANDED #2469, with deployed/operator smoke tracked by #2480 + `automation-start-approval-operator-smoke-runbook-20260613.md`; W7-0 approval result backwrite scope-gate added (runtime not started); A6-4a BPMN compile/preview pure compiler LANDED #2568 `0f214a222` (2026-06-13; no route, persistence, deploy/start, or live BPMN runtime); A6-4b read-only route LANDED #2577 `b5646fa71` (2026-06-13; no persistence, deploy/start, or live BPMN runtime); A6-4c Workflow Designer compile-preview UI LANDED #2604 (read-only; consumes A6-4b route; no deploy/start/persist; stale-response guarded); A6-3-3 runtime/frontend, join-any cancellation semantics, public webhook/token emitter, live BPMN runtime, and W7-1 result backwrite remain demand-gated.
Companion: multitable-automation-run-governance-development-20260527.md
Depends on (landed): C1 contract workflow-job-contract.ts (#1889, read-boundary wired only); RFC #1885

## Closeout Snapshot — 2026-05-29

The governance half and named A5 retry runtime are complete on `origin/main`:

- A0 scope gate / two-gate doctrine: #1932.
- A1 execution snapshot + before-persist redaction + consolidated backend redactor: #1937.
- Dead-letter error message secret scrub: #1917.
- A2 read-only runs API + C1 boundary mapping + admin-only gate: #1967 + #1973.
- A3 admin runs view + admin navigation entry: #1975 + #1983.
- A4 retry scope gate / design lock: #2039.
- A5 whole-execution retry runtime: #2047.
- A1/A5 HTTP serialization hardening: #2051 + #2053.
- A6-0 convergence scout + A6-1 runtime scout: docs-only planning artifacts.
- A6-1 persistent `WorkflowJob` runtime: LANDED #2130 (2026-05-30) — opt-in linear
  job plane (new `multitable_automation_jobs`, rule-level `execution_mode`, fail-closed,
  A1-redaction reuse, A2 detail prefer-jobs). Historical note: this runtime initially
  landed **DORMANT** because createRule/updateRule did not accept `execution_mode`; that
  dormant state was later closed by #2191 enable-writer + #2193 admin UI toggle.

This closeout did NOT mark the convergence engine complete at the time. Current status:
A6-1 and A6-2 are complete end-to-end; A6-3-1 `condition_branch` exclusive-branch runtime
landed (#2321), A6-3-2 frontend/runs readability landed (#2339 + #2348), and
A6-3-4/W3 parallel `join_all` landed end-to-end (#2496 + #2500 + #2501). A6-3-3
branch-local wait/nesting and A6-3-5 join-any remain gated; A6-5/W6-1
`start_approval` later landed separately in #2469; A6-4a pure BPMN compile/preview
compiler later landed in #2568, and the read-only route later landed in #2577. The
Workflow Designer compile-preview UI and any live BPMN runtime remain separate future
unlocks. Later trial
evidence (#2367/#2371) confirmed the A6-3 v1 surface is enough for the tested
condition-branch flow and did not produce a branch-local wait/nesting demand.

## Doctrine — Two Gates (definition of "not lopsided")

- Demand gate: a flow CAPABILITY ships only when a concrete integration/product
  use-case names it. No named use-case -> defer.
- Governance gate: every flow surface MUST inherit the shared
  run/job/status/provenance/redaction/replay substrate. If it does not ->
  fix inheritance first.
- Asymmetry: capability may be lopsided (strategic); governance must not.
  Never ship a second-class flow with no provenance / no replay / no redaction /
  its own status vocabulary.

This line is the governance half. The capability half (convergence engine) is a
separate demand-gated track (see A6 + RFC #1885 + contract #1889).

## Scope Boundary

The original governance-half line improves automation execution observability, and aligns
its data model with the landed C1 WorkflowJob contract (#1889) by boundary mapping — NOT
by changing storage and NOT by persisting jobs. Later A6 runtime slices are separate,
explicit opt-ins and are tracked below.

By itself, the governance-half line did not unlock:

- approval_trigger_bindings / approval result backwrite / automation start_approval
- approval completion event bridge
- persistent automation_jobs runtime (later A6-1 opt-in)
- suspend/resume (later A6-2 opt-in), branch/parallel, cross-engine orchestration
- Workflow Designer / BPMN live execution mapping

The K3 Stage-1 blanket lock is retired (#1993; #1792 = M1 one-record Material Save-only PASS) — replaced by post-GATE scoped gates (see `k3-post-gate-scoped-governance-20260528.md`). This does NOT open the capability half: each item above still requires a separate named unlock / demand gate.

Later status note: automation `start_approval` was separately unlocked and
landed as the A6-5 / W6-1 bridge in #2469. That does not unlock approval
trigger bindings, approval result backwrite runtime, public webhook/token emitters,
BPMN runtime, or branch-local wait/nesting. W7-0 only scopes result backwrite;
W7-1 runtime remains gated. The normal W7-1 re-entry proof is the deployed W6
operator smoke tracked by #2480 and
`automation-start-approval-operator-smoke-runbook-20260613.md`.

## Lock posture (per milestone)

- A0: docs-only, can do now.
- A1 / A2 / A3: S1 observability — low risk, but each still a NAMED UNLOCK
  (explicit opt-in; not "read-only so no review needed").
- A4 / A5: completed by explicit opt-in (#2039 + #2047); retry UI,
  idempotency keys, and re-fetch-current-record context remain future opt-ins.
- A6: A6-0/A6-3/A6-4 design-locks are docs-only; A6-1/A6-2 + A6-3-1 `condition_branch` runtime
  + A6-3-2 frontend/readability + A6-3-4/W3 parallel `join_all` + A6-5/W6-1
  `start_approval` bridge + A6-4a pure BPMN compiler + A6-4b read-only route landed by explicit opt-in; A6-3-3 + join-any, A6-4c UI,
  public webhook/token emitter, and W7 result
  backwrite runtime remain demand-gated.

## Current Baseline

Already present before this line:

- automation_rules CRUD
- AutomationExecutor sequential action execution (status: success|failed|skipped per step)
- multitable_automation_executions table (execution status: running|success|failed|skipped)
- per-rule logs/stats/test API
- frontend MetaAutomationLogViewer
- frontend redacted support packet utility
- scheduler leader lock for in-memory timers
- DingTalk-specific redactor in executor (redactDingTalkFailureAlertText) — to be CONSOLIDATED, not extended
- C1 WorkflowJob contract (workflow-job-contract.ts, #1889) — LANDED. Initially wired
  only at the A2 read boundary; now also used by A6-1 persisted jobs and A6-2 suspended
  job/resume surfaces.

Completed by this governance-half line:

- execution trigger_event snapshot (redacted) — #1937.
- rule_snapshot at execution time (redacted) — #1937.
- finished_at, schema_version — #1937.
- write-time redaction of step.output / step.error — #1937.
- cross-rule Automation Runs API (status via C1 bridge; steps via toWorkflowJobView) — #1967.
- execution detail API — #1967.
- platform-admin-only gate for cross-sheet runs/detail snapshots — #1973.
- frontend admin runs view and admin navigation entry — #1975 + #1983.

Completed by the named A4/A5 retry line:

- retry scope gate with current-rule + stored-trigger-event decision — #2039.
- whole-execution retry route, provenance, and side-effect confirmation — #2047.
- HTTP response serialization invariant for `/test` + retry — #2051 + #2053.

Landed (capability half) — A6-1 COMPLETE, end-to-end & reachable in production:
- A6-1 persistent WorkflowJob runtime — #2130.
- A6-1 enable-writer (createRule/updateRule accept `execution_mode`) — #2191.
- A6-1 admin UI toggle (rule-editor checkbox) — #2193. No longer dormant: a maintainer can
  opt a rule onto the per-action WorkflowJob plane from the editor.
- A6-2 suspend/resume runtime (backend, admin-gated v1; `wait_for_callback` + admin resume route,
  webhook/external resume) — LANDED #2237 c363a78db (2026-06-03).
- A6-2b suspend/resume FRONTEND (admin Resume UI on suspended steps + `wait_for_callback` editor that
  auto-locks `workflow_job_v1`; token admin-detail-only, never rendered) — LANDED #2245 cee99c8e4
  (2026-06-04). **A6-2 now closed end-to-end.**
- A6-3 exclusive condition branch + parallel join-all — LANDED through #2321/#2339/#2348 and
  #2496/#2500/#2501. **A6-3 now covers first-match/default branching plus fan-out/fan-in
  `join_all`; branch-local waits and join-any remain separate.**

Deferred (capability half — A6, frozen/demand-gated):
- A6-2 delay/timer resume (v1 was webhook/external only; delay/timer later forces a durable
  scheduler/worker/leader)
- A6-3-3 branch-local wait/nesting; A6-3-5 join-any;
  A6-4 BPMN compile/preview adapter; public webhook/token emitter; W7 approval result backwrite

## Milestones

### A0 — Scope Gate and TODO  (lock: docs-only, now) — DONE (#1932)

- [x] Add this TODO MD (incl. two-gate doctrine + per-milestone lock posture).
- [x] Add development MD for run governance.
- [x] State approval Phase 2 downstream items stay frozen.
- [x] State retry is not part of A1/A2/A3 runtime (A4 gate / A5 runtime).
- [x] Register the capability half (A6) as frozen/demand-gated; reference #1885 / #1889.

Acceptance:

- [x] Docs-only diff.
- [x] No runtime, migration, route, or UI changes.

### A1 — Execution Snapshot Foundation  (lock: S1 named unlock) — DONE (#1937)

Migration — add ONLY columns A1 populates with a real value now:

- [x] sheet_id TEXT
- [x] trigger_event JSONB        (redacted at write)
- [x] rule_snapshot JSONB        (redacted at write)
- [x] finished_at TIMESTAMPTZ NULL
- [x] schema_version INT NOT NULL DEFAULT 1
- [x] DO NOT add rerun_of_execution_id  (-> A5)
- [x] DO NOT add created_by/initiated_by (-> A5, only if execute path can pass the actor)

Steps storage:

- [x] Keep legacy AutomationStepResult[] UNCHANGED.
- [x] Do NOT persist a workflowJob sub-object.
- [x] Do NOT add upstreamStepKey/branchIndex graph columns (-> A6).

Redaction (BEFORE persist, not at read):

- [x] Redact rule_snapshot (headers.authorization, URL query token, secret, ...).
- [x] Redact trigger_event.
- [x] Redact step.output AND step.error (the third channel: responseBody / generic error text).
- [x] Redaction = secret-shaped value scrub; PRESERVE business field values (diagnosis).
- [x] Business-field / PII masking is OUT of A1 scope -> open question decided at A4 gate.
- [x] Use ONE multitable/core redaction helper: reuse support-packet util or promote a
      core shared helper; CONSOLIDATE the existing DingTalk-specific executor redactor.
- [x] Do NOT reverse-import integration-core/lib/payload-redaction.cjs (domain boundary).

Wiring:

- [x] AutomationService.executeRule() passes sheetId, triggerEvent, current rule snapshot.
- [x] AutomationLogService.record() persists redacted snapshot + finished_at + schema_version.
- [x] Preserve existing logs/stats/test API shapes.
- [x] Storage status stays legacy 4-state (no hot-path/status rewrite).

Acceptance:

- [x] Existing automation unit tests pass.
- [x] Test proves trigger_event / rule_snapshot persist.
- [x] Test proves secret-shaped values in rule_snapshot / trigger_event / step.output /
      step.error are scrubbed at write, AND business field values are preserved.
- [x] Test proves no extra redactor is introduced; DingTalk path uses the consolidated helper.
- [x] Old rows with null snapshot fields still map safely (schema_version defaults 1).

### A2 — Read-only Automation Runs API  (lock: S1 named unlock) — DONE (#1967 + #1973)

- [x] Add GET /api/multitable/automation-executions (filters: sheetId, status, ruleId, limit; clamp 1..200).
- [x] Add GET /api/multitable/automation-executions/:executionId (404 on missing).
- [x] Gate both cross-sheet routes behind platform-admin access (`requireAdminRole()`).
- [x] Emit execution status as WorkflowJobStatus via legacyAutomationStatusToJobStatus(); optional statusLegacy.
- [x] Add toWorkflowJobView(execution, step, index):
        id = `${execution.id}:step:${index}`
        executionId = execution.id
        stepKey = String(index)
        status = legacyAutomationStatusToJobStatus(step.status)   // direct; no no-op ternary
        upstreamJobId = index > 0 ? `${execution.id}:step:${index-1}` : null
        result = step.output ; error = step.error   // already redacted at write (A1)
- [x] status= filter: C1 canonical (advertised), legacy accepted as migration grace.
- [x] Future statuses (queued/suspended/rejected/errored): legal but EMPTY result (not 400).
- [x] Do not add retry endpoint.

Acceptance:

- [x] Route tests: list/detail/filter/limit/not-found.
- [x] Test: toWorkflowJobView output passes C1 normalizeWorkflowJob() (not raw DB step).
- [x] Test: execution status emitted as C1 (success -> resolved).
- [x] Test: status= accepts both vocabularies; future-state filter returns empty (not 400).
- [x] Existing per-rule logs/stats/test shape unchanged.

### A3 — Frontend Runs View  (lock: S1 named unlock) — DONE (#1975 + #1983)

- [x] Client methods for runs list/detail.
- [x] Read-only runs list UI (filter status/rule/sheet; show finished_at).
- [x] Status labels from shared WorkflowJobStatus i18n keys.
- [x] Expandable steps (C1 view) with defensive snapshot redaction.
- [x] Retry omitted.
- [x] Admin navigation entry exposes the view.

Acceptance:

- [x] UI tests: loading, admin gate, status filter, expanded steps, stale-response race guard.
- [x] Existing MetaAutomationLogViewer tests still pass.

### A4 — Retry Scope Gate  (lock: design only) — DONE (#2039)

- [x] Explicit retry demand / named opt-in captured.
- [x] Decide retry source: current enabled rule + stored trigger_event (not redacted rule_snapshot).
- [x] Decide side-effect confirmation UX: `confirmSideEffects === true`.
- [x] Define provenance fields + admin-only permission + missing/deleted-rule failure behavior.
- [x] State retry = whole-run rerun, not A6 suspend/resume.
- [x] Decide the A1-flagged business-field/PII question for A5 v1: no broader PII masking;
      secret-shaped values remain redacted per A1, re-fetch-current-record context is a future opt-in.

### A5 — Whole-execution Retry  (lock: runtime gated) — DONE (#2047 + #2051 + #2053)

- [x] Runtime started only after explicit unlock.
- [x] Migration: add rerun_of_execution_id TEXT NULL, initiated_by TEXT NULL.
- [x] Add POST /api/multitable/automation-executions/:executionId/retry.
- [x] Execute current enabled rule with stored trigger_event; never execute persisted redacted rule_snapshot.
- [x] Persist new execution; link via rerun_of_execution_id; record initiated_by.
- [x] Require admin-only access + explicit side-effect confirmation.
- [x] Fail closed for missing/non-retryable/invalid trigger/missing rule cases.
- [x] Serialize persisted redacted row; safe fallback on log-read failure.
- [x] Harden `/test` endpoint to follow the same response-redaction invariant.

Acceptance:

- [x] Failed/skipped retry creates new execution id; original unchanged.
- [x] Retry persists logs + retry provenance.
- [x] Retry rejects success/running executions.
- [x] Retry rejects missing / empty / invalid trigger events without loading rule or executing actions.
- [x] Retry response and `/test` response never serialize raw in-memory ruleSnapshot / steps.

### A6 — Capability-half Bridge  (A6-0 historical scope gate + current checklist)

Checklist status below starts with the docs-only A6-0 scout/scope gate, then records
later A6-1/A6-2 completions and the current A6-3 design-lock. A6 is still not fully
complete.

- [x] A6-0 docs-only scout/scope gate recorded in
      `multitable-automation-a6-convergence-scout-20260529.md`.
- [x] At A6-0 time, runtime remained frozen / demand-gated; that milestone did not
      authorize implementation.
- [x] Record convergence sequence: persist job -> suspend/resume [webhook before delay]
      -> branch/parallel -> BPMN compile/preview adapter -> approval-as-job.
- [x] Each step references a concrete integration use-case before unlock (demand gate).
- [x] Graph fields (upstreamStepKey/branchIndex) introduced in A6-3, not in A1/A5.
- [x] Governance inheritance: any capability reuses this line's
      run/job/status/provenance/redaction/replay substrate (no second-class layer).
- [x] No runtime in the A6-0 milestone.
- [x] A6-1 persistent WorkflowJob runtime scout recorded in
      `multitable-automation-a6-1-workflowjob-runtime-scout-20260530.md`.
- [x] A6-1 persistent WorkflowJob runtime — LANDED #2130.
- [x] A6-1 enable-writer (createRule/updateRule accept `execution_mode`) — LANDED #2191.
- [x] A6-1 admin UI toggle (rule-editor checkbox) — LANDED #2193. **A6-1 COMPLETE end-to-end.**
- [x] A6-2 suspend/resume runtime (backend, admin-gated v1; webhook/external resume) — LANDED #2237 c363a78db (2026-06-03).
- [x] A6-2b suspend/resume frontend (admin Resume UI + `wait_for_callback` editor) — LANDED #2245 cee99c8e4 (2026-06-04). **A6-2 closed end-to-end.** delay/timer resume still deferred / demand-gated.
- [x] A6-2 UI/operator UAT — PASS #2257 on package `metasheet-multitable-onprem-v2.5.0-a6-2-uat-followup-lock-gate-b37ff906`: `wait_for_callback -> update_record` saved through the UI, suspended, resumed from admin detail, reached terminal `resolved`, and passed the listed negative guards. UAT blockers cleared by #2264 (service validation), #2272 (executor-shaped follow-up configs), and #2278 (`lock_record` hidden/disabled while storage contract is unsupported).
- [x] A6-3-1 `condition_branch` / exclusive-branch v1 runtime (backend) — LANDED #2321 `127b29dd9`
      (2026-06-05): new `condition_branch` action + CHECK migration; dual-layer fail-closed (service +
      executor) rejecting `wait_for_callback` / nested `condition_branch` in branches; exclusive
      first-match-or-`defaultBranch`; C1 parent/selected-child/downstream lineage (no 2nd status vocab).
      Real-DB lineage seam gates via the blocking `plugin-tests.yml` targeted step.
- [x] A6-3-2a `condition_branch` frontend builder — LANDED #2339 `960ea9315`
      (2026-06-06): form-based branch builder, flat per-branch conditions, `update_record` /
      `send_notification` branch action subset, read-only never-flatten guard for richer loaded
      shapes, branch-key validation, and `workflow_job_v1` auto-lock.
- [x] A6-3-2b `condition_branch` admin-runs readability — LANDED #2348 `4b44f25c6`
      (2026-06-06): selected branch shows `label (key)` when present, branch child jobs are
      grouped via nested step keys, and raw branch-selection output is suppressed in favour of the
      readable line.
- [x] A6-3 v1 operator/API/UI trial — PASS #2367/#2371; no A6-3-3 demand surfaced.
- [x] A6-3-3 branch-local wait scope-gate — `multitable-automation-a6-3-3-branch-local-wait-scope-gate-20260615.md`: high-amount review scenario; branch-local `wait_for_callback` only; nested branch/parallel/start_approval, public webhook, join-any, W7, and live BPMN remain out of scope.
- [ ] A6-3-3a backend runtime — not started; must add a nested resume cursor / step-key-aware suspended descriptor, branch-path drift guard, and real-DB high-amount scenario tests before frontend.
- [ ] A6-3-3b frontend authoring/readability — not started; may allow branch-local `wait_for_callback` only after backend contract lands; loaded richer shapes still read-only/never-flatten.
- [x] A6-3-4 / W3-0 parallel fan-out + join-all scope-gate — `multitable-automation-a6-3-parallel-join-all-scope-gate-20260611.md`: `parallel_branch`, `joinMode: all` only, C1 fan-out/fan-in graph, fail/skip semantics, and no BPMN/approval/webhook expansion.
- [x] A6-3-4 / W3-1 parallel fan-out + join-all runtime — LANDED #2496 `b161080b8` (2026-06-11): canonical `parallel_branch` action, `joinMode: all`, service/executor fail-closed validation, C1 parent/branch-child fan-out/fan-in lineage, fail/skip aggregation, and real-DB seam tests.
- [x] A6-3-4 frontend and admin-runs readability — LANDED #2500 `4408239d0` + #2501 `88f5f538a` (2026-06-12): editor authoring for `parallel_branch` with workflow-job auto-lock and admin runs detail showing branch labels/child jobs. **A6-3-4/W3 join-all closed end-to-end.**
- [ ] A6-3-5 join-any / cancellation semantics — gated after join-all runtime.
- [x] A6-4 / W8 BPMN compile/preview scope-gate — `multitable-automation-a6-4-bpmn-compile-preview-scope-gate-20260612.md`: side-effect-free preview + deterministic gap report only; no live BPMN runtime, no deploy/start, no persistence.
- [x] A6-4a implementation plan — `multitable-automation-a6-4a-bpmn-compile-preview-implementation-plan-20260612.md`: first implementation PR had to be a pure compiler module + unit tests only; the route was split into A6-4b and later landed in #2577; no `BPMNWorkflowEngine` import.
- [x] A6-4a BPMN compile/preview pure compiler — LANDED #2568 `0f214a222` (2026-06-13): adds `bpmnCompilePreview` + unit tests only; maps gateways to existing A6-3 `condition_branch` / `parallel_branch` primitives; deterministic mapping/gap reports; no route, DB write, persistence, deploy/start, or live BPMN runtime.
- [x] A6-4b read-only BPMN compile/preview route — LANDED #2577 `b5646fa71` (2026-06-13): exposes `POST /api/workflow-designer/workflows/:id/compile-preview`; loads visual or BPMN XML drafts read-only; preserves source-mode semantics; calls the pure compiler; no persistence, deploy/start, test execution, or live BPMN runtime.
- [x] A6-4c Workflow Designer compile-preview UI — LANDED #2604: read-only dialog consuming the A6-4b route; renders source mode, mapping/gap reports, and backend-redacted automation actions + approval graph as collapsible JSON; no deploy/start/persist; stale-response guarded via a request-id composable.
- [x] A6-5 / W6-1 `start_approval` approval-as-job bridge — LANDED #2469: creates one approval instance from a published template, persists the bridge row, writes suspended / terminal C1 jobs, resumes/fails from W5 completion events, and guards A5 retry duplicates.
- [x] W7-0 approval result backwrite scope-gate — `automation-approval-result-backwrite-scope-gate-20260611.md`: explicit mapping only; durable idempotent attempt state; permission/field guards; no approval form/comment/profile leakage; runtime remains gated.
- [ ] W7-1 approval result backwrite runtime — not started; waits for W6 operator smoke (#2480 + `automation-start-approval-operator-smoke-runbook-20260613.md`) or named runtime unlock.
