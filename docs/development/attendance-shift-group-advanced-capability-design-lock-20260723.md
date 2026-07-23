# Attendance Shift and Group Advanced Capability Design Lock

Status: **PROPOSED**

Date: 2026-07-23

Tracks: issue #4556

Evidence baseline: `origin/main@9f989396b765dac7ef87dfd0e689a69e5be8bec8`

Related narrow fix: PR #4558, merged as
`077fde47859c561a13f820fb8ccc285a2ed5c58f`

Related contract-parity fix: PR #4560, merged as
`9f989396b765dac7ef87dfd0e689a69e5be8bec8`

## 0. Purpose and authorization boundary

This lock turns the requirements in issue #4556 and the supplied
`改善建议.docx` into an implementation sequence that cannot silently change
attendance accounting semantics.

The source request mixes three different classes of work:

1. capabilities that already exist but are hard to discover or configure;
2. contract drift where the runtime is ahead of OpenAPI;
3. genuinely missing domain behavior that changes attendance or overtime
   accounting.

This document separates those classes. It is **not** authorization to enable a
new calculation path, migrate production data, change a runtime flag, or close
issue #4556. Runtime slices remain blocked until the owner ratifies the open
decisions in section 8.

The OpenAPI parity slice in section 9.1 is exempt from that hold because it only
documents behavior that the current runtime already exposes or accepts.

## 1. Current capability ledger

### 1.1 Already implemented

| Requirement | Current capability | Evidence | Honest boundary |
| --- | --- | --- | --- |
| Attendance group type | `fixed_shift`, `scheduled_shift`, and `free_time` exist | `packages/core-backend/src/db/migrations/zzzz20260529213000_add_attendance_group_type.ts`; `plugins/plugin-attendance/index.cjs` group routes | Current runtime fields are represented in OpenAPI after #4560 |
| Group owner | owner and sub-owner rows exist | `packages/core-backend/src/db/migrations/zzzz20260529233000_create_attendance_group_managers.ts`; group-manager routes near `plugins/plugin-attendance/index.cjs:38230` | A manager row is not automatically a delegated authorization grant |
| Group workspace | basics, people, work time, and policies are already presented in the group detail flow | `apps/web/src/views/AttendanceView.vue:4756-5632`; `apps/web/tests/attendance-admin-regressions.spec.ts:2686` onward | Some cards are summaries or links to another editor |
| Scheduling | direct assignments, rotations, publish, temporary shifts, dispatch, swaps, and automatic matching exist | assignment and rotation migrations/routes/tests in `plugin-attendance` | These are schedule primitives, not one multi-period shift |
| Multiple same-day schedule slots | `multiShiftDay` and `slotIndex` support multiple direct assignments | `plugins/plugin-attendance/index.cjs:9827-9961`, `16533-16687`; `apps/web/src/views/AttendanceView.vue:9009-9024` | Actual daily record calculation still summarizes first-in to last-out |
| Overnight schedule | `is_overnight` and next-day shift end calculation exist | `zzzz20260323153000_add_attendance_shift_overnight.ts`; `plugins/plugin-attendance/index.cjs:11110-11123` | Live work-date attribution was incomplete before #4558 |
| Punch policy | org-level IP, geofence, and minimum-interval settings exist | `docs/development/attendance-group-admin-ux-punch-method-config-design-20260529.md` | It is not a per-group punch-policy model |
| Group rule preview | a group can reference `rule_set_id` and preview the rule | `docs/development/attendance-group-admin-ux-rule-policy-config-design-20260529.md` | Runtime calculation does not yet treat it as the member's authoritative rule |

### 1.2 Existing but easy to misread

#### Same-day slots are not shift segments

The system can schedule an employee into an `08:00-12:00` shift in slot 0 and a
`13:00-17:00` shift in slot 1. Effective-calendar planned minutes can sum those
slots (`plugins/plugin-attendance/index.cjs:16631-16687`).

That does not satisfy a true two-segment attendance result:

- the non-prefetched live resolver still loads one assignment with `LIMIT 1`
  (`plugins/plugin-attendance/index.cjs:14042-14079`);
