import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import {
  buildRecordPatchContext,
  requireRecordReadable,
  type RecordPatchRouteContext,
} from './univer-meta'
import {
  VersionConflictError as ServiceVersionConflictError,
  type ConnectionPool,
  type QueryFn,
} from '../multitable/record-write-service'
import { poolManager } from '../integration/db/connection-pool'
import { eventBus } from '../integration/events/event-bus'
import {
  AutomationExecutor,
  AUTOMATION_EXECUTION_SCHEMA_VERSION,
  type ExecutionContext,
  type AutomationStepResult,
  type AutomationExecution,
} from '../multitable/automation-executor'
import { ALL_ACTION_TYPES, type AutomationActionType } from '../multitable/automation-actions'
import { AutomationLogService } from '../multitable/automation-log-service'
import { redactString } from '../multitable/automation-log-redact'
import { normalizeJson } from '../multitable/field-codecs'

/**
 * Multitable button/action field — RUN route (B1-a1).
 *
 * Design lock: docs/development/multitable-button-field-b1s0-designlock-20260615.md
 * (§3 executor dispatch, §4 visible ≠ executable, §5 run-API contract, §6 config
 * shape). **INTERNAL — not in OpenAPI** (same posture as routes/multitable-ai.ts:
 * a per-record server action behind the platform JWT, not a public SDK surface).
 *
 * `POST /api/multitable/sheets/:sheetId/records/:recordId/fields/:fieldId/button/run`
 *
 * Mirrors the AI-shortcut-run route (#2623): per-record server action + audit +
 * uniform status. The button field is value-less (B1-a0) — the executed config
 * lives entirely on `field.property` (flat `{ label, variant?, actionType,
 * actionConfig?, confirm?, readOnly:true }`), never in `record.data[fieldId]`.
 *
 * Preflight order is LOAD-BEARING (§4 / §9 "visible ≠ executable"):
 *   1. record-read gate (requireRecordReadable) — 401/403/404.
 *   2. field exists + field.type === 'button' — 404 / 400.
 *   3. config usable: actionType present + ∈ ALL_ACTION_TYPES (the codec defers
 *      this enum check to run time, B1-a0 field-codecs note) + actionConfig is a
 *      safe plain object (no __proto__/constructor/prototype, bounded depth) — 400.
 *   4. AUTHORIZE the configured actionType AS THE ACTOR (the per-action gate:
 *      record_click → canRead; update_record/create_record/delete_record/
 *      lock_record → canEditRecord; egress/other → not yet bindable) — 403 on
 *      deny. This runs BEFORE the supported-action gate so a low-privilege actor
 *      clicking a would-be high-privilege action is blocked as a GATE (403), not
 *      reported as unsupported (400).
 *   5. SUPPORTED-ACTION gate: B1-a1 dispatches ONLY the inert `record_click`;
 *      everything else (write/egress) is a later gated slice — 400 NOT_SUPPORTED.
 *   6. read the record ONCE (version + data) — 404 if vanished.
 *   7. dispatch via the executor seam (AutomationExecutor.dispatchSingleAction).
 *   8. audit best-effort (AutomationLogService.record) — NEVER 500 a settled
 *      dispatch just to record a log.
 *   9. settle → `{ ok, data: { status, message?, executionId? } }`. Errors are
 *      NOT swallowed: a thrown dispatch surfaces 500 (failed); 403/409 semantics
 *      pass through.
 *
 * Idempotency (§5): optional `requestId` is deduped in-process for a short window
 * so a double-click does not produce two audit rows / two unexplained settles.
 * Full exactly-once is a deferred follow-up (per §5). CAVEAT: the dedup map is
 * IN-PROCESS, so under N replicas a request hashing to two nodes is not deduped;
 * a shared store is out of scope for v1.
 */

export interface MultitableButtonRunRouteDeps {
  /** Injected for tests (audit goes through the kysely `db` singleton, not the
   *  pool, so a pool mock cannot observe it). Defaults to the real services. */
  executor?: Pick<AutomationExecutor, 'dispatchSingleAction'>
  recordAudit?: Pick<AutomationLogService, 'record'>
}

