# Time Machine owned builder expiry and staged-object cleanup

Status: authorized residual implementation of D1 D-B / D-H2, D2b and D7; default OFF; independent implementation and native fault review pending. This closes a missing owned lifecycle entry, not overall Time Machine acceptance. Frozen integration baseline: `68df3e752960ea21c0ccbf95882e576a7a599f04`, based on current main `7137688372c07a32fc992d8d73deca3a92a9ed3c`.

## Problem and bounded decision

The genuine owned capture path commits a builder and source pins, then prepares and uploads outside transactions. Its in-process catch cannot run after abrupt process termination. The older expiry / abandoned-object primitives exist, but reject an expired owned sheet block, have no composed application caller, and receive no staging inventory from the owned composer. Early termination before prepared publication also leaves source pins without cleanup inventory.

Reuse the existing D2b staging rows, immutable abandoned bindings, higher cleanup fence, exact provider discard/status and source-pin release protocol. Do not add a queue, timer, HTTP route, new flag, upload continuation, lease revival, provider selection or key destruction. The one versioned correction below amends the existing deferred anchor function; it adds no table, column or marker. Implement an explicit internal operator command on the composed application and `MetaSheetServer`, following the existing attachment-stage cleanup lifecycle. It accepts only scoped actor identity and generation UUID; owner/fence, lease, block and object evidence come from fresh database reads.

Do not invoke cleanup as a preflight to capture. A preflight releases its request lock before provider IO, so a concurrent identical request could become a replay after the preflight has already caused cleanup. Existing capture duplicates remain status-only. This explicit command is separately invoked in the controlled fault run through the actual composed server; a standalone helper invoked only by tests is insufficient delivery.

## Durable admission before provider IO

1. In the genuine owned claim transaction, each source-pin intent receives one matching `pending` attachment staging row with the same generation, attachment and key. Commit these together. These rows are unsealed intents and do not assert that an archive object exists or that provider absence was observed.
2. Before the first archive PUT, one genuine owned recheck transaction persists the immutable prepared envelope and registers its complete ciphertext plan: all sections, attachments and manifest, including objects never yet PUT. Use the original validated provider `storeId` and exact expected binding / operation UUID. For an attachment, reuse its one exact pending, unbound staging intent; refuse duplicates, wrong key/class/attachment or already terminal rows. Other classes use existing registration. The entire inventory is sealed in this same commit, before any PUT. Legacy registration without early intents remains compatible.
3. Preserve the actual provider namespace through the owned wrapper. Cleanup uses the original composed provider's discard/status capability, never HEAD-null, another root or an inferred namespace. Unknown original provenance refuses cleanup. All provider/custody IO remains outside transactions and advisory locks.
4. A successful verified generation retains its staging provenance and is ineligible for abandoned cleanup. Nonce tombstones and key-reference inventory remain durable in every outcome.

## Expired owner admission and fencing

The command uses the native bounded READ COMMITTED transaction runner. Each transaction starts with the source-free canonical sheet fence, then takes the existing key row (`active` or `retiring`, no new key reference), sheet row and generation row in that order. Recheck canonical live scope, current actor full-read plus sheet-management authority, immutable manual request scope, generation source vector / key and safe building/incomplete posture. Reject active legal holds, verified object receipts and archive-object references.

For an active expired builder, require actual PostgreSQL lease expiry and the exact builder owner tuple. An `archiving` sheet block is admissible only if its owner is this generation, its raw lease equals the expired generation lease, and its full owner/fence/raw lease/raw updated-at tuple is read under the same locks. Clear that exact tuple by CAS in the same transaction as active → abandoned, preserving the old generation owner/fence/lease. A null block is permitted after the existing catch has released it. Any other block, including a successor's expired block, refuses the whole operation without changing it. Never broadly bypass `assertNoActiveWriterBlock` or use JavaScript millisecond timestamps for the block CAS.

For an already abandoned generation, require expired builder or cleanup lease and a null writer block. Claim the existing higher `archive_cleanup` fence with an opaque new owner and a server-clock-derived bounded lease. Cleanup restart reuses persisted object operation UUIDs; a live cleanup owner is refused rather than stolen or extended. Live leases, terminal verified generations, scope mismatch, authority loss and malformed rows cause values-free refusal, retaining references. The command must not expose a caller-supplied owner DTO or permissive authorization callback at the server entry.

## Prepared and early termination paths

Prepared path: independently validate the immutable envelope digest and full scope/key/source-vector binding, complete ciphertext roster and exact bijection with persisted namespace/bindings. Use the existing higher-owner rechecks before every provider attempt and terminal write. Lost responses reconcile through exact operation status; unknown or retained outcomes keep source pins. Only complete official-provider unavailability for the full inventory admits existing source-pin release. This is not physical erasure, remote attestation or permission to destroy a key; anonymous LOCAL pending ciphertext residue remains a stated provider limit.

Early path: no prepared capture, archive object receipt, abandoned binding or committed reserved history may exist. Every staging row must be a pending attachment intent for the generation key, with an exact bijection to its building source pins; reject duplicate/extra/missing rows and legacy unrepresented pins. Validate durable manual scope and all ten immutable unconsumed snapshot reservations. A manual request and reservations also exist in legacy admission and do not identify the owned publisher alone; the new complete pending-intent invariant plus the prepared-before-PUT invariant supplies the nonzero-pin proof. Both mutable and available source pins are admissible only with their exact original builder owner, raw lease and valid metadata posture.

