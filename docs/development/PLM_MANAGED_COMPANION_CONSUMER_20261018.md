# PLM managed companion consumer (2026-10-18)

MetaSheet consumer of the native managed-login provider. Meta parent is `9c5fb4c56b9b41df585748db3dd85cbf3f89f0ed`. This slice is not committed.

Native reference checkout `/tmp/codex-plm-managed-browser-entry-20261017` HEAD is `a7ee408f532b13410563ff9429b2cdafb4408250`. Product, auth, router, and browser source blobs are exactly the accepted `aff4197b3fb8440a9a7b81d13712c4c7b52552a3` protocol (successor of accepted B1 `71ebf6cf03e18e7ec0326c76f35900b3ccf5191c`). Main normal-merged its accepted three fixture-only files plus docs recovery through the audit, read, login, and browser branches, avoiding a repeat of the 90-minute child CI. The src diff from that protocol is three disposable fixture files. Parent 349 exactaef contracts 1 and 2 are 1172 PASS, 0 skip, 2330.92s. This is not full native remote CI completion. The native tree was not reset or modified.

The consumer keeps native PLM and approval authority. Managed read does not vote or write. Personal approval and personal BOM write stay on their existing engines.

## Flag

`PLM_MANAGED_COMPANION_ENABLED` is off unless the value is the exact literal `true`. It is registered in `scripts/ops/global-history-flag-manifest.mjs`. Client registration is `PLM_MANAGED_COMPANION_CLIENTS_JSON`, not a boolean flag. With the flag off, managed JWT verification returns null and ordinary reads stay blocked. Logout of an already issued managed session, unlink, and revoke retry stay available to an authenticated Meta user.

## Identity mapping

An owner or admin provisions one explicit link from a fixed native installation issuer, native AuthUser, native tenant, and native org onto an existing active Meta user, Meta tenant, Meta org, and an owned PLM source plus generation. There is no equal-number or email match, no role copy, and no implicit user, member, or source creation. The stored Meta tenant is the caller's authenticated tenant, and both that tenant and the Meta org must be active `user_orgs.org_id` values for the Meta user. A native tenant or org id is not accepted as that membership. Start, callback, and strict session verification check the same pair again.

Native and Meta tenant, org, and user ids are independent. Native AuthUser 42 and RBAC 900 stay distinct. One active binding occupies one data source. A second native identity needs its own owned source, or a later rebind of this source after the current link is stopped. Owner transfer or revocation stops the relationship. A later rebind needs a fresh owner opt-in and the next source generation. That generation is one greater than the persisted binding generation and any generation already used by the same native tuple. It does not restart at 1 for a different native person. Old link rows stay immutable. Concurrent provisions of one source serialize on a transaction advisory lock. The first successful rebind wins. The other receives `PLM_MANAGED_BINDING_REFUSED`. An admin alone cannot rebind once the source generation is above 0, including when the new native tuple has no history. The first provision of a source still allows an admin.

## Two origins

The OAuth client origin is the Meta browser origin that receives the callback. The PLM connection origin is the native installation base (`nativeBaseUrl`). They are different hosts in a real deployment.

- Link `client_origin` stores the OAuth origin. Exchange and status must return that same `client_origin` and the same `root_part_id` before a local session is created.
- The source fingerprint and binding `frozen_origin` store the PLM connection origin, which must equal the registered native base origin. The fingerprint also includes the source's persistent `tenant_id`, `workspace_id`, and `scope_kind`. A same-owner move of any of those, or a changed PLM origin, fails closed. A mutable `data_sources` config flag is not authority.

## Browser protocol

Meta stores a hashed browser nonce and state, an S256 PKCE challenge, and the exact return path, source, root, and installation scope. Intent cookies are HttpOnly, SameSite=Lax, and Secure only when the registered callback is https. The intent lives at most 300 seconds. The callback is fixed. The return path is `/plm/bom-review`.

The browser is sent to the native first-party `GET /managed-login` with public fields only. Native Continue performs the same-origin authorize. Meta does not emulate that step with a cross-origin POST, an automatic GET issuance, an iframe, or a token bridge.

The callback requires the current matching browser intent before the backchannel exchange. The intent is one-use. Before that exchange, the callback checks both an Authorization bearer and the current managed session cookie. A different Meta person consumes the intent and receives `409 PLM_MANAGED_PERSON_CONFLICT` as JSON. The response does not exchange, does not set a session cookie, and does not clear the existing managed session cookie. An invalid or expired cookie does not block the callback. The same person with the same tenant still completes. When an ordinary bearer and a managed cookie are both present and their tenants differ, the request does not attach that managed session. Link generation, owner, and identity are checked again after the exchange and before the local commit. A lost exchange response does not create a second session. A local commit failure discards the observed native delegation and records a revoke intent. A successful native revoke after a failed local commit stores the delegation on the consumed intent so the in-flight marker clears. A failed revoke stays on the outbox.

