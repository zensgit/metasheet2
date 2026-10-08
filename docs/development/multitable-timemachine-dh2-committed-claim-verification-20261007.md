# Time Machine D-H2 committed claim verification

Baseline: `c1e4250e6f1043239b563a342ffa2187061532a3`, prerequisite Draft #6223,
main `8e2e40d1252bdb7104bd0d54b12a397f90ef1f9a` (fetched again after tests).
Contract: `multitable-timemachine-dh2-committed-claim-design-lock-20261007.md`.
This is the private committed-claim increment only; complete D-H2/D-L/D7 and staging remain OPEN.

## Implementation

One owned native connection starts READ COMMITTED and runs the source-free canonical fence
before business reads. Actor/request locking precedes the active key lock, matching manual
admission. Exact scope authorization, current heads, expired-owner CAS, a building generation,
ten future reservations, complete attachment pin intents and the durable request binding commit
together. Only a confirmed COMMIT within the deadline issues the private WeakMap capability.
A replay returns its generation ID without minting authority. Actual block and generation fences
remain distinct. One post-fence PostgreSQL timestamp supplies creation/lease bindings.

Attachment pin metadata uses one-row keyset queries and cumulative UTF-8 limits; SQL withholds
both payload and entity key before transfer when the row exceeds the remaining budget. Session
and per-statement server timeouts share the owned deadline. Timeout destroys the client, late or
retained queries refuse, and a healthy success restores the prior session timeout. Lost COMMIT
acknowledgement never issues capability or retries, and never claims that a real COMMIT rolled back.

There is no HTTP caller, migration, flag, grant, provider/KMS operation, immutable blob verification,
nonce/seal, publication or prune. Legacy reservation/consumption/admission and global writer refusal
are unchanged. The field-retype source census adds only this actually derived non-writer holder;
it does not prove all source writers/deleters honor the archive block.

## Local execution

All commands ran in the isolated `codex/tm-owned-claim-20261007` worktree. Real DB execution used
an owned PostgreSQL 15.17 cluster and fresh synthetic scratch databases with all 26 fixture migrations.
No foreign key, ACL or guard bypass was used. Evidence is retained in
`artifacts/tm-owned-claim-20261007/` with raw logs, process exits and frozen inputs.

| Check | Command / execution | Result |
| --- | --- | --- |
| Units and focused neighbors | `pnpm --filter @metasheet/core-backend exec vitest run --watch=false tests/unit/multitable-recovery-archive-owned-claim.test.ts tests/unit/multitable-recovery-archive-writer-block.test.ts tests/unit/multitable-field-schema-fence-recheck.test.ts tests/unit/multitable-field-schema-fence-recheck.guard.test.ts` | 4 whole files, 206 PASS, 0 skip |
| Owned real DB | `METASHEET_REAL_DB_TEST_STEP=1 NODE_ENV=test pnpm --filter @metasheet/core-backend exec vitest run --watch=false --config vitest.integration.config.ts tests/integration/multitable-recovery-archive-owned-claim-realdb.test.ts` with a private synthetic DB profile | 1 whole file, 30 PASS, 0 skip |
| CI registration / fail-not-skip | `node --test scripts/ops/multitable-d2-archive-ci-wiring.test.mjs scripts/ops/multitable-d2-archive-fail-not-skip.test.mjs` | 11 PASS, 0 skip; 16 armed missing-DB child specs refuse |
| Provenance / neighbor | `node --test plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs plugins/plugin-integration-core/__tests__/sealed-export-s5-product-to-s3-s4-integration.test.cjs` | 2 PASS, 0 skip; only workflow evidence pin changed |
| Configured repository validation | `pnpm validate:all` | exit 0; existing manifest warnings retained |
| Patch whitespace | `git diff --check` | exit 0 |

The 30 DB cases include actual pre-COMMIT invisibility and complete post-COMMIT visibility,
fence-wait fresh-head observation with a stale RR control, deferred COMMIT failure, lost reply after
real COMMIT, exact authorization/key/request/ownership failures, higher-fence expired CAS,
bootstrap and checkpoint reservations, complete pin intents and purge refusal, SQL withholding,
cumulative limits, real blocked-backend deadline exit, finite pool acquisition, restored session
timeout, retained-query refusal, and a real deadline crossed while freezing a committed candidate.

## Refutation and independent review

Each of six temporary source mutations ran the complete 30-case file. The named matching test
failed with a raw AssertionError and explicit process exit 1: RR before fence (also remove the
RR prelude refusal), key before request, retained query after release, mint after freeze deadline,
payload transfer without withholding, and entity-key transfer without withholding. Saved original
bytes were restored without Git checkout. The final restored whole file returned 30 PASS / 0 skip.
Mutation runs are negative evidence and are not added to the positive PASS count.

The independent source reviewer closed request/key ordering, retained-query lifetime and
post-freeze deadline findings against the restored bytes. The root separately parsed actual
reporter/process JSONs, named raw failures, source hashes and cleanup manifest. Review applies
only to this narrow increment and does not claim full D-H2 acceptance.

Retained first-run evidence includes 20 PASS / 2 FAIL (unsupported clean-expiry CAS and a backend
still waiting after socket destruction), fixed by explicit actual expired tuples and server timeouts.
The first unit run named a nonexistent neighbor; only its three actual files ran, with six census
failures until the real non-writer holder was registered. The corrected four-file command is above.
The first mutation reader expected the AssertionError class in Vitest JSON failureMessages;
the named raw FAIL block contained it. Initial logs remain, and the corrected reader checks both
named raw assertion and reporter case status plus numeric process exit. No failure was relabeled green.

## Bound evidence

| Receipt | SHA-256 |
| --- | --- |
| New claim source | `d8e59e8b14a1a4d113f98ee664e640b77fa4fde1876219ee4cb0e3741cc14a66` |
| Unchanged writer-block source | `1ceee696cfedc5c1745a8929fd0d509f28c4bfbae4647823804c19a05baf8dda` |
| `source-mutation-receipt-20261007.json` | `e98f93363ea276cbc94a5faa4212af59cdc27e8e1d72789bbb766a603d0bef92` |
| `root-execution-readback-20261007.json` | `cf0fc54e0ce7bec2bcdc2bf89f65298f9cc8c78c8863720741f27ed6668694ea` |
| `native-pg/final-manifest.json` | `d1b31ff55582ba848f39e15dcff4c122e3a8886444553d81dc7e819c65bae7db` |

Actual scratch databases and connections were zero before official exact-cluster stop (exit 0).
PID, listener and postmaster PID file are absent; private profile removed; initialized stopped data
and all logs retained. Shared databases and retained local key stores were untouched.

## Remaining gates

The new whole DB file is registered in the Node 20 archive lane, excluded from broad unit discovery,
and covered by omission and armed-missing-DB negatives. Exact published-source CI execution remains
OPEN until its actual terminal run and checkout are collected. Node 18 archive conditional skips
cannot serve as DB execution evidence.

Fresh RR must next validate the exact committed owner/block/key/request/reservation/pin/head tuples
in the same transaction before reading all metadata. Out-of-transaction bytes/crypto, permanent nonce
reservation, predicted coverage, owned finalize and ownership-safe abandonment remain OPEN.
The owned-only future timestamp/ID contract persists prerequisites here; it is not finalize proof.
D1 owner ratification, independent durability/key lifecycle, merge, flags, deployment and staging
acceptance remain OPEN. This evidence does not qualify historical APFS execution for this new source.
