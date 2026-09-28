/**
 * 「复制数据表（含数据）」路由 —— S1（设计锁 ADR docs/development/multitable-copy-sheet-with-data-adr-20260926.md）。
 *
 *   POST /api/multitable/sheets/:sheetId/copy           body { name?, withData: boolean, permissionMode: 'inherit' }
 *   POST /api/multitable/sheets/:sheetId/copy/dry-run   同形，零写
 *
 * **仅会话认证**（CS-1）：不挂 `mst_` API-token 鉴权中间件、不挂 OAPI scope 门（多维表路由对这两者逐个 opt-in，
 * 这两条**不** opt-in；tests/unit/multitable-copy-sheet-routes.test.ts H8 以整文件文本钉住，
 * tests/unit/multitable-oapi-allowlist-guard-tripwire.test.ts 的 ROUTE_FILES 扫描因此看不到本文件）。
 * `rbacGuard('multitable','write')` 之后再做两侧门（§7.1）。
 *
 * GATE ORDER（每一步 fail-closed、每个拒绝 values-free）：
 *   1. `resolveSheetCapabilities(req, query, sheetId)` → `canRead` 403 → liveness 404（authority before existence，
 *      与全文件其它 sheet-addressed 路由同一对；tests/unit/multitable-sheet-liveness-closure-all-routes.guard.test.ts
 *      在语法树上证明）。
 *   2. 源侧门 `hasFullTableReadAccess`（§1.9 三轴）→ 403 `COPY_SOURCE_NOT_FULLY_READABLE`，**不回任何计数**（CS-5/CS-6）。
 *   3. 目标侧门：S1 目标 = 源 Base；`resolveCopyTargetWritable` = 平台管理员角色 ∨ `resolveBaseWritable`，含审批 /
 *      e-learning 投影拒绝（对管理员同样拒）→ 403 `FORBIDDEN`（CS-3 / §4.2，2026-09-28 修订；三处门共用这一个谓词）。
 *   4. 系统表拒绝作为源（门后才回）→ 422 `COPY_SOURCE_SYSTEM_SHEET`（CS-14 / §6）。
 *   5. dry-run：`planCopySheet`（零写）→ 200 summary；execute：`executeCopySheet`（§7.2 单事务，事务内 DB-fresh
 *      重跑 2/3 两门）→ 201。
 *   6. 提交后（execute）：chunked formula 重算（状态进 201 body，失败不 500）、缓存失效、至多一条 values-free
 *      `multitable.sheet.copied`、结构化日志 `[multitable.sheet.copy]`（重放走 `[multitable.sheet.copy.replayed]`）。
 *
 * 拒绝尝试（403 / 413 / 422）在事务外用 pool 写一行 `operation_audit_logs`（ok=false, errorCode）—— CS-17。
 * 响应里**永不**出现单元格值、表达式文本、驱动散文：每个 code 配一条固定 message，details 只含位置与计数。
 */

import { Router, type Request, type Response } from 'express'
import { z } from 'zod'

import { Logger } from '../core/logger'
import { poolManager } from '../integration/db/connection-pool'
import { eventBus } from '../integration/events/event-bus'
import { rbacGuard } from '../rbac/rbac'
import { deriveSheetAccessLevel, resolveCopyTargetWritable, resolveSheetCapabilities, type QueryFn } from '../multitable/permission-service'
import { SheetWriterBlockedError } from '../multitable/canonical-sheet-fence'
import { SheetNotLiveError } from '../multitable/sheet-liveness'
import { sendForbidden, sendSheetNotLive } from '../multitable/sheet-refusals'
import { loadFieldsForSheet, loadSheetRow } from '../multitable/loaders'
import {
  COPY_SHEET_ERROR_CODES,
  CopySheetError,
  assertSourceIsNotSystemSheet,
  executeCopySheet,
  planCopySheet,
  type CopySheetActor,
  type CopySheetDeps,
  type CopySheetRequest,
  type CopySheetResult,
} from '../multitable/copy-sheet-service'
import {
  FIELD_PERMISSION_HISTORY_KEYS,
  SHEET_PERMISSION_HISTORY_KEYS,
  VIEW_CONFIG_HISTORY_KEYS,
  VIEW_PERMISSION_HISTORY_KEYS,
  extractRelationAggregationLinkFieldId,
  fieldPermissionSnapshot,
  getDbNotReadyMessage,
  hasFullTableReadAccess,
  invalidateSheetCachesAfterCopy,
  permissionConfigEntityId,
  recalculateAllFormulaFieldsForActor,
  resolveTemplateTenantId,
  sendDisplayNameHygieneRefusal,
  sheetPermissionSnapshot,
  viewConfigSnapshot,
  viewPermissionSnapshot,
} from './univer-meta'

