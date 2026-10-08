# Time Machine owned manual generation composer

Status: default-OFF implementation of the existing D-H2 contract. Baseline
`0e8f5c26c552df350c70c81a4f6729efa346350d`, prerequisite Draft #6239.
`multitable-timemachine-phase-d1-durable-archive-design-lock-20260826.md` remains
authoritative. This lock precedes production edits; it does not ratify flags or release TM.

The frozen product-path source census at prerequisite #6233 identified the shared false-cache
hole; #6239 reproduced and fixed it under native RC/migration/writer barriers. That bounded source
census plus correction is an input to synthetic composer verification. It does not ratify full
D-H1 production writer closure, dynamically installed plugins or operator SQL. Creating production
or staging generations remains unauthorized until that owner gate and required full census are
closed; this slice exercises only isolated synthetic generation creation.

## Result and minimum scope

The existing manual capture command already performs a full legacy archive. The new owned claim
and fresh RR capture helpers have no production caller. Legacy continuation/finalization reject
an owned archiving block, reread live source and consume history before crypto; they cannot compose
the D-H2 phases. Connect the existing manual endpoint to one complete owned generation when both
existing archive/writer flags are literal 'true'. Keep the entire unselected legacy command path,
existing format, flags, canonicalizers, hash domains and migrations unchanged.

Success means a populated first bootstrap and a repeat checkpoint after a real ordinary write
both produce authenticated, complete, recoverable generations through the actual command. Include
all retained live and soft-deleted attachment rows and immutable local bytes. No older endpoint is
reconstructed from current projections. No hot prune, scheduler, automatic lifecycle cleanup,
provider capability, restore feature or key retirement is added.

Use sibling owned modules for the composer, authority checks and future-history plan/consumption;
do not grow the existing route mega-file beyond necessary factory/type wiring. Existing crypto,
prepared-envelope and object-receipt helpers remain the primitives.

## Private authority and transaction phases

1. Issue the existing committed-claim capability only after confirmed claim COMMIT. Add the already
   selected trust checkpoint ID to its private snapshot. Preserve all prior authority fields,
   independently bound writer/generation fences and raw PostgreSQL timestamps.
2. Consume that genuine claim once in the existing fresh RR capture. Add synchronous, permanent
   consumption of the genuine captured-source capability for this downstream phase. Detached
   readbacks, clones, DTOs and consumed tokens cannot grant plaintext or publication authority.
3. RR releases before attachment reads, custody, encryption or provider calls. Verify every local
   immutable descriptor against actual version/hash/size and bytes. Commit all exact source-pin
   transitions from mutable to available together, after fresh authority/head/reservation checks.
   Later checks expect available pins; do not reuse the RR mutable-only predicate.
4. Every short selected write transaction has actual RC/ongoing-transaction proof and the canonical
   source-free fence before source authority reads; key row, writer-block row, generation and source
   state follow the D-H order. Refuse inherited RR/autocommit. No nested transaction or fence spans
   network/custody work. Normalizing the shared pool is outside scope.
5. Fresh checks bind exact identity/scope/request hash/key row version/trust checkpoint, raw block
   owner/fence/lease/updated-at, generation owner/fence/source vector/claim and expiry timestamps,
   observed operation/section heads, ten ordered reservations and phase-appropriate complete pin set.
   Missing/unknown/expired/drifting state, including one-microsecond drift, refuses. An owned
   exception is private phase authority, never an ignoreArchiving boolean or request-body option.

## Future history, encryption and publication

Before crypto, construct exactly nine future revision rows, nine child endpoints, nine memberships
and one parent endpoint. Both bootstrap and checkpoint therefore have 28 current-generation
coverage candidates; this does not cover all retained history. Revision ID equals its persisted
reserved section operation ID. Each row uses its corresponding reservation's raw created_at;
membership uses the parent reservation timestamp. V1 manifest/source-hash projections retain the
existing canonical millisecond UTC representation. Compare raw timestamps separately in SQL.

Build plans with the existing section-row, canonicalization, source-hash, coverage and snapshot
helpers. Do not commit any future history during planning. Derive a DEK outside transactions;
atomically reserve all ten section nonces and every attachment nonce, against the exact ordered
generation/object batch, in a confirmed short transaction. Only after that COMMIT may AEAD run.
Collision or unconfirmed reservation leaves zero ciphertext/PUT; nonce reservations never expire,
delete or become reusable.

Persist the complete exact ciphertext and signed manifest envelope before the first PUT. Upload
the exact generation-scoped bytes and require genuine PUT plus HEAD receipt compilation. Manifest
MAC production and verification happen outside transactions. All external adapters use the same
runtime transaction-depth probe; each external call must see depth zero.