- the daily record stores one `first_in_at` and one `last_out_at`;
- `computeMetrics` calculates work minutes from the entire first-to-last span
  (`plugins/plugin-attendance/index.cjs:11081-11131`).

For punches at 08:00, 12:00, 13:00, and 17:00, the current daily metric can
count 540 minutes rather than the intended 480 minutes. It also cannot report a
missing punch for only the afternoon segment. The UI must not market slots as
completed multi-period accounting until the segment calculator is delivered.

#### Grace is not flexibility

`lateGraceMinutes` and `earlyGraceMinutes` only move late/early thresholds.
They do not shift the employee's expected departure based on actual arrival,
enforce core hours, or preserve a required duration. Calling those fields
"flexible attendance" would be false.

#### The group workspace is not yet a group-owned policy engine

The current group workspace is real and should be reused. However:

- group rule configuration is explicitly a preview and is not the user
  calculation chain;
- punch method is currently inherited from the org;
- advanced scheduling remains a dedicated workflow;
- group membership is not an effective-dated, single-authority calculation
  assignment.

The next UI may aggregate those facts, but must label each value as
`effective`, `inherited`, `preview-only`, or `not configured`.

#### Group type is deliberately immutable today

The group update route returns `409 ATTENDANCE_GROUP_TYPE_LOCKED` when
`attendanceType` differs from the stored type
(`plugins/plugin-attendance/index.cjs:37991-38018`). Removing that guard would
let one persistent group ID change scheduling semantics across history.

The usability gap is real, but the safe product action is not an ordinary
dropdown update. The recommended flow is "Copy as a new group", choose the new
type, set a future effective date, move calculation membership, preview the
impact, and retain the old group for historical explanation.

### 1.3 Genuine missing capability

1. A canonical shift segment model.
2. Per-segment expected and actual results.
3. A flexible attendance rule distinct from grace.
4. Effective-dated calculation-group membership with an unambiguous winner.
5. A shared work-date resolver across live punch, import, correction, approved
   request application, and recomputation.
6. Group rule resolution in the actual calculation chain.
7. A values-free group effective-policy read model.
8. Future OpenAPI contracts for segment, flex, effective-membership, and
   explanation fields introduced by this line.

## 2. Red lines

### R1. No first-to-last arithmetic for a multi-segment shift

When a shift has more than one segment, daily work minutes must be the sum of
segment work minutes. Breaks between segments are never inferred as work.

### R2. No silent group winner

If more than one calculation group is effective for the same
`org_id + user_id + work_date`, runtime calculation must fail closed with an
actionable conflict. It must not use latest-updated, first-row, or array order.

### R3. No historical restatement

Changing a shift, flex rule, group, or rule set affects only dates at or after
its effective boundary. Existing attendance results keep a policy snapshot and
are not silently recalculated.

### R4. No universal group save endpoint

The group workspace may aggregate reads and orchestrate existing commands, but
must not add one catch-all write that updates membership, scheduling, punch
policy, and accounting rules in a partially successful transaction.

### R5. Punch attribution is separate from grace

Late/early grace cannot extend or shrink the window used to choose a work date.
The attribution contract must have its own setting and evidence.

### R6. Approved overtime does not imply unlimited attribution

An approved overtime request may extend a named shift's attribution window only
to the approved end plus a bounded tail. It must not turn every next-day punch
into the prior work date.

### R7. No raw-ID or cross-org fallback

Every new group, segment, and work-date query is org scoped. Unknown or deleted
actors render neutral labels; no API returns a raw user ID as a display
fallback.

### R8. Legacy clients remain honest

Legacy `workStartTime`, `workEndTime`, and `isOvernight` fields may expose the
outer envelope of a segmented shift for compatibility, but APIs and UI must
also expose `calculationMode=segments`. A legacy client must not be led to
believe the envelope is payable time.

### R9. No in-place group-type mutation

Changing `attendanceType` for an existing group remains blocked. A type change
creates a new group/effective membership transition; it never rewrites the
meaning of an existing group ID.

## 3. Proposed canonical contracts

### 3.1 Shift segments

Recommended storage is a normalized `attendance_shift_segments` table:

| Column | Contract |
| --- | --- |
| `id` | UUID primary key |
| `org_id` | required; must equal the parent shift org |
| `shift_id` | required FK to `attendance_shifts` |
| `segment_index` | integer `0..2`, unique per shift |
| `start_time` | local wall-clock time in the shift timezone |
| `start_day_offset` | v1 fixed to `0` |
| `end_time` | local wall-clock time in the shift timezone |
| `end_day_offset` | `0` or `1` |
| `created_at`, `updated_at` | audit timestamps |

Service validation, in the same transaction as the write, must enforce:

- one to three segments;
- dense indexes beginning at zero;
- positive duration per segment;
- ordered, non-overlapping absolute intervals after day offsets are applied;
- total planned minutes greater than zero and at most 24 hours;
- at most one midnight crossing;
- every segment uses the parent shift timezone.

Existing shifts are backfilled as segment 0. During compatibility:

- reads prefer segment rows when present;
- a legacy row without segments is synthesized as segment 0;
- writes use one service that updates segments and the legacy envelope together;
- a second independent segment writer is forbidden.

Existing attendance results are different: daily `first_in_at`/`last_out_at`
cannot reconstruct segment punches or prove that an intervening break was
unpaid. Pre-cutover records therefore remain
`calculationMode=envelope_legacy`. Migration must not fabricate
`attendance_record_segments` for them. Reports may present the preserved daily
result with a legacy explanation label; only results calculated from
segment-aware evidence receive segment rows.

### 3.2 Segment result snapshot

`attendance_record_segments` is the canonical derived result for a segmented
work date:

| Column | Contract |
| --- | --- |
| `attendance_record_id` | parent daily record |
| `segment_index` | matches the frozen shift segment |
| `expected_start_at`, `expected_end_at` | absolute instants |
| `first_in_at`, `last_out_at` | matched actual instants, nullable |
| `work_minutes`, `late_minutes`, `early_leave_minutes` | non-negative integers |
| `status` | closed segment status vocabulary |
| `policy_snapshot` | shift, segment, group, rule, timezone, and version IDs |

Daily `attendance_records` stays the compatibility aggregate:

- `first_in_at = min(segment.first_in_at)`;
- `last_out_at = max(segment.last_out_at)`;
- `work_minutes = sum(segment.work_minutes)`;
- late/early values are summed from segments;
- status is derived from the segment result set;
- the break between segments is never counted.

Punch-to-segment matching must be deterministic and mutation tested. An event
that matches two segments is an ambiguity, not permission to pick the first.

### 3.3 Flexible attendance

Flex is a separate shift policy, not a reinterpretation of grace:

```text
mode: strict | flex_required_duration
requiredMinutes: integer
arrivalWindowBeforeMinutes: integer
arrivalWindowAfterMinutes: integer
coreStartTime: time | null
coreEndTime: time | null
```

Recommended v1 scope:

- `flex_required_duration` is supported only for a one-segment shift;
- actual expected start is the first valid arrival clamped to the configured
  arrival window;
- expected end is expected start plus `requiredMinutes`;
- optional core hours must remain covered;
- late/early grace applies only after the flex expectation is resolved;
- multi-segment flex remains blocked until a separate contract defines whether
  flexibility applies per segment or to the day.

### 3.4 Effective calculation-group membership

Group membership needs `effective_from` and `effective_to` date boundaries.
There may be many historical rows, but at most one effective
`calculation_group` for a user, org, and date.

Date intervals are inclusive because existing attendance assignment contracts
use `start_date <= work_date` and `end_date >= work_date`. A null
`effective_to` is open ended. Moving a user on date `D` closes the previous row
at `D - 1` and starts the next row at `D`; two rows containing `D` are a
conflict.

The write path must:

- lock the user's membership timeline;
- reject overlap, including concurrent overlap, before committing either row;
- preserve the old row for history;
- record actor, reason, and correlation ID;
- never modify the user's org membership.

Runtime repeats the uniqueness check rather than trusting clean writes. Zero
effective groups resolves to the explicitly configured org default; two or more
effective groups returns `ATTENDANCE_CALCULATION_GROUP_CONFLICT`, emits an audit
event, and performs no attendance-result write. It never chooses by creation
time, update time, or row order.

The calculation precedence is:

1. an approved temporary shift or published direct/rotation assignment;
2. the effective group's schedule/rule references;
3. the org default rule.