const logger = new Logger('MultitableCopySheet')

/** 提交后 formula 重算的分块大小 —— 与表达式变更的 bulk recompute 同值（univer-meta.ts）。 */
const FORMULA_RECOMPUTE_CHUNK_SIZE = 200

/** 每个 code 一条固定 message：永不拼接值。 */
const ERROR_MESSAGES: Record<string, string> = {
  [COPY_SHEET_ERROR_CODES.sourceNotFullyReadable]: 'You must be able to read every record and field of the source sheet to copy it.',
  [COPY_SHEET_ERROR_CODES.sourceSystemSheet]: 'System-managed sheets cannot be copied.',
  [COPY_SHEET_ERROR_CODES.sourceChanged]: 'The source sheet changed while it was being copied; retry.',
  [COPY_SHEET_ERROR_CODES.tooLarge]: 'The source sheet has more rows than a synchronous copy allows.',
  [COPY_SHEET_ERROR_CODES.tooManyFields]: 'The source sheet has more fields than a copy allows.',
  [COPY_SHEET_ERROR_CODES.rowValidationFailed]: 'A source row could not be copied; nothing was written.',
  [COPY_SHEET_ERROR_CODES.permissionParityFailed]: 'The copied permissions did not match the source; nothing was written.',
  [COPY_SHEET_ERROR_CODES.linkTargetNotLive]: 'A link field of the source sheet points at a sheet that is not available in this base.',
  [COPY_SHEET_ERROR_CODES.forbidden]: 'Insufficient permissions',
  COPY_UNMAPPED_FIELD_REF: 'A field configuration references a field that cannot be mapped into the copy.',
  COPY_SOURCE_RULE_UNBUILDABLE: 'A row-level read rule of the source sheet references a column the copy cannot build.',
  COPY_SOURCE_RULE_ON_RENUMBERED_FIELD: 'A row-level read rule references an auto-number column whose values would change in the copy.',
  COPY_UNSUPPORTED_FIELD_TYPE: 'The source sheet has a field type the copy does not support.',
  NOT_FOUND: 'Sheet not found',
  CONFLICT: 'Another operation on this sheet is in progress; retry shortly.',
  RECOVERY_IN_PROGRESS: 'Another recovery operation is in progress on this sheet; retry shortly.',
}

const bodySchema = z.object({
  name: z.string().max(255).optional(),
  withData: z.boolean(),
  permissionMode: z.literal('inherit'),
})

function fail(res: Response, status: number, code: string, details?: Record<string, unknown>): Response {
  // An absent sheet answers the shared liveness body (multitable/sheet-refusals.ts), never a local copy of it.
  if (status === 404 && code === 'NOT_FOUND') return sendSheetNotLive(res, 'absent')
  return res.status(status).json({
    ok: false,
    error: {
      code,
      message: ERROR_MESSAGES[code] ?? 'Request refused',
      ...(details && Object.keys(details).length > 0 ? { details } : {}),
    },
  })
}