One final short transaction rechecks authority and the unchanged prepared package, exact nonce
reservations and 11+attachment uploaded receipts. Consume the exact predeclared history with
reservation-backed INSERT SELECT: each revision before its dedicated child endpoint, all children
before memberships, parent LAST. Require exact insert counts and retain actual DB triggers/FKs.
Reuse the existing actual snapshot-plan readback in this transaction and compare every canonical
section/coverage hash and row count against the precomputed authenticated package. Then create
distinct archive-object refs, release source refs, insert exact coverage and publish
verified/finalized/complete, and CAS-release only the exact writer block in this SAME transaction.
Any error rolls back history, coverage, references, catalog publication and block release together.

## Failure, replay and bounded runtime

Handled failures after a genuine confirmed claim mark only that exact builder active->abandoned,
preserving owner and lease, and release only the exact block tuple. Use the existing cleanup prelude
so permission/key/lease loss or emergency flags OFF cannot disable this safety action. A successor
block mismatch is a no-op and cannot clear its owner. Keep monotonic fence, source pins, prepared
ciphertext, object inventory, reservations and nonce tombstones; their deletion remains the existing
separate cleanup protocol. No abandoned attempt becomes verified.

This selected owned command is one plaintext attempt per request. Duplicate POST reads durable
status only; it never recreates a claim/capture token, recaptures source, consumes more reservations,
re-encrypts or falls back to legacy upload continuation. A new request starts a new generation after
owner-safe release/reclaim. The unselected legacy persisted-envelope continuation stays unchanged.
Cross-process continuation of an interrupted owned upload remains OPEN for separate integration;
do not describe status-only replay as resumed upload.

If claim COMMIT succeeds but acknowledgement/session release fails before capability issuance, no
downstream action is authorized. Retain the durable lease-bound pending/incomplete attempt for
the existing expiry/cleanup protocol; do not reconstruct authority from a request lookup. Likewise
an uncertain final COMMIT is success only after authoritative recoverable-status readback; failed
readback never guesses success. A process kill cannot synchronously run abandonment; retained
state and subsequent owner-safe expiry remain explicit fault/lifecycle gates.

Carry the real native pool from getInternalPool through application/router to the selected command.
Carry explicit server-owned manualCaptureLimits using the existing closed {maxBytes,timeoutMs}
validation; no request-body budget or invented default. Missing/invalid pool or limits refuses before
claim. Native acquisition timeout must be finite and within the supplied time limit; never mutate
shared pool options. Apply a whole-attempt deadline and aggregate staging byte cap to DB metadata,
attachment bytes and prepared payload. Late completion after timeout cannot publish or perform
another provider call. Wipe temporary attachment plaintext on success/failure. Per-object storage
limits remain independently enforced.

For the selected local attachment port, add a narrow readContentAddressedBounded method: validate
the supplied remaining byte budget and immutable key, inspect the opened regular file size before
allocating, read at most that bound plus one overflow sentinel, and verify the complete digest.
Refuse oversized/growing/changed input; close the handle on every path. The existing unbounded
readContentAddressed method and its legacy callers stay byte-identical. The bound covers accepted
staged representations and this source-file read, not total Node/PostgreSQL RSS or every internal
copy made by existing cryptography/serialization helpers. No general storage refactor is allowed.

## Gates

| Gate | Required evidence | State |
| --- | --- | --- |
| Baseline | Unchanged actual manual path demonstrates missing durable owned block or early committed history, with a matching named assertion; preserve raw failure | OPEN |
| Complete bootstrap/checkpoint | Actual manual command, real migration ups/guards, populated first and repeat-after-write archives, complete exact 28 coverage rows per generation | OPEN |
| Attachments and phases | Live/deleted local objects restored from authenticated archive; claim COMMIT before fresh RR, no external call in any DB transaction, pins retained through upload | OPEN |
| Closed authority | Clone/reuse, cross-scope, expiry, auth/key/trust/head/pin/reservation/raw timestamp drift refuse without publication | OPEN |
| Crypto and receipts | Whole permanent nonce batch commits before any AEAD; signed prepared bytes before PUT; genuine PUT/HEAD receipts and exact coverage | OPEN |
| Atomic finalization/failure | Final rollback has no partial history/coverage/publication; exact-owner abandonment cannot clear successor or delete pins/nonces; uncertainty never guessed | OPEN |
| Bounds/parity/replay | Aggregate bytes/deadline; late callbacks stopped; missing config refuses; exact OFF parity; duplicate POST status-only with no second crypto/source attempt | OPEN |
| Refutation/review/CI | Matching guard mutations RED, exact restore, whole neighboring files, native roster/exclusion/armed sentinel UNION, official provenance, independent review and configured checks | OPEN |
| Overall TM | Full writer runtime closure, owned durable upload continuation/lifecycle, current-source same-archive APFS backup/restore/crash/rollback, Phase5 attribution and owner ratification/merge/deploy/staging | OPEN |

All native data/principals are newly isolated and synthetic. Never restart earlier evidence clusters.
Same-host APFS and local NONKMS custody do not prove independent provider durability or KMS.
Existing LC1..LC6 roots and all historical failures remain retained.
