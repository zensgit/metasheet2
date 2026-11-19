# B2 administrator grant proof — local implementation contract

2026-11-18. Scope: the authorized complete local B2 candidate. This contract incorporates the independent design review of the administrator proof, current receiving reader, owned attempt connection, and strict grant composition. It permits the bounded local implementation below. It does not enable production, change any global prerequisite, authorize real data/provider calls, or declare B2 accepted.

## Boundary and owners

- One new purpose: `admin_login_grant_enable`; method and assurance are exactly `local_password`. The existing four-purpose parser, methods, default-unavailable behavior and old issue/consume bodies remain unchanged.
- V1 actor authority is actual current platform admin plus active membership in the selected integration organization. High actors are eligible; every target must be standard with empty reasons and distinct from the actor. Token claims or a privilege class alone are not authority.
- The frozen intent codec is the sole schema, normalization, encoding and digest. Opaque strings and application revision remain lossless. No 100-target, 256KiB, guessed identifier length or other new domain cap. Nonempty complete target sets, existing planner representability and native storage limits remain. HTTP parser bounds are transport only.
- `admin-grant-browser-context.ts` owns actor browser bindings and their genuine context; `admin-grant-local-credential.ts` owns eligible credential establishment. `admin-grant-proof-storage.ts` alone writes the new proof header/children/seal; `admin-grant-proof.ts` alone issues/consumes this proof. The real router factory is unmounted.
- T2 alone produces current-application target evidence. T4 alone owns `executeAdminLoginGrantEnable`, strict grants, command receipts, terminal revoke, strict login and required transactional command audit. No raw-fields alternate grant writer.
- Main owns shared auth-route integration, the assertion alias, registries, CI and shared client options. Existing proof/attempt product files stay frozen until the current WP-C qualification is explicitly released; new isolated files may be implemented independently.

## Genuine session, browser and current authority

The only session constructor is existing `readAuthenticatedSessionContext`. Export its existing private assertion as `assertAuthenticatedSessionContext`; its body/WeakSet stay unchanged. It checks instance provenance only and performs no live-state SQL. Capture closed input values before awaits; never trust structural contexts, accessors or reflection exceptions.

Browser establishment uses a canonical configured HTTPS origin matching request Origin, never Host/body/CORS. It requires the genuine context and native current user/sid, then user lock → watermark → session SHARE. Ensure a nonrevoking epoch watermark by INSERT ON CONFLICT DO NOTHING and locked reread; never overwrite a real watermark. Missing/partial schema or malformed rows refuse, without legacy missing-schema fallback. Token iat must exceed the actual monotonic watermark; native session must exist, match user/sid, be unrevoked and unexpired by DB clock.

Create one immutable binding per sid with server-generated 32-byte nonce, storing only its domain-separated digest, actor/org/origin, DB establishment time and original session expiry. Only terminal revocation is allowed; UPDATE of other fields, DELETE and TRUNCATE refuse. Do not add current user/session FKs that obstruct purge. Require current rows on use.

Set `__Host-meta-agp` only after confirmed commit: HttpOnly, Secure, SameSite=Strict, Path=/, no Domain. Existing sid binding requires its existing matching cookie; lost response does not permit reset. A new genuine sid is recovery. Cookie secret is never JSON/URL/log data. Factory context registration binds the configured origin; copied or cross-origin contexts refuse.

The bearer iat is named `token_issued_at`; it is distinct from native session issued_at. Issue/consume retain exact bearer iat and current watermark witness; a changed bearer iat on the same sid requires a new proof. Browser and proof expiry never extend on same-sid refresh. Historical receipt readback may use a newly authenticated same actor with a current valid browser context.

## Eligible local credential producer

Add nullable users.local_credential_version UUID without backfill. A native trigger generates a fresh server UUID on INSERT and actual password_hash/local_password_set/must_change_password change; otherwise retain OLD exactly, including NULL. Caller-supplied/reset/replayed version is never authoritative. Unrelated user writes and access_generation are unchanged.

Append-only user_local_credential_establishments stores server ID, historical user id/version, kind=self_password_change, source sid and DB timestamp; unique(user,version). Its INSERT validates the exact current version and ready flags. UPDATE/DELETE/TRUNCATE refuse. Historical IDs have no cascading current-user/session FK. This database consistency check is not proof of a human action; the closed actual producer supplies provenance.

Integrate only the existing required-password-change route, preserving current validation, real bcrypt, response and fenced post-commit session issue. The new helper accepts genuine context and the already validated/hash-produced new credential. Its contract is current must-change eligibility plus native live session under the locked transaction, not a fictitious pre-hash CAS. Fully absent new schema uses the original branch and remains proof-ineligible; partial/malformed schema or runtime failure refuses, with no fallback after writes.

