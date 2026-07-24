# Attendance Issue #4556 W2-W3 Development and Verification

- Date: 2026-07-24
- Repository: `zensgit/metasheet2`
- Status: W2 and W3 are delivered on `main`
- Umbrella issue: #4556 remains OPEN for W4-W8
- Authorization boundary: this record documents delivered behavior. It does
  not authorize W4 runtime, a feature-flag transition, deployment, production
  data, issue closure, or a release tag.

## 1. Completion statement

W2 and W3 of the RATIFIED attendance shift/group capability program are
complete on `main`:

1. W2 provides one shared, fail-closed work-date resolver and routes live
   punch, import, approved correction, approved overtime, recomputation, and
   scheduled absence attribution through the locked contract.
2. W3 provides a normalized one-to-three-segment shift model, replay-safe
   legacy backfill, canonical transactional shift service, typed API and SDK,
   reference-safe deletion, and an ordered responsive segment editor.
3. Authoritative segment calculation is deliberately not delivered by W3.
   Multi-segment shifts remain preview-only. Every reference-producing path
   named by the W3 safety erratum rejects a multi-segment shift with zero
   writes while the calculation capability is unavailable.
4. Legacy envelope fields remain compatibility projections. They are not
   payable time for a multi-segment shift, and neither API nor UI represents
   them as such.

The four merge commits below are ancestors of the recorded `main` head
`ee8e586f74a69ae03102a93abd39bfc659e1e7be`.

## 2. Delivered ledger

| Slice | Pull request | Merge commit | Delivered boundary |
| --- | --- | --- | --- |
| W2 shared work-date resolver | #4567 | `f1e390977e57dc1239e312c7423f3cda2d1f055f` | Shared resolver, caller adapters, frozen correction/overtime attribution, import fail-closed parity |
| W3 safety erratum | #4568 | `d6fa5d19b7a3a4fda86161dcaf9d1ff61e11c65b` | Flag-OFF writer matrix, reference lock protocol, non-destructive rollback and delete semantics |
| W3 schema and backend | #4569 | `c5f08aecd5732d70b616561398d8456240f62486` | Segment schema/backfill, service/API/SDK, capability projection, reference-safe deletion |
| W3 editor and Web guard | #4570 | `ee8e586f74a69ae03102a93abd39bfc659e1e7be` | Ordered editor, exact canonical payload, preview-only UX, responsive/a11y behavior, test wiring |

The implementation heads reviewed before squash were:

- W2 final required-check repair: `2be61e352cf5cd1323fd1497e659b9dece923196`.
- W3 safety erratum: `19af69f44183ad886eb21774869ed810855195b8`.
- W3 backend: `78aecb770dd4566c499698518cdda5a47d514fa5`.
- W3 frontend: `6f92936e2d11ef4a43d3c1c17ed602a60d0b02a6`.

## 3. W2 contract and evidence

### 3.1 Delivered behavior

- `AttendanceWorkDateResolver` owns attribution rather than each caller
  reconstructing calendar-date logic.
- Candidate reads are org and user scoped.
- Attribution tails are bounded.
- Overlapping candidates produce ambiguity instead of first-row selection.
- Overnight D/D+1 attribution is shared across callers.
- Approved correction and overtime consume creation-frozen attribution.
- Non-null segment identity is rejected until the separately authorized
  segment-aware contract exists.
- Unresolved or malformed scheduled/import attribution writes no attendance
  record.
- Live fallback is restricted to the locked unresolved-reason allowlist.

### 3.2 Verification

Initial adversarial gate on implementation head `7580ecdfa`:

- focused unit matrix: 87/87;
- attendance integration: 267/267 across ten files on a fresh migrated
  PostgreSQL database;
- backend typecheck and CJS syntax checks: PASS;
- ten named mutations: independently RED, restored, with positive controls;
- two independent review lanes: APPROVE, 0 P1 / 0 P2 / 0 P3.

The final head `2be61e352` then repaired two full-suite contract findings:

1. classified the new accounting-attribution setting outside the W4 readiness
   registry;
2. taught scoped import harnesses the resolver's read-only dependencies.

