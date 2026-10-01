# Time Machine expired-builder and process-crash verification

Status: bounded local prerequisite, Draft/HOLD. This is not full D7/D-L, merge,
staging execution or production acceptance. Contract:
`multitable-timemachine-expired-builder-crash-design-lock-20261001.md`.

## Source identity and scope

- Evidence main baseline: `ef9eb2d86cf4cbef7327036368f92ca3eb0f53d3`.
  Latest observed main is `0386f47fdc9a3e88f38e06c46547389fda42d3d7`; its
  shared auth/features and required web additions need separate integration
  validation. Historical runs are not relabeled as that main.
- Prerequisites: cleanup PR #6195 `9d1d589ea0da7aad79e5482fc29a41e5db69026f`
  and standalone APFS PR #6199 `240f108271d2972572a0ccea87bdf53e8c2e3529`.
  Both remain separate Draft/HOLD candidates; no GitHub merge is performed.
- Local prerequisite integration/lock: `d7628e19388436ae1fe31325ed04d2e3993fe77f`.
  Main's private-database drain and all prerequisite test selectors are retained.
- Runtime implementation: `f1203646f153d316146ee128210cf6a63d60c0ab`.
  The new 47-line `abandonExpiredRecoveryArchiveBuilder` module has SHA256
  `5b4beb92cd4894f9f78d631158e5988974859ba346eca42d7971b51b74ae6b37`.
- Strengthened crash/renewal tests: `606fdf0fb6d1da6aed22c35b76e1a5aa77750392`.
- Late-MAC acceptance: `47882779f87ea4fae38d62c4dc994934edabc05b` in its owned
  acceptance checkout. Publication source `10c5008264d0053e88356cc864d55ad6275e9d12`
  has the identical whole tree `3338a1533ed5ab73746ac068904fa2207dedfcc4`.
  This child changes only the pre-code lock, checkpoint call and sibling test
  helper; all production `src`/`core` bytes remain identical to `606f`/`f120`.
  The verification-report publication child is distinct from these tested SHAs.
- Checkpoint producer repair: `f6cc402d27e5a410b9fc2232aa41091615ae0328`.
  It adds only `TEST_DATABASE_URL`, equal to the adjacent producer-owned
  `DATABASE_URL`, to the sanitized neighbor environment. No inherited database
  input is accepted; the child's pre-IPC equality guard remains unchanged.
  Production source, schema and lease/timing policy are byte-identical to `97a`.
- Standard archive workflow producer repair:
  `eb66e3f1bc60416ff4684b54a51936f7492b119c`. The existing exact multitable
  step adds the same explicit test database alias. Its existing parsed CI guard
  adds equality and target-scoped missing/mismatched alias negatives. All fourteen
  selectors, helper forwarding, child guard and production bytes remain unchanged.

The explicit operation locks the existing canonical scope and rechecks authority,
then uses the same exact expired owner/fence/source-vector/scope predicate in its
locked read and update. It changes only `build_status` to `abandoned` (the existing
trigger maintains `updated_at`). Cleanup claims ownership separately. It releases
no pins, changes no provider receipts, and preserves prepared payloads, nonces and
key references. No route, scheduler, startup caller, schema, production lease
default, provider timeout policy or automatic transient-error abandonment is added.

## Verified gates

