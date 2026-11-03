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
- An already returned department id whose normalized parentId differs from the
  next returned row rejects the snapshot with the existing values-free
  incomplete-department sentence, before manager enrichment or preview/apply.
  The synthetic seeded root is not a returned id until a wire row replaces it.
  Same normalized parent keeps the later name, order, and source and does not
  requeue the id.
- Failures use values-free messages. User pull errors propagate through the
  existing sync failure path before the apply transaction or preview completes.
- New no-DB regressions drive the real client parsing and real fetchAllUsers
  with only the HTTP/client boundary mocked. They enter the existing backend
  unit-test glob; no skipped DB gate or new broad test runner.
- Process status (2026-11-01): the owner lifted Draft/HOLD for Ready and merge of
  this change only. No deploy/R71 change, tag or release, external writes,
  Stream/lifecycle enablement, migration or target acceptance. No unchanged green
  suite reruns.

This does not remove the user/get detail calls, decide real-tenant fields,
ratify offboarding semantics, or claim live/full-app/target acceptance.

## Deploy gate after merge

These gates have run only against HTTP mocks. Public documentation and existing
records do not show that every legitimate provider reply passes them, and one
rejected reply fails the whole pull on every run. A failed pull changes no
directory rows, but joiners and departures stop syncing, and this change adds no
flag: recovery is a code change or redeploying a prior build.

Any tag, package or image containing this change stays undeployed until a real
read-only probe on an isolated tenant passes with coverage, or the owner
explicitly waives it. Being on main does not grant this, and neither does the
standing tag authorization. Deploy authorization names a tag rather than its
contents, so whoever prepares or approves a deploy must check this gate.

The probe needs a tenant with a zero-direct-member department, a childless
department and a department with at least two direct members. It records types and
counts only, never ids, names, URLs or raw bodies, and uses preview, not a real
sync. It answers:

- Listing a childless department: is `result` an empty array, or omitted?
- `user/list` on a zero-direct-member department: is `list` an empty array, or
  omitted? Is `has_more` a boolean, or absent?
- Paging at size 1: is `has_more` boolean on every page, and is `next_cursor`
  usable and unrepeated?
- Across all rows: any missing or blank id or name, any malformed `dept_id_list`?
- `user/get`: does the returned id equal the requested id, once per unique user?
- Does the preview result agree with the walk's counts?

Any rejected shape blocks deployment, and the owner decides whether this lock
changes. A clean result clears that tenant at that time, not every tenant. Missing
coverage is inconclusive, not a pass.

Open owner decision: a tenant with a home-school contacts directory can get a
department row with id -7 under the root. The provider's guidance is to exclude
that row; the ID rule above rejects the whole listing. The prior code very likely
failed such a tenant too, but that is not proven, and its connectivity test can
change from pass to fail.
