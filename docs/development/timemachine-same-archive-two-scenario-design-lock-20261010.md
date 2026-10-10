# Time Machine same-archive two-scenario local acceptance

Owner approved on 2026-10-10: “同意两段验收，继续本地修复”. This
ratifies the local proposal in `artifacts/tm-unblock-owner-decision-20261010/decision.md`
over source `0a111bbd81c137a9eda0ed55264340f7ddf4b065`. It changes how the
two fault properties are demonstrated; it does not authorize native retries
while the historical platform review is unresolved, publication, deployment,
flags, customer data, or a claim that TM is complete.

Both scenarios must execute in the same current-source run, using the same
quiesced SQL dump, immutable archive objects, custody backup and genuine
captured generation. Each target starts as a distinct empty owned database and
distinct private filesystem roots. Source database/roots are unavailable before
either restore. Retain the separate seeded control; it cannot qualify this pair.

## A: process death

Retain the official target launcher, real process death after the first 5000-row
chunk commits, natural database-clock lease expiry, fresh official process
takeover, higher worker fence and unchanged block fence. The old SQL tuple
diagnostic remains explicitly tuple-only; it is not a genuine worker claim.

## B: genuine stale claim

Use a second target imported from the same pre-restore backup. Accept the job
and synchronous attachment restore through the official HTTP service. Stop that
service normally before admitting the two controlled workers; refuse any job
already claimed by its background worker. Keep both archive/writer flags exact
`true` in this synthetic process. A longer test-only scheduler interval bounds
the HTTP setup window without disabling workers.

Prepare custody/provider and canonical authorization/computation through the
production local startup composition. Worker A genuinely claims the accepted
job and executes its first real 5000-row chunk. Hold its original frozen claim
in memory without renewal, outside every transaction. Wait for natural expiry
using SQL time. Worker B genuinely claims the same job, preserving the block
fence and increasing the worker fence. These are distinct logical workers;
their original objects remain inside the same test child, never IPC payloads.

A then calls the real binding reader and `executeRecoveryArchiveAsyncRestoreChunk`
with its exact original object. Both must reject with
`RECOVERY_ARCHIVE_RESTORE_JOB_LEASE_LOST`, not `INVALID_INPUT`. Complete public
table digests and the nontransactional record-chain sequence must be unchanged
by each refusal. B stays paused outside transactions until those checks finish,
then executes the remaining chunk and finalizes through production APIs.

Never serialize, clone, reconstruct or inject a claim; never edit clocks,
lease/ownership rows, callbacks or production claim policy to pass this test.

## Common gates

Each scenario independently requires chunks 5000+1, 5001 scalar restores exactly
once, the preserved first chunk, two-member aggregate, drained derived effects,
attachment bytes, retained custody/nonce identity, fresh before/after OFF HTTP
and SQL parity, no listener residue, and identity-bound non-FORCE database cleanup.
The driver must include all three owned databases in cleanup and residue census.
Missing, mismatched, duplicate-scenario or tuple-only receipts keep the CLI HOLD
and its exit nonzero. Historical receipts cannot be combined into a new PASS.

| Gate | State |
| --- | --- |
| Owner approval of local two-scenario contract | APPROVED 2026-10-10 |
| Local implementation / focused mocked tests / acceptance typecheck | LOCAL PASS; see verification report |
| Genuine current-source APFS execution of both scenarios | HOLD: historical platform review unresolved |
| Required exact-source remote CI | OPEN; publication separately gated |
| Independent staging provider/test key, owner target/window, staging and rollback | OPEN |

Local mocked tests prove orchestration and fail-closed judgement only. Full
native and staging gates remain independent of this local contract approval.
