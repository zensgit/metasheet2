# Archive Attachment Restore

Status: OWNER-CONFIRMED bounded capability; implementation and acceptance OPEN.

## Baseline And Authority

Owner authorized the recommended sequence: merge #5849, implement bounded
attachment restore, and prepare only a read-only nightly investigation plan.
#5849 exact `c2b46dd17f7a64a7fe789ca28cdaf916023ea646` had 37 successful
checks and one intentional skip before Ready and merge. Merge/base:
`868c8d2b26424fcaa8405661a6999abb17ec6d93`, ordered parents
`bb77ca5f2ce3c2825265ec8877861d367d017ead` and the authorized PR head.
Post-merge CI is a separate gate; its terminal base evidence is recorded in the
paired verification report and is not successor CI evidence.

Development branch: `codex/timemachine-attachment-restore-20260919`.
Only isolated synthetic files/databases and ordinary Draft publication are
authorized. No runtime enablement, dispatch, deployment, real environment access
or customer data/storage. A successor merge needs separate authorization.

## Confirmed Product Boundary

- Restore archived attachment references and file content only to the existing
  original record and original attachment field, with current write permission.
- Do not recreate a deleted table, record or field. Do not restore permissions.
- Missing authenticated evidence, changed scope/schema/record/attachment authority
  or revoked access refuses the entire selected operation, not a partial success.
- Explicit preview and confirmation remain mandatory. No automatic restore from
  capture, catalog, refresh, retry-status or diagnostic operations.
- Existing scalar/link recovery and capture behavior remain unchanged when no
  attachment restoration is selected. Attachments must not enter the generic
  scalar-restorable field set in `record-restore-diff.ts`.

## Source-Grounded Integration

`recovery-archive-reader.ts` authenticates the complete manifest/index and file
frames; its private byte map provides defensive copies only for reader-issued
state. `recovery-archive-manual-admission.ts` signs original attachment/record/
field identity, source version, digest, size, media type and deleted state.
The archive index does not include an original display filename. Do not invent
missing metadata or import unauthenticated caller values as historical truth.

`recovery-archive-sync-restore.ts` currently passes only records/links to the
canonical L8 write kernel. `recovery-archive-preview.ts` explicitly blocks differing
attachments. These must change together with execution identity and authorization;
removing the diagnostic alone would silently discard selected attachment changes.

`attachment-service.ts` owns attachment metadata and purge integration.
`StorageService.ts` provides exclusive-create content-addressed upload and digest-
checked reads. File I/O cannot participate in a PostgreSQL rollback. Consequently:

1. Read the authenticated archive through its public complete-state facade.
2. Build a closed selected attachment plan, cross-checking original record/field
   identity and requiring the original record and field to exist. Preserve order
   and exact selected references; do not turn malformed values into empty arrays.
3. Recheck current authorization before staging any bytes. Stage and independently
   verify immutable file objects outside the destructive transaction. A prepared
   object alone is never visible as a restored attachment.
4. Under the canonical writer fence and restore transaction, recheck live record,
   field permission/lock and attachment metadata/purge authority against the preview
   binding. Update metadata, record references and canonical revision/history as
   one transaction with the existing restore idempotency authority.
5. Any refusal or storage failure leaves all selected live records unchanged.
   Attempt-owned staged objects need explicit ownership and cleanup semantics;
   never delete a pre-existing/shared object on rollback. Crash/retry cleanup and
   durable preparation ownership must be resolved in code before runtime exposure.
6. Async restores must not gain partial attachment semantics implicitly. Whole-
   selection rejection on preflight drift and chunk/retry authority must be tested
   against the existing async contract before allowing an executable async plan.

These are required implementation properties, not a claim that a helper or the
existing scalar executor already meets them. Missing retained attachment metadata
must fail closed unless all required metadata can be authenticated; a successful
file decryption alone is insufficient. Do not widen row/field resurrection scope.

### Preparation Ledger

The bounded implementation uses `meta_recovery_archive_attachment_stages` to
persist actor/token-hash/attachment identity before file I/O, with complete original
scope, source version/digest/size and a unique server object UUID. Identity is
immutable; reserved-to-verified is monotonic. The exact expiry of the verified
signed confirmation token is persisted, compared on retries and checked against
database time. Both adapter calls check current authorization and verified,
unexpired source archive authority. No retention or automatic cleanup interval is
introduced. This ledger is not a restore receipt: prepared bytes remain invisible
until the canonical metadata/reference/history transaction commits.

