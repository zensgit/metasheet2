/**
 * Multitable BUTTON field run route (B1-a1 → B1-S1 D0-A).
 *
 * POST /sheets/:sheetId/records/:recordId/fields/:fieldId/button/run
 *
 * Runs a button field's configured action against the current record, mirroring
 * the AI-shortcut-run shape (#2623): preflight gates -> dispatch through the
 * existing automation executor (NO parallel path) -> redacted audit -> settle.
 *
 * Security (design-lock #2645): VISIBILITY != EXECUTABILITY. Seeing a button
 * requires the field to be visible; RUNNING it re-evaluates the action's own
 * gate server-side, as the actor, at dispatch.
 *
 * B1-S1 D0-A enables the FIRST side-effecting action: `send_notification`. It
 * writes a DURABLE in-app notification (Notification Center sink) to recipients
 * that are SERVER-VALIDATED against the sheet member set at dispatch (§3.1, the
 * #1 control). Side-effecting actions REQUIRE a requestId, REQUIRE server-side
 * confirmation when the button declares confirm.enabled, and HARD-REJECT the
 * whole run if ANY configured recipient is not a member.
 *
 * The durable delivery is a ROUTE-LEVEL DEDICATED SIDE-EFFECT TRANSACTION (it does
 * NOT live in the shared AutomationExecutor). All-succeed-or-all-fail in ONE DB
 * transaction, in this order:
 *   server-confirm gate → actor edit gate → recipient hard-reject → dedup
 *     → notification rows → audit row.
 * The no-write validation (confirm / actor / recipient) runs BEFORE the
 * transaction opens, so a rejected run writes NOTHING (no notification, no audit,
 * no dedup marker — the requestId is NOT consumed and a later valid retry with the
 * same requestId still sends once). dedup + notification + audit then commit
 * together; if the audit insert fails, the WHOLE run rolls back (fail-closed — no
 * "sent but unaudited" state). The inert `record_click` stays read-gated,
 * requestId-optional, and OFF this transactional path.
 */

import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { buildRecordPatchContext, requireRecordReadable } from './univer-meta'
import { type ConnectionPool, type QueryFn } from '../multitable/record-write-service'
import { poolManager } from '../integration/db/connection-pool'
import { eventBus } from '../integration/events/event-bus'
import {
  AutomationExecutor,
  AUTOMATION_EXECUTION_SCHEMA_VERSION,
  type AutomationExecution,
  type AutomationStepResult,
  type ExecutionContext,
} from '../multitable/automation-executor'
import type { AutomationActionType } from '../multitable/automation-actions'
import { AutomationLogService } from '../multitable/automation-log-service'
import { loadSheetMemberUserIdSet } from '../multitable/permission-service'
import { insertRecordSubscriptionNotifications } from '../multitable/record-subscription-service'
import { normalizeJson, normalizeMultiSelectValue } from '../multitable/field-codecs'
import { ensureRecordWriteAllowed } from '../multitable/sheet-capabilities'
import { ensureRecordNotLocked } from '../multitable/record-lock'
import { redactString, redactValue } from '../multitable/automation-log-redact'
import { checkWebhookTargetUrl } from '../multitable/webhook-ssrf-guard'
import { pinnedHttpsFetch } from '../multitable/webhook-pinned-fetch'
import { WebhookService } from '../multitable/webhook-service'
import { Logger } from '../core/logger'

type PoolLike = ConnectionPool & { query: QueryFn }
const logger = new Logger('MultitableButton')

// B1-S1 D0-A enabled actions. `record_click` = executor-owned INERT (read-gated,
// requestId-optional, NO confirm). `send_notification` = first side-effecting
// action (notify-gated via canSendNotification, durable + deduped + audited in one route transaction).
// Every new action must declare its actor gate AND whether it is side-effecting —
// a single `sideEffecting` flag drives BOTH the requestId requirement (§6 dedup)
// AND the server-side confirm requirement (§4): a side-effecting action whose
// button declares confirm.enabled MUST be confirmed by the server, not just the FE.
type ButtonActorGate = 'read' | 'edit' | 'notify' | 'webhook'
interface ButtonActionPolicy {
  /** Actor permission required to RUN this action (server-evaluated at dispatch). */
  gate: ButtonActorGate
  /**
   * Side-effecting actions REQUIRE a requestId (§6 at-most-once) AND, when the
   * button declares confirm.enabled, REQUIRE `confirmed === true` from the server
   * (§4 — the FE confirm dialog is an affordance, the server is the gate). Inert
   * actions are neither.
   */
  sideEffecting: boolean
  /** The executor action dispatched for this button click. */
  dispatchType: AutomationActionType
}

