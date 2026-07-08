# Switching a Customer's DingTalk Organization — Assessment and Migration Model

- Date: 2026-07-08
- Scope: what the DingTalk directory-sync integration does when a customer moves from one DingTalk organization (corp) to a different one, and what a supported "switch org" flow would require.
- Status: **assessment / design starting point. No code changed by this document.** Every load-bearing claim is anchored to a file:line on `origin/main` at the time of writing.
- Baseline: `origin/main` @ `d1180d8a2`.

---

## 1. Question and verdict

*Does the product support a customer switching their DingTalk organization — moving the tenant from corp A to a different corp B (new `corpId`, an entirely new directory: new userids, unionIds, openIds)?*

**Not as a first-class feature.** There is no "switch org / migrate corp / re-bind" flow, script, or button. Two mechanical paths exist, and one of them is actively destructive. But the **right model — retire the old binding, then re-bind users onto the new org — is already implemented at the per-user level**; what is missing is org-level orchestration, not the underlying capability.

The rest of this document establishes the mental model that makes the answer make sense (§2), records what the product actually allows today (§3), explains why the obvious path is a trap (§4), and lays out the model to build on instead (§5–§7).

---

## 2. The mental model: there are two binding layers

Everything about a corp switch turns on one fact that is not obvious from the UI: a DingTalk user is bound to a local user through **two independent layers**, and a migration has to deal with both.

| Layer | Table | What it drives | How it is keyed |
|---|---|---|---|
| **Directory link** | `directory_account_links` | directory sync, approval routing, work-notification recipients | maps a `directory_account` → `local_user_id` |
| **Login identity** | `user_external_identities` | DingTalk container login / OAuth (免登) | `external_key`, which is **corp-scoped**: built from `corp_id` + `open_id`/`union_id` |

The login identity is genuinely corp-scoped: it is written on OAuth login with `ON CONFLICT (provider, external_key)` (`packages/core-backend/src/auth/dingtalk-oauth.ts:486`), it stores `corp_id` (`:477`, `:490`), and the login lookup **requires the corp to match** — `WHERE identity.external_key = $2 ... AND identity.corp_id = $5` (`dingtalk-oauth.ts:529,539`). If it does not match, an unprovisioned login returns `403 unlinked_local_user` (`dingtalk-oauth.ts:694`).

**The local user is the stable anchor.** It carries the person's permissions, history, and record ownership, and it does *not* depend on the corp. A corp switch should preserve the local user and rewire only the two DingTalk-side layers above it. That is the whole design.

---

## 3. What the product allows today

- **`corp_id` is editable in place.** `updateDirectoryIntegration` runs `UPDATE directory_integrations SET ... corp_id = $4` (`packages/core-backend/src/directory/directory-sync.ts:1596`). An operator can overwrite Corp ID / AppKey / AppSecret on an existing integration.
- **`corp_id` is not unique.** The only unique key on `directory_integrations` is `(org_id, provider, name)` (`packages/core-backend/src/db/migrations/zzzz20260324150000_create_directory_sync_tables.ts:35`). Multiple integrations may share a corp, and a second integration for corp B is allowed as long as its `name` differs.
- **There is no delete-integration path.** No route, service, or SQL deletes a `directory_integrations` row (grep of `src` for `DELETE FROM directory_integrations` / `deleteDirectoryIntegration` / `router.delete(... integrations)` is empty). The `ON DELETE CASCADE` on the child tables is schema-only and never exercised by the app.
- **Per-user unbind and bind exist**, and the unbind clears *both* layers (see §5).

So the CRUD surface permits both "edit corp in place" and "create a new integration for B", but offers no way to retire the old one and no orchestration for moving users across.

---

## 4. The trap: editing `corp_id` in place

The tempting path — open the existing integration, change Corp ID and credentials, save — is the destructive one.

On the very next sync, the directory of corp A is entirely absent from the fetch, and the `last_seen_at` sweep deactivates every account and department that did not appear:

