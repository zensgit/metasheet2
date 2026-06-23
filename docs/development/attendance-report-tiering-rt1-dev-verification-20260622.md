# Dev + Verification — Attendance report tiering (#5 RT-1)

> **Arc**: #5 (report tiering) · **Slice**: RT-1 (settings + compute) · **PR**: #3069 (branch `feat/attendance-report-tiering-rt1-20260622`, **not merged** — owner-gated hot-core review) · **Design-lock**: `attendance-report-tiering-designlock-20260622.md` (#3055, §3 = recommended column) · **Date**: 2026-06-22 · MetaSheet 口径.

This is one arc of the remaining-line plan (#3048). The plan sequences the remainder as Wave 1 (#4 ∥ #2, Codex) · **Wave 2 (#5 → #6, serial, this lane)** · Wave 3 (#8). Per the agreed pace, this session built **#5 RT-1 only**, then reassesses; #6/#8 follow serially (they share the record-compute path and must not land concurrently).

---

## 1. What shipped

`lateMinutes` is already computed truthfully (from `lateGraceMinutes` + the shift). Severe-late / absence-late are just **tiers of the same lateness**, so RT-1 derives them the same way instead of trusting record meta.

| Piece | Where | Note |
|---|---|---|
| Threshold defaults | `DEFAULT_RULE` (`severeLateThresholdMinutes` 30 / `absenceLateThresholdMinutes` 60) | §3a recommended defaults, over the grace window |
| Tier derivation | `computeLateTierCounts(lateMinutes, rule)` (pure) | falls back to `DEFAULT_RULE`; **enforces** nesting `late ⊇ severe ⊇ absence` via `effectiveAbsence = max(absence, severe)`; `0` disables a tier |
| Persist (one site) | `computeAttendanceRecordUpsertValues` writes `severe_late_count` / `severe_late_minutes` / `absence_late_count` into the record `meta` | derived from the **effective** (post-override) `lateMinutes` → a manual override re-tiers |
| Report read | unchanged — `getAttendanceRecordReportFieldValue` already reads those meta keys | the populated meta makes the existing read return the computed value |

**Why this seam.** The report-field read (`getAttendanceRecordReportFieldValue(row, code)`) has only the record `row`, not the rule — threading the rule through `buildAttendanceRecordReportExportItem(Async)` + the formula value-map + every caller would sprawl. The rule **is** in scope at `computeAttendanceRecordUpsertValues` (where `lateMinutes` is finalized), so the tier is computed once and written into the meta the report already reads. Net production change: **+1 helper, +1 write, +2 rule defaults** — no change to the report-field read or the 7 `computeMetrics` callers.

**Legacy compat (§3c).** Records that predate this carry no tier keys → the report's existing meta-fallback reads `0`, unchanged. No closed period is restated.

## 2. Verification

### 2.1 Unit (no DB) — `packages/core-backend/tests/unit/attendance-report-tiering.test.ts` — **9/9 local pass**
- **Tier math**: defaults (35→severe, 20→none, 0→none); nesting (70→both; 60 at 30/60→both); per-group override (20 at sev15→severe); disabled (`0`→never; severe-on/absence-off); fractional/non-numeric coercion.
- **Nesting enforcement** vs incoherent `absence < severe` (absence 20 / severe 50): a 30-min record yields `{severe:0, absence:0}` (never absence-without-severe); a 60-min record yields both. This closes the correctness gap the review flagged.
- **Wiring** through the **real** `computeAttendanceRecordUpsertValues` (not a fixture): a `09:45` punch with the default rule → `lateMinutes=35` → the returned `metaJson` carries `severe_late_count=1, severe_late_minutes=35, absence_late_count=0`; a `10:30` punch → `80` → both tiers; a `09:05` punch → `0` → zeros.

### 2.2 Real-DB integration — `packages/core-backend/tests/integration/attendance-plugin.test.ts` — runs in `plugin-tests.yml` (real Postgres)
Imports a severe-late (`09:45` → 35 min) + an absence-level (`10:30` → 80 min) record, reads `GET /api/attendance/records`, and asserts the per-record `report_values` carry the self-calculated tiers — `late_count=1` (plumbing) → `severe_late_count=1`, `severe_late_duration=35`, `absence_late_count=0` for the 35-min day; `severe=1 / absence=1` for the 80-min day. This exercises the **actual report/export projection** (field-by-field), catching the recurring "render passes, real wire drops the field" trap.

### 2.3 Gates
`node -c` clean · `tsc --noEmit` **0 errors** · broad attendance unit sweep **199 pass / 0 fail** (no meta-exact-match regression from always-writing the 3 keys) · CI on #3069 (the `test (18.x/20.x)` + `plugin-tests` real-DB step) — see the PR.

## 3. Split — RT-1a (deferred, named so it can't drop)

Per-group **configurable** thresholds need three things that travel together:
1. **Persistence** — `attendance_rules` is **typed columns** (not a JSON blob), so storing `severe_late_threshold_minutes` / `absence_late_threshold_minutes` needs a **migration** + threading through the rule INSERT / `mapRuleRow` / the override resolver.
2. **Write-side enum-strict normalizer** — `z.int().min(0)` on the rule/shift routes + an `absence ≥ severe ≥ lateGraceMinutes` **reject** (the #1776 rule: missing/non-integer/out-of-range → explicit reject, never a silent default). A normalizer that validates a field it can't yet store would be incoherent, so it lands with (1).
3. **Admin UI + 口径 tooltip** (the design-lock RT-3 humanization slice).

v1 thresholds are the ordered 30/60 defaults, so the nesting invariant already holds; the helper enforces it regardless of config, so RT-1a can add per-group values safely.

Also still deferred (design-lock §3d / §4): 出勤口径 (free-hours/unscheduled-not-counted day-count) and 公式函数 (TEXT/FILTER/REGEX) — distinct surfaces from late-tiering.

## 4. Remaining line (after this arc)

| Arc | Lane | Status |
|---|---|---|
| #5 report tiering | this lane | **RT-1 in PR #3069**; RT-1a (above) next; RT-2 export/sync wiring + RT-3 UI + RT-4 staging |
| #6 pending-leave / team availability | this lane | design-lock #3056 (TA-0) **拍板-pending**; serial **after #5** |
| #8 cross-midnight | this lane | design-lock first (NS-0); serial; heaviest |
| #4 / #2 | Codex lane | Wave 1, file-disjoint, parallel — owner to confirm session ownership (plan #3048 flag #1) |

## 5. Governance
design-lock (#3055, recommended §3) → build (this PR, recommended §3) → **owner review of the hot-core change** → CI + real-DB → (merge) → RT-1a … RT-4 → staging smoke → tracker backfill. Serial vs #6/#8. Not merged pending owner review. MetaSheet 口径; no competitor names in code/tests.
