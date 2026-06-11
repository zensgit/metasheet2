import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { requireAdminRole } from '../guards/audit-integration'
import { redactString, redactValue } from '../multitable/automation-log-redact'
import { resolveAiProviderReadiness } from '../services/ai-provider-readiness'
import {
  AiProviderClient,
  estimateAiCostUsd,
  type AiCompletionResult,
  type AiUsage,
} from '../services/ai-provider-client'
import {
  AI_USAGE_RESERVATION_GRACE_MS,
  conservativePromptTokenEstimate,
  insertAiUsageLedgerEntry,
  reserveAiUsage,
  settleAiUsageReservation,
  sumAiUsageWindows,
  type AiUsageAction,
  type AiUsageLedgerEntry,
  type AiUsageLedgerStatus,
  type AiUsageQueryFn,
  type AiUsageReservationResult,
} from '../services/ai-usage-ledger'
import {
  AI_SHORTCUT_TARGET_FIELD_TYPES,
  buildAiShortcutPrompt,
  parseAiShortcutConfig,
  validateAiShortcutSourceFields,
  type AiShortcutConfig,
} from '../multitable/ai-shortcut-config'
import {
  buildRecordPatchContext,
  createRecordWriteHelpers,
  getYjsInvalidatorForRoutes,
  requireRecordReadable,
  type RecordPatchRouteContext,
} from './univer-meta'
import {
  RecordWriteService,
  RecordFieldForbiddenError as ServiceFieldForbiddenError,
  RecordNotFoundError as ServiceNotFoundError,
  RecordValidationError as ServiceValidationError,
  VersionConflictError as ServiceVersionConflictError,
  type ConnectionPool,
  type QueryFn,
} from '../multitable/record-write-service'
import { createYjsInvalidationPostCommitHook } from '../multitable/post-commit-hooks'
import { normalizeJson } from '../multitable/field-codecs'
import { poolManager } from '../integration/db/connection-pool'
import { eventBus } from '../integration/events/event-bus'
import { createRateLimiter } from '../middleware/rate-limiter'
import { ensureRecordWriteAllowed } from '../multitable/permission-service'

/**
 * Multitable AI routes — A1 readiness (M1b) + A2 shortcut preview/run (M2).
 *
 * **INTERNAL — not in OpenAPI.** Per the M0 ratification result
 * (docs/development/multitable-ai-field-staged-arc-m0-ratification-result-20260610.md,
 * OpenAPI Option B, scoped to A1 ONLY by 修正二): this surface is deliberately
 * kept out of `packages/openapi/` and the public SDK. The openapi parity gate
 * only asserts that public endpoints exist, so an internal route never trips it.
 *
 * Guard posture is PER-ROUTE (A1 precedent, never router.use):
 *   - GET  /ai/readiness                          → requireAdminRole() (A1, unchanged)
 *   - POST /sheets/:sheetId/ai/shortcut/preview   → record-read RBAC (requireRecordReadable)
 *     + source-field read mask (masked fields never enter the prompt). Zero write.
 *   - POST /sheets/:sheetId/ai/shortcut/run       → preview gates + canEditRecord +
 *     ensureRecordWriteAllowed + target-field editable via deriveFieldPermissions
 *     (this pre-check IS the layer-3 field_permissions write gate — patchRecords
 *     deliberately does not execute it, #2106 F3) + target type string|longText
 *     + ONLY persisted field.property.aiShortcut config (inline → 4xx).
 *
 * Run sequence (LOCKED §2.2 anti-TOCTOU + review-fix F1 RESERVE-THEN-SETTLE;
 * see the design doc's "Implementation reconcile 2026-06-11" note):
 * requireRecordReadable → read the record ONCE (capture version + source
 * values) → mask + assemble the server-side prompt → unsafe_input pre-send
 * scan (assembled prompt incl. ALL params; replace-and-compare over the shared
 * redactor — JDBC/ODBC shapes are NOT in that pattern set today, declared
 * as-is) → double-confirm/readiness preflight (blocked: zero-token row, no
 * lock) → burst rate limit (429 EARLY: no lock, no ledger row) → quota RESERVE
 * (short advisory-locked tx; in_flight row at a conservative estimate) →
 * provider call (NO lock held) → SETTLE the reservation to actual usage →
 * patchRecords with the captured expectedVersion (409 passthrough, no silent
 * overwrite; write failures re-settle the status keeping usage) → SAME Yjs
 * post-commit invalidation wiring as POST /patch.
 *
 * Ledger policy (§2.5): every attempt EXCEPT rate_limited gets a row
 * (never-sent attempts record zero tokens; provider usage is recorded whatever
 * the downstream outcome). Ledger settles after the provider/patch are
 * BEST-EFFORT (never roll back / never 500 a committed write); a failing
 * quota RESERVE fails closed as `blocked`. Crash-orphaned in_flight
 * reservations are swept to zero-usage 'abandoned' by a later reserve.
 */

