# Time Machine abandoned builder object cleanup prerequisite

Status: bounded prerequisite implementation authorized; independent review pending; existing D1 D-H2 / D2b / D7 object-only prerequisite. Baseline: `48ae5025a5f899de02efd511e7b7e2f2646049ce`.

## Existing contracts and gap

- `recovery-archive-manual-continuation.ts`, `bindManualObjectUpload`: durable prepared bytes determine SHA256 object identity and version before PUT, but no D2b inventory is registered.
- `zzzz20260826121000_add_recovery_archive_staging_cleanup_protocol.ts`: expired owner/fence CAS claims abandoned builders; immutable terminal receipts gate source-pin release. Pending accepts only absent; sealed accepts deleted or absent.
- `recovery-archive-file-store.ts`: exclusive retention decisions serialize pin/delete and prevent successful PUT resurrection; expiry deletion has no operation receipt.

## Protocol

1. In a short authorized, current-owner transaction, register the complete immutable prepared-envelope plan (all sections, attachments and optional manifest) as D2b pending inventory and immutable provider bindings (generation, staging UUID, class/attachment, SHA256 identity, version, digest, size, expiry, operation UUID); advance inventory to sealed because bytes are already durably sealed, before PUT is possible. Retry checks the entire existing binding. Cleanup independently verifies the prepared payload digest and requires an exact bijection between its complete object plan and immutable mappings; legacy absent or partial mappings are refused. Provider expiry is the existing millisecond `Date.toISOString()` contract; the PostgreSQL parent comparison uses `date_trunc('milliseconds', expires_at)` and refuses even an adjacent millisecond. No provider IO inside transactions.
2. An explicit cleanup call rechecks canonical scope and exact expired builder owner, claims using the existing function, and persists no speculative provider success. Each provider attempt has a fresh short current cleanup-owner/fence and posture check. Database admission takes the canonical sheet fence, existing key row, writer-block assertion and generation lock in that order (cleanup does not acquire a new key reference and permits a retiring key), refuses active legal holds, and rejects incomplete provider mappings. Objects with verified catalog receipts or archive-object references are refused.
3. Separate additive discard/status port uses operation UUID plus exact binding. LOCAL file provider uses immutable operation journal and existing exclusive retention decision. The terminal outcome is `absent`: both unuploaded and uploaded objects require durable exact-binding tombstone plus completed unlink and directory fsync. It proves this discard operation has made the object unavailable and prevents successful stale PUT resurrection; it does not claim that bytes previously existed. Pin wins mean retained. Status always repeats unlink/fsync even after a terminal journal, because an already in-flight PUT can publish raw ciphertext after an earlier unlink and crash before its second tombstone check. The receipt promises permanent absence through the official provider, not physical erasure or permission to release/destroy a key. Lost response is ambiguous until exact operation status reconciliation; HEAD null is never evidence.
4. Terminal receipt digest covers operation, exact binding and terminal outcome. A short transaction rechecks owner/fence, writes D2b terminal receipt, then invokes existing pin-release function only after the entire inventory is terminal. Stale owners perform no catalog/pin writes. No transaction/advisory lock spans provider IO.

## Ownership and gates

Implementation owns additive binding migration, `recovery-archive-abandoned-object-cleanup.ts`, `recovery-archive-abandoned-object-store.ts`, surgical manual upload and local file provider changes, focused unit tests, and existing D2b realDB tests/required migration replay wiring as necessary. No existing migration is edited. Rollback refuses nonempty binding inventory.

Gates: registration before IO; exact-binding and cross-generation rejection; stale claim/owner takeover; crash before provider call and after provider confirmation; durable restart/status; pin/delete race and stale PUT no resurrection; transaction-depth rejection; values-free failures; ambiguous outcomes retain source pins; realDB on owned disposable local cluster; independent immutable review.

No timer, startup activation, provider selection, flags, retention defaults, verified-archive expiry, key destruction, remote IO or customer data. Draft/HOLD remains until separately approved.

## Residual limits

This slice does not close full D7 fault/cleanup acceptance. Verified-receipt, pinned-object, and late-finalization cases remain OPEN conservative refusals. Legacy unrepresented uploads remain OPEN and are never guessed from missing HEAD results. Terminal staging receipts preserve key-reference inventory; no key reference release or destruction is implemented. Sealed staging entries in a normally verified generation retain immutable provenance and are ineligible for this abandoned-builder path.

LOCAL pin/discard contention has both independent same-process provider coverage and a two-child-process gate: each child independently constructs its provider on one parent-owned synthetic root, waits for both ready signals, then races pin against operation-bound discard. Exact retained/absent outcomes, receipt, availability and child exits are checked before root removal. This proves bounded local contention only; cross-process crash/restart fault acceptance and full D7 remain unproven. Existing file-store neighbor coverage is reported separately.

## CI and file census

- Runtime: new abandoned-object port and cleanup/registration module; surgical manual continuation and persistent local provider integration.
- Database: one additive migration, immutable row/truncate guards, empty-only rollback, exact catalog audit.
- Verification: new automatically collected unit file; existing whole-file D2b realDB selector preserved; existing manual-checkpoint script gains verified-generation provenance and claim-refusal assertions.
- Migration replay: append the new migration, relation, function and both triggers; newer-layer suspension/restoration includes the new empty layer; exact-anchor CI census changes from 32 to 33 with all prior entries and removal mutations preserved.
- No workflow selector is removed or narrowed. No workflow, package script, route, feature flag, timer, provider default or external integration is enabled.
