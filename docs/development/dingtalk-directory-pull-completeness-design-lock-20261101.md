# DingTalk directory pull completeness — design lock (2026-11-01)

Existing scope: directory sync hardening (DT-HARDEN-05 / DT-OPS-01), under the
sync integrated roadmap. This is a correctness repair to the existing pull/apply
boundary. It adds no integration mode, flag, provider write or rollout permission.

A successful pull must represent every returned directory row and every
advertised user page. Currently missing lists/invalid rows can become an empty
or partial directory, a missing cursor truncates a multi-page pull, and repeated
cursors keep the pull running.

## Gates

- Missing/non-array department or user lists reject the pull. Preserve both
  accepted department list shapes and explicit empty arrays.
- The user pagination flag must be an explicit boolean. Missing/invalid flags reject the page.
- IDs accept nonempty strings or non-negative safe integers; names must be nonempty strings.
- A supplied department-list parent is null when omitted, null, or blank after trim.
  Nonempty strings keep their trimmed text, including out-of-scope parents and parent 0.
  A non-negative safe integer becomes its decimal string. Arrays, objects, booleans,
  fractional numbers, negatives, and unsafe integers reject the whole department list
  with the existing values-free incomplete-department sentence. Preserve both accepted
  list shapes, explicit empty lists, and row id, name, order, and source mapping.
- Supplied department memberships must be arrays of valid ID scalars; malformed lists
  or elements reject the pull before apply. Preserve omitted/null fallbacks, explicit
  empty arrays, ordering and well-formed IDs outside the selected department map.
- A row lacking its identity or name rejects the whole page instead of being
  silently filtered out. Valid rows keep their current field mapping.
- If hasMore is true, nextCursor must be a non-negative safe integer not used in
  that department. Detect immediate repeats and longer cycles before fetching
  that invalid page's user details.
- A user/get detail must resolve the requested user ID. Reject mismatches and
  malformed ID/name types; retain the requested-ID fallback for omitted identity
  and preserve optional profile/manager fields.
- Every non-null supplied department-detail ID alias must match the ID sent on
  the wire; malformed/conflicting aliases and non-finite numeric wire identities
  make that department's enrichment fail. Preserve legacy
  omitted/null identity fallback and manager normalization. The existing
  best-effort path carries prior managers forward and continues other departments;
  a matching success-empty remains authoritative. Its warning is values-free.
- Cursor sets are per department. Do not require monotonic cursors. An explicitly
  final page may omit its cursor. Keep unique-user detail deduplication and
  multi-department membership merging.
- A parent cycle in the pulled department map rejects the snapshot before manager
  enrichment or preview/apply can consume it. Keep existing null and out-of-scope
  parent semantics for valid graphs.
- Failures use values-free messages. User pull errors propagate through the
  existing sync failure path before the apply transaction or preview completes.
- New no-DB regressions drive the real client parsing and real fetchAllUsers
  with only the HTTP/client boundary mocked. They enter the existing backend
  unit-test glob; no skipped DB gate or new broad test runner.
- Keep Draft/HOLD. No merge/deploy/R71 change, external writes, Stream/lifecycle
  enablement, migration or target acceptance. No unchanged green suite reruns.

This does not remove the user/get detail calls, decide real-tenant fields,
ratify offboarding semantics, or claim live/full-app/target acceptance.
