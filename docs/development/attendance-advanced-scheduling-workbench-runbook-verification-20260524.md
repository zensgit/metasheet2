# Attendance Advanced Scheduling Workbench Runbook — Verification

**Date:** 2026-05-24
**Slice:** Operator runbook for the existing read-only advanced-scheduling workbench
**Type:** docs-only

## Scope claim

This slice adds **two new files** under `docs/`. It does not modify, add, or
remove any runtime file, test, configuration, migration, workflow, or
package.json manifest.

| File | Type |
| --- | --- |
| `docs/operations/attendance-advanced-scheduling-workbench-runbook.md` | new operator runbook |
| `docs/development/attendance-advanced-scheduling-workbench-runbook-verification-20260524.md` | this verification MD |

## Contract grounding

The runbook content was grounded against actual code on `origin/main`. The
following anchors were verified before drafting:

| Asserted in runbook | Grounded against |
| --- | --- |
| Route `GET /api/attendance/advanced-scheduling/workbench`, permission `attendance:admin`, GET-only | `plugins/plugin-attendance/index.cjs` line ~25790 (`addRoute('GET', ...)`); backend test `packages/core-backend/tests/unit/attendance-advanced-scheduling-workbench.test.ts` asserts absence of POST/PUT/DELETE |
| Response shape `{ range, summary, scheduleGroups, schedulerScopes, diagnostics, metadata }` | `plugins/plugin-attendance/index.cjs` workbench builder around line 7660 |
| `metadata.readOnly === true` and `metadata.source === 'attendance_advanced_scheduling_workbench'` | same workbench builder |
| Date validation: `VALIDATION_ERROR` on malformed `from` / `to` and on inverted range | route handler ~line 25790 |
| Summary metric field names | response shape at workbench builder return |
| Five diagnostic codes (severity + message verbatim) | `plugins/plugin-attendance/index.cjs` line 7588-7635 (each `buildAttendanceAdvancedSchedulingDiagnostic` call) |
| Truncation contract: aggregates accurate, sample list truncated at 500 | constant `ATTENDANCE_ADVANCED_SCHEDULING_WORKBENCH_ASSIGNMENT_LIMIT = 500` at line 7481; SQL aggregates feed `assignmentAggregates` / `scheduleGroupAssignmentAggregates`, **not** the sampled rows |

The runbook does **not** speculate about data shapes that are not in the
code; every claim has a corresponding callsite reference.

## Static checks

### `git status --short` (worktree, before staging)

```
(only the two new files appear under ?? — no M lines)
```

### `git diff --cached --name-only` (after explicit `git add` of the two files)

```
docs/development/attendance-advanced-scheduling-workbench-runbook-verification-20260524.md
docs/operations/attendance-advanced-scheduling-workbench-runbook.md
```

Exactly two staged paths. No `git add -A` was used.

### `git diff --cached --check`

```
exit 0  (no whitespace or merge-conflict markers)
```

### Staged secret / home-path scan (all five patterns must be 0)

```
JWT-literal           : 0   (regex: eyJ[A-Za-z0-9_-]{20,})
Bearer-literal        : 0   (regex: Bearer[[:space:]]+[A-Za-z0-9_.-]{20,})
private-key-block     : 0   (regex: ^-----BEGIN)
user-home-path        : 0   (regex: /Users/<username>)
token-literal         : 0   (regex: token[[:space:]]*[:=][[:space:]]*[\"'][A-Za-z0-9_.-]{20,})
```

The example commands in §6 of the runbook reference `AUTH_TOKEN_FILE` and
`cat "$AUTH_TOKEN_FILE"` indirection so no literal JWT is ever written to
the runbook. The deployment hostnames `23.254.236.11:8081` /
`23.254.236.11:8082` are publicly visible in earlier merged docs in this
repo and are not secrets.

## Boundary reaffirmation

| Boundary | Status |
| --- | --- |
| No `apps/` changes | confirmed via final `git diff --cached --name-only` |
| No `packages/` changes | confirmed |
| No `plugins/` changes | confirmed |
| No `migrations/` changes | confirmed |
| No `.github/workflows/` changes | confirmed |
| No `meta_*` writes | not applicable (docs-only) |
| No `attendance_*` writes | not applicable (docs-only) |
| No K3 / Data Factory / Bridge Agent touch | confirmed |
| PR6 (reporting / multitable snapshot) | **remains explicitly deferred**; the runbook says so in §5 |
| Grid edit / Excel import / temporary shift / dispatch / swap | **remain explicitly out of scope**; the runbook says so in §5 |
| Effective-calendar resolver | **remains the day-level precedence owner**; the runbook says so in §3.4 and §5 |
| #1802 benchmark matrix | **referenced** in §7 if/when authored; runbook does NOT require it to merge first |