| Gate | Evidence and boundary |
| --- | --- |
| Exact expired-owner CAS | PASS at `f120`; live lease, wrong owner/fence/scope/source vector and non-single-row results refuse. Input is snapshotted before awaiting. |
| Unit/security neighbors | PASS: 192 tests at `f120` (7 CAS, 31 census, 120 schema behavior, 24 abandoned provider, 10 receipt); independent focused replay 72 PASS. |
| Real process deaths and renewal race | PASS at `606f`: independently repeated 62 realDB tests, zero skipped; D2b 25 + source-pin 18 + claim-anchor 19. `pg_blocking_pids` proves CAS blocked behind a renewal held past the original lease; renewal commit makes CAS refuse without changing the renewed row. |
| Durable cleanup reconciliation | Builder SIGKILL occurs after durable pre-PUT registration and actual LOCAL PUT, before its DB receipt. Cleaner SIGKILL occurs after raw ciphertext absence and exact operation-bound status receipt, before its terminal DB receipt; the source pin is still retained. Fresh processes reuse the persisted namespace and operation UUID. All eleven terminal receipts precede source-pin release. |
| Historical manual capture and late MAC | PASS at `4788277`/identical tree `10c5008` in its declared local wrapper environment: 9 realDB files / 239 passed / zero skipped, including D2b 25; canonical replay twice, 33 migrations / 1026 catalog objects and identical fingerprint; genuine within-lease publication with 11 verified objects remains a positive control. That wrapper also supplied `TEST_DATABASE_URL=DATABASE_URL`, masking the tracked producer omission; this is not unmodified official-runner/CI parity. Independent read-only review checked all three source and thirteen log hashes, actual collection and teardown; wiring replay 6/6 PASS. |
| Repaired official checkpoint producer | PASS at `f6cc402`: tracked official runner on a new exclusively owned PostgreSQL 15 cluster, Node 24.14.1; 9 realDB files / 239 PASS / zero skipped, D2b 25, both canonical 33-migration/1026-object replays, genuine late-MAC refusal and normal within-lease publication reached. The cache-only wrapper neither adds nor overwrites database variables. Attachment-stage acceptance also completes; `pnpm validate:all` passes. This local result does not replace repaired-head Node 18/20 CI. |
| Late finalizer zero effects | Genuine custody MAC verifies outside the first committed transaction, then pauses. The test observes a live DB lease, waits for actual expiry without updating it, explicitly abandons and claims a newer cleanup fence, then releases the callback. Finalization refuses: uploaded 11 / verified 0 / coverage 0 / pins 0; exact generation, object, staging, binding, nonce, prepared and key rows remain unchanged after takeover. This attachment-free case does not claim a positive retained-pin fixture; D2b cases in the same checkpoint run cover pin=1. |
| Types, validation and collection | PASS: backend/explicit touched fixture typing, acceptance config and `pnpm validate:all`; 49 wiring contracts at `f120`. Late-MAC child additionally passes 38 unit, 6 checkpoint wiring contracts and explicit acceptance list-files containing the sibling helper. Existing required D2b whole-file selection collects the crash cases. |
| Mutations | Exact expiry, owner fence, terminal receipt admission and both census holder regions went RED and were restored at `f120`. An earlier nested census layout produced a retained GREEN mutation; the small existing-style admission layout corrected that blind spot without changing the scanner or exemptions. Ordinary checkpoint's existing seal-guard mutation also ran/restored. No additional late-MAC runtime mutation is claimed. |
| Owned resource teardown | All retained runs stop only their owned PostgreSQL clusters. Final late-MAC run reports DB/backends 0/0, seven recorded child PIDs gone, three recorded SIGKILL exits, listener gone and owned roots removed. Independent `606f` teardown separately confirms zero clients, children, listener and roots. |
| Standard archive producer repair | PASS local at `eb66`: Node 20.20.2 / fixed pnpm 10.33.0 / PG 15.17, parsed exact step roster executed once, fourteen files / 312 PASS / zero skipped, D2b 25 and all three real crash markers. Fifty wiring/neighbor tests and `pnpm validate:all` pass; neutering only the alias equality makes its negative RED, restored byte-identically. Source/log/lifecycle review CLEAR. Retained setup failures and dependency-graph qualification below remain applicable. |
| Published exact-head backend CI | FAILED at `97a` in both Node versions at checkpoint 87; FAILED again at `3fda` on Node 20 archive 101: fourteen files / 309 PASS / 3 FAIL / zero skipped. At `3fda`, checkpoint 87 actually passes nine files / 239 tests; Node 18 completes successfully and intentionally skips archive 101. The standard workflow omitted the test URL although the checkpoint producer was repaired. New workflow-repair publication dispatch remains PENDING. Main-required PR/merge-window CI remains separate. |

The 239-test checkpoint replay and the 62-test focused replay overlap and are not
added together as a unique-test total. Initial loader/fixture/typing failures and
the earlier mutation GREEN remain retained alongside corrected successful runs.

## Exact APFS recovery composition

Owned local APFS acceptance ran at composite
`a1d1ebbbce5ea3d26ee734ccd196b80318d55d03`: runtime `f120` plus exactly the
six acceptance-helper paths from PR #6183 `7c6c79aae7c67c19ecbc22ca065348c6f3330d05`
(five exact blobs and the acceptance-tsconfig includes union with current main).
The real manual generation was backed up, its source made unavailable, and an
initially empty independent target restored it through the official FD3 launcher.
Exact scalar, attachment bytes and history recovery passed; two fresh flag-OFF
processes proved HTTP parity and no writes across 22 archive tables. The separate
seeded 5001-row control completed two chunks and 5001 derived effects. It is not
the manual capture's row count. Driver and runner exited zero; scoped DBs,
backends, child processes and roots were zero.

