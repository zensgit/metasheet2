# Time Machine D-H2 owned fresh RR verification

Baseline `4f41dd21fcfe0823e367d5eb0db188c0e40ab2b2`, prerequisite Draft #6226;
main `8e2e40d1252bdb7104bd0d54b12a397f90ef1f9a` fetched before the slice and again after tests.
Contract: `multitable-timemachine-dh2-owned-rr-design-lock-20261007.md`.
This is an internal metadata handoff only; complete D-H2/D-L/D7 and staging remain OPEN.

## Result

A genuine committed claim is synchronously consumed before the first await. Concurrent attempts,
DTOs, clones, replay and every failed-attempt retry cannot acquire capture authority. The owned
native connection first ends any old transaction with source-free ROLLBACK, then installs its
session timeout and begins fresh REPEATABLE READ READ ONLY. Repeated BEGIN alone demonstrably
retains an old snapshot, so the explicit reset is required even with a genuinely minted claim.

Inside that same RR, fixed boolean/xid SQL checks exact live scope/auth/key, actual block fence,
separate build fence, generation/checkpoint/request, observed heads, ten future reservations and
complete expected/pin/attachment sets. Timestamp equality is full PostgreSQL precision. Pin intents
stay mutable with null verification fields. The bounded reader then enumerates all seven relational
sections and attachment metadata with cumulative UTF-8 payload limits and SQL withholding.
Local content-addressed descriptors bind version/hash/size but do not prove attachment bytes.

Acquisition, server queries, COMMIT, timeout restoration, release and final freeze share one deadline.
Only confirmed RR COMMIT plus release and the final deadline check mint the private detached token.
Retained authorizer queries and late continuations cannot use the released connection.
There are no row/advisory locks, DB mutations, provider/KMS/byte calls, HTTP callers or nonce/seal.

Same-RR rechecks only observe that snapshot and the current lease clock. A real external SQL commit
between sections remains invisible; a fresh independent read sees it. Downstream current RC owner,
permission/key/lease checks remain mandatory. Writer/deleter closure is not inferred from RR consistency.

## Actual local verification

All execution used `codex/tm-owned-rr-20261007` in its isolated owned worktree. Native PostgreSQL 15
used fresh synthetic scratch databases and 28 actual migration ups per capture case: the unchanged
26-migration claim fixture plus existing view-config and auto-number migrations. No guard/FK/ACL bypass.
Logs, actual reporter statuses, process exits, commands and frozen inputs are retained under
`artifacts/tm-owned-rr-20261007/`.

| Execution | Command / complete files | Result |
| --- | --- | --- |
| New units plus four source neighbors | `pnpm --filter @metasheet/core-backend exec vitest run --config vitest.config.ts tests/unit/multitable-recovery-archive-owned-capture.test.ts tests/unit/multitable-recovery-archive-owned-claim.test.ts tests/unit/multitable-recovery-archive-bounded-source.test.ts tests/unit/multitable-recovery-archive-capture-executor.test.ts tests/unit/multitable-recovery-archive-relational-source.test.ts` | 5 files, 150 PASS (new capture 46), 0 skip |
| Writer and field-fence neighbors | `pnpm --filter @metasheet/core-backend exec vitest run --watch=false tests/unit/multitable-recovery-archive-writer-block.test.ts tests/unit/multitable-field-schema-fence-recheck.test.ts tests/unit/multitable-field-schema-fence-recheck.guard.test.ts` | 3 files, 179 PASS, 0 skip |
| New owned capture real DB | `METASHEET_REAL_DB_TEST_STEP=1 pnpm --filter @metasheet/core-backend exec vitest run --config vitest.integration.config.ts tests/integration/multitable-recovery-archive-owned-capture-realdb.test.ts` with private synthetic profile | 36 PASS, 0 skip |
| Original owned claim DB neighbor | Same armed command with `multitable-recovery-archive-owned-claim-realdb.test.ts` | 30 PASS, 0 skip |
| Two-point roster / fail-not-skip | `node --test scripts/ops/multitable-d2-archive-ci-wiring.test.mjs scripts/ops/multitable-d2-archive-fail-not-skip.test.mjs` | 13 PASS, 0 skip; 17 armed missing-DB children refuse |
| Provenance and S5 | `node --test plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs plugins/plugin-integration-core/__tests__/sealed-export-s5-product-to-s3-s4-integration.test.cjs` | 2 PASS, 0 skip; only workflow evidence pin updated |
| Configured repository validation | `pnpm validate:all` | actual exit 0; existing manifest warnings remain |
| Whitespace | `git diff --check` | exit 0 |

