# Multitable Automation A6-3-3a Branch-Local Wait — Runtime + Verification (2026-06-15)

Status: backend runtime COMPLETE; verified against real Postgres. PR #2626 (draft).
Branch: `runtime/a6-3-3a-runtime-20260615`.

Scope gate (acceptance source):
`docs/development/multitable-automation-a6-3-3-branch-local-wait-scope-gate-20260615.md`.

A6-3-3a allows exactly one new nested shape — a `wait_for_callback` inside the
SELECTED `condition_branch` path — so that only that branch suspends while
ordinary branches finish without waiting. It is built strictly on top of the
landed A6-2 suspend/resume and A6-3-1 `condition_branch` runtime. Out-of-scope
shapes stay rejected: nested `condition_branch`, `parallel_branch`, and
branch-local `start_approval` inside a branch; no public webhook/callback
endpoint or token emitter; no delay/timer resume; no `join_any`; no W7 approval
result backwrite; no BPMN live runtime.

## 1. Runtime, slice by slice

| Slice | Commit | What it does |
|---|---|---|
| 1 — resume-cursor parser | `ca73f0b69` | New `automation-resume-cursor.ts`: `ConditionBranchResumeCursor` + `parseResumeCursor`. Discriminated result `top_level` / `condition_branch` / `invalid`. NULL/absent → `top_level`; a valid cursor → use it. |
| 1.x — parser fail-open close | `0c6cd4bfd` | A non-null cursor OBJECT is NEVER the top-level path. A corrupt `{kind:'top_level'}`, an array, or any unknown kind → `invalid` (fail closed) — so a corrupted branch suspension can never silently resume at the top-level `step_index`. |
| 2 — suspension/job persistence | `4031b95b3` | `automation-suspension-service.ts` `createBranchLocal()` writes the suspension row WITH `resume_cursor` + a suspended branch-child job, atomically; `mapRow` parses the cursor into `SuspensionRow.resumeCursor`. `automation-job-service.ts` `writeSuspendedBranchJob()` writes the wait job by `cursor.stepKey` / `cursor.branchJobId` (inside the condition_branch lineage, not the top-level index). Migration `zzzz20260615120000_add_automation_suspension_resume_cursor.ts` adds the nullable `resume_cursor jsonb` column. |
| 3 — executor suspend + validator relax | `7213c3893` | `automation-executor.ts` `executeConditionBranch` suspends on a branch-local `wait_for_callback`: builds the cursor (parent index + branch key + branch action index + step key + parent/branch/upstream job ids + `branchActionFingerprint`) and calls `onSuspendBranch`. `validateConditionBranchConfig` now ALLOWS branch-local `wait_for_callback` (condition_branch already forces `workflow_job_v1`) while still rejecting nested `condition_branch`, `parallel_branch`, and `start_approval` inside a branch. |
| 3.5 — resume-cursor fail-closed gate | `c2854f79d` | `automation-service.ts` `resumeExecution()` dispatches on the parsed cursor: `invalid` → `409 SUSPENSION_CURSOR_INVALID` (never a top-level fallback). |
| 4 — branch-aware resume orchestration | `199fdcffb` | `resumeExecution` adds the branch fingerprint drift guard BEFORE the token claim, then routes a `condition_branch` cursor to `continueBranchExecution`. `continueBranchExecution` settles the branch wait → runs the branch tail → settles the parent → runs the top-level tail (scope-gate §4.3). |
| 4.x — skipped-job fix | `e29199da6` | On a resumed branch-tail failure, `continueBranchExecution` writes `skipped` C1 jobs for the REMAINING branch children AND the REMAINING top-level actions (mirrors the initial `executeConditionBranch` / `executeActions` fail-stop) so the job plane is complete instead of leaving downstream work invisible. |
| 4.y — pre-claim cursor-binding guard | `98ef122a5` | `resumeExecution` also requires (pre-claim) that the cursor points at a `wait_for_callback` AND carries the deterministic ids (`stepKey` / `parentJobId` / `branchJobId` / `upstreamJobId`) for its branch position — a structurally-valid cursor at a non-wait action with tampered-consistent ids would otherwise claim the token and settle a non-wait action as the wait. → `409 SUSPENSION_CURSOR_INVALID`. |
| 5a — `listByExecution` stepKey hydration | `bd3e472dc` | `automation-job-service.ts` `listByExecution()` now hydrates the C1 suspend descriptor by job `step_key`, not top-level `step_index`. See §2. |
| 5b — real-DB high-amount E2E | `8c2242fc9` | `tests/integration/multitable-automation-branch-local-wait.test.ts` — the un-draft gate. See §4. |
| 5c — this verification doc | (this commit) | Records the runtime + the exact verification evidence. |