```
UPDATE directory_accounts SET is_active = false, updated_at = NOW()
 WHERE integration_id = $1 AND last_seen_at < $2
```
(`directory-sync.ts:2275–2276`, and the departments equivalent at `:2281–2282`.)

There is **no empty-fetch or mass-departure guard on this sweep on `origin/main`** — it runs unconditionally. So a bare corp swap silently marks the entire old organization inactive in one run, turning every previously-linked person into a manual review item.

What it does *not* do on `origin/main`: it does not deactivate the local `users` rows and does not revoke logins by itself, because the offboarding policy (`default_deprovision_policy`) is stored but not enforced. (Enforcement, and a circuit breaker that would abort exactly this mass-departure, is being added under the DT-OPS-01 hardening line and is not yet on `main` — see §9.)

Regardless, the login identities still break: they are corp-A-scoped, so after the swap every returning user fails the `corp_id = $5` lookup and either 403s or — if auto-provision is enabled — is minted as a **duplicate** local user. This is why the in-place swap is the wrong tool.

---

## 5. The right model: unbind, then re-bind — and the primitives already exist

The sound migration is the one where the **local user stays put and its DingTalk-side identity is retired from corp A and re-established against corp B.** This is precisely what the existing per-user primitives already do.

`unbindDirectoryAccount` (`directory-sync.ts:4009`) clears **both** layers in a single transaction:
- it deletes the corp-scoped login identity — `DELETE FROM user_external_identities WHERE ...` keyed by `buildDingTalkIdentityExternalKey(corp_id, open_id, union_id)` (`directory-sync.ts:4056`);
- it resets the `directory_account_links` row back to unlinked;
- and, optionally, it disables the DingTalk login grant (`disableDingTalkGrant`).

`bindDirectoryAccount` (`directory-sync.ts:3836`) re-establishes the **directory link** for a chosen local user. Note the asymmetry that shapes the flow: **`bindDirectoryAccount` writes only `directory_account_links`; it does not write `user_external_identities`** (that table appears zero times in the bind body). The login identity for corp B is therefore re-created when the user next completes DingTalk login under corp B (`dingtalk-oauth.ts:457–490`), not by the bind call.

Both have batch wrappers already: `batchUnbindDirectoryAccounts` (`directory-sync.ts:3082`) and `batchBindDirectoryAccounts` (`:3096`).

In other words: **"先解绑，再让用户绑上去" is not just the right instinct — it is the model the per-user code already implements.** The gap is org-level orchestration, not primitive capability.

---

## 6. Migration procedure (built on today's primitives)

A migration can be run today with the existing primitives, in this order, and it avoids the §4 trap by never re-pointing corp A's integration:

1. **Stand up corp B alongside corp A.** Create a *new* integration for corp B (different `name`) and run a **preview** first, then a sync. B's accounts land as `pending` links, not `linked` (`directory-sync.ts:2373`) — nothing is auto-attached to a local user yet.
2. **Reconcile A → B by email / mobile.** New corp = new userids/unionids/openids, so identity can only carry over by unique email or unique mobile. Matches that are unique become bind candidates; missing or ambiguous ones need a human decision.
3. **Per user: unbind from A, bind to B.** `unbindDirectoryAccount` on the corp-A account clears both layers; `bindDirectoryAccount` attaches the local user to the corp-B account. The local user, its permissions and history are untouched.
4. **Users re-login under corp B.** This re-creates the corp-B login identity (`user_external_identities`, `corp_id = B`). Until a user does this, their directory link works (sync, routing, notifications) but 免登 does not.
5. **Retire corp A.** Today the best available action is to disable the old integration (status / `sync_enabled`); there is no delete path (§3), so its stale accounts linger.

In-flight approvals are safe throughout: `ApprovalDirectoryOrg` bakes `managerId` / `deptHeadId` into the instance at create time and does not re-resolve (`packages/core-backend/src/services/ApprovalDirectoryOrg.ts:11,21`). Only *newly started* approvals re-derive from `directory_account_links (link_status = 'linked')` (`ApprovalDirectoryOrg.ts:37`), so their routing follows corp B as soon as step 3 relinks each user.

