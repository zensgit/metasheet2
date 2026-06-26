# T8-2 Reset-to-T runtime — development verification

> Grounded on PR #3214 (`claude/t8-2-reset-runtime-20260625`). This file records what the T8-2 runtime ships, what is
> proven by tests, and what remains out of scope. Re-verify against `origin/main` before using it as a future status
> ledger.

## Scope shipped

T8-2 Reset-to-T is the destructive point-in-time restore mode:

- it reverts surviving records to their state at T;
- it soft-deletes records created after T into `meta_records_trash`;
- it is gated by `MULTITABLE_ENABLE_PIT_RESET === 'true'`;
- it requires `canManageSheetAccess`;
- it refuses sheets over `MULTITABLE_SHEET_REVERT_MAX_RECORDS`;
- it requires `confirm: 'reset'` on execute;
- it is whole-sheet only in v1.

Reset is distinct from T8-1 Revert: Revert keeps post-T-created records and may partial-skip denied rows. Reset is
all-or-nothing.

## Load-bearing implementation locks

- **Preview identity:** `restore-preview-pit-reset` is a distinct token type from Revert. It binds the revert scope and
  the delete scope.
- **Delete-set identity:** the delete scope hash includes record id and preview-time version. A post-preview create or
  a post-preview edit of a delete target makes execute reject with `PREVIEW_IDENTITY_INVALID`.
- **Reset-specific enumeration:** Reset does not reuse Revert's invisible-row skip semantics. A row-denied, forbidden,
  schema-drifted, or undelete-required target blocks the whole Reset before any write.
- **Single transaction:** reverts, link updates, delete revisions, trash inserts, and live-row deletes happen inside one
  transaction. A failure during the delete-revision phase rolls back the already-started reverts too.
- **No target oracle:** destructive blocks return `RESET_BLOCKED` / `RESET_UNSUPPORTED` without leaking blocker ids,
  blocker counts, or denied record existence.

## Verification

Local non-DB checks run on the implementation branch:

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/multitable-record-lock-guard.guard.test.ts \
  tests/unit/multitable-richtext-longtext-write-sink.guard.test.ts \
  tests/unit/multitable-raw-record-data-projection.guard.test.ts \
  tests/unit/multitable-stored-data-taint-chokepoint.guard.test.ts \
  --reporter=dot
pnpm --filter @metasheet/core-backend test:unit
```

The real-DB suite is allowlisted into `test (20.x)` via
`packages/core-backend/tests/integration/multitable-reset-pit-realdb.test.ts`.

Goldens:

- `DATABASE_URL` sentinel so the suite cannot silently skip in CI;
- flag off -> preview and execute return `RESET_DISABLED`;
- flag on -> A/B revert to T, D is soft-deleted into trash, `source=restore` revisions written;
- locked delete target -> `RESET_BLOCKED`, zero writes, no blocker oracle;
- row-deny added after preview -> `RESET_BLOCKED`, zero writes, no blocker oracle;
- over ceiling -> `413`;
- missing or wrong typed confirm -> `400`;
- record created after preview -> preview identity mismatch, nothing deleted;
- delete target edited after preview -> preview identity mismatch, nothing deleted;
- forced delete-revision failure -> A/B reverts and D delete all roll back;
- source grep proves Reset does not compose reveal grants;
- plain record editor without sheet-access management -> forbidden.

### Coverage note — delete-permission branch (deliberately not separately golden-pinned)

Delete-permission branch is intentionally not separately golden-pinned: `!canDeleteRecord` is shadowed
by canWrite/canEditRecord, and `!ensureRecordWriteAllowed` is only reachable through narrow write-own
scope setup. The mechanism it relies on, throw -> RESET_BLOCKED -> single-transaction rollback, is
covered by locked-target and forced mid-write atomicity goldens.

(Context: a no-write actor blocks at the revert field-forbidden preflight and 409s at PREVIEW before
reaching the delete branch, so a dedicated golden would require a brittle write-own-scope + foreign
`created_by` fixture for low marginal value — the safety property is already proven. No runtime change.)

## Remaining work

Not part of T8-2 v1:

- enabling `MULTITABLE_ENABLE_PIT_RESET` in any real environment;
- async reset for sheets above the synchronous ceiling;
- permission-filtered subset reset;
- T8-1 undelete-execute, which needs resurrect + link-rebuild;
- T9-W irreversible config restore slices.