export interface MultitableAiRouteDeps {
  /** Injected at construction (webhook-service precedent) — tests spy here; never a real provider call in CI. */
  fetchFn?: typeof fetch
}

type PoolLike = ConnectionPool & { query: QueryFn }

interface ShortcutRequestContext {
  pool: PoolLike
  sheetId: string
  recordId: string
  fieldId: string | null
  action: AiUsageAction
  userId: string
}

function sendStatus(
  res: Response,
  httpStatus: number,
  status: 'blocked' | 'quota_exhausted' | 'unsafe_input' | 'provider_error',
  code: string,
  message: string,
): void {
  res.status(httpStatus).json({ ok: false, status, error: { code, message: redactString(message) } })
}

function resolveRequestUserKey(req: Request): string | undefined {
  const user = (req as Request & { user?: { id?: unknown; sub?: unknown; userId?: unknown } }).user
  const raw = user?.id ?? user?.sub ?? user?.userId
  const key = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : ''
  return key.length > 0 ? key : undefined
}

/** Run the burst limiter at the LOCKED gate position (inside the handler, not as route middleware). */
function applyBurstLimiter(
  limiter: (req: Request, res: Response, next: () => void) => void,
  req: Request,
  res: Response,
): Promise<'pass' | 'limited'> {
  return new Promise((resolve) => {
    res.once('finish', () => resolve('limited'))
    limiter(req, res, () => resolve('pass'))
  })
}

async function insertLedgerBestEffort(query: AiUsageQueryFn, entry: AiUsageLedgerEntry): Promise<void> {
  try {
    await insertAiUsageLedgerEntry(query, entry)
  } catch (err) {
    // Best-effort policy (§2.5): a committed write / an already-sent response
    // must never be rolled back or failed because the ledger insert failed.
    console.error('[multitable-ai] usage ledger insert failed (best effort):', err)
  }
}