const BUTTON_ACTION_POLICIES: Record<string, ButtonActionPolicy> = {
  record_click: { gate: 'read', sideEffecting: false, dispatchType: 'record_click' },
  send_notification: { gate: 'notify', sideEffecting: true, dispatchType: 'send_notification' },
  // B1-S1 D0-B: first RECORD-MUTATING button action. `edit` gate is the sheet-level
  // pre-filter; the dispatch branch re-gates the SPECIFIC row (write-own + lock) so a
  // button can never mutate a row the clicker could not edit directly (no elevation).
  update_record: { gate: 'edit', sideEffecting: true, dispatchType: 'update_record' },
  // B1-S2: first EXTERNAL-EGRESS button action. `webhook` gate = a dedicated egress capability
  // (admin or `multitable:send_webhook`), checked DIRECTLY at dispatch (egress ≠ edit); the dispatch
  // additionally SSRF-validates the target and connects to the pinned address (#2950/#2956).
  send_webhook: { gate: 'webhook', sideEffecting: true, dispatchType: 'send_webhook' },
}

export function createMultitableButtonRoutes(): Router {
  const router = Router()
  const logService = new AutomationLogService()

  router.post('/sheets/:sheetId/records/:recordId/fields/:fieldId/button/run', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    const recordId = typeof req.params.recordId === 'string' ? req.params.recordId.trim() : ''
    const fieldId = typeof req.params.fieldId === 'string' ? req.params.fieldId.trim() : ''
    const parsed = z
      .object({
        requestId: z.string().min(1).max(100).optional(),
        // §4 server-confirm: a side-effecting button with confirm.enabled requires
        // confirmed===true. FE-only window.confirm is bypassable by a direct POST,
        // so the server is the gate.
        confirmed: z.boolean().optional(),
      })
      .safeParse(req.body ?? {})
    if (!sheetId || !recordId || !fieldId || !parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId, recordId, fieldId are required' } })
    }
    const requestId = parsed.data.requestId
    const confirmed = parsed.data.confirmed === true

    try {
      const pool = poolManager.get() as unknown as PoolLike
      const query = pool.query.bind(pool) as QueryFn

      // 1) Actor RECORD-READ gate (also 404s a record not on this sheet, 401 unauth).
      //    This IS the inert record_click's own gate (visibility != executability,
      //    re-evaluated server-side as the actor).
      const readable = await requireRecordReadable(req, query, sheetId, recordId)
      if ('status' in readable) {
        return res.status(readable.status).json(readable.body)
      }
      const { access, capabilities, sheetScope } = readable

      // 2) Load the field + its derived permissions for THIS actor.
      const ctx = await buildRecordPatchContext(req, query, sheetId, access, capabilities)
      if (!ctx) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      const field = ctx.fields.find((f) => f.id === fieldId)
      if (!field) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Field not found: ${fieldId}` } })
      }
      if (field.type !== 'button') {
        return res.status(400).json({ ok: false, error: { code: 'NOT_A_BUTTON', message: `Field is not a button: ${fieldId}` } })
      }
      // FIELD-VISIBLE gate: a button the actor cannot see cannot be clicked.
      if (ctx.fieldPermissions[fieldId]?.visible === false) {
        return res.status(403).json({ ok: false, error: { code: 'FIELD_FORBIDDEN', message: `Button field is not visible: ${fieldId}` } })
      }

      const property = normalizeJson(field.property)
      const actionType = typeof property.actionType === 'string' ? property.actionType.trim() : ''
      if (!actionType) {
        return res.status(400).json({ ok: false, error: { code: 'BUTTON_NOT_CONFIGURED', message: 'Button has no actionType configured' } })
      }
      const policy = BUTTON_ACTION_POLICIES[actionType]
      if (!policy) {
        // Real action types are enabled one-by-one (each needs its own gate + policy).
        return res.status(400).json({ ok: false, error: { code: 'BUTTON_ACTION_NOT_ENABLED', message: `Button action not yet enabled: ${actionType}` } })
      }

      // §4 SERVER-CONFIRM GATE (no-write). If the button declares confirm.enabled
      // AND the action is side-effecting, the server REQUIRES confirmed===true.
      // FE-only window.confirm is bypassable by a direct POST, so this is a SERVER
      // behavior: no-confirm → no write (no notification, no audit, no dedup). The
      // FE confirm dialog still runs (it sends confirmed:true), but is not the gate.
      const confirmConfig = normalizeJson(property.confirm)
      const confirmEnabled = confirmConfig.enabled === true
      if (policy.sideEffecting && confirmEnabled && !confirmed) {
        return res.status(400).json({ ok: false, error: { code: 'CONFIRMATION_REQUIRED', message: 'This action requires confirmation' } })
      }

      // §3 ACTOR GATE (per-action). record_click = read (already passed above).
      // send_notification = canSendNotification — a DEDICATED sheet-level notify
      // capability (full sheet write/admin, NOT write-own: notify is a fan-out to the
      // sheet's configured members, not a record-scoped action). Replaces the earlier
      // canEditRecord proxy. The 'edit' branch is retained for any future edit-gated action.
      if (policy.gate === 'edit' && !capabilities.canEditRecord) {
        return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } })
      }
      if (policy.gate === 'notify' && !capabilities.canSendNotification) {
        return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } })
      }
      // EGRESS gate (B1-S2). Egress ≠ edit: a dedicated grant checked DIRECTLY off the authenticated
      // access (admin role, or the EXACT `multitable:send_webhook` permission) — NEVER plain write,
      // and not threaded through the scoped capability projections (one explicit check, no silent-drop).
      // EXACT match (`includes`), NOT a wildcard `hasPermission`: a broad `multitable:*` / `*:*` grant
      // must NOT silently confer external egress — only admin or the dedicated grant may egress.
      // Re-gated here at action time so a button can never egress for an actor who lacks it (no elevation).
      if (policy.gate === 'webhook' && !(access.isAdminRole || access.permissions.includes('multitable:send_webhook'))) {
        return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } })
      }

      // §6 IDEMPOTENCY: side-effecting actions REQUIRE a requestId.
      if (policy.sideEffecting && !requestId) {
        return res.status(400).json({ ok: false, error: { code: 'REQUEST_ID_REQUIRED', message: 'requestId is required for this action' } })
      }

      const executionId = `axe_btn_${randomUUID()}`

      // ── send_notification dispatch (B1-S1 D0-A) ─────────────────────────────
      // Route-level DEDICATED SIDE-EFFECT TRANSACTION. No-write validation first
      // (recipient hard-reject), then one all-or-nothing DB transaction:
      //   dedup → notification rows → audit row.
      if (actionType === 'send_notification') {
        const actorId = access.userId
        const requestIdValue = requestId as string // §6 requestId already required above.

        const actionConfig = normalizeJson(property.actionConfig)
        const requestedUserIds = Array.from(new Set(
          (Array.isArray(actionConfig.userIds) ? actionConfig.userIds : [])
            .filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
            .map((u) => u.trim()),
        ))
        const message = typeof actionConfig.message === 'string' ? actionConfig.message.trim() : ''

        // §3.1 RECIPIENT HARD-REJECT (the #1 control, NO write). config.userIds MUST
        // ALL be sheet members. If ANY configured recipient is not a member, REJECT
        // the entire run (validation-failed) and write NOTHING — no silent partial
        // delivery. Reuses the SAME member set the Person field write-validator uses
        // (single resolver, no drift). This runs BEFORE the transaction so a rejected
        // run never consumes the requestId.
        if (requestedUserIds.length === 0) {
          return res.status(400).json({ ok: false, error: { code: 'NO_RECIPIENTS', message: 'No recipients configured' } })
        }
        if (!message) {
          return res.status(400).json({ ok: false, error: { code: 'MESSAGE_REQUIRED', message: 'Notification message is required' } })
        }
        const memberSet = await loadSheetMemberUserIdSet(query, sheetId)
        const nonMembers = requestedUserIds.filter((u) => !memberSet.has(u))
        if (nonMembers.length > 0) {
          return res.status(400).json({
            ok: false,
            error: { code: 'RECIPIENT_NOT_AUTHORIZED', message: 'One or more recipients are not members of this sheet' },
          })
        }

        // §6 + §4: dedup + notification + audit in ONE transaction (all-or-nothing).
        // The dedup INSERT inside the transaction means a rolled-back run (e.g. a
        // failed audit) does NOT consume the requestId — a later retry still sends.
        // Structured (JSON array) key, NOT a '|'-joined string: requestId is client
        // input and could contain the delimiter, which would risk a false replay.
        const dedupKey = JSON.stringify([actorId, sheetId, recordId, fieldId, requestIdValue])
        const txResult = await pool.transaction<{ deduplicated: boolean; executionId: string }>(async ({ query: txq }) => {
          const dedup = await txq(
            `INSERT INTO multitable_button_run_dedup
               (id, dedup_key, actor_id, sheet_id, record_id, field_id, request_id, execution_id)
             VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (dedup_key) DO NOTHING`,
            [randomUUID(), dedupKey, actorId, sheetId, recordId, fieldId, requestIdValue, executionId],
          )
          if (Number(dedup.rowCount ?? 0) === 0) {
            // Replay: a prior run already COMMITTED this effect. Short-circuit with no
            // second notification and no second audit (single effect, §6). Return the
            // ORIGINAL committed executionId (it maps to the real audit row) — never the
            // fresh id generated this request, which would be untraceable.
            const existing = await txq(
              `SELECT execution_id FROM multitable_button_run_dedup WHERE dedup_key = $1`,
              [dedupKey],
            )
            const originalExecutionId = (existing.rows[0] as { execution_id?: string } | undefined)?.execution_id ?? executionId
            return { deduplicated: true, executionId: originalExecutionId }
          }

          // Durable notification write — the route owns recipient policy (already
          // hard-rejected above); this seam writes exactly the validated recipients.
          await insertRecordSubscriptionNotifications(txq, {
            userIds: requestedUserIds,
            sheetId,
            recordId,
            eventType: 'notification.sent',
            message,
            actorId,
          })

          // §2 HARD DURABLE AUDIT — the redacted triggered_by='button' row is written
          // on the SAME transaction client. If it throws, the whole transaction rolls
          // back (notification + dedup released): fail-closed, no "sent but unaudited".
          const step: AutomationStepResult = {
            actionType: 'send_notification',
            status: 'success',
            output: { notifiedUsers: requestedUserIds.length },
          }
          await writeButtonAudit(logService, txq, {
            executionId, sheetId, fieldId, actorId, requestId: requestIdValue, step,
          })
          return { deduplicated: false, executionId }
        })

        // Post-commit: emit the legacy realtime event so any live in-memory subscriber
        // still fires. Emitted AFTER commit (never inside the tx) so a rolled-back run
        // can never emit a phantom notification. Skipped on a replay (no new effect).
        if (!txResult.deduplicated) {
          eventBus.emit('automation.notification', { userIds: requestedUserIds, message, sheetId, recordId, actorId })
        }

        logger.info('[multitable.button.run]', {
          executionId, sheetId, recordId, fieldId, actionType,
          actorId, status: 'success', requestId: requestIdValue,
          recipients: requestedUserIds.length, deduplicated: txResult.deduplicated,
        })
        return res.json({ ok: true, data: { status: 'succeeded', executionId: txResult.executionId, ...(txResult.deduplicated ? { deduplicated: true } : {}) } })
      }

      // ── send_webhook dispatch (B1-S2) ───────────────────────────────────────
      // First EXTERNAL-EGRESS action. Order is load-bearing for security (#2897 §3.1/§6/§7):
      //   1. parse + validate config (NO write)   2. SSRF-validate target → 400 pre-txn (no dedup/audit)
      //   3. Tx A: claim dedup (replay → return original, NO egress)
      //   4. egress to the PINNED address, retry OFF (at-most-once)   5. Tx B: durable audit, value-scrubbed
      // NOTE for review (D-ORDER): §5's "audit in the SAME tx as dedup" is unsatisfiable for an external
      // call — no HTTP inside a DB tx. So dedup COMMITS before egress (a concurrent retry then sees the
      // claim and cannot double-fire), and the audit lands in Tx B right after egress. The only miss window
      // is a crash between dedup-commit and egress = §6's accepted "rare miss over double-fire".
      if (actionType === 'send_webhook') {
        const actorId = access.userId
        const requestIdValue = requestId as string // §6 requestId required (shared sideEffecting check above).

        const actionConfig = normalizeJson(property.actionConfig)
        const url = typeof actionConfig.url === 'string' ? actionConfig.url.trim() : ''
        const method = actionConfig.method === 'PUT' ? 'PUT' : 'POST' // allowlist; default POST
        const secret = typeof actionConfig.secret === 'string' ? actionConfig.secret : undefined
        // Headers: STRICT caller allowlist (B1-S2 v1) — a field author may set ONLY `content-type`
        // / `accept`. Host / auth / cookie / signature / any custom `X-*` are NEVER settable from
        // untrusted field config (§2/§3.1). The HMAC signature headers are code-owned and overlaid
        // LAST (below), so a caller can never inject or shadow them. Broader custom headers are a
        // future design-lock, not a default.
        const ALLOWED_CONFIG_HEADER = /^(content-type|accept)$/i
        const rawHeaders = (actionConfig.headers && typeof actionConfig.headers === 'object' && !Array.isArray(actionConfig.headers))
          ? (actionConfig.headers as Record<string, unknown>) : {}
        const headers: Record<string, string> = {}
        for (const [k, v] of Object.entries(rawHeaders)) {
          if (ALLOWED_CONFIG_HEADER.test(k) && typeof v === 'string') headers[k] = v
        }
        // Default Content-Type only if the caller did not provide one (caller may override content-type only).
        if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = 'application/json'
        }
        // Body sent AS-IS — NO record-data interpolation (exfil/injection surface, §2). Default {}.
        const body = typeof actionConfig.body === 'string'
          ? actionConfig.body
          : actionConfig.body && typeof actionConfig.body === 'object' ? JSON.stringify(actionConfig.body) : '{}'

        // §3.1 SSRF — fail-fast 400 BEFORE the transaction (no dedup consumed, no audit/delivery written).
        const ssrf = await checkWebhookTargetUrl(url)
        if (!ssrf.ok) {
          // `strict: false` in this package disables discriminated-union narrowing, so read `reason`
          // off the rejection variant explicitly (this was a latent tsc error on the original branch).
          const reason = (ssrf as { reason?: string }).reason ?? 'target rejected'
          return res.status(400).json({ ok: false, error: { code: 'WEBHOOK_TARGET_REJECTED', message: redactString(reason) } })
        }
        if (secret) {
          headers['X-Webhook-Signature'] = WebhookService.signPayload(body, secret)
          headers['X-Webhook-Timestamp'] = new Date().toISOString()
        }

        // Tx A — claim the dedup row with outcome='pending'. The claim COMMITS before egress, so a
        // concurrent retry sees it and cannot double-fire (§6 at-most-once). On replay the response
        // comes STRICTLY from the STORED outcome — a claimed-but-failed or never-completed run is
        // NEVER reported as success (the dedup row means "has a completion state", not "it exists").
        const dedupKey = JSON.stringify([actorId, sheetId, recordId, fieldId, requestIdValue])
        type WebhookClaim =
          | { deduplicated: false }
          | { deduplicated: true; outcome: string | null; httpStatus: number | null; message: string | null; executionId: string }
        const claim = await pool.transaction<WebhookClaim>(async ({ query: txq }) => {
          const dedup = await txq(
            `INSERT INTO multitable_button_run_dedup
               (id, dedup_key, actor_id, sheet_id, record_id, field_id, request_id, execution_id, outcome)
             VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, 'pending')
             ON CONFLICT (dedup_key) DO NOTHING`,
            [randomUUID(), dedupKey, actorId, sheetId, recordId, fieldId, requestIdValue, executionId],
          )
          if (Number(dedup.rowCount ?? 0) === 0) {
            const existing = await txq(
              `SELECT execution_id, outcome, http_status, result_message
                 FROM multitable_button_run_dedup WHERE dedup_key = $1`,
              [dedupKey],
            )
            const row = existing.rows[0] as
              | { execution_id?: string; outcome?: string | null; http_status?: number | null; result_message?: string | null }
              | undefined
            return {
              deduplicated: true,
              outcome: row?.outcome ?? null,
              httpStatus: row?.http_status ?? null,
              message: row?.result_message ?? null,
              executionId: row?.execution_id ?? executionId,
            }
          }
          return { deduplicated: false }
        })
        // Replay short-circuit — STRICTLY from stored outcome, and NEVER a second egress (at-most-once).
        if (claim.deduplicated) {
          if (claim.outcome === 'succeeded') {
            return res.json({ ok: true, data: { status: 'succeeded', executionId: claim.executionId, deduplicated: true } })
          }
          // failed OR pending/null: a prior run that did not durably succeed. Report non-success and do
          // NOT re-send. `pending`/null = "did not complete" — terminal here (never retried/expired, which
          // would reintroduce a double-fire). This unknown→non-success rule is scoped to the webhook branch.
          return res.json({
            ok: true,
            data: {
              status: 'failed',
              executionId: claim.executionId,
              deduplicated: true,
              message: claim.outcome === 'failed'
                ? (claim.message ?? 'previous attempt failed')
                : 'previous attempt did not complete (no re-send)',
            },
          })
        }

        // Egress to the PINNED address (defeats rebinding), retry OFF (at-most-once). Status only; body discarded.
        const pinned = ssrf.addresses[0]
        const family: 4 | 6 = pinned.includes(':') ? 6 : 4
        const startedAt = Date.now()
        let httpStatus = 0
        let reached = false
        let failureMessage: string | undefined
        try {
          const result = await pinnedHttpsFetch(url, pinned, family, { method, headers, body, timeoutMs: 10_000 })
          httpStatus = result.status
          reached = true
          if (!result.ok) failureMessage = `target returned HTTP ${httpStatus}`
        } catch (err) {
          failureMessage = redactString(err instanceof Error ? err.message : String(err)) // never leak target/body
        }
        const durationMs = Date.now() - startedAt
        const succeeded = reached && !failureMessage
        const finalOutcome = succeeded ? 'succeeded' : 'failed'
        // result_message is read back on REPLAY → it is a persisted egress surface and MUST be
        // value-scrubbed before store (§5 / #1882 F1: a secret-shaped value under a benign key).
        const storedMessage = failureMessage ? redactString(failureMessage) : null

        // Tx B — durably record the OUTCOME and the audit ATOMICALLY (§5). The UPDATE is guarded to
        // the still-`pending` row THIS run claimed (dedup_key + execution_id + outcome='pending'); a
        // rowCount !== 1 means the row was finalized/removed by someone else → fail-closed (never
        // overwrite a prior result). The scrubbed audit step output IS the v1 durable delivery record.
        const step: AutomationStepResult = {
          actionType: 'send_webhook',
          status: succeeded ? 'success' : 'failed',
          output: redactValue({ httpStatus, durationMs, reached, target: redactString(url) }),
          durationMs,
          ...(failureMessage ? { error: redactString(failureMessage) } : {}),
        }
        let durablyRecorded = false
        try {
          await pool.transaction(async ({ query: txq }) => {
            const upd = await txq(
              `UPDATE multitable_button_run_dedup
                  SET outcome = $1, http_status = $2, result_message = $3, completed_at = now()
                WHERE dedup_key = $4 AND execution_id = $5 AND outcome = 'pending'`,
              [finalOutcome, reached ? httpStatus : null, storedMessage, dedupKey, executionId],
            )
            if (Number(upd.rowCount ?? 0) !== 1) {
              throw new Error('dedup outcome update did not match exactly one pending row (fail-closed)')
            }
            await writeButtonAudit(logService, txq, { executionId, sheetId, fieldId, actorId, requestId: requestIdValue, step })
          })
          durablyRecorded = true
        } catch (auditErr) {
          // The target MAY have received the call, but this system could NOT durably record the
          // outcome/audit. The dedup row stays `pending` (Tx B rolled back) → a replay returns
          // non-success, and THIS response is non-success too (never a false egress success).
          // logger.error's 2nd arg is an Error (not a meta object) — fold the safe identifiers into the
          // message and pass a redacted Error (the object-meta form was a latent tsc error on the original
          // branch). Identifiers are non-secret; the underlying error text is value-scrubbed (§5 / #1882 F1).
          logger.error(
            `[multitable.button.run] send_webhook EGRESSED but durable outcome/audit failed (stays pending) execution=${executionId} sheet=${sheetId} record=${recordId} field=${fieldId} actor=${actorId} request=${requestIdValue}`,
            new Error(redactString(auditErr instanceof Error ? auditErr.message : String(auditErr))),
          )
        }

        logger.info('[multitable.button.run]', {
          executionId, sheetId, recordId, fieldId, actionType, actorId,
          status: durablyRecorded && succeeded ? 'succeeded' : 'failed',
          requestId: requestIdValue, httpStatus, durationMs, durablyRecorded,
        })
        // §7 3-way: pre-txn 400 handled above. A clean `succeeded` REQUIRES BOTH a reached-2xx target
        // AND a durable outcome/audit. If the durable record failed, report failure/unknown even though
        // the target may have received the call. Never leak the response body in the message.
        if (!durablyRecorded) {
          return res.json({
            ok: true,
            data: { status: 'failed', executionId, message: 'egress completed but durable outcome/audit was not recorded' },
          })
        }
        return res.json({
          ok: true,
          data: { status: succeeded ? 'succeeded' : 'failed', executionId, ...(failureMessage ? { message: redactString(failureMessage) } : {}) },
        })
      }

      // ── update_record dispatch (B1-S1 D0-B) ─────────────────────────────────
      // First RECORD-MUTATING button action. NO ELEVATION: the click performs the
      // update as the CLICKING ACTOR through the SAME per-row gates a normal edit
      // uses, so a button can never mutate a row the clicker could not edit directly.
      if (actionType === 'update_record') {
        const actorId = access.userId
        const requestIdValue = requestId as string // §6 requestId already required (side-effecting).

        // §3.1 PER-ROW WRITE GATE (no-elevation). The sheet-level `edit` policy gate
        // (canEditRecord) above is NOT sufficient — under write-own it is true for
        // EVERY row. Re-gate THIS record by created_by (write-own honored) + the lock
        // guard, identically to the normal record-edit path. Either failure → 403,
        // no write, no dedup consumed.
        const recRes = await query(
          'SELECT created_by, locked, locked_by FROM meta_records WHERE id = $1 AND sheet_id = $2',
          [recordId, sheetId],
        )
        if (recRes.rows.length === 0) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Record not found: ${recordId}` } })
        }
        const recRow = recRes.rows[0] as { created_by?: string | null; locked?: boolean | null; locked_by?: string | null }
        const createdBy = typeof recRow.created_by === 'string' ? recRow.created_by : null
        if (!ensureRecordWriteAllowed(capabilities, sheetScope, access, createdBy, 'edit')) {
          return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions to edit this record' } })
        }
        try {
          ensureRecordNotLocked(actorId, { locked: recRow.locked === true, locked_by: recRow.locked_by ?? null }, () => new Error('locked'))
        } catch {
          return res.status(403).json({ ok: false, error: { code: 'RECORD_LOCKED', message: 'Record is locked' } })
        }

        // §3.2 CONFIG: same-base update of THE CLICKED record (fields only — a button
        // does NOT do cross-base targeting). Empty → nothing to write.
        const actionConfig = normalizeJson(property.actionConfig)
        const fields = (actionConfig.fields && typeof actionConfig.fields === 'object' && !Array.isArray(actionConfig.fields))
          ? (actionConfig.fields as Record<string, unknown>)
          : null
        if (!fields || Object.keys(fields).length === 0) {
          return res.status(400).json({ ok: false, error: { code: 'NO_FIELDS', message: 'Button update_record has no fields configured' } })
        }

        // §3.3 PER-FIELD WRITE GATE + per-type validation (no field-LEVEL elevation). The §3.1 row gate
        // does not bound WHICH fields/values are written, and the executor does a raw `data || $jsonb`
        // merge with NO field checks — so without this a button could write a field the clicker cannot
        // write via a normal PATCH (field_permissions read-only / computed / system), corrupt a computed
        // field, or store an unvalidated value. Enforce the SAME field-level contract as PATCH:
        // `ctx.fieldPermissions[id].readOnly` folds the actor's field_permissions + isFieldAlwaysReadOnly
        // (computed formula/lookup/rollup + system + mirror + intrinsic) — the same deriveFieldPermissions
        // source the PATCH path uses, so a field not writable directly is not writable via a button. Then
        // validate select/multiSelect values via the shared codecs. link/person/attachment need meta_links
        // / membership / attachment writes the executor cannot do → rejected (deferred to a follow-up that
        // routes through the full write path). Either failure → reject BEFORE the tx (no dedup consumed).
        const fieldDefById = new Map(ctx.fields.map((f) => [f.id, f]))
        const validatedFields: Record<string, unknown> = {}
        for (const [fid, value] of Object.entries(fields)) {
          const perm = ctx.fieldPermissions[fid]
          const def = fieldDefById.get(fid)
          if (!def || !perm || perm.readOnly !== false) {
            return res.status(403).json({ ok: false, error: { code: 'FIELD_FORBIDDEN', message: `Field is not writable by this actor: ${fid}` } })
          }
          if (def.type === 'link' || def.type === 'person' || def.type === 'attachment') {
            return res.status(400).json({ ok: false, error: { code: 'FIELD_UNSUPPORTED', message: `Button update_record does not support ${def.type} fields yet: ${fid}` } })
          }
          if (def.type === 'select') {
            const options = def.options?.map((o) => o.value) ?? []
            if (typeof value !== 'string' || (value !== '' && !options.includes(value))) {
              return res.status(422).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: `Invalid select option for ${fid}` } })
            }
            validatedFields[fid] = value
            continue
          }
          if (def.type === 'multiSelect') {
            try {
              validatedFields[fid] = normalizeMultiSelectValue(value, fid, def.options?.map((o) => o.value) ?? [])
            } catch (err) {
              return res.status(422).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: err instanceof Error ? err.message : `Invalid multiSelect value for ${fid}` } })
            }
            continue
          }
          validatedFields[fid] = value
        }

        // §6 + §2: dedup → executor write (SAME tx client) → audit, all-or-nothing.
        // Mirrors the send_notification transaction; the executor performs the real
        // versioned write via the SAME path automations use (no parallel write path).
        const dedupKey = JSON.stringify([actorId, sheetId, recordId, fieldId, requestIdValue])
        const context: ExecutionContext = {
          executionId, ruleId: `btn_${fieldId}`, sheetId, recordId,
          recordData: {}, ruleCreatedBy: '', actorId,
          triggerEvent: { _trigger: 'button', fieldId, requestId: requestIdValue },
        }
        const txResult = await pool.transaction<{ deduplicated: boolean; executionId: string }>(async ({ query: txq }) => {
          const dedup = await txq(
            `INSERT INTO multitable_button_run_dedup
               (id, dedup_key, actor_id, sheet_id, record_id, field_id, request_id, execution_id)
             VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (dedup_key) DO NOTHING`,
            [randomUUID(), dedupKey, actorId, sheetId, recordId, fieldId, requestIdValue, executionId],
          )
          if (Number(dedup.rowCount ?? 0) === 0) {
            const existing = await txq(`SELECT execution_id FROM multitable_button_run_dedup WHERE dedup_key = $1`, [dedupKey])
            const originalExecutionId = (existing.rows[0] as { execution_id?: string } | undefined)?.execution_id ?? executionId
            return { deduplicated: true, executionId: originalExecutionId }
          }
          // Same-base update of the clicked record (fields only). The executor write
          // runs on the tx client, so a failed audit rolls the write back (fail-closed).
          const executor = new AutomationExecutor({ eventBus, queryFn: txq })
          const step = await executor.runSingleAction({ type: 'update_record', config: { fields: validatedFields } }, context)
          if (step.status !== 'success') {
            // Roll back the dedup + any partial write so a transient failure is retryable.
            throw new Error(step.error ?? 'update_record failed')
          }
          await writeButtonAudit(logService, txq, { executionId, sheetId, fieldId, actorId, requestId: requestIdValue, step })
          return { deduplicated: false, executionId }
        })

        logger.info('[multitable.button.run]', {
          executionId, sheetId, recordId, fieldId, actionType,
          actorId, status: 'success', requestId: requestIdValue, deduplicated: txResult.deduplicated,
        })
        return res.json({ ok: true, data: { status: 'succeeded', executionId: txResult.executionId, ...(txResult.deduplicated ? { deduplicated: true } : {}) } })
      }

      // ── record_click dispatch (inert) ───────────────────────────────────────
      const context: ExecutionContext = {
        executionId,
        ruleId: `btn_${fieldId}`,
        sheetId,
        recordId,
        recordData: {},
        ruleCreatedBy: '',
        actorId: access.userId,
        triggerEvent: { _trigger: 'button', fieldId, requestId },
      }
      const executor = new AutomationExecutor({ eventBus, queryFn: query })
      const step = await executor.runSingleAction(
        { type: policy.dispatchType, config: normalizeJson(property.actionConfig) },
        context,
      )

      // record_click is INERT: logger-only, NO durable automation-execution row
      // (design-lock §7/§9, AUDIT-1). Durable audit rows are EXCLUSIVE to
      // side-effecting actions (the in-transaction audit on the send_notification
      // path above). Keeping an inert action out of multitable_automation_executions
      // also keeps the DF-N1 rule-monitoring surface clean.
      logger.info('[multitable.button.run]', {
        executionId, sheetId, recordId, fieldId, actionType,
        actorId: access.userId, status: step.status, requestId,
      })

      if (step.status === 'success') {
        return res.json({ ok: true, data: { status: 'succeeded', executionId } })
      }
      return res.status(200).json({ ok: false, data: { status: 'failed', executionId, message: step.error ?? 'action failed' } })
    } catch (err) {
      // Fail-closed: never leak internals; never 500-swallow into a fake success.
      console.error('[multitable-button] run failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'button run failed' } })
    }
  })

  return router
}