function historyHelpers(): CopySheetDeps['history'] {
  return {
    permissionConfigEntityId,
    sheetPermissionSnapshot,
    fieldPermissionSnapshot,
    viewPermissionSnapshot,
    viewConfigSnapshot,
    sheetPermissionHistoryKeys: SHEET_PERMISSION_HISTORY_KEYS,
    fieldPermissionHistoryKeys: FIELD_PERMISSION_HISTORY_KEYS,
    viewPermissionHistoryKeys: VIEW_PERMISSION_HISTORY_KEYS,
    viewConfigHistoryKeys: VIEW_CONFIG_HISTORY_KEYS,
    deriveSheetAccessLevel: (codes) => deriveSheetAccessLevel(codes) ?? null,
  }
}

/** 201 body 的 data（账本重放的就是这个；`formulaRecompute` 提交后再加，不进账本）。 */
function buildSuccessBody(result: CopySheetResult): unknown {
  return {
    ok: true,
    data: {
      sheet: {
        id: result.sheetId,
        baseId: result.baseId,
        name: result.name,
        copiedFrom: {
          kind: result.summary.copiedFromKind,
          at: null as string | null,
          sheetId: result.summary.sourceSheetId,
        },
      },
      summary: result.summary,
      batchId: result.batchId,
    },
  }
}

/** CS-17：拒绝尝试在事务外用 pool 写一行审计（best-effort；失败只记一条 values-free 日志）。 */
async function auditRefusal(
  query: QueryFn,
  actorId: string,
  sourceSheetId: string,
  statusCode: number,
  errorCode: string,
  mode: 'copy' | 'dry-run',
): Promise<void> {
  try {
    await query(
      `INSERT INTO operation_audit_logs (actor_id, actor_type, action, resource_type, resource_id, metadata, meta)
       VALUES ($1, 'user', 'multitable.sheet.copy', 'meta_sheet', $2, $3::jsonb, $3::jsonb)`,
      [actorId, sourceSheetId, JSON.stringify({ sourceSheetId, ok: false, statusCode, errorCode, mode })],
    )
  } catch (err) {
    logger.warn('[multitable.sheet.copy] refusal audit write failed', { errorName: err instanceof Error ? err.name : 'unknown' })
  }
}

type GateOutcome =
  | { ok: true; baseId: string; actor: CopySheetActor; copierCanManageSourceFields: boolean }
  | { ok: false; status: number; code: string }

/**
 * 门 2-4（在 canRead + liveness 之后）：全表读门 → 目标 Base 可写 → 系统表。返回一个 outcome，由调用方发响应
 * 与审计（这里不碰 res，所以两条路由的**响应形状**一处定义）。
 */
async function gateCopySource(
  req: Request,
  query: QueryFn,
  sheetId: string,
  access: CopySheetActor['access'],
  capabilities: Parameters<typeof hasFullTableReadAccess>[4],
): Promise<GateOutcome> {
  if (!(await hasFullTableReadAccess(req, query, sheetId, access, capabilities))) {
    return { ok: false, status: 403, code: COPY_SHEET_ERROR_CODES.sourceNotFullyReadable }
  }
  const sheetRow = await loadSheetRow(query, sheetId)
  // Soft-deleted / gone between the liveness gate and here: the SAME values-free absent-sheet 404 the gate answers.
  if (!sheetRow) return { ok: false, status: 404, code: 'NOT_FOUND' }
  const baseId = sheetRow.baseId ?? ''
  // Target gate (CS-3 / §4.2): ONE shared predicate — platform admin ∨ resolveBaseWritable, projection bases refused
  // for everyone — identical to the in-transaction re-check and the /context probe (copy-sheet-service.ts, univer-meta.ts).
  if (!(await resolveCopyTargetWritable(access, query, baseId))) {
    return { ok: false, status: 403, code: COPY_SHEET_ERROR_CODES.forbidden }
  }
  try {
    await assertSourceIsNotSystemSheet(query, { id: sheetId, baseId })
  } catch (err) {
    if (err instanceof CopySheetError) return { ok: false, status: err.statusCode, code: err.code }
    throw err
  }
  return {
    ok: true,
    baseId,
    actor: { access, actorId: access.userId, tenantId: resolveTemplateTenantId(req) },
    copierCanManageSourceFields: capabilities.canManageFields === true,
  }
}

