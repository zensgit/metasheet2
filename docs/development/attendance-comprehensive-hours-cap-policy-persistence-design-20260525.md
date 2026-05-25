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
- `period` — the already-resolved period object produced by `resolveAttendanceComprehensiveHoursPeriod` (`:11702`): `{ type, key, from, to, label }`, where `type ∈ { month, quarter, year, payroll_cycle, custom_range }` (the literal enum in `ATTENDANCE_COMPREHENSIVE_HOURS_PERIOD_TYPES` `:11676`; the spec's "monthly/quarterly/yearly" = `month/quarter/year`). `key` is the stable period identifier (`2026-03`, `2026-Q1`, `range:from:to`). Note: the PR6 producer emits `date_range`/`payroll_cycle`, not these types directly — §2.1 defines the required bridge that derives `period.type` before the resolver is called.

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
- **`null`** when no cap is configured for this (org, period-type). The caller (period sync) then **stale-nulls** the `comprehensive_hours_*` columns — inheriting the existing period-summary stale-null pattern (`:3590-3592`, the `!activeValueCodes.has(column.id) → null` branch). Null is **not** an error and **not** zero.

**Why `userId` is in the V1 signature even though V1 ignores it:** forward-compat. The
per-user override extension (§5) slots in without changing any caller. V1 resolves the same
cap for every user in the org.

---

## 2. V1 RECOMMENDED source — org default by cycle-type

- **Covered in V1:** `month`, `quarter`, `year` — one org default cap per cycle-type. The resolver keys off `period.type`.
- **NOT covered by org-default in V1:** `custom_range` (arbitrary window — no natural org default) and `payroll_cycle` (a `cycleId` is a specific *instance*, not a type — `attendance_payroll_cycles` row, `:3452`). For these the resolver returns `null` → the snapshot stale-nulls. Preview-time behavior is unchanged (the preview still takes a caller cap). Deriving a cap for these is deferred (§6).

### 2.1 Period-type bridge — REQUIRED for PR6 to reach the org defaults

**The gap this closes:** the PR6 producer reuses the existing period-summary sync, whose
period resolver `resolveAttendanceReportPeriodSyncPeriod` (`:3432`) emits **only**
`periodType: 'payroll_cycle'` (`:3462`) or `periodType: 'date_range'` (`:3497`) — it never
emits `month/quarter/year`. Without a bridge, the resolver above would always receive
`date_range`, never match an org default, and PR6 would always stale-null. So the bridge is
mandatory, not optional.

**Bridge rule (applied before calling the resolver, on the period sync's `date_range` window
`from`/`to`):**
- exact natural calendar month (`from` = 1st, `to` = month-end) → `month`
- exact natural calendar quarter → `quarter`
- exact natural calendar year (`YYYY-01-01`..`YYYY-12-31`) → `year`
- any other `date_range` → `custom_range` (→ resolver returns `null` → stale-null)
- `payroll_cycle` → stays `null` in V1; mapping a payroll cycle to a cycle-type (cycle-template mapping) is a **separate opt-in** (§6)

This keeps the resolver's clean `month/quarter/year/payroll_cycle/custom_range` vocabulary
while making the org defaults actually reachable through the real producer. The derived
`type` (and its `key`, e.g. `2026-03`) is what the resolver and the fingerprint payload use.

**Storage (recommended): a settings-JSON path — no new migration.** Carry the cap defaults
on existing config infrastructure rather than a new table. The impl should prefer the
**existing `attendance.settings` normalizer** (`SETTINGS_KEY = 'attendance.settings'` `:51`,
with the `attendance.settings.updated` event `:27801`) so cap defaults live inside the
attendance settings shape that admins already manage — *or* an equivalent `system_configs`
settings-JSON entry via `ConfigService` (`packages/core-backend/src/services/ConfigService.ts:216`/`:253`).
The impl must **not** bypass the existing `attendance.settings` normalizer with a parallel
config write. Either way it is migration-free. The cap defaults are a small map:
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
- `payroll_cycle` → cycle-type mapping (cycle-template mapping) so payroll cycles can resolve an org default; `custom_range` org-default derivation. Both stay `null` in V1 (§2.1).

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
| R2 | No cap configured → `null` (not 0, not error) → columns stale-null | unit + integration | Unset config; resolver returns null; period sync writes null for the `comprehensive_hours_*` columns (period-path stale-null `:3590-3592`). |
| R3 | `payroll_cycle` / non-aligned `custom_range` → `null` in V1 | unit test | Assert resolver returns null for these (deferred coverage). |
| R7 | Period-type bridge: aligned `date_range` → `month/quarter/year`; non-aligned → `custom_range`; `payroll_cycle` → null | unit test | Feed exact-month/quarter/year and off-by-one windows; assert the derived type, so the org default is reachable through `resolveAttendanceReportPeriodSyncPeriod`'s `date_range` output. |
| R4 | Cap edit changes `effective_key` → `source_fingerprint` changes → row re-syncs | integration test | Edit the config; re-run sync; assert the period row patched (fingerprint differs). Real wire, not fixture. |
| R5 | `fingerprintPayload` keys are exactly the companion catalog codes | unit test | Assert the payload shape so PR6 plumbing can rely on it. |
| R6 | Storage rides the existing `attendance.settings` normalizer (or a `ConfigService` settings-JSON equivalent); no new migration; no parallel config write | review checklist | Reviewer confirms empty `migrations/` diff and that cap defaults flow through the existing settings normalizer (honest: review-enforced unless a CI guard is added separately). |

## 8. Cross-references

- `docs/development/attendance-comprehensive-hours-pr6-runtime-orientation-20260525.md` — established cap persistence as the PR6 prerequisite.
- `docs/development/attendance-comprehensive-hours-pr6-snapshot-boundary-20260525.md` — the #1819 boundary contract; the companion catalog fields keep this work migration-free.
- `[[attendance-multitable-report-boundary]]` — period summaries are the correct grain.
- `[[staged-opt-in-lineage]]` — cap-policy impl and PR6 impl are each separate opt-ins.
- `[[k3-poc-stage1-lock-no-new-fronts]]` — the persisted write path re-opens a runtime surface; decide deliberately.