export function createMultitableAiRoutes(deps: MultitableAiRouteDeps = {}): Router {
  const router = Router()
  const aiClient = new AiProviderClient({ ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}) })

  // E-10 burst cap resolves once at construction (caps are boot-time env);
  // keyed by the AUTHENTICATED user id (§2.5 subject key — never the
  // header-backfilled tenantId). 429 → rate_limited and NO ledger row.
  const constructionCaps = resolveAiProviderReadiness(process.env).caps
  const burstLimiter = createRateLimiter({
    windowMs: 60_000,
    maxRequests: constructionCaps.tenantBurstRpm,
    keyPrefix: 'multitable-ai-shortcut',
    keyFn: resolveRequestUserKey,
    onLimited: (_req, res, retryAfterSeconds) => {
      res.status(429).json({
        ok: false,
        status: 'rate_limited',
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many AI shortcut requests. Please try again later.',
          retryAfter: retryAfterSeconds,
        },
      })
    },
  })

  router.get('/ai/readiness', requireAdminRole(), (_req: Request, res: Response) => {
    const report = resolveAiProviderReadiness(process.env)
    res.json(redactValue(report))
  })

  /**
   * A3 §2.4 — admin usage summary (INTERNAL, not in OpenAPI). Deliberately
   * NOT behind the AI burst limiter: a read-only ledger aggregate must never
   * consume (or be starved by) the preview/run budget. Subject semantics are
   * LOCKED: token windows are the CALLER's own (authenticated user id), the
   * USD window is instance-wide. No readiness info here — blocked diagnosis
   * stays on GET /ai/readiness (A1).
   */
  router.get('/ai/usage-summary', requireAdminRole(), async (req: Request, res: Response) => {
    try {
      const subjectKey = resolveRequestUserKey(req)
      if (!subjectKey) {
        // requireAdminRole already rejected anonymous callers; this guards the
        // exotic "admin without a usable id" shape instead of summing garbage.
        return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'No usable caller identity' } })
      }
      const pool = poolManager.get() as unknown as PoolLike
      const query = pool.query.bind(pool) as AiUsageQueryFn
      const sums = await sumAiUsageWindows(query, subjectKey)
      const caps = resolveAiProviderReadiness(process.env).caps
      res.json({
        callerDayTokens: sums.userDailyTokens,
        callerWeekTokens: sums.userWeeklyTokens,
        instanceDayUsd: sums.instanceDailyUsd,
        caps: {
          tenantDailyTokenCap: caps.tenantDailyTokenCap,
          tenantWeeklyTokenCap: caps.tenantWeeklyTokenCap,
          accountDailyUsdCap: caps.accountDailyUsdCap,
        },
      })
    } catch (err) {
      console.error('[multitable-ai] usage summary failed:', err)
      res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load AI usage summary' } })
    }
  })

  /**
   * Shared gate pipeline from "prompt assembled" onward (review-fix F1,
   * RESERVE-THEN-SETTLE): unsafe scan → double-confirm/readiness preflight
   * (blocked: zero-token row, NO lock) → burst limit (429: NO lock, NO ledger
   * row) → quota RESERVE (one SHORT advisory-locked tx: stale sweep → SUM
   * incl. in_flight → insert the in_flight reservation) → provider call (NO
   * lock / NO pooled connection held) → SETTLE the reservation to actual
   * usage → onSuccess (run: patch + Yjs; write failures re-settle the status
   * KEEPING usage via `finalize`). Settles are best-effort (§2.5); a failing
   * reserve fails closed as `blocked`.
   */
  async function executeShortcut(
    req: Request,
    res: Response,
    ctx: ShortcutRequestContext,
    prompt: string,
    onSuccess: (
      result: AiCompletionResult & { ok: true },
      finalize: (status: AiUsageLedgerStatus, error?: string) => Promise<void>,
    ) => Promise<void>,
  ): Promise<void> {
    const baseEntry = {
      subjectKey: ctx.userId,
      userId: ctx.userId,
      sheetId: ctx.sheetId,
      fieldId: ctx.fieldId,
      recordId: ctx.recordId,
      action: ctx.action,
    } as const
    const zeroUsage = { promptTokens: 0, completionTokens: 0 }
    const query = ctx.pool.query.bind(ctx.pool) as AiUsageQueryFn

    // unsafe_input pre-send scan (§2.4): the backend redactor exposes no
    // detection surface, so detection derives from replace-and-compare — any
    // rewrite means the assembled prompt carries secret-shaped content.
    if (redactString(prompt) !== prompt) {
      await insertLedgerBestEffort(query, {
        ...baseEntry,
        ...zeroUsage,
        estimatedCostUsd: 0,
        status: 'unsafe_input',
      })
      return sendStatus(
        res,
        422,
        'unsafe_input',
        'AI_UNSAFE_INPUT',
        'The assembled prompt contains secret-shaped content; the request was not sent.',
      )
    }

    // Double-confirm / readiness / price preflight — `blocked` resolves BEFORE
    // the limiter and the reserve (zero-token row, no lock, zero outbound).
    // complete() re-runs the same gates internally (defense in depth).
    const pre = aiClient.preflight()
    // `in`-guard (not `!pre.ok`): non-strict tsconfig, no boolean-discriminant narrowing.
    if ('message' in pre) {
      await insertLedgerBestEffort(query, {
        ...baseEntry,
        ...zeroUsage,
        estimatedCostUsd: 0,
        provider: pre.provider ?? null,
        model: pre.model ?? null,
        status: 'blocked',
        error: pre.message,
      })
      return sendStatus(res, 503, 'blocked', 'AI_BLOCKED', pre.message)
    }

    // Burst rate limit (Q-3) — 429 EARLY: no lock, no pooled connection held,
    // and NEVER a ledger row (the limiter responds itself).
    if ((await applyBurstLimiter(burstLimiter, req, res)) === 'limited') {
      return
    }

    // Quota RESERVE — the advisory locks wrap ONLY this short check+insert
    // transaction (F1: never across the provider call). The in_flight
    // estimate (1 token/char prompt bound + the maxOutputTokens cap) counts
    // against every concurrent reserve; overshoot is prevented while
    // estimate ≥ actual (pessimistic for CJK, delta review NF-1) without
    // serializing provider traffic. Settle writes actuals back.
    let reservation: AiUsageReservationResult
    try {
      const estimatedUsage: AiUsage = {
        promptTokens: conservativePromptTokenEstimate(prompt),
        completionTokens: pre.caps.maxOutputTokens,
      }
      reservation = await reserveAiUsage(ctx.pool, {
        ...baseEntry,
        provider: pre.provider,
        model: pre.model,
        estimatedPromptTokens: estimatedUsage.promptTokens,
        estimatedCompletionTokens: estimatedUsage.completionTokens,
        estimatedCostUsd: estimateAiCostUsd(pre.price, estimatedUsage),
        caps: {
          tenantDailyTokenCap: pre.caps.tenantDailyTokenCap,
          tenantWeeklyTokenCap: pre.caps.tenantWeeklyTokenCap,
          accountDailyUsdCap: pre.caps.accountDailyUsdCap,
        },
        staleAfterMs: pre.caps.requestTimeoutMs + AI_USAGE_RESERVATION_GRACE_MS,
      })
    } catch (err) {
      // Quota-reserve-time ledger unavailability → fail closed (§2.5).
      console.error('[multitable-ai] quota reserve failed; failing closed:', err)
      return sendStatus(res, 503, 'blocked', 'AI_BLOCKED', 'AI usage ledger is unavailable; request blocked (fail-closed).')
    }
    if ('reason' in reservation) {
      return sendStatus(res, 429, 'quota_exhausted', 'AI_QUOTA_EXHAUSTED', `AI usage quota exhausted (${reservation.reason}).`)
    }
    const reservationId = reservation.reservationId

    // Provider call — NO lock held; a crash from here until settle leaves an
    // in_flight row that a later reserve sweeps to zero-usage 'abandoned'.
    const result = await aiClient.complete({ prompt })
    const usage: AiUsage = result.usage ?? zeroUsage

    // SETTLE (best-effort — never 500 a committed write / an already-sent
    // response over a ledger UPDATE). Re-settling keeps the ACTUAL usage and
    // only flips status/error (§2.5: the money was spent regardless).
    const settle = async (status: AiUsageLedgerStatus, error?: string | null): Promise<void> => {
      try {
        await settleAiUsageReservation(query, reservationId, {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          estimatedCostUsd: result.estimatedCostUsd,
          provider: result.provider ?? null,
          model: result.model ?? null,
          durationMs: result.durationMs,
          status,
          error: error ?? null,
        })
      } catch (err) {
        console.error('[multitable-ai] usage ledger settle failed (best effort):', err)
      }
    }

    if (result.status === 'blocked') {
      // Post-reserve blocked = the env raced between preflight and the call —
      // settle to zero usage (result.usage is null on blocked) with the blocking status.
      await settle('blocked', result.message ?? null)
      return sendStatus(res, 503, 'blocked', 'AI_BLOCKED', result.message ?? 'AI requests are not enabled for this deployment.')
    }

    if (result.status === 'provider_error') {
      // Tokens are recorded whenever the provider returned usage — the money is spent.
      await settle('provider_error', result.message ?? null)
      return sendStatus(res, 502, 'provider_error', 'AI_PROVIDER_ERROR', result.message ?? 'AI provider request failed.')
    }

    // Settle to actual usage BEFORE the downstream write so the quota account
    // reflects the real spend even if the write path crashes mid-flight.
    await settle('succeeded')
    await onSuccess(result as AiCompletionResult & { ok: true }, (status, error) => settle(status, error ?? null))
  }

  router.post('/sheets/:sheetId/ai/shortcut/preview', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    const schema = z.object({
      recordId: z.string().min(1).max(50),
      fieldId: z.string().min(1).max(50).optional(),
      config: z.unknown().optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!sheetId || !parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: !sheetId ? 'sheetId is required' : parsed.error?.message } })
    }
    if (parsed.data.fieldId === undefined && parsed.data.config === undefined) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Either fieldId or config is required for preview' } })
    }

    try {
      const pool = poolManager.get() as unknown as PoolLike
      const query = pool.query.bind(pool) as QueryFn

      const readable = await requireRecordReadable(req, query, sheetId, parsed.data.recordId)
      if ('status' in readable) {
        return res.status(readable.status).json(readable.body)
      }
      const { access, capabilities } = readable

      const patchContext = await buildRecordPatchContext(query, sheetId, access, capabilities)
      if (!patchContext) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }

      // Preview accepts an INLINE config (M3 config-time preview) or a persisted one.
      let config: AiShortcutConfig
      if (parsed.data.config !== undefined) {
        const inline = parseAiShortcutConfig(parsed.data.config)
        if ('error' in inline) {
          return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: inline.error } })
        }
        const sourceError = validateAiShortcutSourceFields(
          inline.config,
          new Map(patchContext.fields.map((field) => [field.id, field.type])),
        )
        if (sourceError) {
          return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: sourceError } })
        }
        config = inline.config
      } else {
        // Review-fix N2: when fieldId resolves a PERSISTED config, the target
        // field must be visible to the actor (the same layer-2 ∧ layer-3
        // readable set the echo/field-mask uses) — an invisible field behaves
        // as nonexistent, so a reader can neither execute nor infer the hidden
        // field's instruction/options through preview.
        if (!patchContext.readableEchoFieldIds.has(parsed.data.fieldId!)) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Field not found: ${parsed.data.fieldId}` } })
        }
        const resolved = resolvePersistedShortcutConfig(patchContext, parsed.data.fieldId!)
        if ('error' in resolved) {
          return res.status(resolved.httpStatus).json({ ok: false, error: { code: resolved.code, message: resolved.error } })
        }
        config = resolved.config
      }

      const captured = await readRecordOnce(query, sheetId, parsed.data.recordId)
      if (!captured) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Record not found: ${parsed.data.recordId}` } })
      }

      const prompt = assembleMaskedPrompt(config, patchContext, captured.data)

      await executeShortcut(
        req,
        res,
        {
          pool,
          sheetId,
          recordId: parsed.data.recordId,
          fieldId: parsed.data.fieldId ?? null,
          action: 'preview',
          userId: access.userId,
        },
        prompt,
        // The reservation was already settled to 'succeeded' with actual usage
        // by executeShortcut — preview only ships the response.
        async (result) => {
          res.json({
            ok: true,
            data: {
              status: 'succeeded',
              action: 'preview',
              output: result.text,
              usage: result.usage,
              estimatedCostUsd: result.estimatedCostUsd,
              provider: result.provider,
              model: result.model,
            },
          })
        },
      )
    } catch (err) {
      console.error('[multitable-ai] shortcut preview failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to preview AI shortcut' } })
    }
  })

  router.post('/sheets/:sheetId/ai/shortcut/run', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    // Run executes ONLY a persisted config (§2.1) — an inline config is rejected
    // explicitly BEFORE shape parsing so the contract is unmistakable.
    if (req.body && typeof req.body === 'object' && 'config' in (req.body as Record<string, unknown>)) {
      return res.status(400).json({
        ok: false,
        error: { code: 'AI_INLINE_CONFIG_REJECTED', message: 'run executes only the persisted field.property.aiShortcut config; inline config is not accepted' },
      })
    }
    const schema = z.object({
      recordId: z.string().min(1).max(50),
      fieldId: z.string().min(1).max(50),
    })
    const parsed = schema.safeParse(req.body)
    if (!sheetId || !parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: !sheetId ? 'sheetId is required' : parsed.error?.message } })
    }
    const { recordId, fieldId } = parsed.data

    try {
      const pool = poolManager.get() as unknown as PoolLike
      const query = pool.query.bind(pool) as QueryFn

      // 1) Record-read gate (404 record-not-on-sheet / 401 / 403 — A2-T2 probes).
      const readable = await requireRecordReadable(req, query, sheetId, recordId)
      if ('status' in readable) {
        return res.status(readable.status).json(readable.body)
      }
      const { access, capabilities, sheetScope } = readable

      // 2) Sheet-level write capability.
      if (!capabilities.canEditRecord) {
        return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } })
      }

      const patchContext = await buildRecordPatchContext(query, sheetId, access, capabilities)
      if (!patchContext) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }

      // 3) Target field: persisted config only + type + layer-3 editable.
      const targetField = patchContext.fields.find((field) => field.id === fieldId)
      if (!targetField) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Field not found: ${fieldId}` } })
      }
      if (!AI_SHORTCUT_TARGET_FIELD_TYPES.has(targetField.type)) {
        return res.status(400).json({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: `AI shortcut target field must be string or longText, got: ${targetField.type}` },
        })
      }
      // Layer-3 write gate (#2106 F3): patchRecords does NOT execute
      // field_permissions on writes — this pre-check IS that layer's
      // enforcement point for the AI run path.
      const targetPermission = patchContext.fieldPermissions[fieldId]
      if (!targetPermission || targetPermission.visible === false || targetPermission.readOnly === true) {
        return res.status(403).json({ ok: false, error: { code: 'FIELD_FORBIDDEN', message: `AI shortcut target field is not editable: ${fieldId}` } })
      }

      const resolved = resolvePersistedShortcutConfig(patchContext, fieldId)
      if ('error' in resolved) {
        return res.status(resolved.httpStatus).json({ ok: false, error: { code: resolved.code, message: resolved.error } })
      }
      const config = resolved.config

      // 4) Read the record ONCE — capture version + source values (anti-TOCTOU:
      //    this version rides into patchRecords as expectedVersion).
      const captured = await readRecordOnce(query, sheetId, recordId)
      if (!captured) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Record not found: ${recordId}` } })
      }

      // 5) Row-policy write gate (own-write scope etc. — same primitive RWS applies in-transaction).
      if (!ensureRecordWriteAllowed(capabilities, sheetScope, access, captured.createdBy, 'edit')) {
        return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Record editing is not allowed' } })
      }

      // 6) Mask + assemble (masked source fields never enter the prompt).
      const prompt = assembleMaskedPrompt(config, patchContext, captured.data)

      await executeShortcut(
        req,
        res,
        { pool, sheetId, recordId, fieldId, action: 'run', userId: access.userId },
        prompt,
        // The reservation is already settled to 'succeeded' with actual usage;
        // write failures re-settle the STATUS via `finalize` keeping the usage
        // (§2.5: the provider spend is real whatever the write outcome).
        async (result, finalize) => {
          // 7) Land the value through the AUTHORITATIVE write path — RecordWriteService
          //    (the automation executeUpdateRecord raw-SQL path is a FORBIDDEN anti-precedent),
          //    with the SAME post-commit Yjs invalidation wiring as POST /patch.
          const recordWriteService = new RecordWriteService(pool, eventBus, createRecordWriteHelpers(req, pool))
          const invalidator = getYjsInvalidatorForRoutes()
          if (invalidator) {
            recordWriteService.setPostCommitHooks([createYjsInvalidationPostCommitHook(invalidator)])
          }

          try {
            const patchResult = await recordWriteService.patchRecords({
              sheetId,
              changesByRecord: new Map([
                [recordId, [{ fieldId, value: result.text ?? '', expectedVersion: captured.version }]],
              ]),
              actorId: access.userId || null,
              fields: patchContext.fields,
              visiblePropertyFields: patchContext.readableEchoFields,
              visiblePropertyFieldIds: patchContext.readableEchoFieldIds,
              attachmentFields: patchContext.attachmentFields,
              fieldById: patchContext.fieldById,
              capabilities,
              sheetScope,
              access,
            })

            res.json({
              ok: true,
              data: {
                status: 'succeeded',
                action: 'run',
                recordId,
                fieldId,
                version: patchResult.updated[0]?.version ?? null,
                output: result.text,
                usage: result.usage,
                estimatedCostUsd: result.estimatedCostUsd,
                provider: result.provider,
                model: result.model,
              },
            })
          } catch (err) {
            // Provider usage is ALREADY spent — re-settle the status keeping usage (§2.5).
            if (err instanceof ServiceVersionConflictError) {
              await finalize('version_conflict', `version conflict at write time (server ${err.serverVersion})`)
              res.status(409).json({
                ok: false,
                error: { code: 'VERSION_CONFLICT', message: err.message, serverVersion: err.serverVersion },
              })
              return
            }
            const failureMessage = err instanceof Error ? err.message : String(err)
            await finalize('write_failed', failureMessage)
            if (err instanceof ServiceNotFoundError) {
              res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: err.message } })
              return
            }
            if (err instanceof ServiceFieldForbiddenError) {
              res.status(403).json({ ok: false, error: { code: err.code, message: err.message } })
              return
            }
            if (err instanceof ServiceValidationError) {
              res.status(400).json({ ok: false, error: { code: err.code || 'VALIDATION_ERROR', message: err.message } })
              return
            }
            console.error('[multitable-ai] shortcut run write failed:', err)
            res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to write AI shortcut result' } })
          }
        },
      )
    } catch (err) {
      console.error('[multitable-ai] shortcut run failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to run AI shortcut' } })
    }
  })

  return router
}