function copySheetDeps(): CopySheetDeps {
  return {
    eventBus,
    hasFullTableReadAccess: (query, sheetId, access, capabilities) => hasFullTableReadAccess(undefined, query, sheetId, access, capabilities),
    relationAggregationLinkFieldId: extractRelationAggregationLinkFieldId,
    history: historyHelpers(),
  }
}

function parseRequest(req: Request, res: Response): { sheetId: string; body: CopySheetRequest } | null {
  const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
  if (!sheetId) {
    res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId is required' } })
    return null
  }
  const parsed = bodySchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'withData (boolean) and permissionMode ("inherit") are required' } })
    return null
  }
  const name = typeof parsed.data.name === 'string' && parsed.data.name.trim() ? parsed.data.name.trim() : null
  if (name && sendDisplayNameHygieneRefusal(res, name)) return null
  return { sheetId, body: { sourceSheetId: sheetId, name, withData: parsed.data.withData, permissionMode: 'inherit' } }
}

/**
 * PG 锁类 SQLSTATE → 409（可重试，不是 500）：40P01 deadlock_detected（围栏先于行锁之后不该再出现 —— 出现即是
 * 新写者的锁序回归，仍按可重试回）、55P03 lock_not_available、40001 serialization_failure。只认 code，不看散文。
 */
const RETRYABLE_LOCK_SQLSTATES: ReadonlySet<string> = new Set(['40P01', '55P03', '40001'])

function mapError(res: Response, err: unknown): Response | null {
  if (err instanceof CopySheetError) return fail(res, err.statusCode, err.code, err.details)
  if (err instanceof SheetNotLiveError) return sendSheetNotLive(res, err.liveness)
  if (err instanceof SheetWriterBlockedError) return fail(res, 409, 'RECOVERY_IN_PROGRESS')
  const sqlState = (err as { code?: unknown } | null | undefined)?.code
  if (typeof sqlState === 'string' && RETRYABLE_LOCK_SQLSTATES.has(sqlState)) return fail(res, 409, 'CONFLICT')
  const hint = getDbNotReadyMessage(err)
  if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
  return null
}

