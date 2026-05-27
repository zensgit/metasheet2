# Multitable Automation Run Governance TODO

Date: 2026-05-27
Scope: multitable automation run governance only (the "governance half")
Status: proposed
Companion: multitable-automation-run-governance-development-20260527.md
Depends on (landed): C1 contract workflow-job-contract.ts (#1889, not-wired); RFC #1885

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
frozen, demand-gated separate track (see A6 + RFC #1885 + contract #1889).

## Scope Boundary

This line improves automation execution observability, and aligns its data model
with the landed C1 WorkflowJob contract (#1889) by boundary mapping — NOT by
changing storage and NOT by persisting jobs.

It does not unlock:

- approval_trigger_bindings / approval result backwrite / automation start_approval
- approval completion event bridge
- persistent automation_jobs runtime
- suspend/resume, branch/parallel, cross-engine orchestration
- Workflow Designer / BPMN live execution mapping

K3 stage-1 lock remains in effect. Each item above is a separate named unlock.

## Lock posture (per milestone)

- A0: docs-only, can do now.
- A1 / A2 / A3: S1 observability — low risk, but each still a NAMED UNLOCK
  (explicit opt-in; not "read-only so no review needed").
- A4: docs only (design); A5 runtime gated/frozen.
- A6: docs only; all runtime frozen / demand-gated.

## Current Baseline

Already present:

- automation_rules CRUD
- AutomationExecutor sequential action execution (status: success|failed|skipped per step)
- multitable_automation_executions table (execution status: running|success|failed|skipped)
- per-rule logs/stats/test API
- frontend MetaAutomationLogViewer
- frontend redacted support packet utility
- scheduler leader lock for in-memory timers
- DingTalk-specific redactor in executor (redactDingTalkFailureAlertText) — to be CONSOLIDATED, not extended
- C1 WorkflowJob contract (workflow-job-contract.ts, #1889) — LANDED, NOT WIRED
  (WorkflowJobStatus 8-state; legacyAutomationStatusToJobStatus: success->resolved, rest identity)

Missing (governance half — this line):

- execution trigger_event snapshot (redacted)
- rule_snapshot at execution time (redacted)
- finished_at, schema_version
- write-time redaction of step.output / step.error (currently raw except DingTalk path)
- cross-rule Automation Runs API (status via C1 bridge; steps via toWorkflowJobView)
- execution detail API

Deferred (capability half — A6, frozen/demand-gated):

- persistent automation_jobs runtime; suspend/resume; branch/parallel
- BPMN compile/preview adapter; approval-as-job bridge

## Milestones

### A0 — Scope Gate and TODO  (lock: docs-only, now)

- [ ] Add this TODO MD (incl. two-gate doctrine + per-milestone lock posture).
- [ ] Add development MD for run governance.
- [ ] State approval Phase 2 downstream items stay frozen.
- [ ] State retry is not part of A1/A2/A3 runtime (A4 gate / A5 runtime).
- [ ] Register the capability half (A6) as frozen/demand-gated; reference #1885 / #1889.

Acceptance:

- [ ] Docs-only diff.
- [ ] No runtime, migration, route, or UI changes.

### A1 — Execution Snapshot Foundation  (lock: S1 named unlock)

Migration — add ONLY columns A1 populates with a real value now:

- [ ] sheet_id TEXT
- [ ] trigger_event JSONB        (redacted at write)
- [ ] rule_snapshot JSONB        (redacted at write)
- [ ] finished_at TIMESTAMPTZ NULL
- [ ] schema_version INT NOT NULL DEFAULT 1
- [ ] DO NOT add rerun_of_execution_id  (-> A5)
- [ ] DO NOT add created_by/initiated_by (-> A5, only if execute path can pass the actor)

Steps storage:

- [ ] Keep legacy AutomationStepResult[] UNCHANGED.
- [ ] Do NOT persist a workflowJob sub-object.
- [ ] Do NOT add upstreamStepKey/branchIndex graph columns (-> A6).

Redaction (BEFORE persist, not at read):

- [ ] Redact rule_snapshot (headers.authorization, URL query token, secret, ...).
- [ ] Redact trigger_event.
- [ ] Redact step.output AND step.error (the third channel: responseBody / generic error text).
- [ ] Redaction = secret-shaped value scrub; PRESERVE business field values (diagnosis).
- [ ] Business-field / PII masking is OUT of A1 scope -> open question decided at A4 gate.
- [ ] Use ONE multitable/core redaction helper: reuse support-packet util or promote a
      core shared helper; CONSOLIDATE the existing DingTalk-specific executor redactor.
- [ ] Do NOT reverse-import integration-core/lib/payload-redaction.cjs (domain boundary).

Wiring:

- [ ] AutomationService.executeRule() passes sheetId, triggerEvent, current rule snapshot.
- [ ] AutomationLogService.record() persists redacted snapshot + finished_at + schema_version.
- [ ] Preserve existing logs/stats/test API shapes.
- [ ] Storage status stays legacy 4-state (no hot-path/status rewrite).

Acceptance:

- [ ] Existing automation unit tests pass.
- [ ] Test proves trigger_event / rule_snapshot persist.
- [ ] Test proves secret-shaped values in rule_snapshot / trigger_event / step.output /
      step.error are scrubbed at write, AND business field values are preserved.
- [ ] Test proves no new redactor is introduced; DingTalk path uses the consolidated helper.
- [ ] Old rows with null snapshot fields still map safely (schema_version defaults 1).

### A2 — Read-only Automation Runs API  (lock: S1 named unlock)

- [ ] Add GET /api/multitable/automation-executions (filters: sheetId, status, ruleId, limit; clamp 1..200).
- [ ] Add GET /api/multitable/automation-executions/:executionId (404 on missing).
- [ ] Emit execution status as WorkflowJobStatus via legacyAutomationStatusToJobStatus(); optional statusLegacy.
- [ ] Add toWorkflowJobView(execution, step, index):
        id = `${execution.id}:step:${index}`
        executionId = execution.id
        stepKey = String(index)
        status = legacyAutomationStatusToJobStatus(step.status)   // direct; no no-op ternary
        upstreamJobId = index > 0 ? `${execution.id}:step:${index-1}` : null
        result = step.output ; error = step.error   // already redacted at write (A1)
- [ ] status= filter: C1 canonical (advertised), legacy accepted as migration grace.
- [ ] Future statuses (queued/suspended/rejected/errored): legal but EMPTY result (not 400).
- [ ] Do not add retry endpoint.

Acceptance:

- [ ] Route tests: list/detail/filter/limit/not-found.
- [ ] Test: toWorkflowJobView output passes C1 normalizeWorkflowJob() (not raw DB step).
- [ ] Test: execution status emitted as C1 (success -> resolved).
- [ ] Test: status= accepts both vocabularies; future-state filter returns empty (not 400).
- [ ] Existing per-rule logs/stats/test shape unchanged.

### A3 — Frontend Runs View  (lock: S1 named unlock)

- [ ] Client methods for runs list/detail.
- [ ] Read-only runs list UI (filter status/rule/sheet; show finished_at).
- [ ] Status labels from shared WorkflowJobStatus i18n keys.
- [ ] Reuse support-packet renderer; expandable steps (C1 view).
- [ ] Retry shown unavailable or omitted.

Acceptance:

- [ ] UI tests: loading, empty, failed filter, expanded steps.
- [ ] Existing MetaAutomationLogViewer tests still pass.

### A4 — Retry Scope Gate  (lock: design only)

- [ ] Decide retry source: rule_snapshot vs current rule (default rule_snapshot).
- [ ] Decide side-effect confirmation UX (explicit action / idempotency key).
- [ ] Define audit fields + permission requirement + deleted-rule failure behavior.
- [ ] State retry = degenerate case of future resume (A6); reuse resume path later.
- [ ] DECIDE the A1-flagged open question: business-field/PII masking in replayed snapshots.

### A5 — Whole-execution Retry  (lock: runtime gated)

- [ ] Migration: add rerun_of_execution_id TEXT NULL, initiated_by TEXT NULL (writers exist now).
- [ ] Add POST /api/multitable/automation-executions/:executionId/retry.
- [ ] Reconstruct executor rule from rule_snapshot; reuse trigger_event.
- [ ] Persist new execution; link via rerun_of_execution_id; record initiated_by.

Acceptance:

- [ ] Failed/skipped retry creates new execution id; original unchanged.
- [ ] Success and failed retry both persist logs.
- [ ] Retry rejects success/running executions.

### A6 — Capability-half Bridge  (lock: design only, frozen / demand-gated)

- [ ] Record convergence sequence: persist job -> suspend/resume [webhook before delay]
      -> branch/parallel -> BPMN compile/preview adapter -> approval-as-job.
- [ ] Each step references a concrete integration use-case before unlock (demand gate).
- [ ] Graph fields (upstreamStepKey/branchIndex) introduced HERE, not in A1.
- [ ] Governance inheritance: any capability reuses this line's
      run/job/status/provenance/redaction/replay substrate (no second-class layer).
- [ ] No runtime in this milestone.