## 2. Slice 5a — the stepKey hydration fix (③)

### 2.1 The bug it closes

A branch-local suspension stores, on the suspension row, `step_index =
parentStepIndex` (so the existing top-level locators keep working) AND a
non-null `resume_cursor` whose `stepKey` (e.g. `2.branch.high_amount.1`)
identifies the suspended branch CHILD job. The top-level `condition_branch`
PARENT job shares that same `step_index` (its key is `String(parentStepIndex)`,
e.g. `"2"`, and it stays `running` while suspended).

The pre-5a `listByExecution` built a `Map<number, descriptor>` keyed by
`step_index` and attached the descriptor to any `suspended` row by `step_index`.
Two problems:

1. Keying by `step_index` could attach a branch descriptor to the wrong job at
   the same index. (In the in-scope happy path the parent is `running`, not
   `suspended`, so it is incidentally safe — but the keying is wrong in
   principle and §7 requires keying by `stepKey`.)
2. With two `suspended` rows at the same `step_index` and distinct `stepKey`,
   `Map` overwrite means every suspended sibling collapses to the LAST token.

### 2.2 The fix

One map keyed by the job `step_key` string:

- Select `resume_cursor` alongside `step_index, reason, resume_token`, run it
  through the existing `parseResumeCursor` (same string-or-object normalization
  as `mapRow`), and key by
  `parsed.kind === 'condition_branch' ? parsed.cursor.stepKey : String(step_index)`.