Complete log SHA256:
`3ff4a6ec9c8222605ee86ed39a2d746a6ec6c3c6f4f48034c568eed6d04782b8`.
The independent review checked the source/helper/hash composition. Later test-only
children preserve all production bytes, but this APFS run remains bound to its
actual composite SHA; it is not relabeled as an executed `4788277`/publication run.
It proves that recovery composition, not the checkpoint environment producer;
the later producer failure does not replace or widen the earlier APFS evidence.

## Failed dispatch and producer repair

Dispatch `36803970693`, attempt 1, tested `97a9245e8cf78a8d24d8ed6451c23c3b416272c0`.
Node 20 job `110184172653` and Node 18 job `110184172484` both failed the builder,
cleaner and late-builder child cases with `CRASH_CHILD_EARLY_EXIT`. The producer
omitted `TEST_DATABASE_URL`; the child requires it to equal `DATABASE_URL` before
waiting for IPC or creating a Pool. An independent no-database negative/positive
probe confirmed that guard behavior. This is an environment-producer mismatch,
not evidence of a timing or Node-version failure. The one-line `f6cc402` repair
was independently reviewed with the guard and all runtime/timing bytes unchanged.

Both complete failed logs are retained: Node 20 SHA256
`486ee8f17527e6dae690e9f67f8c6555534cce456da4047a751ea9b56b9064b8`
(7,180,209 bytes), Node 18 SHA256
`b97995bd530a47309f18bc87932167b82985845d08ce7fbf1cc98f6fc1b3aeba`
(7,045,775 bytes). No successful archive census is attributed to that dispatch.

The repaired official runner exits 0 at `f6cc402`; its complete retained log is
13,891 bytes, SHA256
`6f2c4d038879b6f29b0580d285d02bdd9f5dd3dea64897ee58efec7532ae9033`.
DB connections, owned PostgreSQL cluster and scoped processes are zero. The
outer evidence driver then exits 1 because its residue assertion also sees two
exclusively owned Node/tsx cache directories. That postprocessing failure is
retained separately; a scoped teardown supplement removes only those caches and
the wrapper after rechecking zero processes and all runner/census hashes. The
owned temporary root is now removed. No extra test replay or success relabeling
is used to conceal that driver failure.

## Standard archive lane failure and repair

The next dispatch `36806817395`, attempt 1, tested report child
`3fda6713e2b81da79419da89ad590fc4d2ce26bf`. Complete Node 20 job
`110192896846` log (7,801,876 bytes / thirty validated ranges) SHA256:
`84930dfe40a1731a8e54e322425083a663c3aeaf90d821d7b3561a434fe80797`.
Strict step windows establish checkpoint 87 nine files / 239 PASS / zero skipped,
genuine late-MAC and all crash/teardown markers; archive 101 fourteen files /
309 PASS / three FAIL / zero skipped. All failures are the builder, cleaner and
late-builder `CRASH_CHILD_EARLY_EXIT`. Node 18 job `110192896857` is SUCCESS;
its archive step is intentionally skipped by the existing Node 20 condition.

The real standard-step environment has the database URL and fail-not-skip marker
but no test URL. The helper forwards that omission and the child equality guard
rejects before IPC/Pool. The internal `HARNESS_REQUIRED` is not printed by the
silent catch; source plus actual environment supports this attribution. The
`eb66` change fixes that producer and retains strict rejection, rather than
adding an alias fallback. No timing/lease/default change is made.

The independently audited local fourteen-file run actually passes 312 tests,
D2b 25, zero skipped; complete log SHA256:
`903c9eabb611a7bcb782f9d71eede983dc01e68e9d0eec9ef5490de8f3978375`.
Migrate/drop/stop exit 0; clients, database, seven child PIDs, postmaster, listener,
and owned PG/temporary/cache roots are zero. This run executes only the archive
roster, not the official checkpoint or the other standard-step multitable files.
The fifty-test wiring/neighbor log SHA256 is
`59a7d394380fe04b3716f44884b2eebf5fc7340606a9f845db35e0bf897eb1ee`;
the alias-guard RED mutation is retained and restored exactly.