export function createMultitableCopySheetRoutes(): Router {
  const router = Router()

  router.post('/sheets/:sheetId/copy/dry-run', rbacGuard('multitable', 'write'), async (req: Request, res: Response) => {
    const parsed = parseRequest(req, res)
    if (!parsed) return
    const { sheetId, body } = parsed
    const startedAt = Date.now()
    try {
      const pool = poolManager.get()
      const query = pool.query.bind(pool) as QueryFn
      const { access, capabilities, sheetLiveness } = await resolveSheetCapabilities(req, query, sheetId)
      if (!access.userId) return res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } })
      if (!capabilities.canRead) return sendForbidden(res)
      if (sheetLiveness !== 'live') return sendSheetNotLive(res, sheetLiveness)

      const gate = await gateCopySource(req, query, sheetId, access, capabilities)
      if (gate.ok === false) {
        await auditRefusal(query, access.userId, sheetId, gate.status, gate.code, 'dry-run')
        return fail(res, gate.status, gate.code)
      }
      // 超限的 with-data 预检回 200 + `summary.overLimit=true`（记录不读、结构披露照常；ADR §3「超限与否」/ FE-2）。
      const plan = await planCopySheet(query, body, gate.actor, copySheetDeps(), {
        copierCanManageSourceFields: gate.copierCanManageSourceFields,
        overLimit: 'report',
      })
      logger.info('[multitable.sheet.copy.dry-run]', {
        sourceSheetId: sheetId,
        targetBaseId: gate.baseId,
        userId: access.userId,
        ok: true,
        rowCount: plan.summary.rowCount,
        fieldCount: plan.summary.fieldCount,
        blankedFieldCount: plan.ctx.blankedFieldIds.size,
        permissionRowCount: plan.summary.permissionRowCount + plan.summary.fieldPermissionRowCount + plan.summary.viewPermissionRowCount,
        recordPermissionRowCount: plan.summary.recordPermissionRowCount,
        permissionMode: body.permissionMode,
        withData: body.withData,
        durationMs: Date.now() - startedAt,
      })
      return res.json({ ok: true, data: { summary: plan.summary } })
    } catch (err) {
      if (err instanceof CopySheetError) {
        const pool = poolManager.get()
        const actorId = typeof req.user?.id === 'string' ? req.user.id : ''
        if (actorId) await auditRefusal(pool.query.bind(pool) as QueryFn, actorId, sheetId, err.statusCode, err.code, 'dry-run')
      }
      const mapped = mapError(res, err)
      if (mapped) return mapped
      logger.error('[multitable.sheet.copy.dry-run] failed', err instanceof Error ? new Error(err.name) : undefined)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to analyse the copy' } })
    }
  })

  router.post('/sheets/:sheetId/copy', rbacGuard('multitable', 'write'), async (req: Request, res: Response) => {
    const parsed = parseRequest(req, res)
    if (!parsed) return
    const { sheetId, body } = parsed
    const startedAt = Date.now()
    try {
      const pool = poolManager.get()
      const query = pool.query.bind(pool) as QueryFn
      const { access, capabilities, sheetLiveness } = await resolveSheetCapabilities(req, query, sheetId)
      if (!access.userId) return res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } })
      if (!capabilities.canRead) return sendForbidden(res)
      if (sheetLiveness !== 'live') return sendSheetNotLive(res, sheetLiveness)

      // 事务外快速拒（§7.2 第 1 步）；事务内还会 DB-fresh 重跑同一对门。
      const gate = await gateCopySource(req, query, sheetId, access, capabilities)
      if (gate.ok === false) {
        await auditRefusal(query, access.userId, sheetId, gate.status, gate.code, 'copy')
        return fail(res, gate.status, gate.code)
      }

      const outcome = await executeCopySheet({
        pool: { transaction: (handler) => pool.transaction(({ query: txQuery }) => handler({ query: txQuery as unknown as QueryFn })) },
        request: body,
        actor: gate.actor,
        deps: copySheetDeps(),
        targetBaseId: gate.baseId,
        copierCanManageSourceFields: gate.copierCanManageSourceFields,
        buildBody: buildSuccessBody,
      })

      if (outcome.replayed) {
        // 重放**不写一行**：走独立 token，SOP 的 `[multitable.sheet.copy]` 计数不会把一次连点数成多次。
        logger.info('[multitable.sheet.copy.replayed]', {
          sourceSheetId: sheetId,
          targetSheetId: outcome.result.sheetId || null,
          targetBaseId: gate.baseId,
          userId: access.userId,
          ok: true,
          durationMs: Date.now() - startedAt,
        })
        res.set('Idempotent-Replayed', 'true')
        return res.status(201).json(outcome.body)
      }
      if (outcome.ledgerUnavailable) {
        logger.warn('Copy-sheet dedupe ledger unavailable; copied without dedupe', { sourceSheetId: sheetId, userId: access.userId })
      }

      const result = outcome.result
      // 提交后（§7.2 第 7 步）：缓存失效 → chunked formula 重算（复制者 actor 语境；失败不 500，状态进 body）。
      invalidateSheetCachesAfterCopy(result.sheetId)
      let formulaRecompute: { attempted: number; recomputed: number; failed: boolean; errorCode?: string } | null = null
      if (result.formulaFieldIds.length > 0 && result.newRecordIds.length > 0) {
        let recomputed = 0
        let failed = false
        try {
          // TX-5：字段读也在 try 里 —— 提交后的任何失败都不能把一次已提交的复制变成 500。
          const freshFields = await loadFieldsForSheet(query, result.sheetId)
          for (let i = 0; i < result.newRecordIds.length; i += FORMULA_RECOMPUTE_CHUNK_SIZE) {
            const chunk = result.newRecordIds.slice(i, i + FORMULA_RECOMPUTE_CHUNK_SIZE)
            // DATA-7：先按复制者的读权限水合 lookup / rollup，再算 formula（formula-over-lookup 才看得到真实值）。
            const results = await recalculateAllFormulaFieldsForActor(access.userId, query, result.sheetId, freshFields as never, chunk, { hydrateLookupRollupFor: access })
            recomputed += results.length
          }
        } catch (err) {
          logger.error('[multitable.sheet.copy] formula recompute failed mid-chunk', err instanceof Error ? new Error(err.name) : undefined)
          failed = true
        }
        formulaRecompute = {
          attempted: result.newRecordIds.length,
          recomputed,
          failed,
          ...(failed ? { errorCode: 'BULK_RECOMPUTE_FAILED' } : {}),
        }
      }

      // 至多一条 values-free 表级事件（CS-19）：不在 webhook-event-bridge 的映射里，不进 outbox。
      eventBus.emit('multitable.sheet.copied', {
        sourceSheetId: sheetId,
        targetSheetId: result.sheetId,
        targetBaseId: result.baseId,
        actorId: access.userId,
        rowCount: result.summary.rowCount,
        fieldCount: result.summary.builtFieldCount,
        permissionMode: body.permissionMode,
        withData: body.withData,
      })
      logger.info('[multitable.sheet.copy]', {
        sourceSheetId: sheetId,
        targetSheetId: result.sheetId,
        targetBaseId: result.baseId,
        userId: access.userId,
        ok: true,
        rowCount: result.summary.rowCount,
        fieldCount: result.summary.builtFieldCount,
        blankedFieldCount: result.summary.disclosures.filter((d) => d.code !== 'MIRROR_NOT_BUILT' && d.code !== 'DEPENDS_ON_BLANKED_COLUMN' && d.code !== 'BUTTON_DISABLED').length,
        permissionRowCount: result.summary.permissionRowCount + result.summary.fieldPermissionRowCount + result.summary.viewPermissionRowCount,
        recordPermissionRowCount: result.summary.recordPermissionRowCount,
        permissionMode: body.permissionMode,
        withData: body.withData,
        formulaRecomputeFailed: formulaRecompute?.failed ?? false,
        durationMs: Date.now() - startedAt,
      })

      const data = (outcome.body as { data: Record<string, unknown> }).data
      return res.status(201).json({ ok: true, data: { ...data, ...(formulaRecompute ? { formulaRecompute } : {}) } })
    } catch (err) {
      const statusCode = err instanceof CopySheetError ? err.statusCode : err instanceof SheetWriterBlockedError ? 409 : null
      const errorCode = err instanceof CopySheetError ? err.code : err instanceof SheetWriterBlockedError ? 'RECOVERY_IN_PROGRESS' : null
      if (statusCode && errorCode) {
        const pool = poolManager.get()
        const actorId = typeof req.user?.id === 'string' ? req.user.id : ''
        if (actorId) await auditRefusal(pool.query.bind(pool) as QueryFn, actorId, sheetId, statusCode, errorCode, 'copy')
        logger.info('[multitable.sheet.copy]', {
          sourceSheetId: sheetId,
          userId: actorId || null,
          ok: false,
          statusCode,
          errorCode,
          permissionMode: body.permissionMode,
          withData: body.withData,
          durationMs: Date.now() - startedAt,
        })
      }
      const mapped = mapError(res, err)
      if (mapped) return mapped
      logger.error('[multitable.sheet.copy] failed', err instanceof Error ? new Error(err.name) : undefined)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to copy the sheet' } })
    }
  })

  return router
}