Expired, never-applied stages can transition to abandoned, then cleaned.
Implementation checkpoint: `87f05247d1cdb9854bcf1f216ecd4a78424e229e`.
This is an update to the same unpublished successor migration, not a rewrite of
an already-landed migration.
Internal cleanup accepts only the server object identity, not a path. It locks the same row
as apply, refuses any attachment metadata reference to that object/path, commits
abandonment before filesystem retirement, then stamps cleaned in another
transaction. Failed storage work remains abandoned and retryable; cleaned is
terminal. A restore admitted before expiry can finish while cleanup waits, after
which its applied state refuses cleanup without storage I/O. Expiry is not a new
schedule or policy default. No public or background cleanup registration is added.
Applied/displaced old objects and private unpublished marker directories remain
separate reference-safe cleanup work, not covered by this expired-stage operation.

### Transactional Metadata Participant

The internal metadata participant requires a nonzero transaction-depth probe and
fresh authorization, then locks the verified source archive and the actor/token/
attachment stage. It compares the complete reserved identity and object UUID.
Only the existing original record and attachment field may join the retained
attachment row. A fingerprint of its database JSON binds the pre-apply metadata;
drift refuses rather than importing stale metadata. The original filename and
media type are retained, size must match, and this bounded implementation supports
the local provider only. A fresh stage object replaces storage identity while
clearing deleted/purge markers in the same transaction.

The internal canonical sync executor now accepts an authenticated preparation
batch. It detaches input, binds its metadata roster to the v2 plan/token, rebuilds
attachment changes under existing sheet/record/schema locks, and includes them in
the locked true-delta permission check. Batch application requires an exact union
of before/target metadata identities and exactly the target set of verified stages.
Metadata updates, reference version-CAS, canonical revision/seal, token burn and
sync receipt share the existing transaction. Dedicated real-DB cases cover this
internal executor, not public HTTP attachment restoration.

The canonical batch also marks each verified stage applied with its operation ID
and displaced old storage identity before replacing the attachment metadata. A
BEFORE trigger locks and checks the original database storage binding. A deferred
commit-time trigger checks the adopted object, original record reference, sync
receipt and token burn together. Neither a forged displaced location nor a wrong
operation can commit. Applied rows cannot be rewritten or deleted. This is a
commit-time proof, not a permanent foreign key to retention-managed history.

At that internal checkpoint no executable preview was enabled. The public sync
checkpoint below supersedes that limitation only for an explicitly supplied
server-owned storage port. Cleanup, async attachment contract and browser
loop remain mandatory. Retaining displaced identity is not proof of safe cleanup;
physical deletion still requires current reference/pin and ownership arbitration.
Do not infer public completeness from the internal transaction evidence.

## Authenticated File Preparation Facade

The sync facade accepts a server-owned storage port; the public runtime now accepts
an explicit composition port, without registering a default provider or enabling
flags. Before archive reads it checks the signed token, token burn,
current key, catalog binding and legal holds. Each stage authorization reuses the
same source guard. File IO remains outside SQL transactions. Database-derived
metadata, actual field deltas and v2 identity must agree before staging; callers
cannot supply trusted paths, hashes or attachment descriptors. Entry inputs are
snapshotted and known refusals retain canonical structured responses.

An isolated binary acceptance now runs the authenticated reader, durable staging,
canonical metadata/reference/history transaction and readback of original bytes.
Its authorization callbacks and signed token are synthetic: it is not public
preview, real login or browser UAT. Cleanup and concurrent failure gates remain open.

The two-file failure oracle now requires one verified and one reserved object
after a second upload failure, unchanged live record and metadata, and a retry
that reuses both identities without reuploading verified bytes. Real second-metadata
and final-receipt failures now prove rollback of metadata, record/history, adoption,
token and receipt with same-token retry. Abandoned/displaced-object cleanup and
crash/concurrency gates remain open.

## Local File Ownership And Durability

Implementation checkpoints: `a6cad9ecb06a70dbdfce6bb8627b1242c4aa53a5`
and `b1227f32ac86be4243e58d11d4fb6444a2b87344`.