---

## 7. What a supported "switch org" feature would add

The procedure above is manual and loops per user. A first-class feature is the orchestration around the existing primitives:

- **An explicit migration flow** (not a bare `corp_id` field edit), with the destructive in-place swap disabled or gated for a live tenant.
- **An A → B reconciliation surface**: promote the email/mobile match into an operator-reviewed mapping table, so the per-user unbind→bind is confirmed in bulk rather than one account at a time.
- **A deactivation-sweep suppression (or empty-fetch/mass-departure circuit breaker)** for the migration window, so the old directory is never mass-deactivated by accident (§4, §9).
- **A decision on the login-identity layer**: today it re-establishes only when each user re-logs in. A migration could optionally carry it over at bind time (rewriting `user_external_identities.corp_id` + `external_key`) so users are not briefly locked out of 免登.
- **A retire/delete-integration path** for corp A, plus updating the `DINGTALK_ALLOWED_CORP_IDS` allowlist if it is in use.

---

## 8. Optional guardrail: user-confirmed unbind (random verification code)

Unbind is destructive — it removes the login identity and the directory link, and can revoke the login grant (§5). A step that requires the **affected user** to approve the unbind with a short-lived random code turns a silent admin action into an auditable, consented one. It is buildable by composing patterns the codebase already has.

**Reusable primitives.**
- Code delivery via DingTalk, with a verifiable token and a delivery-ledger row, already exists for approval cards: `insertDingTalkApprovalCardDelivery` (`packages/core-backend/src/integrations/dingtalk/approval-card-deliveries.ts:61`) + an HMAC token (`automation-executor.ts:2635`) + a deep link (`:2636`). A confirm-unbind code is the same shape.
- Short-lived, one-time-use, TTL semantics already exist in the OAuth state store (`packages/core-backend/src/auth/dingtalk-oauth.ts`, DT-OPS-05).
- The seam is the existing unbind route, today a single admin POST: `POST /accounts/:accountId/unbind` (`packages/core-backend/src/routes/admin-directory.ts:656`). A confirmation gate splits it into *request* → *confirm*.

**The one decision that drives the design — and it ties back to this whole thread.** A per-user code is a *per-user, user-present* mechanism, but an org switch is inherently *bulk*. So:
- For an **individual** unbind (a person leaving, an admin correcting a mis-bind, a self-service re-bind), a confirmation code fits perfectly and is worth building.
- For a **bulk org migration** — the `POST /accounts/batch-unbind` path (`admin-directory.ts:695`), hundreds of users — a hard per-user code gate would stall the migration on user availability. There, the right consent model is notify-and-window (announce, allow an objection period, then proceed) or an operator-confirmed batch, not a code per person.

So the feature should be **an opt-in gate on individual unbind, not a hard gate on the batch path.**

**Recommended shape (individual; strongest value = auditable consent).**
1. Admin — or the user — requests unbind of account X for local user U.
2. Generate a random code; store a short-TTL, one-time pending-unbind record `{accountId, localUserId, codeHash, expiresAt, requestedBy}`.
3. Deliver the code to U over a channel U controls **and that is still valid before the unbind** — the user's current DingTalk work notification (the identity is intact until the unbind completes), with email as a corp-independent fallback.
4. U confirms with the code within the TTL → `unbindDirectoryAccount` executes. Wrong or expired → refused. Both the delivery and the verification are audited.

**Channel note for the org-switch case.** During a migration the corp being retired *is* the DingTalk channel — but the corp-A identity is still valid until the unbind, so the code can be delivered there (or by email). It cannot be delivered to corp B, whose binding does not exist yet (chicken-and-egg).

This is a new capability line: it needs a small design lock and explicit sign-off before implementation. It is recorded here as an option, not a commitment.

---

## 9. Open uncertainties — verify in staging before relying

