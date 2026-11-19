# Legacy permission revoke transaction boundary

This integration contract combines the B2 live authorization-input witnesses with the #6924 authorization confirmation and source receipt semantics for `POST /api/permissions/legacy/revoke`.

## Input, authority and ordering

The compatibility route validates its two string inputs and preserves its existing trim behavior. It calls the data-only `writeLegacyAuthorizationException` command with the actor, normalized target and permission, and optional reason. The closed, frozen shared-world REVOKE_DIRECT plan holds R3 for actor and target before R5 for either. The confirmed legacy-revoke action uses the existing AUTHORIZATION_OPERATION root with that operation's receipt identity, planned role parents and deadline. Each entry takes exactly one transaction.

Check an active, activated and non-recycled actor plus an actual admin membership on the same connection before returning any target-specific decision. The locked membership uses FOR SHARE; raw role, is_admin or token claims alone cannot authorize this write. Compatibility roots restore their local timeout after a successful membership query. A confirmed operation retains its own timeout. A loss of authority gives the same 403 for missing, recycled and existing targets. With established authority a missing target yields 404 and a recycled target 409. An inactive or pending target can still be changed. A genuine open token, correct root identity and live actor and target witnesses are required at the write sites.

## Column, evidence and receipts

Keep the pure `removeMatchingLegacyPermission` array operation. It removes matching trimmed strings and preserves all other elements, including nulls and non-string JSON values. A scalar, including a string resembling a JSON array, remains unchanged. A non-matching list is a no-op. The sole legacy UPDATE owner is `revokeLockedLegacyUserPermission(tx, options)`, called only by the shared `writeAuthorizationException` writer. Its two statements preserve the original jsonb or text[] type and compare the database value with the previously observed image. Reject unsupported storage types, a stale source or an unacknowledged/mismatched RETURNING row. Keep the outer write on the original transaction with both actor and target locked.

For a real change, supersede the existing target deprovision evidence and update its generation, and write the appropriate source receipt and mandatory audit on the same transaction. If any part fails, none of those effects commits. No-match returns the existing 404 without invalidation or audit. Successful writes invalidate the target cache only after confirmed commit. Keep recovery-conflict classification first, the established busy 409, and the mainline 403/404/recycle/stale error bodies. Never replay a command whose commit or response is uncertain.

## Verification

Keep both storage representations, before-image comparisons, acknowledgement failures, namespace isolation, and real membership SHARE/DELETE contention in both arrival orders under the native legacy transaction tests. Keep the mainline compatibility-route matrix for unknown and existing targets, missing live administrator, mandatory audit rollback and no duplicate event. Caller guards bind both receipt-owning roots to the shared writer, and the stored-column writer to its single checked caller. Read-side imports of the pure array helper are limited to the existing operation snapshot and receipt service.