The durable stage identity derives a domain-separated ownership digest from its
actor, token, object and complete original attachment binding. An existing local
directory is not adopted merely because its payload bytes match. Its exact
versioned ownership marker must match before upload or readback.

A new marker is written and synced in a private sibling directory before atomic
publication. Marker failure cannot poison the stable object directory. Payload
verification reads and syncs the same descriptor, then syncs its parent directory,
before the database can mark the stage verified. Unsupported providers refuse.

The internal local retirement primitive places an empty directory at the exact
payload key as an exclusive-create barrier. This prevents a late uploader from
recreating a retired file; a writer holding the old unlinked descriptor cannot
make its bytes visible at the key. A race that prevents barrier installation
refuses completion rather than claiming cleanup. No recursive deletion is used.
This primitive is not registered as a public or scheduled cleanup capability.
The internal expired-stage operation coordinates this barrier with database
abandonment/apply arbitration. Runtime registration and displaced-object cleanup
remain OPEN.

These guarantees require a trusted, exclusively server-managed storage root.
An actor able to replace directories between ownership validation and path-based
operations is outside this checkpoint's guarantee (retained review P3). This is
not shared-hostile-NAS, WORM or storage certification. A process crash before
publication can leave a private temporary directory; its reconciliation is not
implemented or silently authorized by this checkpoint.

## Required Evidence

The preview projects selected attachment changes into its true-delta permission
context and diagnostic summary. Without a complete server-owned storage port it
still refuses executable attachment previews.
The internal sync plan supports a domain-separated v2 identity carrying a closed,
sorted attachment/original-record/original-field/metadata-hash roster; absence of
that roster preserves v1 hashes exactly. Public database-derived roster collection,
v2 token minting and synchronous execution are connected at
`c97550f243d82060e1af88c1a90864cde78e4c93` (tree
`b93f8883072586cad761331f71c4470e03dce878`). Preview locks and hashes both removed
and restored original metadata; execution rederives the full plan before staging.
The application snapshots and binds all three storage methods, rejecting a partial
port before database resolution. Over-threshold attachment selections remain
whole-selection refused, not silently downgraded to scalar or asynchronous work.

The isolated HTTP/PG oracle now restores two original files, refuses anonymous
execution, metadata drift and altered selected fields before staging, and refuses
token replay without another version increment. It uses a synthetic authenticated
middleware, not real login or browser UAT. No production composition or flag was
enabled. Internal cleanup runtime registration, displaced objects and unpublished
temporary directories still require reconciliation; this is not product FINAL.

| Gate | Required oracle | Status |
| --- | --- | --- |
| Faithful recovery | Existing row/field; changed/deleted attachment reference; original bytes readable after restore; scalar peers unchanged | OPEN |
| Authorization | Second tenant, hidden/read-only field, record lock, revoked access and actor/scope substitution refuse with zero live writes | OPEN |
| Evidence | Missing/swapped/corrupt file, wrong original record/field, missing metadata and invalid reference shape refuse whole selection | OPEN |
| Drift/concurrency | Preview then record/field/attachment mutation; purge race; two-client execute/retry; exactly one canonical effect | OPEN |
| Atomicity | Second file failure and last metadata/write failure leave no partial live restore; owned staging cleanup/restart proof | OPEN |
| History | Restored reference changes have canonical sealed revision/history and visible refresh; no caller-supplied authority | OPEN |
| Browser | Real preview/confirmation/download through production client/router and synthetic owned DB/storage, desktop/mobile | OPEN |
| Mutations | Remove permission, original binding, digest, drift, transactional write or cleanup ownership guard: matching test RED, restored GREEN | OPEN |
| Integration | Focused neighbors, type/lint, required selector union, exact-head CI, independent bounded review and exact-SHA report | OPEN |

## Synthetic Browser Progress

At code `dc589e3e830d1cedaf29b4161839857612590816`, desktop 1440 and mobile
390 production modal/client/router loops restore scalar and attachment changes
against owned synthetic PostgreSQL/storage. The attachment loop verifies both
original binary payloads, entire record equality, one restore history entry and
one UI executed notification. Unsupported attachment copy now explains the
current service/scope limitation instead of claiming universal non-support.

The Browser gate above remains OPEN for full Workbench login, field authorization,
actual grid refresh and browser download. Synthetic SQL edits, synthetic bearer
authentication and direct storage byte readback do not substitute for those
oracles. Cleanup registration, displaced-object reconciliation and full independent
review also remain open. No new recovery semantics or production flag is enabled.

