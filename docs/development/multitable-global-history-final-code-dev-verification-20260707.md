# Global History — final code-dev pass verification (2026-07-07)

This is a dated implementation and verification record for the 2026-07-07 owner GO:
"complete the remaining code-development items for the history/restore line, plan/order parallel work, and deliver a
design + verification MD." The canonical source remains current `origin/main` plus the existing
`multitable-global-history-*` docs; this file records what this pass changed.

Base reviewed and re-verified after rebase: `origin/main` at `7bb0a5feace1bf2540a5c016f481e514e45c2ddf`.

## 0. Execution order

1. **Backend safety guard first** — block PIT Reset whenever meta-revision retention is enabled. This is a fail-closed
   safety invariant and is independent of UI.
2. **Reset T-source product entry** — replace the normal destructive Reset entry's free-form time source with an
   audited Global History batch selector, keeping manual datetime only as an Advanced fallback.
3. **Config-restore destructive FE** — expose the already-shipped T9-W destructive/sensitive config tiers through the
   existing Config History modal using server previews and typed confirms.
4. **Boundary review** — re-read delete-revision / field-value recovery code. The honest boundary is unchanged:
   historical bytes and link edges that were never captured cannot be recovered retroactively.

Items 2 and 3 were developed in isolated worktrees in parallel, then integrated into one final branch with item 1.

## 1. Code changes

### 1.1 PIT Reset retention conflict guard

Files:
- `packages/core-backend/src/routes/univer-meta.ts`
- `packages/core-backend/tests/integration/multitable-reset-pit-realdb.test.ts`

Behavior:
- If `MULTITABLE_ENABLE_PIT_RESET=true` and `MULTITABLE_META_REVISION_RETENTION_ENABLED=1`, both
  `/reset-preview` and `/reset-execute` now return:
  - HTTP `409`
  - `RESET_RETENTION_CONFLICT`
  - zero writes
- This turns the previous runbook-level STOP-SHIP condition into an executable backend guard. It does not enable any
  flag.

Golden:
- `(b2) retention guard: PIT_RESET + meta revision retention enabled -> 409 RESET_RETENTION_CONFLICT, ZERO writes`
  verifies preview refusal, execute refusal, survivor records unchanged, post-T record still live, no trash insert, and
  no `source='restore'` revision.

### 1.2 History-anchored Reset T-source

Files:
- `apps/web/src/multitable/components/ResetToPointPicker.vue`
- `apps/web/src/multitable/views/MultitableWorkbench.vue`
- `apps/web/tests/multitable-reset-tsource-picker.spec.ts`

Behavior:
- The default Reset entry now lists recent Global History batches via `listHistoryEvents(baseId, { sheetId, limit: 20 })`.
- Selecting a batch passes that batch's exact `createdAt` ISO to `reset-preview` and `reset-execute`.
- Manual `datetime-local` remains available under Advanced manual time as an explicit fallback.
- The entry remains hidden unless `pitResetEnabled` is true.

Wire locks:
- history list is scoped by base + sheet;
- preview receives the selected batch `createdAt` ISO, not a recomputed local time;
- execute receives the same selected batch ISO and fires the existing refresh seam on success.

### 1.3 T9-W destructive/sensitive config restore FE

Files:
- `apps/web/src/multitable/api/client.ts`
- `apps/web/src/multitable/components/MetaConfigHistoryModal.vue`
- `apps/web/src/multitable/utils/meta-record-labels.ts`
- `apps/web/tests/multitable-config-history-modal.spec.ts`

Behavior:
- The Config History modal now lets create/delete/permission revision rows open the server preview instead of hiding
  the action client-side.
- Existing safe update previews keep the old diff UI and execute body.
- Destructive/sensitive server preview shapes are rendered faithfully:
  - `uncreate` -> typed confirm `uncreate`;
  - `undelete` -> typed confirm `undelete`, blocked on `idCollision`;
  - `permissionRevert` -> typed confirm `revert-permission`, executable only when server says `supported: true`.
- The modal passes the typed confirm explicitly to the workbench/client. The client also keeps a token->confirm fallback
  for compatibility, but the workbench path no longer relies on hidden client state.

Wire locks:
- ordinary update execute still sends server `previewToken` and no client baseline hash;
- destructive execute sends `previewToken + confirm:"uncreate"`;
- permission and undelete previews cannot execute until their server-shaped conditions are satisfied.

## 2. Boundary deliberately not changed

No production/staging flags were enabled in this pass.

The single-record version restore route still refuses delete revisions with `RESTORE_UNSUPPORTED`. That is not the same
as PIT undelete or recycle-bin restore:
- PIT undelete reconstructs a record at a point in time and is already implemented behind `MULTITABLE_ENABLE_PIT_UNDELETE`.
- Trash restore resurrects the delete-time trash row.
- A record-version target whose revision action is `delete` means "the record did not exist at that version"; treating
  its pre-delete snapshot as a normal restore target would be a semantic lie.

Value-level recovery for already-destroyed field data also remains impossible: historical config revisions store field
definitions, not the removed per-record column bytes, link edges, or auto-number sequence state. A forward-looking
tombstone-capture feature could preserve future destructive deletes/retypes, but it cannot recover bytes that were
never captured before this pass.

## 3. Verification

Targeted first pass:

```bash
cd /private/tmp/ms2-gh-final/apps/web
./node_modules/.bin/vitest run \
  tests/multitable-reset-tsource-picker.spec.ts \
  tests/multitable-config-history-modal.spec.ts \
  --watch=false --reporter=dot
# 2 files, 29 tests passed

./node_modules/.bin/vue-tsc -b
# passed

cd /private/tmp/ms2-gh-final
/Users/chouhua/Downloads/Github/metasheet2/node_modules/.bin/tsc \
  -p packages/core-backend/tsconfig.json --noEmit
# passed
```

Backend real-DB guard pass:

```bash
DATABASE_URL=postgres://metasheet:metasheet@127.0.0.1:5435/<fresh-db> \
  vitest --config vitest.integration.config.ts \
  run tests/integration/multitable-reset-pit-realdb.test.ts --reporter=dot
# 1 file, 13 tests passed
```

Scoped Global History / restore backend pass on a fresh migrated DB:

```bash
DATABASE_URL=postgres://metasheet:metasheet@127.0.0.1:5435/<fresh-db> \
  vitest --config vitest.integration.config.ts run <31 history/restore real-DB files> --reporter=dot
# 31 files, 303 tests passed
```

Scoped Global History / restore frontend pass:

```bash
cd /private/tmp/ms2-gh-final/apps/web
./node_modules/.bin/vitest run <13 history/restore FE specs> --watch=false --reporter=dot
# 13 files, 104 tests passed
```

Cleanup:
- both disposable PostgreSQL databases were dropped with `DROP DATABASE ... WITH (FORCE)`;
- dependency symlinks used only to run tests from the temporary worktree were not staged.

## 4. Final state

The code-completable remainder opened by this GO is implemented:
- retention conflict is an executable backend guard;
- Reset has a history-anchored T-source product entry;
- destructive/sensitive T9-W config restore tiers have FE preview/confirm/execute wiring.

Remaining work is not autonomous code completion:
- environment flag enablement is an operator/owner rollout decision;
- production rollout is separate from staging;
- already-destroyed field values/link edges cannot be recovered without prior tombstone capture;
- any future tombstone-capture/value-level recovery feature is forward-looking and should be designed as its own
  product capability, not represented as retroactive recovery.
