import { Router, type Request, type Response } from 'express'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { requireAdminRole } from '../guards/audit-integration'
import { redactString, redactValue } from '../multitable/automation-log-redact'
import { resolveAiProviderReadiness } from '../services/ai-provider-readiness'
import {
  AiProviderClient,
  type AiCompletionResult,
} from '../services/ai-provider-client'
import {
  conservativePromptTokenEstimate,
  sumAiUsageWindows,
  type AiUsageLedgerStatus,
  type AiUsageQueryFn,
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
  parseMetaFilterInfo,
  evaluateFilterNode,
  evaluateMetaFilterCondition,
  collectLeafConditions,
  type RecordPatchRouteContext,
  type MetaFilterCondition,
} from './univer-meta'
import {
  RecordWriteService,
  RecordFieldForbiddenError as ServiceFieldForbiddenError,
  RecordNotFoundError as ServiceNotFoundError,
  RecordValidationError as ServiceValidationError,
  VersionConflictError as ServiceVersionConflictError,
  type QueryFn,
} from '../multitable/record-write-service'
import { createYjsInvalidationPostCommitHook } from '../multitable/post-commit-hooks'
import { normalizeJson } from '../multitable/field-codecs'
import { poolManager } from '../integration/db/connection-pool'
import { eventBus } from '../integration/events/event-bus'
import { createRateLimiter } from '../middleware/rate-limiter'
import { ensureRecordWriteAllowed, resolveSheetCapabilities, resolveSheetReadableCapabilities } from '../multitable/permission-service'
import { loadFieldsForSheet, tryResolveView } from '../multitable/loaders'
import {
  insertBulkPreviewCacheRow,
  readBulkPreviewCacheRows,
  type BulkPreviewCacheRow,
} from '../services/ai-bulk-preview-cache'
import {
  runShortcutCore,
  type PoolLike,
  type ShortcutRequestContext,
} from '../services/ai-bulk-shared'
import {
  BulkFillJobService,
  resolveBulkJobMaxRows,
  resolveBulkInlineMaxRows,
  computeScopeFingerprint,
  findActiveBulkJob,
  insertBulkJobHeader,
  insertBulkJobRowsPending,
  readBulkJobHeader,
  readBulkJobRows,
  readGeneratedRows,
  countBulkJobRowsByState,
  cancelBulkJob,
  setHeaderRunning,
  setHeaderAggregate,
  setRowCommitOutcome,
  type BulkJobRowSeed,
} from '../services/ai-bulk-job-service'
import type { QueueService } from '../types/plugin'

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
  /**
   * Optional B-4 async-job service. When omitted, the routes build one with the
   * same fetchFn but NO queue — the bulk-fill job's generate phase must then be
   * driven directly (tests call `runJob`; production injects a service wired to a
   * real QueueService so `enqueue` runs the worker out-of-band).
   */
  bulkJobService?: BulkFillJobService
  /**
   * Optional in-process queue (production wiring). When provided and no
   * `bulkJobService` is injected, the lazily-built service registers its generate
   * processor on this queue so `enqueue` runs `runJob` out-of-band — WITHOUT it the
   * generate phase never executes in production. Omitted in tests (which drive
   * `runJob` directly for determinism).
   */
  queue?: QueueService
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