The native `yur_` credential and the PKCE verifier are not placed in a URL, `localStorage`, or a frontend payload.

## Managed session

The managed JWT purpose is handled before the AuthService trusted-user shortcut. Verification requires a persisted active user, canonical membership of both the Meta tenant and the Meta org, and a session row, an exact expiry of at most 600 seconds, the native binding and status, and the source generation. Sessions are inserted once. Persisted revocation is monotonic. Managed refresh, session-org reissuance, and `POST /api/auth/password/change` return `403 MANAGED_SESSION_REISSUE_REJECTED`. The password route refuses before it hashes a new password, updates `users`, or inserts an ordinary `user_sessions` row. A normal must-change token still uses that first-login route. Ordinary legacy JWT expiry is unchanged. Local role checks remain Meta's own permissions.

## Transport

The native read credential is encrypted on the server and used for `GET /api/v1/bom/multitable/{part_id}/managed-context`. A managed binding blocks legacy query, preview, select, schema, tables, connect, test, cache, adapter, facade, embed, workbench, and plugin entry for that source before any shared credential or cached payload is used. On `PLMAdapter` the same check runs inside the inherited read, write, download, schema, and `tableExists` methods, and before a mock or cached public payload. An already connected shared client is not reused after the source is bound. The check does not depend on the feature flag. Personal approval and personal BOM write keep their own grant transport. Source class comes from the persisted binding row. `unbound` is only a successful query that returns no row, and that is the legacy path. Missing schema and database outage refuse shared transport whether `PLM_MANAGED_COMPANION_ENABLED` is `true`, `false`, or unset. A missing `DATABASE_URL` is the same refusal: it does not prove the source was never managed-bound, and it does not open a pool. A disabled flag still blocks managed login and managed read. It does not reopen shared credentials. A provider failure, a missing credential, or a changed source fails closed.

Personal write still uses the persisted source origin and the separate `yuw_` grant. The write adapter cache is not the authority for that call.

## Unlink

Local block commits first: the link becomes terminal, the binding is blocked, sessions are revoked, and pending intents are revoked. An immutable native-revoke outbox row freezes the client, delegation, link generation, retry identity, and originating intent. A consumed intent that still has no delegation id stays unresolved after its browser `expires_at`. Unlink, source retry, and `GET /session` report `pending` until an observed native acknowledgement or a definitive cancellation. Browser expiry, the 8 second client fetch abort, and `consumed_at` plus any finite padding are not that cancellation: the native exchange locks the parent and only then samples time, so a code accepted inside its 120 second lifetime can still mint a credential that lasts the 600 second read grant. An acknowledgement stamps only the intent id stored on that outbox row. A consumed intent that never observed a delegation, including a person-conflict consume, remains pending. A pending intent cancelled before exchange, with no session and no in-flight consumed intent, still acknowledges with no outbox row. The API reports `pending` until native ACK. A retry locks the link and then the outbox row, rechecks the registration, and cannot target another generation. `{ outboxId }` still retries one row. `{ dataSourceId }` retries every pending row for that source for the owner or an admin, without returning outbox ids, delegation ids, or credentials. If an in-flight consumed intent remains, that retry stays `pending`. Registration drift stays `pending` with `last_error` `registration_mismatch` and does not call native revoke. A late callback cannot revive an unlinked source or session. Logout of the current managed session does not revoke unrelated browser parents.

## Out of this slice

No third approval engine. No production enablement, deploy, merge, or external notification. No refresh of the managed session. Installed topology and entire-window acceptance remain later C3 work.


## Slice boundary after independent verification

B2 binds an existing authenticated Meta owner to a separately verified native person and source, and consumes a dedicated native read grant. It is not the Yuantus-only entry bootstrap; that remains a separate B2b slice. Unresolved consumed exchanges cannot be declared cleaned up from browser expiry or a local HTTP abort. They remain pending until an exact observed native delegation acknowledgement; outbox rows carry the originating intent id. The verification MD and compact artifact record local415-unit/27-PG and real paired-process controls. Dedicated exact-head PG16 CI, full app bootstrap, and installed customer topology remain pending.


The B2 source slice at `28d2125719895310d8289bb685a36fe96d8ccfa0` has all31 reported exact-head checks green, including actual managed27-case PostgreSQL16, listener132-case PostgreSQL16 and visual14-case PostgreSQL16 runs. See `artifacts/plm-managed-companion-consumer-20261018/ci-final-source.json`. This closes the existing-Meta-owner consumer slice only; the full-SPA/Yuantus-only entry remains B2b, with installed lifecycle work later. Draft status remains.
