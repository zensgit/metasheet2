# Archive Attachment Restore

Status: OWNER-CONFIRMED bounded capability; implementation and acceptance OPEN.

## Baseline And Authority

Owner authorized the recommended sequence: merge #5849, implement bounded
attachment restore, and prepare only a read-only nightly investigation plan.
#5849 exact `c2b46dd17f7a64a7fe789ca28cdaf916023ea646` had 37 successful
checks and one intentional skip before Ready and merge. Merge/base:
`868c8d2b26424fcaa8405661a6999abb17ec6d93`, ordered parents
`bb77ca5f2ce3c2825265ec8877861d367d017ead` and the authorized PR head.
Post-merge CI is a separate gate, not yet claimed here.

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
immutable; reserved-to-verified is monotonic. Both adapter calls check current
authorization and verified, unexpired source archive authority. No retention or
automatic cleanup interval is introduced. This ledger is not a restore receipt:
prepared bytes remain invisible until the canonical metadata/reference/history
transaction is implemented. Apply/abandon/cleanup coordination and reference-
aware deletion are still required before exposure; do not infer those guarantees
from the reservation and verified states alone.

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

This participant is not a public entry point. Canonical writer fencing, locking,
preview/token fingerprint binding, reference CAS, history, receipt consumption,
cleanup ownership and runtime wiring remain mandatory. No executable preview is
enabled by these internal changes. The test's forced enclosing rollback proves
transaction participation only, not the yet-unwired history/record write chain.

## Required Evidence

The preview now projects selected attachment changes into its true-delta permission
context and diagnostic summary. It still refuses executable attachment previews.
The internal sync plan supports a domain-separated v2 identity carrying a closed,
sorted attachment/original-record/original-field/metadata-hash roster; absence of
that roster preserves v1 hashes exactly. Database-derived roster collection,
token minting with v2 and canonical execution rechecks are not yet connected.
Never treat the new hash compiler as proof of that end-to-end binding.

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

## Nightly Read-Only Investigation Plan

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
