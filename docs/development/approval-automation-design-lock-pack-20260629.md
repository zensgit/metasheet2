# Approval & Process-Automation — design-lock pack (2026-06-29)

> Code-grounded design-lock sections for every remaining heavy/decision rung of the dev-plan (#3379),
> authored + adversarially reviewed by a 34-agent workflow. Each section is brand-neutral (MetaSheet
> principles). **None is authorized to build by this doc** — each rung is owner-gated; see the decision
> register (`approval-automation-decision-register-20260629.md`) for the open decisions + proposed
> defaults that unblock it. Anchor caveat: T1-3 / T2-4 / T3-6 had cited anchors the reviewer could not
> fully confirm — verify against code before implementing.

---

## T0-3 — Expose delete_record in the rule editor (safely)

### Summary / current state
`delete_record` has a **fully guarded executor** but is **not editor-selectable**. The runtime is complete and proven:

- Dispatch case: `executeSingleAction` routes `'delete_record'` to `executeDeleteRecord` — `packages/core-backend/src/multitable/automation-executor.ts:1604`.
- Guarded executor: `executeDeleteRecord` — `automation-executor.ts:2102-2201`. It routes a delete through the **same cross-base write gate** as a record write (`evaluateCrossBaseWrite`, claim==truth + trigger-actor base-write + shared per-target-base quota), enforces the **record-lock guard** (`ensureRecordNotLocked`, :2158-2160), cleans up `meta_links` on both FK sides first (:2166-2169), and performs a **HARD delete** (`DELETE FROM meta_records …`, :2179-2182) — there is no soft-delete/`deleted_at`/undo. It then emits `multitable.record.deleted` (:2187-2192) and a real-time `record-deleted` fan-out (:2195).
- Type + storage already widened: `AutomationActionType` and `ALL_ACTION_TYPES` include `delete_record` (`automation-actions.ts:9,28`); `DeleteRecordConfig` (`automation-actions.ts:71-84`) defines optional `targetBaseId/targetSheetId/targetRecordId` (all absent = same-base trigger-record delete); the DB CHECK constraint includes it (`db/migrations/zzzz20260614120000_add_delete_record_automation_action.ts`).
- Save-path already accepts it: `CANONICAL_ACTION_TYPES` derives from `ALL_ACTION_TYPES` and `validateActionObject` passes `delete_record` (`automation-service.ts:84,309-318`). **It is already savable via the raw API today** — this rung is about the editor surface and the safety affordances, not new capability.
- Cascade is bounded: `MAX_AUTOMATION_DEPTH = 3` (`automation-service.ts:51`, enforced :1338-1339) caps any delete→trigger→delete chain.

The destructive surface is the **production trigger**: a same-base `delete_record` fires on the live trigger record, hard-deletes it, no undo.

### Scope — what gets built
Make `delete_record` a first-class, **same-base trigger-record** selectable action in the rule editor, behind an explicit anti-misdelete acknowledgement, with a clean persisted config and a label. Concretely, the "enable = N changes" set (each is required; the first compile-blocks the rest):

1. **FE type union** — add `'delete_record'` to `AutomationActionType` in `apps/web/src/multitable/types.ts:1006-1021`. It is currently **absent**, so adding it to the selectable list will not compile under `vue-tsc -b` until the union includes it. (`record_click` is also absent there — confirming the FE union lags the backend; out of scope here.)
2. **Selectable list** — add `'delete_record'` to `SUPPORTED_SELECTABLE_ACTION_TYPES` in `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue:1309-1325`.
3. **Label** — add a `case 'delete_record'` to `automationActionTypeLabel` in `apps/web/src/multitable/utils/meta-automation-labels.ts:835-867` (proposed `删除记录` / `Delete record`). Today it falls through to `default: String(type)`, rendering the raw key.
4. **Default draft config** — add a `delete_record` case to `defaultConfigForActionType` (`MetaAutomationRuleEditor.vue:2740-2785`) returning the authoring shape (e.g. `{ acknowledged: false }`); the existing `default: {}` would otherwise leave no place for the ack.
5. **Config block** — add a `v-if="action.type === 'delete_record'"` block (template region near the `lock_record` block at `MetaAutomationRuleEditor.vue:928-933`) containing a permanent-delete warning hint + the required acknowledgement control.
6. **Save gate** — extend `canSave` (`MetaAutomationRuleEditor.vue:2134-2172`) to block save of a `delete_record` action whose acknowledgement is not set.
7. **Clean serialize branch** — add an explicit `if (action.type === 'delete_record')` branch to the action serialize map (`MetaAutomationRuleEditor.vue:2845-2981`, before the `return { type, config: action.config }` fallthrough at :2980) that emits **clean config** (`config: {}` for same-base v1). This prevents the authoring-only acknowledgement key from leaking into the persisted rule and into every execution's `action_config`.
8. **Save-time cross-base parity (backend)** — extend `validateCrossBaseWriteConfig` (`automation-service.ts:283-293`) so `delete_record` (and `lock_record`) get the same fail-closed shape check that `update_record` gets today (it currently early-returns for every non-`update_record` type). Independent of UI exposure, because the action is already API-savable.

### What does NOT get built (non-goals)
- **No cross-base delete UI.** No `targetBaseId/targetSheetId/targetRecordId` inputs; same-base only. Cross-base delete remains runtime-capable but editor-unminted (deferred, gated).
- **No alternate same-base target.** Same-base delete is trigger-record-only; no per-record id/field-path picker.
- No soft-delete / trash / undo (the system has none for records; the executor and both same-base REST sinks hard-`DELETE`).
- No new audit table, no new authoring capability, no Test Run behavior change beyond an informational hint.

### Runtime / round-trip semantics
- **Production (same-base):** trigger fires → executor reads `context.recordId` → hard-deletes the trigger record. Lock guard and depth cap apply. Recorded in the execution log like every other action.
- **Test Run is NOT the real path.** `testRun` synthesizes `recordId: 'test_record'`, `actorId: 'system'` (`automation-service.ts:1958-1972`). A same-base `delete_record` Test Run therefore deletes a non-existent id (0-row `DELETE`, reported `success` per the same-base leniency at `automation-executor.ts:2148-2150`) — it validates nothing and is **misleading-green**, not destructive. It is not a pure no-op: it still emits `multitable.record.deleted` + `publishRecordRealtime('record-deleted', …)` for the synthetic id, which a `record.deleted`-triggered rule could observe (depth-capped). A literal real record with id `'test_record'` would be deleted, but ids are app-generated (`rec_…`) so collision is effectively nil. This is why the same-base-only default keeps Test Run safe; the destructive Test Run path exists **only** for cross-base rules (executor uses `config.targetRecordId`, not the synthetic id) — a known gap that already exists pre-rung and is held off by not minting cross-base delete rules in the editor.
- **Authorization:** rule authoring is gated by `canManageAutomation` (`packages/core-backend/src/routes/univer-meta.ts:15390` create, `:15427` update). Same-base runtime delete runs with the rule's authority (lock guard only — parity with `update_record`/`create_record`). Cross-base delete is gated by `evaluateCrossBaseWrite`.

### Test plan
1. **FAIL-FIRST (selectable):** model on the existing lock_record test at `apps/web/tests/multitable-automation-rule-editor.spec.ts:313-331`. Mount the editor, read the action `<select>` options, assert `actionValues` **contains** `'delete_record'` and the option is enabled. RED today (it is not in `SUPPORTED_SELECTABLE_ACTION_TYPES`).
2. **Real-wire emit (round-trip the executor reads), not a hand-built fixture:** model on the create_record emit test at `multitable-automation-rule-editor.spec.ts:1767-1818`. Mount → select `delete_record` → tick the acknowledgement → Save → assert the emitted payload's action is **exactly** `{ type: 'delete_record', config: {} }` — i.e. the same-base shape `executeDeleteRecord` consumes, with **no acknowledgement key** in `config`. This catches both the serialize-shape regression and the ack-leak.
3. **Label:** assert `automationActionTypeLabel('delete_record', …)` returns the real label (not the raw key) — add to `apps/web/tests/meta-automation-labels.spec.ts` (currently uncovered).
4. **Save gate:** assert `canSave` is false for a `delete_record` action with the acknowledgement unset, true once set.
5. **Backend save-time parity:** add a service-level test asserting a cross-base `delete_record` config with `targetBaseId` set but missing `targetSheetId`/`targetRecordId` is **rejected at Save** (`AutomationRuleValidationError`), mirroring the existing `update_record` cross-base shape check — currently it is accepted at Save and only fails at run.
6. **Migration guard unchanged:** `delete-record-automation-action-migration.test.ts` already locks the DB constraint; no change.

### Dependencies
- Backend executor, action registry, DB constraint, execution-log, and depth guard are all already in place (anchors above) — no backend runtime work beyond the optional save-time validation parity (item 8 / decision 4).
- FE: `AutomationActionType` union (`types.ts`), the editor SFC, the label util. Adding to the selectable list **requires** the union change first or the build breaks.

### Brand-neutrality note
The only side-effecting test-run confirmation that exists today is scoped to an outbound-message channel (`MetaAutomationRuleEditor.vue:3017`). Stated as a MetaSheet capability: *destructive and side-effecting actions need an authoring-time confirmation distinct from a generic save.* This rung adds that affordance for record deletion; whether the existing channel-confirm is generalized to cover destructive deletes is folded into the Test Run decision.

---

## T1-1 — Node-level SLA + timeout actions

### Scope

Today SLA is **template-level and remind-only**: `approval_templates.sla_hours` is copied into `approval_metrics.sla_hours` at instance start (`ApprovalProductService.ts:3170-3177`), a periodic scan flips `sla_breached` when `started_at + sla_hours` elapses (`ApprovalMetricsService.checkSlaBreaches`, `ApprovalMetricsService.ts:293-306`), and the only consequence is a notification (`ApprovalBreachNotifier.notifyBreaches`, `ApprovalBreachNotifier.ts:74-177`). There is no per-node deadline and no effect other than "warn".

This rung adds a **per-node timeout policy** with an effect set, anchored at node activation rather than instance start:

- **Configuration:** approval nodes gain an optional `timeout` policy (`afterMinutes` + `effect` + effect-specific target).
- **Effects WIRED this rung:** `remind` (notification, reusing the existing breach-notifier channels), `transfer` (reassign the timed-out node to a configured user), `jump` (advance the instance to a configured downstream approval node).
- **Effects CONTRACT-PRESENT but runtime-INERT this rung:** `auto_approve`, `auto_reject` — declared in the enum, normalized + round-tripped, but refused by the effect engine until an explicit owner opt-in (see Open Decision 1). This mirrors the in-repo `NodeFieldAccess` precedent where `readonly`/`editable` are "declared now so the contract is forward-stable; do not wire them" (`types/approval-product.ts:32-48`).
- **Runtime engine:** the existing `ApprovalSlaScheduler` tick (leader-lock + at-least-once) is extended to also find due node deadlines; the side-effecting transition is owned by `ApprovalProductService` under the same `FOR UPDATE` + `version` machinery that human actions use.

**Out of scope / unchanged:** template-level `sla_hours` and its instance-level breach path stay byte-for-byte as-is; this is purely additive and orthogonal.

### Contract + real anchors it extends

**1. Node config type — `types/approval-product.ts`.** `ApprovalNodeConfig` (`types/approval-product.ts:78-90`) currently allows `assigneeType/assigneeIds/assigneeSources/approvalMode/emptyAssigneePolicy/autoApprovalPolicy/fieldPermissions`. Add:

```ts
export type NodeTimeoutEffectKind = 'remind' | 'transfer' | 'jump' | 'auto_approve' | 'auto_reject'

export interface NodeTimeoutPolicy {
  afterMinutes: number              // whole minutes from node activation, > 0, capped
  effect: NodeTimeoutEffectKind
  transferToUserId?: string         // required iff effect === 'transfer'
  jumpToNodeKey?: string            // required iff effect === 'jump' (downstream approval node)
}
// ApprovalNodeConfig gains:  timeout?: NodeTimeoutPolicy
```

`ApprovalActionType` (`types/approval-product.ts:16-24`) is **not** extended — auto-fired effects reuse existing record actions plus a metadata discriminator (Open Decision 3).

**2. The load-bearing normalizer — `normalizeApprovalGraph` (`ApprovalProductService.ts:970`, node loop `:979`).** This is the anchor the whole contract stands on. The approval-node branch **rebuilds `config` field-by-field via an explicit allowlist** (`ApprovalProductService.ts:1037-1049`):

```ts
normalizedNode.config = {
  ...(hasLegacyAssignees ? { assigneeType, assigneeIds } : {}),
  ...(assigneeSources ? { assigneeSources } : {}),
  ...(approvalMode ? { approvalMode } : {}),
  ...(emptyAssigneePolicy ? { emptyAssigneePolicy } : {}),
  ...(autoApprovalPolicy ? { autoApprovalPolicy } : {}),
  ...(fieldPermissions ? { fieldPermissions } : {}),
}
```

An unknown `config.timeout` key is **silently dropped here** — so a hand-built config that "looks right" would never survive save/publish. The change adds a `normalizeNodeTimeoutPolicy(node.config.timeout, …)` validator and threads `...(timeout ? { timeout } : {})` into this rebuild. `assertApprovalGraph` (`ApprovalProductService.ts:1577-1583`) delegates to this same normalizer, so the policy round-trips create → save → publish → `runtime_graph`. Publish-time cross-validation (alongside the existing `fieldPermissions` field-id check at `ApprovalProductService.ts:944-963`) asserts: `transferToUserId` present for `transfer`; `jumpToNodeKey` is an `approval` node downstream of the host node (reuse `isReachableDownstream`, `ApprovalProductService.ts:1708-1713`); per Open Decision 6, reject non-remind timeouts on parallel-branch nodes.

**3. Deadline materialization — `ApprovalMetricsService`.** Node activation already records `activatedAt` into `node_breakdown` (`ApprovalMetricsService.recordInstanceStart:174-182`, `recordNodeActivation:204-223`), driven by `emitNodeActivationMetric` (`ApprovalProductService.ts:4207-4215`). The default storage adds two nullable scalar columns to the **existing** `approval_metrics` table — `current_node_deadline_at TIMESTAMPTZ`, `current_node_timeout_effect TEXT` — set when a node with a `timeout` policy activates (`deadline = activatedAt + afterMinutes`) and cleared on decision/exit, plus a stamped fired-timestamp (in the `node_breakdown` entry) to make remind single-shot. A partial scan index mirrors the existing `idx_approval_metrics_sla_scan` (`migrations/zzzz20260425100000_create_approval_metrics.ts:82-86`). (Storage shape is Open Decision 2.)

**4. Scanner — `ApprovalSlaScheduler.tick` (`ApprovalSlaScheduler.ts:135-167`).** The tick already calls `checkSlaBreaches` then dispatches via the `onBreach` hook. Add a sibling step: `metrics.listDueNodeTimeouts(now)` returns `{ instanceId, nodeKey, effect }` tuples (active rows where `current_node_deadline_at < now`, not yet fired), and the scheduler hands them to a new `onNodeTimeout` hook wired in `index.ts` (next to the existing `startApprovalSlaScheduler({ onBreach })` block, `index.ts:2076-2097`). The scheduler stays dumb — it only finds due work and reuses the leader-lock / at-least-once guarantees.

**5. Effect application — `ApprovalProductService` + `ApprovalGraphExecutor`.** The effect engine runs inside a transaction taking the same row lock human actions take — `SELECT * FROM approval_instances WHERE id = $1 … FOR UPDATE` (`ApprovalProductService.ts:3213`) — re-validates the node is still `current_node_key` + status `pending`, then applies via existing executor methods:
- `remind` → compose + dispatch via the existing notifier path (`ApprovalBreachNotifier`), no state change.
- `transfer` → `executor.buildTransferAssignments(currentNodeKey, transferToUserId)` (`ApprovalGraphExecutor.ts:770-778`); deactivate old assignees; bump `version`.
- `jump` → `executor.resolveReturnToNode(jumpToNodeKey)` (`ApprovalGraphExecutor.ts:697-700`), reusing the admin-jump transition body (`ApprovalProductService.ts:3310-3373`).
- `auto_approve` (gated/inert) → would use `executor.resolveAfterApprove(currentNodeKey)` (`ApprovalGraphExecutor.ts:557-580`).
- `auto_reject` (gated/inert) → terminal reject via the existing reject path.

### Runtime / round-trip semantics

- **Anchor + reset:** deadline = node `activatedAt` + `afterMinutes`. Re-entering a node (return/jump-back) re-stamps `activatedAt`, so the deadline resets — no separate bookkeeping.
- **Invalidation (the core decision):** the timeout effect and the human approver race on the `approval_instances` row lock + `version`. Whichever commits first wins. If the human acts first, `current_node_key` advances and the deadline is cleared on exit, so the later timeout tick re-reads, sees the node is no longer current, and is a **no-op**. If the timeout fires first, it bumps `version` and deactivates the node's assignments; a stale human action then fails the existing status/version checks (409). No new locking primitive is introduced.
- **At-least-once safety:** the scan is at-least-once (mirroring `breach_notified_at`); the per-node fired-stamp + the "still current" re-check make a duplicate tick idempotent for every effect.
- **Audit:** each auto-fired effect writes an `approval_records` row reusing the existing action with `metadata.timeoutEffect: true` (mirrors `metadata.adminJump: true`, `ApprovalProductService.ts:3360`) and a system actor id.

### Test plan

**FAIL-FIRST (RED without the change) — assert the REAL publish wire, not a fixture.**
`createTemplate` with an approval node carrying `config.timeout = { afterMinutes: 60, effect: 'remind' }` → `publishTemplate` → read back the published `runtime_graph` (via the published-definition row / version-detail DTO) → assert `node.config.timeout` deep-equals the input. This goes **RED today** because `normalizeApprovalGraph` (`ApprovalProductService.ts:1037-1049`) strips the unknown `timeout` key, so the published graph has `config.timeout === undefined`. It turns green only once the normalizer preserves the policy. (This directly guards the documented wire-vs-fixture drift trap: a unit test on a hand-built config would false-green.)

**Additional tests (assert real rows/transitions, not hand-built breakdowns):**
1. *Deadline stamped:* create + dispatch into a timeout node → read the real `approval_metrics` row (`getInstanceMetrics`) → assert `current_node_deadline_at === activatedAt + afterMinutes` and effect recorded.
2. *Remind single-shot:* advance clock, run the node-timeout scan → assert one notify dispatch; run a second tick → assert zero (fired-stamp idempotency).
3. *Transfer effect:* timeout fires → assert the only active assignment for the node is `transferToUserId`, old assignees deactivated, `version` bumped, an `approval_records` row with `action='transfer'` + `metadata.timeoutEffect===true`.
4. *Jump effect:* timeout fires → assert `current_node_key === jumpToNodeKey`, parallel-state cleared, record `action='jump'` + `metadata.timeoutEffect===true`.
5. *Invalidation no-op:* human approves the node, **then** a stale scan tick targets the now-exited node → assert no second transition (current node already advanced; deadline cleared).
6. *Security gate:* a node with `effect='auto_approve'` and the terminal-effects gate OFF → run the scan → assert the node stays `pending` and no terminal record is written (proves auto-approve is inert until opt-in).

### Dependencies

- `ApprovalSlaScheduler` (tick + leader-lock + at-least-once) — `ApprovalSlaScheduler.ts:135-167`.
- `ApprovalBreachNotifier` + env channels — `ApprovalBreachNotifier.ts:74-177`, wired at `index.ts:2076-2097`.
- `ApprovalGraphExecutor` transitions — `buildTransferAssignments:770`, `resolveReturnToNode:697`, `resolveAfterApprove:557`.
- `ApprovalMetricsService` node_breakdown + new scan/store API — `ApprovalMetricsService.ts:204-223, 293-306`.
- `ApprovalProductService` dispatch `FOR UPDATE` + `version` + admin-jump body — `:3213, :3310-3373, :3515`.
- One schema migration on the existing `approval_metrics` table (or a new table — Open Decision 2).

### Explicit non-goals

- Template-level SLA and its instance-level breach scan are unchanged.
- No repeating / multi-stage escalation (single-shot per activation this rung).
- No business-hours / working-calendar clocks (plain wall-clock minutes).
- No timeout effects beyond `remind` inside parallel-gateway regions.
- No bespoke authoring UI — `timeout` is configured through the existing template-graph JSON, which now round-trips through the normalizer.
- `auto_approve` / `auto_reject` are contract-present but NOT runtime-wired until an explicit owner opt-in (Open Decision 1).

---

## T1-2 — Inbound webhook endpoint (signed, audited)

**Size: M.** Turns the latent `webhook.received` trigger into a real, signature-authenticated, audited ingestion route. No new third-party deps; no DB migration under the proposed defaults.

### Problem — `webhook.received` is inert

The trigger type exists end-to-end at the type/config/persistence layer but nothing can ever fire it:

- It is a member of `AutomationTriggerType` (`packages/core-backend/src/multitable/automation-triggers.ts:14`) and `ALL_TRIGGER_TYPES` (`:25`); its config shape is `WebhookReceivedConfig { secret?: string }` (`automation-triggers.ts:48-51`).
- It is a valid trigger at rule-save: `VALID_TRIGGER_TYPES` includes it (`automation-service.ts:71`) and the DB CHECK constraint already allows it (`db/migrations/zzzz20260414100000_extend_automation_rules.ts:47`). So `webhook.received` rules can be created and stored today.
- **But there is no path that dispatches them.** `TRIGGER_TYPE_BY_EVENT` (`automation-triggers.ts:61-66`) maps only `record.*`/`form.submitted`; `handleEvent` looks the incoming event up in that map and `return`s on a miss (`automation-service.ts:1350-1351`), and also early-`return`s when `sheetId`/`recordId` are absent (`:1344-1345`). The scheduler's `register()` explicitly skips every non-schedule trigger (`automation-scheduler.ts:508-511`). A grep confirms zero inbound routes. Both the event path and the schedule path are dead ends for this trigger — it is fully inert.

### Scope — what gets built

1. **One ingestion route**, added inside `createAutomationRoutes` (`routes/automation.ts:151`):
   `POST /api/multitable/automation/webhook/:ruleId` — unauthenticated by session JWT, authenticated by an HMAC signature over the raw request body bound to a timestamp.
2. **One service method** `AutomationService.ingestWebhook(...)` that fetches the rule, verifies the signature + freshness, and dispatches it by calling the existing `executeRule` directly (NOT `handleEvent`). Returns a discriminated `{ status, code } | { execution }` result, mirroring `resumeExecution`/`retryExecution` (`routes/automation.ts:363-402`, `:309-358`).
3. **Raw-body capture** for that path only (path-scoped `express.json({ verify })` mounted before the global parser), because HMAC must run over the exact bytes the client signed.
4. **Auth bypass**: add the path prefix to `AUTH_WHITELIST` so the global `/api/**` JWT gate lets it through (the route does its own crypto).
5. **Audit**: accepted requests produce the existing `AutomationExecution` log row (already redacted at persist); rejected requests emit a structured security log line + a metric counter (`automation_webhook_rejected_total{reason}`).

**Out of scope (non-goals):** any change to the outbound webhook delivery system (`webhook-service.ts`, `webhook-event-bridge.ts` stay untouched); EventBus emission for webhook ingestion (we call `executeRule` directly, never re-enter `handleEvent`/`TRIGGER_TYPE_BY_EVENT`); a nonce/dedup store; secret encryption-at-rest; async/queued dispatch; multi-rule fan-out (one rule per `:ruleId`); any frontend rule-editor UI for the secret/endpoint; making `webhook.received` fire on internal record events.

### Contract

**Request** — `POST /api/multitable/automation/webhook/:ruleId`

Headers:
- `X-MS-Webhook-Timestamp: <unix-epoch-seconds>` — required.
- `X-MS-Webhook-Signature: sha256=<hex>` — required; `hex = HMAC_SHA256(secret, "${timestamp}.${rawBody}")`.
- `Content-Type: application/json`.

Body: arbitrary JSON object. It becomes the execution's `recordData`; an optional top-level `recordId` string is honored if present.

**Signing input binds the timestamp — this is the security spine.** The existing outbound helper `WebhookService.signPayload(body, secret)` signs the **body only** (`webhook-service.ts:630-632`) and sends `X-Webhook-Timestamp` **unsigned** (`webhook-service.ts:358,364`). Reusing that verbatim and bolting on a freshness check gives **zero** replay protection: a captured `(body, signature)` pair replays under any fresh timestamp. The inbound scheme therefore signs `"${timestamp}.${rawBody}"`, a deliberate **divergence** from `signPayload` (the helper is reused only for the inner `createHmac('sha256', …)` primitive, not its message framing).

**Verification order (in `ingestWebhook`, all failures collapse to one response):**
1. `getRule(ruleId)` (`automation-service.ts:854-863`; `mapRow` hydrates `trigger_config` incl. `secret`, `:1991-2008`). Reject if rule is missing, `trigger_type !== 'webhook.received'`, `enabled === false`, or `trigger_config.secret` is empty.
2. Parse `X-MS-Webhook-Timestamp`; reject if non-numeric or `|nowSeconds - ts| > 300`.
3. Recompute HMAC over `"${ts}.${rawBody}"`; compare against the header with `crypto.timingSafeEqual` (length-checked first). Reject on mismatch.
4. **Every reject class returns an identical `401 { ok: false }`** — no distinct codes/messages, so an unauthenticated caller cannot probe rule existence/enabled-state.

**Success:** build a synthetic event and dispatch:
```ts
const event: AutomationEventPayload = {           // shape per automation-service.ts:520-528
  sheetId: rule.sheet_id,
  recordId: typeof body.recordId === 'string' ? body.recordId : '',
  data: body,                                      // → context.recordData (executor :812)
  actorId: rule.created_by ?? null,
  _triggeredBy: 'webhook',                         // → execution.triggeredBy (executor :789)
}
const execution = await this.executeRule(toExecutorRule(rule), event)  // service :1372
```
Respond `202 { ok: true, executionId }`. **Step outputs are never returned** to the unauthenticated caller.

**New `ingestWebhook` signature** (discriminated result, like `resumeExecution`):
```ts
async ingestWebhook(input: {
  ruleId: string
  rawBody: Buffer | string
  signatureHeader?: string
  timestampHeader?: string
  parsedBody: Record<string, unknown>
  nowMs?: number                                   // injectable clock for tests
}): Promise<{ status: number; code: string } | { execution: AutomationExecution }>
```

**Real `file:line` anchors this contract extends:**
- `routes/automation.ts:151-166` — `createAutomationRoutes` + `getService` 503 guard (new route slots in here, no `requireAdminRole`).
- `routes/automation.ts:363` — the resume route's header notes a "public/webhook surface is DEFERRED". That deferred surface is the *resume-callback* webhook (resuming a suspended execution via a single-use token) and stays deferred; it is **not** this rung. The reference only shows the codebase already anticipates a signature-authenticated inbound surface — this rung builds a *sibling* inbound surface for the `webhook.received` trigger, on its own path, with signature auth in place of `requireAdminRole`.
- `automation-service.ts:1372-1400` — `executeRule` is the dispatch entry reused unchanged.
- `automation-service.ts:1958-1972` — `testRun` is the structural model for "fetch rule → `toExecutorRule` → synthetic `AutomationEventPayload` → `executeRule`".
- `automation-executor.ts:806-816` — context build: `recordData ← payload.data`, `actorId ← payload.actorId`, `ruleCreatedBy ← rule.createdBy` (`:813`); `:789` `triggeredBy ← _triggeredBy`.
- `index.ts:967` then `:970` — path-scoped `express.json({ verify })` MUST be mounted before the global `express.json({ limit:'10mb' })` (the attendance-import precedent at `:967`); the `verify` hook stores `req.rawBody = buf`.
- `index.ts:994-1005` — global JWT gate; `isWhitelisted(req.path)` short-circuits it (`:996`).
- `jwt-middleware.ts:6-28,42-44` — `AUTH_WHITELIST` (prefix match); add `'/api/multitable/automation/webhook/'`, exactly the `'/api/plm-embed/'` self-authenticating precedent at `:27`.

### Runtime / round-trip semantics

- **Userless dispatch under rule authority.** There is no live session user. The execution runs as the rule author: `actorId = rule.created_by`, and downstream record writes use `context.ruleCreatedBy` (`executor:813`) — identical to how scheduled triggers already run userless. Owner must accept that webhook-triggered side effects execute as the rule's author.
- **Conditions still apply.** `executeRule → executor.execute` evaluates `rule.conditions` against `context.recordData` (= the webhook body), so condition filters work as for any trigger.
- **Canonicalization-free.** HMAC is over `req.rawBody` bytes, never `JSON.stringify(parsed)`; a sender's exact bytes are authoritative regardless of key order/whitespace.
- **At-least-once / replay residual.** With timestamp-freshness-only (no nonce table, the v1 default), a request replayed within the 300s window re-dispatches and re-runs side effects; downstream action idempotency is the operator's responsibility. Documented residual risk.
- **Recursion guard.** The synthetic event omits `_automationDepth`, so it starts at 0 — same as a real external event.

### Test plan

All tests drive the **real mounted Express route + real DB log**, not hand-built fixtures (DB-gated `describe`, per the existing `multitable-automation-start-approval-http.test.ts` pattern).

1. **FAIL-FIRST (RED before the change):** create an enabled `webhook.received` rule with a secret; `POST /api/multitable/automation/webhook/:ruleId` with a correctly signed body → assert **202** + a new `AutomationExecution` row via `svc.logs.getByRule(ruleId)`. This is RED today because the route returns **404** (route absent). Goes GREEN only with the route wired.
2. **Real-wire canonicalization (wire-vs-fixture trap):** send a body with NON-canonical JSON (extra whitespace + reordered keys); compute the signature over the EXACT bytes sent; assert **202** + an execution row. A handler that re-serialized `req.body` would compute a different digest and 401 — this proves `req.rawBody` is used.
3. **Reject creates no side effect:** sign a body, then flip one body byte (or use the wrong secret) before sending → assert **401** AND `svc.logs.getByRule(ruleId)` shows **no new row** (nothing dispatched).
4. **Replay window:** reuse a captured valid `(timestamp, body, signature)` with `timestamp` older than 300s (inject `nowMs`) → **401**.
5. **Oracle uniformity:** unknown `ruleId`, a disabled rule, a non-`webhook.received` rule, and a `webhook.received` rule with **no secret** (decision 2's fail-closed path) each return an **identical 401 body** (no existence/state leak).

### Open owner decisions

1. **Signature scheme binds the timestamp.** *Default:* `HMAC-SHA256(secret, "${unixSeconds}.${rawBody}")`, sent as `X-MS-Webhook-Signature: sha256=<hex>` + `X-MS-Webhook-Timestamp`, compared with `timingSafeEqual` — a deliberate divergence from outbound `signPayload` (body-only, `webhook-service.ts:630`).
2. **Secret-less `webhook.received` rule = fail-closed.** `WebhookReceivedConfig.secret` is optional (`automation-triggers.ts:49`). *Default:* a rule with no secret is **not ingestable** (uniform 401), and a non-empty secret becomes **required at rule-save** for `webhook.received`. Never accept unsigned inbound.
3. **Response-code oracle.** *Default:* one uniform `401 { ok:false }` for all of {unknown rule, wrong trigger type, disabled, secret-less, stale timestamp, bad signature} — no existence/enabled-state leak to an unauthenticated caller.
4. **Replay-defense depth.** *Default:* signed-timestamp + ±300s freshness window only; nonce/dedup store **deferred** (would add a migration). Residual in-window replay risk is accepted and documented; downstream action idempotency is the operator's responsibility.
5. **Dispatch authority.** *Default:* webhook-triggered actions run **userless under the rule author** (`rule.created_by` → `context.ruleCreatedBy`, `executor:813`), identical to scheduled triggers. Owner must accept that webhook side effects execute as the rule author.
6. **Secret at rest.** *Default:* `trigger_config.secret` stays **plaintext** in `automation_rules.trigger_config` JSONB (parity with the outbound webhook secret), redacted in any rule-read API that surfaces `trigger_config`; encryption-at-rest **deferred** (would add a migration).
7. **Audit-trail persistence (task-named open decision).** *Default:* accepted requests → the existing redacted `AutomationExecution` row; rejected requests → a structured security log line + `automation_webhook_rejected_total{reason}` metric; **no new queryable audit table in v1** (a reject-audit table would add a migration). Owner decides whether log+metric is enough to investigate attack patterns or a queryable record is required.
8. **Sync vs async dispatch.** *Default:* synchronous inline dispatch (like `testRun`), respond 202 after the executor returns; no queue in v1. Trade-off: a slow/abusive action ties up a request worker.
9. **Rate limit + body cap.** *Default:* per-rule inbound rate limit via the existing `RateLimitStore` (e.g. 60/min/rule) + a 1 MB body cap on the webhook path (below the global 10 MB at `index.ts:970`).

### Dependencies + migration

- **Deps:** none new — Node `crypto` (`createHmac`, `timingSafeEqual`) and `express` only.
- **Files touched:** `automation-service.ts` (new `ingestWebhook`, reusing the same-module `toExecutorRule`), `routes/automation.ts` (new route), `index.ts` (path-scoped raw-body parser + ordering), `jwt-middleware.ts` (`AUTH_WHITELIST` entry). `automation-triggers.ts` is reused unchanged.
- **Migration:** **none under the proposed defaults** — `webhook.received` is already a valid trigger_type and the secret already lives in `trigger_config` JSONB. Choosing the non-default for decision 4 (nonce/dedup store), decision 6 (secret encryption), or decision 7 (queryable reject-audit table) would each add one migration.

---

## T1-3 — approval.* automation trigger

**Size: M · design-lock-first · decisionClean = false** (cross-tenant routing + loop guard + record-less semantics are all owner calls; see Open Decisions).

### Problem / one line
An approval completion event already exists and is already consumed, but ONLY to resume a suspended automation that itself started the approval (the W6/W7 "bridge" path). There is no way to say *"when ANY approval of template X reaches a terminal outcome, run automation rule Y."* This rung promotes the completion event to a first-class rule trigger.

### What exists today (real anchors — read, not invented)
- The completion event is emitted on the in-process bus for every terminal transition: `emitApprovalCompletionEvent` → `eventBus.emit(event.eventType, event)` (`packages/core-backend/src/services/ApprovalCompletionEvent.ts:123-131`). Event types are `approval.approved | approval.rejected | approval.revoked | approval.cancelled` (`ApprovalCompletionEvent.ts:7-11`). The payload shape `ApprovalCompletionEventV1` carries `approval.{instanceId,requestNo,templateId,templateVersionId,publishedDefinitionId,businessKey,workflowKey}`, `transition.toStatus`, `actor`, `requester` — and crucially **no `sheetId`, no `recordId`, and no `_automationDepth`** (`ApprovalCompletionEvent.ts:45-68`).
- `AutomationService.init()` subscribes to all four `approval.*` events and routes them to `handleApprovalCompletionEvent` (`packages/core-backend/src/multitable/automation-service.ts:734-744`). That handler is the bridge-resume path: it `claimCompletion(event)` and **returns immediately if no bridge claims it** (`automation-service.ts:1667-1668`). `claimCompletion` only matches a row with `status='pending'` (`automation-approval-bridge-service.ts:312-327`) — i.e. an approval an automation previously *started*. A human-started approval has no bridge and is therefore dropped today.
- The generic rule-trigger dispatcher `handleEvent` is **sheet-scoped**: it needs `sheetId && recordId` (`automation-service.ts:1344-1345`), maps the event name via `TRIGGER_TYPE_BY_EVENT` (which has only the 4 record/form events, `automation-triggers.ts:61-66`), then `loadEnabledRules(sheetId)` (`automation-service.ts:1347`, query at `:1977-1987`), `matchesTrigger`, `executeRule`. None of this is reachable for `approval.*` because (a) `TRIGGER_TYPE_BY_EVENT` has no approval entry and (b) approval events have no sheet.
- The trigger-type contract surfaces: `AutomationTriggerType` union + `ALL_TRIGGER_TYPES` (`automation-triggers.ts:6-27`) and the service-side guard `VALID_TRIGGER_TYPES` (`automation-service.ts:62-73`) — **none contain any `approval.*` type today.** `createRule`/`updateRule` reject unknown trigger types (`automation-service.ts:755-757, 884-885`).
- Precedent for executing a rule against a synthetic (non-record-mutation) event: `testRun` builds a synthetic `AutomationEventPayload` and calls `executeRule` (`automation-service.ts:1958-1972`). `AutomationEventPayload` = `{ sheetId, recordId, data?, changes?, actorId?, _automationDepth?, _triggeredBy? }` (`automation-service.ts:520-528`).
- Depth guard: `MAX_AUTOMATION_DEPTH = 3` (`automation-service.ts:51`), enforced in `handleEvent` off `payload._automationDepth` (`:1338-1342`); the W7 backwrite already threads `_automationDepth + 1` into its fan-out (`:1819-1828`).

### Scope — what gets built
1. **Trigger type.** Add `approval.completed` to `AutomationTriggerType` + `ALL_TRIGGER_TYPES` (`automation-triggers.ts:6-27`) and to `VALID_TRIGGER_TYPES` (`automation-service.ts:62-73`). Add a config interface `ApprovalCompletedConfig { templateId: string; outcomes?: ApprovalCompletionOutcome[] }` alongside the other config shapes in `automation-triggers.ts:29-51`. (Single trigger type + outcomes filter is the proposed default — see Open Decision 6.)
2. **Independent fan-out dispatch.** In the `init()` subscription callback for the four `approval.*` events (`automation-service.ts:734-744`), invoke a NEW `dispatchApprovalTriggerRules(event)` **as a sibling of `handleApprovalCompletionEvent`, NOT chained after it** — both run for the same event. This keeps the existing **8** bus subscriptions (the wire asserted at `tests/unit/multitable-automation-service.test.ts:330`) and, critically, makes the fresh trigger fire even when `handleApprovalCompletionEvent` early-returns at `:1668` because there is no bridge (the human-started case T1-3 exists for).
3. **Cross-sheet routing.** Add `loadEnabledApprovalRules(templateId)` = `SELECT ... FROM automation_rules WHERE enabled AND trigger_type='approval.completed' AND trigger_config->>'templateId' = $1` (cross-sheet sibling of the sheet-scoped `loadEnabledRules` at `:1977-1987`). `templateId` is the routing key (Open Decision 1) and is reliably populated on the event for both bridged and human-started approvals (`ApprovalInstanceRow.template_id` is typed non-null, `ApprovalProductService.ts:145,162`; fed into the event at `:3141` and via `buildCompletionEvent` at `:4232`).
4. **Outcome filter + execution.** For each matched rule, filter on `event.transition.toStatus` against `config.outcomes` (default `['approved']`) — a small approval-specific check mirroring `matchesTrigger` (`automation-triggers.ts:71-96`). On match, run `executeRule(execRule, syntheticApprovalEvent)` where `syntheticApprovalEvent: AutomationEventPayload` = `{ sheetId: rule.sheet_id, recordId: '', data: {}, actorId: event.actor?.id ?? event.requester.id ?? null, _automationDepth, _triggeredBy: 'approval_trigger' }` with the full completion event passed through as the executor `triggerEvent` so action templates can read `{{trigger.approval.requestNo}}`, `{{trigger.transition.toStatus}}`, etc. (template plumbing mirrors `buildTemplateData`, `automation-approval-bridge-service.ts:123-134`).
5. **Action allowlist for this trigger.** At create/update, reject an `approval.completed` rule whose actions include any record-targeting action (`update_record`/`create_record`/`delete_record`/`lock_record`) or `start_approval`; allow only `send_notification`/`send_webhook`/`send_email`/`send_dingtalk_*` (Open Decisions 3 & 4). Validation slots beside the existing per-action validators (e.g. `validateStartApprovalConfig`, `automation-service.ts:148`).
6. **Loop/depth + dedup.** Seed `_automationDepth` from the bridge's stored trigger event when present (`(bridge.triggerEvent._automationDepth ?? 0) + 1`, mirroring `:1821`), else `0`; combined with the action allowlist this closes both cycle classes. Dedup the fresh-trigger path on `event.eventId` (already unique, `ApprovalCompletionEvent.ts:97`) (Open Decision 5).

### Runtime / round-trip semantics
- **Both consumers run per event, independently.** `bus.emit('approval.approved', event)` → the single subscription callback calls (a) `handleApprovalCompletionEvent` (resumes a waiting bridge, or no-ops if none) AND (b) `dispatchApprovalTriggerRules` (fires fresh `approval.completed` rules). Neither path's outcome gates the other.
- **The fresh-trigger path is the ONLY path that fires for human-started approvals** (no bridge → `handleApprovalCompletionEvent` returns at `:1668`). This is the load-bearing semantic: appending the dispatch *after* the bridge logic instead of as a sibling would silently never fire for the primary use case.
- **Round trip for an authored rule:** author creates an `approval.completed` rule on sheet S with `config={templateId:'tpl_x', outcomes:['approved']}` and a `send_notification` action → a human approves an instance of `tpl_x` → `ApprovalProductService` emits `approval.approved` → `dispatchApprovalTriggerRules` loads the rule cross-sheet by `templateId`, passes the outcome filter, executes → `automation.notification` is emitted with the templated message. Rejected/revoked/cancelled outcomes are filtered out unless listed in `config.outcomes`.

### Test plan
- **FAIL-FIRST, real wire (RED today):** construct `AutomationService` with a mocked DB returning one enabled rule `{trigger_type:'approval.completed', trigger_config:{templateId:'tpl_x', outcomes:['approved']}, action_type:'send_notification', action_config:{userIds:['u1'], message:'Approved {{trigger.approval.requestNo}}'}}`, call `service.init()`, spy on `bus.emit`, then **`bus.emit('approval.approved', <ApprovalCompletionEventV1 with approval.templateId='tpl_x', transition.toStatus='approved'>)`** and assert `emitSpy` was called with `'automation.notification'` carrying the rendered message. This goes RED on `main` because the event reaches `handleApprovalCompletionEvent`, finds no bridge, and returns at `automation-service.ts:1668` — nothing is emitted. It exercises the real subscription path (not a direct method call) and uses the existing `send_notification → automation.notification` emission as a fixture-free oracle (pattern at `tests/unit/multitable-automation-service.test.ts:97-102`).
- **Outcome filter:** same setup, `bus.emit('approval.rejected', ...)` ⇒ NO `automation.notification` (rejected not in `outcomes`); then with `outcomes:['approved','rejected']` ⇒ emits.
- **Subscription-count guard stays green:** assert `subscribe` still called 8× and `unsubscribe` 8× (the existing assertion at `tests/unit/multitable-automation-service.test.ts:330,365`) — proving the fan-out reused the existing approval.* subscription rather than adding a 9th.
- **Loop/dedup:** emitting the same `event.eventId` twice runs the rule once; an `approval.completed` rule containing `start_approval`/`update_record` is rejected at `createRule` with `AutomationRuleValidationError`.
- **Cross-tenant authorization:** a rule whose `createdBy` lacks read on `templateId` is skipped at fire time (or rejected at create — per Open Decision 2).

### Dependencies
- Reuses the live `ApprovalCompletionEventV1` emission (`ApprovalCompletionEvent.ts:123-131`) and the existing 4 approval.* subscriptions (`automation-service.ts:734-744`) — no new event contract, no new bus subscription, no new HTTP route.
- Reuses the executor + `automation.notification`/webhook/email action sinks unchanged.
- Editor/UI surfacing of the new trigger type is a thin follow-up (the enum addition makes it selectable; the audit's dev-plan tracks editor work separately).

### Non-goals (V1)
- No record-targeting actions from an approval trigger (no `update_record`/`create_record`/`delete_record`/`lock_record`, no W7-style result backwrite) — record-less only.
- No `start_approval` inside an `approval.completed` rule (structural loop break).
- No source-record / `businessKey` resolution to bind the trigger to a multitable record.
- No conditions (`ConditionGroup`) on `approval.completed` rules (Open Decision 8).
- No cross-base writes (that is T3-5); no rejection-specific backwrite (T3-4); no new DB migration unless Open Decision 1 selects the indexed variant.
- Brand-neutral: this is a MetaSheet capability requirement — "on an approval reaching a terminal outcome, run a multitable automation rule" — independent of any specific approval product.

---

## T1-4 — Node field-permissions readonly/editable + authoring UI

### Summary / problem
A node's `fieldPermissions` array (`ApprovalNodeConfig.fieldPermissions?` — `types/approval-product.ts:85-89`) already supports three access values — `editable | readonly | hidden` (`NodeFieldAccess`, `approval-product.ts:48`). Two gaps:

1. **Runtime:** only `hidden` is enforced — server echo-redaction strips hidden fields from the `formSnapshot` echoed in read DTOs while the instance is AT the hiding node (`approval-form-redaction.ts:40-77`, gated on `permission.access === 'hidden'` at `:59`; wired into `toUnifiedDTO` at `ApprovalBridgeService.ts:139-143`). `readonly`/`editable` are declared but **runtime-inert** (`approval-product.ts:41-46`).
2. **Authoring:** **none** of the three are UI-authorable. Today a node only gets `fieldPermissions` via a raw graph POST. The linear steps editor drops them on save and fail-closes the whole template if it sees them.

This design-lock builds the **unblocked half**: make `hidden` end-to-end UI-authorable in the linear editor. It does **not** build `readonly`/`editable` enforcement — that is blocked on the edit-form-at-node prerequisite (see Open decisions).

### Why readonly/editable runtime is blocked (load-bearing fact)
`form_snapshot` is **write-once at create**. The create insert writes it (`ApprovalProductService.ts:3090`); every later `UPDATE approval_instances` (verified: `:3329, :3595, :3658, :3715, :3808, :3854, :3907, :4045, :4053, :4062`) sets status/version/node columns — **none writes `form_snapshot`**. No dispatch branch edits form values. With no path that edits the form mid-flow, `readonly` is observationally identical to `editable` and to plain display. Therefore "add runtime for readonly/editable" is not implementable without first building edit-form-at-node. That direction is the **open owner decision**; this rung leaves the two values inert (contract-stable, normalized-through).

### Scope — what gets built (FE-only)
The backend already accepts, shape-validates (`normalizeNodeFieldPermissions`, `ApprovalProductService.ts:893-922` — keeps all three values, trims/dedupes `fieldId`, rejects bad `access`/dup), cross-validates every `fieldId` against the version's form schema (`validateNodeFieldPermissionsAgainstFormSchema`, `:950-968`), and emits `fieldPermissions` for **every** approval node uniformly inside `normalizeApprovalGraph` (`:1032-1048`). "Linear vs complex" is purely an FE editor distinction — the backend does not care which editor produced the graph. So **no backend change** is required; this rung is FE-only.

Build, in `apps/web/src/approvals/`:
- **Draft model:** add `fieldPermissions?: NodeFieldPermission[]` to `ApprovalStepDraft` (`templateAuthoring.ts:115-141`).
- **Hydrate:** in `stepDraftFromApprovalNode` (`:341-407`) read `config.fieldPermissions` into the draft (keep only entries whose `fieldId` exists in the draft fields; preserve `access` verbatim so a future readonly/editable entry authored via API survives a linear round-trip).
- **Emit:** in `buildStepConfig` (`:825-841`) append `...(perms.length ? { fieldPermissions: perms } : {})`, omit-empty (mirrors the existing `autoApprovalPolicy` omit-empty discipline at `:839`).
- **Unblock the linear allowlist:** add `'fieldPermissions'` to the linear `allowedConfigKeys` in `unsupportedTemplateAuthoringReason` (`:647-654`). Today a linear approval node carrying `fieldPermissions` is outside that allowlist → returns `节点含暂不支持的配置` → whole template opens read-only with save disabled (`:644-666`). Once `buildStepConfig` emits it, the file-level warning at `:484-488` ("the two allowlists must stay SEPARATE … buildStepConfig does NOT preserve fieldPermissions") is resolved and the key is safe to allowlist.
- **UI:** a per-step "在此节点隐藏的字段 / fields hidden at this node" multi-select in each linear step row (`TemplateAuthoringView.vue:919-1046`, alongside `approvalMode`/`emptyAssigneePolicy`/`mergeWithRequester`), options = the draft's top-level fields, selection → `step.fieldPermissions = [{ fieldId, access: 'hidden' }]`. New stable `data-testid="approval-step-field-permissions"`.

### Non-goals (explicit)
- **edit-form-at-node** and any `readonly`/`editable` **runtime** — deferred to a separate gated rung (see decision 1). `readonly`/`editable` remain inert, forward-stable enum members.
- **Complex-graph** (cc/condition/parallel or non-linear) field-permission authoring — stays read-only-preserved via `BACKEND_PRESERVED_COMPLEX_APPROVAL_CONFIG_KEYS` (`templateAuthoring.ts:489-497`, incl. `fieldPermissions` at `:496`) + `applyApprovalNodeEditsToGraph` spread-original-first (`approvalNodeEdit.ts:81-94`). G-5 edits only `assigneeSources`; field-permissions there is a later slice.
- **No DB migration / no schema change** — `fieldPermissions` lives inside the graph JSONB; existing instances/templates (absent the key) are byte-for-byte unchanged.
- **No new permission** — authoring stays gated by `approval-templates:manage` (`APPROVAL_PRODUCT_PERMISSIONS`, `approval-product.ts:1-8`).
- **No OpenAPI change** — the approval-graph node `config` is intentionally loosely typed (`additionalProperties: true`); the TS types are the contract of record.

### Contract / round-trip semantics
- `NodeFieldPermission = { fieldId, access }`, `access ∈ {editable, readonly, hidden}` (`approval-product.ts:48-53`) — unchanged; this rung makes `hidden` reachable from the linear editor.
- Round-trip: `draftFromTemplate(template-with-linear-hidden-perm)` → step draft carries the permission → `buildApprovalGraph` (`templateAuthoring.ts:843-879`) reproduces `config.fieldPermissions` byte-identical; `unsupportedTemplateAuthoringReason` now returns `null` for that template (it is authorable, no longer read-only).
- Redaction semantics unchanged: instance-keyed (NOT viewer-keyed) — every reader (approver, requester, observer, admin) sees the same redacted snapshot while AT a hiding node; the field reappears once the instance advances past it; the stored `form_snapshot` is never mutated (`approval-form-redaction.ts:13-38`). A node with only `editable`/`readonly` entries hides nothing (`:32-33`).
- Default proposal for hiding a `required` field: ALLOW — the value is already captured at create, redaction is echo-only, so there is no submit-time conflict.

### Test plan (fail-first; assert the REAL wire)
**FAIL-FIRST #1 — FE builder round-trip (RED today):** in `apps/web/tests/approvalTemplateAuthoring.spec.ts`, build a linear draft with a field `amount` and a step whose `fieldPermissions = [{ fieldId: 'amount', access: 'hidden' }]`, call the REAL `buildApprovalGraph(draft)` and assert the emitted `approval_1` node has `config.fieldPermissions` deep-equal `[{ fieldId: 'amount', access: 'hidden' }]`. RED today (`ApprovalStepDraft` has no such field and `buildStepConfig` never emits it) → GREEN after.

**FAIL-FIRST #2 — the flip (RED today):** assert `unsupportedTemplateAuthoringReason(linearTemplateWithHiddenPerm) === null`. Today returns `暂不支持的配置`. This is the inverse of the three existing tests that LOCK the current fail-closed behavior and must be **rewritten** to the new contract: `approvalTemplateAuthoring.spec.ts:339-368` ("fails closed … no node-field editor yet"), `approvalTemplateAuthoring.spec.ts:718` (combo A2 fail-closed), and `approval-template-authoring-graph-preserve.test.ts:294-319` (linear fieldPermissions fail-closed).

**FAIL-FIRST #3 — real wire end-to-end through HTTP+DB (RED today):** extend `packages/core-backend/tests/integration/approval-p1c-field-permissions.api.test.ts` to author the template from a FE-built payload — `buildCreateTemplatePayload(draft)` where `draft` is the same draft as #1 — NOT a hand-built raw graph, then publish → create with `{ reason, secret }` → GET `/api/approvals/:id` and assert the detail echo `not.toHaveProperty('secret')` while keeping `reason`. RED today because the FE payload omits `fieldPermissions` so nothing is hidden. This routes the FE builder output through the real backend normalize + redaction (DB-backed lane, `describeIfDatabase`).

**Component (real UI→payload wire):** mount `TemplateAuthoringView`, select `amount` in the new per-step hidden-fields control, and assert `buildCreateTemplatePayload`/`buildUpdateTemplatePayload` (the exact functions the save button calls, `templateAuthoring.ts:1046+`) carries `approvalGraph.nodes[…].config.fieldPermissions`.

### Dependencies
- Blocking the runtime half only: **edit-form-at-node** (write-once `form_snapshot` today). Not blocking the authoring half built here.
- Reuses existing, shipped substrate: backend normalize/cross-validate (`ApprovalProductService.ts:893-968, :1032-1048`), redaction (`approval-form-redaction.ts`), bridge wiring (`ApprovalBridgeService.ts:139-143`), the linear authoring pipeline (`templateAuthoring.ts`), and the `approval-web-guard` vitest gate (the touched FE modules are `.vue`-free except the view).

---

## T2-1+2 — Scoped approval administrators + handover (bulk reassign)

### Scope

**Build (this rung):**

1. **Scoped-admin capability split.** Carve today's single monolithic admin grant into three *capability* permission codes so an org can hand someone template authoring, or process recovery, or data recovery, without giving them everything. Also fix a latent contract drift: `approvals:admin` is guard-used and DB-seeded but is **not** in the canonical permission list.
2. **Admin handover / bulk reassign.** A new admin-only endpoint that reassigns a (departing / role-changed) user's *active* approval assignments to another user across many in-flight instances in one call, fully audited, returning a per-instance success/skip manifest. This generalizes the existing single-instance, self-initiated `transfer` action into an admin-initiated, recovery-style batch built on the `adminJump` discipline (`FOR UPDATE` + version bump + audit row + domain event).

**Do NOT build (explicit non-goals — see below):** row-level data-scoping (an admin limited to a dept / category / template-set), a frontend handover UI, re-resolution of the approval graph during handover, and any change to who can run the *single-instance* `transfer` action.

### Contract

**Permission model — `packages/core-backend/src/types/approval-product.ts:1-6`** currently declares exactly four flat codes:

```
APPROVAL_PRODUCT_PERMISSIONS = ['approvals:read','approvals:write','approvals:act','approval-templates:manage']
```

`approvals:admin` is **absent here** yet is the live guard on `routes/approvals.ts:1359` (`POST /api/approvals/:id/jump`) and `routes/approval-metrics.ts:65,83,102`, and is seeded into the `permissions` / `role_permissions` tables by `db/migrations/zzzz20260515130000_add_jump_action_to_approval_records.ts:5,31-49`. This rung adds the new codes **and** backfills `approvals:admin` so the constant matches reality:

- `approvals:admin` (process / recovery — keep as umbrella; existing)
- `approvals:admin-templates`
- `approvals:admin-data`

All three deliberately keep the existing **non-namespaced `approvals` resource prefix** (`rbac/namespace-admission.ts:11-38` lists `approvals` in `NON_NAMESPACED_PERMISSION_RESOURCES`). This is load-bearing: `derivePermissionNamespace` (`namespace-admission.ts:139-142`) → `userHasEffectiveNamespaceAccess` (`:300-313`) gate any *namespaced* resource behind both a `<ns>_admin` role AND an enabled `user_namespace_admissions` row, so a brand-new prefix such as `approval-process:` would be **dead-on-arrival for directly-granted non-admins**. The accepted trade-off: the `approvals:*` wildcard (`rbac/rbac.ts:21-25`) grants all three scopes at once.

**New endpoint** (modeled on the `approvals:admin`-guarded jump route at `routes/approvals.ts:1359`, NOT on the self-service action dispatcher at `routes/approvals.ts:1428`):

```
POST /api/approvals/admin/reassign
  guard:  authenticate + rbacGuard('approvals:admin')
  body:   { fromUserId: string, toUserId: string, reason: string, instanceIds?: string[] }
  200:    { ok: true, data: { succeeded: string[], skipped: { id: string, reason: string }[] } }
```

Actor identity/permissions resolve through the existing helpers `resolveApprovalActorId/Roles/Permissions` (`routes/approvals.ts:98-130`).

**Service method** `ApprovalProductService.bulkReassign(...)` — extends the per-instance recovery pattern of `adminJump` (`services/ApprovalProductService.ts:3198-3425`): `client.connect()` → per instance `BEGIN` → `SELECT ... FOR UPDATE` (`:3213`) → terminal/active guards (`:3228-3246`) → reassign → audit row → `COMMIT`. The reassign body itself reuses the proven single-transfer primitives:

- `deactivateActorAssignmentsAtNode` (`:4377-4396`) — deactivate the fromUser's active row(s) at the node.
- `executor.buildTransferAssignments` (`services/ApprovalGraphExecutor.ts:770-778`) — build the toUser's static `user` assignment at the same node/step. **Note this drops `resolvedFrom`/`delegatedFrom`** (a documented semantic, below).
- `insertAssignments` (`:4398-4419`) and `insertApprovalRecord` (`:4555-4581`).

**Migration** (follows `zzzz20260515130000:31-49` and `zzzz20260616130000:34-46` exactly): (a) INSERT the three permission rows `ON CONFLICT (code) DO NOTHING` guarded by `checkTableExists`, (b) grant them to the `admin` role in `role_permissions`, (c) extend `approval_records_action_check` to add a new `reassign` action value. `down()` deletes the role/permission rows and re-adds the CHECK as `NOT VALID`.

### Runtime / round-trip semantics

- **Per-instance, best-effort.** Each instance is its own transaction; a stale/terminal/now-unassigned instance is **skipped** (manifest reason, e.g. `terminal`, `not-assigned`, `version-conflict`), never aborting the batch. Re-running is intrinsically idempotent — once X is no longer active, the instance is skipped.
- **Version bump.** Each reassigned instance bumps `approval_instances.version` (the single-instance `transfer` branch at `services/ApprovalProductService.ts:3537-3560` does **not** bump version — confirmed; this rung diverges deliberately so optimistic-concurrency consumers observe the handover).
- **Audit action `reassign`** is written outside the `ApprovalActionType` union (`approval-product.ts:16-24`), exactly as the existing `'jump'` audit action is — admin audit actions are not `dispatchAction` actions. A new value (vs reusing `transfer`) keeps the revoke-window "node already handled" check at `services/ApprovalProductService.ts:3698-3708` (which counts `action IN ('approve','reject','transfer')`) uncontaminated by admin handovers.
- **Literal swap.** The toUser becomes a plain static `user` assignment; no graph re-resolution; `metadata.adminReassign=true` + `metadata.reassignedFrom=<fromUserId>` are stamped for trace.
- **SoD guards** (fail-closed): refuse when `toUserId === requester_snapshot.id` or `toUserId` is already an active assignee at that node.
- **Count refresh + event.** After the batch, `publishApprovalCountsForUsers` for fromUser, toUser and affected requesters (mirrors the admin-jump refresh at `routes/approvals.ts:1408-1416`), and a new `approval.bulk_reassigned` event is emitted (mirrors `eventBus.emit('approval.admin_jumped', …)` at `:3417-3418`).

### Test plan

Harness already exists: integration tests boot `MetaSheetServer`, mint a token via `/api/auth/dev-token?roles=&perms=` (`routes/auth.ts:47-77`), make real HTTP calls and read back real DB rows; `tests/setup.integration.ts:8` sets `RBAC_TOKEN_TRUST=true`, so the token `perms` claim is honored and guards are genuinely exercised (pattern: `tests/integration/approval-wp1-parallel-gateway.api.test.ts:1-66`).

1. **FAIL-FIRST, real wire (positive).** `describeIfDatabase`: mint an admin token, create a published-template approval over HTTP so user X is an active assignee, then `POST /api/approvals/admin/reassign { fromUserId:X, toUserId:Y, reason }`. Assert against the **database**, not fixtures: in `approval_assignments` X's row is `is_active=false` and a `Y` row is `is_active=true` at the same `node_key`; in `approval_records` a row with `action='reassign'`, `actor_id=<admin>`, `target_user_id=Y`, `metadata.adminReassign=true`, `metadata.reassignedFrom=X`; and `approval_instances.version` incremented. RED today (no route → 404 → no DB rows; and `approval_records_action_check` would reject `'reassign'` even if inserted).
2. **Negative guard (real wire).** Same setup with a non-admin token (`roles=user&perms=approvals:read`) → expect **403**. RED-meaningful because `RBAC_TOKEN_TRUST` makes the guard actually evaluate the claim.
3. **SoD + skip-manifest unit** (mock-pg pattern of `tests/unit/approval-admin-jump-service.test.ts`): assert reassign-to-requester is refused; a terminal instance lands in `skipped` with the correct reason while a sibling instance succeeds; and a re-run of the same batch is a no-op (`not-assigned`).

### Dependencies

- RBAC stack: `rbac/rbac.ts` (guard + wildcard), `rbac/service.ts:36-72` (`userHasPermission`), `rbac/namespace-admission.ts` (resource-prefix gating constraint).
- Migration pattern + `permissions` / `role_permissions` / `approval_records_action_check` (existing migrations `zzzz20260515130000`, `zzzz20260616130000`).
- Service primitives in `ApprovalProductService.ts` (`adminJump`, `deactivateActorAssignmentsAtNode`, `insertAssignments`, `insertApprovalRecord`) and `ApprovalGraphExecutor.buildTransferAssignments`.
- Count/event plumbing (`publishApprovalCountsForUsers`, `eventBus`).

### Non-goals (explicit)

- **No row-level data-scoping** (admin limited to dept / category / template-set). Deferred to a later rung that should reuse the existing namespace-admission machinery, not a parallel scope table.
- **No frontend handover UI / admin "all approvals by assignee" browse surface** (current admin enumeration is instance-scoped only; the endpoint accepts explicit `instanceIds` or self-enumerates).
- **No graph re-resolution** during handover (literal swap only).
- **No change to the self-initiated single-instance `transfer` action** (`approvals:act`, `routes/approvals.ts:1428` → `ApprovalProductService.ts:3537-3560`).
- **No new resource-prefixed permission namespaces** (would trip namespace-admission gating).

---

## T2-3 — Person/team process analytics

### Scope
Template / instance / breach metrics already ship (overall + per-template duration, p50/p95, SLA breach rate). This rung adds **person** and **team** drill-down aggregations on top of the *same* `approval_metrics` rows, with no change to the write path.

**Person** = the approval **requester** (`approval_instances.requester_snapshot->>'id'` / `->>'name'`). **Team** = the requester's frozen **department** (`requester_snapshot->>'directoryDepartment'`, falling back to `->>'department'`). Both are read-only, admin-only aggregations that mirror the existing `byTemplate` shape (total / approved / rejected / revoked / avgDuration / slaBreachRate), grouped by the new dimension instead of `template_id`.

**Builds:**
- Service: two methods on `ApprovalMetricsService` (e.g. `getMetricsByRequester` / `getMetricsByDepartment`, or one `getMetricsByDimension('requester'|'department')`) returning a `MetricsDimensionRow[]` modeled on `MetricsSummaryTemplateRow`.
- Routes: `GET /api/approvals/metrics/people` and `GET /api/approvals/metrics/teams`, same `authenticate` + `rbacGuard('approvals:admin')` gates and `since`/`until`/`limit` parsing as the existing summary/report routes.
- Drill-down: optional `requesterId` / `department` query filter on the existing `/report` so an admin can scope slowest-instances/breaches to one person or team.

**Does NOT build (non-goals):** approver/actor-level aggregation (unnesting `node_breakdown[].approverIds`); any org/team **hierarchy** rollup (team = flat department string only); a live-directory re-query (uses the frozen snapshot); rich FE charts beyond a sortable table; any change to the metrics **write** path or `node_breakdown` schema.

### Contract (extends real anchors I read)
- **Aggregation pattern to mirror** — `getMetricsSummary` per-template GROUP BY at `packages/core-backend/src/services/ApprovalMetricsService.ts:366-391` (`GROUP BY template_id … ORDER BY COUNT(*) DESC LIMIT 100`) and its row→object mapping at `:406-418`. The new methods reuse the identical `COUNT(*) FILTER (WHERE terminal_state = …)` + `AVG(duration_seconds)` + SLA-rate shape, swapping the GROUP key.
- **JOIN + JSONB-extraction precedent (strongest anchor)** — `listBreachContextByIds` at `ApprovalMetricsService.ts:604-655` already does `FROM approval_metrics m LEFT JOIN approval_instances i ON i.id = m.instance_id` and reads `i.requester_snapshot` (name extraction at `:636-640`). The new queries extend exactly this JOIN to also `GROUP BY i.requester_snapshot->>'id'` / `->>'directoryDepartment'`.
- **Return types** — new `MetricsDimensionRow` modeled on `MetricsSummaryTemplateRow` (`ApprovalMetricsService.ts:50-58`) and surfaced like `MetricsReport` (`:98-102`); query input reuses `MetricsSummaryQuery` (`:115-120`) + `clampReportLimit` (`:136-138`).
- **Routes** — register beside the existing admin metrics routes at `packages/core-backend/src/routes/approval-metrics.ts:63-98` (note `rbacGuard('approvals:admin')` and the `resolveTenantId` / `parseDate` / `parseLimit` helpers at `:24-53`).
- **Team field source** — `requester_snapshot` is built at `packages/core-backend/src/services/ApprovalProductService.ts:3036-3053`: raw `department` at `:3040` (always present) and `directoryDepartment` at `:3041` (optional). The condition engine treats `directoryDepartment` as the canonical department (`:3061`; RA-1a attrs at `ApprovalConditionFormula.ts:54-67`) — hence the default groups on `directoryDepartment` with `department` fallback.
- **Schema baseline** — `approval_metrics` table + its four indexes at `packages/core-backend/src/db/migrations/zzzz20260425100000_create_approval_metrics.ts:39-86`. Indexes today cover `(tenant_id, terminal_at)`, `(template_id)`, and the SLA partials. **No index supports grouping by requester id or department** (both live in `approval_instances.requester_snapshot` JSONB, which has no expression index — confirmed: no `requester_snapshot` index in any migration). This is the schema/index decision this rung must flag (Decision 2).
- **OpenAPI parity (CI gate)** — the report schema lives at `packages/openapi/src/paths/approvals.yml:572-672`; the two new endpoints must be added there or the spec-parity check fails.

### Runtime / round-trip semantics
- Each `approval_metrics` row maps to exactly one requester ⇒ requester and department aggregations are **clean partitions** (no double-counting), unlike an approver dimension. The aggregate `total` over all buckets equals the summary `total`.
- Department is read from the **frozen** snapshot, so a post-hoc reorg does not retroactively re-bucket historical approvals (intended for historical analytics).
- Tenant scoping is driven by `approval_metrics.tenant_id` on the JOIN driver, so the requester/department join cannot leak rows across tenants even though `approval_instances` carries no tenancy column (documented semantic, not a gate).
- Null handling: `requester_snapshot` may be `{}` (migration default) and `directoryDepartment` may be absent ⇒ those rows fall into a null-keyed bucket (mirrors `templateId: null` at `ApprovalMetricsService.ts:410`).

### Test plan
**FAIL-FIRST (real wire, DB-backed):** new `packages/core-backend/tests/integration/approval-metrics-people-teams.test.ts` using the existing harness pattern — `const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip` and a no-silent-skip sentinel (`tests/integration/dept-head-sync-plumbing.test.ts:17,58-59`). Seed a real `approval_instances` row with `requester_snapshot = '{"id":"u-1","name":"Alice","directoryDepartment":"Engineering"}'::jsonb` and a real `approval_metrics` row (`instance_id`, `tenant_id`, `started_at`, `terminal_state='approved'`, `duration_seconds=120`). Call the new `getMetricsByDepartment({tenantId, since, until})` (or `GET /teams`) and assert a `{ department: 'Engineering', total: 1, approved: 1 }` bucket. This goes **RED** before the change (method/route absent) and — because it reads a real JSONB snapshot through real SQL, not a hand-built `byDepartment` fixture — it is the only test that catches the most likely bug here: extracting `->>'department'` vs `->>'directoryDepartment'` (wire-vs-fixture drift).

**Secondary (mocked Query, SQL-string contract):** in the style of `tests/unit/approval-metrics-service.test.ts:14-52`, assert the emitted SQL `JOIN approval_instances` and `GROUP BY` on the chosen `requester_snapshot->>…` expression and the `LIMIT`. This pins the contract but is explicitly **not** the real-wire bar.

**Router (gate + param plumbing):** extend `tests/unit/approval-metrics-router.test.ts` to assert `/people` and `/teams` enforce `authenticate` + `rbacGuard('approvals:admin')` (401/403) and forward parsed `since`/`until`/`limit` to the service — asserting the real call args, not a stubbed body.

### Dependencies & non-goals
**Deps:** new endpoints must be added to `packages/openapi/src/paths/approvals.yml` (parity gate); the fail-first integration test requires the `DATABASE_URL` lane (or a pg-mem dev dep — Decision 8); any chosen index/denormalization (Decision 2) is a new Kysely migration + (for denormalization) a backfill.

**Non-goals:** approver/actor analytics; team hierarchy/rollup; live-directory department resolution; cross-tenant department reconciliation; mutating the metrics write path. Each is a separately-gated follow-on.

> Not decision-clean: the new aggregation introduces a schema/index fork (Decision 2), a load-bearing department-field choice (Decision 3), and person-level PII/surveillance gating (Decision 4). See open decisions + proposed defaults.

---

## T2-4 — N-of-M threshold voting node mode

### Anchor correction
The brief cites `ApprovalGraphExecutor.ts` aggregation at `:3894-3969`. The executor is only 1233 lines and resolves graph *topology* (it carries an `aggregateMode` tag but never counts votes). The real per-node aggregation switch (modes `single`/`all`/`any`) lives in **`packages/core-backend/src/services/ApprovalProductService.ts:3894-3969`**. The executor's role is the mode *source* (`getApprovalMode`, `ApprovalGraphExecutor.ts:689-691`). Every anchor below was read in `metasheet2-audit` @ `7113f8b05`.

### Scope (what gets built)
Add a fourth approval-node aggregation mode, **threshold (N-of-M)**: a node with M assignees advances once **N distinct approvers** approve (1 ≤ N ≤ M), instead of one (`any`) or all (`all`). Concretely:
- New union member `'threshold'` on `ApprovalMode` and a new node-config field `approvalThreshold?: number` (the N).
- Publish-time validation of N (range + presence, gated on mode).
- Runtime aggregation: count distinct approvals at the node; while `distinct approvals < N` short-circuit the dispatch (instance stays `pending`, one non-completing `approve` record written); on the Nth approval, advance and cancel the remaining pending assignees (first-N-wins) with an audit trail.
- Type/contract lockstep across all mode-reader sites + OpenAPI enum.

**Out of scope (this rung):** authoring UI; threshold inside a parallel-gateway branch; a configurable reject/quorum-fail threshold (v1 keeps existing single-reject-rejects behavior); any SQL schema change.

### Contract — extends these REAL anchors
**Type surface (`packages/core-backend/src/types/approval-product.ts`)**
- `:13` `export type ApprovalMode = 'single' | 'all' | 'any'` → add `| 'threshold'`.
- `:78-90` `interface ApprovalNodeConfig` (has `approvalMode?: ApprovalMode` at `:82`) → add `approvalThreshold?: number`.
- `:106` resolution carrier `aggregateMode: 'single' | 'all' | 'any' | null` → add `'threshold'`.

**Executor (`packages/core-backend/src/services/ApprovalGraphExecutor.ts`)**
- `:44` `approvalMode: ApprovalMode` and `:106` `aggregateMode: 'single' | 'all' | 'any' | null` and `:820` context-param union → add `'threshold'`.
- `:285-287` local `normalizeApprovalMode` (`value === 'all' || 'any' || 'single' ? value : 'single'`) → accept `'threshold'`.
- **`:689-691` `getApprovalMode()` — SECURITY-CRITICAL.** It normalizes any unknown mode to `'single'`. If this site (or the union / `APPROVAL_MODES` set) is not updated in lockstep, a published `'threshold'` node **silently degrades to single-approver — one person approves what should require N. That is a control bypass, not a cosmetic bug.** The executor unit test below is the dedicated guard.
- `:557-580` `resolveAfterApprove` already stamps `aggregateMode` from `getApprovalMode`; threshold flows through unchanged once the union accepts it.

**Service validation + aggregation (`packages/core-backend/src/services/ApprovalProductService.ts`)**
- `:301` `const APPROVAL_MODES = new Set<ApprovalMode>(['single', 'all', 'any'])` → add `'threshold'`.
- `:322-328` `normalizeApprovalMode` (error text `"must be single, all, or any"`) → extend message + add `approvalThreshold` validation: required when mode is `'threshold'`, integer, `1 ≤ N ≤ distinct(static assigneeIds)` when assignees are static (the `hasLegacyAssignees` branch, `:1008-1010`); `N ≥ 1` only for dynamic sources.
- `:1000-1051` publish-time approval-node normalization — thread `approvalThreshold` into `normalizedNode.config` (`:1037-1049`, next to `...(approvalMode ? { approvalMode } : {})` at `:1045`).
- **`:3894-3969` the aggregation switch** — add a `approvalMode === 'threshold'` branch:
  - Active-assignee snapshot already exists: `:3460-3463` (`SELECT * FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE`), `:3509-3514` (`currentNodeAssignments`, `actorAssignments`, `actorCanAct`).
  - Count **distinct approvers so far** at the node (reuse the `loadApprovalHistory` shape, `:2048-2063`, which already reads `approval_records WHERE action='approve'`). The existing `'all'` short-circuit writes a non-completing `approve` record (`aggregateComplete:false`, `:3913-3929`) — threshold reuses that exact record shape while `distinctApprovals < N`.
  - On `distinctApprovals + 1 >= N`: deactivate the actor's assignment (`deactivateActorAssignmentsAtNode`, `:4377-4396`) and cancel remaining siblings + audit metadata using the existing `'any'` first-wins path (`:3933-3958`), then fall through to the shared advance block (`:3971-4108`) and emit the system `'sign'` cancellation audit row (`:4109-4129`).
- `:2172-2178` auto-approval cascade currently short-circuits for `'all' && remaining > 0`; add a threshold-aware short-circuit (stay on node while `distinctApprovals < N`).

**Wire/contract mirror (`packages/openapi/src/base.yml`)**
- `:3061-3066` `approvalMode: { type: string, enum: [single, all, any] }` → add `threshold` + document `approvalThreshold`. (The reject-cancellation `aggregateMode` doc block at `:3310` carries the mode as a free string and needs no logic change.)

> Reader-side note from the consumer sweep: `aggregateMode` is only ever *persisted as a string* into record/assignment metadata (`:3949`, `:4124`, executor `:908/:1000/:1020/:1036`); nothing branches on it for logic, so adding `'threshold'` to the union is type-safe for completion-event / timeline writers. No separate frontend `ApprovalMode` mirror exists in this worktree (`packages/` = core-backend, openapi, mssql-readonly-utils, claudedocs).

### Runtime / round-trip semantics
- **Serialization makes count-then-decide safe.** Each dispatch takes the per-instance `approval_instances` row lock, so the "read distinct-approval count → decide advance vs short-circuit" step cannot race two finalizing approvers. Cite this as the reason a simple count read is correct.
- **Distinct unit.** N counts distinct approver identities, not raw rows — a role assignment spanning multiple rows, or a re-dispatch, is one vote.
- **Early decision (first-N-wins).** The Nth approval cancels the remaining M−N pending assignees (`is_active=FALSE` + `aggregateCancelledBy/At` metadata, `:3933-3958`) and writes one system `'sign'` row; the completing `approve` record carries `approvalMode:'threshold'`, `aggregateComplete:true` (`:4080-4108`).
- **Reject (v1, unchanged).** A single reject still rejects the whole instance (`:3851-3863`) — see open decision 1.

### Test plan
**1. FAIL-FIRST integration test (real wire — keystone).** New `tests/integration/approval-threshold-mode.api.test.ts`, copying the harness of `tests/integration/approval-wp1-any-mode.api.test.ts` (real Postgres gated on `DATABASE_URL`, real `POST /api/approvals` + `/api/approvals/:id/actions`, asserts raw `approval_assignments.is_active`/metadata and `approval_records`, not fixtures). Scenario N=2, M=3 (assignees A/B/C, `approvalMode:'threshold'`, `approvalThreshold:2`):
  - approve#1 (A) → API `status:'pending'`, node unchanged; DB: exactly one `approve` record at the node with `aggregateComplete:false`; B and C still `is_active=TRUE`.
  - approve#2 (B) → API `status` advanced/`approved`, node advanced; DB: C's assignment `is_active=FALSE` with `aggregateCancelledBy:'B'`; a system `'sign'` cancellation row exists; completing record has `approvalMode:'threshold'`.
  - **This is RED today**: publishing `approvalMode:'threshold'` is rejected at `ApprovalProductService.ts:322-328` (`"must be single, all, or any"`), so the template never publishes. It goes GREEN only with the union + validator + runtime change.

**2. FAIL-FIRST executor unit test (lockstep / control-bypass guard).** Add to `tests/unit/approval-graph-executor.test.ts` (precedent: the `aggregateMode` assertions at `:477-510`): build a runtime graph with `approvalMode:'threshold'` and assert `executor.getApprovalMode('threshold-node') === 'threshold'` and `resolveAfterApprove('threshold-node').aggregateMode === 'threshold'`. **RED today** because `getApprovalMode` (`:689-691`) degrades unknown → `'single'`. This test is the explicit guard against the silent single-approver downgrade.

**3. Validation tests** (unit, no DB — `pool.connect` not called pattern): N missing when mode=threshold → 400; N=0 / N>static-assignee-count → 400; valid N round-trips into the normalized runtime graph config.

### Dependencies
- Existing aggregation/assignment plumbing only: `currentNodeAssignments`/`actorAssignments` snapshot (`:3460-3514`), `loadApprovalHistory` (`:2048-2063`), `deactivateActorAssignmentsAtNode` (`:4377-4396`), the `'any'` sibling-cancel + audit path (`:3933-3958`, `:4109-4129`).
- No new tables, columns, or migration: mode + N live in the `runtime_graph` JSONB of the published definition.

### Non-goals (explicit)
- No authoring UI (mode picker / N input) — authored via template JSON / API, like `all`/`any` shipped.
- No threshold on a node inside a parallel-gateway branch (rejected at publish in v1).
- No configurable reject/quorum-fail threshold — v1 keeps single-reject-rejects.
- No change to `single`/`all`/`any` behavior, to the reject path, or to parallel-gateway join semantics.
- Brand-neutral: capability is stated as all-must-approve / any-one-approves / **N-of-M threshold**; 会签/或签 appear only as parenthetical domain glosses.

---

## T2-5 — Timezone-aware scheduling

### Problem
Scheduled automations advertise a `timezone` knob but ignore it. Cron matching is hard-wired to UTC wall-clock fields, and the data-driven date-reminder path buckets days in UTC. A rule authored as "every day at 09:00 in Berlin" actually fires at 09:00Z (11:00 local in summer). The config is accepted, persisted, and silently wrong.

Real anchors confirming the gap:
- `packages/core-backend/src/multitable/automation-scheduler.ts:144-156` — `cronMatches` matches against `date.getUTCMinutes()`, `getUTCHours()`, `getUTCMonth()`, `getUTCDate()`, `getUTCDay()`. Pure UTC.
- `packages/core-backend/src/multitable/automation-scheduler.ts:202-216` — `nextCronOccurrenceMs` scans minute-by-minute calling `cronMatches`; no tz parameter.
- `packages/core-backend/src/multitable/automation-scheduler.ts:437-455` / `:498-507` — `registerCron` and the cron-expression extraction in `register` never read `trigger.config.timezone`.
- `packages/core-backend/src/multitable/automation-date-reminder.ts:19-21` — module doc: "v1 buckets in UTC ... `config.timezone` is accepted+persisted but only `'UTC'` is honored".
- `packages/core-backend/src/multitable/automation-date-reminder.ts:86-89` (`utcTimeOfDayBoundaryMs`) and `:115-131` (`computeDateReminderOccurrence`, `Date.UTC(...)` bucket at `:125`, day shift at `:128`) — UTC day boundaries.
- `packages/core-backend/src/multitable/automation-triggers.ts:37-40` — `ScheduleCronConfig.timezone?: string` (declared, unused).
- `packages/core-backend/src/multitable/automation-service.ts:1306-1308` — the date_field save-validator currently **rejects** any non-UTC timezone.

### Scope (what gets built)
1. **Cron tz-awareness.** `cronMatches` gains a `timeZone` argument and matches against the rule's **wall-clock fields in that IANA timezone** instead of UTC. `nextCronOccurrenceMs` gains an optional `timeZone` arg (default `'UTC'`) and threads it through the minute-scan. `registerCron` / `register` read `trigger.config.timezone` and pass it down (`automation-scheduler.ts:437-455`, `:498-507`).
2. **Date-reminder tz-awareness.** `computeDateReminderOccurrence` day-buckets at **local midnight in the rule's timezone** (calendar-day arithmetic, not `+86400000`), and `utcTimeOfDayBoundaryMs` / `nextDateReminderTimerDelayMs` resolve the `timeOfDay` boundary in that timezone (`automation-date-reminder.ts:86-100`, `:115-131`).
3. **Save validation.** Add a cron timezone branch and relax the date_field branch: any **valid IANA timezone** is accepted (probed via the established `Intl.DateTimeFormat` pattern); an invalid string is rejected (see decision D6). Replaces the current "reject anything but UTC" at `automation-service.ts:1306-1308`.
4. **Runtime fail-closed defense.** The scheduler loop catches an `Intl` throw on a persisted-junk tz, falls back to UTC, and warns — one corrupt rule cannot kill scheduling.

### Out of scope (non-goals)
- `schedule.interval` — a fixed-ms cadence is timezone-irrelevant; untouched.
- Sub-day reminder offsets (already deferred at `automation-date-reminder.ts:17`).
- Any frontend timezone picker. The audit worktree surfaces **no** automation tz UI today (`rg timezone packages/core-frontend/src` over the automation editor returns nothing); this rung is API/config-level only.
- Per-user / viewer-local timezone rendering; historical rewrite of already-fired ledger rows; any new DB column (tz lives in `trigger_config` JSONB).

### Contract
- **Dependency:** none new. Wall-clock-in-tz uses native `Intl.DateTimeFormat('en-US', { timeZone, ... }).formatToParts(date)` — the exact pattern already in `packages/core-backend/src/multitable/field-codecs.ts:449-458` (dateTime codec) and `packages/core-backend/src/audit/AuditService.ts:194`.
- **Function signatures (extend, default-UTC so existing callers are unchanged):**
  - `nextCronOccurrenceMs(expression: string, fromMs?: number, timeZone?: string): number | null` (was `automation-scheduler.ts:202`).
  - `cronMatches(parsed, date, timeZone)` (internal, `:144`).
  - `computeDateReminderOccurrence(dateValue, config)` already carries `config.timezone` via `ScheduleDateFieldConfig` — wire it in (`:115`).
- **Config shapes unchanged** (`automation-triggers.ts:37-40`, `automation-date-reminder.ts:35-36`): `timezone?: string`. Semantics change from "accepted+ignored" to "honored". Absent/empty/`'UTC'` ⇒ UTC (backward-compatible).
- **No DDL.** The dedup ledger PK stays `PRIMARY KEY (rule_id, record_id, occurrence_ts)` (`packages/core-backend/src/db/migrations/zzzz20260628120100_create_date_reminder_fires.ts:24`). Because `occurrence_ts` is part of that key, re-bucketing changes the key — see migration risk B.

### Runtime / round-trip semantics (load-bearing, not owner calls)
- **Fail-closed both ends.** Save rejects an invalid tz (D6); the runtime loop additionally try/catches the `Intl` throw → UTC + warn, so a hand-written DB/import row can't crash the scheduler.
- **Performance.** `nextCronOccurrenceMs` scans up to ~2.6M minutes (annual/leap crons). The minute loop MUST NOT construct a formatter per minute. Construct the formatter once per tz and resolve the local offset per **candidate UTC day** (re-probe when the day rolls — DST shifts only at a day boundary), then do pure arithmetic within the day. Otherwise register-time blocks the leader's event loop for seconds.
- **Date-reminder calendar arithmetic.** The shift at `automation-date-reminder.ts:128` (`dayUtcMidnight + signedDays*DAY_MS`) drifts an hour across a DST boundary and can land on the wrong local day. The tz-aware version shifts **calendar days in the tz**, then resolves to the instant.
- **Idempotency preserved.** `computeDateReminderOccurrence` stays a PURE function of (dateValue, config) — it still never reads NOW. Only the bucketing reference frame changes; the claim-then-fire ledger contract (`automation-service.ts:1219`, `:1224-1230`) is untouched.
- **DST emergent behaviour** (the executable form of decisions D1/D2): spring-forward → no UTC instant maps to the missing local time ⇒ that day is skipped; fall-back → two UTC instants map to the repeated local time ⇒ default suppresses the second (fire-once).

### Test plan
All tests assert the **real wire** (call the exported scheduler/reminder functions, compare ISO strings) — no hand-built fixtures.

**FAIL-FIRST (cron, RED today — `nextCronOccurrenceMs` ignores tz).** Extend `describe('nextCronOccurrenceMs')` at `packages/core-backend/tests/unit/automation-v1.test.ts:2060`:
- Standard time: `nextCronOccurrenceMs('0 9 * * *', Date.parse('2026-01-15T00:00:00.000Z'), 'America/New_York')` ⇒ `'2026-01-15T14:00:00.000Z'` (09:00 EST = UTC-5). RED today (returns 09:00Z).
- Spring-forward (US DST begins 2026-03-08): `'0 2 * * *'` in `'America/New_York'` from `2026-03-08T00:00:00Z` ⇒ `'2026-03-09T06:00:00.000Z'` (the 02:00 local slot does not exist on 03-08; next day's 02:00 EDT = 06:00Z). Locks D2 = skip-day.
- Fall-back (US DST ends 2026-11-01): `'30 1 * * *'` from `2026-11-01T00:00:00Z` ⇒ first match `'2026-11-01T05:30:00.000Z'` (01:30 EDT); a follow-up call from that instant +1min must return `'2026-11-02T05:30:00.000Z'`, NOT `2026-11-01T06:30:00.000Z` (the repeated 01:30 EST). Locks D1 = fire-once.
- **Backward-compat:** the existing assertion at `:2063` (`'15 9 * * *'`, no tz arg ⇒ `09:15:00Z`) must still pass; add an explicit `'UTC'` variant returning the same.

**FAIL-FIRST (date_field, RED today — UTC bucket).** Extend `describe('computeDateReminderOccurrence — pure, day-bucketed')` at `packages/core-backend/tests/unit/automation-date-reminder.test.ts:23`: a record date `'2026-06-28'` with `{ offsetDays: 0, direction: 'before', timeOfDay: '09:00', timezone: 'Asia/Shanghai' }` ⇒ `'2026-06-28T01:00:00.000Z'` (09:00 UTC+8), not `'2026-06-28T09:00:00.000Z'`. RED today.

**Integration (real wire, re-fire guard for migration risk B).** In `packages/core-backend/tests/integration/multitable-date-reminder-trigger.test.ts`: seed a rule + record, run a scan in UTC (writes a ledger row), switch the rule's `timezone`, run again — assert the at-most-once contract holds per the chosen D5 policy (default: at most one additional fire; never a loop).

### Dependencies
- None added. Native `Intl` only (Node ≥ full-ICU, already relied on at `field-codecs.ts:449-458`).
- Touches: `automation-scheduler.ts` (cron matching + plumbing), `automation-date-reminder.ts` (bucketing helpers), `automation-service.ts` (`validateDateFieldTriggerAtSave` at `:1273-1319` + a new cron-tz branch + startup audit log for migration risk A), `automation-triggers.ts` (doc only). No schema migration.

---

## T2-6 — Event-driven dedup ledger

### Problem
Only `schedule.date_field` is idempotent. Its scan claims each `(rule, record, occurrence)` in `meta_automation_date_reminder_fires` and fires **only if the insert won** — claim-then-fire, at-most-once (`automation-service.ts:1223-1240`). Every other trigger is event-driven and routes through `AutomationService.handleEvent` (`automation-service.ts:1337-1367`), which maps the event to a trigger (`TRIGGER_TYPE_BY_EVENT[eventType]`, :1350), matches each enabled rule (`matchesTrigger`, :1356), and calls `executeRule` (:1359) — **with no dedup row anywhere**. A redelivered `record.created/updated/deleted` or `form.submitted` therefore re-runs every side effect (send_notification, create_record, http_request, start_approval).

Today the in-process bus (`integration/events/event-bus.ts:22-105`) is a synchronous `eventemitter3` that fires exactly once and attaches no event id (distinct from the persistent `EventBusService` in `core/EventBusService.ts`, which AutomationService does **not** use — see the import at `automation-service.ts:3`). So "redelivery" presently means an application-level double-emit / double-submit, and the rung also future-proofs against an at-least-once transport. The payload itself (`AutomationEventPayload`, `automation-service.ts:520-528` — `sheetId, recordId, data?, changes?, actorId?, _automationDepth?, _triggeredBy?`) carries **no id, version, or dedup key**, which is exactly why KEY + WINDOW are open decisions below.

### Scope
**Build:** replicate the date-reminder claim-then-fire discipline for event-driven triggers.
1. A new idempotency table `meta_automation_event_fires`, modeled on `zzzz20260628120100_create_date_reminder_fires.ts` (FK → `automation_rules(id)` ON DELETE CASCADE, composite PK, `fired_at` retention index).
2. A pure, NOW-free helper `computeEventDedupKey(eventType, payload)` in a new `automation-event-dedup.ts` module (mirroring the pure split in `automation-date-reminder.ts`), plus retention constants.
3. A claim in `handleEvent`'s per-rule loop (`automation-service.ts:1353-1366`): after `matchesTrigger` passes and **before** `executeRule`, `INSERT ... ON CONFLICT DO NOTHING RETURNING`; on zero rows claimed → `continue` (the delivery was already consumed). One claim per `(rule, dedup_key)` so one rule deduping never blocks a sibling rule on the same event.
4. The dedup key's source field stamped onto the real emit payloads (see KEY decision / default A) so the helper has something stable to key on.
5. Opportunistic retention sweep + a `fired_at` index, mirroring `sweepDateReminderLedgerIfDue` (`automation-service.ts:1154-1165`) and `zzzz20260628120200_add_date_reminder_fires_fired_at_index.ts`.

**Do NOT build:** any change to `schedule.cron/interval/date_field` idempotency; `webhook.received` dedup or the `approval.*` completion bridge (`automation-service.ts:735`); per-action retry (that stays the job/rerun machinery); a durable/outbox transport or cross-process exactly-once beyond the single DB row; any new dedup UI.

### Contract
**New migration** `zzzz<ts>_create_event_fires.ts`, byte-pattern of the date-reminder migration:
```
CREATE TABLE IF NOT EXISTS meta_automation_event_fires (
  rule_id   text NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  dedup_key text NOT NULL,
  fired_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS idx_event_fires_rule     ON meta_automation_event_fires (rule_id);
CREATE INDEX IF NOT EXISTS idx_event_fires_fired_at ON meta_automation_event_fires (fired_at);
```
Idempotent DDL, no backfill. (Extends the table-family established at `zzzz20260628120100_create_date_reminder_fires.ts:17-31` and `zzzz20260628120200_add_date_reminder_fires_fired_at_index.ts:10-14`.)

**Claim site** — inside the loop at `automation-service.ts:1353-1366`, between `matchesTrigger` (:1356) and `executeRule` (:1359):
```
const dedupKey = computeEventDedupKey(eventType, payload)   // pure
if (dedupKey) {
  const claim = await sql`
    INSERT INTO meta_automation_event_fires (rule_id, dedup_key)
    VALUES (${rule.id}, ${dedupKey})
    ON CONFLICT DO NOTHING RETURNING rule_id
  `.execute(this.db)
  if (claim.rows.length === 0) continue   // redelivery — already fired
}
```
This is the literal analogue of the date-reminder claim at `automation-service.ts:1224-1230` (same INSERT…ON CONFLICT DO NOTHING RETURNING + `if (rows.length === 0) continue`). `dedupKey === ''` (absent source field) falls through to fire — fail-open (default fallback decision).

**Payload contract (default key A)** — add `_eventId?: string` to `AutomationEventPayload` (`automation-service.ts:520-528`) and stamp a `randomUUID()` at every emit site that today emits a record/form event without one: `record-service.ts:743, :861, :1040, :1389`, `record-write-service.ts:1338`, the executor cascade re-emits `automation-executor.ts:2081, :2187, :2236` (which currently stamp only `_automationDepth`), and the form route `univer-meta.ts:13562`. `computeEventDedupKey` returns `` `${eventType}:${payload._eventId}` `` or `''` when absent. A content-derived idempotency key already has precedent in this codebase (`automation-approval-bridge-service.ts:203`, `start_approval:${rootExecutionId}:${stepIndex}:${templateId}`).

**Retention constants** in `automation-event-dedup.ts`, mirroring `automation-date-reminder.ts:65-67`: `EVENT_DEDUP_RETENTION_DAYS`, `EVENT_DEDUP_LEDGER_SWEEP_INTERVAL_MS`, and a pure `eventDedupRetentionCutoffIso(nowMs)`; the sweep mirrors `sweepDateReminderLedgerIfDue` (`automation-service.ts:1154-1165`) and is best-effort (a retention failure must never block firing).

### Runtime / round-trip semantics
- **Cascade safety:** the executor re-emits `record.updated/created/deleted` for chaining (`automation-executor.ts:2081/2187/2236`), each with a fresh `_eventId`, so a cascade is a genuinely new event and is **not** deduped against its trigger. Depth runaway stays bounded by the existing `_automationDepth` guard (`automation-service.ts:1338-1342`, stamped +1 at :2086). `field.value_changed` rides `record.updated` (`automation-triggers.ts:76-93`); two value-changed rules on one update each claim independently because the PK includes `rule_id`.
- **At-most-once:** a crash between the claim and `executeRule` drops exactly that one delivery — the same documented tradeoff as date_field (`automation-service.ts:1171-1177`), preferred over a double-fire (delivery-semantics decision).
- **Deletes:** the key never reads the record, so `record.deleted` (record already gone) dedups cleanly.

### Test plan
Real-DB integration suite `multitable-event-dedup-trigger.test.ts`, modeled on `tests/integration/multitable-date-reminder-trigger.test.ts` (`new AutomationService(new EventBus(), db, q)`, `describeIfDatabase`, real `meta_bases/sheets/fields/records`, assert ledger rows + `multitable_automation_executions` count + the record marker the action writes). Drive the deterministic seam `await svc.handleEvent(eventType, payload)` (public at `automation-service.ts:1337`), not a hand-built execution fixture, so the real `handleEvent → matchesTrigger → executeRule → action → Postgres` chain runs.

**FAIL-FIRST T1 (redelivery dedup):** create an enabled `record.created` rule whose action stamps a marker field. Call `handleEvent('multitable.record.created', payload)` **twice with an identical `_eventId`**. Assert exactly **one** `meta_automation_event_fires` row, **one** logged execution, and the marker written **once**. On current main (no ledger) the second call re-fires → execution count = 2 → **RED**.

**FAIL-FIRST T2 (emit-site wire round-trip — guards the wire-vs-fixture drift class):** subscribe a capturing handler to a **real** `EventBus`, perform a real `recordService.createRecord(...)`, and assert the captured payload has a non-empty `_eventId`. On current main `record-service.ts:743` emits no such field → **RED**. This proves the dedup key actually rides the real emit, not just a test fixture.

**Control (no false dedup):** a third `handleEvent` with a **different** `_eventId` (a legitimate second change to the same record) **does** fire again → execution count increments. Pins that we dedupe redeliveries, not legitimate repeat changes. Plus: a far-apart sibling rule on the same event still fires (independent claim); an absent `_eventId` fires (fail-open).

### Deps + non-goals
**Deps:** the date-reminder ledger family as the proven pattern (table DDL, claim-then-fire, opportunistic retention sweep); the single `handleEvent` chokepoint (`automation-service.ts:1337`); kysely migration framework; `randomUUID` (already used at `automation-executor.ts:781`). No new external dependency. **Non-goals:** durable/outbox transport or cross-process exactly-once beyond the DB row; `webhook.received` / `approval.*` dedup; per-action or partial-failure retry; any change to schedule.* idempotency or to date_field's window/timezone; a dedup-management UI.

---

## R1 — BPMN runtime governance + SSRF containment

### Scope

Two-prong containment of the legacy BPMN engine. Both prongs are required; neither alone closes the rung.

**Prong A — route governance (mount-level gate).** The legacy BPMN engine is mounted authenticate-only with no RBAC and no feature flag. Add a mount-level gate so the engine and its visual-designer deploy/test path are disabled by default and only reachable in deployments that explicitly opt in (and, when on, only by privileged callers). This also restores the `designer = preview-only` convergence fence: the visual designer must not be a back-door that deploys/starts processes on the real engine.

**Prong B — service-task egress containment (SSRF).** The HTTP service task performs a raw `fetch()` to a process-supplied URL with the server's network position (authenticated SSRF: internal hosts, loopback, and cloud-metadata `169.254.169.254` are all reachable). Route the egress through the repo's existing SSRF guard so only public HTTPS targets are reachable and DNS-rebinding is closed.

**In scope:** the mount gate + `requireAdminRole()` posture on side-effecting routes; replacing the raw `fetch()` sink with `checkWebhookTargetUrl` + `pinnedHttpsFetch`; gating the designer deploy/test routes; fail-first tests for both prongs.

**Out of scope (this rung):** the script-task sandbox (already a denylist sandbox, not RCE — see Non-goals); any new connector/allowlist UI; the `class`/`delegateExpression`/external-task channels; reworking the BPMN parser.

### Threat model (grounded)

- `packages/core-backend/src/index.ts:1088` mounts `this.app.use('/api/workflow', workflowRouter)` and `:1090` mounts `/api/workflow-designer` — **neither is gated.** Contrast the PLM precedent immediately below at `index.ts:1091-1099`, which switches on `isPlmEnabled(...)` and falls back to `disabledFeatureHandler(...)`. The BPMN mounts have no such gate.
- Every route in `routes/workflow.ts` is guarded by `authenticate` only — no RBAC: `/deploy` (:91/:93), `/definitions` (:147), `/start/:key` (:200/:202), `/instances` (:242), `/instances/:instanceId` (:299), `/tasks` (:369), `/tasks/:taskId/claim` (:449), `/tasks/:taskId/complete` (:514), `/message` (:561), `/signal` (:596), `/incidents` (:629), `/incidents/:incidentId/resolve` (:673), `/audit` (:713).
- The SSRF sink: `routes/workflow.ts:200 /start/:key` → `workflowEngine.startProcess(...)` → activity dispatch `BPMNWorkflowEngine.ts:345-346 (case 'serviceTask')` → `executeServiceTask` (:505); when `props.type === 'http'` (:525-527) it calls `executeHttpTask` (:539), where `url = this.resolveExpression(props.url, instance?.variables)` (:544, `${var}`-templated via `evaluateExpression` :1178-1187) is passed to a raw **`fetch(url, { method, headers, body })`** at **`BPMNWorkflowEngine.ts:550`**. No scheme check, no internal-address check, no timeout. The response is then read with `await response.json()` and stored into `props.responseVariable` (:559-566).
- Reachability nuance (load-bearing for the test design): the XML parser only maps `class/expression/delegateExpression/resultVariable/topic/type` for `bpmn:serviceTask` (`BPMNWorkflowEngine.ts:951-958`); it does **not** parse `url/method/headers/body/responseVariable` from XML. So a process deployed via stock BPMN XML sets `props.type='http'` but leaves `props.url` undefined. The fetch sink is nonetheless real, authenticated-reachable code, and any path that populates `properties.url` (visual/programmatic definition, or a one-line parser extension) immediately re-arms it. Containment hardens the **sink**, independent of how `props.url` is populated.
- `DISABLE_WORKFLOW=true` (`routes/workflow.ts:29`) is **not** a security control: it only skips `workflowEngine.initialize()` (`BPMNWorkflowEngine.ts:160` — load definitions, resume instances, timers). The router and the `deployProcess`/`startProcess` handlers stay mounted and the fetch sink stays live. A real mount-level gate is therefore a separate, required addition.
- Convergence-fence breach: `routes/workflow-designer.ts:1211 POST /workflows/:id/deploy` calls `workflowEngine.deployProcess(...)` (:1233) — a second, ungated path that makes a draft startable on the real engine; `:1282 POST /workflows/:id/test` is the sibling test path. Both are `authenticate` + per-draft owner/share ACL (`canDeployWorkflowDraft` :1223, `hasWorkflowDraftAccess` :1302) but carry **no platform RBAC and no feature flag.**

### Contract

**A1 — engine-enable config (new), modeled exactly on the PLM precedent.**
Add `isLegacyWorkflowEngineEnabled(productModeValue = process.env.PRODUCT_MODE, enableValue = process.env.ENABLE_LEGACY_BPMN): boolean` alongside `isPlmEnabled` in `packages/core-backend/src/config/product-mode.ts:18-25` (same `parseBooleanEnv`/`normalizeProductMode` helpers, lines :3-16). Semantics: returns `true` only when `ENABLE_LEGACY_BPMN` is explicitly truthy; default **false** (note: the opposite default from `isPlmEnabled`, which defaults true — the legacy engine is opt-in, PLM is opt-out).

**A2 — gated mounts** at `index.ts:1088` and `:1090`. Wrap with the existing `disabledFeatureHandler` (defined `index.ts:202-212`, returns `404 { ok:false, error:{ code:'FEATURE_DISABLED', message } }`):
```
if (isLegacyWorkflowEngineEnabled()) {
  this.app.use('/api/workflow', workflowRouter)
} else {
  this.app.use('/api/workflow', disabledFeatureHandler('Legacy BPMN workflow engine is disabled in this deployment'))
}
```
The visual designer keeps its draft-CRUD/preview routes mounted; only its two engine-touching routes (deploy :1211, test :1282) consult `isLegacyWorkflowEngineEnabled()` and return the same `FEATURE_DISABLED` 404 when off (preserving designer=preview-only).

**A3 — RBAC posture when enabled (recommended default).** When the flag is on, apply `requireAdminRole()` (`guards/audit-integration.ts:113`, returns `403 { error:'AccessDenied', code:'ADMIN_REQUIRED' }` for anonymous/non-admin and logs the denial) to the side-effecting routes — `/deploy`, `/start/:key`, `/signal`, `/message`, designer `deploy`/`test` — inserted between `authenticate` and `validate`. Read-only routes (`/definitions`, `/instances`, `/tasks`, `/audit`) stay `authenticate`-only. This is defense-in-depth layered on the flag, not a replacement for it.

**B1 — egress containment, reusing the existing webhook SSRF stack (no new allowlist invented).** Replace the raw `fetch` at `BPMNWorkflowEngine.ts:550` with:
```
const check = await checkWebhookTargetUrl(url)          // multitable/webhook-ssrf-guard.ts:89
if (!check.ok) throw new Error(`HTTP task target rejected: ${check.reason}`)
const { status, ok } = await pinnedHttpsFetch(          // multitable/webhook-pinned-fetch.ts:28
  url, check.addresses[0], <family>,
  { method, headers, body: body ? JSON.stringify(body) : undefined, timeoutMs: BPMN_HTTP_EGRESS_TIMEOUT_MS })
```
`checkWebhookTargetUrl` (guard file :89-119) enforces: https-only (:97), reject internal hostnames `localhost/.internal/.local` (:80-82, :99), reject RFC1918 / loopback / link-local incl. cloud-metadata `169.254.169.254` (:26-73, :101-117), and **resolve-then-pin** — it returns the resolved addresses so `pinnedHttpsFetch` connects to the pinned IP (not a re-resolved name), closing the DNS-rebinding window (pinned-fetch header comment :1-13). `pinnedHttpsFetch` forces the `Host` header to the URL host (:42-50, strips caller-supplied Host), resolves on response **headers** then destroys the socket (:64-71) — it returns `{ status, ok }` and never reads the body.

**B1 consequence — `responseVariable` regression (owner decision D5):** because `pinnedHttpsFetch` never reads the body, the current `await response.json()` → `props.responseVariable` capture (:559-566) cannot be preserved as-is. Default: store `{ status, ok }` into `responseVariable` (or drop it) and document the change; a bounded-body reader is deferred. Do **not** reintroduce an unbounded `response.json()`.

### Runtime / round-trip semantics

- Flag OFF (default): `GET/POST /api/workflow/*` and designer deploy/test return `404 FEATURE_DISABLED`; the engine performs no DB I/O and no egress.
- Flag ON, non-admin caller (recommended posture): side-effecting routes return `403 ADMIN_REQUIRED`; read routes succeed.
- Flag ON, admin caller, http service task with an internal/non-https `props.url`: `checkWebhookTargetUrl` returns `{ ok:false, reason }`; the task throws; the existing `catch` (executeHttpTask :569-571) logs and re-throws so the activity is recorded as a failure/incident (fail-closed, D6).
- Flag ON, admin caller, public HTTPS target: egress connects to the pinned address with `Host` forced to the URL host, completes on headers within the timeout, and stores `{ status, ok }` into `responseVariable` (D5).

### Test plan

Harness: vitest + supertest + `express()` with a `req.user` injection middleware and module-boundary `vi.mock`, per `tests/unit/multitable-button-routes.test.ts:6-81`.

1. **FAIL-FIRST (route governance, real wire).** With `ENABLE_LEGACY_BPMN` unset (default off), build the real app mount logic and `POST /api/workflow/start/:key` as an authenticated user; assert the response is exactly the real `disabledFeatureHandler` shape: `status 404`, body `{ ok:false, error:{ code:'FEATURE_DISABLED' } }`. **RED today** (route is ungated → returns 201/500 from the real handler). GREEN after A2. Add the mirror assertion for `POST /api/workflow-designer/workflows/:id/deploy` (RED today, GREEN after the designer gate).
2. **FAIL-FIRST (SSRF egress boundary, real wire).** Unit-drive the real engine method by invoking `executeServiceTask`/`executeHttpTask` with a crafted `activityDef.properties = { type:'http', url:'http://169.254.169.254/latest/meta-data/' }` (and a second case `http://127.0.0.1:5432/`), spying on global `fetch` (today's sink) and on `https.request`. Assert **no** outbound request is ever issued toward the internal address and that the task throws. **RED today** (raw `fetch(url)` at :550 fires against the internal URL). GREEN after B1 (`checkWebhookTargetUrl` rejects before any socket). This anchors at the egress boundary deliberately — the stock XML parser does not populate `props.url` (:951-958), so a full deploy→start round-trip cannot inject a controlled URL today; the boundary test exercises the real sink without an aspirational parser path.
3. **Green coverage.** Flag-on admin → side-effecting route reaches the handler (200/201); flag-on non-admin → `403 ADMIN_REQUIRED`; flag-on http task to a public HTTPS host → `pinnedHttpsFetch` is called with the pinned address and `responseVariable` receives `{ status, ok }` (assert against a stubbed `https.request`, real wire — mock at the `https.request` boundary, not a hand-built fetch fixture).

### Dependencies

- Reuses (no new deps): `config/product-mode.ts` (`parseBooleanEnv`/`normalizeProductMode`), `index.ts:202 disabledFeatureHandler`, `guards/audit-integration.ts:113 requireAdminRole`, `multitable/webhook-ssrf-guard.ts:89 checkWebhookTargetUrl`, `multitable/webhook-pinned-fetch.ts:28 pinnedHttpsFetch`.
- New env vars: `ENABLE_LEGACY_BPMN` (default off), `BPMN_HTTP_EGRESS_TIMEOUT_MS` (default 10000). Both need a deploy/release-note entry (D2).
- No DB migration. No schema change.

### Non-goals (explicit)

- **Script-task sandbox is not in scope.** `executeScriptTask` (:578-641) is already a denylist sandbox (dangerous-pattern regexes :591-605) feeding an assignment-only parser (`result.x = …` :621-628) and a numeric-only evaluator (`safeEvaluateExpression` :646-660) — it is not arbitrary code execution. Residual risk worth noting for a later rung: the denylist is weaker than an allowlist, but expanding it here would be gold-plating. Left as a tracked residual, not fixed in R1.
- No host allowlist UI/config, no per-tenant egress policy, no rework of the `class`/`delegateExpression`/external-task channels, no BPMN-parser changes.
- Not changing the per-draft owner/share ACL (`canDeployWorkflowDraft`/`hasWorkflowDraftAccess`) — the flag + RBAC sit in front of it.

### Open owner decisions

This rung is security- and behavior-changing; it is **not** decision-clean. See the structured `openOwnerDecisions` / `proposedDefaults` (D1 gating mechanism · D2 default state + migration · D3 designer-gate granularity · D4 SSRF egress policy + https-only/method break · D5 `responseVariable` regression · D6 fail-closed semantics · D7 egress timeout). Each carries a proposed default above; D1, D2, and D5 in particular require an explicit owner call before implementation.

---

## T3-4 — W7 rejection backwrite

**Size: M · design-lock-first.** Adds approval-result backwrite on the non-approved terminal outcomes (rejected / revoked / cancelled). The approved-path backwrite already ships (W7-1); this rung removes the asymmetry where a non-approved outcome leaves the source record blank.

### 1. Scope

**In scope**
- In `handleApprovalCompletionEvent`, run the *existing* `writeApprovalResultBack` on the non-approved branch (today it is reachable only on the approved branch), so a configured `resultWriteback` mapping receives the terminal outcome, actor, and completion timestamp from the completion event.
- Wrap that call in the same best-effort `try/catch` the approved path uses, surfacing a `backwriteSkipped` reason on the `start_approval` step `output` so a locked/missing/mis-typed target never blocks the terminal settle.
- Update the stale header comment (`automation-service.ts:1780-1781`, "rejection backwrite is a named follow-up") to describe the shipped behavior.
- Per **D2 default**, gate the new behavior behind an opt-in flag so already-saved (approved-only) rules are unaffected.

**Out of scope (non-goals, §6)**
- No change to the terminal run status under the **D1 default** (write-back-then-fail): the run still settles `failed` and the tail stays `skipped` via the existing `failApprovalBridgeExecution`.
- No cross-base backwrite (that is the separate T3-5 security arc).
- No new schema/migration, no new config keys beyond the opt-in flag, no executor changes.

### 2. Contract + real anchors it extends

All anchors verified by reading `packages/core-backend/src/multitable/automation-service.ts`, `.../services/ApprovalCompletionEvent.ts`, and the integration test.

- **Branch to change — `automation-service.ts:1688-1692`**: the run builds `result = this.approvalCompletionStepResult(event)` (:1688) then early-returns into `failApprovalBridgeExecution` for any `event.transition.toStatus !== 'approved'`. The new behavior inserts the backwrite *before* that settle. The completion event has already been single-claimed at `:1667` (`approvalBridgeService.claimCompletion(event)`), so the backwrite inherits at-most-once delivery.
- **Reused writer is already outcome-agnostic — `writeApprovalResultBack` :1783-1841**: it writes `event.transition.toStatus` into the status field (:1795), `event.actor?.id ?? null` into the approver field (:1796), `event.occurredAt` into the completed-at field (:1797), and calls `assertResultWritebackFields(bridge.sheetId, writeback, event.transition.toStatus)` (:1790) with the *real* outcome — not a hardcoded `'approved'`. So the implementation is "call it on the other branch," not "generalize the writer." It is lock-guarded (`ensureRecordNotLocked`, :1806), same-base, values-constrained (system values only), and merges via `data || $1::jsonb` (:1810-1815, idempotent).
- **Pattern to mirror — approved-path wrapper :1708-1725**: `try { backwritten = await this.writeApprovalResultBack(...) } catch { ...output.backwriteSkipped = reason }`. The non-approved branch reuses this shape; under the **D1 default** it does NOT merge the result into a tail snapshot (no tail runs), and proceeds to `failApprovalBridgeExecution` regardless of write success.
- **Step-result shape — `approvalCompletionStepResult` :1753-1772**: returns `status: 'failed'` with `error: 'Approval completed with <toStatus>'` for non-approved (:1765-1771). Under D1 default this is preserved verbatim; the only addition is the `output.backwriteSkipped` / write echo for observability. (This hardcoded `'failed'` is also why the continue-tail alternative is structurally awkward — see D1.)
- **Settle path unchanged — `failApprovalBridgeExecution` :1916-1953**: sets `execution.status = 'failed'` (:1931), pushes the failed step (:1933), marks the tail `skipped` (:1934-1937), settles jobs.
- **Event type — `ApprovalCompletionEvent.ts:6, :36-43, :49, :61-64`**: `ApprovalCompletionOutcome = 'approved' | 'rejected' | 'revoked' | 'cancelled'`; `transition.toStatus` is that union; `actor` is nullable (null on auto/system cancel); `occurredAt` is an ISO string. `handleApprovalCompletionEvent` already accepts all four event types at `:1665`.
- **Save-time validation today — `assertResultWritebackFieldsAtSave` :1879-1914**: validates target field type against `'approved'` only (:1909). Per **D5 default** this stays as-is; the runtime `assertResultWritebackFields` (:1843-1874) + `resultWritebackFieldTypeError` select-option check (:242-271, `options.has(outcome)` at :251-256) handle a missing outcome option by throwing → caught → `backwriteSkipped`.
- **Config validation — `validateStartApprovalConfig` :170-180**: where the **D2 default** opt-in flag (`resultWriteback.onNonApproved`) is parsed/validated alongside the existing `statusField`/`approverField`/`completedAtField` keys (`RESULT_WRITEBACK_FIELDS`, :89). The flag is part of the action config, so it is covered by the resume-time action-fingerprint drift guard (cannot be swapped after the approval suspends).

### 3. Runtime / round-trip semantics

1. Approval reaches a non-approved terminal state → completion event emitted → `handleApprovalCompletionEvent` claims the bridge once (`:1667`).
2. Rule/fingerprint guards run as today (`:1676-1686`).
3. **New:** if the rule's `start_approval` config has `resultWriteback` (with the **D2** opt-in flag set), call `writeApprovalResultBack` inside a `try/catch`. On success the source record's `data` jsonb merges `{ <statusField>: <outcome>, <approverField>: <actorId|null>, <completedAtField>: <occurredAt> }`; per **D6** it emits depth-guarded `multitable.record.updated` + realtime. On a locked/missing/mis-typed/missing-select-option target it throws → caught → `backwriteSkipped` reason captured.
4. Settle: under the **D1 default**, call `failApprovalBridgeExecution` with the (possibly `backwriteSkipped`-annotated) failed step — run = `failed`, tail = `skipped`. (Under the continue-tail alternative, step status and the executor entry path differ — see D1.)

Round-trip: the written outcome string equals `transition.toStatus`; a `select` statusField must carry that option or the write skips (D5). `completedAtField` is the event's `occurredAt`, not "now".

### 4. Test plan (assert the real wire, not fixtures)

Harness: `packages/core-backend/tests/integration/multitable-automation-start-approval.test.ts` (real DB; drives `ApprovalProductService.dispatchAction` and asserts `meta_records.data` / execution steps over the actual bridge — the same wire as W7-1 at :436-499).

- **FAIL-FIRST — "non-approved approval writes the result back to the source record."** Configure a rule with `resultWriteback` (reuse `seedDefaultWritebackFields`, :221-233 — its select has `approved`/`rejected`), drive `dispatchAction(..., { action: 'reject' }, ...)`, then `await waitForExecutionStatus(svc, id, 'failed')` (NOT `'success'` — copying the W7-1 success-waiter at :487 would time out). Assert `meta_records.data.approval_status === 'rejected'`, `approved_by === <rejecter>`, `typeof approved_at === 'string'`. **RED today**: the early return at `:1688-1692` settles before `writeApprovalResultBack` ever runs, so the record stays blank → the `approval_status` assertion fails. Goes GREEN with the change. This assertion is the common denominator of both D1 options (both write back), so it is stable against the headline decision.
- **D1-discriminator tests.** Under the **fail default**: assert the run is `failed`, the tail webhook is NOT called, step[1] is `skipped`. Note the existing test "rejected approval fails the automation and does not run the tail" (:597-679) encodes the current contract and has NO `resultWriteback` on its rule, so it stays GREEN under fail-default and would FLIP (calls non-empty, step[1] success) under continue-default — call this out explicitly in whichever option is chosen.
- **D2 opt-in test.** A rejection on a rule whose `resultWriteback` omits the opt-in flag writes nothing (existing approved-only contract preserved).
- **D5 partial-coverage test.** With a select statusField lacking the `revoked` option (the `seedDefaultWritebackFields` gap), a `revoke` leaves the record unwritten and surfaces `backwriteSkipped` on the step output (mirrors W7-1b at :549-571: `output` `toMatchObject({ backwriteSkipped: expect.stringContaining(...) })`).
- **D6 parity test.** Subscribe to `multitable.record.updated` (as W7-1a does at :504) and assert a non-approved backwrite emits `changes.<statusField> === <outcome>` for the source record.
- **Lock-guard test.** A locked source record on rejection → `backwriteSkipped: 'source record is locked'`, and the run still settles terminal (never a 500).
- `vue-tsc`/typecheck + existing suite green; if D2 adds the flag, a config-validation unit test for the new key.

### 5. Dependencies + explicit non-goals

**Deps:** none new. Reuses `writeApprovalResultBack` (:1783), `failApprovalBridgeExecution` (:1916), `assertResultWritebackFields` (:1843), the completion-event contract (`ApprovalCompletionEvent.ts`), and the single-claim bridge.

**Non-goals (each a separate later opt-in):**
- **No schema migration.** Reuses `meta_records.data` jsonb + the existing `resultWriteback` config (plus, per D2, one optional boolean flag) — no new columns/tables.
- **No cross-base backwrite** (T3-5 — permission / lock / audit / target re-resolution is a security arc, not this slice).
- **No new requester/UI surface** beyond the optional opt-in toggle the chosen D2 default implies.
- **No idempotency rework** — at-most-once is inherited from `claimCompletion` (:1667); the jsonb-merge UPDATE is itself idempotent.
- **No "notify on rejection" workflow primitive** — if that is the real need, it belongs to the planned `approval.*` automation trigger (TODO T1-3), not to bending the backwrite into a tail-running path.

---

## T3-5 — W7 cross-base backwrite

**Size: L · design-lock-first.** Extend the approval-result backwrite so it can write the approval outcome to a record in a **different base** than the source/trigger record, routed through the platform's existing cross-base write gate. Today the backwrite is hard-bound to the source record. The four re-lock arcs the rung names — permission / lock / audit / target-resolution — are all open owner decisions below.

### Scope (what gets built)
- The `start_approval` action's `resultWriteback` config grows optional cross-base addressing: `targetBaseId`, `targetSheetId`, `targetRecordId` — the same literal triple `update_record` already uses (`automation-executor.ts:2022`).
- `writeApprovalResultBack` (`automation-service.ts:1783`) is taught to: detect cross-base intent, route through the **shared** cross-base write gate (extracted, see below), and on success retarget its lock-check + `UPDATE` + realtime fan-out to the target record. Same-base behavior is byte-for-byte unchanged (zero regression).
- The executor's gate (`evaluateCrossBaseWrite`, `automation-executor.ts:1818`, currently **private**) plus `checkCrossBaseWriteQuota` (`automation-executor.ts:1900`) are **extracted into one shared module** taking `(queryFn, actorId, triggerSheetId, targetSheetId, declaredTargetBaseId, quota)`. Both the executor and the service backwrite call the one gate — forking the gate into a second copy would be the security anti-pattern (this is an implementer decision, decided here, not an owner call).

### Non-goals (explicitly out)
- **Rejection-path cross-base** — backwrite stays approved-path only (the non-approved branch still fails the automation today). Folds into **T3-4** (rejection backwrite), not this rung.
- **Dynamic target-record resolution** (link-field / lookup) — see open decision 2; this rung ships the literal triple only and does **not** re-open expression templating (the reason W7-1 was gated — `automation-service.ts:1775-1781`).
- **Person-shaped `approverField`** writes — unchanged; `approverField` remains string/longText only (`automation-service.ts:260-264`).
- Cluster-wide quota (the default store is in-process; `automation-executor.ts:711-713`).

### Contract — config + the REAL anchors it extends
**Config shape (`start_approval.config.resultWriteback`).** Today (`automation-service.ts:170-180`) it is `{ statusField?, approverField?, completedAtField? }` and the validator iterates only `RESULT_WRITEBACK_FIELDS` (`automation-service.ts:89`) — it **silently ignores unknown keys**. This rung adds the optional triple and new save-time validation that mirrors `validateCrossBaseWriteConfig` (`automation-service.ts:283-293`): if any of `targetBaseId/targetSheetId/targetRecordId` is present, **all three are required** (open decision 4).

**Anchors extended:**
- `automation-service.ts:1783` `writeApprovalResultBack(...)` — same-base writer; its lock SELECT and `UPDATE` are bound to `bridge.recordId` / `bridge.sheetId` (`automation-service.ts:1800-1815`), and it early-returns on `!bridge.sheetId` (`:1789`). This is the surface that grows a cross-base branch.
- `automation-service.ts:1806` `ensureRecordNotLocked(event.actor?.id ?? null, …)` — the lock guard, today against the **source** record and the **approver** id.
- `automation-service.ts:16-17` the service imports `ensureRecordNotLocked` + `publishMultitableSheetRealtime` but **NOT** `resolveBaseWritable` — a cross-base backwrite must pull in the authority dependency (or call the extracted gate, which owns it).
- `automation-executor.ts:1818-1892` `evaluateCrossBaseWrite` — the gate to reuse: same-base fast-path → `{crossBase:false}` (`:1832`); soft-deleted/missing target sheet → fail-closed (`:1842-1849`); claim==truth `declaredTargetBaseId === target sheet base` (`:1861-1868`); `resolveBaseWritable(actorId, …)` trigger-actor authority, fail-closed on null actor (`:1871-1878`); per-target-base quota (`:1889`).
- `automation-executor.ts:2052-2058` cross-base "record not found in target sheet → failed" (claim==truth on the record) and `:1974-1992` `publishRecordRealtime` which **omits actorId for cross-base** — both behaviors the backwrite must adopt for the target write.
- `permission-service.ts:1569` `resolveBaseWritable` — fail-closed on no userId / missing base; grants on `BASE_WRITE_PERMISSION_CODES` ∪ base owner.
- `automation-approval-bridge-service.ts:33-50` `AutomationApprovalBridgeRow` — carries `sheetId` / `recordId` / `triggerEvent` but **no baseId**; the trigger base is resolved from `sheetId` inside the gate, and the trigger actor is read out of `triggerEvent` (open decision 1).

### Runtime / round-trip semantics
1. **Anti-misroute invariant (hard contract, NOT a decision):** the **presence of any** target-addressing key makes the backwrite cross-base intent. It then routes through the gate and, on any gate rejection, **fails closed (skip + log on the step output) — it NEVER silently falls back to writing the source record.** A silent fall-back would stamp `approved` onto the wrong (source) row = a data-integrity bug. Same-base (no target keys) is the only path that touches `bridge.recordId`.
2. **`recordData` tail-merge must be gated on same-base.** W7-1a merges the backwrite patch into the resume snapshot so tail actions see the written status (`automation-service.ts:1712-1715`). For a **cross-base** backwrite the patch landed on a record in another base — merging it into the **source** record's tail context would inject fields that do not belong to the source record. The cross-base path therefore returns a non-merged sentinel (or the resume conditions the merge on `gate.crossBase === false`); cross-base writes are not visible to this rule's own tail context. State this as a correctness property.
3. **Lock + claim==truth on the target.** On cross-base, the lock SELECT and `UPDATE` retarget to `targetSheetId`/`targetRecordId`; a 0-row lock SELECT means the record does not live in the target sheet → fail-closed (mirror `automation-executor.ts:2052`). The lock comparison uses the same effective actor chosen in decision 1.
4. **Realtime + depth.** Cross-base fan-out targets the **target** sheet's room with `actorId` omitted (privacy, mirror `automation-executor.ts:1987`); same-base keeps passing the actor through. The emitted `multitable.record.updated` keeps `_automationDepth + 1` (`automation-service.ts:1821`) so a backwrite-driven cascade in the target base stays depth-guarded.
5. **Quota.** Cross-base backwrite increments the shared per-target-base counter (default 60 / 60s, `automation-executor.ts:714-715`); the N+1th is rejected fail-closed like any other cross-base write.
6. **Best-effort preserved.** A gate rejection / locked / missing target → log + skip + surface on the step output; the approved-tail resume still runs (the W7-1 best-effort posture, `automation-service.ts:1716-1725`).

### Test plan (fail-first; assert the REAL wire)
Harness: `tests/integration/multitable-automation-start-approval.test.ts` (`executeAndApprove`, `seedSheetRecord`, `seedWritebackFields`, real `ApprovalProductService.dispatchAction(approve)`) + the two-base seeding from `tests/integration/multitable-cross-base-automation-write.test.ts` (`meta_bases` BASE_A/BASE_B with `owner_id`, `user_permissions` granting target base-write).

- **FAIL-FIRST (RED today):** seed base A (trigger record) **and** base B (a real target record + writeback fields), grant the trigger actor base-write on B via `user_permissions`. Author a `start_approval` rule whose `resultWriteback` carries `{ targetBaseId: B, targetSheetId, targetRecordId, statusField:'approval_status' }`. Drive a real approval through `dispatchAction(approve)` → resume. **Query the TARGET record in base B from the DB and assert `data.approval_status === 'approved'`.** RED today because `writeApprovalResultBack` is hard-bound to `bridge.sheetId`/`bridge.recordId` (`automation-service.ts:1800-1815`) — base B's record is never touched. Assert the **DB row**, not the returned patch object.
- **Anti-misroute companion:** under that same cross-base config, assert the **SOURCE** record in base A is **NOT** mutated (no `approval_status` key) — locks invariant 1.
- **Authority fail-closed:** trigger actor lacks base-write on B → target unchanged, source unchanged, skip surfaced on the step output (real DB, not a stubbed gate).
- **Quota / claim==truth / locked-target:** reuse the executor gate's existing cases against the backwrite entry point (mismatched `targetBaseId`, `targetRecordId ∉ targetSheetId`, locked target).
- **Regression:** same-base backwrite suite stays green (12/12) — the cross-base branch is inert when no target keys are present.

### Dependencies
- **Gate extraction** of `evaluateCrossBaseWrite` + `checkCrossBaseWriteQuota` from `automation-executor.ts` into a shared module (touches the executor; keep its public behavior identical and re-run the cross-base write suites).
- `resolveBaseWritable` (`permission-service.ts:1569`) — now also reached from the service path.
- **Soft-dep on T3-4** for the rejection branch and on the (separate) dynamic-target-resolution follow-up; neither is built here.

---

## T3-2 — Business/work-day calendar wired to approval SLA

### Problem / why this rung
A work-day calendar already exists in the attendance domain, but approval SLA is **hours-only and UTC-only**. The breach decision today is one line of pure wall-clock arithmetic:

```
WHERE terminal_at IS NULL
  AND sla_hours IS NOT NULL
  AND sla_breached = FALSE
  AND started_at + (sla_hours * interval '1 hour') < $1   -- ApprovalMetricsService.ts:301
RETURNING instance_id
```

`checkSlaBreaches(now)` (`packages/core-backend/src/services/ApprovalMetricsService.ts:293`) is invoked by `ApprovalSlaScheduler.tick()` (`ApprovalSlaScheduler.ts:140`) on a default 15-minute interval (`ApprovalSlaScheduler.ts:16`, `:204`). `sla_hours` is an `INTEGER` column on `approval_templates` (migration `zzzz20260425100000_create_approval_metrics.ts:27`) mirrored onto `approval_metrics` (`:49`), copied at instance start by `recordInstanceStart` (`ApprovalMetricsService.ts:165`, INSERT at `:183`) from `bundle.template.sla_hours` (`ApprovalProductService.ts:3176`). There is no notion of legal-workday counting, natural-day counting, minute granularity, timezone, or pause windows.

The work-day verdict already exists elsewhere: `resolveEffectiveCalendar(db, args)` in the attendance plugin (`plugins/plugin-attendance/index.cjs:15578`) returns `{ mode, from, to, timezone, items[] }` (`:15827`), where each item carries a per-day `effective.isWorkingDay` (`:15800`–`:15824`, derived from base rule + `attendance_holidays` at `:15729`–`:15751`) and the response carries a resolved `timezone` (`:15662`/`:15831`). `attendance_holidays` is org-scoped: `INSERT INTO attendance_holidays (id, org_id, holiday_date, name, is_working_day, origin)` (`index.cjs:11224`). It is exposed both over HTTP — `GET /api/attendance/effective-calendar`, gated `withPermission('attendance:read')` (`index.cjs:39802`/`:39803`) — and in-process via `module.exports` (`index.cjs:19985` … `resolveEffectiveCalendar` at `:20145`).

This rung **wires that calendar to approval SLA**: multi-time-dimension SLA (legal-workday / natural-day / hour / minute) plus non-counting windows. The cross-domain boundary (attendance → approval) is the headline open decision.

### Scope — what gets built
1. **Schema (additive migration).** On `approval_templates`: `sla_unit TEXT` (one of `hour|minute|natural_day|workday`), `sla_amount INTEGER` (>0), `sla_calendar_org_id TEXT NULL`, `sla_non_counting JSONB NULL`. On `approval_metrics`: `sla_due_at TIMESTAMPTZ NULL`, resolved `sla_timezone TEXT NULL`, `sla_unit TEXT NULL`, `sla_amount INTEGER NULL`. Legacy `sla_hours` (`migration :27`/`:49`) is retained as a compatibility alias (`sla_unit='hour'` ⇒ `sla_amount = sla_hours`).
2. **`SlaDeadlineCalculator`** — a new **pure** module in core-backend (`packages/core-backend/src/services/SlaDeadlineCalculator.ts`) plus a `WorkdayCalendarPort` interface. Given `(startedAt, unit, amount, timezone, nonCountingWindows, port)` it returns the concrete deadline `sla_due_at`:
   - `hour`/`minute`: arithmetic that skips configured non-counting windows.
   - `natural_day`: step `amount` local-midnight day boundaries in the instance timezone.
   - `workday`: step forward consuming only days where `port` reports `isWorkingDay === true`.
3. **Wire instance start.** Extend `recordInstanceStart` (`ApprovalMetricsService.ts:165`) to accept `slaUnit`/`slaAmount`/`slaCalendarOrgId`; the caller in `ApprovalProductService` (`:3170`) resolves the calendar via the port, runs the calculator, and persists `sla_due_at` + resolved tz onto the metrics row. The whole block stays inside `safeMetricsCall` (`ApprovalProductService.ts:3170`) so a calendar failure can never roll back the approval instance.
4. **Cut the scanner over.** Replace the hours-math in `checkSlaBreaches` (`ApprovalMetricsService.ts:295`–`302`) with `sla_due_at < $1`, retaining a **legacy fallback branch** for rows that have `sla_hours` but `sla_due_at IS NULL`. No calendar call happens in the hot scan loop — all calendar work is front-loaded to instance start.
5. **Calendar provider seam.** The attendance domain supplies the concrete `WorkdayCalendarPort` (wrapping `resolveEffectiveCalendar`, `index.cjs:15578`). The wiring mechanism is the open decision below.

### Scope — what does NOT get built (non-goals)
- Per-node / per-step SLA deadlines — instance-level SLA only.
- Live recompute of `sla_due_at` when the calendar changes after start (snapshot-at-start only).
- New authoring UI for unit / windows / calendar-org — config flows through the existing template create/update API (`approvals.ts:488`/`:539`, `approval-product.ts:455`/`:474`) and DB; admin UI is a later rung.
- Per-approver / per-assignee calendars or timezones — one calendar + one timezone per instance.
- Business-time-formatted overdue strings in the notifier beyond re-basing it on the real deadline.

### Contract — anchors it extends
- **Scanner SQL** — replaces `ApprovalMetricsService.ts:295`–`302`. New predicate: `terminal_at IS NULL AND sla_breached = FALSE AND ((sla_due_at IS NOT NULL AND sla_due_at < $1) OR (sla_due_at IS NULL AND sla_hours IS NOT NULL AND started_at + (sla_hours * interval '1 hour') < $1))`.
- **Start path** — extends the INSERT at `ApprovalMetricsService.ts:183`–`196` (adds `sla_due_at`, `sla_timezone`, `sla_unit`, `sla_amount`) and the call site at `ApprovalProductService.ts:3171`–`3178`.
- **Template columns** — extends `approval_templates.sla_hours` (`migration :27`, CHECK `sla_hours > 0` at `:36`); new `sla_unit` gets a CHECK constraint; new metrics columns extend `:49`.
- **Index** — a new partial index keyed on `sla_due_at` replaces `idx_approval_metrics_sla_scan` (`migration :83`–`86`), which is currently predicated on `terminal_at IS NULL AND sla_hours IS NOT NULL AND sla_breached = FALSE` ordered by `started_at`.
- **Port interface** (new): `WorkdayCalendarPort { resolveWorkdays(input: { orgId: string; from: string; to: string }): Promise<{ timezone: string; days: Array<{ date: string; isWorkingDay: boolean }> }> }` — shaped to map 1:1 onto `resolveEffectiveCalendar`'s `{ timezone, items[].date, items[].effective.isWorkingDay }` (`index.cjs:15800`, `:15819`, `:15831`).
- **Type surface** — `ApprovalTemplateListItemDTO.slaHours` (`approval-product.ts:423`) gains sibling `slaUnit`/`slaAmount`/`slaCalendarOrgId`/`slaNonCounting`; create/update requests (`approval-product.ts:455`, `:474`) accept them.

### Runtime / round-trip semantics
- **Start (cold path):** resolve org for the instance → `port.resolveWorkdays({ orgId, from = startedAt-date, to = startedAt-date + horizon })` → calculator walks forward to the deadline → persist `sla_due_at` + resolved tz. Guarded; on port failure, fall back per decision #4.
- **Scan (hot path):** every ~15 min the tick compares `sla_due_at < now` only (`ApprovalSlaScheduler.ts:140`). No calendar I/O in the loop.
- **Round-trip invariant (workday unit crossing a holiday):** a `workday`/`amount=1` instance started the evening before a public holiday must have `sla_due_at` land **after** the holiday; it must NOT breach while still inside its business window even though raw wall-clock elapsed already exceeds 24h.
- **Backward compatibility:** templates with only legacy `sla_hours` set (`sla_unit NULL`) keep `sla_due_at NULL` and remain on the UTC hours-math branch — byte-identical to today.

### Test plan (fail-first; assert the REAL wire)
**FAIL-FIRST integration test** — `packages/core-backend/tests/integration/approval-sla-workday-calendar.test.ts`:
1. Seed a public holiday via the **real** `attendance_holidays` insert shape (`index.cjs:11224`) on the day immediately after an instance's start.
2. Create a template with `sla_unit='workday'`, `sla_amount=1` and start a real instance through `ApprovalProductService` so `recordInstanceStart` runs.
3. Advance `now` to `started_at + 25h` (past a naive 24h SLA) but still inside the post-holiday business window.
4. Run the **real** `ApprovalMetricsService.checkSlaBreaches(now)` against the real SQL and assert it returns `[]` (not breached), and that the persisted `sla_due_at` resolves through the **real** `resolveEffectiveCalendar`/port — not a hand-built deadline.
   - **Why it is RED today:** the current scanner uses `started_at + sla_hours * interval '1 hour'` (`:301`) with no calendar wiring, so a workday-1 instance breaches on plain 24h elapse → the assertion `breached == []` fails until this rung lands.

**Supporting unit tests** (injected fake `WorkdayCalendarPort` + mock `Query`, mirroring `approval-metrics-service.test.ts` which constructs `new ApprovalMetricsService(queryMock)`): calculator `hour` skipping a non-counting window; `natural_day` local-midnight stepping across a DST boundary; `workday` stepping over `isWorkingDay=false` days; and a **legacy-fallback** test asserting a row with `sla_due_at NULL` + `sla_hours` set still breaches via the old math (proves the compatibility branch).

### Dependencies
- Attendance `resolveEffectiveCalendar` (`index.cjs:15578`) and `attendance_holidays` (migrations `zzzz20260114120000_add_attendance_scheduling_tables.ts`, `zzzz20260520020000_add_origin_to_attendance_holidays.ts`) must be present/migrated in the target environment.
- The chosen boundary mechanism (decision #1) must be implemented before the `workday`/`natural_day` paths are usable; `hour`/`minute` need no attendance dependency.
- New migration must run before the scanner cutover so `sla_due_at` and the replacement index exist.

### Open owner decisions
This rung changes the database schema, introduces a cross-domain dependency from approval into the attendance domain, and alters the breach decision path — so it is **not** decision-clean. The ten decisions (boundary mechanism, org↔tenant mapping, snapshot vs live recompute, fail-open vs fail-closed, timezone authority, non-counting-window semantics, migration/backfill shape, legacy default behaviour, notifier phrasing, deadline-search horizon) are enumerated with proposed defaults in the structured `openOwnerDecisions` / `proposedDefaults` fields. The headline is decision #1: approval (`packages/core-backend`) must reach a calendar that lives in the attendance plugin without violating the established "separate domain adapters, never read `attendance_*` directly" boundary — recommended resolution is a `WorkdayCalendarPort` interface owned by approval, with the attendance plugin registering the concrete provider.

---

## T3-3 — Handwritten signature / compliance

> **Status: SCOPING-LEVEL LOCK.** This rung locks the *node-level signature-requirement contract* and its round-trip persistence — the decision-light, additive, default-preserving floor. The signature **kind** (handwritten image vs typed attestation), **runtime enforcement**, **image-bytes capture/storage**, **mobile capture**, and **compliance retention** are explicitly **OPEN owner decisions** (see the decision list). Nothing in the locked floor commits to those answers.

### 1. Scope

**What gets built (locked):**

1. A new optional node-config field `signaturePolicy` on approval nodes, declared **forward-stable and default-preserving** — a node without it behaves exactly as today (every existing template/instance is byte-for-byte unchanged). This mirrors the established `NodeFieldAccess` / `fieldPermissions` precedent, which declared enum members and a normalized-through field *before* wiring runtime behavior.
2. The backend graph normalizer is extended so `signaturePolicy` **survives the full persistence round-trip** (template create/update → published runtime graph → dispatch-time re-normalize). This is the keystone: today the approval-node branch of the normalizer rebuilds `config` from a fixed whitelist and **silently drops any unknown key**, so without this change the field would never persist.
3. A locked round-trip guarantee through the front-end node editor (the editor already preserves unknown config keys; this rung pins that with a test).
4. Optionally (per the authoring-UI decision) a thin "require signature" checkbox in the node editor, clearly labelled as not-yet-enforced.

**What does NOT get built here (deferred to follow-up rungs / gated on the open decisions):**

- Server-side **enforcement** of the requirement (the field is declared runtime-**inert** this rung, exactly as `fieldPermissions`' `readonly`/`editable` members are declared-but-inert).
- Any **signature-capture widget** (handwritten canvas / touch / mobile).
- Any **image-bytes storage** pipeline, new DB table/column, or migration.
- Any new **audit action** or change to the `approval_records` action CHECK constraint.
- **Retention / erasure / legal-hold** machinery.

### 2. Contract + real code anchors (every anchor read in `metasheet2-audit`)

**2a. Type contract — `packages/core-backend/src/types/approval-product.ts`**

- `ApprovalNodeConfig` is defined at **L78-90**; its last optional member `fieldPermissions?: NodeFieldPermission[]` (**L89**) is the exact precedent. Add a sibling:
  ```ts
  // LOCKED minimal shape — richer fields (kind, appliesTo) are OPEN decisions.
  export interface NodeSignaturePolicy { required: boolean }
  // in ApprovalNodeConfig (after fieldPermissions, L89):
  signaturePolicy?: NodeSignaturePolicy
  ```
  The doc-comment at **L32-47** (explaining that `fieldPermissions`' `hidden` is enforced while `readonly`/`editable` are "declared now so the contract is forward-stable; do not wire them") is the literal template for `signaturePolicy`'s inert-this-rung framing.
- `ApprovalActionType` union (**L16-24**) is unchanged — signature rides on existing `approve`/`reject`, not a new action.
- `ApprovalActionRequest` (**L379-400**) is where a future `signature?: …` reference field plumbs in (deferred to the enforcement rung; not added now).
- `UnifiedApprovalHistoryDTO.metadata: Record<string, unknown>` (**L362-372**, metadata at **L371**) is the typed audit-echo channel.

**2b. Keystone normalizer — `packages/core-backend/src/services/ApprovalProductService.ts`**

- The approval-node case of `normalizeApprovalGraph` rebuilds `normalizedNode.config` from a **fixed whitelist** at **L1037-1049** (`assigneeType/assigneeIds`, `assigneeSources`, `approvalMode`, `emptyAssigneePolicy`, `autoApprovalPolicy`, `fieldPermissions`). Any key not in this object is **dropped**. The fix mirrors `fieldPermissions` exactly:
  - add a `normalizeNodeSignaturePolicy(...)` helper modeled on `normalizeNodeFieldPermissions` (declared at **L893**, called at **L1032-1036**);
  - add `...(signaturePolicy ? { signaturePolicy } : {})` to the rebuilt config object at **L1037-1049** (omit-when-absent, consistent with the surrounding spreads so untouched nodes stay byte-identical).
- **Single gate, both directions (verified):** `assertApprovalGraph` (**L1577-1583**) is a thin wrapper that just calls `normalizeApprovalGraph`. The save path and the dispatch-time stored read both funnel through it — `asRuntimeGraph` (**L1614-1635**, the read at dispatch, called from `dispatchAction` at **L3465**) calls `assertApprovalGraph` at **L1620**. The publish step's `buildRuntimeGraph` (**L1637-1647**) is a passthrough `JSON.parse(JSON.stringify(approvalGraph))` deep-clone that does **not** re-whitelist. Therefore the one normalizer change covers create, update, publish, and every dispatch read — there is no second independent projection to patch. (This is the codebase's own "whitelist/pick/select projection must round-trip through real wire" rule applied.)

**2c. Audit storage seam (no migration) — same file + migration**

- `insertApprovalRecord` (**L4555-4581**) writes `JSON.stringify(record.metadata)` into the `approval_records.metadata` JSONB column (param 10, **L4575**). A signature *reference* can live here with **no migration**.
- Migration `db/migrations/20250924105000_create_approval_tables.ts` shows `approval_records` already has both `metadata JSONB DEFAULT '{}'` (**:33**) and a **dormant** `attachments JSONB DEFAULT '[]'` column (**:32**) that `insertApprovalRecord` never writes. The action CHECK (**:20**, later widened by `zzzz20260515130000_add_jump_action_to_approval_records.ts` to `created/approve/reject/return/revoke/transfer/sign/comment/cc/remind/jump`) already permits `approve`/`reject`, so no action-constraint migration is needed for the default audit path.
- **Echo gap (sharpens the PII decision):** the platform history read endpoint `routes/approval-history.ts` SELECTs `id, occurred_at, actor_id, actor_name, action, comment, from_status, to_status, version, from_version, to_version` at **L86-104** and returns `{ items: rows }` raw — it does **not** project `metadata` (nor `attachments`). So a signature reference written to `metadata` will NOT surface in the timeline until that SELECT is extended. This is a feature, not a bug, for compliance: the read projection is the natural place to apply redaction.

**2d. Enforcement mirror (for the deferred enforcement rung)**

- The reject-comment-required guard at **L3762-3764** (`throw new ServiceError('Rejection comment is required', 400, …REJECT_COMMENT_REQUIRED)`) is the exact pattern for a future `APPROVAL_SIGNATURE_REQUIRED` fail-closed check, placed after the current-node + `actorCanAct` resolution (**L3509-3519**) using the node's `signaturePolicy` read from the runtime graph.

**2e. Route plumbing — `packages/core-backend/src/routes/approvals.ts`**

- Action enum validation at **L1440-1447**; body-field plumbing pattern (`targetUserIds`/`addSignMode`) at **L1449-1468**; `dispatchAction` call passing the request at **L1514-1526**. A future `signature` body field plumbs here exactly like `targetUserIds`. (No route change in the locked floor.)

**2f. Front-end round-trip + capture insertion point**

- `apps/web/src/approvals/approvalNodeEdit.ts` — `applyApprovalNodeEditsToGraph` at **L81-94** rebuilds each approval node with **spread-original-first** (`{ ...originalConfig, assigneeSources: … }`, **L87**), so a new config key like `signaturePolicy` is **preserved verbatim** with no editor change. This rung pins that with a unit test.
- `apps/web/src/views/approval/ApprovalDetailView.vue` — the approve/reject dialog (**L320-346**) and `submitAction` (**L856-869**, which calls `store.executeAction(id, { action, comment })`) are the future insertion point for a capture widget + `signature` payload. No existing canvas/signature-pad component exists in the FE (verified), so capture is net-new and deferred.

### 3. Runtime / round-trip semantics

- **Round-trip (locked):** author sets `config.signaturePolicy.required = true` on an approval node → `normalizeApprovalGraph` accepts and preserves it at save → stored in `approval_graph` → `buildRuntimeGraph` deep-clones it into the published `runtime_graph` → at dispatch `asRuntimeGraph`→`normalizeApprovalGraph` re-accepts it. With the keystone fix, `required` survives all four hops; without it the key is dropped at hop 1 (save) and again at hop 4 (dispatch read).
- **Default-absent (locked):** a node with no `signaturePolicy` normalizes to a config with no such key (omit-when-absent spread), so legacy templates and in-flight instances are byte-identical.
- **Inert this rung (locked):** no dispatch path reads `signaturePolicy`; approve/reject behave exactly as today. The compliance *behavior* (enforcement, capture, retention) activates only after the corresponding open decisions are taken.

### 4. Test plan (real wire; includes a fail-first)

1. **FAIL-FIRST — publish round-trip over real HTTP (integration).** Mirror `tests/integration/approval-p1c-field-permissions.api.test.ts` (boots `MetaSheetServer`, dev-token auth, real `POST /api/approval-templates` → `POST …/publish` → `POST /api/approvals` → `POST …/actions`). Create a template whose approval node config carries `signaturePolicy: { required: true }`, publish it, then read it back through the real wire (published template-version detail and/or by driving a dispatch and asserting the node config the executor sees). Assert `node.config.signaturePolicy.required === true`. **RED today**: `normalizeApprovalGraph`'s whitelist (L1037-1049) strips the key at save and again at `asRuntimeGraph` dispatch-read. GREEN after the keystone fix. This asserts the persisted+re-normalized wire, not a hand-built graph object.
2. **Default-preserving (integration).** Mirror `buildLegacyGraph` from the p1c test: a node with no `signaturePolicy` round-trips with no `signaturePolicy` key injected (no spurious diff, no behavior change).
3. **FE editor preserve (unit, runs under the approval-web-guard vitest gate — no `.vue`/Element Plus import).** Build a graph whose approval node has both `assigneeSources` and `signaturePolicy`; run `applyApprovalNodeEditsToGraph` editing only `assigneeSources`; assert `signaturePolicy` survives byte-identical (pins the spread-original-first guarantee at approvalNodeEdit.ts:87).
4. **(Gated, enforcement rung — described, not in this lock.)** Once enforcement is decided: dispatch `approve` without a signature at a `required` node → expect `400 APPROVAL_SIGNATURE_REQUIRED`; today it returns 200. RED→GREEN belongs to that rung because it depends on the signature-KIND and enforcement decisions.

### 5. Dependencies

- **Locked floor:** none new. Pure additive change to existing types + the existing `normalizeApprovalGraph` + an existing FE seam, plus tests on the existing real-DB integration harness.
- **Deferred phases:** `StorageService` (`StorageProvider.upload`/`getFileUrl`/`getPresignedUploadUrl`, defined at StorageService.ts:114-125) for image bytes; a net-new FE signature-pad/canvas component (none exists today) for capture; a history-SELECT projection change (approval-history.ts:86-104) for audit echo; possibly a retention job for the compliance horizon.

### 6. Explicit non-goals

- No runtime enforcement of the requirement in this rung (declared-inert, `fieldPermissions` precedent).
- No image capture, no canvas/touch/mobile capture, no image-bytes storage, no use of the dormant `attachments` column.
- No new DB table, column, index, or migration; no new audit action; no change to the `approval_records` action CHECK.
- No retention/erasure/legal-hold engine; no PDF rendering with an embedded signature; no biometric or certificate-based (PKI) verification; no multi-signature ordering semantics.
- Brand-neutral: this is stated as a MetaSheet node-level signature-requirement capability; no external product is referenced.

---

## T3-1 — Mobile approval surface

**Rung size:** L · **Type:** scoping lock (architecture sketch, not a full implementable spec) · **Web only.**

### 1. Scope

This rung locks the *scope and decision set* for a mobile-friendly approval surface — it does **not** authorise building push, offline, or a native app. The committed, decision-light deliverable is small; everything heavy is enumerated as an open owner decision (§7).

**In scope (committed v0 seam):**
- A mobile/touch-viewport approval surface that supports the three core flows — **review-list + approve/reject** and **initiate** — by reusing the *existing* REST endpoints with **zero new server contract**.
- A wire-level commitment: the mobile surface consumes the same `UnifiedApprovalDTO` list and the same action/create endpoints the desktop views already use (§3).
- Reuse of the existing in-app realtime badge (socket.io) for "new approval" awareness while a session is open — unchanged.

**Explicitly NOT in scope of this rung (each is an open decision in §7, gated for a later slice):**
- Any **out-of-app push** (Web Push / VAPID / service worker / FCM / APNs). None exists today.
- A **PWA / installable** shell, manifest, or service worker.
- **Offline** mutation/queueing.
- The richer action set (transfer / return / add_sign / reduce_sign / revoke / remind / admin-jump).
- A **native** application (ruled out by "Web only").
- Any schema migration.

### 2. Existing substrate (read + anchored)

The platform already exposes a complete, brand-neutral REST + realtime substrate the mobile surface reuses verbatim:

- **List / inbox**: `GET /api/approvals` with `tab=pending|mine|cc|completed`, `sourceSystem=all|platform|plm`, `status`, `search`, paging — `routes/approvals.ts:608`. Client wrapper `listApprovals` — `apps/web/src/approvals/api.ts:750`.
- **Pending/unread badge**: `GET /api/approvals/pending-count` returns `{ count, unreadCount }` — `routes/approvals.ts:929`; client `getPendingCount` — `api.ts:823`.
- **Unified action dispatch (version-less)**: `POST /api/approvals/:id/actions`, `rbacGuard('approvals','act')`, accepts `approve|reject|transfer|revoke|comment|return|add_sign|reduce_sign` — `routes/approvals.ts:1428` (action allow-list at `:1440`). This is the path the desktop detail view actually uses: `ApprovalDetailView.vue` `submitAction` → `store.executeAction` → `dispatchAction` → `POST .../actions` (`api.ts:953`).
- **Legacy version-guarded actions**: `POST /api/approvals/:id/approve` (`routes/approvals.ts:1570`) and `/reject` (`:1706`) require `version` and return **409** on mismatch (`approvalVersionConflictResponse`, `:174`). The legacy `ApprovalInboxView.vue` (`apps/web/src/views/ApprovalInboxView.vue:328`) uses these.
- **Initiate**: `POST /api/approvals` with `{ templateId, formData }` — `routes/approvals.ts:748`; client `createApproval` — `api.ts:790`. Form renderer `ApprovalNewView.vue` (leaf field types, detail sub-form via `el-table` at `:157`, attachment via 10MB `el-upload` at `:286`).
- **Detail / history**: `GET /api/approvals/:id` (`routes/approvals.ts:1849`), `GET /api/approvals/:id/history`.
- **In-app realtime (the only push-like path today)**: backend `broadcastTo(buildAuthenticatedUserRoom(userId), 'approval:counts-updated', payload)` — `services/approval-realtime.ts:117`; room join on socket connect — `services/CollabService.ts:108`; frontend subscriber `useApprovalCountsRealtime.ts:98`. **This only delivers to an open, connected tab** — there is no out-of-app delivery.
- **Permissions**: `approvals:read | write | act` via `useApprovalPermissions` (`apps/web/src/approvals/permissions.ts`); routes gated by `rbacGuard` and route-meta `permissions` (`appRoutes.ts:253`). Viewport meta already present (`apps/web/index.html:6`).

### 3. Contract (what is locked)

The locked contract for this rung is deliberately thin (scoping-lock altitude):

1. **No new server contract in v0.** The mobile surface binds to the existing endpoints in §2 exactly. The mobile review-list issues `GET /api/approvals?tab=pending&sourceSystem=<filter>`; approve/reject issue `POST /api/approvals/:id/actions`; initiate issues `POST /api/approvals`. The data shape is the existing `UnifiedApprovalDTO` (`apps/web/src/types/approval.ts`).
2. **One new client seam**: a mobile approval surface module (route or responsive component — the structural form is an open decision, §7) whose *data contract* is fixed even though its layout is not.
3. **Everything that would require a new endpoint, a new event, a service worker, or a schema migration is explicitly deferred** into §7 and is NOT part of this lock. In particular, push subscription storage, a push dispatch endpoint, and any VAPID/web-push wiring are **not** contracted here — they remain open decisions so the doc stays internally consistent (push cannot be both "open decision" and "locked contract").

### 4. Runtime / round-trip semantics

- **Awareness, today**: a connected mobile tab receives `approval:counts-updated` over socket.io and updates the badge — but a backgrounded/closed mobile browser receives nothing. **Closing this out-of-app gap is the rung's reason to exist, and it is the single biggest open decision** (§7, push transport + dispatch source).
- **Action round-trip / concurrency**: v0 mobile approve/reject use the **version-less** unified `/actions` path, identical to desktop. Stale-list protection today is only the server-side status guard (a non-`pending` instance is rejected). Mobile amplifies stale-list double-action risk (longer-lived lists, intermittent connectivity); whether mobile must adopt the version-guarded legacy path (409) is an explicit decision (§7).
- **Initiate round-trip**: `pruneHiddenFormDataWithDetail` + auto-sum mirror the desktop semantics; the open question is which field types render acceptably on a touch viewport (detail `el-table`, 10MB attachment) — §7.

### 5. Test plan (incl. fail-first)

Tests run in the existing **frontend vitest + mounted-app harness** (model: `apps/web/tests/approvalCountsRealtime.spec.ts`). Note: there is **no** backend supertest harness in `core-backend` (verified — do not promise one).

- **FAIL-FIRST (asserts the REAL wire, not fixtures):** mount the new mobile approval-list surface and assert that on mount it issues a real `GET /api/approvals?tab=pending` request and renders real `UnifiedApprovalDTO` fields (`title`, `status`) from the response.
  - It goes **RED today** because the surface module does not exist (import/route resolves to nothing).
  - **Wire-vs-fixture guard**: the test MUST disable mock mode — `api.ts:30` short-circuits to `mockApproval()` fixtures when `import.meta.env.DEV || __APPROVAL_MOCK__`. Stub `apiFetch`/`apiGet` and assert the **request URL + method + query** (`/api/approvals`, `tab=pending`, `sourceSystem=…`) and that rendered rows reflect the stubbed response body — never the mock factory output. Without disabling mock, the test green-passes against hand-built fixtures (the known wire-vs-fixture trap).
- **Action wire test**: assert the mobile approve button issues `POST /api/approvals/:id/actions` with body `{ action: 'approve' }` (mock disabled), and reject requires a non-empty comment per existing `policy.rejectCommentRequired`.
- **Initiate wire test**: assert submit issues `POST /api/approvals` with `{ templateId, formData }`.
- **Permission gating**: assert action affordances are hidden when `canAct` is false (`permissions.ts`).

### 6. Deps + non-goals

**Dependencies:**
- Existing approval REST + `UnifiedApprovalDTO` (`routes/approvals.ts`, `apps/web/src/approvals/api.ts`) — present.
- Existing socket.io realtime (`approval-realtime.ts`, `CollabService.ts`) — present, in-app only.
- **(Push slice only, deferred)** a **Notification Hub** that does not yet exist — the remind handler already defers external IM/email/push to it (`routes/approvals.ts:1155-1159`). Any out-of-app push slice is blocked on that hub plus a schema migration plus VAPID secret management.

**Non-goals (this rung):** native app; PWA/service worker/manifest; out-of-app push; offline mutations; push subscription schema; the richer action set; admin-jump on mobile; any change to desktop views' contract.

### 7. Open owner decisions

This rung is **not decision-clean**: it touches a schema-and-security surface (push subscriptions), a privacy surface (lock-screen payload), and multiple product forks. The full enumerated decision set with proposed defaults is carried in the structured `openOwnerDecisions` / `proposedDefaults` fields. Headline forks: (a) native vs PWA vs responsive-web; (b) out-of-app push transport (none exists); (c) push dispatch source / Notification Hub dependency; (d) push subscription storage migration + key security; (e) lock-screen payload content; (f) offline read-only vs queued mutations; (g) version-less vs version-guarded mobile actions; (h) v0 action set; (i) initiate field support (detail/attachment); (j) separate `/m/*` route vs responsive adaptation; (k) rollout gating / feature flag.

---

## T3-6 — S-band: approval data as first-class multitable records

> Status: **architecture / scoping lock (pre-implementation)**. Grounding: audit worktree
> `metasheet2-audit` @ `7113f8b05`. This is an **L strategic lock** — it picks the system-of-record
> stance and the buildable first slice, and surfaces the product/security/migration decisions the
> owner must make. Implementation is a separate, gated PR. Brand-neutral: MetaSheet principles only.

### 1. The strategic intent (and why it is more than W7)

The S-band goal is that approval data — *form values, the running instance, and the outcome* —
behaves like ordinary multitable data: **formulas, dashboards, automation, and views operate on it
without a bespoke sync layer**. Today they cannot, because approval data and multitable data live in
two physically separate stores:

- **Approval store** — `approval_templates` / `approval_template_versions` (`form_schema`,
  `approval_graph` jsonb) / `approval_published_definitions` (`runtime_graph`) / `approval_instances`
  (`status`, `request_no`, `form_snapshot` jsonb, `current_node_key`, `requester_snapshot`) /
  `approval_records` (the action ledger). Anchors:
  `db/migrations/20250924105000_create_approval_tables.ts:9-15` (base instance row),
  `db/migrations/zzzz20260411120100_approval_templates_and_instance_extensions.ts:16-49` (templates :16-26,
  versions :28-38 with `form_schema` :33 / `approval_graph` :34, published defs :40-49 with `runtime_graph` :44),
  and `:73-78` (the `template_id` / `template_version_id` / `published_definition_id` / `request_no` /
  `form_snapshot` / `current_node_key` instance columns).
- **Multitable store** — `meta_sheets` / `meta_fields` / `meta_views` / `meta_records` / `meta_links`.
  Anchors: `db/migrations/zzz20251231_create_meta_schema.ts:7-69` — `meta_records` at `:44-51`
  (`data` jsonb `:47`, `version` `:48`), `meta_fields` at `:17-27` (`type` `:22`, `property` jsonb `:23`).
  Extension columns the projection must respect: `locked`/`locked_by`/`locked_at`
  (`zzzz20260612140000_add_meta_record_locked.ts:20-22`), `created_by`
  (`zzzz20260406093000_add_meta_record_created_by.ts:7`), `modified_by`
  (`zzzz20260430163000_add_meta_record_modified_by.ts:4`), trash
  (`zzzz20260617120000_create_meta_records_trash.ts:19`).

**W7 is the narrow bridge, not this rung.** W7 (`AutomationService.writeApprovalResultBack`,
`multitable/automation-service.ts:1783-1841`) copies a *fixed three-field* outcome
(`statusField`/`approverField`/`completedAtField`) onto **one source record**, **approved-only**,
driven by the `start_approval` automation action and the `multitable_automation_approval_bridges`
1:1 linkage (`multitable/automation-approval-bridge-service.ts:194-310`,
`db/migrations/zzzz20260610150000_create_automation_approval_bridges.ts`). It is a value-copy of three
cells, not "approval data as records." T3-6 is the general case: the *instance itself* as a governed
multitable row.

Two capability gaps prove the silo is real and structural:
- **Approval forms cannot reference multitable records.** `FormFieldType`
  (`types/approval-product.ts:54-64`) is `text | textarea | number | date | datetime | select |
  multi-select | user | attachment` (+ `detail`) — there is **no `link`/record-reference type**,
  even though multitable has had `link` / `person` / `lookup` / `rollup` since
  `multitable/field-codecs.ts:6-36` (`link` `:15`).
- **Instances are not records.** A live instance is an `approval_instances` row with a frozen
  `form_snapshot` and `requester_snapshot` (`ApprovalProductService.ts:3036-3066`), surfaced only
  through `UnifiedApprovalDTO` (`services/approval-bridge-types.ts:14-34`;
  `toUnifiedApprovalDTO` at `ApprovalProductService.ts:1340-1384`, `formSnapshot` `:1374`, frozen
  schema `:1377`). Nothing in `meta_records` knows it exists, so no formula/view/dashboard can see it.

### 2. Architecture stance (LOCKED) — one-way materialized read-model projection

This lock adopts **one** of three stances and names the other two as non-goals so the owner sees the
fork explicitly:

- **(A) LOCKED — materialized read-model projection.** The approval engine **remains the
  system-of-record**. Multitable gains a **system-owned, managed "approval-object" sheet** whose rows
  are `meta_records` materialized **1:1 from `approval_instances`**, written by a projector that
  subscribes to the **already-shipped completion-event channel** and runs once at create. This
  generalizes W7 from "three fixed cells on the source record" to "a full governed row per instance,"
  reusing W7's exact value-constrained, lock-guarded discipline. It is **one-way** (approval → record)
  for this rung.
- **(B) NON-GOAL — inverted ownership** (the record is the system-of-record; editing the record
  mutates the live approval). Rejected as a default: it breaks `form_snapshot` immutability, the
  `approval_instances.version` optimistic-concurrency line
  (`db/migrations/zzzz20260411120100…:74`), and the frozen-template-version render contract
  (`toUnifiedApprovalDTO` `frozenFormSchema` `:1377`). It is a *decision*, not a default — see §6 D1.
- **(C) NON-GOAL — virtual sheet / query adapter** (expose `approval_instances` through the multitable
  query API with no duplication). Elegant but the formula/rollup/link/dashboard stack assumes a
  physical `meta_records` row with stable `id` + `data` jsonb + `version` + indexes; a virtual adapter
  would re-implement that surface against a foreign schema. Higher risk; deferred.

**Principle (inherited from W7): the projection carries system values only.** Status enum, `request_no`,
template ids, requester/approver ids, and ISO timestamps — never user-templated strings — exactly the
constraint that gated the W7 write path (`automation-service.ts:1807-1808`, "patch carries ONLY system
outcome values"). The projector re-uses the **lock guard** (`ensureRecordNotLocked`,
`automation-service.ts:1806`) and emits the same `multitable.record.updated` fan-out
(`automation-service.ts:1822-1828`) so views/subscribers see the projected row live.

### 3. Scope — exactly what gets built

**In scope (this rung):**
1. A **managed approval-object sheet** (system-owned, `meta_sheets` row) provisioned lazily, with a
   fixed allowlisted column set of `meta_fields` (request_no, status/outcome, template id+version,
   requester id, current approver id, created/completed timestamps).
2. A **projector** that (a) on `createApproval` upserts the new instance's row, and (b) subscribes to
   the four terminal completion events and updates status/outcome/approver/completed-at.
3. A **1:1 side mapping** (`approval_instances.id` ↔ `meta_records.id`), UNIQUE on instance id,
   mirroring the `multitable_automation_approval_bridges` 1:1 idempotency pattern.
4. **Idempotent upsert** keyed on instance id, last-writer-wins by `occurredAt`, lock-guarded.

**Explicitly NOT in scope (each a named later opt-in):** record→instance write-back / inverted
ownership (B); virtual sheet (C); the record-reference `FormFieldType` (the "forms reference records"
half — see §6 D8); full `form_snapshot` projection (allowlist only here); per-row ACL inheritance from
approval visibility; person/link-typed requester/approver cells; cross-base projection; in-flight
node-by-node progress.

### 4. Contract + real anchors it extends

- **Source of truth for projection events — the completion channel (reuse, do not invent).**
  `ApprovalCompletionEventV1` (`services/ApprovalCompletionEvent.ts:45-68`) carries
  `approval.instanceId` / `requestNo` / `templateId` / `templateVersionId` /
  `publishedDefinitionId`, `transition.toStatus` (`:39`, one of approved/rejected/revoked/cancelled),
  `actor` (`:61-64`), `occurredAt` (`:49`), `requester` (`:65-67`). Emitted by
  `emitApprovalCompletionEvent` (`:123-131`) at create (`ApprovalProductService.ts:3187-3188`) and on
  every terminal transition (`:3414-3415`, `:3749`, `:3889`). It is **already consumed** the same way
  W7 consumes it — `AutomationService` subscribes at `automation-service.ts:734-744`
  (`['approval.approved','approval.rejected','approval.revoked','approval.cancelled']`) → handler
  `:1663` → `claimCompletion` (`automation-approval-bridge-service.ts:312-327`). **The projector
  registers a second, independent subscriber on the same four events** — it does not piggy-back on the
  W7 bridge claim (the bridge is per-automation-execution; the projection is per-instance and must fire
  even when no automation started the approval).
- **Create-time projection hook.** `createApproval` freezes the instance and emits the create event at
  `ApprovalProductService.ts:3036-3066` / `:3187-3188`; the projector's create path keys off that same
  emit (or a direct call) so a manually-created approval (no automation) is also projected.
- **Write path — the real multitable record write.** Project via the existing `meta_records` write
  primitives the W7 runtime already uses: read `SELECT data FROM meta_records …`
  (`automation-service.ts:1696-1699`), guard `ensureRecordNotLocked` (`:1806`), and jsonb-merge
  `UPDATE meta_records SET data = COALESCE(data,'{}') || $1::jsonb, version = version + 1 …`
  (`automation-service.ts:1810-1815`). The projector's insert path mirrors `RecordWriteService`
  (`multitable/record-write-service.ts:390`) for new rows. **The backend is the final arbiter** — field
  types on the managed sheet are validated exactly as W7 validates its targets
  (`resultWritebackFieldTypeError`, `automation-service.ts:242-268`).
- **Config / data contract added:** the side mapping table `approval_record_projections`
  (instance_id UNIQUE → sheet_id, record_id, last_outcome, last_occurred_at), and the managed sheet's
  field id constants. No column is added to `meta_records` for all sheets.

### 5. Runtime / round-trip semantics

- **Create → row appears.** `createApproval` → projector upserts a `meta_records` row on the managed
  sheet with status `pending`, request_no, template, requester id. A dashboard/formula sees the
  in-flight approval immediately.
- **Terminal transition → row updated, idempotently.** An `approval.{approved,rejected,revoked,cancelled}`
  event → projector updates status/outcome/approver/completed-at on the **same** row (looked up via the
  side mapping). The eventBus is at-least-once; the upsert is keyed on instance id and ignores an event
  whose `occurredAt` is older than the row's `last_occurred_at` (W7's "last-writer-wins, lock-guarded"
  discipline, `automation-service.ts:1800-1815`).
- **One-way only.** Editing the projected record does **not** mutate the approval instance. The managed
  sheet is read-only to end users; the projector is the sole writer.
- **No new approval-side coupling.** The approval engine emits the same events it already emits; if the
  projector throws, it must (like W7's best-effort backwrite, `automation-service.ts:1716-1725`) log +
  skip, never crash the approval transition.

### 6. Open decisions → see the structured `openOwnerDecisions` (D1–D10)

This rung is **not decision-clean**: it changes schema (new managed sheet + mapping table), touches a
security boundary (projecting approval form data into a multitable-governed surface), and forks on the
system-of-record question. The ten decisions are enumerated with proposed defaults in the structured
output; the load-bearing ones are **D1 system-of-record direction** (default: engine stays SoR,
one-way), **D3 governance precedence** (default: sheet-scoped, read-only, no per-row ACL inheritance
yet), **D4 PII exposure** (default: allowlisted columns, not full `form_snapshot`), and **D8 the
forms-reference-records `FormFieldType`** (default: defer to its own rung).

### 7. Test plan (the implementation PR must include these; ≥1 is fail-first against the REAL wire)

- **FAIL-FIRST — create projects a record (real wire).** Call `ApprovalProductService.createApproval`
  for a published template, then `SELECT … FROM meta_records` on the managed sheet via the real query
  fn and assert a row exists with `status='pending'` and the instance's `request_no`. **Fail-first:**
  with no projector registered, no `meta_records` row is created → RED. Asserts the real DB row, **not
  a hand-built fixture** — proving the projector is wired to the actual create path, not a stub.
- **FAIL-FIRST — terminal completion updates the SAME row via the real event.** Emit a genuine
  `approval.approved` `ApprovalCompletionEventV1` through `emitApprovalCompletionEvent`
  (`ApprovalCompletionEvent.ts:123`) — the exact channel W7 subscribes to — and assert the projected
  `meta_records.data` now carries `outcome='approved'`, the approver id, and the completed-at timestamp,
  on the **same record id** from the create test. **Fail-first:** without the second subscriber the row
  stays `pending` → RED. (Mirrors the W7 subscriber proof at `automation-service.ts:734-744`.)
- **Idempotency / replay.** Re-deliver the identical completion event; assert the row is unchanged and
  `version` did not double-increment (upsert keyed on instance id, `occurredAt` gate).
- **Lock guard.** With the projected record `locked` by a different user
  (`zzzz20260612140000_add_meta_record_locked.ts:20-22`), assert the projector logs+skips and never
  throws into the approval transition (W7 parity, `automation-service.ts:1716-1725`).
- **One-way isolation.** Edit the projected record's `data` directly; assert `approval_instances` is
  unchanged (the projection is read-model only).
- **No regression.** Existing W7 backwrite specs and `start_approval` bridge specs stay green; the
  projector is additive (a *second* independent subscriber, not a change to `claimCompletion`).

### 8. Dependencies + explicit non-goals

- **Deps:** the completion-event bus (`ApprovalCompletionEvent.ts`), the `meta_records` write path
  (`record-write-service.ts:390`, jsonb-merge `automation-service.ts:1810-1815`), the record lock
  (`record-lock.ts` via `ensureRecordNotLocked`), and managed-sheet provisioning
  (`multitable/provisioning.ts`).
- **Non-goals (named, each a later opt-in):** inverted ownership / record→instance write-back (D1);
  virtual-sheet adapter (§2 C); record-reference `FormFieldType` (D8); full `form_snapshot` projection
  (D4); per-row ACL inheritance from approval visibility (D3); person/link requester cells (D6);
  cross-base projection (D10); live in-flight node progress (D2); any change to the legacy W7
  approved-only source-record write-back (D9).

### 9. Landing

This design-lock is the opt-in artifact. **Implementation is a separate PR**, opened only on explicit
GO and only after D1–D10 are answered. Brand-neutral: states MetaSheet capability requirements;
benchmarked internally, no external product names in the contract.

---

