# Attendance Advanced Scheduling Group / Scheduler Scope Verification

Date: 2026-05-21
Branch: `codex/attendance-advanced-scheduling-benchmark-20260521`

## Scope

PR1 is design-only. It locks the next implementation boundaries for DingTalk-like
`排班班组` and `排班人` without changing runtime behavior.

| Area | Result |
| --- | --- |
| Runtime code | Not changed |
| Frontend code | Not changed |
| Migration | Not changed |
| `plugins/plugin-attendance/index.cjs` | Not changed |
| `attendance_*` fact writes | Not changed |
| Direct `meta_*` writes | Not changed |
| Data Factory / Bridge Agent | Not touched |

## Code Orientation Evidence

The design was checked against current `origin/main` implementation:

| Existing surface | Evidence | Design implication |
| --- | --- | --- |
| Attendance groups | `zzzz20260204123000_create_attendance_groups.ts` creates `attendance_groups` with `rule_set_id`, timezone, description, plus `attendance_group_members`. | Do not overload this model for scheduling groups; it already owns attendance policy semantics. |
| Attendance group routes | `plugins/plugin-attendance/index.cjs` exposes `/api/attendance/groups` CRUD with `attendance:admin`. | Scheduling groups need a separate route family and should not mutate attendance group membership. |
| RBAC | `createRbacHelpers()` checks `user_permissions`, `user_roles`, and `role_permissions`. | Scoped scheduler access should layer on top of RBAC; `attendance:admin` remains global. |
| Role context | Existing role/role-tag extraction supports calendar policy filters. | Scheduler scopes can reuse users/roles/roleTags, but must still fail closed on writes. |
| Conflict save guard | `attendance-scheduling-conflict-save-*` documents backend 409 conflict enforcement. | Future grid/bulk writes must not bypass the guard. |
| Operation audit | `operation_audit_logs` exists and is schema-hardened with `occurred_at` and `meta`. | v1 should reuse this audit table instead of introducing a parallel operation-log fact store. |
| Report multitable sync | report-records / period-summaries docs lock multitable as rebuildable report layer. | Future schedule snapshots may be multitable, but schedule truth remains SQL attendance models. |

## Design Decisions Verified

| Decision | Verification |
| --- | --- |
| `attendance_schedule_groups` separate from `attendance_groups` | Avoids mixing rule-set/timezone policy groups with operational scheduling groups. |
| Date-aware schedule group membership | Supports "who belonged to this schedule group on this day" for future grid and import previews. |
| Scoped scheduler table | Covers DingTalk `排班人` semantics: scheduler by user/role/role tag with explicit scope and action list. |
| `attendance:admin` bypass + scoped non-admin fail-closed | Preserves current admin behavior while preventing degraded RBAC from granting scheduling power. |
| `operation_audit_logs` reuse | Matches existing audit schema and avoids new fact-source drift. |
| Dense grid deferred | Prevents building UI before permission/scope ownership is known. |

## Verification Commands

```bash
git status --short
git diff --no-index --check /dev/null docs/development/attendance-advanced-scheduling-benchmark-todo-20260521.md
git diff --no-index --check /dev/null docs/development/attendance-advanced-scheduling-benchmark-verification-20260521.md
git diff --no-index --check /dev/null docs/development/attendance-advanced-scheduling-group-scope-design-20260521.md
git diff --no-index --check /dev/null docs/development/attendance-advanced-scheduling-group-scope-verification-20260521.md
```

Expected:

- `git status --short`: only four new markdown files.
- `git diff --no-index --check`: no whitespace diagnostics. Exit code `1`
  is expected because `/dev/null` differs from each new file.

## Acceptance Criteria

- Scheduling group is explicitly separate from attendance group.
- Scheduler scope model is explicit and action-scoped.
- Existing RBAC and `attendance:admin` behavior are preserved.
- Future writes have an operation-log contract.
- Future grid/bulk/import paths must go through backend conflict guards.
- The next coding PR can be either:
  - read-only `attendance_schedule_groups` descriptor/routes; or
  - schema migration + focused unit tests for schedule groups and scheduler
    scopes.