type PoolLike = ConnectionPool & { query: QueryFn }

/** Action types B1-a1 can actually DISPATCH. Everything else in ALL_ACTION_TYPES
 *  is a later gated slice (§3.3 upgrade order). */
const SUPPORTED_RUN_ACTION_TYPES = new Set<AutomationActionType>(['record_click'])

/** Maximum nesting depth permitted in actionConfig before it reaches a handler. */
const MAX_ACTION_CONFIG_DEPTH = 8
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Defense-in-depth (design task §5): reject prototype-pollution keys and
 * unbounded depth in actionConfig at the run/dispatch chokepoint, before any
 * handler reads it. Returns an error message string on rejection, else null.
 */
function assertSafeActionConfig(value: unknown, depth = 0): string | null {
  if (depth > MAX_ACTION_CONFIG_DEPTH) {
    return 'actionConfig nesting is too deep'
  }
  if (!value || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const err = assertSafeActionConfig(item, depth + 1)
      if (err) return err
    }
    return null
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(key)) {
      return `Unsafe actionConfig key: ${key}`
    }
    const err = assertSafeActionConfig((value as Record<string, unknown>)[key], depth + 1)
    if (err) return err
  }
  return null
}

interface ButtonFieldProperty {
  actionType: AutomationActionType
  actionConfig: Record<string, unknown>
  label?: string
  confirm?: { enabled: boolean; message?: string }
}

type ButtonConfigResult =
  | { ok: true; property: ButtonFieldProperty }
  | { ok: false; status: number; code: string; message: string }

/**
 * Resolve + validate the button field's executed config from `field.property`.
 * The button field is value-less, so the config is read from property (already
 * §6-sanitized by field-codecs on the read path) — but `actionType ∈
 * ALL_ACTION_TYPES` and the safe-config guard are enforced HERE at run time
 * (the codec defers them, B1-a0).
 */
function resolveButtonConfig(rawProperty: unknown): ButtonConfigResult {
  const property = normalizeJson(rawProperty)
  const actionType = typeof property.actionType === 'string' ? property.actionType.trim() : ''
  if (!actionType) {
    return { ok: false, status: 400, code: 'BUTTON_CONFIG_INVALID', message: 'Button field has no actionType configured' }
  }
  if (!(ALL_ACTION_TYPES as string[]).includes(actionType)) {
    return { ok: false, status: 400, code: 'BUTTON_ACTION_TYPE_UNKNOWN', message: `Unknown button actionType: ${actionType}` }
  }
  const actionConfig =
    property.actionConfig && typeof property.actionConfig === 'object' && !Array.isArray(property.actionConfig)
      ? (property.actionConfig as Record<string, unknown>)
      : {}
  const unsafe = assertSafeActionConfig(actionConfig)
  if (unsafe) {
    return { ok: false, status: 400, code: 'BUTTON_CONFIG_INVALID', message: unsafe }
  }
  const out: ButtonFieldProperty = {
    actionType: actionType as AutomationActionType,
    actionConfig,
  }
  if (typeof property.label === 'string') out.label = property.label
  return { ok: true, property: out }
}

type Capabilities = { canRead: boolean; canEditRecord: boolean }

/**
 * §4 visible ≠ executable — re-evaluate the CONFIGURED action's own gate AS THE
 * ACTOR. record_click → record-readable (already proven by the read gate);
 * write-class actions → canEditRecord; egress/other actions are not yet
 * bindable from a button and are denied here (they bind in later gated slices
 * with their own gate — webhook 闸 etc.). This runs before the supported-action
 * gate so the security invariant surfaces as a GATE (403), not as unsupported.
 */