The two unit commands cover eight distinct whole files, 329 cases. DB results are separate whole files.
Armed missing-DB refusal is negative harness evidence, not a passing DB suite. Vitest 1 JSON summary
incorrectly counts skipped assertions as passed for that command; actual per-assertion statuses show
one sentinel failure plus skipped DB cases and are retained, without calling them PASS.

## Refutation and review

Eleven temporary source mutations each ran the complete 36-case DB file with a matching named raw
AssertionError RED and explicit exit 1: omit initial reset; reuse consumed claim; omit generation raw
timestamp equality; omit reservation raw timestamp equality; omit observed heads; omit full pin sets;
permit retained SQL after release; mint after freeze deadline; transfer oversized payload; transfer
oversized entity key; replace RR by RC while also neutering the isolation guards. The last mutation
actually sees the other transaction's later data, rather than merely failing an isolation prelude.

Two genuine claim cases alter real generation/reservation INSERT timestamps by one microsecond,
with all immutable guards enabled. Full timestamps differ while UTC millisecond display is identical;
capture refuses before source transfer and permanently consumes the token. They refute millisecond-only
binding without mutating immutable rows or forging a private capability.

All three saved source files were restored byte-for-byte without Git checkout. Final restored complete
DB execution is 36 PASS / 0 skip. Mutation runs are not added to the positive case count. Independent
static source audit found no remaining narrow implementation blocker. It flagged a duplicate closing
line in the then-in-progress spec; that was removed before valid DB collection. Root independently
checked actual reporter/process statuses, raw named failures, restored bytes and cleanup receipts.

Retained initial errors are test/evidence-controller issues: nonexistent unit config; in-progress spec
closing line; no-DB controller argument index; missing historical Express ambient declarations during
targeted tsc; root mutation needle using pre-format whitespace; cleanup executable symlink spelling
before stop. Each was corrected without dropping a guard/negative or relabeling a failure green.
Targeted tsc with actual ambient/auth entrypoints and configured validation both exit 0.

| Receipt | SHA-256 |
| --- | --- |
| Owned capture source | `3614294b5f989cf3fe47453fea179678342952f215fd5dc23b59656cdc5b3bae` |
| Claim source (only synchronous take/WeakSet added) | `9c4a5b203632ac2f4f5f5200205c597e02ca8276a7277f97477096c9ddcb3b0f` |
| Unchanged bounded reader | `1a1993ab98f17edec8ddce3d3c184f317ab253f7f8e6fac7d5d51a32291aa1e0` |
| `source-mutation-receipt-20261007.json` | `b2fe9694a4c7f45669a91683a4dbcb42cad1389f5f6e5dfd02b2f15ea73c98a1` |
| `root-final-mutation-quality-readback-20261007.json` | `5bda0e261d08f93a328459a61480912b227e54009e68722c4012938738466df3` |
| `native-pg/final-manifest.json` | `c3b29d45b8e52575d286d204a29fc912f752fd8c3d9593770a2a10f7941ccb93` |

Before official stop, scratch databases and other client connections were actually zero. Exact PG15
postmaster/listener identity was checked; pg_ctl fast stop exit 0, PID/listener/PID file absent and
TCP refused. Private profile removed; initialized stopped data and all evidence retained. Shared DBs
and retained local key stores were untouched.

## Remaining gates

The complete new DB file enters the Node 20 archive union and no-DB exclusion, with both omission
negatives and an armed sentinel. Exact published-source CI execution remains OPEN until collected.
Legacy capture/admission/consume/seal/writer refusal and original fixture remain byte-identical.

Out-of-TX byte verification/crypto, permanent nonce reservation, future coverage, owner-aware finalize
and abandonment remain OPEN. A frozen source inventory identifies attachment insertion, cross-sheet
link reset and enabled untagged tombstone retention as three concrete writer-closure gaps; the inventory
is not runtime/race proof. Full D-H2/D-L/D7, D1 ratification, merge, flags, provider/key lifecycle,
deployment and owner staging stay OPEN. Historical APFS execution does not qualify this new source.
