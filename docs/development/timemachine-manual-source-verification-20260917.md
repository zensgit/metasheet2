# Manual Capture Relational Source Checkpoint

Status: internal prerequisite implemented; manual capture end-to-end OPEN.
Base: `89f1ecdee2c3b70205a318074824c834bc6a5c7e`.
Code: `fed4c4d281ce960b739c37a8a9e83aaed14496df`.
Tree: `b7be65db277e8ca71004c73eecf662992fd4aeac`.
Delivery: continue Draft/HOLD #5849; no independent policy PR.

## Implemented

`readRecoveryArchiveRelationalSource` projects seven relational sections with
one SQL statement. PostgreSQL's statement snapshot avoids cross-statement
READ COMMITTED drift between these sections. Scope requires the supplied
sheet/base/workspace tuple and a non-deleted sheet. Canonical row admission
snapshots/sorts rows; duplicate identities and malformed section shape fail
closed. Links/sequences referring to fields outside the captured schema refuse
the entire projection instead of disappearing. Bigint sequence values are text;
tombstone timestamps are canonical UTC milliseconds. Errors are values-free.

This internal function is not an authorization service, source-seal certificate,
archive, complete snapshot or publication token. Callers must authenticate and
derive its scope. No route or worker calls it yet. Attachment and permission
evidence are deliberately absent from its return type, not fabricated as empty.
Their future builders and the final source-boundary protocol remain required.

## Verification

- Unit + canonical-row neighbor: 2 files / 26 tests PASS, including a clean-code
  repeat after commit. This uses default backend Vitest discovery; no selector
  change is needed for the new `tests/unit/*.test.ts` file.
- Backend `pnpm exec tsc --noEmit`: PASS.
- Source `pnpm exec eslint src/multitable/recovery-archive-relational-source.ts`:
  PASS. `git diff --check`: PASS.
- Local PostgreSQL 15 projection probe: PASS for all seven sections, wrong
  workspace/base, deleted and empty sheets, exact bigint > JS safe integer,
  UTC tombstone timestamp, and cross-schema link refusal.
- Mutation replacing the workspace equality predicate with a non-null parameter
  check caused the real SQL scope negative to fail with missing expected
  rejection. Restored source returned GREEN, followed by unit GREEN.

The real SQL probe ran before commit against the bytes committed above. It used
a task-owned PG cluster and minimal mirror tables, NOT a full migrated schema,
not concurrent publication, and not capture-to-restore acceptance. Initial probe
attempts hit local module resolution and null-prototype comparison issues;
those were harness failures, corrected before the reported passing run.

Run-owned database and backend counts were zero at cleanup. The dedicated
cluster stopped and its data directory was removed. No existing database was
used. The local probe is `artifacts/manual-source/check.mts` (not a CI test),
SHA-256 `5b7ac150a86a4e220bb028b01dce29f7d17a95dedf87034d1948af7a3a871659`.

Source SHA-256:
`c4c308ce3850994e325eecc949d70373c5fe7a9f951d4ff9c4ebf0dac8deae25`.
Unit SHA-256:
`81fad86a1cc3493cb604978455cfcad09d104bd10b5d5577c9c0fac93a640182`.

## Open Gates

Full migration acceptance; source seals and concurrent source movement;
attachment capture; permission evidence; repeated manual capture beyond initial
bootstrap; request identity; authenticated receipt publication; HTTP/UI;
independent final review; exact-head CI. None is waived by this checkpoint.
No scheduling, retention change, flag enablement, customer storage, deployment
or production operation was performed.
