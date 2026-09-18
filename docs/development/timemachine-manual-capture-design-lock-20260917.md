# Time Machine Manual Capture Contract

Status: OWNER-CONFIRMED bounded scope; implementation and acceptance OPEN.

Latest local acceptance: `067b0154794a91222407e29e9c8ae84c5d2208d2` joins
the production modal/client to HTTP capture, status, catalog and preview at desktop
and mobile widths. `49a590333952d88a37435253cdfe94b061dcdcd1` additionally
executes a real HTTP restore of a synthetic changed scalar field, proves its sealed
restore history, and refuses consumed-token replay. `c6d786ccfd3bb6bdec5392215ae6e3eacdfec429`
adds browser-confirmed scalar restore at 1440/390 with independent DB/history
readback. Full login/UAT and immutable attachments remain open. The dated checkpoints below
retain their original narrower evidence boundaries.

UI checkpoint `360a65ce3`: the existing archive modal now has an explicit selected
table confirmation and manual capture/status section. It stores only a request UUID
for tab-session reload, rechecks durable status on mount, retries that same request,
and never initiates restore. Browser component checks are synthetic; full runtime
browser acceptance and immutable attachments remain open. See the staged database
verification report for exact evidence and limitations.

Runtime command increment (2026-09-19, following implementation checkpoint
`d390c1e4797f8a86ef714a34b2fe49e35d686d19`): the selected-table HTTP command
and request-status reader now compose the internal no-attachment pipeline.
This is not closure of the UI, attachment or separate restore acceptance gates.

### Runtime Command Boundary

- `POST /sheets/:sheetId/recovery-archive/captures` accepts exactly
  `{ requestId }`; `GET /sheets/:sheetId/recovery-archive/captures/:requestId`
  reads that actor's durable request. Query aliases are refused. These paths
  share the existing multitable router mount and canonical recovery authority.
- Both operations require the existing exact-true archive and writer-fence gates.
  Creation additionally requires an explicit server-owned `manualCapture` policy
  in application/local-startup composition: `keyId`, `keyRowVersion`,
  `leaseSeconds`, `expiresAfterSeconds`. None has an inferred numeric default.
  Omitted policy preserves restore-only composition; invalid policy fails closed.
  Supporting explicit configuration does NOT ratify the deferred production
  lease/retention values or authorize enabling a configured runtime.
- Server-derived actor/workspace/base/table scope flows through admission,
  canonical section construction, sealing, persisted encrypted package, uploads
  and atomic finalization. HTTP cannot submit ciphertext, rows, keys, source
  vectors, a generation id, lease or expiry overrides.
- Closed response data is `{ requestId, generationId, state }`, with state
  `pending`, `incomplete` or `recoverable`. Pending means a durable active,
  unexpired building lease, not a promise that a background worker exists.
  There is no new scheduler: the explicit POST drives work while awaited.
  Network/upload failure can leave prepared bytes resumable by the same request.
  Loss of the first opaque plaintext source without prepared bytes never causes
  recapture; after its lease ends the request reads incomplete.
- Finalized exact retries return the same generation. Interrupted prepared
  retries preserve payload hash and ten nonce reservations. Status rereads
  current authority; an old request id does not bypass a later revocation.
- Publication does not restore the table. Catalog/preview/explicit restore remain
  separate, and existing hard-deleted table and unsupported-attachment refusals
  remain unchanged. UI and full public restore/apply acceptance remain OPEN.

Owner confirmation: `确认手动归档合同` on 2026-09-17, in response to the
proposal to let an administrator explicitly select a table for manual archive
capture, with isolated synthetic verification and without automatic scheduling,
retention cleanup or customer storage integration.

