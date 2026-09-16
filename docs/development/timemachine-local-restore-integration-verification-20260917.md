# Local Restore Integration Verification

Status: LOCAL CHECKPOINT; seeded-catalog database/process restore passes.
Production capture, clean-machine backup/import and remote integration CI remain open.

## Binding

Integration parent: `ad1462dec2a9922e3f4b743876b808d8526164bf`.
This report accompanies the narrow application compatibility fix and two unit
test extensions. Historical source PR evidence is not new integration CI.

## Results

- Required-web selector census: main 390, archive parent 391, union 392;
  missing parent selectors 0/0.
- New application positive before fix: 1 failed / 33 passed, with
  `RECOVERY_ARCHIVE_APPLICATION_COMPOSITION_FACTORY_FAILED`.
- After fix, eight unit files: 174/174 passed.
- Core `type-check`: PASS.
- ESLint for `src/multitable/recovery-archive-application.ts`: PASS.
- `git diff --check`: PASS.
- Required-web shell syntax (`bash -n`): PASS; full Web suite not run here.

## Independent Review

Sol high reviewed the exact three-file uncommitted implementation/test delta
over the integration parent. Verdict: 0 P1 / 0 P2 / 0 P3. Review covered
capability authenticity/revocation and test false-green risks. It was static
only: no reviewer test/DB/network execution. Session
`01a0abb1-db97-72b3-8e1c-80f0fe0c35ba` completed and was closed.

Unit invocation from repository root:

```sh
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/multitable-recovery-archive-reader.test.ts \
  tests/unit/multitable-recovery-archive-file-store.test.ts \
  tests/unit/multitable-recovery-local-custody.test.ts \
  tests/unit/multitable-recovery-local-custody-store.test.ts \
  tests/unit/multitable-recovery-archive-crypto.test.ts \
  tests/unit/multitable-recovery-archive-application.test.ts \
  tests/unit/multitable-recovery-archive-preview.test.ts \
  tests/unit/multitable-recovery-archive-authenticated-manifest.test.ts \
  --reporter=dot
```

## Discriminating Evidence

The application test accepts the genuine opaque local capability and rejects a
spread copy before resolving database runtime. Existing KMS missing-method and
flag-off tests remain green. The real old composition guard produced the RED;
the compatibility fix produced GREEN.

The persistent-reader test writes actual encrypted objects through the POSIX
provider, writes encrypted custody packages through the custody store, rotates
keys, locks the writer, and constructs fresh store/session instances. Exact
recovered payloads include one existing record and one tombstone. Wrong-secret
unlock stays locked; deleted synthetic custody/object files fail closed. Test
cleanup removes only its unique temporary roots and scrubs the two secrets.

This test runs in one process. Its selected binding is a fixture, and nonce
reservation is a no-op fixture. It does not prove database publication, process
restart, actual row writes, or restore-job completion.

## Remaining Gates

- Production capture and clean-machine catalog backup/import are not established
  by the seeded-catalog process drill below.
- Broad merged-tree gates and remote exact-head CI before publication claims.
- No Ready, merge, flag, dispatch, deployment or customer-storage action.

## Database/Process Follow-up

On local parent `8e2832f60`, dedicated PostgreSQL 15 initialized with UTF8 and
the C locale applied all 406 migrations; second replay succeeded without new
migrations. The unmodified restore-jobs suite passed 39/39, zero skips.
An initial invocation incorrectly used the no-DB default config and collected
no tests; it failed and is not counted. The real run used the workflow's
`vitest.integration.config.ts` with `METASHEET_REAL_DB_TEST_STEP=1`.

Four test/helper files then add a local-storage variant to that already-wired
suite. The new selected case passed 1/1 (39 intentionally unselected), exercising
the persistent providers, real transactional nonce reservation, locked parent
custody, SIGKILL after a committed chunk, independent-process reopening, and
exactly-once 5,001-row restoration plus derived-effect drain. An initial missing
test constant import was corrected before the passing run.