Calendar overrides and approved attendance requests remain orthogonal layers.
The chosen group/rule/shift versions are frozen into the record snapshot.

### 3.5 Group effective-policy read model

Add a values-free, org-scoped aggregate read endpoint. It does not introduce a
new write path.

It returns:

- group type, timezone, active member count, and manager posture;
- schedule strategy and whether it is fully configured;
- rule source and whether it is effective or preview-only;
- punch method source (`org_inherited` in v1);
- overtime, makeup-punch, and outdoor-request posture;
- unresolved conflicts and the exact editor route for each item;
- effective date and source IDs, but no secrets or member list.

Authorization is checked before any aggregate SQL. A delegated attendance admin
must also be an active member of the target org.

### 3.6 Shared work-date resolver

Introduce one named `AttendanceWorkDateResolver` used by:

- live punch;
- CSV/XLSX import;
- approved makeup punch and time correction;
- approved overtime application;
- manual recomputation and scheduled derivation.

Input includes org, user, punch instant, event kind when known, explicit
work-date evidence when authorized, effective schedule candidates, existing
open records, approved overtime windows, and timezone.

Candidate generation is atomic at the semantic level: it produces tuples of
`(workDate, shiftId, segmentIndex, absoluteWindow)`. The resolver does not first
choose a date and then search that date for a segment, or first choose a segment
and derive the date afterward. That ordering shortcut would split a segment
crossing midnight or select the wrong same-day slot.

Output is:

```text
resolved:
  workDate
  shiftId
  segmentIndex | null
  reasonCode
  evidenceSnapshot
ambiguous:
  candidates[] # workDate, shiftId, segmentIndex, absoluteWindow
  reasonCode
unresolved:
  reasonCode
```

The resolver never silently falls back from `ambiguous` to the calendar date.
The caller either returns an actionable error or records a review-required
event according to the ratified caller policy.

Imports, corrections, approved requests, and recomputation resolve policy
`as-of workDate`, not as-of the operation timestamp. If a result already has a
frozen policy snapshot, an ordinary correction keeps that snapshot. Selecting
a newer policy requires a separately authorized, versioned recomputation that
records both the prior and replacement result.

PR #4558 is a valid narrow repair for live punches that fall inside a strict
overnight shift window. It does not settle the shared resolver contract,
post-shift tails, approved-overtime extension, import, or recomputation.

## 4. API and compatibility contract

### 4.1 Current parity repair (delivered by #4560)

OpenAPI now reflects these runtime fields already in use:

- `AttendanceGroup.attendanceType`;
- `AttendanceGroup.memberCount`;
- group POST/PUT `attendanceType`;
- shift PUT `isOvernight`;
- assignment response and POST/PUT `slotIndex` plus accepted legacy alias.

This parity repair added no runtime behavior. Future slices must keep generated
artifacts and the required attendance OpenAPI contract gate in sync.

### 4.2 New shift contract

Segment support adds:

- `segments[]`;
- `calculationMode: envelope | segments`;
- `plannedMinutes`;
- a compatibility envelope in existing start/end fields.

Unknown segment properties are rejected. Invalid segment arrays return a
field-specific validation error and write nothing.

### 4.3 No hidden group-policy mutation

The aggregate group endpoint is GET-only. UI commands continue to call the
existing typed endpoints for group basics, members, managers, assignments,
rule sets, and org punch policy.

## 5. UI contract

### 5.1 Group workspace

Keep the existing four-stage workspace and make source/effect explicit:

1. Basics: type, timezone, managers, effective state.
2. People: active calculation membership and dated changes.
3. Work time: schedule strategy, shifts, segments, and flex mode.
4. Policies: rule source, punch source, overtime, makeup, and outdoor posture.

Every summary shows one of:

- `Effective`;
- `Inherited from organization`;
- `Preview only`;
- `Needs configuration`;
- `Conflict - action required`.

Do not nest a second full editor inside the group page. Open the authoritative
editor in a drawer or focused route and return to the same group and stage.

For an existing group, type is displayed as immutable with a "Copy as new
group" action. The copy flow must not move members until an effective date and
impact preview are confirmed.

### 5.2 Shift editor