- **Two-corp coexistence and the `external_key` collision.** The investigation surfaced a genuine conflict about whether a directory account's stored `external_key` is corp-independent (`unionId || openId || userId`) or corp-scoped. If it is corp-independent, the same natural person present in both corp A and corp B simultaneously could collide on `UNIQUE(provider, external_key)` (`migration:98`) and abort the sync transaction. This was not pinned down in a single verification pass and **must be tested on staging** before choosing a "keep A while standing up B" coexistence window.
- **Member-group and department residue.** Retiring corp A by disabling its integration leaves its projected member groups, role grants, and departments in place; the cleanup semantics were assessed as *likely* but not proven.

---

## 10. Relationship to the in-flight hardening line

Two items on the current DingTalk hardening line bear directly on this scenario:

- **DT-OPS-01 (offboarding executor + circuit breaker).** The mass-departure of corp A's accounts is exactly the shape the breaker guards: a batch above `DIRECTORY_DEPROVISION_MAX_BATCH` aborts rather than acting. If the deprovision policy is ever enabled, that breaker is what stops a corp switch from cascading into a mass login revocation. It is default-off and not yet merged; on `origin/main` today the offboarding policy is stored but not enforced, so a bare corp swap does not auto-lock local users — it only strands them.
- **DT-OPS-04 (per-integration notification credentials).** Work notifications now resolve credentials from the recipient's own integration rather than "latest active", which is what keeps notifications correct while two integrations coexist during a migration window.

Neither makes "switch org" a feature; both reduce the blast radius of doing it manually.

---

## 11. Generalizing: an org transfer is a reconciliation over corp-scoped bindings

§5–§8 handle the *user* layer. But a tenant couples to DingTalk in more places than user identity, and a real "transfer org" flow has to walk all of them. The right shape is a **first-class, resumable reconciliation**: enumerate every corp-scoped binding and, for each, present the customer with a three-way choice — **re-bind** (to a resolved corp-B target), **drop** (leave unbound — disable, not delete), or **needs-attention** (cannot be auto-resolved).

The unifying principle is the same as §2: **the system-side entity is the anchor; only the DingTalk-side handle is rewired.** A form, an automation rule, a local user, an approval template all survive the transfer untouched; what moves or drops is the DingTalk handle beneath them.

### 11.1 The catalog of corp-scoped bindings

| Binding | Where it lives | Corp-scoped? | Auto-resolvable to corp B? | Transfer decision |
|---|---|---|---|---|
| **User identity** | `directory_account_links` + `user_external_identities` | login identity is corp-scoped (§2) | by unique email / mobile (propose → confirm) | re-bind (optionally §8 code) / drop |
| **Form → DingTalk group** | automation rule `destinationId` → `dingtalk_group_destinations` (`webhook_url`, `secret`) | the webhook points at a specific group in a specific corp | **No** — a webhook has no cross-org identity | customer pastes the new group's webhook/secret (re-bind) or disables it (drop) |
| **Work-notification credentials** | `directory_integrations.config` (appKey/secret/agentId) | yes | supply corp-B creds once | re-bind (new creds) / drop |
| **Approval-card config** | `directory_integrations.config` (approval-card) | yes | re-configure for corp B | re-bind / drop |
| **Member-group / department projections** | projected from `directory_departments` | yes | re-project from corp B | re-project / drop |

The **form → group row is the sharp case, and it is why per-item customer confirmation is not optional but necessary.** `dingtalk_group_destinations` is just `{ webhook_url, secret, enabled }` keyed by `created_by` (`packages/core-backend/src/db/migrations/zzzz20260419183000_create_dingtalk_group_destinations.ts:6–18`) — it has no `corp_id` / `integration_id` and no cross-org identity. Unlike a user (which email/mobile can auto-propose), a group binding cannot be auto-matched to corp B at all: the customer must either paste the new corp-B group's webhook (re-bind) or turn it off (drop). The automation rule keeps its `destinationId` either way (`packages/core-backend/src/multitable/automation-actions.ts:113`), so "drop" disables the destination without touching the form.

