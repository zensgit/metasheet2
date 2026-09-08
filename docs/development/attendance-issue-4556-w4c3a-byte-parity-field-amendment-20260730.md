# Attendance issue #4556 W4C-3a byte-parity field amendment

Status: **RATIFIED** (the three exact byte-parity fields in section 3 only)

Date: 2026-07-30

Ratified: 2026-07-30, merged SHA
`ab752d722327f11887e3884a23ed4f6304faa3c5` — the commit that landed this
document on `main` (PR 4679) — with `OD-W4C-57=(a)`. Durable owner record
(transcription of the owner's explicit instruction): PR 4679 comment
`5125993049`,
<https://github.com/zensgit/metasheet2/pull/4679#issuecomment-5125993049>.

Scope of what the ratification authorizes: **only** the three exact
byte-parity fields in section 3, and W4C-3a implementation depending on them.

**Status reconciliation note (2026-08-09):** this header previously read
`PROPOSED — owner RATIFY required`. That was in-repo status drift, not a
pending decision — the owner record cited above predates this correction and is
unchanged by it. This edit transcribes that existing record and confers no new
authority; the linked owner comment is the authority, not this document and not
the pull request carrying this edit. If any line here misstates that record, it
must not merge.

Authority proposed against:

- merged amendment SHA
  `e6c536fe7a201ca0466b2dc776b15fbdb23aa890`;
- owner decision `OD-W4C-56=(a)`, durably transcribed in PR #4677 comment
  `#5125676385`.

This document is a narrow correction to the exact W4C-3a durable legacy plan
union. It does not authorize W4C-3a merge, W4C-3b, W4C-5 soak, a flag change,
deployment, production/customer data, or issue closure.

## 1. Why the correction is required

The accepted plan must replay the existing legacy effect byte-compatibly from
durable values. Three values written by the retained implementation have no
honest field in the exact union at the authority SHA:

1. A normal batch writes `payload.source ?? null` to
   `attendance_import_batches.source`
   (`plugins/plugin-attendance/index.cjs:26096-26128`). The request schema
   admits exactly five non-null values
   (`plugins/plugin-attendance/index.cjs:24751-24753`), while the governing
   batch-plan contract names source without freezing its nullable closed domain
   (`docs/development/attendance-issue-4556-w4c3a-durable-legacy-plan-amendment-20260729.md:846-865`).
2. Both retained attendance-record upsert strategies write
   `row.timezone` to `attendance_records.timezone`
   (`plugins/plugin-attendance/index.cjs:20187-20236` and
   `:20249-20344`), while the governing record-write freeze list contains no
   timezone
   (`docs/development/attendance-issue-4556-w4c3a-durable-legacy-plan-amendment-20260729.md:940-952`).
3. The retained group path keeps a normalized lookup key separately from the
   original trimmed display name, then writes the display name to
   `attendance_groups.name`
   (`plugins/plugin-attendance/index.cjs:9085-9145` and `:9219-9236`), while
   the governing exact `ensure_group` union contains only `normalizedName`
   (`docs/development/attendance-issue-4556-w4c3a-durable-legacy-plan-amendment-20260729.md:1048-1056`).

Using `compatibilityMetadata`, a snapshot, or another opaque leaf for any of
these values is forbidden. It would make an opaque leaf select a literal
business write and would hide a required effect input from the exact union.
Recomputing any value from mutable state at worker time is also forbidden.

## 2. Proposed decision

### OD-W4C-57 — exact byte-parity fields

- **(a) Recommended:** correct the exact union with only the three fields in
  section 3, then continue W4C-3a under both RATIFIED amendments.
- **(b):** retain the current union and narrow W4C-3a to legacy inputs for
  which batch source is non-null, record timezone is not written, and group
  display name equals its normalized key.

Option (b) is not recommended. The retained writers always write record
timezone, and the restriction would remove already shipped input shapes rather
than preserve byte compatibility.

## 3. Exact union correction for option (a)

If `OD-W4C-57=(a)` is RATIFIED:

1. `LegacyImportBatchPlanV1` normal variant changes only:

   ```text
   source: 'dingtalk' | 'manual' | 'dingtalk_csv' |
           'dingtalk_api' | 'csv' | null
   ```

   Null and non-null are distinct digest inputs. Empty string is not a null
   surrogate, and no other string is accepted.

2. `LegacyImportRecordWritePlanV1` adds exactly:

   ```text
   timezone: string
   ```

   The value is the exact resolved timezone frozen while preparing the
   retained legacy row. The apply adapter writes this frozen value and never
   reloads a current default.

3. `LegacyImportGroupEffectPlanV1` `ensure_group` adds exactly:

   ```text
   displayName: string
   ```

   `normalizedName` remains the canonical lookup, sort, uniqueness, reference,
   and lock key. `displayName` is the exact non-empty trimmed value written to
   `attendance_groups.name`. The parser requires
   `displayName.trim() === displayName`,
   `displayName.toLowerCase() === normalizedName`, and rejects `/^\d+$/`
   exactly as the retained collector does. It does not replace
   `displayName` with `normalizedName`.

All three fields remain covered by the existing chunk digest and logical plan
digest. No root manifest field, physical table column, route, response, lock
class, authorization rule, or operational branch is added.

## 4. Required proof

The W4C-3a implementation gate must include:

1. normal batch `source=null` and all five non-null source positive controls,
   plus independent mutations that coerce null to empty string and substitute
   one legal non-null source for another;
2. record timezone positive controls for both `values` and `unnest` strategies,
   plus a mutation that reloads a changed current/default timezone after
   enqueue and independent mutations that replace the frozen valid timezone at
   each writer;
3. a mixed-case group display name whose normalized key differs, proving
   prepare freezes both values and apply writes the display name; replacing
   `displayName` with `normalizedName` must fail, and a numeric-only name must
   create no group;
4. restart parity for each value from persisted manifest/chunk data only;
5. exact-key negatives for omission, extra keys, null under the wrong field,
   and opaque-leaf substitution.

Each mutation has its own positive control. Where a neighboring guard could
reject first, that guard is neutralized in a separate mutation run so the
field-specific leg must fail independently.

## 5. Ratification and execution boundary

An owner RATIFY must name the merged SHA of this PROPOSED amendment and
`OD-W4C-57=(a|b)`. Only then may implementation depend on the selected
correction. Existing W4C-3a foundation work that does not consume these three
values may continue under `OD-W4C-56=(a)`, but prepare/apply cutover must not be
declared complete before this decision is durable.

Even after RATIFY, W4C-3a still stops at its separately reviewed Draft PR and
owner merge decision. No later slice or runtime activation follows
automatically.