Use an ordered segment editor with explicit day-offset labels. Do not expose
raw `slotIndex` as the user concept. Slots remain a scheduling concept; segments
are part of one shift.

The editor previews:

- total planned minutes;
- unpaid gaps;
- midnight crossing;
- flex eligibility;
- the compatibility envelope.

### 5.3 Explainability

The employee and admin record views show:

- work date and why it was chosen;
- effective group, shift, timezone, and rule source;
- per-segment planned/actual times and anomalies;
- approved request overlays;
- a warning when current configuration differs from the frozen result.

## 6. Migration and rollout

1. Add schema with no runtime read cutover.
2. Backfill every legacy shift to one segment in a replay-safe migration.
3. Verify fresh DB, upgrade DB, and collision/invalid legacy fixtures.
4. Ship dual-read with feature flag default OFF.
5. Shadow-calculate segment results and compare with legacy results; do not
   write authoritative totals.
6. Enable for a synthetic staging org only.
7. Run overnight, multi-segment, flex, correction, import, and approval matrices.
8. Opt in named orgs; keep rollback to legacy reads while no segmented shift is
   active.
9. Remove dual-write only in a later, separately authorized cleanup.

No migration may rewrite historical attendance results.

## 7. Required verification

### 7.1 Database

- fresh migration and upgrade from pre-segment schema;
- one segment backfill for every legacy shift;
- replay idempotency;
- concurrent membership overlap rejection;
- inclusive boundary transition (`D - 1` to `D`) without a gap or double winner;
- cross-org FK and query isolation;
- rollback leaves both legacy envelope and segments unchanged.

### 7.2 Calculation

- `08:00-12:00` plus `13:00-17:00` yields 480 minutes, not 540;
- missing afternoon in/out produces a segment anomaly;
- duplicate punches resolve deterministically;
- a segment crossing midnight preserves the originating work date;
- same-day slots select by the containing segment window rather than the first
  assignment row;
- no-window and multiple-window matches return the ratified unresolved or
  ambiguous outcome;
- approved overtime extends only the named window;
- next-day shift overlap produces the ratified precedence or ambiguity;
- flex late-arrive/late-leave and early-arrive/early-leave;
- core-hours violation;
- DST gap/fold and two non-UTC timezones;
- group switch at the effective boundary;
- historical record snapshot is unchanged after configuration edits;
- a backdated import/correction uses policy as-of the business work date, not
  the submission timestamp;
- a legacy daily result remains `envelope_legacy` and receives no fabricated
  segment rows.

### 7.3 Entry-point parity

The same work-date cases run through live punch, import, approved correction,
approved overtime, and recomputation. Replacing any caller with calendar-date
fallback must make its parity test fail.

### 7.4 Mutation

At minimum:

- reintroduce first-to-last work-minute arithmetic;
- remove one segment from the sum;
- select the first overlapping group;
- use grace as attribution tail;
- choose the previous work date on ambiguity;
- remove org scope from every new query;
- recompute with current rather than frozen policy;
- accept multi-segment flex in v1.

Each mutation must have a named failing leg.

### 7.5 Frontend

- editor keyboard and screen-reader flow;
- segment order and overlap validation;
- responsive 375, 768, and 1440 pixel views;
- source/effect labels in every group policy summary;
- no save request from preview-only controls;
- no raw ID fallback;
- route return preserves group and stage.

## 8. Owner decisions required for runtime

| ID | Decision | Recommendation |
| --- | --- | --- |
| OD-4556-1 | Model 08-12 and 13-17 as one shift with segments, or only document two schedule slots | True shift segments; slots alone cannot produce correct actual minutes |
| OD-4556-2 | Maximum segments in v1 | Three, aligned with the existing three punch-pair reporting surface |
| OD-4556-3 | Flexible mode with multiple segments | Block in v1; support flex only for one segment |
| OD-4556-4 | Calculation-group cardinality | Exactly one effective calculation group per user/org/date |
| OD-4556-5 | Shift-level owner | Do not add authorization semantics; use group owner/sub-owner. Add shift steward metadata later only with a named workflow |
| OD-4556-6 | Unapproved post-shift attribution tail | Separate bounded setting, recommended 120 minutes; never reuse grace |
| OD-4556-7 | Approved overtime attribution | Approved end plus the bounded tail, tied to the same user/shift/work date |
| OD-4556-8 | Overlap between previous night and current-day shift | Existing open previous-night record wins; otherwise current-day containing shift wins; unresolved ties are actionable ambiguity |
| OD-4556-9 | Per-group punch policy | Keep org-inherited/read-only in this line; design per-group enforcement separately |
| OD-4556-10 | Group aggregate writes | No universal write endpoint; typed commands only |
| OD-4556-11 | Historical recalculation | Explicit operator action only; never automatic after configuration changes |
| OD-4556-12 | Existing group type change | Keep the in-place lock; offer copy-to-new-group plus effective-dated membership transition |