Check this again under the higher live cleanup owner. Since abandonment prevents a subsequent prepared/binding commit and every eligible PUT requires that earlier commit, archive publication was never admitted. In one transaction, record a distinct versioned database checksum over the generation, staging intent and full original source-pin binding while still present, transition ALL pending intents → absent under the existing D2b guard, then release ALL source pins through the existing all-terminal function. Do not label this checksum a provider receipt. Already early-complete re-invocation conservatively refuses because deleted pin fields cannot reconstruct this receipt preimage; it does not need a new marker or cause leakage. Zero-pin/zero-intent early generations perform no provider IO and release nothing, without claiming an exclusive publisher identity.

If either proof is incomplete, refuse and retain the original references. Do not backfill unknown object coordinates, re-read source plaintext, allocate replacement nonces, manually delete ciphertext or release key references.

## Runtime boundary and rollback

Expose one explicit internal composed application/server cleanup method. Bind its authorization to the existing canonical scope evaluator, not startup-cached authority. Use the actual native pool, transaction-depth probe, capture limits and manual lease policy. Missing policy, native pool, provider namespace or discard/status capability refuses before cleanup IO. Default-OFF application construction does not resolve providers, database or cleanup dependencies. Stopped/failed application and server shutdown refuse new cleanup; shutdown drains admitted cleanups through the existing lifecycle barrier before custody release.

No production activation or staging dispatch is implied. Rollback is the existing two flags OFF plus normal process drain, with full database/provider readback proving disabled routes make no changes. Do not remove nonempty durable inventory or mutate older frozen proof worktrees.

## Required gates

| Gate | Required evidence | Initial state |
| --- | --- | --- |
| Claim atomicity | Genuine owned claim has one pending intent per source pin; rollback has neither | OPEN |
| Before-first-PUT commit | Prepared plus complete exact namespace roster committed before any provider call; mutation of registration turns matching test red | OPEN |
| Early cleanup | Real claim/capture/nonce process termination, no prepared objects; exact higher fence, distinct never-admitted receipts, all-terminal before pin release | OPEN |
| Prepared cleanup | Real mid-upload and finalize-CAS process termination; complete ciphertext roster, lost-response/restart, exact discard evidence before pin release | OPEN |
| Refusal/concurrency | Live lease, successor block byte equality, stale cleanup owner, other scope/actor/root, missing/partial roster, hold/verified posture, ambiguity retain references | OPEN |
| Product caller | Actual composed server command with canonical fresh authority; default-OFF and shutdown/drain negatives; duplicate capture has zero cleanup side effects | OPEN |
| Current source | Core/acceptance compilation, focused tests plus neighbor, workflow/package/field-ledger/migration union and fail-not-skip collection | OPEN |
| Native faults | Fresh owned isolated APFS + PostgreSQL, synthetic data, actual child termination, real SQL expiry, no seeded abandonment/receipts, immutable inputs and cleanup/readback | OPEN |

No gate here closes independent storage/KMS acceptance, deployed staging SHA/owner activation window, Phase 5 missing-sample attribution, full writer census, merge/CI, broader restore fault matrix or overall TM completion. Report these separately.

## Deferred anchor lifecycle correction — 2026-10-07

The genuine fresh attempt-04 reached all admission DML, then its first COMMIT failed with SQLSTATE23514 after63 native queries. The existing deferred anchor guard bound ordinal10 to the current generation owner; the higher cleanup claim changed that owner/fence while all ten immutable reservations retained their original builder/gen/fence1 provenance, with no published parent history. Full rollback retained the original expired builder, block, pins and pending intents. This authorizes one additive Kysely migration after the current live stream, amending that function only. Historical migrations and the original exact-owner and sealed-history compatibility arms remain unchanged.

The additional arm admits only building/abandoned/incomplete under a higher live cleanup owner and the complete coherent immutable ten-row original builder/gen/fence1 roster, exact scope/vector/creation provenance, nine ordered bootstrap or checkpoint sections, and exact ordinal10 future anchor. Existing producer/immutability functions and triggers must match their exact protected shapes before replacement. The roster establishes structural referential integrity across the existing owner handoff; it is not exclusive publisher identification or cleanup authorization. Actual cleanup retains byte-identical fresh canonical authorization, source-free first statement and full admission checks. The arm remains valid after pins/intents terminalize. No reservation, nonce, history or source-pin ownership is rewritten; no guard is removed or disabled and no parent is fabricated.

Up verifies exact predecessor function/body and trigger shape; down verifies the replacement and refuses any catalog state that the exact predecessor arms cannot represent, without altering data. Safe rollback restores the predecessor bytes. Prepare actual-native claim→real lease expiry→cleanup COMMIT, higher cleanup restart, immutable roster/nonce/key references, full-terminal-before-release and malformed/foreign posture negatives plus apply/rollback/in-use refusal. Source/static/unit checks do not close these native gates; root reviews the frozen correction before any new fresh reproduction or full seven-case fault run.
