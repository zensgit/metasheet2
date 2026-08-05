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
| `aggregate-conflict-membership-overlap.json` | §4.4: `CALCULATION_GROUP_MEMBERSHIP_OVERLAP` with `affectedUserCount` only (W6-R2 — never user IDs), `people` stage `editorRef` (OD-W6-9(a)); winner selection stays W7 (W6-R5, parent R2). |
| `aggregate-conflict-fixed-schedule-changed.json` | W6-R4: FSER `configuration_changed` embed with group-safe `managedSets` drift, byte-shaped like the FSER lock response; conflict `FIXED_SCHEDULE_CONFIGURATION_CHANGED` routes to `schedule?surface=assignments` via the #4711 family (W6-R8). |
| `invalid-reject-member-leak.json` | W6-R2 negative: response carrying `memberIds` / `userId` keys must fail the exact-key contract validator. |
| `invalid-reject-unknown-label.json` | W6-R6 negative: unknown `label` and `calculationPosture` enum values must be rejected, never silently defaulted. |
| `invalid-reject-open-editor-ref.json` | W6-R8 negative: an `editorRef` carrying a caller-supplied admin `section` id outside the closed tables must fail parsing. |

Namespace note (shared-DB discipline): when W6-1 turns these shapes into
seeded real-DB rows, fixture IDs must be file-namespaced
(`w6agg-<case>-<runstamp>`), not bare `Date.now()`.
