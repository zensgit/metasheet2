# Attendance QA Report Fixes - Development Record - 2026-09-12

## Status

PROPOSED. This change is based on `origin/main` at
`02ca7b1ef5145b84760f4a5471b3e0a4f7ca1300`. It has not been merged or
deployed by this workstream.

## Input

The source QA archive was reviewed as evidence, not as an instruction source:

- Archive: `metasheet-attendance-qa-pack-2026-09-12.tar.gz`
- SHA-256: `f616ab4a5c51529c357e346df44be05bf9c75a4785ebddc488d48f395545b515`
- Primary observations: a completed punch pair rendered as still clocked in,
  browser-local time was mixed with rule-local work dates, and the synthetic
  test family lacked the policy and assignment fixtures required to exercise
  leave, overtime, and shift swap.

The archive also contained plaintext test credentials despite its README
claiming otherwise. The original archive was preserved byte-for-byte and was
not used to authenticate. A separate local sanitized copy was produced.

## Implemented Changes

### Employee overview and reports

- A completed check-in/check-out pair now renders as `Clocked out` and keeps
  both timeline nodes. The old untyped latest-punch fallback no longer turns a
  historical checkout into a false clocked-in state.
- The hours label is date-aware (`Hours - <work date>`) rather than claiming a
  historical fallback row is today's total.
- Clock, work-date, weekday, punch timeline, and report timestamps use a
  validated attendance rule/workday timezone. Missing or invalid timezone
  evidence renders an unavailable placeholder instead of silently falling
  back to the browser timezone.
- Punch requests carry a validated effective rule timezone when known. If the rule
  timezone is unavailable, the field is omitted so the backend owns derivation
  or rejection; the browser timezone is never substituted.
- Report mode does not load the current self-service rule. Historical report
  timestamps use only each record's persisted workday timezone evidence;
  missing, invalid, or mixed record timezones render explicit unavailable or
  multi-timezone states instead of borrowing today's rule.
- Administrative audit, run, membership, and configuration timestamps retain
  their prior browser-local presentation. Those cross-user operational values
  have no single employee workday timezone and must not depend on `/rules/me`.

### Assignment provenance

- The assignment list now returns only the producer type already stored on
  `attendance_shift_assignments`; producer keys, reference IDs, and run IDs
  remain undisclosed because the employee UI does not need them.
- The existing shift-swap candidate predicate can therefore exclude
  producer-managed range assignments and retain only active, published,
  manual, single-day regular assignments.
- Workday context summaries expose the validated timezone persisted on each
  record. Current shift/rule resolution still supplies schedule labels and
  workday comparison data, but cannot rewrite historical timestamp context.

### Synthetic QA seed

- Each synthetic user receives the existing self-service read permission in
  addition to punch permission.
- Each synthetic organization receives a dedicated active leave type and
  overtime rule, updated idempotently by stable business keys.
- Each user receives a deterministic view-only scheduler scope over the closed
  synthetic user family.
- Two users receive deterministic manual, published, single-day assignments on
  the same date after the soak window. The seed now rejects
  `users_per_org < 2` because that shape cannot exercise shift swap.
- Deterministic scope and assignment identifiers are RFC 4122 version-4-shaped
  UUIDs, not raw MD5 values cast to UUID.

## Design Boundaries

- No migration, feature flag, rollout posture, production data, or customer
  data is changed.
- The seed additions remain inside the pre-existing closed synthetic soak
  family and are inert until the already-gated runner is explicitly executed.
- This change repairs forward rendering and QA fixture reachability. It does
  not rewrite the historical record shown in issue `#5558` and does not claim
  that the test machine already runs this branch.
- No credential from the source archive was used, transmitted, or committed.

## Review Split

- Kimi K3 reviewed the frontend state and timezone paths. Its findings led to
  explicit invalid-timezone handling, report-row timezone formatting, the
  date-aware hours label, removal of the current-rule request from report mode,
  required-lane wiring for the punch outcome spec, and preservation of
  administrative operational timestamps outside employee rule context.
- Grok 4.6 reviewed the backend and seed changes. Its findings led to RFC
  version/variant bits, same-day two-user assignments, the minimum-user guard,
  removal of the seed's UTC fallback, and a matching pre-SSH workflow lower
  bound for `users_per_org`. Its exact-head review also independently caught
  the administrative timestamp regression and the mixed-record timezone
  fallback; both were reproduced before repair.
- Codex retained implementation ownership and independently reran the tests in
  the companion verification record.
