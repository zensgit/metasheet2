# Time Machine D-H2 fresh RR metadata capture

Status: bounded development, internal only, default-OFF. Parent authority is D-H2/D-I0 in
`multitable-timemachine-phase-d1-durable-archive-design-lock-20260826.md`.
Baseline: `4f41dd21fcfe0823e367d5eb0db188c0e40ab2b2`, prerequisite Draft #6226.

## Required result

`bindRecoveryArchiveOwnedCapture(pool, authorize, limits)` accepts only a genuinely minted private
committed claim. It atomically consumes the claim before its first await; concurrent attempts and
all retries after failure refuse. Scope, key, generation, actual block/build fences, future identities
and expected pin/head sets come only from the private claim binding. A DTO/readback cannot mint
claim or capture authority. No runtime caller or durable restart reconstruction is added.

Only after claim COMMIT does one owned native connection begin fresh REPEATABLE READ READ ONLY.
The acquired private connection first executes source-free ROLLBACK before reading/restoring session
timeout settings and beginning RR. Repeated BEGIN alone can retain an existing pool-client snapshot;
a genuine pre-claim RR client must be reset, and removing the reset must make its golden test red.
Within this same RR snapshot, source-free transaction checks verify stable xid/isolation/read-only
and absence of any advisory lock. SQL-only authorization and exact live scope/key/block/generation,
request, checkpoint, bootstrap branch, reservation and pin/head tuples must match before the bounded
reader enumerates all seven relational sections and attachment metadata. No SELECT row locks or
advisory fence, mutation, provider/network/KMS call or byte read occurs in RR.

The ten reservation tuples and full pin sets are compared in SQL with fixed boolean/count output;
no unbounded authority aggregate is transferred. Raw PostgreSQL timestamps are compared at full
precision; canonical millisecond timestamps cannot substitute for exact identity. Complete source
pin IDs, claim IDs and live attachment IDs must agree. Intent pins are source/building/mutable,
owned with the actual build tuple and exact unexpired lease, and have null verification metadata.
Both observed heads and future reservation identities stay separately bound.

All source payloads share one cumulative UTF-8 metadata byte limit. The existing bounded keyset
reader withholds oversized payload and entity key before transfer. Only local content-addressed
`UUID/sha256-<digest>` locators are admitted as attachment descriptors, with SQL size and expected
hash/version; descriptors do not claim verified bytes or turn intent pins into available pins.

Acquisition, authority checks, reads, COMMIT, timeout restoration, healthy release and final freeze
share the absolute deadline, with explicit finite native acquisition and remaining server timeout.
Late queries or retained authorizer SQL cannot use a released connection. Failure discards the
connection. Only confirmed RR COMMIT, release and final deadline check can mint a private detached
captured token. There is no provider/crypto/finalize authority in that token.

A same-RR recheck cannot see later commits by another transaction. Final in-RR checks establish
snapshot consistency and current clock lease validity only; subsequent RC object/nonce/finalize
owner rechecks remain mandatory. Runtime remains unconnected until the all-source writer/deleter
census and full D-H2 composition are proved.

## Gates

| Gate | Required evidence | State |
| --- | --- | --- |
| Single-use authority | Private minted token only, concurrent duplicate and failure reuse refuse | LOCAL PASS |
| Fresh snapshot | Claim-before-RR commit order and writer-wait fresh-head golden; same xid across every section | LOCAL PASS |
| Exact binding | Active key/scope/request/checkpoint/block/build/heads/ten reservations/full pin sets and raw timestamps | LOCAL PASS |
| Metadata boundary | Complete seven sections, local immutable descriptors, zero provider calls, cumulative cap and withholding | LOCAL PASS |
| Native lifetime | Explicit finite pool acquisition, server deadline, no late SQL/token before confirmed COMMIT/release | LOCAL PASS |
| Regression/CI | Existing claim/capture neighbors, whole real DB registration and fail-not-skip | LOCAL PASS |
| Exact published-source CI execution | Terminal whole-file execution and actual checkout qualification after Draft publication | OPEN |
| Full D-H2 / D-L / D7 | Out-of-TX bytes/crypto, nonces, predicted coverage, owner-aware finalize/abandonment, lifecycle | OPEN |

No migration, flag, grant, legacy guard relaxation, provider/KMS/key-retirement operation, seal,
publication, prune, merge, deployment or staging occurs. Retained local key stores remain preserved.