## Where this fits in the chain

This slice sits in the kernel-polish lane per memory
`[[k3-poc-stage1-lock-no-new-fronts]]`:

- The underlying read-only workbench shipped earlier in the advanced-scheduling closeout (see #1755 / #1759 — referenced in the runbook §7).
- No write path is authorized by this runbook.
- The runbook documents an existing, already-deployed surface — it does not extend the codebase.

It pairs with — but does not depend on — any future "advanced scheduling
benchmark matrix" docs-only slice. The runbook is self-contained.

## Codex review round 1 — corrections applied

Round-1 Codex review (issuecomment-4527289086) returned `BLOCK` on three
documentation-accuracy points, all addressed in the follow-up commit on
this branch:

| # | Codex finding | Fix applied | Grounding |
| --- | --- | --- | --- |
| 1 | "UI loads only on Refresh click" was reversed — the workbench actually auto-loads as part of the Admin Center batch data load | Runbook §1 / UI section rewritten: auto-fires via `loadAdvancedSchedulingWorkbench()` inside the `Promise.all` admin-data batch; button is **Reload workbench / 重载工作台** (not "Refresh") | `apps/web/src/views/AttendanceView.vue:16051` (Promise.all call) and `:4388` (button label) |
| 2 | Table name `attendance_assignments` is wrong (3 occurrences in runbook); the real table is `attendance_shift_assignments` | All 3 occurrences corrected: §3.2 trigger, §3.4 trigger, §5 read-only list | `plugins/plugin-attendance/index.cjs` lines 10446, 10813, 25869, 25897, 25955, 26326, 26408, 26421, 26560, 26667 — all reference `attendance_shift_assignments` |
| 3 | "token never on the command line" over-promised; `$(cat "$AUTH_TOKEN_FILE")` substitutes into curl argv | Runbook §6 setup rewritten with an explicit secret-hygiene contract: "not printed, not committed, only read from 0600 file"; argv caveat is called out; `curl -H @<header-file>` tighter variant offered as drop-in. The bullet list at the end of §6 also corrected to remove the "never on the command line" phrase | n/a (docs-only wording fix) |

The fixes are docs-only and do not change the slice's scope, boundaries, or
PR6-deferred posture. CI re-runs against the same path-filter subset.

## Not done in this slice (intentionally)

- No code change.
- No new test.
- No production runtime smoke (the runbook already documents the safe live-check commands; an actual run requires an operator's local JWT and is out of CI scope).
- No staging E2E.
- No update to the `attendance-comprehensive-hours-pr0-pr5-closeout-20260523.md` "PR6 deferred" list (this slice is not PR6 work — PR6 remains untouched).
- No advanced-scheduling write path opt-in.
- No `[[staged-opt-in-lineage]]` ratchet forward — this is a docs sidecar, not the next link in any chain.

## Cross-references

- `plugins/plugin-attendance/index.cjs`
  - `~7481` — `ATTENDANCE_ADVANCED_SCHEDULING_WORKBENCH_ASSIGNMENT_LIMIT = 500`
  - `~7502` — truncation flag construction
  - `~7588 ... ~7635` — five diagnostic emitters
  - `~7660` — response assembly
  - `~25790` — route registration (`GET` only)
- `packages/core-backend/tests/unit/attendance-advanced-scheduling-workbench.test.ts`
  - asserts the five diagnostic codes
  - asserts absence of POST / PUT / DELETE on the route
- `apps/web/tests/attendance-admin-regressions.spec.ts`
  - exercises the admin-rail render path that consumes the GET response
- `docs/development/attendance-comprehensive-hours-pr0-pr5-closeout-20260523.md`
  - establishes the K3 PoC stage-1 lock + staged-opt-in discipline that this runbook respects
- `docs/operations/attendance-prod-env.md`
  - sibling operations doc; runbook follows the same style and secret-hygiene conventions

## Sign-off

Docs-only slice ready for Codex independent review. No autonomous merge.
