# MetaSheet side of the Yuantus upgrade chain — design (2026-10-15)

Branch `cursor/plm-upgrade-chain-metasheet-316e`, stacked on the handoff branch `codex/plm-visual-consumer-20261015` at `a5977db1c2afb0106d87e60fe066cd4a3427dc4c` (PR #6424 → #6423 → #6418 → #6413 → `main` merge base `ad2246fecd7af5227f8f4a68ee5c8ba8512e212c`). Draft only. No merge, deployment, production enablement, real notification or data deletion is part of this work.

## Authority and inputs

- The authoritative window scope lives in the Yuantus repository (`docs/development/WINDOW_MASTER_GOAL_20261015.md`, `WINDOW_GROK_HANDOFF_20261015.md` and linked docs). From this environment that repository is not reachable: `git clone` and the GitHub API both return 404 for `zensgit/yuantus-plm` and six name variants, and the GitHub connector is in an error state. Those documents were therefore **not read**; nothing here claims agreement with them. The scope used is the task statement (goal, fixed business rules, engineering rules) plus the four stack documents already in this repository: `PLM_LISTENER_REVIEW_20261015.md`, `PLM_RECORD_CROSSSTACK_RECOVERY_20261015.md`, `PLM_PERSONAL_APPROVAL_RECEIVER_20261015.md`, `PLM_VISUAL_CONSUMER_RECOVERY_20261015.md`.
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
| Controlled multi-dim write-back | `PATCH /api/plm-workbench/data-sources/:id/bom-multitable/:partId/lines/:bomLineId` requires a MetaSheet login and data-source ownership, an entitled `bom_multitable_writeback`, an Idempotency-Key, a four-field whitelist and If-Match pass-through (`routes/plm-workbench.ts:1063-1159`). The ECO intent route (`:1168-1254`) shares those gates. | Partial: identity, audit and multitable path are open (see Gaps) |
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

`ApprovalBridgeService` decides `plm:` mirror instances by calling `PLMAdapter.approveApproval/rejectApproval` with the bridge adapter's own account (`ApprovalBridgeService.ts:1740-1745` on this branch, `:1730-1735` on the handoff head). With `PLM_APPROVAL_CARD_ENABLED=true` the same ECO tasks are decided by the acting person's Yuantus grant. The bridge path would then impersonate that person through an integration account, contrary to the manifest's own "No service-account approval fallback", and give one Yuantus approval a second decision channel. The bridge now refuses with `409 PLM_PERSONAL_BINDING_REQUIRED` before any source call or local state change (`:1298-1309`). Behavior with the flag off is unchanged. The read-only mirror sync is not changed.

### 5. Flag registration (`f46c317`)

`PLM_EMBED_VISUAL_PREVIEW_ENABLED` (added in #6424 as two inline reads) is now read only through `isPlmEmbedVisualPreviewEnabled()` (`auth/embed-config.ts:62`). It is registered in `scripts/ops/global-history-flag-manifest.mjs`, and the source-derived completeness census covers it, as `AGENTS.md` requires for new env flags.

## Disable and restore semantics after this PR

| Level | Disable | In-flight work | Restore |
| --- | --- | --- | --- |
| Package/feature flags | Exact-`'true'` flags off: routes return 503/404 and workers do not start or tick | Rows are retained, and evidence tables refuse delete/truncate. Prepared intents stay prepared. Listener cursors stay put. Personal command intents keep their receipts. | Flags back on: every send is rechecked at deliver time (permission, round, rule revision, recipients) and cancelled when stale. Listeners resume from the stored cursor (outage recovery, not history backfill). Escalations whose SLA elapsed during the outage fire once, idempotent per round. |
| One BOM review binding | `disable()`: status `disabled` (terminal by DB guard), listener stopped, audit revision written | Queued notifications are cancelled `BINDING_DISABLED`. No new events. Completions are cancelled by the existing `active` check. The sheet, rows, audit and events are retained. | The source owner creates a new share or rebind. A listener needs an explicit owner enable (new generation, baseline at the current sequence, no backfill). |
| Personal approval binding | Unbind destroys the stored grant and withdraws tasks and cards; unresolved command evidence is kept | Background reconciliation never issues a decision | A same-person rebind recovers prior receipts |

## Concurrency and permissions summary

- All new checks run inside the existing transactions and lock order. Each new refusal precedes any network call (embed) or state mutation (bridge, notifications).
- Object permissions are unchanged. Licensing and flags only ever restrict. The new org check and the bridge refusal narrow access and widen nothing.

## Gaps not implemented here (by design or budget)

1. **Whole-BOM completion webhook.** The wire accepts `granularity: 'bom'` (`plm-bom-review-wire.ts:118`) and #6417's UI offers "整份 BOM 评审完成", but no producer exists. The row-event trigger only emits for `row`, delivery refuses non-row (`plm-bom-review-service.ts:1129`), and the existing real-DB test asserts silence for `bom`. Proposed design:
   - Have the worker scan, under the binding lock, for "all current `snapshot` rows have their latest round completed".
   - Insert a fact row keyed by `(binding_id, hash of sorted (record_id, round))` with `ON CONFLICT DO NOTHING`, plus a trigger-created `bom.review.completed`/`bom` event (guard at depth 2).
   - At delivery, recheck that the same set is still complete.
   This needs an owner decision on refresh semantics (lines leaving the snapshot) and a migration. Until it lands, admins can select a grain that never fires.
2. **Write-back identity and audit.** Managed PLM sources build their adapter with an empty config service (`DataSourceManager.ts:218,300-302`). The Yuantus login therefore falls back to the deployment-wide `PLM_USERNAME/PLM_PASSWORD` (`PLMAdapter.ts:1137-1146,1192-1194`), and the workbench write-back writes as that integration account for any data-source owner. No MetaSheet audit row is written for write-back or ECO intent (`routes/plm-workbench.ts:1136-1158`). The BOM review multitable has no write-back path at all: the only caller of `updateBomMultitableLine` is the workbench route. Proposed design:
   - Write with the owner's own persisted source session, the same transport as share context, which proves `auth_user_id`, or with a Yuantus-issued personal write grant.
   - Record a durable MetaSheet write-back intent (actor, row, frozen idempotency key, If-Match from a fresh context read, receipt).
   - Never change source cells locally; the `bom_line_writeback` event and refresh carry the result.
   This depends on the Yuantus contract. Until then, keep `bom_multitable_writeback` unentitled where the deployment account is shared.
3. **Personal bindings are not scoped by MetaSheet tenant** (`zzzz20261015040000…:9`): there is one deployment-wide connection. This is acceptable for the single-customer takeover; multi-tenant hosting would need a tenant column.
4. **SSO, Discussion visibility (X2), distributed revocation, DP1, Stage A, RG source binding and the version roadmap.** No MetaSheet code is added here. The embed has no MetaSheet identity, so the token `sub` is not mapped; there is no Yuantus↔MetaSheet SSO; Discussion writes reject `visibility_scope`. These need the unread Yuantus scope documents and owner decisions.
5. **Legacy bridge with the flag off.** It still decides through the adapter account. Turning it default-off would change long-standing `main` behavior and is left to the owner.

## Docs versus code (recorded, not resolved by assertion)

- The manifest purpose for `PLM_APPROVAL_CARD_ENABLED` says "No service-account approval fallback". The legacy bridge was such a fallback even with the flag on; fixed in change 4.
- The Visual document says preview capabilities bind "identity, scope, Part". The relay scope was tenant-only; fixed in change 1.
- The record-ingress document reports its native guard and census modules passing. On the handoff head, the rank-8 record-lock and OD-6 revision-disposition guards fail on `plm-record-ingress-service.ts:161,165`, and the #5938 liveness, API-path and `index.ts` pre-gate censuses fail on #6418 code. These are local full-suite results; `test (20.x)` never ran on #6418.
- #6417's UI offers whole-BOM completion, which the backend never emits (gap 1).

## Remaining work by phase

1. **Stack hygiene before any retarget to `main`** (owners of #6418/#6423/#6424). Add the security dispositions for the guard and census reds listed in the verification document. Fix the `outbound-sql-write-gate` test double for the transactional `persistDataSource`. Then rerun the six required `main` contexts on the actual resulting commit.
2. **Collaboration completeness**: whole-BOM completion (gap 1) and merging the #6417 UI onto the same base.
3. **Write-back** (gap 2): Yuantus contract for owner or personal write identity, plus a MetaSheet write-back intent and audit.
4. **Paired real-environment acceptance** (owner-approved, O-level): real Yuantus read-only window, real DingTalk delivery, TLS and embed edge CSP, full migration chain and server lifecycle.
5. **Parked window items pending the Yuantus scope documents**: SSO, Discussion visibility, revocation propagation, DP1, Stage A, RG source binding, version roadmap.
