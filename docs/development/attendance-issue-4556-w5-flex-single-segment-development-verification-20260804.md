# Attendance Issue #4556 W5 — Flexible Single-Segment Mode Development & Verification

> Status: **RECORD** (implementation evidence). Does **not** authorize a runtime
> flag transition, deployment, soak, production migration, customer data use,
> notifications, or closing issue #4556.
>
> Date: 2026-08-04
> Contract: `docs/development/attendance-shift-group-advanced-capability-design-lock-20260723.md`
> sections **3.3** and **9.6** (OD-4556-3).
> Delivery branch: `codex/attendance-w5-flex-20260804`.

## 0. Scope delivered

| Item | Delivered |
| --- | --- |
| Minimal persistence contract on `attendance_shifts` | Yes — discriminated `flex_mode` + value columns |
| Strict discriminated validation (service + pure TS + DB CHECK) | Yes |
| Single-segment flex calculator (expected start clamp + required duration) | Yes |
| Multi-segment flex rejection | Yes (write path + frozen context + UI) |
| Grace applies only after flex expectation resolution | Yes |
| Optional core hours via **authoring** guarantee (no new reasonCode) | Yes |
| UI + explainability | Yes (editor, list label, reason vocabulary) |
| Synthetic unit / web / migration tests | Yes |
| Strict legacy bytes/history preserved | Yes (default `strict`, absent `flexPolicy` on frozen context) |
| Org isolation / no raw IDs | Unchanged shift org scoping; no raw UUID labels added |

## 1. Product readings locked into code (implementation assumptions)

These are the only readings required to implement §3.3 without inventing a
second flex contract. They are recorded here so a gate reviewer can challenge
them without hunting comments:

1. **Arrival window anchor** = the single segment `startTime` on the work date.
2. **First valid arrival** = the matched check-in evidence for that one segment
   (W4 directional matching; single segment uses the attribution window cell).
3. **Clamp** = `expectedStart = clamp(actualArrival, windowStart, windowEnd)`;
   missing arrival falls back to `windowStart` so missing-check-in still has a
   stable expectation.
4. **Expected end** = `expectedStart + requiredMinutes`.
5. **Payable minutes** = intersection of actual `[in,out)` with the
   flex-resolved `[expectedStart, expectedEnd)` (plus bounded approved OT), not
   the outer legacy envelope.
6. **Core hours (authoring-only guarantee, no new reasonCode)**: optional
   same-day `HH:MM` pair. Save/freeze/calculator reject any policy where some
   allowed clamped start cannot cover core. **Both** inequalities are required
   (duration-only `requiredMinutes >= coreEnd-coreStart` is insufficient):
   - `latestPermittedStart <= coreStart`
   - `earliestPermittedStart + requiredMinutes >= coreEnd`
   with `earliest = segmentStart - arrivalWindowBefore` and
   `latest = segmentStart + arrivalWindowAfter`. Corrupt frozen policy fails
   closed as `review_required` / `input_schema_invalid` with zero segments and
   null daily projection. The calculator does **not** invent
   `core_hours_violation` or any other new closed-set reason.
   Multi-segment flex in the UI preserves the user's flex selection and blocks
   save with a visible validation error (no silent rewrite to strict).
7. **Strict default** omits `flexPolicy` from newly frozen contexts so W4
   strict bytes stay exact; only `flex_required_duration` adds the field.
8. **w4c1 path in scope**: pure calculator + `buildW4ShadowFrozenContextV1`
   freeze re-validate multi-segment flex and core coverage fail-closed
   (`input_schema_invalid` / `null` context).

If any of (1)–(7) is rejected by owner, stop and amend the design lock before
merge.

## 2. Persistence

Migration:
`packages/core-backend/src/db/migrations/zzzz20260804120000_attendance_shift_flex_policy.ts`

- Columns: `flex_mode` (default `strict`), `flex_required_minutes`,
  `flex_arrival_window_before_minutes`, `flex_arrival_window_after_minutes`,
  `flex_core_start_time`, `flex_core_end_time`.
- Discriminated CHECK: strict ⇒ all value columns NULL; flex ⇒ required + both
  windows NOT NULL with bounds; core times both null or both set.
- Does **not** extend the closed segment-reason vocabulary.
- `down()` aborts before DDL when any non-strict flex row exists.

## 3. Runtime surfaces

| Layer | Path |
| --- | --- |
| Pure policy | `packages/core-backend/src/attendance/w5-flex-policy.ts` |
| Calculator | `packages/core-backend/src/attendance/w4c1-segment-calculator.ts` (flex branch; strict path unchanged when policy absent/strict) |
| Frozen context type | `packages/core-backend/src/attendance/w4c0-write-boundary-types.ts` optional `flexPolicy` |
| Canonical shift writer | `plugins/plugin-attendance/lib/attendance-shift-service.cjs` |
| Frozen context build | `plugins/plugin-attendance/index.cjs` `buildW4ShadowFrozenContextV1` |
| Route schema | `shiftFlexPolicySchema` on create/update |
| OpenAPI | `AttendanceShiftFlexPolicy` + shift request bodies; segment reason enum |
| UI | `AttendanceShiftFlexPolicyEditor.vue` + `AttendanceView.vue` list/explain |

