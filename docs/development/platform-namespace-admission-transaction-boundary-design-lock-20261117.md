# Platform namespace admission transaction boundary

## Scope and availability

This lock covers only the existing platform-admin `PATCH /api/admin/users/:userId/namespaces/:namespace/admission` caller. It is a local B2 prerequisite, not a new login grant, proof purpose, identity write, feature switch or deployment. Other admission callers and the shared writer registry remain pending. A design gate is not implementation or runtime acceptance.

## Command boundary

- Introduce one data-only command accepting `actorId`, `userId`, `namespace` and `enabled`. Clone all four scalar inputs synchronously before the first await; freeze command-owned objects, never the caller's object.
- Use one default `withAuthorizationInputTransaction`, READ COMMITTED, shared R0, no R1 or role-parent R2, then every R3 before every R5. Actor and target are code-unit sorted and deduplicated, including actor=target.
- The owned frozen plan has exactly `intent`, `roleIds`, `userIds`, `admissionUserIds` and `witness`. Intent is `SET_ADMISSION`, parents are empty, and both plan and witness subject lists equal the complete actor/target set. Do not extend the intent catalogue.
- No caller transaction, runner, hook, nested root or extra lock helper is admitted. Before use, require the genuine open same-connection token, shared world, identical plan object, exact frozen context/keys/lists and intent. Immediately before the business helper, recheck those facts and exact actual R3/R5 witness sets, locked subject keys and empty role-row keys. A born subject is not a held subject.

## Domain and authority

- Preserve existing preflight normalization, boolean and controlled-namespace validation, platform-admin gate and invisible-target 404.
- In the root, target missing gives `NOT_FOUND`/404; deleted or purged target gives `USER_IN_RECYCLE_BIN`/409, before actor/witness refusal. Inactive and pending targets remain writable as before.
- Actor authority is S0: qualified active, activated, non-recycled account with raw `users.role='admin'` OR an exact live `user_roles.admin` membership. Retain the existing locked representation, including `COALESCE(is_active, TRUE)`. No wildcard, token, `is_admin`-only or extra disabled-role rule is introduced.
- Raw admin returns before a child query. Membership-dependent authority takes an exact same-token `user_roles(user_id=actorId, role_id='admin') FOR SHARE` after target/account checks. Save timeouts, use the existing 5000/10000 window, restore on row/no-row completion, and do not send restoration SQL into an aborted transaction. Missing edge gives existing actor403/no write; positive SHARE remains held through commit.
- This child SHARE is distinct from a `roles` parent and does not require nonempty `roleIds`. It does not assert closure of every competing authorization writer.

## Write and response compatibility

- Call the existing `writeUserNamespaceAdmission` exactly once on the branded token, with `{ userId, namespace, enabled, actorId, source: 'platform_admin' }`. Keep its sole DML literal and W-16 pending status. Do not copy that DML or call the wrapper that owns another raw transaction.
- No user, identity, role, proof or audit write is added inside the root. Preserve post-commit list → permission-cache invalidation → audit `grant`/`revoke` → existing response. A later response failure does not imply the earlier commit rolled back.
- Keep all other route handlers, bulk/birth writers and shared helper semantics unchanged. No stricter target-ID contract from a different API is imported.

## Error contract

- Only this caller's catch adopts the inherited `AuthorizationInputBusyError` response: 409 `{ ok: false, error: { code: 'AUTHORIZATION_INPUT_BUSY', message: 'Authorization inputs are busy; retry this change.', details: { retryable: true } } }`.
- This includes eligible acquisition and awaited-work failures, explicitly 55P03, 57014, 40P01 and non-marker40001 as classified by the default root. It is an observable old generic500 → typed409 change, not a new retry or global error-mapper rule.
- Recovery-marker40001 remains this route's old generic500 without a recovery adapter; XX000 remains500. Work-return, uncertain COMMIT acknowledgement and post-commit failures retain their original boundaries and are not labelled busy or automatically replayed. Pre-commit busy produces no commit/readback/cache/audit. One root attempt only.

## Required verification gates

1. Existing normalized route/body/domain behavior; raw-admin/no-child and membership-only positives; missing/inactive/pending/recycled actor and target cases, with domain precedence before actual-witness errors. Preserve caller mutation isolation, including actor=target deduplication.
2. Genuine/open/correct-connection/plan-identity/frozen-shape/actual-witness negatives. Exact importer/registered-route/data-key and binding guard, with no generic allowance, alias, detached call, callback, caller token or runner.
3. Actual owned synthetic PG persisted admission rows and unchanged neighbors; root order R0 → all R3 → all R5; positive child SHARE and concurrent DELETE in both orders. Neutering SHARE must produce a behavioral physical-lock red, exact source restore, then green.
4. Exact busy response for acquisition and awaited-work eligible SQLSTATEs; marker and XX000 old500; no pre-commit persisted/post-commit effects; no replay after uncertain COMMIT or post-commit failure. Separate injected SQLSTATE surface coverage from physical lock coverage.
5. Preserve existing unit and adjacent PG regressions. Whole new PG file, zero skips, module-load refusal when `EXPECT_DB=1` lacks a URL and failure rather than green when the owned URL is unreachable. Filtered cases are unexecuted, not extra passes.
6. Main alone registers the new whole PG file once in the existing `approval-db` / `approval-real-db-integration` lane with `EXPECT_DB=1`, default unit exclusion and the exact Node ownership guard. Preserve all sibling workflow/test-chain entries; removal, duplicate and relocation negatives must fail. Local registration is not remote CI execution.

## Ownership and delivery limits

Grok authors the bounded new command, this route's replacement and focused unit/PG specimens. Codex owns shared guard/CI integration, serial execution, source-fault restoration and final verification. Independent review is required before local acceptance. Source edits are disjoint; database execution is serial against the existing owned synthetic instance only. No installation, commit, push, deployment, staging or real-account operation is authorized by this lock.
