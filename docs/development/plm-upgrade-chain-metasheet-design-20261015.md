# MetaSheet side of the Yuantus upgrade chain — design (2026-10-15)

Branch `cursor/plm-upgrade-chain-metasheet-316e`, stacked on the handoff branch `codex/plm-visual-consumer-20261015` at `a5977db1c2afb0106d87e60fe066cd4a3427dc4c` (PR #6424 → #6423 → #6418 → #6413 → `main` merge base `ad2246fecd7af5227f8f4a68ee5c8ba8512e212c`). Draft only. No merge, deployment, production enablement, real notification or data deletion is part of this work.

## Authority and inputs

- The first pass could not read `zensgit/yuantus-plm` (clone and API 404). The second pass read the eight documents from Yuantus branch `codex/plm-baseline-batch-20261015` that were supplied as uploads: `WINDOW_MASTER_GOAL_20261015.md` (authoritative scope), `WINDOW_GROK_HANDOFF_20261015.md`, `PLM_LISTENER_REVIEW_20261015.md`, `PLM_PERSONAL_APPROVAL_RECOVERY_20261015.md`, `PLM_METASHEET_APPROVAL_REUSE_REVIEW_20261015.md`, `PLM_VISUAL_PREVIEW_PROVIDER_RECOVERY_20261015.md`, `PLM_VISUAL_MARKUP_RECOVERY_20261015.md`, and `PLM_DATE_OBSOLETE_UNDO_RECOVERY_20261015.md`. The handoff also names `PLM_BASELINE_MEMBER_BATCH_20261015.md`; that file was not in the upload set and was not read. The master goal's three planning links (`PRODUCT_SKU_MATRIX.md`, `PLM_STANDALONE_METASHEET_BOUNDARY_STRATEGY_20260407.md`, `WORKFLOW_OWNERSHIP_RULES.md`) were also not in the set.
- `#6417` (BOM collaboration UI, `codex/plm-bom-ui-20261015` @ `2323b45`) is a sibling of `#6418` on top of `#6413`; it is **not** an ancestor of the handoff head, so its share/rule/listener editors are absent from this branch.

## Assumptions

1. Yuantus is the single authority for PLM objects, BOM write-back, ECO and release state, and for its own approval instances. MetaSheet keeps collaboration state (review rows, rounds, notifications) and never mirrors a Yuantus decision as its own authority.
2. The "advanced collaboration upgrade package" is licensed and switched on Yuantus' side. MetaSheet consumes that state deny-only: Yuantus' capability manifest and the `entitled` flag in share/context responses, plus the deployment flags the package sets for the companion service. MetaSheet stores no license of its own, so there is exactly one license authority.
3. "Disable and restore" means two levels. The first is the package or feature level: exact-`'true'` env flags, preserved data, and resumption from durable state. The second is the per-binding level: a creator disables one BOM review binding. Per-binding disable is terminal by an existing database guard. Restore at that level is an explicit new share or rebind by the source owner, never an implicit resurrection.
4. Embed tokens are minted by Yuantus with `tenant_id`, `org_id`, `part_id`, `feature_key`, `embed_origin` and `jti` (cross-language vector in `tests/unit/embed-token-verify.test.ts`), so requiring `org_id` does not reject a correctly minted token.

## Inventory: what MetaSheet already provides (handoff head)

| Piece | Existing implementation (evidence) | Status before this PR |
| --- | --- | --- |
| Identity binding | User submits a Yuantus-issued personal grant (`yua_…`) and Yuantus verifies it (`PlmPersonalApprovalBindingService.ts:174-228`). The grant is encrypted at rest. Scope is checked against the server-fixed connection and the effective tenant/org (`:106-120`). One subject per owner and connection (`zzzz20261015040000_create_plm_personal_approval_cards.ts:9`). Decisions use the person's Bearer with no service-account interceptor (`PLMAdapter.ts:2494-2511`). | Done (#6423) |
| Tenant/org isolation | BOM review changes must match the bound `source.tenant_id/org_id` (`plm-bom-review-service.ts:289-291`). Record ingress compares the canonical source (`plm-record-ingress-service.ts:54-62`). Personal approval requires the served org (`PlmPersonalApprovalBindingService.ts:117-118`). The embed relays checked only `tenant_id` (`routes/plm-embed.ts` and `routes/plm-embed-visual-preview.ts`, before this PR). | Gap: embed org |
| Licensing hooks | The capability manifest is advisory (`PLMAdapter.ts:712`, `isFeatureAvailable` `:752`). The write-back route denies when the feature is not entitled (`routes/plm-workbench.ts:1099-1113`). A share snapshot must be `entitled: true` (`plm-bom-review-wire.ts:67-71,132-137`). Entitlement never grants past ownership or object permission. | Done (deny-only) |
| Embedding in the Yuantus entry | The token is EdDSA with a kid allowlist and `aud`/`typ`/`exp`/`part_id` checks (`auth/embed-token-verify.ts:65-96`). The origin allowlist doubles as the frame-ancestors source (`auth/embed-config.ts`). A single-use jti is required (`auth/embed-jti-store.ts`). The postMessage nonce and origin are pinned (`apps/web/src/services/integration/plmEmbedWriteToken.ts`). | Done; org gap above |
| Controlled multi-dim write-back | The workbench PATCH requires a MetaSheet login and data-source ownership, an entitled `bom_multitable_writeback`, an Idempotency-Key, a four-field whitelist and If-Match pass-through. The ECO intent route shares the entitlement and ownership gates. This PR adds a MetaSheet audit attempt before the provider call and an outcome row after it (`routes/plm-workbench.ts`, `insertPlmWritebackAudit`). The Yuantus call still uses the deployment integration account (`PLMAdapter.ts:1137-1146,1192-1194`). | Audit done; writer identity still the integration account |
| Native approval (via Yuantus) | Personal source tasks and cards are recorded as immutable command intents. Receipts must name the bound subject (`PlmPersonalApprovalBindingService.ts:577-590`). Thresholds are Yuantus-side, counting distinct AUTH identities. | Done (#6423); legacy bridge conflict |
| Generic pre-review | The BOM review state machine is enforced in the database: 待评审→评审中→有问题/已完成, reopen starts a new round, issue owners and SLA start are frozen, and completion stops the clock (`zzzz20261014010000_add_plm_bom_review_states.ts:52-56,157-167`). Notification rules, frozen intents and completion webhooks run through `plm-bom-review-service.ts`. The MetaSheet approval engine already exists for sign-off reuse (`POST /api/approvals`, `routes/approvals.ts:3050`). | Done for row grain; whole-BOM grain open |
| Disable / restore | Exact-`'true'` flags gate all routes and workers (`plm-bom-review-wire.ts:12-14`, `plm-bom-notification-worker.ts:6-8`, `plm-personal-approval-wire.ts:98-99`, `plm-record-ingress-wire.ts:46-47`). Per-binding disable is terminal (`zzzz20261014030000_add_plm_bom_status_views_initialized.ts:11,27`). Evidence tables refuse deletion. | Gap: disabled binding still notified |

## Changes in this PR

### 1. Embed org cross-check (`aa1ed32`)

`GET /api/plm-embed/bom-review/context` reads Yuantus with the configured source's own credentials, so MetaSheet is the only gate between a token and the served scope. It compared `claims.tenant_id` with the served `x-tenant-id` and stopped there. A token minted for another org of the same tenant therefore read the served org's BOM. Both the BOM context relay (`routes/plm-embed.ts:105-110`; check at `:107-110`) and the Visual relay (`routes/plm-embed-visual-preview.ts:56-60`) now require `claims.org_id === adapter.getEffectiveOrgId()` and return `403 EMBED_ORG_MISMATCH` otherwise, including when either side is absent or ambiguous. The check runs after the tenant check and **before** the jti is consumed or the provider is called, so a refused token does not burn its single use. The duck types require `getEffectiveOrgId`; an adapter without it gets 503, matching the existing tenant-surface rule. The Visual provider also validates the forwarded token. The relay check there is defense in depth that also covers the admission path.

### 2. Disabled binding: no notifications, listener stopped (`9daedd2`)

The scan created no event only when no config existed. It never looked at `b.status`, and the prepare/deliver rechecks did not either, while completion delivery already required `active` (`plm-bom-review-service.ts:1105` on the handoff head). Now:

- `scanNotifications` returns `{ created: 0 }` for a disabled binding (`:882`).
- `prepareNotification` and `deliverNotification` re-read the status under `FOR SHARE` (`bindingDisabled`, `:1057`). A queued event or intent becomes `cancelled` with reason `BINDING_DISABLED` (`:993-996`, `:1028-1031`); the intent guard permits only that prepared→cancelled transition. `notificationContext` also refuses disabled bindings (`:947`).
- `disable()` stops an `active` listener in the same transaction, with `stop_reason='BINDING_DISABLED'` and the cursor kept, and records an audited `plm-bom-review:<id>:lifecycle` config revision. The revision carries before/after status and version and the stopped generation and cursor (`:1351-1363`). Lock order is binding (`FOR UPDATE`) then listener, the same as intake and rebind; prepare/deliver take intent then binding `FOR SHARE`, so no cycle is introduced.
- `stale` bindings keep notifying: stale means a source refresh failed, and MetaSheet-local review work and its SLA continue. Completion webhooks still require `active`.

### 3. Pre-existing backend reds on the handoff head (`7994071`, `18922e0`)

`test (20.x)` does not run on these stacked PRs, because `plugin-tests.yml` only triggers for `main` and `develop`. Two failures it would report were mechanical and are fixed here:

- `supertest-app-mode-tripwire.test.ts` failed on `plm-personal-approval-routes.test.ts`, which used `request(app)` at five sites. Those requests now go through `usePinnedServer()` with unchanged assertions.
- The default no-database config loaded `plm-personal-approval-realdb.test.ts` and failed at import with "DATABASE_URL required". It is now excluded like the other three PLM real-DB files and still runs whole-file in `plm-personal-approval-realdb.yml`.

The remaining latent reds need security dispositions that only their owners should write; they are listed in the verification document.

### 4. One decision channel per Yuantus approval (`0ac8b5f`)

`ApprovalBridgeService` decides `plm:` mirror instances by calling `PLMAdapter.approveApproval/rejectApproval` with the bridge adapter's own account (`ApprovalBridgeService.ts:1740-1745` on this branch, `:1730-1735` on the handoff head). With `PLM_APPROVAL_CARD_ENABLED=true` the same ECO tasks are decided by the acting person's Yuantus grant. The bridge path would then impersonate that person through an integration account, contrary to the manifest's own "No service-account approval fallback", and give one Yuantus approval a second decision channel. The bridge now refuses with `409 PLM_PERSONAL_BINDING_REQUIRED` before any source call or local state change (`:1298-1309`). The 2026-10-17 security continuation makes this refusal unconditional: unset, `off`, `false`, `TRUE`, `1` and `true` all refuse. Federation `approval_approve` and `approval_reject` now return the same 409 after their existing id/version/reject-comment validation. Neither entry dispatches a shared-account decision or writes local decision state. Native platform approvals, personal card commands and read-only mirror sync retain their existing paths.

### 5. Flag registration (`f46c317`)

`PLM_EMBED_VISUAL_PREVIEW_ENABLED` (added in #6424 as two inline reads) is now read only through `isPlmEmbedVisualPreviewEnabled()` (`auth/embed-config.ts:62`). It is registered in `scripts/ops/global-history-flag-manifest.mjs`, and the source-derived completeness census covers it, as `AGENTS.md` requires for new env flags.

### 6. Write-back audit (this pass)

The master goal requires an audited, controlled BOM write-back chain. The workbench line PATCH and ECO-intent POST previously called Yuantus and returned without writing a MetaSheet audit row. Each admitted request now inserts an `operation_audit_logs` attempt (`resource_type='plm-bom-writeback'`, `status_code=0`) **before** the provider call, and a matching outcome row afterwards. The attempt stores the MetaSheet actor, data source, part, line, changed field names, the patch, a SHA-256 of the Idempotency-Key (never the key), and whether If-Match was present. If the attempt insert fails, the route returns 503 `PLM_WRITEBACK_AUDIT_UNAVAILABLE` and does not call Yuantus. An outcome-insert failure is logged and does not change the provider result. Refusals that happen before a provider call (missing key, unentitled, invalid patch, unknown source) write nothing. The collaborative team-preset audit list is unchanged and does not show these rows. This does not change which Yuantus account performs the write.

## Disable and restore semantics after this PR

| Level | Disable | In-flight work | Restore |
| --- | --- | --- | --- |
| Package/feature flags | Exact-`'true'` flags off: routes return 503/404 and workers do not start or tick | Rows are retained, and evidence tables refuse delete/truncate. Prepared intents stay prepared. Listener cursors stay put. Personal command intents keep their receipts. | Flags back on: every send is rechecked at deliver time (permission, round, rule revision, recipients) and cancelled when stale. Listeners resume from the stored cursor (outage recovery, not history backfill). Escalations whose SLA elapsed during the outage fire once, idempotent per round. |
| One BOM review binding | `disable()`: status `disabled` (terminal by DB guard), listener stopped, audit revision written | Queued notifications are cancelled `BINDING_DISABLED`. No new events. Completions are cancelled by the existing `active` check. The sheet, rows, audit and events are retained. | The source owner creates a new share or rebind. A listener needs an explicit owner enable (new generation, baseline at the current sequence, no backfill). |
| Personal approval binding | Unbind destroys the stored grant and withdraws tasks and cards; unresolved command evidence is kept | Background reconciliation never issues a decision | A same-person rebind recovers prior receipts |

## Concurrency and permissions summary

- All new checks run inside the existing transactions and lock order. Each new refusal precedes any network call (embed) or state mutation (bridge, notifications).
- Object permissions are unchanged. Licensing and flags only ever restrict. The new org check and the bridge refusal narrow access and widen nothing.

## Whole-BOM completion: left unbuilt

The handoff rule is that the collaboration-done webhook is configurable per row or per whole BOM, with its own event name and its own authoritative transaction, distinct from PLM change success. The wire accepts `granularity: 'bom'` (`plm-bom-review-wire.ts:118`). The only producer emits `bom.review.completed` with `granularity='row'` (`zzzz20261014040000_add_plm_bom_row_completion_events.ts`), and delivery refuses anything else (`plm-bom-review-service.ts:1129`). The existing real-DB test asserts that a `bom` rule stays silent. #6417's UI offers "整份 BOM 评审完成" and is not on this branch.

None of the eight Yuantus documents says how a refresh that drops lines counts toward "the whole BOM is complete":

- whether the set is the current snapshot only, or every line ever shared, including lines a later refresh removed;
- whether a dropped line that is not 已完成 blocks the whole-BOM event, and whether a dropped line that was 已完成 still counts;
- whether the event is evaluated again after a refresh changes membership, and whether a new membership that becomes complete emits again;
- which single transaction is authoritative, given that one row's completion transaction cannot see a concurrent refresh.

Guessing any of those would emit a business event the rule says must have its own authoritative transaction. The producer stays unbuilt. Configuring granularity `bom` stores the rule and never fires it.

## Reclassification of the previously parked window items

Read against the eight documents. "Done" means the attached docs and this checkout agree on the MetaSheet behavior that those docs actually specify.

| Item | Class | Why |
| --- | --- | --- |
| SSO | Yuantus-side dependency | The personal-approval doc specifies an ordinary Yuantus login JWT that mints a purpose grant. MetaSheet verifies that grant and never maps `embed` `sub` to a MetaSheet user. No document specifies a MetaSheet SSO, OIDC or SAML flow. "Continuous SSO" is named by the Visual provider doc as still outside that slice, without a MetaSheet contract. |
| Discussion visibility | Yuantus-side dependency | MetaSheet Discussion read/write and Visual markup consumption exist (#6424). The consumer rejects a body that carries `visibility_scope` so an internal-visibility intent is not stored as a public one. None of the eight docs defines the visibility values or who may set them. |
| Revocation propagation | Done for the specified model | The listener doc says remote revocation is observed on the next authenticated poll or delivery, not by one distributed transaction. Personal grants fail closed when Yuantus returns 401/403 (`PlmPersonalApprovalBindingService.ts:143-144,200`). Visual admission is rechecked after each await. Instantaneous cross-service cancellation is explicitly not required. |
| DP1 date-obsolete undo | Yuantus-side | `PLM_DATE_OBSOLETE_UNDO_RECOVERY_20261015.md` is a Yuantus lifecycle feature (`DATE_OBSOLETE_UNDO_ENABLED`, Yuantus routes, Yuantus migrations `date_obsolete_undo_013` / `t21`). It names no MetaSheet endpoint, table or flag. MetaSheet has no DP1 code, and these docs do not ask for any. |
| Stage A | Not specified for MetaSheet | The master goal keeps the name. The listener doc's "Stage 2C" is a Yuantus disposable migration rehearsal. No attached doc defines a Stage A behavior for MetaSheet. |
| RG source binding | Not specified for MetaSheet | No attached doc defines "RG". The listener's source fingerprint, owner and cursor binding is the source binding these docs do specify, and it is implemented. |
| Version roadmap | Needs real env, plus a cross-repo runbook | The master goal asks for dependency versions, migration, backup/restore and failed-upgrade handling of the upgrade package. MetaSheet facts that exist: exact-`'true'` flags, evidence-bearing migrations that refuse downgrade when rows exist, and no destructive disable. A package install/upgrade rehearsal is a real-environment item and is not claimed. |
| Baseline member batch | Yuantus-side | Named by the handoff (`PLM_BASELINE_MEMBER_BATCH_20261015.md`) and described there as a Yuantus read-path performance candidate. The doc itself was not uploaded. No MetaSheet change. |

## Other gaps left open

1. **Write-back Yuantus identity.** Managed sources log in with deployment `PLM_USERNAME` / `PLM_PASSWORD` (`PLMAdapter.ts:1137-1146,1192-1194`; `DataSourceManager.ts:218,300-302`). Every data-source owner therefore writes as that integration account. None of the eight docs specifies a personal write grant or an owner-session write. The MetaSheet audit now records who requested the write; it does not change who Yuantus authenticates. BOM review sheets still have no outbound write-back: the only caller of `updateBomMultitableLine` is the workbench route.
2. **Generic pre-review wiring.** The reuse review's step 4 says to start published MetaSheet approval definitions from collaboration automation, reusing `automation-approval-bridge-service.ts` and record permissions. It does not name the template, the triggering collaboration event, or the form mapping. Step 5 (automatic PLM apply after review) explicitly waits for a separate completion contract. Neither step is implemented. A MetaSheet review and a Yuantus ECO stay separate facts, which is what the review requires.
3. **Personal bindings are not scoped by a MetaSheet tenant column** (`zzzz20261015040000…:9`). One deployment-wide connection matches the single-customer takeover. The grant's Yuantus tenant and org are checked.
4. **Legacy bridge with the flag off** still decides through the adapter account. The reuse review says that path must not be reused unchanged for W22. This branch enforces that only while `PLM_APPROVAL_CARD_ENABLED` is exactly `true`. Changing the flag-off path would change long-standing `main` behavior and is left to the owner.

## Docs versus code

Recorded from the eight uploads against this checkout. Historical counts in those docs are checkpoints of earlier SHAs, not claims about this head.

- Reuse review, written against MetaSheet `a5ed6d8`: `PLMAdapter.approveApproval` / `rejectApproval` at lines 3391 and 3413. On `a5ed6d8` those lines match. On the handoff head the same methods are at 3579 and 3601 because #6424 added Visual methods above them. The behavior the review describes (adapter credentials, no actor argument) is unchanged on the flag-off path.
- Reuse review: the legacy bridge "must not be reused unchanged for W22". With the personal-card flag on, this branch returns 409 before that call. With the flag off, the unchanged call remains (gap 4).
- Reuse review step 4 is not implemented (gap 2 above). The review itself says it "does not enable a new external-review authority".
- Listener doc: "MetaSheet real PostgreSQL suite … 125 passed" and "flag manifest: 47 passed" are results for earlier sources (`5600570` and before). This branch's BOM suite is 132 and the manifest test file is 50. The doc says those numbers are source checkpoints.
- Listener doc: remote revocation is not a distributed transaction. The code matches: a 401/403/404/409 on poll stops the listener (`plm-bom-review-service.ts` poll catch). Nothing here claims faster propagation.
- Visual provider doc, at its own checkpoint: "MetaSheet consumer/browser wiring remain to be verified." The later markup doc records Draft #6424 and `browser-04-locked` (3 tests). The consumer is on this branch. The provider doc's "remaining" line is older than the markup follow-up.
- Markup doc: "Bound does not assert currentness at later read." MetaSheet stores the binding it was given and the embed panel compares it with the current preview descriptor (`PlmEmbedVisualPreviewPanel.vue`). A mismatch is shown as not current. That matches the doc.
- Markup doc: V1 tools are pin, rectangle, arrow, callout, rotation 0. `visual-review-markup.ts` uses that set.
- Personal-approval recovery: distinct Yuantus AUTH subjects, not seats. MetaSheet submits one seat with the bound grant and stores Yuantus' receipt; it does not count seats. The two-person test in that doc is a Yuantus assertion.
- DP1 doc: Yuantus-only. No MetaSheet file references it. No mismatch to fix.
- Master goal acceptance table: "以上均为验收要求，尚不代表已经实现或通过。" This document does not treat local tests as that acceptance.
- Handoff: #6424 `a5977db` "43 workflows, 46 checks". The check-run query for that SHA returned 46 successes. Workflow-run count and check-run count differ; both statements can be true. This branch does not re-cite that green for any other SHA.
- MetaSheet listener doc in this repo says the flag manifest passed 47, then later sections supersede the suite count. Same historical-checkpoint reading as the Yuantus copy.
- The record-ingress document in this repo says its guard census passed. On the handoff head, rank-8 and OD-6 fail on `plm-record-ingress-service.ts:161,165`, and the #5938, API-path and `index.ts` pre-gate censuses fail on #6418 code. Those 19 reds stay with their authors; this pass does not edit them.

## Remaining work by phase

1. **Stack hygiene before any retarget to `main`** (owners of #6418/#6423/#6424). The 19 pre-existing backend reds listed in the verification document. Then the six `main` contexts on the resulting commit.
2. **Whole-BOM completion**, only after the dropped-line question in the section above is answered. #6417's UI is a separate merge onto this base.
3. **Write-back identity** (gap 1): a Yuantus contract for an owner session or a personal write grant. MetaSheet audit of the request is done.
4. **Generic pre-review wiring** (gap 2): needs a named template, trigger and form mapping. Automatic PLM apply waits on the reuse review's step 5 contract.
5. **Real environment** (owner-approved): paired Yuantus read-only window, real DingTalk, embed CSP/TLS, package install/upgrade/restore, full migration chain and server lifecycle.
6. **Not a MetaSheet implementation from these docs**: DP1, Stage A, RG source binding, baseline member batch, continuous SSO, Discussion visibility values.

## Personal identity boundary continuation — 2026-10-17

This increment closes the two generic shared-account approval entries, including when the personal-card feature is disabled. It removes only private dispatch/version helpers and their now-unused flag import. History still reads existing decisions; a refusal creates no decision history. Platform approve/reject remain functional. No new flag, schema or credential is introduced.

The distinct personal BOM-line and ECO-intent grant chain remains unfinished. Workbench writes still use the configured integration identity on this source; the MetaSheet attempt audit is not proof of a Yuantus personal subject. The next increment must implement and verify the actual positive chain, independently scoped credentials, current permissions, immutable retry identity and revocation/concurrency behavior. This guard increment does not complete PR #6425 or the master goal.


## Personal BOM write identity — current implementation contract (2026-10-17)

This increment is in progress. The earlier shared-account gap is being repaired
under the explicit implementation authorization; it is not a completed positive
write chain. Approval credentials remain separate from native `bom_write` grants.
Both BOM line PATCH and ECO-intent POST must use the requesting person's verified
Yuantus grant, with no shared-account fallback under any flag value.

The binding records the current persistent source owner, MetaSheet tenant,
workspace/scope and canonical native target origin, plus the separately verified
Yuantus tenant, organization and subject. Source configuration is re-read under
locks; a cached adapter URL is not authority to receive a personal bearer. Lock
order is active owner, exact active Meta membership (when non-null), source, then binding, including rebind and use. A first mapping read
must be rechecked after locking; it must not follow a changed mapping into an
inverted second lock. Transfer or scope/target changes invalidate further use.

Remaining consumer integration must compare the source's MetaSheet tenant against
`req.authenticatedTenantId`, the JWT-verified carrier. The compatibility header
may populate `req.user.tenantId`; that field must not establish tenant authority.
A source snapshot alone does not prove the caller's tenant. Nullable legacy
private sources remain a distinct explicit case, never copied from Yuantus scope.
This request-context check must be made inside the source/dispatch lock boundary.
For tenant-scoped callers, the active `user_orgs` membership must also be
rechecked/locked through dispatch; a previously verified token is not a lock
against concurrent membership revocation. Ordinary auth resolves that membership
on admission, but that earlier query does not serialize the later provider call.

A durable logical intent is unique by MetaSheet owner/source/operation kind and
client operation key before resolving today's personal binding. Its frozen
origin/person/native scope/payload cannot change on retries. Replacing a grant
for the same person can authorize a fresh dispatch attempt; changing the person
or target cannot reinterpret the old key as a different operation. Grant generation
belongs to the attempt, not the logical operation identity. ECO browser requests
need an operation key as well as line writes. Provider receipts, current authority
checks and native commit remain the final business authority.

Local unbinding invalidates use before remote self-revoke. Remote uncertainty is
not revocation proof: an encrypted retired credential and its original target
must survive a process restart until revocation can be reconciled. Replacement
must not revoke the replacement credential or lose older pending revocations.
The encrypted retirement/restart foundation is implemented and independently
verified below. Consumer admission and automatic reconciliation wiring remain pending.

### Reviewed durable dispatch boundary (implementation pending)

Read-only Astra ultra review pinned MetaSheet `037f1612` and native `e75a9f4`.
A two-phase transaction is required: phase one commits one immutable logical
intent before any provider mutation; phase two reacquires current authority and
sends the stored request. Both phases lock `users FOR SHARE`, exact active
`user_orgs FOR SHARE`, source, binding, then intent. Source/binding/intent use
`FOR UPDATE`. `FOR KEY SHARE` would permit an ordinary membership deactivation.
A unique `(owner, source, operation kind, client key hash)` prevents a changed
binding/person/origin from creating another namespace for the same operation.

The stored intent must include both identity domains, source workspace/scope,
canonical native origin/connection/person, target part/line, effective body,
normalized `If-Match` including absence, fingerprint and stable provider key.
On an existing logical identity, compare those frozen fields; never refreeze or
regenerate the key. A current replacement grant for the same person may retry.
Persisting only a hash cannot reconstruct the request after restart.

An uncertain first commit forbids immediate dispatch. After the first confirmed
commit, a crash, timeout, malformed provider success or lost local outcome commit
leaves that same intent recoverable. Known local success also replays through
native current authorization with the frozen key, rather than bypassing a later
native revocation. At the reviewed native source this includes current grant,
membership/global RBAC, entitlement and Part BOM type permission; it does not
prove per-item Part/line/ECO ACL enforcement. A later refusal does not negate a
previous unknown attempt that may already have committed. A timed-out HTTP
request is not distributed cancellation: an admitted provider operation may
finish after local locks release. Neither distributed atomicity nor cancellation
is claimed. Existing routes still require implementation and fault/race tests
against this contract; these paragraphs are not completion evidence.


### Trusted actor admission implemented (2026-10-17)

The binding service now requires `{userId, metaTenantId}` for bind, management
URL, scoped metadata list, use and freeze. `metaTenantId` must be an explicit null
or a nonempty valid string. Missing, undefined, numeric or blank context cannot
become legacy admission. Null matches only a persisted null `legacy_private`
source, without borrowing the native tenant. Non-null context must equal the
persisted source tenant and have a current active `user_orgs` row locked
`FOR SHARE` after the active user and before the source/binding locks. The
membership lock remains held through native verification and local commit.

Self-revoke/unbind cleanup retains owner-only admission and remains available
when the feature is disabled; it gains no business write authority. The two
systems' subjects and tenant/org values remain distinct. Actual route construction
of the trusted actor, durable intents, personal dispatch and binding UI remain
pending. This service contract does not make a header/body tenant trustworthy.


### Durable personal BOM operation admission

The new additive intent table is keyed by owner, source, operation kind and
client-key SHA256. Mutable binding ID/generation, native person and origin do
not define logical uniqueness. The first transaction locks active user,
exact active Meta organization membership, persisted source and binding, then
locks/inserts the intent. It freezes the independently scoped Meta/native
identities, workspace/policy, origin, connection, person, part/line, canonical
allowed body, If-Match including absence, and provider key. It commits before
any native mutation request.

The second transaction reacquires those authority locks in the same order and
locks the intent. Changed frozen context is409 with zero new dispatch; it is
never silently replaced. A current grant for the same native person may rotate
without changing the stored operation key. The locks remain held through native
request and local outcome commit. Every replay calls native authorization;
confirmed local evidence never bypasses current native permission checks.
Receipt validation requires the frozen line ID and agreement with any prior
canonical confirmation. Conflicting acknowledgements and transport ambiguity
remain unknown, preserve earlier confirmation and return unavailable. A lost
COMMIT acknowledgement may still leave durable evidence; retries use that row.
The existing memory-only freeze helper is not durable dispatch.

Intent-table downgrade takes an exclusive NOWAIT lock and refuses any stored
row. Credentials are encrypted only on bindings; intents retain no credential
fields or raw client operation keys. Ordinary business text is not filtered by
broad secret substrings. The standalone native provider retains authority over
PLM business state and permission. Route/UI integration and live paired-service
verification are subsequent slices; this design does not authorize production
enablement or represent the whole upgrade package as completed.