Mutation: remove the child's persistent object-provider assignment, leaving
the prior IPC provider active. The case fails with
`archive_local_process_must_read_own_objects`. Restore the assignment and verify
the worker helper SHA-256 returns to
`856aabb4361cec7b1dd7d91954803dc25d113ddcb000afbadcb0bfa030f60bb3`.
The worker was subsequently narrowed to pass only location/identity fields to
the custody store (never the recovery secret); its final SHA-256 is
`29511de71e4d60eb37e673aa2b636a3e493833de0214b113c984c5ca521808a7`.

Independent Sol review found a real P2: old fixture cleanup did not include
nonce reservations or namespaced local key IDs. Independent old-database census
confirmed 40 nonce rows and four local keys after the exploratory runs. That
disposable database was dropped, not treated as a clean final baseline.

Code checkpoint `7dfbec510a48eeff143aec8fd438a232fbfc49f4` tracks the exact
identities it creates, cleans them under the existing test-only transaction
bypass, and asserts zero counts before clearing tracking sets. Sol's narrow
follow-up verdict was 0 P1 / 0 P2 / 0 P3; static only, session
`01a0abd7-691f-77a1-827e-a8413767d994` closed. No production invariant changed.

Final newly created PostgreSQL database: fresh 406 migrations + no-op replay
PASS; restored full suite **40/40, zero skipped**, 208.981 seconds; local unit
neighbors **8 files / 174 tests PASS**. Acceptance-script TypeScript config
(`tsc -p scripts/tsconfig.recovery-archive-acceptance.json --noEmit`) and diff-check
PASS. The four test/helper runtime blobs match that code checkpoint; only this
verification report differs afterward. No product source changed in this round.

Final independent census: archives, restore jobs, derived effects, nonce
reservations, local keys, fixture sheets, fixture users and other database
connections all zero (`0|0|0|0|0|0|0|0`). Both task-owned databases dropped;
database-prefix/backend census `0|0`; dedicated PG stopped and PGDATA removed.
The two source PRs and their remote branches were not modified.

The synthetic catalog and frozen plan are seeded using existing test helpers;
this does not establish production capture or clean-machine catalog import.
Independent-process restart within the same host is distinct from restoring a
database backup onto another host. No secret is written into source/evidence:
the synthetic random recovery secret crosses only private parent/child IPC.

## Current-main Integration Gates

Checkpoint `2a9ae319870d3da2d385c931ab108ffd917da5a0` is a conflict-free
true merge of `3d7a8b6c946788c583a6012ee1ed2a5d7230df8b` and main
`d732f62b65f63f93a20114807fa4484fb98d1265`. The new main delta is record-read
sheet-liveness enforcement and its unit test. No source PR was rewritten.

- Latest-tree focused neighbors: four files / 80 tests PASS, including all nine
  record-liveness cases. Core typecheck and diff-check PASS.
- Required-web script: exit 0; all 19 groups PASS, final group 464 files / 7,138
  tests. Group counts overlap and must not be presented as unique test totals.
- Six recovery/archive wiring scripts: 101/101 PASS before this merge; their
  source bytes are unchanged by the merge.
- Multitable OpenAPI parity: 1/1 PASS. Official OpenAPI build/generation/guard
  PASS with no tracked generated drift.
- Full sealed-export S5 chain PASS, including live/frozen provenance comparison.
- Web app-only `vue-tsc --noEmit -p tsconfig.app.json` PASS with a private
  temporary build-info file. Full web `type-check` is NOT PASS locally: the
  shared installed dependencies produce TS2769 in `vite.config.ts(28,29)` from
  Vite 5/7 plugin type incompatibility. Config and root/web manifests and lockfile
  are byte-identical to main. No product/config workaround was applied.
- Missing isolated-worktree CLI dependency entries were supplied using existing
  ignored dependency links and temporary NODE_PATH; no install or lockfile edit.
- Terra high read-only integration audit, session
  `01a0abfe-86a3-7aa2-99db-3224e328a714`: 0 P1 / 0 P2 / 0 P3. It verified web
  selector union, local-custody unit discovery, whole-file real-DB CI wiring and
  application lifecycle/admission preservation. Session closed; this is static
  review, not an additional runtime test.

The prior 40/40 real-DB evidence remains bound to `7dfbec510`, not a fresh DB run
on this replay. Remote successor exact-head CI is still required; publication
as Draft/HOLD is not merge approval or a claim of complete product readiness.