Installed branch is one RC transaction: user FOR UPDATE → ensure/lock watermark → session SHARE → recheck current required-change/account/session → update credential and capture new UUID → insert genuine establishment → monotonically advance watermark → commit. A post-commit session-response failure is committed password change, not rollback. Same-second JWT/watermark rules are not weakened. No new endpoint, admin-reset/invite/registration provenance, historical conversion or automatic activation.

Issue and consume require exact current UUID/establishment, ready flags and existing credential witness. Hash/flag A→B→A, reused user id, arbitrary establishment or changed version cannot retain old authority. The two existing production watermark upserts in session-revocation and identity-repair use GREATEST(existing,proposed); preserve all metadata and other effects. Qualify each actual queued-writer race independently.

## Immutable proof storage

New migrations only: actor inputs `zzzz20261118090000_admin_grant_actor_inputs.ts`, proof sets `zzzz20261118100000_admin_grant_proof_sets.ts`, after confirming unique filenames. Published migrations stay unchanged. No extension install or historical backfill.

Extend challenge purpose/kind pairing only for new purpose/confirmed_identity_set. Preserve old purposes and failed-row shape, TTL maximum300, actor-wide failure budget and issued uniqueness. New-purpose nonfailed rows require local_password, browser digest, actor/org/connection and NULL old singleton identity/revision. Failed rows have zero children/seal and retain original NULL assurance/proof/browser/expiry shape. Avoid SQL NULL CHECK loopholes.

Children contain challenge, positive ordinal, unique user, exact identity/binding/evidence/access-generation/privilege pins. Seal contains exact canonical intent, original command id, application revision text, positive target count, browser binding, credential establishment/version, watermark microseconds, token iat and captured session expiry. Omit redundant authority_witness digest; actual S0/membership rereads plus existing exact fields supply authority.

Assembly on one tx: issued parent → sorted children → seal last. Child INSERT locks parent, requires issued new purpose, no seal and target != actor. Seal INSERT locks parent and requires exact complete children. Parent/children/seal immutable history cannot be reset, deleted or truncated. Adding FKs/retention guards can restrict table-wide TRUNCATE; do not promise old DDL behavior is byte-identical.

Deferred constraints inspect FINAL stored state at COMMIT, not an earlier NEW image. Require complete ordinal/count/unique targets and exact JSON keys/types/values against header/seal/children, plus native pg_catalog.sha256(convert_to(domain || canonical_text,'UTF8')) digest (qualify exact built-in form during implementation). No pgcrypto install. Database need not reproduce JavaScript sorting/escaping: consume parses known encoded targetCount, checks it, normalizes via frozen codec and requires exact re-encoded bytes. Duplicate/extra keys and noncanonical text cannot become usable.

Proof syntax is exact agp1.UUID.32-byte-base64url-secret; store a domain-separated SHA256 secret digest and compare canonical equal-length bytes in constant time. Action reference is agc: plus command-key hex, never raw opaque command id. Expiry uses DB time, <=created_at+300 and captured browser/session expiry, never renewed by retry.

Down proves caller-owned RC before bounded locks, refuses all retained new history and drops only new objects/constraints in dependency order. No CASCADE or cleanup of evidence. T4 dependencies roll down first.

Operational rollback for the actor-input migration: a new user or a change to credential fields can populate `users.local_credential_version` as soon as the migration runs, even with strict login disabled. A retained version, browser binding or establishment blocks schema rollback with `ADMIN_GRANT_ACTOR_INPUTS_DOWN_BLOCKED`. Roll back the application while retaining the schema and its history. An empty installation supports transactional down after dependents are removed.

## Owned comparison and exact roots

Expose data-only issue, prepareConsume, consumeOnTx and assertConsumedOnTx. No public positive resolver/comparator/query callback/availability=true/context constructor. New local factories are executable with real bcrypt/schema/AIS/receiver; production remains unmounted and unavailable before IO.

Discover exact registered actor+target plan with singleton source identityRead. Each real root awaits plan revalidation and actual requireIdentityRead, then uses genuine T1 receiver/full actor and target witnesses. Hold positive active user_orgs FOR SHARE in sorted user order after kernel R5 before R6. No member repair. Full order: R0/R2/source freeze/all role/R3/R5 → memberships → canonical R6 integration/application/capability/identity/binding/evidence → sorted watermarks → sorted sessions → browser/proof. No late lower-rank lock or SHARE upgrade.

