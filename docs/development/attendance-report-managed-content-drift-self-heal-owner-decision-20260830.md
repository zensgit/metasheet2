# 考勤多维表托管内容漂移自愈 — Design Lock

> **Status: RATIFIED — IMPLEMENTATION AUTHORIZED**
>
> Ratified: 2026-08-31
>
> Implementation baseline: `origin/main@42d87e57f2e6be41b05d4ca12dd918196f94c0cf`

## 1. Problem

The daily and period attendance report writers currently skip an existing row when its
stored source and field fingerprints match the desired fingerprints. A writer can alter
a plugin-managed report cell without altering those fingerprint cells, leaving a report
projection that looks current while disagreeing with canonical attendance facts.

The report remains a one-way, rebuildable projection. It never becomes a source for
`attendance_*` facts.

## 2. Ratified Decisions

| ID | Ratified decision |
| --- | --- |
| OD-MCD-1 | Repair a plugin-managed cell even when both stored fingerprints match. |
| OD-MCD-2 | A human edit to a managed report cell is projection drift and may be overwritten from canonical attendance facts. |
| OD-MCD-3 | Preserve every user-created or custom field exactly; patches may contain only resolved managed physical field IDs. |
| OD-MCD-4 | Fail closed on record-version drift. The plugin record writer must use an atomic optional `expectedVersion` predicate and return a typed values-free conflict. |
| OD-MCD-5 | Add no reverse attendance write, route, permission, notification, external delivery, or rollout flag. |
| OD-MCD-6 | Apply one pure managed-content rule to both daily and period report projections. |

## 3. Locked Behavior

For an existing report row, the writer rebuilds the complete desired managed map from
canonical attendance sources and resolves every logical managed field to its physical
multitable field ID.

```text
skip iff fingerprints match
     and every non-volatile managed physical field deep-equals the desired value

patch iff a fingerprint differs or any managed field differs
      using only desired managed physical fields
      with expectedVersion equal to the inspected record version

conflict iff the inspected version no longer matches at UPDATE
         with zero record, link, or revision mutation from the rejected attempt
```

`synced_at` is managed but volatile: it is included in a successful patch and excluded
from content equality. Unknown/custom fields are neither compared nor copied into the
patch, so the core merge writer preserves them exactly.

The optional CAS argument is backward compatible: callers that omit `expectedVersion`
retain the existing plugin record patch behavior. Invalid expected versions fail before
any database access. Conflict messages and attendance conflict logs contain only fixed
codes and fixed text.

## 4. Authorized Files

Shared CAS micro-surface:

- `packages/core-backend/src/types/plugin.ts`
- `packages/core-backend/src/multitable/record-errors.ts`
- `packages/core-backend/src/multitable/records.ts`
- `packages/core-backend/src/index.ts`
- owning unit and existing real-PostgreSQL plugin-record tests

Attendance-owned surface:

- `plugins/plugin-attendance/lib/attendance-report-managed-content-drift.cjs`
- the two minimal call sites in `plugins/plugin-attendance/index.cjs`
- dedicated helper and existing report-sync tests

## 5. Required Gates

- Same-fingerprint managed drift repairs for daily and period rows.
- Clean rows skip even when only `synced_at` differs.
- Fingerprint mismatch keeps the existing patch behavior.
- Custom fields survive repair exactly.
- A deterministic two-connection version race returns `VERSION_CONFLICT` and writes no
  rejected record revision.
- Removing managed-content comparison, `expectedVersion`, or the SQL version predicate
  makes the corresponding test red.
- Focused unit/neighbor tests, core typecheck, source lint, real PostgreSQL, and
  `git diff --check` pass on the exact candidate.

## 6. Explicit Exclusions

No migration, OpenAPI, web UI, workflow/selector change, permission expansion, reverse
write to attendance facts, flag enablement, dispatch, staging, deployment, production,
or real customer data is authorized by this lock.