Its local CI-faithful focused rerun was 114/114. The final required workflow
run `30036250668` passed Node 18, Node 20, coverage, migration replay,
contracts, Web tests, and the other required jobs. The Node 20 job completed
the real-DB path in 17m28s.

Durable gate comments:

- `https://github.com/zensgit/metasheet2/pull/4567#issuecomment-5062209565`
- `https://github.com/zensgit/metasheet2/pull/4567#issuecomment-5062261742`

## 4. W3 backend contract and evidence

### 4.1 Schema and compatibility

- The canonical shift service persists one to three dense ordered rows in
  `attendance_shift_segments`; the service owns the dense/order invariant.
- Existing shifts are backfilled as one segment.
- A legacy row without segment rows is synthesized as segment zero on read.
- Create and update use the canonical shift service and update the segment
  rows plus compatibility envelope in one transaction.
- Migration replay and upgrade paths are covered, including partial dispatch
  foreign-key repair.
- Destructive schema rollback is fail-closed once segment data exists.

### 4.2 Flag-OFF safety

The reserved segment-calculation capability remains unavailable. While it is
unavailable:

- multi-segment authoring is preview-only;
- assignments, rotation assignments, swaps, dispatch targets, schedule
  publish, and automatic matching cannot create a live reference to a
  multi-segment shift;
- converting a referenced one-segment shift to multiple segments is rejected;
- typed rejection occurs before any durable write;
- the legacy envelope cannot be used as authoritative payable time.

No environment flag was enabled by W3.

### 4.3 Delete and history semantics

- Shift deletion locks the parent and checks durable reference classes in the
  same transaction.
- Assignments, rotation rules, pending swaps, and pending/published dispatches
  block deletion with typed conflict and zero writes.
- Rejected shift-swap snapshots, cancelled dispatch snapshots, and automatic
  matching candidates do not block deletion and are retained with neutral
  labels. Assignment rows, including inactive or ended history, remain
  blockers.
- Deleted-shift responses expose no raw UUID fallback.
- Dispatch target shift references use nullable `ON DELETE SET NULL`.

### 4.4 Verification

Exact backend head `78aecb770`:

- fresh database migration from zero: PASS, pending migrations 0;
- full attendance integration under `TZ=UTC`: 13 files / 305 tests;
- W3 focused real-DB suites: 39/39;
- shift service unit suite: 24/24;
- admin users: 65/65;
- Web regressions: 130/130;
- backend and Web typecheck: PASS;
- final OpenAPI parity: 14/14;
- OpenAPI validation, code generation guard, and diff check: PASS.

The final parity gate was proved load-bearing: removing the strict HH:MM
pattern made exactly one of the 14 checks fail. Eight additional backend
mutations independently killed the flag implementation posture, pre-DDL
legacy validation, transaction normalization, orphan redaction, index
ownership, partial foreign-key repair, parent lock ordering, and two-segment
zero-write guard.

Independent exact-head review verdict: APPROVE, 0 P1 / 0 P2 / 0 P3.

Durable gate comment:

- `https://github.com/zensgit/metasheet2/pull/4569#issuecomment-5064281552`

Final required workflows passed, including Node 18/20, migration replay,
OpenAPI/contracts, attendance Web guard, Web tests, and coverage. The principal
plugin run was `30050885159`.

## 5. W3 frontend contract and evidence

### 5.1 Editor behavior

- The shift form uses an ordered one-to-three paid-segment editor.
- Every row exposes start time, end time, and an explicit same-day/next-day
  label.
- Add, move up/down, and remove actions use icon buttons with titles and
  accessible names.
- The preview shows paid minutes, unpaid gaps, midnight posture, flex
  eligibility, and compatibility envelope.
- Paid minutes sum segment durations and never count intervening gaps.
- A cross-midnight segment must be final; more than one midnight crossing is
  rejected.
- Strict minute-resolution HH:MM, positive duration, ordering/overlap, segment
  count, and 24-hour total are validated before any save request.
- Multi-segment flex is represented as unavailable.

### 5.2 Wire and compatibility behavior

- Save sends canonical `segments[]` only.
- It does not mix `workStartTime`, `workEndTime`, or `isOvernight` into the
  same request.