- Key approval-bridge entries by `String(bridge.step_index)` (`start_approval`
  is always top-level → its job's `step_key` is `String(stepIndex)`).
- In `rows.map`, look up `suspendByStepKey.get(row.step_key)` under the same
  `status === 'suspended'` guard.

This is correct for all three job families at once: a top-level suspended job's
`step_key` is `String(step_index)`; a branch child's is `cursor.stepKey`; the
parent's `"2"` is never a branch suspension key, so the descriptor can never
land on the parent `condition_branch` job. A corrupt non-null cursor parses to
`invalid` and falls back to `String(step_index)` — the real suspended branch
child then stays descriptor-less (fail-closed); the verification keeps the
invalid-cursor case to the `resumeExecution` → 409 path and does not call
`listByExecution` on it.

## 3. How it satisfies the scope gate

### §4 Runtime shape

- §4.1 suspension cursor — slices 1/1.x/2: the nullable structured cursor
  (`parentStepIndex` / `branchKey` / `branchActionIndex` / `stepKey` /
  `parentJobId` / `branchJobId` / `upstreamJobId` / `branchActionFingerprint`),
  NULL = legacy top-level, non-null-but-malformed = invalid.
- §4.2 job state while suspended — verified by the HAPPY-high E2E: execution
  `running`, parent `condition_branch` job `running`, prior branch child
  (notify) `resolved`, branch wait child `suspended`, downstream branch + top
  level absent.
- §4.3 resume semantics — slices 4/4.x: load by token → validate `pending` →
  current rule + enabled → top-level fingerprint → branch fingerprint → cursor
  binding (points at a `wait_for_callback` + deterministic stepKey/job ids)
  → re-fetch record → read execution before claim → single-use claim → settle
  branch wait → branch tail → settle parent → top-level tail.

### §5 Failure matrix

| Case | Expected | Where verified |
|---|---|---|
| current rule missing/disabled | `409 RULE_MISSING_OR_DISABLED`, token kept | resumeExecution (shared A6-2 path; covered by suspend-resume T7) |
| top-level action fingerprint changed | `409 RULE_CHANGED`, token kept | resumeExecution (shared; suspend-resume T8) |
| selected branch path changed / key removed | `409 RULE_CHANGED`, token kept | E2E `drift guard before claim` |
| corrupt non-null resume cursor | `409 SUSPENSION_CURSOR_INVALID`, token kept | E2E `invalid cursor` |
| structurally-valid cursor at a non-wait action / inconsistent derived ids | `409 SUSPENSION_CURSOR_INVALID`, token kept, no job settles | E2E `semantic-corrupt cursor` |
| record deleted while waiting | `404 RECORD_GONE`, token kept | resumeExecution (shared; suspend-resume T9) |
| second resume | `409 ALREADY_RESUMED` | E2E `second resume` |
| post-claim branch-tail failure | execution terminal `failed`; remaining branch + top-level jobs `skipped` | E2E `branch-tail failure on resume` |
| non-selected branch contains wait | no suspension | covered by A6-3-1 selection semantics (only the selected branch runs) |

### §6 Acceptance scenario

The E2E uses a real-DB rule with one `condition_branch` (low `amount ≤ 100000`
→ `update_record status=auto_approved`; high `amount > 100000` →
`send_notification`, `wait_for_callback`, `update_record
status=approved_after_review`) plus a top-level `update_record` tail. LOW
finishes (auto_approved, no suspension); HIGH suspends at the branch wait and
resumes to `approved_after_review`. Matches §6 steps 1–7.

### §7 Required tests (backend runtime PR)

- service validation accepts branch-local `wait_for_callback` only in
  `workflow_job_v1` rules (condition_branch forces `workflow_job_v1`), and
  `validateConditionBranchConfig` still rejects nested `condition_branch` /
  `parallel_branch` / branch-local `start_approval`. `parallel_branch` and
  `start_approval` branch rejections are unit-asserted in
  `tests/unit/automation-v1.test.ts` (`cannot contain parallel_branch ...`,
  `cannot contain start_approval until A6-3-3`); the nested `condition_branch`
  rejection is enforced by the validator (lines 261/289) and the executor branch
  loop. 203 unit tests green.
- executor suspends a selected branch-local wait and does not run later branch
  actions before resume — E2E `HAPPY-high suspends`.
- resume continues the selected branch tail then the top-level tail — E2E
  `HAPPY-high resume`.
- stale top-level fingerprint fails closed; stale selected branch fingerprint
  fails closed; second resume already-resumed; record-gone 404 — §5 table.
- **`listByExecution()` hydrates the suspend descriptor by branch `stepKey` and
  never attaches it to the parent branch job by top-level `step_index`** — E2E
  `descriptor-on-stepKey` (placement) + `stepKey disambiguation` (the
  discriminating proof, §VERIFICATION).

## VERIFICATION (exact evidence, 2026-06-15)

Environment: local Postgres `metasheet_test`, OS-user owner, trust TCP.
`DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet_test`.

### Migrations

`pnpm --filter @metasheet/core-backend migrate` (with the DATABASE_URL above) →
`migration "zzzz20260615120000_add_automation_suspension_resume_cursor" was
executed successfully`. Confirmed the `resume_cursor jsonb` (nullable) column
exists on `multitable_automation_suspensions`.

### Type-check

`pnpm exec tsc --noEmit -p packages/core-backend/tsconfig.json` → exit 0, no
output. Clean (with both slice 5a source and the slice 5b test present).

### Unit tests

`vitest run tests/unit/automation-v1.test.ts tests/unit/automation-runs-api.test.ts`
→ **203 passed** (2 files; automation-v1 = 179, automation-runs-api = 24). The
`error: ... jsonb insert failed` log line is an intentional error-path fixture,
not a failure.

### Real-DB E2E (the un-draft gate)

Command:

```
DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet_test \
pnpm --filter @metasheet/core-backend exec vitest \
  --config vitest.integration.config.ts run \
  tests/integration/multitable-automation-branch-local-wait.test.ts
```

Result: **11 passed (11)** — the `describeIfDatabase` sentinel test confirms
`DATABASE_URL` is set, so the suite actually RAN (not skipped). Each assertion
shape:

| # | Test | Result | Key assertions |
|---|---|---|---|
| HAPPY-low | low branch, no suspension | PASS | execution `success`; 0 suspension rows; 0 suspended jobs; record `status=auto_approved` |
| HAPPY-high suspends | selected branch suspends | PASS | execution `running`; suspension `pending`, `step_index=0`, branch cursor `{branchKey:high_amount, branchActionIndex:1, stepKey:0.branch.high_amount.1}`; parent job `0` = `condition_branch`/`running`; `0.branch.high_amount.0` = `send_notification`/`resolved`; `0.branch.high_amount.1` = `wait_for_callback`/`suspended`; `0.branch.high_amount.2` absent; top-level `1` absent; record not yet `approved_after_review` |
| descriptor-on-stepKey | §7 placement | PASS | `listByExecution`: parent `0` is `running` with NO `suspend` descriptor; branch child `0.branch.high_amount.1` is `suspended` with a valid C1 `suspend.resumeToken` (passes `normalizeWorkflowJob`) |
| stepKey disambiguation | §7 discriminating proof (③) | PASS | two `suspended` jobs at the SAME `step_index=2` with distinct stepKeys (`2.branch.b1.0`, `2.branch.b2.0`) + distinct tokens → each job keeps ITS OWN token (`tok_b1`, `tok_b2`) |
| HAPPY-high resume | §4.3 / §6.7 | PASS | resume returns `execution`, `success`, `initiatedBy=admin_resume`; jobs `0`/`0.branch.high_amount.0..2`/`1` all `resolved`; record `status=approved_after_review`; suspension `resumed` |
| drift guard before claim | §5 branch drift | PASS | mutate SELECTED branch actions only (top-level fingerprint stays equal) → `409 RULE_CHANGED`; suspension still `pending` |
| invalid cursor | §5 fail-closed | PASS | corrupt `resume_cursor` to `{kind:'top_level'}` → `409 SUSPENSION_CURSOR_INVALID`; suspension still `pending` (token NOT claimed) |
| semantic-corrupt cursor | §5 cursor binding | PASS | valid-shaped cursor re-pointed at index 0 (send_notification) + consistent ids + unchanged branch fingerprint → `409 SUSPENSION_CURSOR_INVALID`; suspension `pending`; branch wait child `0.branch.high_amount.1` stays `suspended` (no settle) |
| second resume | §5 single-use | PASS | first resume succeeds; second → `409 ALREADY_RESUMED` |
| branch-tail failure on resume | §5 + slice-4 | PASS | post-wait `send_webhook` returns 500 → execution terminal `failed`; `0.branch.high_amount.2`=`failed`; remaining branch child `0.branch.high_amount.3`=`skipped`; parent `0`=`failed`; remaining top-level `1`=`skipped`; record never `should_not_run` |

### Discrimination proof for slice 5a (does the §7 test actually catch the bug?)

To confirm the `stepKey disambiguation` test is non-vacuous, I temporarily
reverted `listByExecution` keying to the OLD `step_index` form and re-ran only
that test:

```
× stepKey disambiguation ...
  → expected 'tok_b2' to be 'tok_b1' // Object.is equality
```

Both suspended siblings collapsed to the last-inserted token (`tok_b2`) — the
exact bug slice 5a fixes. The source was then restored to the stepKey keying and
the full suite re-run **10/10 green**. (The happy-path `descriptor-on-stepKey`
test is parent-safe regardless of keying because the parent stays `running`; the
disambiguation test is what discriminates the fix.)

### No regression (shared `listByExecution`)

`vitest --config vitest.integration.config.ts run` over the new E2E +
`multitable-automation-suspend-resume.test.ts` + `multitable-automation-jobs.test.ts`
(all share `listByExecution`) → **30 passed (30)** (11 + 11 + 8).

## Out-of-scope (still rejected, by design)

- nested `condition_branch` inside a branch → rejected at rule save and in the
  executor branch loop;
- `parallel_branch` inside a branch → rejected at rule save;
- branch-local `start_approval` → rejected at rule save;
- no public webhook/callback endpoint, no token emitter (the resume token's only
  read surface remains the admin-gated execution detail);
- no delay/timer resume, no `join_any`, no W7 approval result backwrite, no BPMN
  live runtime.

## Re-entry

A6-3-3b (editor support + admin-runs readability tests) is a separate explicit
opt-in PR after this backend runtime lands. The PR (#2626) stays draft until the
owner reviews this verification.
