# Attendance fixed schedule customer feedback repair

Date: 2026-10-24
Status: implementation authorized by the owner in the attendance chat for the two P1 and two P2 findings in the 2026-10-24 customer review. Draft PR and CI are authorized. Merge, real backfill, deployment and feature enablement remain owner-gated.
Base: `771170234e95ff67c0b1d32b2e4929c08d7ee39e`.

## Scope and acceptance

This is a corrective slice for the group fixed-schedule editor: read the group's saved desired configuration, edit it safely, explain multi-segment reference eligibility, and render all shift segments. It does not declare the five-surface FSER-4 delivery complete, change effective-calendar semantics, rewrite frozen attendance contexts, enable a rollout, or publish a package. Package ownership is coordinated with the DingTalk development chat; this branch supplies reviewed source only.

The existing #4709 desired configuration and derived effectiveness service remain authoritative. Saving desired configuration creates no assignments, events, notifications or recalculation. Applying/rebuilding continues to consume the locked configuration and preserves exact producer ownership. Clearing is explicit and limited to the selected managed shift/window; it never changes the desired configuration.

## Read contract

Add `GET /api/attendance/groups/:groupId/fixed-schedule/editor`, authorized by the same authenticated actor/org and group-preview permission as the existing preview route. The admin aggregate route and its response remain unchanged. Reuse its canonical service internally and return only `groupId`, `state`, `reasonCodes`, `desired`, `drift.managedSets` and `referenceEligibility`; do not expose aggregate coverage or member identities.

An optional validated `shiftId` query selects the unsaved candidate. Without it, use the desired shift; with neither, `referenceEligibility` is null. Otherwise it is `{ shiftId, allowed, reasonCode }`, where `reasonCode` is null or `ATTENDANCE_SHIFT_MULTI_SEGMENT_CALCULATION_DISABLED`. Validate the candidate's authenticated-org ownership and count its persisted segments with schema failures surfaced. Resolve the existing canonical posture on a real database transaction. Missing posture support retains the existing closed legacy behavior; unreadable dependencies return unavailable, never optimistic eligibility. This projection describes segment reference eligibility, not a grant of write permission or a guarantee that all write-time checks will pass. Writers independently recheck their existing guards.

## Conditional configuration save

Preserve the existing PUT config route and provide `POST .../fixed-schedule/config/update` using the same handler for the existing constrained-client network path. Add optional `expectedConfigRevision`: integer 0 means the client observed no config; a positive integer means it observed that revision. Omitted preserves legacy callers.

A stale positive revision, a positive revision with no row, or a concurrent winner against expected 0 returns the existing typed 409 before any configuration or assignment change. Expected 0 uses insert-if-absent. Existing-row conditional writes use the same configuration-before-shift lock order as the consumer. Re-saving equal values preserves revision and audit timestamps; a stale revision is still rejected. No migration is needed.

The new UI always supplies this condition, distinguishes Save configuration from Apply/Rebuild, verifies the save response, and reloads authoritative state. Apply/Rebuild submit the matching revision and candidate. A 409 reloads and stops; it never retries with an automatic overwrite. Configuration save remains available with zero target members and when multi-segment reference use is disabled.

## Frontend behavior

Use a sibling composable for parsing, operation state and stale-response suppression. Bind reads and writes to org, group, generation, candidate and revision. Changing any relevant scope invalidates preview/eligibility; stale success, failure and finally callbacks cannot modify a newer scope. An unavailable or malformed read stays unavailable, with no fallback to the newest shift or today's dates. A genuinely unconfigured group starts with no selected shift.

Show saved configuration, pending application and drift from server projections. Expose each old managed set with its exact clear operation; do not clear automatically or substitute the new desired tuple. Clear remains independent of multi-segment admission and of configuration saving.

Use the existing segment formatter for the weekly matrix, including gaps and next-day markers. A missing shift in the first list page may be fetched by its existing scoped detail endpoint; a missing/unreadable shift is explicit and cannot silently become another shift.

## Gates

| Gate | Required evidence |
| --- | --- |
| Group identity | A/B distinct desired configs survive selection and reload; org switches and delayed replies cannot cross scopes; off-page desired shifts are handled explicitly. |
| Configuration | First save, changed shift/date, no-op save, zero members, stale revision and concurrent first saves; rejects perform zero writes. |
| Materialization | Explicit save then apply/rebuild with current revision; changed candidate/stale preview cannot dispatch; old managed sets cleared only by exact user-selected tuple. |
| Segments | Legacy/disabled and canonically admitted org positives/negatives; no DTO-driven policy fallback; unavailable schema; independent clear; full segmented and overnight display. |
| Authorization | Existing preview manager positive, other-group negative, forged org/actor and unauthenticated negatives before scoped reads. Existing write checks remain authoritative. |
| Tests | Focused unit, mounted Vue, and isolated real PostgreSQL CAS/neighbor tests. New frontend spec appears in attendance-web-guard and required-web script. Guard mutations produce real failed assertions and are restored byte-for-byte. |
| UI | Synthetic browser screenshots at desktop/tablet/mobile widths and review of actual changed controls. |
| Delivery | Independent final diff review, exact-head CI, Draft PR, verification MD; no merge/deploy/backfill/enable or duplicate package publication. |