Add one closed admin_grant_issue variant to the owned attempt only after main releases its freeze. For TX1 and correct-password TX2 call actual withAuthorizationInputTransaction OUTSIDE runStep, passing its existing transaction runner port that delegates the handler into the same owned runStep/scoped query/raw client. BEGIN remains runStep-owned; SET RC is first callback query. Preserve full ok/error/rollbackAcked before AIS error mapping; pre-run refusal is no transaction and lost COMMIT acknowledgment stays unknown. No second checkout, nested root, directory takeover or replay.

TX1 captures owned values, not a reusable token. Commit, compare real bcrypt exactly once with no transaction open, retain same physical sid/latch owner. Correct-password TX2 uses a new genuine root and compares all retained inputs; under actor R5 reread common budget, supersede same-sid new-purpose issued proof, then issue sealed set atomically. Do not take old actor advisory after R5.

Wrong-password TX2 uses existing advisory → actor KEY SHARE → common failure count → failed new-purpose parent from the valid first snapshot. Later target drift does not erase a failed comparison. Five failures in900seconds are actor-wide across old/new purposes/sids; a fifth existing failure means rate limit, not a sixth row. Actor R5 conflicts with old KEY SHARE, supplying cross-purpose serialization. Preserve epoch drain, quiescence, loss/discard, exact-token cleanup and uncertainty behavior. Any optional attempt audit happens only after disposal; it is not command audit.

## Same-transaction T4 command and receipt

T4 owns actual full-root executeAdminLoginGrantEnable and actor-only historical readback. T3 prepared/consumed results have private runtime brands bound to exact open tx, context, intent, registered plan and genuine receiving result; no copied/closed/cross-tx substitute. Fresh consume checks secret, status/expiry, full canonical set, current S0/member/session/browser/credential/actor/target witnesses, then consumes. T4 asserts before every grant.

Choose one exact sequence: consume proof → INSERT immutable command receipt → INSERT all per-target grants → required caller-tx audit → COMMIT. Receipt-first permits ordinary grant→receipt FK; deferred completeness still checks full final bundle. Do not keep a competing grants-first/deferred-FK implementation.

Receipt key SHA256 binds purpose, actor, org and original opaque command id; store originals/full intent/digest/proof/count/result. Per-target grant uniqueness is command key+ordinal/target, not command_id UNIQUE. Deferred completion ties consumed action reference/receipt to the original complete historical target/pin set, without requiring grants to stay enabled forever. Nth grant/audit/deferred failure rolls back everything and preserves original proof expiry. No per-target savepoint continuation.

Authorized actor-only readback precedes fresh target/proof rejection, remains usable after target delete/proof expiry/grant revoke, and reports historical commit only. Require current same actor S0/org/session/browser and exact original intent. After uncertain result allow at most read-only reconciliation; no blind mutation, compare or provider replay. Changed intent under same command is conflict.

Grant-only: no activation, membership restoration, generation advance or deprovision supersede. Fresh T2 evidence is needed for new issue/consume/grant; original fresh_until alone does not expire ongoing login. Renewed evidence requires explicit accepted old-grant revoke before replacement. Container adapter uses exact stored-app own unionId to unique prior web-proven full slot, retaining corp:openId.

## Required local evidence

Main executes only owned synthetic PG, serial heavy work, with fixed source pins and no skipped positives. Required whole files plus unchanged neighbors, targeted types, caller/writer/mount guards, meaningful guard mutations and exact-byte restoration are distinct from CI/provider/browser/deployment acceptance.

- Real password route/helper → new genuine session → real server browser cookie → bcrypt issue → actual T4 multi-target consume/grants/receipt/audit, with high actor/standard targets. Include101 targets and >256KiB canonical command within real transport bounds.
- Native same PID both roots/no TX during compare/first RC, all prior WP-C cases and new-branch loss, rollback, deferred COMMIT and ACK uncertainty. Six cross-purpose attempts on three sids produce exactlyfive failures andone rate limit; both lock orders observed.
- Monotone queued watermark, baseline-versus-revoke, exact session/browser/iat/origin/expiry/provenance drift; partial schema and copied brands refuse. Actual credential producer, stamp ABA/spoof/reuse, unrelated updates and rollback.
- Native seal completeness/immutability/NULL/canonical/digest/retained-history down, genuine nonvacuous Nth-grant/audit/deferred rollback, same-command concurrency and historical receipt after deletes/revokes/expiry.
- Full actor/target witnesses, mixed high targets, membership/source/application/identity/evidence changes, no out-of-scope source effects. Production mounting/default gates remain false. Whole B2 additionally requires actual local web/container route/browser integration, separately from real provider acceptance.
