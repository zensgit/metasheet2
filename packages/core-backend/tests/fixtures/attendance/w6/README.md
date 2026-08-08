# W6 (#4556) group effective-policy aggregate — fixture pack (PROPOSED)

Status: **PROPOSED / runtime HOLD**. Synthetic contract shapes only — every
UUID, date, and count below is fabricated for the draft contract; nothing here
comes from production or customer data.

Governing document:
`docs/development/attendance-issue-4556-w6-group-effective-policy-design-lock-20260805.md`.
Machine-shape twins:
`packages/openapi/drafts/attendance-w6-group-effective-policy.draft.yml` and
`packages/core-backend/src/attendance/w6-group-effective-policy-contract.ts`.

No test consumes these fixtures in W6-0 (zero-behavior preparation; red line
W6-R9). At W6-1 they become the seed/assertion vectors for the real-DB matrix
(design lock §7.2): each `aggregate-*` fixture is the exact-key deepEqual
expectation for a seeded scenario, and each `invalid-reject-*` fixture is a
negative vector that the contract validator must reject.

| Fixture | Design-lock clause(s) it encodes |
| --- | --- |
| `aggregate-effective-fixed-shift.json` | §4.3 baseline response shape; §4.2 label `effective`; OD-W6-2(a) FSER object embedded verbatim for a `fixed_shift` group; OD-W6-6(a) single-segment `strict` shift stays `effective` under `legacy` posture; W6-R2 values-free (counts + config IDs only). |
| `aggregate-org-inherited-defaults.json` | §4.3 `rules.source='org_default'` → label `org_inherited`; `punchMethod`/`requestPosture` fixed to `org_inherited` (parent OD-4556-9); `fixedSchedule: null` for a non-`fixed_shift` group (OD-W6-2(a)). |
| `aggregate-preview-only-segments-flex.json` | OD-W6-6(a): a multi-segment shift plus `flex_required_duration` under `calculationPosture='legacy'` labels `segments`/`flex` `preview_only` with reason `SEGMENT_CALCULATION_NOT_AUTHORITATIVE`; W5 `mode` mirrored read-only. |
| `aggregate-needs-configuration.json` | §4.2 label `needs_configuration`; conflict codes `SCHEDULE_STRATEGY_INCOMPLETE` + `TIMEZONE_MISSING` (OD-W6-4(a)); `timezone: null` surfacing rule. |
| `aggregate-conflict-membership-overlap.json` | §4.4: `CALCULATION_GROUP_MEMBERSHIP_OVERLAP` with `affectedUserCount` only (W6-R2 — never user IDs), `people` stage `editorRef` (OD-W6-9(a)); winner selection stays W7 (W6-R5, parent R2). **CORRECTED in the W6-1 rebuild** — see the amendment note below. |
| `aggregate-conflict-fixed-schedule-changed.json` | W6-R4: FSER `configuration_changed` embed with group-safe `managedSets` drift, byte-shaped like the FSER lock response; conflict `FIXED_SCHEDULE_CONFIGURATION_CHANGED` routes to `schedule?surface=assignments` via the #4711 family (W6-R8). |
| `aggregate-configured-scheduled-shift.json` | OD-W6-6(a) applied to a CONFIGURED `scheduled_shift` group: v1 resolves no single shift, so the single-segment-strict exemption cannot apply and `segments`/`flex` are `preview_only` under a non-authoritative posture. Added in the W6-1 rebuild because that branch previously hard-coded `effective` with no posture read at all — fail-open in exactly the direction §9 closes — and had zero fixture and zero test coverage. |
| `aggregate-conflict-unpublished-managed-row.json` | §4.2 closed-set completeness: `FIXED_SCHEDULE_UNPUBLISHED_MANAGED_ROW` (one of the seven RATIFIED OD-W6-4(a) codes) had NO producer anywhere in the implementation. This pins the shape that gives it one — FSER state stays `effective` (its own predicate excludes unpublished rows) while the aggregate escalates `drift.unpublishedManagedRows > 0` into `conflicts[]`. Also the only fixture carrying a NULL `endDate`, which the response contract previously rejected (a legal open-ended managed row 500'd). |
| `invalid-reject-member-leak.json` | W6-R2 negative: response carrying `memberIds` / `userId` keys must fail the exact-key contract validator. |
| `invalid-reject-unknown-label.json` | W6-R6 negative: unknown `label` and `calculationPosture` enum values must be rejected, never silently defaulted. |
| `invalid-reject-open-editor-ref.json` | W6-R8 negative: an `editorRef` carrying a caller-supplied admin `section` id outside the closed tables must fail parsing. |

Namespace note (shared-DB discipline): when W6-1 turns these shapes into
seeded real-DB rows, fixture IDs must be file-namespaced
(`w6agg-<case>-<runstamp>`), not bare `Date.now()`.

## W6-1 rebuild amendments to this pack (flagged for owner visibility)

This pack landed on `main` under the W6-0 authorization, so an edit to it is a
SPEC edit, not a test fix. Three changes were made during the W6-1 rebuild and
are surfaced here rather than folded in silently:

1. **`aggregate-conflict-membership-overlap.json` corrected.** It pinned
   `domains.schedule.sourceRefs` to a single `{kind:'shift'}` entry despite a
   non-null `fixedSchedule.desired`. That shape is UNREACHABLE by construction:
   the aggregate appends a `fixed_schedule_config` ref whenever the config row
   resolves, and a non-null `desired` implies the config row exists (both are
   read from `attendance_group_fixed_schedule_configs` under the same
   `org_id`/`group_id` predicate, and `id` is a NOT NULL uuid PK). Fixtures 1
   and 6 carry BOTH refs on an identical `desired` shape, so no trigger
   condition distinguished this one. The prior branch resolved the mismatch
   TEST-side (a local patch plus a `not.toStrictEqual` guard); the correction
   belongs in the fixture, so all fixtures state one consistent rule and the
   suite can be a plain exact-key deepEqual.
2. **`aggregate-configured-scheduled-shift.json` added** (seventh fixture) —
   the configured-`scheduled_shift` branch had zero coverage and was
   fail-open.
3. **`aggregate-conflict-unpublished-managed-row.json` added** (eighth
   fixture) — gives a RATIFIED conflict code its first producer, and pins the
   two-schedule-domain-conflicts-in-one-response shape that follows from it.

Each is reversible by amendment; none changes a §4.2 closed set's MEMBERSHIP
(no code added, no code removed from the ratified lists).