### 11.2 The transfer as a first-class object

A transfer should be a resumable record, not a one-shot script — a customer decides over days, across possibly hundreds of items:

- `corp_transfer { id, org_id, from_corp, to_corp, status, ... }`
- a worklist of `binding_decision { transfer_id, kind, source_handle, proposed_target, decision: pending|rebind|drop|blocked, applied_at, decided_by }`

Phases, resolving the chicken-and-egg (corp B must exist before targets can be resolved):
1. Stand up the corp-B integration + credentials — a *new* integration (§3), not an in-place swap.
2. **Freeze corp A** for the window (disable its sync) so the `last_seen_at` sweep (§4) never mass-deactivates it mid-transfer.
3. Build the worklist by scanning the catalog (§11.1).
4. Customer decides each item — re-bind / drop / flag — with the per-resource confirm from §8 for user items.
5. Apply each item independently and idempotently, audited.
6. Retire corp A (today: disable; a delete path is a §7 gap).

### 11.3 Recommendation

This is a coherent and worthwhile line, but it is a **substantial new subsystem**, and its hard parts are product decisions, not code: what "re-bind" means per resource type, what the safe default is, and who confirms what. The recommended safe default is that **every item defaults to *drop = disable*, never delete**, so the anchor entity (the form, the user, the template) is never lost and a wrong decision is reversible. The right next step is to **ratify this catalog and the per-item decision semantics as a design lock before any implementation**, then build incrementally — starting with the two highest-value resource types, users and form → group destinations, which between them cover most of what a customer actually feels. This document is that design lock's starting point; it commits no code.

---

## 12. Provider-agnostic by construction: DingTalk is the first provider, not the only one

The transfer model in §11 must not be hardcoded to DingTalk — and, encouragingly, the substrate is already built for that. `provider` is a first-class column on every identity/directory table, and it is part of the uniqueness that matters (verified on the live schema):

- `directory_integrations`, `directory_accounts`, `user_external_identities`, and `user_external_auth_grants` each carry a `provider` column.
- Identity uniqueness is provider-keyed: `UNIQUE(provider, external_key)` and `UNIQUE(local_user_id, provider)` on `user_external_identities`, and `UNIQUE(provider, external_key)` on `directory_accounts`.

The consequence is significant: **a local user may hold exactly one identity per provider, simultaneously.** A WeCom identity and a DingTalk identity coexist on the same person by construction — nothing in the schema is DingTalk-exclusive. So the reconciliation catalog (§11.1) is provider-generic almost for free: key every binding on `(provider, …)`, and the re-bind / drop decision stays uniform across providers.

### 12.1 What to abstract (a thin driver), not rewrite

Only the provider-specific *behaviour* needs an interface — the engine stays generic. A **directory-provider driver** covers: list departments / users, resolve identity, OAuth / 免登 login, and send messages (notification / group / card). DingTalk is the first implementation (`packages/core-backend/src/integrations/dingtalk/`); further providers are new implementations behind the same interface. The sync and transfer engines call the interface, never a provider directly.

### 12.2 The one genuinely DingTalk-hardcoded resource

`dingtalk_group_destinations` is the exception: it has **no `provider` column** and is DingTalk-named (§11.1). When a second provider is added, generalize it to a provider-tagged group-destination table (add `provider`; the "form → group" binding concept is shared — only the webhook / send shape differs per provider). It is not worth renaming today with no second provider in play; recorded so it is not forgotten when one arrives.

### 12.3 Recommendation (and a caveat against over-building)

Make the transfer subsystem **provider-parametric**: it operates on the abstract `(provider, tenant, binding-kind)` model, so adding another provider is a driver plus (for groups) one column — never an engine change. But do not build a full provider plugin SPI before a second provider exists: keep the data model provider-tagged (already true), keep the transfer engine provider-generic, keep provider specifics behind a thin driver, and ship DingTalk as driver #1. The generalization is cheap precisely because the schema already treats `provider` as first-class — realize it when a second provider is actually demanded, not speculatively.
