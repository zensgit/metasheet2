# Direct permission writers and authorization confirmation

This contract applies to the integration of the B2 authorization-input root with the permission confirmation and source readback already delivered in #6924. It covers the direct grant, direct revoke and template apply compatibility routes and their shared writer with confirmed operations.

## Compatibility command

The old HTTP endpoints accept authenticated requests without preview or command ID. Grant and revoke require a permission and an existing canonical non-empty string user ID. Template apply validates the template identifier and requires the same canonical user ID. Absent required fields retain their 400 responses. Malformed target identifiers return 400 before opening a transaction. A valid optional reason is normalized and stored with its origin.

The data-only entry is `writeLegacyAuthorizationException`. Capture actor, target, reason, action and a private copy of template codes before awaiting. For direct grant and template use one READ COMMITTED `GRANT_DIRECT` transaction. For direct and legacy revoke use `REVOKE_DIRECT`. The frozen plan lists unique sorted actor and target in both the R3 and R5 subject and witness sets. It names no role parent. The same actor and target yield one subject. The shared writer requires the command's plan object and the actual open same-connection token.

Before reading a target permission image or authorizing DML, validate a currently active, activated, non-disabled, non-recycled actor and the exact positive `user_roles.admin` edge on that connection with FOR SHARE. For compatibility roots bound this membership query with the existing 5000/10000 ms acquisition window, restoring the prior settings after success. An unauthorized actor receives 403 for existing and absent targets. After authority checks a missing target receives 404, a deleted or purged target 409. Inactive and pending targets retain the existing behavior. Actual R3/R5 witnesses must cover both subjects before writing. Born-only rows cannot supply a missing witness.

## Confirmed operations and persistence

The confirmation service owns a separate `AUTHORIZATION_OPERATION` root with its receipt key, planned role parents, deadlines, table fence, version check, audience checks and post-write source readback. Its exception path uses the same `writeAuthorizationException(tx, input)` on its existing transaction. The actor, operation ID, held role parents and actor/target admission and user witnesses must match. Preserve the shorter operation timeout. A caller never starts a nested grant command.

Direct grant, direct revoke and template grant check the full locked before-image, validate all requested catalogue entries for additions and require exact acknowledgement of every changed row. Template apply leaves role assignments and admission alone. A changed permission supersedes existing deprovision evidence. The resulting source receipt and mandatory audit are in the same transaction as the permission change. A compatibility request with no reason records legacy_unprovided. Unchanged requests produce no duplicate receipt or audit. A no-match direct revoke returns 404. Template readback occurs before commit; cache invalidation follows confirmed commit only when a change occurred. Failed audit, receipt or readback rolls the transaction back. An ambiguous commit must never replay automatically.

Keep the established schema/SQL failure and typed HTTP error families at the corresponding endpoint. Authorization input contention returns 409 with the fixed code and error string. A recovery marker retains its separate retryable recovery body. Permission writes cannot report success if schema inputs are unavailable.

## Verification

The native direct-permission and legacy-revoke transaction suites cover physical lock ordering, concurrent membership removal, expected effects and rollback. The authorization-operation exception, compatibility, delegated, full-schema, fence and provenance suites retain the mainline HTTP, receipt, authority and source contracts. Unit and caller guards check the real DML owners, command contexts, before-images, acyclic ownership and error bodies. Keep independent whole-file collection for both workflow families.