interface ButtonAuditInput {
  executionId: string
  sheetId: string
  fieldId: string
  actorId: string
  requestId?: string
  step: AutomationStepResult
}

function buildButtonExecution(input: ButtonAuditInput): AutomationExecution {
  const now = new Date().toISOString()
  return {
    id: input.executionId,
    ruleId: `btn_${input.fieldId}`,
    triggeredBy: 'button',
    triggeredAt: now,
    status: input.step.status === 'success' ? 'success' : input.step.status === 'skipped' ? 'skipped' : 'failed',
    steps: [input.step],
    sheetId: input.sheetId,
    initiatedBy: input.actorId,
    // requestId is a plain identifier (the §6 idempotency key), kept in the
    // redacted trigger_event so a run is traceable to its dedup marker.
    triggerEvent: input.requestId ? { _trigger: 'button', fieldId: input.fieldId, requestId: input.requestId } : { _trigger: 'button', fieldId: input.fieldId },
    finishedAt: now,
    schemaVersion: AUTOMATION_EXECUTION_SCHEMA_VERSION,
  }
}

/**
 * §2 HARD DURABLE AUDIT — write a redacted multitable_automation_executions row
 * with triggered_by='button' (EXPLICIT; never the executor's 'event' default) ON
 * THE CALLER'S query client. For send_notification this is the SAME transaction
 * client as the dedup + notification writes, so audit is a HARD precondition: if
 * this insert fails it THROWS, the transaction rolls back, and the run fails
 * fail-closed (no "sent but unaudited" state). The action config is NEVER
 * persisted (only ids + actionType + status ride into the step), and the row is
 * redacted via the SAME path record() uses (recordWithQuery delegates the value
 * builder), so no secret-shaped value leaks. Button rows are EXCLUDED from the
 * rule-monitoring reads (listExecutions/getRecent) but stay retrievable by getById.
 */
async function writeButtonAudit(
  logService: AutomationLogService,
  query: QueryFn,
  input: ButtonAuditInput,
): Promise<void> {
  await logService.recordWithQuery(query, buildButtonExecution(input))
}