function resolvePersistedShortcutConfig(
  patchContext: RecordPatchRouteContext,
  fieldId: string,
):
  | { config: AiShortcutConfig }
  | { error: string; httpStatus: number; code: string } {
  const field = patchContext.fields.find((candidate) => candidate.id === fieldId)
  if (!field) {
    return { error: `Field not found: ${fieldId}`, httpStatus: 404, code: 'NOT_FOUND' }
  }
  const raw = (field.property ?? {}).aiShortcut
  if (raw === undefined) {
    return { error: `Field has no persisted aiShortcut config: ${fieldId}`, httpStatus: 400, code: 'VALIDATION_ERROR' }
  }
  const parsed = parseAiShortcutConfig(raw)
  if ('error' in parsed) {
    return { error: `Persisted aiShortcut config is invalid: ${parsed.error}`, httpStatus: 400, code: 'VALIDATION_ERROR' }
  }
  return { config: parsed.config }
}

async function readRecordOnce(
  query: QueryFn,
  sheetId: string,
  recordId: string,
): Promise<{ version: number; data: Record<string, unknown>; createdBy: string | null } | null> {
  const result = await query(
    'SELECT id, version, data, created_by FROM meta_records WHERE id = $1 AND sheet_id = $2',
    [recordId, sheetId],
  )
  const row = result.rows[0] as { version?: unknown; data?: unknown; created_by?: unknown } | undefined
  if (!row) return null
  return {
    version: Number(row.version ?? 1),
    data: normalizeJson(row.data),
    createdBy: typeof row.created_by === 'string' ? row.created_by : null,
  }
}

/**
 * Source-field read mask (D3c composite — the same layer-2 ∧ layer-3 readable
 * set POST /patch uses for its echo): a masked/denied/unknown source field
 * NEVER enters the prompt. Computed fields can't appear (config governance
 * rejects them) but would be dropped here too.
 */
function assembleMaskedPrompt(
  config: AiShortcutConfig,
  patchContext: RecordPatchRouteContext,
  recordData: Record<string, unknown>,
): string {
  const readableById = new Map(patchContext.readableEchoFields.map((field) => [field.id, field]))
  const sources = config.sourceFieldIds
    .map((sourceFieldId) => {
      const field = readableById.get(sourceFieldId)
      if (!field) return null
      return { name: field.name, value: recordData[sourceFieldId] }
    })
    .filter((source): source is { name: string; value: unknown } => source !== null)
  return buildAiShortcutPrompt(config, sources)
}
