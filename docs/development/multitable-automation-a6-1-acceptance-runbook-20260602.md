# A6-1 Acceptance Smoke Runbook — 2026-06-02

> Type: **operator acceptance runbook** (上线验收). A small, manual verification loop proving the
> A6-1 chain is usable end-to-end on a real environment. This is NOT new capability — it proves the
> shipped chain (runtime #2130 + enable-writer #2191 + admin UI toggle #2193) actually works wire-to-DB.
> Design/status live in `…-a6-execution-plan-20260601.md` / `…-run-governance-todo-20260527.md`.

## Why a runbook (not only a test)

The chain is already covered hop-by-hop by automated tests:
- every-PR unit: editor toggle → save emits `executionMode` (#2193 editor spec); rule create/update
  carries + persists `execution_mode` and rejects invalid (#2191 unit); opt-in rule routes to the
  job-persisting executor path (#2130 unit); A2 prefers persisted jobs.
- CI real-DB (`plugin-tests.yml` DB job): `AutomationJobService` lifecycle → jobs + `listByExecution`
  C1 views (#2130); `createRule(execution_mode)` → `getRule` round-trip on real Postgres (#2191).

What no automated test ties together is the **live full loop through the UI + a real triggered run +
the admin runs view**. That is environment-bound (needs a running stack), so it is an operator smoke.

## Preconditions

- Backend on `:8900` + Postgres (migrations applied) + frontend on `:8899` (`pnpm docker:dev` for
  local DB/Redis, then `pnpm --filter @metasheet/core-backend dev` and `pnpm dev`).
- An admin / `canManageAutomation` user, and a multitable sheet you can create records in.

## Smoke loop (opt-IN → jobs persist → C1 visible)

1. **UI — enable the opt-in.** Open the sheet → Automation manager → create/edit a rule. Set a simple
   trigger (e.g. `record.created`) and one action. **Check the toggle** "Persist a per-action run
   record (advanced)" / "持久化每步运行记录（高级）" (`data-field="executionMode"`). **Save.**
2. **Confirm it persisted.** `GET /api/multitable/sheets/:sheetId/automations` → the rule's
   `executionMode` is `"workflow_job_v1"` (not null). (Or DB: `SELECT execution_mode FROM
   automation_rules WHERE id = '<ruleId>'` → `workflow_job_v1`.)
3. **Trigger one run.** Perform the action that fires the trigger (e.g. create a record in the sheet).
4. **DB — jobs persisted.** Find the execution, then:
   ```sql
   SELECT id FROM multitable_automation_executions WHERE rule_id = '<ruleId>' ORDER BY triggered_at DESC LIMIT 1;
   SELECT step_index, action_type, status, upstream_job_id
   FROM multitable_automation_jobs WHERE execution_id = '<executionId>' ORDER BY step_index;
   ```
   **Expect ≥1 job row** (one per action; `onStart` writes a `running` job before the action, then it
   settles to a C1 status `resolved`/`failed`/`skipped`). `result`/`error` are redacted.
5. **A2/A3 — C1 steps visible.** As admin, open `/admin/automation-executions` (or
   `GET /api/multitable/automation-executions/:executionId`) → the run renders its **C1 WorkflowJob
   steps from the persisted jobs** (prefer-jobs path), statuses mapped via the C1 bridge.

## Reverse check (opt-OUT → no jobs, unchanged behavior)

6. Either uncheck the toggle on a rule and save (→ `executionMode` null), or use a legacy rule. Trigger
   a run. **Expect ZERO new rows** in `multitable_automation_jobs` for that execution, and the admin
   runs view falls back to the legacy `steps` shape. This proves existing fire-and-forget rules are
   untouched (default off).

## Pass criteria

- Opt-in: toggle persists `workflow_job_v1`; a triggered run writes ≥1 `multitable_automation_jobs`
  row; the admin runs view shows the C1 step(s).
- Opt-out: no job rows; legacy step rendering unchanged.
- Secrets in `result`/`error` appear redacted (A1 invariant), never raw.

If all pass, A6-1 is verified **operable**, not just dev-complete. A6-2 (suspend/resume) and beyond
remain demand-gated — open only on a named human-in-the-loop use-case (webhook/external resume FIRST,
not delay/timer).
