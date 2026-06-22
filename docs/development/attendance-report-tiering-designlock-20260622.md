# Design-lock (PROPOSED): Attendance report tiering — severe-late / absence-late as first-class rules (#5 RT-0)

> **Status**: PROPOSED — Wave 2 / arc #5 from the execution plan (`attendance-benchmark-remainder-development-plan-20260622.md`). My lane (non-Codex; Codex owns Wave 1 #4/#2). Owner 拍板s §3 before build. MetaSheet 口径; no competitor names.
> **Scope**: promote **严重迟到 / 旷工级迟到** (severe-late / absence-late) from **meta-passthrough** to **first-class, self-calculated** report metrics driven by **configurable rule thresholds** — so the numbers are computed from a rule, not trusted from whatever a record's meta happens to carry.
> **Grounding**: `origin/main`, `plugins/plugin-attendance/index.cjs`. Today: basic `late_count` / `early_leave_count` self-calc from `lateMinutes`/`earlyLeaveMinutes` (index.cjs ~4571); but `severe_late_count` / `severe_late_duration` / `absence_late_count` read **record meta** (`readAttendanceRecordMeta(row, ['severe_late_count','severeLateCount'])`, ~4574) keyed `summary.severeLateCount` (~1025/1035/1045). The per-group rule already carries `lateGraceMinutes` (DEFAULT_RULE ~21); the late compute lives at ~10255 (`lateThresholdAt = shiftStart + lateGraceMinutes`; `lateMinutes = max(0, firstIn − lateThresholdAt)`).

---

## 1. The decision — what #5 v1 is

`lateMinutes` is **already** computed truthfully (from `lateGraceMinutes` + the shift). Severe/absence are just **tiers of the same lateness**, so they should be derived the same way — not passed through from meta. v1:
1. Add two thresholds to the **per-group rule** (beside `lateGraceMinutes`): `severeLateThresholdMinutes`, `absenceLateThresholdMinutes`.
2. **Tier `lateMinutes`** at compute time: `lateMinutes ≥ severeLateThreshold` → severe; `lateMinutes ≥ absenceLateThreshold` → absence-late. (absence threshold > severe threshold > grace.)
3. The report fields read the **computed tier**, not meta — replacing the `summary.*` passthrough at ~4574 with the same `lateMinutes`-vs-threshold derivation the basic tiers already use, and **persisting** the tier counts/minutes so exports round-trip.

No change to how `lateMinutes` itself is computed; this only adds tiers on top of it.

## 2. Contract

- **Rule fields** (per-group rule + the shift/rule template + the override resolver that already copies `lateGraceMinutes`): `severeLateThresholdMinutes`, `absenceLateThresholdMinutes` — non-negative integers, validated enum-strict (the #1776 rule: missing/non-integer/out-of-range → explicit normalizer reject, never a silent default), with `absenceLateThresholdMinutes ≥ severeLateThresholdMinutes ≥ lateGraceMinutes` enforced.
- **Compute**: where `lateMinutes` is finalized, derive
  `severeLateCount = lateMinutes ≥ severeLateThreshold ? 1 : 0`,
  `severeLateMinutes = severeLateCount ? lateMinutes : 0`,
  `absenceLateCount = lateMinutes ≥ absenceLateThreshold ? 1 : 0`.
  Persist these onto the record summary (so the export/report path reads a stored, not re-derived, value).
- **Report fields** (~4574): `severe_late_count` / `severe_late_duration` / `absence_late_count` read the **computed** value; the existing `readAttendanceRecordMeta` becomes a **fallback only** for legacy records that predate the computed tier (so old exports don't change — historical compat).
- **Wire-vs-fixture round-trip** (the landmine the v3 flagged): a real-wire test must assert the computed tier survives the **actual report/export projection** (field-by-field copy/whitelist), not just a hand-built record — the recurring "render test passes, real wire drops the field" trap.

## 3. Decisions for owner 拍板 (§3)

| # | Question | Recommended v1 | Why |
|---|---|---|---|
| 3a | **Threshold defaults** | severe = **30 min**, absence-late = **60 min** (over grace) | common 对标 defaults; configurable per-group, so a customer overrides freely |
| 3b | **Compute-on-read vs persist** | **persist** the tier counts/minutes onto the summary at compute time (read path reads stored) | the v3 bar is "self-calc + 落库 + 真过线 round-trip"; persisting keeps export deterministic + avoids re-deriving with a possibly-changed rule |
| 3c | **Legacy records** (no computed tier) | **meta-passthrough fallback** (don't recompute history) | recomputing past records with today's thresholds would silently restate closed periods; new records compute, old records keep their stored meta |
| 3d | **Attendance 口径 fields** (应出勤/出勤 "自由工时不计/未排班不计") — also in the v3 #5 scope | **defer to a follow-up slice** unless you want it in v1 | distinct surface (day-count 口径) from late-tiering; keeping v1 to the late tiers ships a clean, testable slice |

## 4. Boundaries / non-goals

- **Late tiers only** in v1 (severe-late / absence-late). The 出勤口径 (free-hours/unscheduled not counted) + 公式函数 (TEXT/FILTER/REGEX) from the v3 #5 are **separate follow-up slices** (3d).
- **No change to `lateMinutes`** or the basic `late`/`early` compute.
- **Serial with #6/#8** — shares the record-compute / summary path; do NOT land concurrently with a #6/#8 PR (plan §2/§7).
- Per-group rule (like `lateGraceMinutes`); no new global-only knob.

## 5. Slices (mirror the plan's RT-0..RT-4)

1. **RT-0 (this lock)** — thresholds, tiers, defaults, persist-vs-read, legacy compat, the round-trip landmine.
2. **RT-1 settings + compute** — rule fields + normalizer (enum-strict) + the tier derivation at the late-compute site; persist onto the summary.
3. **RT-2 report/export wiring** — the report fields read the computed tier (meta fallback for legacy) + the sync job; **the wire round-trip test**.
4. **RT-3 admin UI + tooltip** — threshold config card + a 口径 tooltip (absorbs a v3 humanization slice: precise definitions).
5. **RT-4 staging smoke** — change a threshold → severe/absence counts + summary + export move consistently; legacy record unchanged.

## 6. Verification plan (real-DB, per plan §2 "data-affecting paths get real-DB integration")

- threshold set so a known `lateMinutes` crosses severe but not absence → `severe_late_count=1, absence_late_count=0`, and the **export projection** carries the same (wire round-trip).
- raise the absence threshold below `lateMinutes` → `absence_late_count` flips, deterministically.
- legacy record carrying only `summary.severeLateCount` meta → still reads via the fallback, unchanged.
- normalizer: non-integer / `absence < severe` / negative → explicit reject (no silent default).
- regression: basic `late_count` / `early_leave_count` / `lateMinutes` unchanged.

## 7. Governance

design-lock → **owner 拍板 §3 (defaults / persist / legacy / 3d scope)** → RT-1…RT-4 small PRs (subagent-reviewed, CI, real-DB integration) → staging smoke → tracker backfill. Serial vs #6/#8. PROPOSED until selected. MetaSheet 口径; no competitor names.