function authorizeActionAsActor(
  actionType: AutomationActionType,
  capabilities: Capabilities,
): { ok: true } | { ok: false; message: string } {
  switch (actionType) {
    case 'record_click':
      // Inert: zero side effects, the record-read gate already passed.
      return capabilities.canRead ? { ok: true } : { ok: false, message: 'Insufficient permissions to read this record' }
    case 'update_record':
    case 'create_record':
    case 'delete_record':
    case 'lock_record':
      return capabilities.canEditRecord
        ? { ok: true }
        : { ok: false, message: 'Insufficient permissions to run this action' }
    default:
      // send_webhook / send_email / send_* / wait_for_callback / condition_branch
      // / start_approval / parallel_branch — each has its OWN gate that is not yet
      // wired for the button surface. Fail closed (never "visible ⇒ executable").
      return { ok: false, message: 'This action is not yet runnable from a button' }
  }
}

const RUN_BODY_SCHEMA = z.object({
  requestId: z.string().min(1).max(128).optional(),
})

/** In-process dedup window for `requestId` (§5 anti-double-click; not exactly-once). */
const DEDUP_TTL_MS = 60_000

interface SettleResult {
  status: number
  body: { ok: boolean; data?: unknown; error?: { code: string; message: string } }
}

export function createMultitableButtonRunRoutes(deps: MultitableButtonRunRouteDeps = {}): Router {
  const router = Router()
  const recordAudit = deps.recordAudit ?? new AutomationLogService()

  // §5 idempotency: requestId → cached settle, constructed in the factory closure
  // so each app (and each test `buildApp()`) gets an isolated, self-resetting map.
  const dedupCache = new Map<string, { at: number; result: SettleResult }>()
  function dedupKey(actorId: string, sheetId: string, recordId: string, fieldId: string, requestId: string): string {
    return `${actorId}::${sheetId}::${recordId}::${fieldId}::${requestId}`
  }

  /** Resolve the executor per-request — `poolManager.get()` may not be ready at
   *  mount, and the inert record_click handler never touches the pool anyway. */
  function resolveExecutor(pool: PoolLike): Pick<AutomationExecutor, 'dispatchSingleAction'> {
    if (deps.executor) return deps.executor
    return new AutomationExecutor({
      eventBus,
      queryFn: (sql: string, params?: unknown[]) => pool.query(sql, params),
    })
  }

  router.post(
    '/sheets/:sheetId/records/:recordId/fields/:fieldId/button/run',
    async (req: Request, res: Response) => {
      const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
      const recordId = typeof req.params.recordId === 'string' ? req.params.recordId.trim() : ''
      const fieldId = typeof req.params.fieldId === 'string' ? req.params.fieldId.trim() : ''
      const parsedBody = RUN_BODY_SCHEMA.safeParse(req.body ?? {})
      if (!sheetId || !recordId || !fieldId || !parsedBody.success) {
        return res.status(400).json({
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: !sheetId
              ? 'sheetId is required'
              : !recordId
                ? 'recordId is required'
                : !fieldId
                  ? 'fieldId is required'
                  : parsedBody.error?.message ?? 'Invalid request body',
          },
        })
      }
      const requestId = parsedBody.data.requestId

      try {
        const pool = poolManager.get() as unknown as PoolLike
        const query = pool.query.bind(pool) as QueryFn

        // 1) Record-read gate (404 record-not-on-sheet / 401 unauth / 403 no read).
        const readable = await requireRecordReadable(req, query, sheetId, recordId)
        if ('status' in readable) {
          return res.status(readable.status).json(readable.body)
        }
        const { access, capabilities } = readable
        const actorId = access.userId as string

        // §5 idempotency: a repeated requestId in the short window returns the SAME
        // settle and writes NO second audit row (checked AFTER auth so a denied
        // request is never cached as a usable settle).
        const dKey = requestId ? dedupKey(actorId, sheetId, recordId, fieldId, requestId) : null

        const patchContext: RecordPatchRouteContext | null = await buildRecordPatchContext(
          req,
          query,
          sheetId,
          access,
          capabilities,
        )
        if (!patchContext) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
        }

        // 2) Field exists + readable + type === 'button'. A field hidden by
        //    layer-2/3 permission is not in `fields` (read-masked) → 404-like,
        //    never leaking its existence to a non-reader (§9 field hidden).
        const targetField = patchContext.fields.find((field) => field.id === fieldId)
        if (!targetField) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Field not found: ${fieldId}` } })
        }
        const fieldPermission = patchContext.fieldPermissions[fieldId]
        if (!fieldPermission || fieldPermission.visible === false) {
          return res.status(403).json({ ok: false, error: { code: 'FIELD_FORBIDDEN', message: `Field is not readable: ${fieldId}` } })
        }
        if (targetField.type !== 'button') {
          return res.status(400).json({
            ok: false,
            error: { code: 'NOT_A_BUTTON_FIELD', message: `Field is not a button: ${fieldId} (type: ${targetField.type})` },
          })
        }

        // 3) Config usable (actionType ∈ ALL_ACTION_TYPES + safe actionConfig).
        const resolved = resolveButtonConfig(targetField.property)
        if (resolved.ok === false) {
          return res.status(resolved.status).json({ ok: false, error: { code: resolved.code, message: resolved.message } })
        }
        const { actionType, actionConfig } = resolved.property

        // 4) §4 authorize the configured action AS THE ACTOR (BEFORE the
        //    supported-action gate → low-priv + high-priv action = 403, not 400).
        const auth = authorizeActionAsActor(actionType, capabilities)
        if (auth.ok === false) {
          return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: auth.message } })
        }

        // 5) B1-a1 supported-action gate (only the inert record_click dispatches).
        if (!SUPPORTED_RUN_ACTION_TYPES.has(actionType)) {
          return res.status(400).json({
            ok: false,
            error: { code: 'ACTION_NOT_SUPPORTED', message: `Button action is not runnable yet: ${actionType}` },
          })
        }

        // §5 dedup replay (post-auth, pre-dispatch): same requestId in window →
        // return cached settle, no second dispatch / audit row.
        if (dKey) {
          const cached = dedupCache.get(dKey)
          if (cached && Date.now() - cached.at < DEDUP_TTL_MS) {
            return res.status(cached.result.status).json(cached.result.body)
          }
        }

        // 6) Read the record ONCE (version + data for the execution context).
        const captured = await query(
          'SELECT id, version, data, created_by FROM meta_records WHERE id = $1 AND sheet_id = $2',
          [recordId, sheetId],
        )
        const capturedRow = captured.rows[0] as { version?: unknown; data?: unknown } | undefined
        if (!capturedRow) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Record not found: ${recordId}` } })
        }
        const recordData = normalizeJson(capturedRow.data)

        // 7) Dispatch via the executor seam. A MINIMAL ExecutionContext: actorId
        //    AND ruleCreatedBy both = the actor (executor write-handlers treat
        //    ruleCreatedBy as the write authority, so seeding it with the actor is
        //    the forward-safe default for when real writes bind — never a
        //    privileged synthetic creator). executionId/ruleId are synthetic;
        //    record_click is inert so reads none of this, but the seam is correct
        //    for later gated write actions.
        const executionId = `axe_btn_${sheetId}_${fieldId}_${Date.now()}`
        const context: ExecutionContext = {
          executionId,
          ruleId: `button:${fieldId}`,
          sheetId,
          recordId,
          recordData,
          ruleCreatedBy: actorId,
          actorId,
          triggerEvent: { _source: 'button_run', sheetId, recordId, fieldId, actorId },
        }

        const executor = resolveExecutor(pool)
        let stepResult: AutomationStepResult
        try {
          stepResult = await executor.dispatchSingleAction({ type: actionType, config: actionConfig }, context)
        } catch (err) {
          // Errors are NOT swallowed (§5): a thrown dispatch surfaces semantically.
          // A version conflict (a write-class action racing a concurrent edit)
          // passes through as 409 — same as the AI run route (#2623). For the
          // inert record_click this path is unreachable (it cannot throw), but the
          // mapping is wired now so the seam is correct when write actions bind.
          const message = redactString(err instanceof Error ? err.message : String(err))
          const status = err instanceof ServiceVersionConflictError ? 409 : 500
          const code = err instanceof ServiceVersionConflictError ? 'VERSION_CONFLICT' : 'DISPATCH_FAILED'
          await recordButtonExecution(recordAudit, {
            executionId,
            ruleId: context.ruleId,
            sheetId,
            actorId,
            actionType,
            status: 'failed',
            error: message,
            triggerEvent: context.triggerEvent,
          })
          return res.status(status).json({
            ok: false,
            error: {
              code,
              message,
              ...(err instanceof ServiceVersionConflictError ? { serverVersion: err.serverVersion } : {}),
            },
          })
        }

        // 8) Audit best-effort — NEVER 500 a settled dispatch to record a log.
        const settledStatus = stepResult.status === 'success' ? 'succeeded' : 'failed'
        await recordButtonExecution(recordAudit, {
          executionId,
          ruleId: context.ruleId,
          sheetId,
          actorId,
          actionType,
          status: stepResult.status === 'success' ? 'success' : 'failed',
          error: stepResult.status === 'success' ? null : (stepResult.error ?? 'Action failed'),
          triggerEvent: context.triggerEvent,
        })

        // 9) Settle.
        const settle: SettleResult = {
          status: settledStatus === 'succeeded' ? 200 : 422,
          body: {
            ok: settledStatus === 'succeeded',
            data: {
              status: settledStatus,
              recordId,
              fieldId,
              actionType,
              executionId,
              ...(settledStatus === 'failed' && stepResult.error ? { message: redactString(stepResult.error) } : {}),
              ...(stepResult.output !== undefined ? { output: stepResult.output } : {}),
            },
          },
        }
        if (dKey) dedupCache.set(dKey, { at: Date.now(), result: settle })
        return res.status(settle.status).json(settle.body)
      } catch (err) {
        // Unexpected failure (NOT a swallowed dispatch error — those are handled
        // above and re-settled). Surface 500.
        return res.status(500).json({
          ok: false,
          error: { code: 'INTERNAL_ERROR', message: redactString(err instanceof Error ? err.message : String(err)) },
        })
      }
    },
  )

  return router
}