Error code: `ATTENDANCE_SHIFT_FLEX_POLICY_INVALID` (typed 422, zero writes).

## 4. Focused verification commands

Run from the worktree root (do not enable flags, deploy, or use customer data):

```bash
# Pure W5 policy + calculator
pnpm --filter @metasheet/core-backend exec vitest run \
  src/attendance/__tests__/w5-flex-policy.test.ts \
  src/attendance/__tests__/w5-flex-segment-calculator.test.ts \
  --watch=false

# Shift service flex validation (unit)
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-shift-segments-service.test.ts \
  --watch=false

# Migration real-DB (requires DATABASE_URL)
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/integration/attendance-shift-flex-policy-migration.db.test.ts \
  --watch=false

# Existing W4C-1 calculator still green (strict legacy)
pnpm --filter @metasheet/core-backend exec vitest run \
  src/attendance/__tests__/w4c1-segment-calculator.test.ts \
  --watch=false

# Web pure analysis + typecheck
pnpm --filter @metasheet/web exec vitest run \
  tests/attendance-shift-segments.spec.ts --watch=false
pnpm --filter @metasheet/web type-check
```

### 4.1 Local results on the implementation worktree

All runs below used synthetic fixtures only. No runtime flag, deployment, staging
org, production/customer data, or external notification was used.

| Gate | Result |
| --- | --- |
| Core policy/calculator/strict-regression/service matrix | 5 files / 171 tests PASS |
| Web analysis/editor helpers + mounted preservation/reset interaction | 1 file / 10 tests PASS |
| Isolated PostgreSQL migration + canonical writer | 1 file / 2 tests PASS |
| Required-CI two-point wiring guard | 96 tests PASS |
| Core backend TypeScript | PASS |
| Web Vue/TypeScript | BASELINE-RED; W5 adds no diagnostic (same three pre-existing TS2550 errors on clean base) |
| OpenAPI build + security validation | PASS |
| Generated SDK build (`openapi-typescript`) | PASS |

The PostgreSQL file is intentionally excluded by the default no-DB Vitest
configuration. Its recorded run used `vitest.integration.config.ts` with a
local isolated PostgreSQL connection, matching the required attendance DB lane.

The full web `vue-tsc -b` command reports the same three pre-existing TS2550
diagnostics on this branch and on the clean review base:
`src/approvals/attachmentUpload.ts:59` (`Object.hasOwn`),
`src/services/integration/k3WiseSetup.ts:535` (`Array.at`), and
`src/views/UserManagementView.vue:1277` (`String.replaceAll`). No W5 file emits
a TypeScript diagnostic; this slice does not modify those unrelated files.

## 5. Synthetic matrix covered

| Leg | Expected |
| --- | --- |
| Strict, no flexPolicy | expected = segment times; worked = segment intersection |
| Strict, flexPolicy.mode=strict | same as absent |
| Multi-segment + flex_required_duration | `input_schema_invalid` / write 422 |
| Early arrive (before window) | expected start = window open |
| In-window arrive | expected start = actual arrival; no late |
| Late arrive (after window) | expected start = window close; late after grace |
| Early leave vs flex expected end | early after grace |
| Core hours not coverable by every clamped start | authoring 422 / freeze null / calculator `input_schema_invalid` |
| Authoring-valid core hours | calculator emits only existing closed reasons |
| UI multi-segment | flexEligible=false; flex selection remains visible, save is blocked until the user returns to strict or one segment |

## 6. Explicit non-goals (still blocked)

- Multi-segment flex semantics
- Runtime flag enablement / org cutover
- Staging soak, deployment, production migration
- Closing #4556
- Changing historical attendance result bytes
- Group effective-policy workspace (W6) or group calculation cutover (W7)

## 7. Honest boundary

- W5 wires flex into the pure calculator and shift authoring path. Authoritative
  org cutover remains gated by existing W4 rollout posture (flag default OFF).
- Flex expected end that falls outside the frozen absolute attribution window
  fails closed as `invalid_segment_order` (same containment rule as strict
  anchors). Extremely wide flex windows need a correctly sized attribution
  window from the W2 resolver, not a calculator exception.
- The real-DB flex migration/writer suite is excluded from the no-DB lane and
  named as a whole file in the required attendance PostgreSQL step; the wiring
  guard pins both locations.
- Two product readings remain explicit owner gates rather than inferred
  acceptance: missing arrival currently resolves to the arrival-window open,
  and optional core hours are a positive same-day interval. Rejecting either
  reading requires a contract amendment before this PR can merge.
