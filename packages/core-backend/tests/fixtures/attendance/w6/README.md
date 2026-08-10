# W6-1 (#4556) group effective-policy aggregate — fixture pack

Synthetic contract shapes only — every UUID, date, and count below is
fabricated for the contract; nothing here comes from production or customer
data.

Governing document:
`docs/development/attendance-issue-4556-w6-group-effective-policy-design-lock-20260805.md`.
Machine-shape twins:
`packages/openapi/drafts/attendance-w6-group-effective-policy.draft.yml` and
`packages/core-backend/src/attendance/w6-group-effective-policy-contract.ts`.

Each `aggregate-*` fixture is the exact-key deepEqual expectation for a
seeded real-DB scenario (design lock §7.2), and each `invalid-reject-*`
fixture is a negative vector that the contract validator must reject.

| Fixture | Design-lock clause(s) it encodes |
| --- | --- |
| `aggregate-effective-fixed-shift.json` | §4.3 baseline response shape; §4.2 label `effective`; OD-W6-2(a) FSER object embedded verbatim for a `fixed_shift` group; OD-W6-6(a) single-segment `strict` shift stays `effective` under `legacy` posture; W6-R2 values-free (counts + config IDs only). |
| `aggregate-org-inherited-defaults.json` | §4.3 `rules.source='org_default'` → label `org_inherited`; `punchMethod`/`requestPosture` fixed to `org_inherited` (parent OD-4556-9); `fixedSchedule: null` for a non-`fixed_shift` group (OD-W6-2(a)). |
| `aggregate-preview-only-segments-flex.json` | OD-W6-6(a): a multi-segment shift plus `flex_required_duration` under `calculationPosture='legacy'` labels `segments`/`flex` `preview_only` with reason `SEGMENT_CALCULATION_NOT_AUTHORITATIVE`; W5 `mode` mirrored read-only. |
| `aggregate-needs-configuration.json` | §4.2 label `needs_configuration`; conflict codes `SCHEDULE_STRATEGY_INCOMPLETE` + `TIMEZONE_MISSING` (OD-W6-4(a)); `timezone: null` surfacing rule. |
| `aggregate-conflict-membership-overlap.json` | §4.4: `CALCULATION_GROUP_MEMBERSHIP_OVERLAP` with `affectedUserCount` only (W6-R2 — never user IDs), `people` stage `editorRef` (OD-W6-9(a)); winner selection stays W7 (W6-R5, parent R2). Carries both `shift` and `fixed_schedule_config` sourceRefs, matching every other fixture with a non-null `fixedSchedule.desired`. |
| `aggregate-conflict-fixed-schedule-changed.json` | W6-R4: FSER `configuration_changed` embed with group-safe `managedSets` drift, byte-shaped like the FSER lock response; conflict `FIXED_SCHEDULE_CONFIGURATION_CHANGED` routes to `schedule?surface=assignments` via the #4711 family (W6-R8). |
| `aggregate-configured-scheduled-shift.json` | OD-W6-6(a) applied to a configured `scheduled_shift` group: v1 resolves no single shift, so the single-segment-strict exemption cannot apply and `segments`/`flex` are `preview_only` under a non-authoritative posture. |
| `aggregate-conflict-unpublished-managed-row.json` | §4.2 closed-set completeness: pins the shape that gives `FIXED_SCHEDULE_UNPUBLISHED_MANAGED_ROW` (one of the seven ratified OD-W6-4(a) codes) its producer — FSER state stays `effective` (its own predicate excludes unpublished rows) while the aggregate escalates `drift.unpublishedManagedRows > 0` into `conflicts[]`. Also the only fixture carrying a null `endDate` (a legal open-ended managed row). |
| `invalid-reject-member-leak.json` | W6-R2 negative: response carrying `memberIds` / `userId` keys must fail the exact-key contract validator. |
| `invalid-reject-unknown-label.json` | W6-R6 negative: unknown `label` and `calculationPosture` enum values must be rejected, never silently defaulted. |
| `invalid-reject-open-editor-ref.json` | W6-R8 negative: an `editorRef` carrying a caller-supplied admin `section` id outside the closed tables must fail parsing. |

Namespace note (shared-DB discipline): fixture IDs seeded into the real-DB
matrix are file-namespaced (`w6agg-<case>-<runstamp>`), never a bare
`Date.now()`.