export interface ButtonExecutionEntry {
  executionId: string
  ruleId: string
  sheetId: string
  actorId: string
  actionType: AutomationActionType
  status: 'success' | 'failed'
  error: string | null
  triggerEvent: unknown
}

/**
 * Build the single-step `AutomationExecution` that a button run audits as
 * (multitable_automation_executions; `rule_id` is TEXT with no FK, so the
 * synthetic `button:<fieldId>` id is valid). Exported so a unit test can assert
 * this exact shape round-trips through the REAL `AutomationLogService.record()`
 * (which serializes field-by-field): the audit call site is wrapped in a
 * swallowing best-effort try/catch, so a shape incompatibility would otherwise
 * silently no-op the audit in production while a spy-injected test stayed green
 * (the wire-vs-fixture-drift trap).
 */
export function buildButtonExecution(entry: ButtonExecutionEntry, nowIso: string = new Date().toISOString()): AutomationExecution {
  return {
    id: entry.executionId,
    ruleId: entry.ruleId,
    triggeredBy: entry.actorId,
    triggeredAt: nowIso,
    status: entry.status === 'success' ? 'success' : 'failed',
    steps: [
      {
        actionType: entry.actionType,
        status: entry.status,
        ...(entry.error ? { error: entry.error } : {}),
      },
    ],
    sheetId: entry.sheetId,
    triggerEvent: entry.triggerEvent,
    finishedAt: nowIso,
    duration: 0,
    schemaVersion: AUTOMATION_EXECUTION_SCHEMA_VERSION,
    ...(entry.error ? { error: entry.error } : {}),
  }
}

/**
 * Best-effort audit of a button run. Failures are SWALLOWED here on purpose:
 * per §5 we never 500 an already-settled dispatch just to record a log.
 */
async function recordButtonExecution(
  recordAudit: Pick<AutomationLogService, 'record'>,
  entry: ButtonExecutionEntry,
): Promise<void> {
  try {
    await recordAudit.record(buildButtonExecution(entry))
  } catch {
    // Swallow: best-effort audit must never break an already-committed/settled run.
  }
}