export function createMultitableAiRoutes(deps: MultitableAiRouteDeps = {}): Router {
  const router = Router()
  const aiClient = new AiProviderClient({ ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}) })

  // B-4 async-job service: shared if injected (production wires a real queue),
  // else a queue-less one over the SAME pool + fetchFn (the generate phase is then
  // driven directly — tests call runJob). Lazily resolves the pool at first use so
  // construction doesn't require an initialized poolManager.
  let bulkJobServiceInstance: BulkFillJobService | undefined = deps.bulkJobService
  const bulkJobService = {
    get instance(): BulkFillJobService {
      if (!bulkJobServiceInstance) {
        bulkJobServiceInstance = new BulkFillJobService({
          pool: poolManager.get() as unknown as PoolLike,
          ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
          // Production passes a real queue → the service registers its generate
          // processor and `enqueue` runs the worker out-of-band. No queue (tests) →
          // `enqueue` is a no-op and the caller drives `runJob` directly.
          ...(deps.queue ? { queue: deps.queue } : {}),
        })
      }
      return bulkJobServiceInstance
    },
    registerPlan(jobId: string, plan: Parameters<BulkFillJobService['registerPlan']>[1]) {
      this.instance.registerPlan(jobId, plan)
    },
    enqueue(jobId: string) {
      return this.instance.enqueue(jobId)
    },
  }

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
   * Single-record thin wrapper over `runShortcutCore` (review-fix F1 gate
   * order preserved): burst limit (429 EARLY: NO lock, NO ledger row, the
   * limiter responds itself) → core → map the per-row outcome to `res` →
   * onSuccess on the charged-success path (run: patch + Yjs; write failures
   * re-settle the status KEEPING usage via `finalize`).
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
    // Burst rate limit (Q-3) — runs BEFORE the core's reserve (gate order
    // unchanged): 429 EARLY, no lock, no pooled connection held, NEVER a
    // ledger row (the limiter responds itself).
    if ((await applyBurstLimiter(burstLimiter, req, res)) === 'limited') {
      return
    }

    const outcome = await runShortcutCore(aiClient, ctx, prompt)
    switch (outcome.kind) {
      case 'unsafe_input':
        return sendStatus(res, 422, 'unsafe_input', 'AI_UNSAFE_INPUT', outcome.message)
      case 'blocked':
        return sendStatus(res, 503, 'blocked', 'AI_BLOCKED', outcome.message)
      case 'reserve_failed':
        return sendStatus(res, 503, 'blocked', 'AI_BLOCKED', outcome.message)
      case 'quota_exhausted':
        return sendStatus(res, 429, 'quota_exhausted', 'AI_QUOTA_EXHAUSTED', `AI usage quota exhausted (${outcome.reason}).`)
      case 'generation_failed_before_usage':
        return sendStatus(
          res,
          outcome.httpStatus,
          outcome.httpStatus === 502 ? 'provider_error' : 'blocked',
          outcome.code,
          outcome.message,
        )
      case 'charged': {
        if (!outcome.result.ok) {
          // A charged-but-errored row (provider error WITH usage) has no usable
          // text on the single-record path — surface the provider error (the
          // spend is already settled).
          return sendStatus(res, 502, 'provider_error', 'AI_PROVIDER_ERROR', outcome.result.message ?? 'AI provider request failed.')
        }
        await onSuccess(outcome.result as AiCompletionResult & { ok: true }, (status, error) => outcome.settle(status, error ?? null))
        return
      }
    }
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

      const patchContext = await buildRecordPatchContext(req, query, sheetId, access, capabilities)
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

      const patchContext = await buildRecordPatchContext(req, query, sheetId, access, capabilities)
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

  /**
   * B-1 — AI bulk-PREVIEW (INTERNAL, not in OpenAPI). Apply an ALREADY-PERSISTED
   * field.property.aiShortcut across MANY records at once, generating + charging
   * per provider-called row, returning the proposed values for a review-before-
   * write (the WRITE itself is B-2 — this route never writes a record).
   *
   * Design lock:
   * docs/development/multitable-ai-bulk-fill-review-before-write-designlock-20260621.md
   *
   * Posture (extend, don't fork): the SAME per-record gate sequence + the SAME
   * res-free reserve-then-settle core (runShortcutCore), looped per row. The
   * BURST limiter runs ONCE at route entry (per-HTTP-request guard); per-row
   * bounding is the D3 row-cap + the D4 quota pre-check.
   *
   * Gate map:
   *  - inline config REJECTED (run parity).
   *  - SHEET-LEVEL gates ONCE (hoisted out of the loop): record-read capability
   *    → canEditRecord → buildRecordPatchContext → target type ∈ {string,longText}
   *    + layer-3 fieldPermissions[fieldId] (visible/readOnly) → persisted config.
   *  - D2-A scope: the FULL server-resolved filtered set (scope:'view' applies
   *    the view's persisted filterInfo over ALL records, NOT the loaded page);
   *    scope:'sheet' = whole sheet. Optional recordIds intersect the set.
   *  - D3-A cap: |resolved set| > MULTITABLE_AI_BULK_MAX_ROWS → 400
   *    BULK_SCOPE_TOO_LARGE (no silent truncation).
   *  - D4: pre-check rows × per-row est-tokens vs the per-tenant cap; whole run
   *    won't fit → AI_BULK_QUOTA_INSUFFICIENT (generate NOTHING).
   *  - PER ROW (D5 + D1-A): requireRecordReadable (read-deny → OMITTED from the
   *    response entirely) → ensureRecordWriteAllowed (not writable →
   *    skipped_no_perm, NO generation) → readRecordOnce (capture version) →
   *    assembleMaskedPrompt (unreadable sources NEVER enter the prompt) →
   *    runShortcutCore. A provider-called row is CHARGED + cached + returned;
   *    its diff is MASKED (masked:true when any source field was dropped). A
   *    provider-never-reached row (skipped/over-cap/quota/no-usage) is UNCHARGED.
   *  - 429/blocked mid-batch PAUSES the run: stop and return PARTIAL; un-reached
   *    rows are uncharged. (AiCompletionResult collapses provider 429 into
   *    provider_error, so a provider failure stops the batch — un-reached rows
   *    are never charged.)
   */
  router.post('/sheets/:sheetId/ai/shortcut/bulk-preview', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    // Persisted config only (run parity) — reject inline config BEFORE shape parse.
    if (req.body && typeof req.body === 'object' && 'config' in (req.body as Record<string, unknown>)) {
      return res.status(400).json({
        ok: false,
        error: { code: 'AI_INLINE_CONFIG_REJECTED', message: 'bulk-preview executes only the persisted field.property.aiShortcut config; inline config is not accepted' },
      })
    }
    const schema = z.object({
      fieldId: z.string().min(1).max(50),
      scope: z.enum(['view', 'sheet']),
      viewId: z.string().min(1).max(50).optional(),
      recordIds: z.array(z.string().min(1).max(50)).max(5000).optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!sheetId || !parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: !sheetId ? 'sheetId is required' : parsed.error?.message } })
    }
    const { fieldId, scope, viewId, recordIds } = parsed.data
    if (scope === 'view' && !viewId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'viewId is required when scope is "view"' } })
    }

    // Burst rate limit ONCE at entry (per-HTTP-request guard) — never per row.
    if ((await applyBurstLimiter(burstLimiter, req, res)) === 'limited') {
      return
    }

    try {
      const pool = poolManager.get() as unknown as PoolLike
      const query = pool.query.bind(pool) as QueryFn
      const ledgerQuery = pool.query.bind(pool) as AiUsageQueryFn

      // ── SHEET-LEVEL gates (ONCE, hoisted) ──────────────────────────────────
      const { access, capabilities, sheetScope } = await resolveSheetReadableCapabilities(req, query, sheetId)
      if (!access.userId) {
        return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } })
      }
      if (!capabilities.canRead) {
        return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } })
      }
      if (!capabilities.canEditRecord) {
        return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } })
      }

      const patchContext = await buildRecordPatchContext(req, query, sheetId, access, capabilities)
      if (!patchContext) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }

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
      // Layer-3 write gate (#2106 F3) — the per-record run's enforcement point, hoisted.
      const targetPermission = patchContext.fieldPermissions[fieldId]
      if (!targetPermission || targetPermission.visible === false || targetPermission.readOnly === true) {
        return res.status(403).json({ ok: false, error: { code: 'FIELD_FORBIDDEN', message: `AI shortcut target field is not editable: ${fieldId}` } })
      }

      const resolved = resolvePersistedShortcutConfig(patchContext, fieldId)
      if ('error' in resolved) {
        return res.status(resolved.httpStatus).json({ ok: false, error: { code: resolved.code, message: resolved.error } })
      }
      const config = resolved.config

      // ── D2-A scope: server-resolved FULL filtered set (NOT the loaded page) ──
      // Resolve the view filter over the SAME visible field set the read path
      // uses (patchContext.fields), reusing parseMetaFilterInfo + evaluateFilterNode
      // (the #3010 export semantic). scope:'sheet' = every record on the sheet.
      const fieldTypeById = new Map(patchContext.fields.map((field) => [field.id, field.type]))
      // A condition on a field the actor cannot SELECT (layer-2 ∧ layer-3 denied)
      // is dropped = treated as non-existent (parity with /view); a computed
      // (lookup/rollup/formula) filter can't be evaluated here without
      // applyLookupRollup, so it's dropped too (the row simply isn't excluded by
      // it — conservative: a bulk preview must not silently disagree with the
      // grid by SILENTLY DROPPING rows it can't evaluate).
      const selectableFieldIds = patchContext.readableEchoFieldIds
      const COMPUTED_FILTER_TYPES = new Set(['lookup', 'rollup', 'formula'])

      let filterNode: ReturnType<typeof parseMetaFilterInfo> = null
      // BJ-7 scope fingerprint input: the view's persisted filter signature (a
      // stable JSON of its filterInfo) so a re-start with the same view/filter
      // resumes the same job and a changed filter is a distinct intent.
      let filterSignature: string | null = null
      if (scope === 'view') {
        const view = await tryResolveView(query, viewId!, new Map())
        if (!view || view.sheetId !== sheetId) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `View not found: ${viewId}` } })
        }
        filterNode = parseMetaFilterInfo(view.filterInfo)
        filterSignature = view.filterInfo == null ? '' : JSON.stringify(view.filterInfo)
      }

      const recordIdFilter = recordIds && recordIds.length > 0 ? new Set(recordIds) : null
      const recordRes = await query('SELECT id, version, data FROM meta_records WHERE sheet_id = $1', [sheetId])
      let candidateIds = (recordRes.rows as Array<{ id: unknown; data: unknown }>)
        .map((row) => ({ id: String(row.id), data: normalizeJson(row.data) }))
        .filter((row) => (recordIdFilter ? recordIdFilter.has(row.id) : true))
      if (filterNode) {
        // A COMPUTED (lookup/rollup/formula) filter leaf the actor CAN select cannot be
        // evaluated here without hydration. Treating it as match-all would generate AI
        // for rows OUTSIDE the user's view (over-scope + over-charge for a write-preview),
        // so v1 REFUSES rather than silently over-generate. (A computed leaf on a DENIED
        // field is dropped = non-existent, parity with the actor's own /view which also
        // can't apply it.) Reusing the #3010 computed-filter hydration is the later option.
        const computedLeaf = collectLeafConditions(filterNode).find(
          (leaf) => selectableFieldIds.has(leaf.fieldId) && COMPUTED_FILTER_TYPES.has(fieldTypeById.get(leaf.fieldId) ?? ''),
        )
        if (computedLeaf) {
          return res.status(422).json({
            ok: false,
            error: {
              code: 'AI_BULK_VIEW_FILTER_UNSUPPORTED',
              message: 'This view filters on a computed (lookup/rollup/formula) field, which bulk preview cannot resolve yet — narrow the view to non-computed filters, or pass an explicit record selection.',
            },
          })
        }
        // A leaf on a denied (non-selectable) field is treated as non-existent (matches
        // everything), matching the actor's own /view "denied field == non-existent" rule.
        const leafMatches = (leaf: MetaFilterCondition, cellValue: unknown): boolean => {
          if (!selectableFieldIds.has(leaf.fieldId)) return true
          return evaluateMetaFilterCondition(fieldTypeById.get(leaf.fieldId)!, cellValue, leaf)
        }
        const hasEvaluableLeaf = collectLeafConditions(filterNode).some((leaf) => selectableFieldIds.has(leaf.fieldId))
        if (hasEvaluableLeaf) {
          candidateIds = candidateIds.filter((row) =>
            evaluateFilterNode(filterNode!, (leaf) => leafMatches(leaf, row.data[leaf.fieldId])),
          )
        }
      }
      const candidates = candidateIds.map((row) => row.id)

      // ── BJ-7 active-job check BEFORE the expensive per-row gate loop ─────────────
      // Compute the scope fingerprint (cheap) and look up an active job for this
      // (actor, sheet, field). A MATCHING fingerprint → return that job's id
      // (idempotent resume — never a duplicate generating run / double-charge),
      // skipping the expensive resolution. A DIFFERENT fingerprint → 409 (a distinct
      // intent is never silently attached to the old batch).
      const scopeFingerprint = computeScopeFingerprint({ scope, viewId: viewId ?? null, filterSignature, recordIds: recordIds ?? null })
      const activeJob = await findActiveBulkJob(ledgerQuery, access.userId, sheetId, fieldId)
      if (activeJob) {
        if (activeJob.scopeFingerprint === scopeFingerprint) {
          return res.json({ jobId: activeJob.jobId })
        }
        return res.status(409).json({
          ok: false,
          error: {
            code: 'ACTIVE_JOB_EXISTS',
            message: 'An AI bulk-fill job for a different scope is already running for this field; review or cancel it before starting another.',
            job: { jobId: activeJob.jobId, status: activeJob.status, total: activeJob.total, generated: activeJob.generated, quotaPaused: activeJob.quotaPaused },
          },
        })
      }

      // ── D5 gates BEFORE D3/D4: only PROVIDER-BOUND rows count toward cap/quota ──
      // Build the generation set FIRST so a read-denied row is OMITTED (never counted →
      // no hidden-row oracle via total/400/429) and a not-writable row is skipped_no_perm
      // (never counted toward the provider-call cap/quota → a small real batch is never
      // false-blocked by many unreadable/unwritable rows). The version captured here
      // rides into the run cache as previewVersion (anti-TOCTOU for B-2).
      const runId = `aibulk_${randomUUID()}`
      const skipped: Array<{ recordId: string; reason: string }> = []
      // CHARGED but NOT confirmable (provider responded WITH usage but errored, or the
      // run-cache write failed). Distinct from `skipped` (UNCHARGED). B-2 must never
      // treat a `failures` row as committable — there is no usable cached output.
      const failures: Array<{ recordId: string; reason: string }> = []
      // The full source-field set the config wants — used to flag a masked diff (a row
      // whose readable source set is smaller generated against a reduced context).
      const configSourceCount = config.sourceFieldIds.length

      const generationCandidates: Array<{ recordId: string; version: number; data: Record<string, unknown> }> = []
      for (const recordId of candidates) {
        // Row-level READ gate — a read-denied / vanished row is OMITTED entirely (never
        // counted, never a skipped entry that would confirm existence = no oracle).
        const readable = await requireRecordReadable(req, query, sheetId, recordId)
        if ('status' in readable) continue
        const captured = await readRecordOnce(query, sheetId, recordId)
        if (!captured) continue
        // Row-policy WRITE gate — not writable → skipped_no_perm, NOT counted toward cap/quota.
        if (!ensureRecordWriteAllowed(capabilities, sheetScope, access, captured.createdBy, 'edit')) {
          skipped.push({ recordId, reason: 'skipped_no_perm' })
          continue
        }
        generationCandidates.push({ recordId, version: captured.version, data: captured.data })
      }

      // ── BJ-8 routing: > inline cap → async JOB (≤ job cap), else inline (UNCHANGED) ──
      // The cap counts ONLY provider-bound rows (the locked B-1 invariant), so the
      // routing decision rides on the same gated set. ≤ inline cap stays the v1
      // synchronous path below (byte-identical). Over the inline cap → start a job
      // (header + seeded job-rows + enqueue) and return { jobId }; over the JOB cap
      // → 400 BULK_SCOPE_TOO_LARGE (no silent truncation).
      const inlineMaxRows = resolveBulkInlineMaxRows()
      if (generationCandidates.length > inlineMaxRows) {
        const jobMaxRows = resolveBulkJobMaxRows()
        if (generationCandidates.length > jobMaxRows) {
          return res.status(400).json({
            ok: false,
            error: { code: 'BULK_SCOPE_TOO_LARGE', message: `Bulk scope resolves to ${generationCandidates.length} generatable rows, over the async job cap of ${jobMaxRows}. Narrow the view/selection.`, total: generationCandidates.length, cap: jobMaxRows },
          })
        }

        // Build the per-row seeds (pending generatable + skipped_no_perm) and the
        // in-process generation plan (the masked prompts — NEVER persisted: taint).
        const jobId = `aibulkjob_${randomUUID()}`
        const seeds: BulkJobRowSeed[] = []
        const planRows: Array<{ recordId: string; prompt: string; version: number; masked: boolean }> = []
        let ordinal = 0
        for (const cand of generationCandidates) {
          const prompt = assembleMaskedPrompt(config, patchContext, cand.data)
          const readableSourceCount = config.sourceFieldIds.filter((id) => patchContext.readableEchoFieldIds.has(id)).length
          const masked = readableSourceCount < configSourceCount
          const currentRaw = cand.data[fieldId]
          const currentValue = typeof currentRaw === 'string' ? currentRaw : currentRaw == null ? null : String(currentRaw)
          seeds.push({ recordId: cand.recordId, ordinal, state: 'pending', currentValue })
          planRows.push({ recordId: cand.recordId, prompt, version: cand.version, masked })
          ordinal += 1
        }
        // skipped_no_perm rows are seeded as `state=skipped` (truthful review state),
        // NOT counted toward `total` (the provider-bound denominator for progress).
        for (const s of skipped) {
          seeds.push({ recordId: s.recordId, ordinal, state: 'skipped', currentValue: null, reason: s.reason })
          ordinal += 1
        }

        try {
          // Insert the header FIRST — the partial UNIQUE active index enforces BJ-7
          // (a concurrent different-scope double-start raises a unique violation we
          // catch + resolve to the existing job). Then seed rows + register the plan.
          await insertBulkJobHeader(ledgerQuery, {
            jobId,
            actorId: access.userId,
            sheetId,
            fieldId,
            scopeFingerprint,
            total: generationCandidates.length,
          })
        } catch (err) {
          // Lost a concurrent-start race → return the now-active job (same fp) or 409.
          const raced = await findActiveBulkJob(ledgerQuery, access.userId, sheetId, fieldId)
          if (raced) {
            if (raced.scopeFingerprint === scopeFingerprint) return res.json({ jobId: raced.jobId })
            return res.status(409).json({
              ok: false,
              error: {
                code: 'ACTIVE_JOB_EXISTS',
                message: 'An AI bulk-fill job for a different scope is already running for this field; review or cancel it before starting another.',
                job: { jobId: raced.jobId, status: raced.status, total: raced.total, generated: raced.generated, quotaPaused: raced.quotaPaused },
              },
            })
          }
          throw err
        }
        await insertBulkJobRowsPending(ledgerQuery, jobId, seeds)
        bulkJobService.registerPlan(jobId, { actorId: access.userId, sheetId, fieldId, rows: planRows })
        await bulkJobService.enqueue(jobId)
        return res.json({ jobId })
      }
      // ≤ inline cap from here: the v1 SYNCHRONOUS path, UNCHANGED. (The D3-A hard
      // cap is now the BJ-8 routing decision above — over the inline cap routes to a
      // job; over the job cap 400s — so no separate inline-cap 400 is reachable here.)

      // ── D4 pre-check on the PROVIDER-BOUND set: whole run must fit the per-tenant cap ──
      // Estimate generatable-rows × per-row tokens against the CALLER's daily/weekly
      // windows; if it can't fit, refuse the WHOLE run before generating (no partial spend).
      const pre = aiClient.preflight()
      if ('message' in pre) {
        // Provider not ready — refuse the whole run up front (no per-row blocked rows).
        return sendStatus(res, 503, 'blocked', 'AI_BLOCKED', pre.message)
      }
      if (generationCandidates.length > 0) {
        const perRowEstTokens = conservativePromptTokenEstimate('') + pre.caps.maxOutputTokens
        const estTotalTokens = generationCandidates.length * perRowEstTokens
        const sums = await sumAiUsageWindows(ledgerQuery, access.userId)
        const dailyFits = sums.userDailyTokens + estTotalTokens <= pre.caps.tenantDailyTokenCap
        const weeklyFits = sums.userWeeklyTokens + estTotalTokens <= pre.caps.tenantWeeklyTokenCap
        if (!dailyFits || !weeklyFits) {
          return res.status(429).json({
            ok: false,
            status: 'quota_exhausted',
            error: {
              code: 'AI_BULK_QUOTA_INSUFFICIENT',
              message: `This bulk run needs ~${estTotalTokens} tokens which exceeds the remaining per-tenant ${!dailyFits ? 'daily' : 'weekly'} token quota; nothing was generated.`,
            },
          })
        }
      }

      // ── PER-ROW generation (D1-A charge-on-generation) over the gated set ───────────
      const rows: Array<{ recordId: string; version: number; currentValue: string | null; proposed: string; masked: boolean; writable: boolean }> = []
      let settledCost = 0
      let paused = false

      for (const cand of generationCandidates) {
        const recordId = cand.recordId
        const captured = { version: cand.version, data: cand.data }
        // Mask + assemble: unreadable source fields NEVER enter the prompt.
        const prompt = assembleMaskedPrompt(config, patchContext, captured.data)
        // masked diff: how many of the config's sources actually survived the read mask.
        const readableSourceCount = config.sourceFieldIds.filter((id) => patchContext.readableEchoFieldIds.has(id)).length
        const masked = readableSourceCount < configSourceCount

        const outcome = await runShortcutCore(
          aiClient,
          { pool, sheetId, recordId, fieldId, action: 'preview', userId: access.userId },
          prompt,
        )

        if (outcome.kind === 'charged') {
          // The CHARGE stands regardless of what follows — runShortcutCore already
          // settled provider usage into the ledger (provider spend is real).
          const usageTokens = outcome.usage.promptTokens + outcome.usage.completionTokens
          const costUsd = outcome.result.estimatedCostUsd
          settledCost += costUsd

          // `charged` ALSO covers provider_error-WITH-usage (runShortcutCore: the
          // provider billed but produced no usable output). That row is CHARGED but
          // NOT confirmable — never cache an empty/failed output, never return it as
          // writable (B-2 commits ONLY real cached outputs). Pause: a provider
          // erroring mid-batch must not keep spending on subsequent rows.
          if (!outcome.result.ok) {
            failures.push({ recordId, reason: 'provider_error_charged' })
            paused = true
            break
          }

          const proposed = outcome.result.text ?? ''
          // Persist the cached output — B-2 commits ONLY from this. The cache is the
          // OUTPUT store, never the charge ledger (the charge already settled above).
          const cacheRow: BulkPreviewCacheRow = {
            runId,
            actorId: access.userId,
            sheetId,
            fieldId,
            recordId,
            previewVersion: captured.version,
            proposedValue: proposed,
            usageTokens,
            costUsd,
          }
          let cached = false
          try {
            await insertBulkPreviewCacheRow(ledgerQuery, cacheRow)
            cached = true
          } catch (err) {
            console.error('[multitable-ai] bulk-preview cache insert failed (fail-closed for this row):', err)
          }
          if (!cached) {
            // FAIL-CLOSED (#3019 persistent-run-cache lock): the row is CHARGED
            // (provider spend is real) but has NO cached output for B-2 to commit,
            // so it must NOT be a confirmable row. Pause — a cache outage would
            // otherwise charge every subsequent row un-confirmably.
            failures.push({ recordId, reason: 'cache_failed_after_generation' })
            paused = true
            break
          }
          // currentValue = the target field's value the writer is about to overwrite,
          // read server-side from THIS record (never grid-page-dependent) so the review
          // diff is truthful for EVERY row, on-page or not. The writer passed the target
          // field's write+visible gate, so they may read it (no extra mask needed).
          const currentRaw = captured.data[fieldId]
          const currentValue = typeof currentRaw === 'string' ? currentRaw : currentRaw == null ? null : String(currentRaw)
          rows.push({ recordId, version: captured.version, currentValue, proposed, masked, writable: true })
          continue
        }

        if (outcome.kind === 'quota_exhausted' || outcome.kind === 'blocked' || outcome.kind === 'reserve_failed') {
          // Quota/availability hit mid-batch → PAUSE: stop here, return partial.
          // This row + every un-reached row is UNCHARGED.
          skipped.push({ recordId, reason: outcome.kind === 'quota_exhausted' ? 'rate_limited_before_call' : 'blocked_before_call' })
          paused = true
          break
        }

        if (outcome.kind === 'generation_failed_before_usage') {
          // Provider failed with NO usage (incl. a collapsed 429) → UNCHARGED.
          // A provider failure pauses the batch (un-reached rows uncharged).
          skipped.push({ recordId, reason: 'generation_failed_before_usage' })
          paused = true
          break
        }

        if (outcome.kind === 'unsafe_input') {
          // Secret-shaped prompt for this row — not sent, UNCHARGED; skip the row
          // but DO NOT pause (other rows may be clean).
          skipped.push({ recordId, reason: 'unsafe_input' })
          continue
        }
      }

      return res.json({
        runId,
        rows,
        skipped,
        failures,
        settledCost,
        capped: paused,
      })
    } catch (err) {
      console.error('[multitable-ai] bulk-preview failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to run AI bulk preview' } })
    }
  })

  /**
   * B-2 — AI bulk-COMMIT (INTERNAL, not in OpenAPI). The WRITE step of the
   * review-before-write flow: persist the CACHED proposed values (generated +
   * already CHARGED at B-1 preview) for the rows the user confirmed. Second impl
   * ring of the ratified design lock (§3 + D6):
   * docs/development/multitable-ai-bulk-fill-review-before-write-designlock-20260621.md
   *
   * Body: { runId, recordIds: [confirmed] }. fieldId/sheetId come from the cache
   * rows + URL (NOT the body) — a run targets exactly one field.
   *
   * LOCKED criteria (each → a real-DB golden):
   *  1. Commit ONLY cached rows. The write set = cache rows (readBulkPreviewCacheRows)
   *     whose recordId ∈ confirmed recordIds. A confirmed recordId with NO cache
   *     entry → `not_in_cache`, NEVER written. NEVER re-generate / call the provider.
   *  2. A non-cached / B-1 `failures[]` row → `not_in_cache` (there is no value to write).
   *  3. expectedVersion stale-drop. The write rides the CACHED `previewVersion`
   *     (anti-TOCTOU) into patchRecords; ServiceVersionConflictError → `stale_reprev`.
   *  4. Abandoned previews stay charged — release NOTHING. Commit does ZERO ledger
   *     writes (charge settled at B-1); a cached row NOT in the confirmed list is
   *     simply not written. Reuse is patchRecords ONLY — never the reserve/settle
   *     core — so the ledger token-sum is UNCHANGED by a commit.
   *  5. Per-row partial outcomes (no all-or-nothing rollback): each confirmed
   *     recordId gets exactly one outcome ∈ {written, stale_reprev, write_conflict,
   *     not_in_cache, skipped_no_perm}. patchRecords is called ONCE PER record
   *     (single-entry Map), each in its own try/catch.
   *  6. Re-gate AT COMMIT (perms can change after preview): every cached row must
   *     STILL pass record-read (requireRecordReadable) + sheet canEditRecord +
   *     layer-3 field-permission (visible/readOnly) + ensureRecordWriteAllowed —
   *     a row unwritable NOW → `skipped_no_perm`, never written. The write ALSO
   *     goes through patchRecords (which re-enforces lock/version in-transaction).
   *
   * The EXACT cached `proposedValue` is written (B-1 stored it verbatim). A short
   * TTL applies: a cache row past `expiresAt` (an abandoned/expired run) is
   * treated as `not_in_cache` (no value to commit). Per-recordId outcome
   * precedence: not_in_cache (no entry / expired) → skipped_no_perm (a commit-time
   * gate fails) → patchRecords outcome (written / stale_reprev / write_conflict).
   * An unknown / fully-expired runId yields all-`not_in_cache` at 200 (never 404).
   */
  router.post('/sheets/:sheetId/ai/shortcut/bulk-commit', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    const schema = z.object({
      runId: z.string().min(1).max(100),
      recordIds: z.array(z.string().min(1).max(50)).min(1).max(5000),
    })
    const parsed = schema.safeParse(req.body)
    if (!sheetId || !parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: !sheetId ? 'sheetId is required' : parsed.error?.message } })
    }
    const { runId, recordIds } = parsed.data

    // Burst rate limit ONCE at entry (per-HTTP-request guard, bulk-preview parity).
    // Commit issues NO provider call, but it is still a privileged batch endpoint.
    if ((await applyBurstLimiter(burstLimiter, req, res)) === 'limited') {
      return
    }

    type CommitOutcome = 'written' | 'stale_reprev' | 'write_conflict' | 'not_in_cache' | 'skipped_no_perm'
    const outcomes: Array<{ recordId: string; outcome: CommitOutcome }> = []

    try {
      const pool = poolManager.get() as unknown as PoolLike
      const query = pool.query.bind(pool) as QueryFn

      // ── SHEET-LEVEL gates (ONCE, hoisted; bulk-preview parity) ────────────────
      const { access, capabilities, sheetScope } = await resolveSheetReadableCapabilities(req, query, sheetId)
      if (!access.userId) {
        return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } })
      }
      if (!capabilities.canRead) {
        return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } })
      }
      if (!capabilities.canEditRecord) {
        return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } })
      }

      const patchContext = await buildRecordPatchContext(req, query, sheetId, access, capabilities)
      if (!patchContext) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }

      // ── Cache = THE ONLY source of values to write (criterion 1) ──────────────
      // Read the run's cache once; index by recordId. A row past its TTL is treated
      // as absent (criterion: expired run == not_in_cache). A cache row whose
      // sheet_id does NOT match the URL sheet is dropped (cross-sheet runId guard).
      const ledgerQuery = pool.query.bind(pool) as AiUsageQueryFn
      const cacheRows = await readBulkPreviewCacheRows(ledgerQuery, runId)
      const nowMs = Date.now()
      const cacheByRecordId = new Map<string, (typeof cacheRows)[number]>()
      for (const row of cacheRows) {
        if (row.sheetId !== sheetId) continue
        // OWNER gate (fail-closed): the cached output was generated under the ORIGINAL
        // actor's source-field read permissions, so ONLY that actor may commit it. A
        // different user — even one with canEditRecord on this sheet who has the runId —
        // gets `not_in_cache`, never another actor's preview output (which can encode
        // source-field content THAT committer cannot read).
        if (row.actorId !== access.userId) continue
        const expiresMs = Date.parse(row.expiresAt)
        if (Number.isFinite(expiresMs) && expiresMs <= nowMs) continue // expired → not_in_cache
        // PK is (run_id, record_id) so at most one live row per recordId.
        cacheByRecordId.set(row.recordId, row)
      }

      // ── PER-ROW commit over the CONFIRMED set (deduped, order preserved) ───────
      // Each confirmed recordId gets EXACTLY ONE outcome (criterion 5). Precedence:
      // not_in_cache → skipped_no_perm (commit-time re-gate) → patchRecords outcome.
      const seen = new Set<string>()
      for (const recordId of recordIds) {
        if (seen.has(recordId)) continue
        seen.add(recordId)

        const cached = cacheByRecordId.get(recordId)
        if (!cached) {
          // No cached value (never generated, a B-1 `failures[]` row, or expired) →
          // NOTHING to write. Criteria 1 + 2.
          outcomes.push({ recordId, outcome: 'not_in_cache' })
          continue
        }

        // Re-gate AT COMMIT (criterion 6) + land the EXACT cached value through the
        // shared per-record write discipline (criteria 3 + 5 + 6). The CACHED
        // previewVersion rides in as expectedVersion (anti-TOCTOU). Identical code
        // to the B-4 job commit phase — only the value/version SOURCE differs.
        const outcome = await commitOneRecord({
          req,
          query,
          pool,
          patchContext,
          capabilities,
          sheetScope,
          access,
          sheetId,
          recordId,
          fieldId: cached.fieldId,
          value: cached.proposedValue,
          expectedVersion: cached.previewVersion,
        })
        outcomes.push({ recordId, outcome })
      }

      const counts = outcomes.reduce<Record<CommitOutcome, number>>(
        (acc, { outcome }) => {
          acc[outcome] += 1
          return acc
        },
        { written: 0, stale_reprev: 0, write_conflict: 0, not_in_cache: 0, skipped_no_perm: 0 },
      )

      return res.json({ outcomes, counts })
    } catch (err) {
      console.error('[multitable-ai] bulk-commit failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to commit AI bulk preview' } })
    }
  })

  /**
   * Resolve a bulk-fill job for the caller, enforcing the per-route gates shared
   * by every job route: the job must EXIST, belong to the CALLER (BJ-7 owner
   * gate — a job's generated outputs encode source content only its actor may
   * read), and live on the URL sheet (cross-sheet jobId guard). Returns the
   * header or sends the appropriate 401/403/404 and returns null.
   */
  async function resolveBulkJobForActor(
    req: Request,
    res: Response,
    query: AiUsageQueryFn,
    sheetId: string,
    jobId: string,
  ): Promise<Awaited<ReturnType<typeof readBulkJobHeader>>> {
    const userId = resolveRequestUserKey(req)
    if (!userId) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } })
      return null
    }
    const header = await readBulkJobHeader(query, jobId)
    // Owner + cross-sheet checks collapse to 404 (never reveal another actor's /
    // another sheet's job exists).
    if (!header || header.actorId !== userId || header.sheetId !== sheetId) {
      res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Bulk job not found: ${jobId}` } })
      return null
    }
    return header
  }

  /**
   * B-4 BJ-3 — POLL a bulk-fill job's progress. Actor + cross-sheet gated. Returns
   * the durable header counters + per-state row counts + the commit aggregate.
   */
  router.get('/sheets/:sheetId/ai/shortcut/bulk-job/:jobId', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    const jobId = typeof req.params.jobId === 'string' ? req.params.jobId.trim() : ''
    if (!sheetId || !jobId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId and jobId are required' } })
    }
    try {
      const pool = poolManager.get() as unknown as PoolLike
      const query = pool.query.bind(pool) as AiUsageQueryFn
      const header = await resolveBulkJobForActor(req, res, query, sheetId, jobId)
      if (!header) return
      const counts = await countBulkJobRowsByState(query, jobId)
      return res.json({
        jobId: header.jobId,
        state: header.status,
        suspendReason: header.suspendReason,
        total: header.total,
        generated: header.generated,
        skippedCount: counts.skipped,
        failuresCount: counts.failure,
        committedCount: counts.committed,
        pendingNotGeneratedCount: counts.pending_not_generated,
        settledCost: header.settledCost,
        quotaPaused: header.quotaPaused,
        aggregate: header.aggregate,
      })
    } catch (err) {
      console.error('[multitable-ai] bulk-job poll failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to read bulk job' } })
    }
  })

  /**
   * B-4 BJ-9 — paginated review of a job's rows, ordered by ordinal. Actor +
   * cross-sheet gated. Each row carries its durable diff (current_value /
   * proposed / masked / reason) and state; confirmable = state === 'generated'.
   */
  router.get('/sheets/:sheetId/ai/shortcut/bulk-job/:jobId/rows', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    const jobId = typeof req.params.jobId === 'string' ? req.params.jobId.trim() : ''
    if (!sheetId || !jobId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId and jobId are required' } })
    }
    const cursorRaw = typeof req.query.cursor === 'string' ? Number(req.query.cursor) : NaN
    const cursor = Number.isFinite(cursorRaw) ? cursorRaw : null
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 100
    try {
      const pool = poolManager.get() as unknown as PoolLike
      const query = pool.query.bind(pool) as AiUsageQueryFn
      const header = await resolveBulkJobForActor(req, res, query, sheetId, jobId)
      if (!header) return
      const rows = await readBulkJobRows(query, jobId, cursor, limit)
      const nextCursor = rows.length === limit ? rows[rows.length - 1]!.ordinal : null
      return res.json({
        rows: rows.map((r) => ({
          recordId: r.recordId,
          ordinal: r.ordinal,
          state: r.state,
          currentValue: r.currentValue,
          proposed: r.proposedValue,
          masked: r.masked,
          reason: r.reason,
        })),
        nextCursor,
      })
    } catch (err) {
      console.error('[multitable-ai] bulk-job rows failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to read bulk job rows' } })
    }
  })

  /**
   * B-4 BJ-4 — CANCEL a job. Actor + cross-sheet gated. The worker stops at the
   * next row; rows already `generated` stay charged + committable; ungenerated
   * rows → pending_not_generated (uncharged); the job → `rejected`. No release.
   */
  router.post('/sheets/:sheetId/ai/shortcut/bulk-job/:jobId/cancel', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    const jobId = typeof req.params.jobId === 'string' ? req.params.jobId.trim() : ''
    if (!sheetId || !jobId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId and jobId are required' } })
    }
    try {
      const pool = poolManager.get() as unknown as PoolLike
      const query = pool.query.bind(pool) as AiUsageQueryFn
      const header = await resolveBulkJobForActor(req, res, query, sheetId, jobId)
      if (!header) return
      const cancelled = await cancelBulkJob(query, jobId)
      const after = await readBulkJobHeader(query, jobId)
      return res.json({ jobId, cancelled, state: after?.status ?? header.status })
    } catch (err) {
      console.error('[multitable-ai] bulk-job cancel failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to cancel bulk job' } })
    }
  })

  /**
   * B-4 BJ-10 — COMMIT the confirmed subset of a job. The FE submits the
   * confirmed `recordIds` ONCE; the BACKEND chunks the confirmed `generated`
   * rows (≤ the inline cap per chunk) through the SHARED per-record write
   * discipline (commitOneRecord — re-gate + expectedVersion stale-drop + per-actor
   * owner gate, sourced from job-rows), writes each outcome back to job-rows, and
   * stores the durable aggregate on the header (poll-readable).
   */
  router.post('/sheets/:sheetId/ai/shortcut/bulk-job/:jobId/commit', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    const jobId = typeof req.params.jobId === 'string' ? req.params.jobId.trim() : ''
    const schema = z.object({ recordIds: z.array(z.string().min(1).max(50)).min(1).max(5000) })
    const parsed = schema.safeParse(req.body)
    if (!sheetId || !jobId || !parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: !sheetId || !jobId ? 'sheetId and jobId are required' : parsed.error?.message } })
    }
    const confirmed = new Set(parsed.data.recordIds)

    // Burst rate limit ONCE at entry (bulk-commit parity) — a privileged batch endpoint.
    if ((await applyBurstLimiter(burstLimiter, req, res)) === 'limited') {
      return
    }

    try {
      const pool = poolManager.get() as unknown as PoolLike
      const query = pool.query.bind(pool) as QueryFn
      const ledgerQuery = pool.query.bind(pool) as AiUsageQueryFn

      const header = await resolveBulkJobForActor(req, res, ledgerQuery, sheetId, jobId)
      if (!header) return

      // BJ-4/BJ-5: the job must be in a COMMITTABLE state — one where the worker is
      // no longer mutating it. `suspended` = generated & awaiting review; `errored` =
      // crashed mid-generate (BJ-5, persisted partial committable); `rejected` =
      // cancelled (BJ-4, already-generated rows still committable). Reject `queued`/
      // `running` (the worker is still generating — committing now would race it and
      // write a partial) and `resolved` (already committed). 409 Conflict.
      if (header.status !== 'suspended' && header.status !== 'errored' && header.status !== 'rejected') {
        return res.status(409).json({
          ok: false,
          error: { code: 'BULK_JOB_NOT_COMMITTABLE', message: `Bulk job is not awaiting commit (status: ${header.status}).` },
        })
      }

      // Sheet-level gates (bulk-commit parity) — the actor must STILL be able to
      // write the sheet; the per-record re-gate inside commitOneRecord enforces the
      // rest. resolveSheetReadableCapabilities resolves the caller's RBAC.
      const { access, capabilities, sheetScope } = await resolveSheetReadableCapabilities(req, query, sheetId)
      if (!access.userId) {
        return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } })
      }
      if (!capabilities.canRead || !capabilities.canEditRecord) {
        return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } })
      }
      const patchContext = await buildRecordPatchContext(req, query, sheetId, access, capabilities)
      if (!patchContext) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }

      // The write set = the job's `generated` rows whose recordId was confirmed.
      // A confirmed recordId NOT in the generated set is ignored (it has no value
      // to write — skipped / failure / pending_not_generated rows are not confirmable).
      const generatedRows = (await readGeneratedRows(ledgerQuery, jobId)).filter((r) => confirmed.has(r.recordId))

      // BACKEND-owned chunking (BJ-10): ≤ the inline cap per chunk. The FE never loops.
      const chunkSize = resolveBulkInlineMaxRows()
      type JobCommitOutcome = 'committed' | 'stale_reprev' | 'write_conflict' | 'skipped_no_perm'
      const counts: Record<JobCommitOutcome, number> = { committed: 0, stale_reprev: 0, write_conflict: 0, skipped_no_perm: 0 }

      // Flip a COMMITTABLE job → running for the commit phase, GUARDED (clears
      // suspend_reason). False = a concurrent commit already claimed it (or it left
      // the committable set between the read above and here) → 409, no double-commit.
      if (!(await setHeaderRunning(ledgerQuery, jobId))) {
        return res.status(409).json({
          ok: false,
          error: { code: 'BULK_JOB_COMMIT_IN_PROGRESS', message: 'Another commit is already in progress for this job.' },
        })
      }

      for (let i = 0; i < generatedRows.length; i += chunkSize) {
        const chunk = generatedRows.slice(i, i + chunkSize)
        for (const row of chunk) {
          const written = await commitOneRecord({
            req,
            query,
            pool,
            patchContext,
            capabilities,
            sheetScope,
            access,
            sheetId,
            recordId: row.recordId,
            fieldId: header.fieldId,
            value: row.proposedValue ?? '',
            expectedVersion: row.previewVersion ?? 0,
          })
          // Map the B-2 vocabulary `written` → the job-rows terminal `committed`.
          const outcome: JobCommitOutcome = written === 'written' ? 'committed' : written
          counts[outcome] += 1
          await setRowCommitOutcome(ledgerQuery, jobId, row.recordId, outcome)
        }
      }

      // Durable aggregate on the header; the job resolves (terminal success — the
      // generate+review+commit cycle is complete, even if some rows stale-dropped).
      const aggregate = { confirmed: parsed.data.recordIds.length, attempted: generatedRows.length, counts }
      await setHeaderAggregate(ledgerQuery, jobId, aggregate, 'resolved')

      return res.json({ jobId, state: 'resolved', counts, attempted: generatedRows.length })
    } catch (err) {
      console.error('[multitable-ai] bulk-job commit failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to commit bulk job' } })
    }
  })

  /**
   * M4 / Lane B2 — NL→formula suggest (INTERNAL, not in OpenAPI). The user
   * describes a formula in natural language; the model proposes ONE candidate
   * expression which the client then validates through the EXISTING zero-cost
   * `POST /formula/dry-run` + Test flow (no auto-persist — the user accepts
   * manually). Design lock:
   * docs/development/multitable-ai-formula-assist-m4-design-20260611.md.
   *
   * RBAC (§1.4, 修正二): `canManageFields` — formula authoring is a SHEET-LEVEL
   * field operation, NOT record-level (so NOT requireRecordReadable/
   * canEditRecord). Posture matches A2: per-route guard, not in OpenAPI.
   *
   * Data minimization (§1.2): the prompt context is the sheet field list as
   * NAMES + TYPES ONLY — record values NEVER enter the prompt (no data[]). The
   * assembled prompt still passes the SAME A2 unsafe_input redactString gate
   * (secret-shaped field names / instruction → 422), and the attempt rides the
   * SHARED reserve-then-settle pipeline (sheet-scoped: record_id/field_id NULL,
   * action=suggest). Status mapping reuses A2 (blocked/rate_limited/
   * quota_exhausted/unsafe_input/provider_error).
   */
  router.post('/sheets/:sheetId/ai/suggest-formula', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    const schema = z.object({
      instruction: z.string().min(1).max(SUGGEST_FORMULA_MAX_INSTRUCTION_LENGTH),
    })
    const parsed = schema.safeParse(req.body)
    if (!sheetId || !parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: !sheetId ? 'sheetId is required' : parsed.error?.message } })
    }
    const instruction = parsed.data.instruction.trim()
    if (!instruction) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'instruction is required' } })
    }

    try {
      const pool = poolManager.get() as unknown as PoolLike
      const query = pool.query.bind(pool) as QueryFn

      // Field-authoring gate (sheet-scoped): resolveSheetCapabilities yields the
      // SAME canManageFields primitive the formula field write/dry-run paths use.
      const { access, capabilities } = await resolveSheetCapabilities(req, query, sheetId)
      if (!access.userId) {
        return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } })
      }
      if (!capabilities.canManageFields) {
        return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'You cannot manage fields on this sheet' } })
      }

      // Schema metadata only — NAMES + TYPES, no record `data[]` (§1.2). Same
      // {id,type}-style column-metadata posture as the dry-run engine.
      const fields = await loadFieldsForSheet(query as AiUsageQueryFn, sheetId)
      const prompt = buildFormulaSuggestPrompt(instruction, fields)

      await executeShortcut(
        req,
        res,
        { pool, sheetId, recordId: null, fieldId: null, action: 'suggest', userId: access.userId },
        prompt,
        // The reservation is already settled to 'succeeded' with actual usage;
        // suggest only ships the candidate (no write, no auto-persist — the
        // client runs it through the existing /formula/dry-run + Test flow).
        async (result) => {
          res.json({
            ok: true,
            data: {
              status: 'succeeded',
              action: 'suggest',
              candidate: result.text ?? '',
              usage: result.usage,
              estimatedCostUsd: result.estimatedCostUsd,
              provider: result.provider,
              model: result.model,
            },
          })
        },
      )
    } catch (err) {
      console.error('[multitable-ai] suggest-formula failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to suggest formula' } })
    }
  })

  return router
}

/** M4 §1.2: NL description length cap (mirrors the A2 instruction cap surface). */
export const SUGGEST_FORMULA_MAX_INSTRUCTION_LENGTH = 500

/**
 * Assemble the NL→formula suggest prompt from the sheet schema (M4 §1.2). The
 * context is the field list as NAME + TYPE ONLY — record values are NEVER
 * included (no `data[]`), so no per-record read happens on this path. The
 * `{fldId}`-reference convention is surfaced so the model proposes an
 * expression the existing dry-run engine can parse.
 */
export function buildFormulaSuggestPrompt(instruction: string, fields: { id: string; name: string; type: string }[]): string {
  const fieldLines = fields.map((field) => `- ${field.name} (id: ${field.id}, type: ${field.type})`).join('\n')
  return [
    'You are a formula assistant for a multidimensional table. Propose ONE formula expression that fulfils the user request.',
    'Reference fields by their id wrapped in braces, e.g. {fld_price}. Return ONLY the formula expression, no prose, no code fences.',
    '',
    'Available fields (name, id, type — no values are provided):',
    fieldLines || '- (no fields)',
    '',
    `User request: ${instruction}`,
  ].join('\n')
}

/** Per-record commit outcome (B-2 vocabulary; the job-commit phase maps `written`→`committed`). */
export type RecordCommitOutcome = 'written' | 'stale_reprev' | 'write_conflict' | 'skipped_no_perm'

/**
 * Commit ONE confirmed value through the AUTHORITATIVE write path — the shared
 * per-record write discipline used by BOTH `bulk-commit` (B-2, value from the
 * inline preview cache) and the B-4 job commit phase (value from job-rows). The
 * ONLY thing that differs between the two callers is the value + expectedVersion
 * SOURCE; the re-gate sequence (read → layer-3 field-perm → own-write) and the
 * patchRecords + outcome mapping are byte-identical (so a value the user did NOT
 * review is never written, and perms are re-checked at commit — criteria 3 + 6).
 *
 * Re-gate AT COMMIT (perms may have changed since the preview/generation):
 *  6a) record-read gate (read-denied / vanished → skipped_no_perm)
 *  6b) layer-3 field-permission on the target field (patchRecords does NOT run
 *      field_permissions on writes, #2106 F3 → this IS that enforcement point)
 *  6c) own-write scope (createdBy) — then patchRecords (which re-enforces
 *      lock/version in-transaction). The CACHED previewVersion rides in as
 *      expectedVersion → a shifted record drops as `stale_reprev`.
 */
async function commitOneRecord(args: {
  req: Request
  query: QueryFn
  pool: PoolLike
  patchContext: RecordPatchRouteContext
  capabilities: Awaited<ReturnType<typeof resolveSheetReadableCapabilities>>['capabilities']
  sheetScope: Awaited<ReturnType<typeof resolveSheetReadableCapabilities>>['sheetScope']
  access: Awaited<ReturnType<typeof resolveSheetReadableCapabilities>>['access']
  sheetId: string
  recordId: string
  fieldId: string
  value: string
  expectedVersion: number
}): Promise<RecordCommitOutcome> {
  const { req, query, pool, patchContext, capabilities, sheetScope, access, sheetId, recordId, fieldId, value, expectedVersion } = args

  // 6a) Row-level read gate.
  const readable = await requireRecordReadable(req, query, sheetId, recordId)
  if ('status' in readable) return 'skipped_no_perm'
  // 6b) Layer-3 field-permission on the target field.
  const targetPermission = patchContext.fieldPermissions[fieldId]
  if (!targetPermission || targetPermission.visible === false || targetPermission.readOnly === true) {
    return 'skipped_no_perm'
  }
  // 6c) Own-write scope (createdBy) + existence. The version used for the conflict
  //     check is the CACHED expectedVersion (anti-TOCTOU), NOT this freshly-read one.
  const current = await readRecordOnce(query, sheetId, recordId)
  if (!current) return 'skipped_no_perm'
  if (!ensureRecordWriteAllowed(capabilities, sheetScope, access, current.createdBy, 'edit')) {
    return 'skipped_no_perm'
  }

  // Land the EXACT value through RecordWriteService.patchRecords (NEVER raw SQL),
  // SAME post-commit Yjs invalidation wiring as POST /patch. ONE record per call.
  const recordWriteService = new RecordWriteService(pool, eventBus, createRecordWriteHelpers(req, pool))
  const invalidator = getYjsInvalidatorForRoutes()
  if (invalidator) {
    recordWriteService.setPostCommitHooks([createYjsInvalidationPostCommitHook(invalidator)])
  }

  try {
    await recordWriteService.patchRecords({
      sheetId,
      changesByRecord: new Map([[recordId, [{ fieldId, value, expectedVersion }]]]),
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
    return 'written'
  } catch (err) {
    // NO ledger writes here — the charge settled at generation time.
    if (err instanceof ServiceVersionConflictError) {
      // Record shifted since the value was generated — DROP it, never overwrite
      // against data the user did not review.
      return 'stale_reprev'
    }
    // Everything else patchRecords can throw at commit (a locked record, a
    // now-forbidden field, a vanished record, a validation failure, or any
    // unexpected error) is a per-row write conflict. Never all-or-nothing.
    if (
      err instanceof ServiceValidationError ||
      err instanceof ServiceFieldForbiddenError ||
      err instanceof ServiceNotFoundError
    ) {
      return 'write_conflict'
    }
    console.error('[multitable-ai] commit row write failed:', err)
    return 'write_conflict'
  }
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
