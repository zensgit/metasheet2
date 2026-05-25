# Comprehensive-Hours Cap-Policy Persistence — Design Lock — 2026-05-25

**Status:** design-lock (docs-only). **This design does NOT unlock implementation.** Any
persisted cap write path is a separately-gated opt-in (a named impl PR), still subject to
the K3 PoC stage-1 lock. This document locks the V1 contract + decisions so the eventual
impl is small and unambiguous; it ships no code.

**Why this exists:** PR6 reporting value-plumbing is blocked on a missing persisted
comprehensive-hours cap (orientation `attendance-comprehensive-hours-pr6-runtime-orientation-20260525.md`).
Comprehensive-hours is stateless today — the cap is read only from a live request
(`normalizeAttendanceComprehensiveHoursCapMinutes` `plugins/plugin-attendance/index.cjs:12001`).
Once a cap is persisted and resolvable per (org, user, period), `comprehensive_hours_excess_minutes`
becomes computable inside `syncAttendanceReportPeriodSummary` (`:3509`) and PR6 unblocks.

Verified against `plugins/plugin-attendance/index.cjs` at `996bf3c73`.

---

## 1. V1 REQUIRED decision — lock the resolver contract (the keystone)

A single pure-ish resolver is the contract everything else hangs from:

```
resolveComprehensiveHoursCap(orgId, userId, period)
  -> { capMinutes: number, source: string, fingerprintPayload: object }
  |  null
```