## Local Startup Binding

Local startup follow-up: code `6cb20af35dbd02a5f835027cd5190c917d1dd610`
binds the existing multitable attachment storage singleton into the local custody
composition. It resolves only after successful explicit custody unlock; OFF and
failed unlock never resolve it. No separate attachment root, path override,
permission, retention default or flag was added. Application admission retains
the existing complete-port validation/snapshot. This closes the missing local
launcher binding, not the full login/download or cleanup acceptance gates.

Download evidence at `d1ca403ddb8cd85fc28dbf7575d23a9956df808b` now includes
the existing production attachment GET route: both restored files return original
bytes to the synthetic authenticated actor, anonymous requests refuse, and the
same assertions run after each desktop/mobile restore. The process main pool is
explicitly replaced with a verified owned synthetic database before any route
query. This does not prove browser link interaction or Workbench login.

## Authenticated Acceptance Follow-Up

Code `4b5a6a52e5593cba730dec97a3e9628a8af7b631` replaces the attachment
verifier's synthetic identity middleware with production login and JWT middleware
using an isolated synthetic account. Capture, preview, restore and download use
the resulting session; inactive-actor download refuses. Desktop/mobile modal
acceptance passes with that token. This still is not Workbench login-page,
organization selection, grid refresh or attachment-link-click UAT.

Sol's bounded permission/original-binding review of `f215ba1f1a` found no P1 and
one P2: preparation refusals can escape as HTTP 500 rather than canonical
forbidden/drift responses. Fail-closed behavior is preserved but the diagnostic
contract was not complete at that checkpoint. The bounded fix below closes this
finding; successful authenticated recovery alone was not sufficient evidence.

## Typed Refusal Closure

Code `6bff7a8d6645644ad07b77b606df265dc2842aa0`, tree
`5e322c08b76f9f513b240b78f727ba0fdbe8aa04`, preserves named permission
refusals through preparation and staging, and maps original metadata/plan drift
to the existing preview-drift response. Unknown DB/storage failures remain generic
server failures, with private provider details sanitized rather than exposed.

The actual HTTP oracle previews first, then makes the original field read-only:
execution returns 403 without new stages or record changes. Moving the original
attachment out of its field returns 409 with the same zero-effect assertions.
Restoring the fixture permits the unchanged positive two-file restoration and
original-byte downloads. This does not add permission or recovery semantics.

Terra read-only review found no evidenced P1/P2 in the five source-file fix after
withdrawing an incorrect infrastructure-error-classification concern. It ran no
tests; executable evidence remains the owned local verification. Draft/HOLD stays
in force pending successor CI and the remaining acceptance gates above.

## Field And Record Lock Acceptance

Authorization acceptance follow-up at code
`84e975b2b131c1ed0ebadde93f8f5974ca01abfa` adds production HTTP proof for
post-preview hidden/read-only attachment fields (403) and another actor's record
lock (409 RECORD_LOCKED). The latter preserves live attachment metadata, record
data/version, history, token and receipt; restoring the fixture permits the
original positive recovery. This is existing lock semantics, not an administrator
bypass or new unlock action. Staging may prepare private attempt-owned objects
before the canonical record-lock refusal; no zero-staging claim is made for that
case. Cross-tenant and full Workbench acceptance remain separately open.

## Nightly Plan Boundary

No real environment access is authorized by this plan. Known artifact evidence:
External Metrics run `35414465715` and Regression run `35414586092`, main
`bb77ca5f2ce3c2825265ec8877861d367d017ead`, each report 11 checks, five
passes, six N/A and zero measured failures. Missing p95/p99 families are plugin
reload and snapshot create/restore. This is not proof of excessive latency.

Before any future environment read, obtain a named authorized environment and
owner-provided sanitized evidence: scrape timestamp/window, expected registry
identity, metric family/label names, and whether the corresponding activities
occurred. Do not request credentials in reports. Compare exporter registration,
configured family/label selectors and observed samples offline first. Distinguish
wrong target, missing family, label mismatch and no activity. A synthetic fixture
can prove parser behavior, never production population. Do not generate reload/
restore activity, change thresholds, dispatch workflows or claim the alerts closed.
