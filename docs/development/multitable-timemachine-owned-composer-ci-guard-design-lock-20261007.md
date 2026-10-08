# Owned composer guard census correction

Status: bounded test/CI repair; Draft/HOLD, no product activation.
Source parent: `9d4b847be3847bdc73a3c867fca738f856cc63b8`.
Refreshed main: `cc6ca96ac21547b342c1e06ec425d77b6ed43e01`.

The ordinary composer CI at `f817f010fce37e903440eb8a2a5ca69caf070c6f`
failed eight static guard assertions in two existing specs. Both Node jobs failed
before the native composer step. The APFS descendant reproduces the same eight
failures in two complete files: 104 cases, 96 PASS, 8 FAIL, zero skip.
Corrected G4's predecessor CI is independently qualified successful at `f3e730e9`.

Source review identifies four new owned archive fence holders absent from the
field-schema ledger, and one new shared authority row-lock statement absent from
the sheet-liveness ledger. These are real census omissions; no SQL mock/protocol
failure was observed. The new holders mutate archive metadata and
`meta_sheets.recovery_writer_*`, not user record data or ACLs.

## Minimal repair and invariants

- Bound edits to the two existing guard specs plus this contract/verification.
  Production bytes, workflow, configuration, provenance and flags remain exact.
- Classify only the four exact observed owned keys, preserving all existing region,
  transitive writesVia/entryWritesVia, declaration identity and unknown-holder guards.
  Derive actual call sites from source, never add a blanket path/name exemption.
- Do not claim the shared `SELECT id ... FOR UPDATE` reads deleted_at in that
  statement. Normal authority recheck acquires the lock, then re-reads the shared
  live binding through the same RC query and validates the same transaction ID
  before returning to the write caller. Give this exact key a mechanically checked
  under-lock binding verdict, without increasing a GAP ceiling.
- Exact-owner abandonment intentionally does not require current liveness,
  flags, permissions, keys or producer lease validity. Mechanically constrain its
  exact owner tuple and its terminalize/release write set. Do not impose a new
  production liveness predicate on failure cleanup.
- Every old ledger entry, sibling negative and security assertion remains intact.
  New owner/fence/cleanup classification must be falsifiable by a matching guard
  test; it must not silently admit any future unknown holder or lock.

## Verification

1. Preserve whole-file pre-repair failure and exact input/source hashes.
2. Run both whole guard files and relevant owned authority/composer/claim neighbors.
3. Remove one new holder entry and weaken each new mechanical proof in a controlled
   source/test mutation: matching negative assertions must fail. Preserve original
   bytes, restore exactly, then rerun complete affected files.
4. Independently review final source and evidence; check focused test types,
   configured validation, default CI collection and unchanged production bytes.
5. Publish a bounded Draft/HOLD continuation and one unique ordinary exact-head CI;
   retain failed ancestor runs and read actual native step execution afterward.

If inspection reveals a genuine production guard defect, stop this test-only
implementation, identify the concrete defect and amend the bounded repair before
editing product source. Passing these static specs alone does not qualify native
owned capture, APFS backup/restore, interrupted continuation, Phase 5 or staging.