Inspected base: `89f1ecdee2c3b70205a318074824c834bc6a5c7e` (merged #5848).
This confirmation removes the manual-capture scope blocker only. It does not
ratify the deferred numeric policies in `timemachine-capture-policy-proposal-20260917.md`,
resolve nightly monitoring failures or authorize deployment.

## Confirmed Boundaries

1. An authorized administrator explicitly selects an existing table and initiates
   capture. No implicit all-table scan or startup-triggered capture is added.
   Administrator means the existing recovery authority for that table, not a new
   global-admin bypass. Concretely, reuse authenticated identity,
   `canManageSheetAccess`, full-table read and live sheet/base/workspace scope
   checks; the name of an existing `OwnerContext` helper is not a new
   workspace-owner-only policy. Workspace/base/table/actor bindings remain
   server-owned.
2. Capture creates a recoverable archive of the selected source state. It does
   not move the table to trash, delete it, overwrite live records or perform a
   restore. Archive creation and restore acceptance remain separate commands.
3. Reuse the existing archive format, source seals, coverage proofs, encryption,
   authenticated object receipts, catalog and canonical restore writer. Do not
   expose arbitrary client-supplied rows, source vectors, storage paths, keys,
   manifest hashes or verified-state assertions as capture inputs.
4. Only complete, authenticated captures may become recoverable catalog entries.
   Missing sections, failed storage writes and interrupted capture cannot be
   presented as success. Empty sections require authoritative empty evidence;
   empty arrays must not hide an unsupported source reader.
5. Implement and verify in an isolated worktree with synthetic data and
   task-owned local storage/DB only. Existing runtime switches remain unchanged
   and fail closed. Ordinary push and Draft/HOLD publication follow standing
   authorization; Ready/merge require separate exact authorization.
6. No automatic schedule, retention duration, automatic cleanup, customer NAS
   access, flag enablement, dispatch, staging/deployment, production or customer
   data operation is authorized. Do not revive an already hard-deleted table.

## Source-Grounded Reuse

These are existing components, not evidence of a completed manual-capture flow:

| Component | Existing responsibility |
| --- | --- |
| `recovery-archive-section-rows.ts` | Exact canonical rows for nine data sections |
| `recovery-archive-snapshot-plan.ts` | Ten-section plaintext plan, derived coverage and nonce validation |
| `recovery-archive-section-bootstrap.ts` | Snapshot/section identity reservations and source bootstrap consumption |
| `recovery-archive-seals.ts` | Bound section and snapshot source seals |
| `recovery-archive-object-receipts.ts` | Uploaded/verified object evidence and transactional receipt verification |
| `recovery-archive-catalog.ts` | Existing catalog read contract |
| `recovery-local-startup.ts` | Explicit local custody/provider composition; no capture scheduling |
| `univer-meta.ts::resolveRecoveryArchiveRestoreOwnerContext` | Current manage-sheet + full-read authority, server scope and fresh recheck |

The inspected planner explicitly has no database, storage, route or production
caller responsibility. Its presence must not be reported as a manual capture
button or a complete source-to-archive pipeline.

## Implementation Invariants

- Preserve current recovery permission checks and recheck authority at acceptance
  and publication. Cross-workspace/base/table substitution, revoked authority,
  callers without the required capabilities and managed/system-table
  restrictions must fail closed.
- Use an exact consistent source boundary for all mandatory sections. Source
  movement during capture must not create a mixed-time snapshot. Do not hold an
  unbounded database transaction across object-store operations merely to avoid
  defining the source-boundary protocol.
- Give a manual request a durable identity with a canonical payload binding.
  Same-identity retry must recover the original capture rather than duplicate an
  effect; a conflicting payload must be rejected. Existing reservation and
  publication authority are the first reuse candidates, not a second ledger by
  default.
- Return values-free failures and closed progress/result DTOs. Do not return
  plaintext row data, secrets or physical storage locations in diagnostics.
- Use the unlocked configured provider. Capture cannot provision custody or
  unlock it implicitly. Storage exhaustion or receipt verification failure
  refuses publication; it cannot trigger archive deletion or shorten retention.
- UI progress reflects durable server state. The UI must distinguish pending,
  failed/incomplete and recoverable outcomes according to the final server
  contract; reload/retry must not manufacture success.
- The user reviews and accepts a restore separately through the existing preview
  and canonical writer path. Capture success does not grant restore permission.

## Required Acceptance

| Gate | Required evidence | Current status |
| --- | --- | --- |
| Permission and identity | Authorized positive; unauthenticated/missing-capability/cross-scope and revocation negatives | OPEN |
| Live source capture | Selected synthetic table to canonical sections, with concurrent-source boundary proof | OPEN |
| Complete publication | All mandatory receipts/coverage; missing/corrupt section and storage-failure negatives | OPEN |
| Retry/concurrency | Same request replay, conflicting payload refusal, concurrent attempt and interruption recovery | OPEN |
| Recovery loop | Public catalog -> preview -> separate restore -> exact schema-valid state comparison | OPEN |
| User experience | Real selected-table entry, confirmation, durable progress, reload and failure display | OPEN |
| Discriminating tests | Neutralize authority, scope, receipt/coverage and retry guards -> targeted RED -> restore GREEN | OPEN |
| Isolation | Exact/prefix DB, backend, child process and temporary storage residue zero | OPEN |
| Publication | Required test selectors, immutable reviewed head, exact-head CI and design/verification MD | OPEN |

Empty-table and nonempty-table positives are both required. Unsupported
attachment/section shapes must be visibly refused, never silently omitted.
Record local measurements separately from configured recovery objectives; no
RPO/RTO, NAS durability or independent backup SLA is implied.

## Execution Order

### Repeat-Capture Implementation Direction (Not Yet Implemented)

The source audit and bounded Sol architecture review on `d443fe229` identify
`section_checkpoint` / `checkpoint_snapshot` as the intended repeat-capture
extension. Ordinary events only prove event counts/endpoints, not a complete
section digest; the immutable per-sheet bootstrap marker remains genesis proof.
Do not delete that marker or reuse an old bootstrap root for new content.

Keep first capture unchanged. A later generation requires existing genesis and
nine fresh payload-bound section checkpoint operations plus a fresh snapshot
parent. Reuse immutable generation reservations rather than introducing another
checkpoint-marker ledger. Each checkpoint has exactly one full-section revision
with exact row count and canonical source hash. The generic ordinary-event
sealer must remain unable to mint checkpoint operations.

A new forward migration must extend tightly paired operation/action/member and
reservation constraints, endpoint/member guards and generation claim anchors;
do not rewrite deployed migrations. Preserve bootstrap-only source-vector v1;
use an explicit new domain/version for checkpoint vectors. Add real-DB drift,
forged-member, stale-source, partial-retry and rollback negatives before exposing
the new callable path. A green existing recovery-schema-drift workflow alone
does not prove these causality objects.

The capture transaction must bind the exact canonical content and source fence.
No unbounded object IO inside it. Any preparation outside that transaction needs
a proven drift token and revalidation; crash recovery must not silently recapture
different bytes under an already-sealed generation. Attachment pins and fresh
permission evidence participate in the same complete nine-section proof.
Publication still independently verifies receipts, coverage, authority and owner
fence. Sol's result is architecture input, not implemented/DB-tested approval.

One coordinator owns writes. First trace and implement consistent source capture
and reuse existing publication authority; then bind the command to existing
recovery authorization and the table UI. Review high-risk persistence/permission
changes independently on a frozen head. Run focused neighbors and mutations,
then isolated DB/browser acceptance and required CI wiring. Do not split off
another unused pure-policy implementation and call this contract complete.

Technical route spelling, persisted request representation and exact file scope
are implementation decisions to record after the source trace, not new business
permissions. Any need to widen capture/restore semantics beyond these boundaries
returns to the owner. Keep historical SHA-scoped reports unchanged.

## Prepared Capture Persistence Boundary

The manual-capture implementation adds an immutable, generation-owned prepared
byte store, not another archive catalog. A single prepared payload belongs to
the existing generation, owner/fence and source-vector hash. Its checksum is
database-generated. Exact-byte retry is idempotent; different bytes conflict.
Reads and writes require an active, unexpired owner within an explicit database
transaction. UPDATE, DELETE and TRUNCATE are refused; nonempty rollback refuses
to destroy the retained original. No builder takeover or lease revival is added.

This internal store accepts an opaque sealed envelope from a future coordinator;
it is not an encryption validator, permission check or public endpoint. It must
never receive plaintext or an unwrapped DEK. Ciphertext/wrapped-key/descriptors
must be serialized and validated by that coordinator before using the store.
The source-to-seal crash interval still fails closed: a reserved nonce must not
be reused to encrypt a recaptured source when no prepared payload was committed.
Object upload and provider calls remain outside the database transaction.

Storage acceptance alone does not close durable command identity, consistent
source capture, fresh authorization, full receipt publication, restore or UI.

The internal prepared-upload continuation now serializes a versioned closed
envelope containing the existing crypto binding, opaque wrapped DEK and exactly
ten ordered sealed sections. It validates canonical base64, nonce uniqueness,
tag/nonce lengths and the existing AAD binding before use. It is a structural
validator, not a substitute for AEAD authentication during restore.

The continuation loads an existing envelope before invoking capture. On a fresh
attempt it calls the existing reserve-then-seal implementation with no upload
callback, commits the complete envelope, then begins uploading. Each upload
rechecks the injected authorization port and active generation ownership.
Provider callbacks receive fresh decoded copies, so callback mutation cannot
change later section bytes. Upload receipt construction/persistence remains the
caller responsibility; successful callback completion does not publish a catalog.
No HTTP route uses this continuation yet. Its authorization and transaction ports
must be bound to existing runtime authority before exposing the manual command.

The internal manual-continuation factory now binds the same database actor,
live sheet/base/workspace, manage-access and conservative full-table-read policy
used by recovery workers. Callers of that factory cannot substitute a permissive
authorization callback. The persisted request admission still needs to supply
the server-owned identity; no HTTP body identity is admitted by this factory.
Identity and crypto scope must agree before capture or upload. Every resumed
section rechecks current authority in a short transaction; policy lookup errors
are normalized to a values-free unavailable code. This does not yet provide a
locked permission/source snapshot or authorize catalog publication.

### Durable Manual Request Binding

An immutable internal mapping now binds `(actor_id, request_id)` to one generation
and the exact workspace/base/sheet tuple. Its domain/versioned hash covers the
actor and target tuple; the proposed manual command has no caller-supplied capture
options. Future command changes must explicitly version that payload contract.
Generation uniqueness prevents aliases from turning one capture into two requests.
Database insertion requires a matching live building generation; catalog foreign
keys, immutable row/truncate guards and nonempty-down refusal retain retry truth.

Lookup returns the original generation across connections, including after the
generation is no longer eligible for building. That result is identity evidence,
not permission or a lease renewal. The caller must recheck authorization and active
ownership before continuation. A conflicting target or generation refuses.
The eventual admission transaction must look up first, then atomically create the
generation and binding only when absent; losing concurrent creation must roll back
its entire transaction. This helper does not yet implement generation allocation,
HTTP admission or publication and must not be exposed as an authorization bypass.

### Atomic Reservation Admission

The internal runtime factory now composes fresh canonical scope/manage/full-read
authorization, request lookup and generation/reservation/binding writes in one
caller-owned transaction. Lock order is canonical sheet fence, actor/request
advisory serialization, key registry, then generation/reservation writes. Exact
replays return the recorded generation only after fresh authorization; they do
not allocate another generation or extend its lease.

New requests require an active key at the server-configured row version, no
writer block, and exactly one active unpruned trust checkpoint. Existing immutable
bootstrap markers select checkpoint reservations; otherwise the original bootstrap
allocator is used. Lease/expiry values are explicit server policy, not request
options, a retention scheduler or a cleanup mechanism. Any failed write rolls back
the generation, all reservations and the request binding together.

This is reservation admission, not source capture or a public command. Source
capture/checkpoint sealing still needs an exact in-fence source boundary and drift
revalidation before crypto/publication. A previously reserved generation cannot be
blindly populated from a later live snapshot. No HTTP route calls the factory yet.

### First-Attempt Source Snapshot

Fresh admission now reads the existing seven relational projections and attachment
metadata in one MVCC statement while the admission transaction still holds the
canonical sheet fence. The internal result includes an opaque in-process source
handle. Its original scope, owner tuple, snapshot and canonical digest are private;
consumers receive detached copies, not a mutable reference to the stored snapshot.
Exact request replay returns `source=null`, never a new capture of later data.

The canonical runtime source-recheck factory reacquires the sheet fence, checks
current authority and writer-block/active-generation ownership, then compares a
fresh projection with the original canonical digest. Drift, revocation, expired
ownership and fabricated handles refuse. This helper does not mint a publication
token and does not guarantee that data cannot change after its transaction ends.

The handle is intentionally not durable or public. Loss before prepared ciphertext
has been committed cannot be repaired by recapturing later data under that generation.
The caller must fail closed. Durable ciphertext resume remains a separate path.
Attachment metadata is not an immutable object receipt, and full permission evidence,
source sealing, crypto/provider composition and final publication still remain OPEN.

### Source-Bound First Encryption

The internal continuation now consumes a first-attempt source handle exactly once,
matching actor, workspace/base/sheet, generation owner and the complete reserved
crypto binding. It snapshots the handle and callback before asynchronous work.
Before custody or nonce reservation, all seven relational plaintext sections must
exactly match canonical bytes derived from the original detached source snapshot.
Canonical source/authority rechecks run before and after plan preparation.

Missing, consumed or mismatched handles fail closed when prepared ciphertext is
absent. Once immutable prepared ciphertext exists, continuation needs no source
handle and cannot call capture or produce another DEK. These checks do not replace
final in-fence source sealing/publication checks: source can change after a recheck.
Attachment pins, permission evidence, production nonce/provider composition and
catalog publication remain incomplete. No endpoint or feature flag is enabled.

### Atomic Attachment Source Intents

Fresh manual admission now registers every captured attachment candidate with the
existing generation-owned source-pin authority, in the same transaction as the
generation/reservations/request binding. It uses the database-returned lease value
without timestamp rounding. Deleted attachment rows are not silently omitted.
Exact request replay does not insert or renew pins. A failed pin claim rolls back
the whole admission, including earlier pins.

Pins remain `source/building/mutable`, with null immutable version/hash/size.
This is an intent, not proof of bytes, an archive object reference or a verified
attachment. Immutable source capture, AEAD object copy and durable receipts still
have to succeed before verification/publication. No cleanup or retention behavior
is added or changed by this composition.

### Unavailable Attachment Sources

Fresh admission refuses any in-scope attachment marked `blob_purged_at`, including
deleted/unreferenced attachment rows. The generation, request binding and source
intents roll back together. A live metadata row or absence of that marker is not
proof that bytes exist or are immutable.

The current `StorageService.downloadByKey` contract supplies bytes but no immutable
version/generation or storage-enforced content identity. It must not be reused as
a successful immutable-source adapter merely by hashing one download. D1 attachment
source requirements remain in force: missing, mutable-without-version or drifting
sources cannot produce a verified archive. The archive object-store's exclusive
destination writes do not establish immutability of the source. Source capability
admission and encrypted copy/receipt integration remain open, not silently waived.

### Durable Nonce Authority

Manual continuation replaces the capture callback's nonce sink with its own
transactional sink. The private source handle retains the admitted key row version.
The sink reacquires the canonical sheet fence, locks the exact active key version,
rechecks current scope authority, writer exclusion, owner/lease and source digest,
then reserves exactly ten ordered sections through the existing
`meta_recovery_archive_reserve_nonce` function. All entries must match the source
generation/format/algorithm and one DEK fingerprint. Failure rolls back the entire
batch. The crypto engine cannot seal until this transaction has returned committed.

The existing permanent nonce registry and generation/section uniqueness remain the
authority; no new registry, nonce deletion or duplicate-as-success retry is added.
Prepared ciphertext resumes without another reservation. Source handles still cannot
be recreated for a generation whose plaintext was lost. This does not yet complete
source sealing, immutable attachment copy, object receipts or catalog publication.

### No-Attachment Source Seal Integration

The server-owned reservation transaction now also consumes the admitted bootstrap
or repeat-checkpoint identities. It derives all nine data-section counts and hashes
from the private captured source, with empty attachment index only when no attachment
candidates exist and zero-row audit-only permission evidence. The continuation
requires these two empty sections byte-for-byte; arbitrary callback evidence is not
accepted. Any attachment candidate refuses continuation until immutable-source
verification is integrated.

Canonical fence, current source/key/authority/owner checks, nine source seals,
snapshot parent and reading their coverage rows share one short transaction.
The resulting ten-section plan uses the existing canonical snapshot planner: nine
captured data sections and coverage derived from nine revisions, ten endpoints and
nine memberships. Callback-supplied coverage bytes are never authoritative.

This supersedes the initial seal-in-nonce transaction ordering: coverage must exist
before custody and AEAD. Nonce reservation is a later short transaction which repeats
the live source/key/authority/owner checks. A nonce or custody failure may retain
historical seals, but creates no prepared ciphertext or published archive. It does
not permit recapture of the consumed source. Prepared-envelope resume does not re-seal.
These seals and the 28-row coverage prove this snapshot's source roots only, not
arbitrary historical pruning authority. Immutable attachments, provider receipts and
the final publication fence remain open.

### Durable Section Upload Adapter

The internal manual object-upload factory binds the canonical recovery authorizer,
server identity/owner and an existing object-store provider. Before external IO it
loads the durable prepared envelope and database expiry under fresh authority/owner
checks. Only the selected original ciphertext is uploaded; callback-provided bytes
are ignored. Its SHA-256 is the generation-scoped object ID and immutable version.
The existing receipt compiler performs guarded PUT and HEAD outside transactions.

Before recording an `uploaded` receipt, a new transaction rechecks current authority,
owner/lease and the identical durable envelope. Revocation can leave an unreferenced
encrypted object, but cannot create an authorized receipt. No automatic deletion is
added. Receipt `verified` transitions remain tied to the later finalization transaction;
this adapter neither publishes an archive nor grants recovery access. The synthetic
acceptance uses only the existing test-local provider, not customer storage or a
production-provider readiness claim.

### Local Custody Compatibility Evidence

Manual capture accepts the existing opaque local admission through the unchanged
crypto custody input. No new key provider or format is needed. The synthetic
integration stores the encrypted custody backup in a private sibling directory,
admits the active `local-v1` key, captures and uploads all ten sections, locks the
originating session and restores a fresh session from the saved backup. Wrong
recovery secret, changed generation binding and altered wrapped DEK must refuse.
Already prepared ciphertext can resume upload while the originating session stays
locked; this does not permit new encryption or implicit unlock.

This proves the internal manual chain's compatibility with LC-1..6, not standard
startup wiring, a separate-host recovery drill or final archive publication. Runtime
policy/command admission and manifest/catalog finalization remain open.

### Durable Manifest Authentication

The manual continuation authenticates its server-built sealed-section manifest
before any upload and persists the signed manifest envelope alongside ciphertext.
Manifest timestamps and source vector are taken from the admitted database
generation. Custody MAC runs outside transactions, followed by the canonical
source/key/owner/permission recheck. Existing public archive format v1 is unchanged;
only the internal prepared package gains version 2. Resume requires this signed
package and does not reconstruct plaintext or call custody again. Legacy unsigned
packages fail closed in manual continuation; no implicit upgrade or recapture.

Structural envelope checks do not replace restore-time MAC/AEAD authentication.
Manifest object receipt and atomic catalog publication remain separate unfinished
steps; stored sections alone do not make an archive available for recovery.

The subsequent manifest upload adapter now persists an `uploaded` receipt using
the exact durable signed envelope, with generation-scoped immutable object identity
and fresh post-provider authorization. It never marks receipts `verified` and never
publishes the catalog. The unfinished step is atomic receipt verification and
catalog finalization, followed by runtime command/UI integration.

### Atomic Manual Publication

The internal finalizer now verifies the durable manifest MAC through guarded
custody outside the database transaction. It then re-reads byte-identical prepared
content under the canonical sheet fence, active key/version lock, current request
identity/authority, writer exclusion and active owner lease. The exact unpruned
trust checkpoint must contain the selected anchor. Current source rows and the
actual immutable sealed-history coverage are rebuilt and compared with every
signed section hash/count. Eleven exact uploaded object receipts are promoted,
the 28-row snapshot coverage is inserted, and the catalog is finalized in one
transaction. A failed final write rolls all of those changes back.

Section storage MUST contain `ciphertext || authTag`, matching the existing v1
reader; object identity/hash/size cover the complete bytes. Earlier ciphertext-only
upload evidence is superseded: it did not prove stored objects could be restored.
Fresh-session real local custody now exercises the actual archive reader against
the persisted manifest and all ten complete stored section objects.

This is internal no-attachment publication evidence, not a newly enabled product
route, customer-storage acceptance, full attachment support or a completed goal.
# Attachment Source Purge Arbitration Implementation

Checkpoint `ac390fb7e106852b141051b980602a8a79d9de67` implements the
existing source-protection requirement, without authorizing attachment capture.
`blob_purge_claimed_at` is a durable, monotonic deletion-intent marker, not a
receipt that bytes were deleted. Under the canonical sheet fence, manual
admission refuses this marker and all three guarded physical deletion paths
refuse an active source pin before committing the marker. Provider I/O follows
transaction commit; `blob_purged_at` remains the existing success receipt.
Provider failure retains the marker and permits idempotent deletion retry.
This arbitrates source use versus deletion, not exactly-once physical deletion.
Both existing archive and writer-fence flags must be exact true for guarded
deletion; disabled deletion behavior is preserved. Mixed-version or differently
flagged writers are not a validated deployment configuration. No runtime flags
were enabled outside owned test processes.

## Attachment Ciphertext Identity Substrate

Implementation checkpoint `591c559f151c1579b006d748d231e12001b0b880`
adds same-generation attachment AEAD, not an enabled attachment capture path.
The AEAD domain binds the full original attachment ID, immutable source version,
generation identity and plaintext digest. The nonce registry represents opaque
attachment IDs (including production `att_...` IDs) as `attachment:` plus SHA-256
of the exact UTF-8 ID. This is an internal object discriminator, not a new source
ID or permission. A digest collision refuses a second object rather than
allowing nonce reuse. Existing ten section names and their identity remain intact.

The global `(dek_fingerprint, nonce)` primary key and generation/object unique
constraint remain immediate and immutable. The batch reserves every nonce before
any encryption. The registry migration extends the existing row shape guard and
CHECK, audits both existing uniqueness arbiters, row/truncate triggers and the
values-free reservation function. Rollback refuses once an attachment reservation
exists; no safety tombstone is deleted. It runs within the production PostgreSQL
Migrator's transactional DDL boundary, like the existing registry migrations.

Prepared formats 1/2 explicitly reject attachment ciphertext; their upload
continuation must not silently omit an attachment plan. Durable attachment
envelopes, pin verification, provider receipts, finalization and restore-byte
consumption remain required before declaring attachment archival supported.