**Input**
- `orgId`, `userId` — strings.
- `period` — the already-resolved period object produced by `resolveAttendanceComprehensiveHoursPeriod` (`:11702`): `{ type, key, from, to, label }`, where `type ∈ { month, quarter, year, payroll_cycle, custom_range }` (the literal enum in `ATTENDANCE_COMPREHENSIVE_HOURS_PERIOD_TYPES` `:11676`; the spec's "monthly/quarterly/yearly" = `month/quarter/year`). `key` is the stable period identifier (`2026-03`, `2026-Q1`, `range:from:to`).

**Output**
- `capMinutes` — resolved cap in minutes (same unit as `buildAttendanceComprehensiveHoursComparison` expects, `:11910`).
- `source` — provenance string, e.g. `org_default_by_cycle_type`. Enumerated, not free text.
- `fingerprintPayload` — the flat object whose keys are the companion catalog codes that must enter the report fingerprint (see §4). Concretely:
  ```
  {
    comprehensive_hours_cap_minutes: <capMinutes>,
    comprehensive_hours_cap_source: <source>,
    comprehensive_hours_cap_effective_key: <effectiveKey>,
  }
  ```
- **`null`** when no cap is configured for this (org, period-type). The caller (period sync) then **stale-nulls** the `comprehensive_hours_*` columns — inheriting the existing disabled-field stale-null pattern (`:2519`). Null is **not** an error and **not** zero.

**Why `userId` is in the V1 signature even though V1 ignores it:** forward-compat. The
per-user override extension (§5) slots in without changing any caller. V1 resolves the same
cap for every user in the org.

---

## 2. V1 RECOMMENDED source — org default by cycle-type

- **Covered in V1:** `month`, `quarter`, `year` — one org default cap per cycle-type. The resolver keys off `period.type`.
- **NOT covered by org-default in V1:** `payroll_cycle` (a `cycleId` is a specific *instance*, not a type — `attendance_payroll_cycles` row, `:3452`) and `custom_range` (caller-defined window). For these, the resolver returns `null` in V1 → the snapshot stale-nulls. Preview-time behavior is unchanged (the preview still takes a caller cap). Deriving a cap for these is deferred (§6).

**Storage (recommended): reuse `system_configs` settings-JSON via `ConfigService`** (`packages/core-backend/src/services/ConfigService.ts:216`/`:253`) — **no migration.** One org-scoped key (e.g. `attendance.comprehensive_hours.cap_defaults`) holding a small map:
```
{ "month": <minutes>, "quarter": <minutes>, "year": <minutes> }
```
- **`effective_key` semantics in V1:** a **config-revision identifier** — the `system_configs` row's `updated_at` (or a monotonic version), **NOT an effective-date.** It exists so a cap edit changes the fingerprint and triggers re-sync (§4). True effective-dating is deferred (§6); this resolves the latent tension between "cap version/effective key" and "no historical audit" — V1 has a *revision* marker, not date-versioned history.
- Whether to instead introduce a dedicated table is a deliberate choice that belongs to the impl opt-in **only if** the grain/audit needs of §5/§6 are pulled in; V1's org-default-by-cycle-type does **not** require one.

---

## 3. Fingerprint integration — the bridge back to #1819 / PR6

The cap must participate in the report `source_fingerprint` so a cap edit re-syncs the
affected rows. Mechanism (no descriptor change, no migration):

- The resolver's `fingerprintPayload` keys are **companion catalog value-fields** authored alongside `comprehensive_hours_excess_minutes`: `comprehensive_hours_cap_minutes`, `comprehensive_hours_cap_source`, `comprehensive_hours_cap_effective_key`.
- They ride the **existing dynamic value-column path** in `syncAttendanceReportPeriodSummary` (catalog → `buildAttendanceReportPeriodSummaryValueColumns` → `ensureObject` dynamic fields `:3536-3543`; per-column fill via `getAttendancePeriodSummaryFieldValue` `:3595`).
- Because they appear as keys in the logical payload, the existing `source_fingerprint` rule picks them up **automatically** — the fingerprint hashes the logical payload minus a fixed exclusion set (`syncedAt` / the fingerprints themselves). No fingerprint code changes.
- **Re-sync trigger in V1: passive.** A cap edit changes `effective_key` → next scheduled period sync computes a different `source_fingerprint` → the row patches. No active edit-triggered job in V1 (that would be a separate extension).

This keeps the cap-policy work and the PR6 value-plumbing cleanly separable: cap-policy
ships the resolver + storage + companion-field semantics; PR6 (still its own opt-in) wires
the resolver into the sync and adds the catalog entries + tests.

---

## 4. OPTIONAL extension — attendance-group override (separate opt-in)

Per-attendance-group cap override on top of the org default. **Must not be implemented
without its own opt-in**, especially if it needs effective-date or audit — at that point a
single `system_configs` map is likely insufficient and a dedicated table (→ migration) is the
honest choice. Out of scope for V1.

## 5. EXPLICIT deferred (none of these in V1 or its first impl)

- Per-user cap override.
- Employee-category / position-class caps.
- Historical audit table (cap change history).
- Effective-dated caps + retroactive recompute policy (changing a cap retroactively alters already-computed violations — deliberately not decided here).
- `payroll_cycle` / `custom_range` org-default derivation.

## 6. Stage lock

This design-lock is docs-only and safe under the stage-1 lock (kernel-polish planning). **It
does not unlock implementation.** The cap-policy impl introduces a new persistent write path
+ admin-config semantics and is a **separately-gated opt-in** (a named impl PR), to be decided
deliberately. PR6 reporting remains a *further* separate opt-in after cap-policy lands.

---

## 7. Test matrix (for the eventual impl, not this PR)

| # | Property | Enforcement | Test |
| --- | --- | --- | --- |
| R1 | Resolver contract: `(orgId,userId,period)→{capMinutes,source,fingerprintPayload}` for `month/quarter/year` | unit test | Configure org defaults; assert resolved cap per cycle-type. |
| R2 | No cap configured → `null` (not 0, not error) → columns stale-null | unit + integration | Unset config; resolver returns null; period sync writes null for the `comprehensive_hours_*` columns (`:2519` pattern). |
| R3 | `payroll_cycle` / `custom_range` → `null` in V1 | unit test | Assert resolver returns null for these types (deferred coverage). |
| R4 | Cap edit changes `effective_key` → `source_fingerprint` changes → row re-syncs | integration test | Edit the config; re-run sync; assert the period row patched (fingerprint differs). Real wire, not fixture. |
| R5 | `fingerprintPayload` keys are exactly the companion catalog codes | unit test | Assert the payload shape so PR6 plumbing can rely on it. |
| R6 | Storage is `system_configs` via `ConfigService`; no new migration | review checklist | Reviewer confirms empty `migrations/` diff (honest: review-enforced unless a CI guard is added separately). |

## 8. Cross-references

- `docs/development/attendance-comprehensive-hours-pr6-runtime-orientation-20260525.md` — established cap persistence as the PR6 prerequisite.
- `docs/development/attendance-comprehensive-hours-pr6-snapshot-boundary-20260525.md` — the #1819 boundary contract; the companion catalog fields keep this work migration-free.
- `[[attendance-multitable-report-boundary]]` — period summaries are the correct grain.
- `[[staged-opt-in-lineage]]` — cap-policy impl and PR6 impl are each separate opt-ins.
- `[[k3-poc-stage1-lock-no-new-fronts]]` — the persisted write path re-opens a runtime surface; decide deliberately.