- Legacy shifts normalize to one editable segment.
- Quick-start template apply converts the target draft to the template's one
  segment.
- Template undo restores the complete previous segment list and editing
  posture; a subsequent PUT sends the restored canonical segment payload.
- The shift list shows ordered segments, planned minutes, and the fail-closed
  preview-only posture.
- Delete confirmation names the backend transaction's actual blocker classes
  rather than claiming that all historical evidence blocks deletion.

The editor and pure analysis were extracted under
`apps/web/src/views/attendance/`; the large `AttendanceView.vue` gained only
the host wiring and did not absorb another full editor implementation.

### 5.3 Verification

Exact frontend head `6f92936e2`:

- Web typecheck: PASS;
- attendance admin plus setup-template regressions: 179/179;
- pure segment boundary tests: 8/8;
- scoped lint: zero errors; only pre-existing multi-component warnings remain
  in the legacy regression file;
- responsive browser inspection at 1440, 768, and 390 pixels: no editor
  overlap or editor horizontal overflow;
- required `attendance-web-guard`: PASS in run `30052797527`;
- full `web-tests`: PASS in run `30052797544`;
- Node 18: PASS;
- Node 20: PASS in 17m15s;
- coverage: PASS.

The following mutations were independently RED and restored:

1. reintroduce a legacy envelope key into the save payload;
2. bypass overlap validation;
3. calculate paid time as first-start to last-end;
4. discard the template segment snapshot during undo.

The fourth mutation changed a restored two-segment shift into one envelope
segment and made the exact post-undo PUT assertion fail. This proves that the
new template fixture is not a cosmetic update.

The pure boundary spec is explicitly present in both pull-request and push
path filters and in the actual `attendance-web-guard` Vitest run list.

Independent exact-head review verdict: APPROVE, 0 P1 / 0 P2 / 0 P3.

Durable gate comment:

- `https://github.com/zensgit/metasheet2/pull/4570#issuecomment-5064489037`

## 6. Explicitly not delivered

W2/W3 do not deliver or authorize:

- authoritative per-segment attendance calculation;
- `attendance_record_segments` result rows or immutable calculation snapshots;
- punch-to-segment event matching;
- segment-aware import/correction/overtime/recompute writes;
- shadow comparison, named-org opt-in, or rollback state transitions;
- single-segment flex calculation;
- calculation-group policy precedence;
- W6/W7 effective group-policy runtime;
- a production or staging flag transition;
- customer acceptance, deployment, issue closure, or a release tag.

These remain W4-W8 work under separate design and owner gates.

## 7. W4 stop gate

Read-only post-W3 reconciliation found that §9.5 of
`attendance-shift-group-advanced-capability-design-lock-20260723.md` is a
high-level roadmap, not a sufficiently precise authorization for
financial/time-accounting runtime. Before W4 implementation, a separately
reviewed amendment to that lock must close at least:

- the per-segment status/reason vocabulary and daily aggregation precedence;
- deterministic event matching windows, ambiguity, duplicates, DST gap/fold,
  and prohibition of silent UTC fallback;
- the exact append-only policy/input/result snapshot schema, version source,
  immutability, and atomic daily aggregate pointer;
- the boundary between W4 legacy-context segment calculation and W7
  calculation-group policy precedence;
- live/import/correction/overtime/recompute/scheduled writer parity;
- shadow-difference vocabulary, opt-in preconditions, suspended posture, and
  safe rollback state machine;
- the minimum OpenAPI and record-detail explainability surface.

The recommended order remains:

`W4 amendment RATIFY -> schema/snapshot/vocabulary -> pure matcher/DST ->
shadow writers -> all-entry parity -> shadow ledger/API/UI -> synthetic
staging opt-in`.

W4 runtime must not begin merely because this W2/W3 verification record lands.

## 8. Final W2/W3 verdict

W2 and W3 are complete and verified on `main`. Their completion is bounded:
work-date attribution is shared, and multi-segment shifts can be modeled,
edited, validated, stored, and inspected safely while authoritative
calculation remains unavailable. Issue #4556 correctly stays OPEN for W4-W8.
