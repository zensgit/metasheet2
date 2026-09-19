# Attachment Restore Verification

Status: LOCAL IMPLEMENTATION IN PROGRESS; no executable attachment restore yet.

Base: `868c8d2b26424fcaa8405661a6999abb17ec6d93` (#5849 merge).
Contract: `e4625f322` (full parent available in Git).
First code checkpoint: `0158b581001d630a470d39b2476c2cfb0c48b16e`.
Source/authorization checkpoint: `19d8e6e49996ff6a1083697dcaa22b118f463a2e`.
Branch: `codex/timemachine-attachment-restore-20260919`.

## Completed Local Evidence

- Internal descriptive cell planner preserves original reference ordering and
  selected scope without changing input maps or scalar values.
- Explicit empty scope, malformed/duplicate references, missing or duplicate
  attachment index evidence, archived-deleted references, wrong original record/
  field, missing live record and missing selected field fail closed.
- Scalar-only selection and identical attachments remain no-op; restoring an
  empty reference list plans detachment, not file deletion.
- Two files / 24 unit tests PASS: attachment-plan and existing archive-preview.
- Core `type-check` PASS (including archive acceptance script project).
- Source ESLint and diff-check PASS.
- Mutation removes original record/field ownership checks: precisely the two
  ownership cases fail (10 pass / 2 fail). Restore and both suites PASS 24/24.
- Existing installed dependencies were linked into this new worktree; no install
  or dependency/lockfile change.

The helper is not called by runtime yet and is not an authorization proof. Its
new unit file is not yet explicitly enrolled in the required archive CI lane;
local success is not published-head CI evidence. No successor PR is published.

## Source And Authorization Checkpoint

- Attachment-only and mixed scalar/attachment plans project into the canonical
  write-intent shape, preserving live versions, exact changed-field IDs, scalar
  peers and input immutability. Drift, duplicate cells and conflicting ownership
  reject the complete projection.
- The existing canonical plan authorizer accepts a writable attachment field,
  refuses hidden/read-only fields, and rechecks current management authority.
  Omitting attachment changed-field IDs yields exactly two false-allow failures;
  restoring the projection returns the suite to green.
- The real encrypted reader now privately retains authenticated attachment
  generation/workspace/base/sheet/record/field, deleted state, size and media
  type. Restore-source access checks all original identities, refuses archived-
  deleted/missing entries and forged state, and returns defensive binary copies.
  This was exercised through both the internal reader and public complete-state
  reconstruction. It does not invent the absent archived display filename.
- Removing the original record/field checks produced the targeted real-reader
  failure. Restored final run: four files / 58 tests PASS (reader, attachment plan,
  canonical plan authorization and archive preview).
- Core type-check (both projects), source ESLint and diff-check PASS.

These are real reader and authorization-component checks, not end-to-end file
restoration. No storage preparation, metadata update or live restore is enabled
by this checkpoint. The public preview still refuses attachment differences.

## Remaining Required Work

Authenticated-reader integration; prepared file ownership and crash cleanup;
preview/token binding; explicit attachment field authorization; canonical atomic
metadata/reference/history apply; purge/drift/retry concurrency; async contract;
whole-operation negatives; real isolated database/storage and desktop/mobile
browser acceptance; required CI wiring and independent exact-head review.
Existing `unsupported_attachments` remains in force until that chain is complete.

Sol high's bounded read-only integration review was closed while running without
a terminal verdict. No external approval is claimed. #5849 post-merge CI was
still running with no observed failure; PR-head green is not substituted for it.
No flags, dispatch, deployment, real environment or customer storage/data access.
The read-only nightly plan is in the paired design lock; it has not been executed
against any real environment.