Two setup attempts preceded the sole actual archive roster run. A Node 20 PATH
selected a Corepack pnpm shim and implicitly relinked only this owned worktree's
dependencies. Its own lock/workspace edits were preserved then restored to frozen
source bytes; the prior node_modules graph was not reconstructed. A second probe
incorrectly required transitive esbuild as a direct dependency and stopped before
PG creation. The successful attempt fixes the CLI entry and resolves esbuild from
tsx; it performs no dependency install. These local results do not prove a
frozen-lock install, GitHub CI or current-main integration. The new exact-head CI
must install from the unchanged committed lockfile and validate separately.

Evidence: `artifacts/timemachine-expired-builder-ci-3fda671/backend-complete/`,
`artifacts/tm-archive-ci-alias-repair-20261001/`, and
`artifacts/tm-archive-ci-alias-repair-eb66e3f/attempt3-fixed-probe/`; the earlier
setup attempts and implicit-install/restoration diff remain retained alongside.

## Reproduction and retained evidence

Focused commands (for realDB, set the task-specific variables below only to a
newly owned synthetic PostgreSQL database and owned short temporary root):

```bash
TSX_DISABLE_CACHE=1 NODE_ENV=test pnpm --filter @metasheet/core-backend exec vitest run \
  --config vitest.config.ts --no-cache \
  tests/unit/multitable-recovery-archive-expired-builder.test.ts \
  tests/unit/multitable-field-schema-fence-recheck.guard.test.ts \
  tests/unit/multitable-field-schema-fence-recheck.test.ts \
  tests/unit/multitable-recovery-archive-abandoned-object-store.test.ts \
  tests/unit/multitable-recovery-archive-object-receipt-compiler.test.ts

DATABASE_URL="${TM_REVIEW_DB_URL:?owned synthetic URL required}" \
  TEST_DATABASE_URL="$TM_REVIEW_DB_URL" \
  TMPDIR="${TM_REVIEW_TMP_ROOT:?owned short root required}" \
  NODE_ENV=test EXPECT_DB=1 METASHEET_REAL_DB_TEST_STEP=1 TSX_DISABLE_CACHE=1 \
  pnpm --filter @metasheet/core-backend exec vitest run \
  --config vitest.integration.config.ts --no-cache \
  tests/integration/multitable-recovery-archive-stale-pin-cleanup-realdb.test.ts \
  tests/integration/multitable-recovery-archive-source-pin-authority-realdb.test.ts \
  tests/integration/multitable-recovery-archive-claim-anchor-realdb.test.ts

TM_TEST_PG_BIN="$(pg_config --bindir)" node scripts/ops/run-recovery-manual-checkpoint.mjs
pnpm validate:all
```

The owned runners record the cache-disabled environment, actual commands, source
and log SHA256s, PG lifecycle and zero-residue census. Local ignored evidence:
`artifacts/tm-expired-builder/evidence-f120.json`,
`artifacts/tm-expired-builder-strengthened/evidence-606f.json`,
`artifacts/tm-expired-builder-independent-606f/evidence.json`,
`artifacts/tm-late-mac-finalizer/evidence-4788277.json` in the acceptance checkout,
and `artifacts/timemachine-expired-builder-apfs-20261001/` in that same checkout.
Producer-failure attribution and the new cache-only runner are retained under
`artifacts/tm-checkpoint-producer-f6cc402/`; the two complete failed CI jobs are
under `artifacts/timemachine-expired-builder-ci-97a9245/`. Historical evidence is
preserved rather than relabeled as the repaired source.

## Remaining limits

The crash fixture prepares synthetic sealed data before reserving its ten nonces;
it proves preservation, not reserve-before-encrypt ordering or full capture. The
late PUT case delays the callback after physical PUT; it does not prove late
physical publication or cancellation. Process SIGKILL is not machine/power-loss,
NAS/remount durability or physical erasure. Lease/fence checks prevent late DB
effects; they do not bound arbitrary provider/KMS call latency.

Verified/expired/pinned/legacy object deletion, the full claim/capture/crypto/
upload/finalize fault matrix, live Phase 5 missing-sample attribution, independent
provider/staging KMS, actual staging window/rollback and production acceptance
remain OPEN. No key-reference release/destruction, retention default, live flag,
deployment, real/customer data or remote provider/KMS action is authorized by this
report. The overall completion goal remains ACTIVE.