Ratification must record any deviation from these recommendations before the
corresponding runtime slice starts.

## 9. Development slices and model allocation

### 9.1 W0 - contract parity and capability truth

Scope:

- #4558 merged after exact-head review and all checks;
- #4560 fixed current OpenAPI drift with required-gate and mutation evidence;
- publish this capability ledger and design lock;
- update issue #4556 without claiming completion.

Suggested implementation: Grok for bounded OpenAPI/test edits; Codex for exact
runtime parity review and final diff.

Completion:

- OpenAPI focused contract test is wired and green on main;
- #4558 remains described as a narrow live-punch fix;
- no runtime accounting behavior changes in the parity PR.

### 9.2 W1 - effective group membership

Scope:

- effective-dated membership schema;
- one calculation group invariant;
- audit and concurrency tests;
- no calculation-chain cutover.

Suggested implementation: Kimi K3 for migration and real-DB fixture work;
frontier/Opus-class independent security review; Codex final review.

### 9.3 W2 - shared work-date resolver

Scope:

- ratified resolver contract;
- live/import/correction/overtime/recompute adapters;
- #4558 logic folded into the one implementation;
- no segment support yet.

Suggested implementation: frontier model or Grok on a narrowly specified
backend task; independent adversarial review is mandatory.

### 9.4 W3 - segment schema and authoring

Scope:

- segment migration/backfill;
- typed service and API;
- shift editor;
- flag remains OFF for authoritative calculation.

Suggested implementation: Kimi K3 for schema/service; Luna-class model for UI;
Codex integrates and reviews.

### 9.5 W4 - segment calculation and snapshots

Scope:

- per-segment event matching;
- daily aggregate;
- approval/import/recompute parity;
- shadow comparison, then staging opt-in.

Suggested implementation: highest-capability backend model; independent
mutation author; Codex final verdict.

### 9.6 W5 - flexible single-segment mode

Scope:

- strict discriminated policy;
- single-segment calculator;
- UI and explainability;
- multi-segment flex remains rejected.

Suggested implementation: Grok or Kimi for bounded policy implementation;
Luna-class model for UI; independent gate.

### 9.7 W6 - group effective-policy workspace

Scope:

- values-free aggregate read model;
- source/effect labels;
- authoritative editor navigation;
- no new universal write.

Suggested implementation: Terra-class backend work and Luna-class UI work in
disjoint files; Codex performs cross-layer review.

### 9.8 W7 - group policy calculation cutover

Scope:

- precedence and snapshots;
- conflict fail-closed;
- synthetic staging soak;
- named-org opt-in.

Suggested implementation: highest-capability backend model plus independent
real-DB and mutation gate.

### 9.9 W8 - verification and closeout

Scope:

- development and verification MD;
- operator migration/rollback runbook;
- issue acceptance ledger;
- no customer-acceptance claim without customer evidence.

## 10. Issue closure definition

Issue #4556 can close only when:

1. every acceptance item is mapped to a merged slice or explicitly removed by
   an owner decision;
2. multi-segment actual minutes exclude breaks and expose segment anomalies;
3. flex behavior is distinct from grace;
4. calculation-group changes are effective-dated and historically explainable;
5. all work-date entry points use the shared resolver;
6. OpenAPI, runtime, frontend, migrations, and tests agree;
7. staging migration, rollback, and synthetic accounting evidence are durable;
8. the user-facing group workflow shows what is effective, inherited,
   preview-only, or conflicting.

Until then, #4556 remains an umbrella issue with separately reviewable slices.
