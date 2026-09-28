/**
 * 字段类型转换（带值迁移）第 3 刀 —— **执行**与**整列撤销**的事务半。
 * 设计锁：docs/development/multitable-field-retype-first-batch-adr-20260926.md §3（执行 1-10、撤销判定表）/ §4（往返保真 A）。
 *
 * 本模块只做「一个事务里发生的事」：调用方（routes/univer-meta.ts）先过五门、范围校验、确认串、信任门与凭证逐 claim
 * 校验，再开事务把事务内的 `query` 交进来。这里不碰 req / res、不读 env 以外的进程状态、不做提交后的缓存失效。
 *
 * ── 失败的两种形态 ─────────────────────────────────────────────────────────────────────────────────────
 *   - **拒绝**：函数返回 `{ ok: false, failure }`。所有判定都排在第一条写语句之前，所以拒绝时事务里只有锁与读，
 *     提交与回滚等价——「任一不过 ⇒ 零写入」靠的是这个次序，不是靠调用方记得回滚。
 *   - **异常**：任何 throw（栅栏被恢复占用、前镜像超上限、改写行数对不上、任何 SQL 错误）都原样向外抛，由
 *     `pool.transaction` 回滚整个事务。写到一半的状态不可能提交。
 *
 * ── values-free ────────────────────────────────────────────────────────────────────────────────────────
 * 返回值、拒绝的 message / details、审计行 metadata 只含 id 与计数。选项文本（= 单元格文本）与单元格值只进库内的三处：
 * 字段 property、前镜像信封、配置修订的 before / after——与 `PATCH /fields/:fieldId` 改 property 时落库的内容同级。
 */
import { randomUUID } from 'node:crypto'

import {
  acquireCanonicalSheetFence,
  assertNoActiveWriterBlock,
  isWriterFenceEnabled,
} from './canonical-sheet-fence'
import { recordConfigRevision } from './config-revision-recorder'
import {
  canonicalFieldRetypeConvertPlanInput,
  classifyFieldRetypeConvertCell,
  classifyFieldRetypeConvertPair,
  compareCodeUnits,
  FIELD_RETYPE_CONVERT_FIRST_BATCH,
  FIELD_RETYPE_CONVERT_NOT_SUPPORTED_CODE,
  planFieldRetypeConvert,
  type FieldRetypeConvertLiveCell,
  type FieldRetypeConvertScopeReason,
  type FieldRetypeConvertTargetType,
  type FieldRetypeConvertTrashCell,
} from './field-retype-convert'
import { resolveFieldRetypeConvertManagedSheetReason } from './field-retype-convert-preview'
import { mintOperation, sealOperation } from './operation-ledger'
import { recordRecordRevisionsBatch, type RecordRevisionInput } from './record-history-service'
import { resolveSheetRevertMaxRecords } from './restore-caps'
import {
  hashFieldRetypeConvertPlan,
  verifyFieldRetypeConvertPreviewIdentity,
  type FieldRetypeConvertPreviewIdentityRawClaims,
} from './restore-preview-identity'
import { captureRetypeConvertPreImageRows, RETYPE_CONVERT_TOMBSTONE_REASON } from './tombstone-capture'

export type FieldRetypeConvertQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

/** 撤销的确认串（ADR §3 撤销）。执行的确认串 `FIELD_RETYPE_CONVERT_CONFIRM` 在 field-retype-convert.ts。 */
export const FIELD_RETYPE_UNDO_CONFIRM = 'undo-field-type-convert'

/** 稳定拒绝码。 */
export const FIELD_RETYPE_CONFIRM_REQUIRED_CODE = 'CONFIRM_REQUIRED'
export const FIELD_RETYPE_PREVIEW_IDENTITY_INVALID_CODE = 'PREVIEW_IDENTITY_INVALID'
export const FIELD_RETYPE_PLAN_DRIFT_CODE = 'PLAN_DRIFT'
export const FIELD_RETYPE_ALREADY_UNDONE_CODE = 'ALREADY_UNDONE'
export const FIELD_RETYPE_PRE_IMAGE_EXPIRED_CODE = 'PRE_IMAGE_EXPIRED'
export const FIELD_RETYPE_UNDO_PRECONDITION_FAILED_CODE = 'UNDO_PRECONDITION_FAILED'
export const FIELD_RETYPE_SHEET_TOO_LARGE_CODE = 'SHEET_TOO_LARGE'
/** Tier-2 配置回滚对转换 / 撤销修订的拒绝（ADR §3.10）。 */
export const FIELD_RETYPE_RESTORE_NOT_SUPPORTED_CODE = 'RESTORE_NOT_SUPPORTED'
export const FIELD_RETYPE_RESTORE_NOT_SUPPORTED_REASON = 'field_retype_conversion'

/** 记录修订的 `source`：历史里能一眼分清「转换改的」与「用户改的」。 */
export const FIELD_RETYPE_CONVERT_REVISION_SOURCE = 'retype-convert'
export const FIELD_RETYPE_UNDO_REVISION_SOURCE = 'retype-convert-undo'

/** 审计行的 action（operation_audit_logs）。 */
export const FIELD_RETYPE_CONVERT_AUDIT_ACTION = 'multitable.field.retype-convert'
export const FIELD_RETYPE_UNDO_AUDIT_ACTION = 'multitable.field.retype-convert-undo'

export interface FieldRetypeConvertFailure {
  status: number
  code: string
  message: string
  details?: Record<string, unknown>
}

const MESSAGES = {
  fieldNotFound: 'Field not found',
  conversionNotFound: 'Conversion not found',
  identityInvalid: 'A valid server-minted preview identity is required; preview before converting.',
  planDrift: 'The sheet changed since the preview; preview again before converting.',
  notSupported:
    'This field type conversion is not supported here. The first batch converts a text field to single or multiple select, on a sheet that no plugin, system, pipeline or approval projection manages.',
  alreadyUndone: 'This conversion has already been undone.',
  preImageExpired:
    'The values captured before this conversion are no longer retained, so the column cannot be restored. Nothing was changed.',
  undoPrecondition:
    'The column or its records changed after the conversion, so the whole-column undo is refused. Nothing was changed.',
} as const

const tooLargeMessage = (total: number, cap: number): string =>
  `This sheet has ${total} records including its recycle bin, above the ${cap}-record ceiling for a field type conversion; a conversion of this size is refused.`

export function fieldRetypeConvertNotSupported(reason: FieldRetypeConvertScopeReason): FieldRetypeConvertFailure {
  return { status: 422, code: FIELD_RETYPE_CONVERT_NOT_SUPPORTED_CODE, message: MESSAGES.notSupported, details: { reason } }
}

export function fieldRetypeConvertTooLarge(total: number, cap: number): FieldRetypeConvertFailure {
  return { status: 413, code: FIELD_RETYPE_SHEET_TOO_LARGE_CODE, message: tooLargeMessage(total, cap) }
}

/**
 * 凭证不可用的统一回答（ADR §3.3：任一 claim 不符 ⇒ 401）。**不**说是哪一个 claim——那会把凭证变成探针。
 * 唯一的例外是过期：过期的凭证签名有效，`reason: 'expired'` 只告诉调用方「重新预览」，不泄露任何 claim。
 */
export function fieldRetypeConvertIdentityInvalid(reason?: string): FieldRetypeConvertFailure {
  return {
    status: 401,
    code: FIELD_RETYPE_PREVIEW_IDENTITY_INVALID_CODE,
    message: MESSAGES.identityInvalid,
    ...(reason === 'expired' ? { details: { reason: 'expired' } } : {}),
  }
}

// ── 凭证逐 claim 校验（ADR §3.3，事务外）────────────────────────────────────────────────────────────────

export type FieldRetypeConvertClaimMismatch =
  | 'mismatch_fieldId'
  | 'mismatch_sheetId'
  | 'mismatch_actorId'
  | 'mismatch_sourceType'
  | 'mismatch_targetType'

/**
 * 纯函数。`claims` 是 `readFieldRetypeConvertPreviewIdentity` 认证过签名 / 过期 / type 之后原样交出的 claim。
 * 逐条比对，任一不符即返回原因（调用方一律答 401，原因不出响应）：
 *   - `fieldId` 必须等于路径上的 `:fieldId` —— 拿 A 列的凭证不能改 B 列；
 *   - `sheetId` 必须等于该字段**当前**的 sheet_id —— 即五门判定所在的那张表；
 *   - `actorId` 必须等于请求者 —— 给甲签的凭证乙不能用；
 *   - `sourceType` 必须是首批源 `string`；`targetType` 必须是首批目标之一。
 * `planHash` 不在这里比：它要在事务里、栅栏之后重算。
 */
export function checkFieldRetypeConvertClaims(
  claims: FieldRetypeConvertPreviewIdentityRawClaims,
  expected: { fieldId: string; sheetId: string; actorId: string },
): FieldRetypeConvertClaimMismatch | null {
  if (claims.fieldId !== expected.fieldId) return 'mismatch_fieldId'
  if (claims.sheetId !== expected.sheetId) return 'mismatch_sheetId'
  if (claims.actorId !== expected.actorId) return 'mismatch_actorId'
  if (claims.sourceType !== 'string') return 'mismatch_sourceType'
  if (!(FIELD_RETYPE_CONVERT_FIRST_BATCH.string as readonly string[]).includes(claims.targetType)) return 'mismatch_targetType'
  return null
}

// ── 写入值（往返保真 A，ADR §4）─────────────────────────────────────────────────────────────────────────

/**
 * 一格转换后写什么。空（缺键 / null / `''`）⇒ 规范空值：单选 `''`、多选 `[]`；有值 ⇒ 单选写原文本、多选写 `[原文本]`
 * （长度 1，逗号顿号分号换行都是普通字符，不切分）。被 A 规则拒绝的格没有写入值——返回 `undefined`，调用方据此中止。
 */
export function resolveFieldRetypeConvertPostValue(
  targetType: FieldRetypeConvertTargetType,
  hasKey: boolean,
  value: unknown,
): string | string[] | undefined {
  const outcome = classifyFieldRetypeConvertCell(hasKey, value)
  if (outcome.kind === 'rejected') return undefined
  if (outcome.kind === 'empty') return targetType === 'select' ? '' : []
  return targetType === 'select' ? outcome.option : [outcome.option]
}

/** 这一格要不要碰：`data->F IS DISTINCT FROM post`。缺键恒为要碰（转换从不删键，只会补键）。 */
export function isFieldRetypeConvertCellTouched(hasKey: boolean, value: unknown, post: string | string[]): boolean {
  if (!hasKey) return true
  if (typeof post === 'string') return value !== post
  return true // 目标是数组（多选）：文本列里合法的原值只有字符串 / null，永远不等于数组
}

// ── 共用：读行、取栅栏、审计 ─────────────────────────────────────────────────────────────────────────────

interface LockedLiveRow {
  recordId: string
  version: number
  data: Record<string, unknown>
  hasKey: boolean
  value: unknown
}

function toBool(value: unknown): boolean {
  return value === true || value === 't' || value === 'true'
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return {}
}

function readCount(res: { rows: unknown[] }): number {
  const n = Number((res.rows[0] as { c?: unknown } | undefined)?.c ?? 0)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

/**
 * 栅栏。信任门（`isWriterFenceEnabled()`）是调用方在事务外答 409 的；这里**不**走 `fenceWriterEntry`——它在开关关着时
 * 首行就 return，事务会在没有栅栏的情况下照常改写整列。所以开关关着时直接抛：那是接线错误，不是可以答给用户的拒绝。
 * 取到栅栏之后才读写块状态（fence-before-check），恢复占着表时抛 `SheetWriterBlockedError`，调用方答 409。
 */
async function enterFence(query: FieldRetypeConvertQuery, sheetId: string): Promise<void> {
  if (!isWriterFenceEnabled()) {
    throw new Error('field retype convert reached its transaction without the canonical writer fence; refusing to run')
  }
  await acquireCanonicalSheetFence(query, sheetId)
  await assertNoActiveWriterBlock(query, sheetId)
}

/**
 * 行数只数不读，先于任何行锁：超上限的表不该先被整表 `FOR UPDATE` 再被拒。事务里**不**对缺表做 try/catch
 * （42P01 会让事务进入 aborted 状态）；回收站表早于本功能的迁移，缺表即部署错误，照常抛。
 */
async function countScanRows(query: FieldRetypeConvertQuery, sheetId: string): Promise<{ live: number; trash: number }> {
  const live = readCount(await query('SELECT count(*)::int AS c FROM meta_records WHERE sheet_id = $1', [sheetId]))
  const trash = readCount(await query('SELECT count(*)::int AS c FROM meta_records_trash WHERE sheet_id = $1', [sheetId]))
  return { live, trash }
}

/**
 * 范围内 live 行 `FOR UPDATE`。`has_key` / `cell` 两个表达式与预览的读法逐字相同（field-retype-convert-preview.ts），
 * 所以同一行在预览与执行里得到同一个单元格哈希；另取整行 `data`，写后快照要用。无 `ORDER BY`：次序由码元比较器在内存里定。
 */
async function lockLiveRows(query: FieldRetypeConvertQuery, sheetId: string, fieldId: string): Promise<LockedLiveRow[]> {
  const res = await query(
    'SELECT id, version, data, (data ? $2::text) AS has_key, data -> $2::text AS cell FROM meta_records WHERE sheet_id = $1 FOR UPDATE',
    [sheetId, fieldId],
  )
  return (res.rows as Array<{ id?: unknown; version?: unknown; data?: unknown; has_key?: unknown; cell?: unknown }>).map((row) => ({
    recordId: String(row.id),
    version: Number(row.version ?? 0),
    data: asObject(row.data),
    hasKey: toBool(row.has_key),
    value: row.cell === undefined ? null : row.cell,
  }))
}

async function writeAuditRow(
  query: FieldRetypeConvertQuery,
  action: string,
  actorId: string | null,
  fieldId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await query(
    `INSERT INTO operation_audit_logs (actor_id, actor_type, action, resource_type, resource_id, metadata, meta)
     VALUES ($1, 'user', $2, 'meta_field', $3, $4::jsonb, $4::jsonb)`,
    [actorId, action, fieldId, JSON.stringify(metadata)],
  )
}

// ── 执行 ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface ExecuteFieldRetypeConvertInput {
  /** 五门判定所在的表 = 事务外读到的字段 sheet_id。 */
  sheetId: string
  fieldId: string
  /** 请求者（凭证 actorId claim 的比对对象）。 */
  actorId: string
  /** 写进历史 / 审计的 actor（路由的 `getRequestActorId`）。 */
  historyActorId: string | null
  previewToken: string
  /** 从**认证过**的凭证里读出、并已过首批校验的目标类型。 */
  targetType: FieldRetypeConvertTargetType
  /** 路由的 `mapFieldType` / `normalizeJson`：与预览用同一份实现，planHash 才可比。 */
  mapFieldType: (rawStoredType: string) => string
  normalizeProperty: (rawStoredProperty: unknown) => Record<string, unknown>
  env?: NodeJS.ProcessEnv
}

export interface ExecuteFieldRetypeConvertResult {
  convertRevisionId: string
  sheetId: string
  fieldId: string
  sourceType: 'string'
  targetType: FieldRetypeConvertTargetType
  /** 前镜像行数 = 转换时的 live 行数。 */
  recordCount: number
  cells: { rewritten: number; unchanged: number }
  options: { final: number; droppedValidationRuleCount: number }
  /** 被改写的 recordId（提交后的协同失效用；不进响应）。 */
  touchedRecordIds: string[]
}

export type ExecuteFieldRetypeConvertOutcome =
  | { ok: true; result: ExecuteFieldRetypeConvertResult }
  | { ok: false; failure: FieldRetypeConvertFailure }

/**
 * 一次转换，一个事务。次序锁定（ADR §3.4-3.7）：
 *   栅栏 → 字段行 FOR UPDATE → 范围复核 → 规模 → live 行与本表回收站行 FOR UPDATE → **重算 planHash** 并整体校验凭证
 *   → 预铸 convertRevisionId、mintOperation → **写前镜像（每条 live 行）** → 改字段 → 一条批量改写 → 每个被碰行一条
 *   记录修订 → 配置修订 → 作业行 → 审计行 → sealOperation。
 */
export async function executeFieldRetypeConvert(
  query: FieldRetypeConvertQuery,
  input: ExecuteFieldRetypeConvertInput,
): Promise<ExecuteFieldRetypeConvertOutcome> {
  const { sheetId, fieldId, targetType } = input
  const env = input.env ?? process.env

  await enterFence(query, sheetId)

  const fieldRes = await query(
    'SELECT id, sheet_id, name, type, property, "order" FROM meta_fields WHERE id = $1 FOR UPDATE',
    [fieldId],
  )
  const fieldRow = (fieldRes.rows as Array<{ sheet_id?: unknown; type?: unknown; property?: unknown }>)[0]
  if (!fieldRow) return { ok: false, failure: { status: 404, code: 'NOT_FOUND', message: MESSAGES.fieldNotFound } }
  // 凭证的 sheetId claim 要等于字段**当前**的表；五门也是在 input.sheetId 上判的。锁下读到的若不是同一张表，两者都作废。
  if (String(fieldRow.sheet_id ?? '') !== sheetId) return { ok: false, failure: fieldRetypeConvertIdentityInvalid() }

  // 范围复核（锁下）：预览之后字段可能被 PATCH 改了类型，表可能被插件登记。
  const rawType = fieldRow.type
  const pairRefusal = classifyFieldRetypeConvertPair(rawType, input.mapFieldType(String(rawType ?? '')), targetType)
  if (pairRefusal) return { ok: false, failure: fieldRetypeConvertNotSupported(pairRefusal) }
  const managedReason = await resolveFieldRetypeConvertManagedSheetReason(query, sheetId)
  if (managedReason) return { ok: false, failure: fieldRetypeConvertNotSupported(managedReason) }

  const cap = resolveSheetRevertMaxRecords(env)
  const counted = await countScanRows(query, sheetId)
  if (counted.live + counted.trash > cap) return { ok: false, failure: fieldRetypeConvertTooLarge(counted.live + counted.trash, cap) }

  const liveRows = await lockLiveRows(query, sheetId, fieldId)
  const trashRes = await query(
    'SELECT record_id, (data ? $2::text) AS has_key, data -> $2::text AS cell FROM meta_records_trash WHERE sheet_id = $1 FOR UPDATE',
    [sheetId, fieldId],
  )
  const trash: FieldRetypeConvertTrashCell[] = (trashRes.rows as Array<{ record_id?: unknown; has_key?: unknown; cell?: unknown }>).map((row) => ({
    recordId: String(row.record_id),
    hasKey: toBool(row.has_key),
    value: row.cell === undefined ? null : row.cell,
  }))
  if (liveRows.length + trash.length > cap) return { ok: false, failure: fieldRetypeConvertTooLarge(liveRows.length + trash.length, cap) }

  // 重算计划与 planHash（栅栏与行锁之下），再把凭证整体校验一遍：claims 与事务外那次相同，planHash 是新的。
  const sourceProperty = input.normalizeProperty(fieldRow.property)
  const live: FieldRetypeConvertLiveCell[] = liveRows.map((row) => ({ recordId: row.recordId, version: row.version, hasKey: row.hasKey, value: row.value }))
  const plan = planFieldRetypeConvert({ sourceProperty, targetType, live, trash })
  const planHash = hashFieldRetypeConvertPlan(
    canonicalFieldRetypeConvertPlanInput({ sheetId, fieldId, sourceType: 'string', sourceProperty, plan }),
  )
  const verdict = verifyFieldRetypeConvertPreviewIdentity(input.previewToken, {
    sheetId,
    fieldId,
    actorId: input.actorId,
    sourceType: 'string',
    targetType,
    planHash,
  })
  if (!verdict.valid) {
    if (verdict.reason === 'plan_drift') return { ok: false, failure: { status: 409, code: FIELD_RETYPE_PLAN_DRIFT_CODE, message: MESSAGES.planDrift } }
    return { ok: false, failure: fieldRetypeConvertIdentityInvalid(verdict.reason) }
  }
  // 凭证只为 verdict=ok 的计划签发。哈希相同即输入相同，这里不该到得了；到了就按漂移拒，绝不执行一份被拒的计划。
  if (plan.verdict !== 'ok') return { ok: false, failure: { status: 409, code: FIELD_RETYPE_PLAN_DRIFT_CODE, message: MESSAGES.planDrift } }

  // ── 以下开始写 ──────────────────────────────────────────────────────────────────────────────────────
  const convertRevisionId = randomUUID()
  const operation = await mintOperation(query, sheetId)

  const rowById = new Map(liveRows.map((row) => [row.recordId, row]))
  const preImages = plan.sortedLive.map((cell) => {
    const post = resolveFieldRetypeConvertPostValue(targetType, cell.hasKey, cell.value)
    if (post === undefined) throw new Error('field retype convert met a cell with no target value under an accepted plan; aborting')
    return { recordId: cell.recordId, hasKey: cell.hasKey, value: cell.value, post }
  })
  const touched = preImages.filter((row) => isFieldRetypeConvertCellTouched(row.hasKey, row.value, row.post))

  // 前镜像先于任何改写，无条件（不看 capture 开关）；超上限抛 422，失败即整体回滚。
  await captureRetypeConvertPreImageRows(query, preImages, { sheetId, fieldId, configRevisionId: convertRevisionId }, env)

  const fieldUpdate = await query(
    'UPDATE meta_fields SET type = $2, property = $3::jsonb, updated_at = now() WHERE id = $1 AND sheet_id = $4 RETURNING id',
    [fieldId, targetType, JSON.stringify(plan.targetProperty), sheetId],
  )
  if (fieldUpdate.rows.length !== 1) throw new Error('field retype convert could not update the field row it holds locked; aborting')

  if (touched.length > 0) {
    const payload = touched.map((row) => ({ record_id: row.recordId, post: row.post }))
    // lock-exempt: field retype convert — schema op rewriting the converted field's key sheet-wide under canManageFields + the full-table-read gate (mirrors the 4c-1 lossy retype cell rewrite); not a per-record user edit.
    // revision-emitted: one record revision per rewritten row at its new version — recordRecordRevisionsBatch below, same txn.
    const rewritten = await query(
      `UPDATE meta_records AS m
       SET data = jsonb_set(m.data, ARRAY[$2::text], item.post, true),
           version = m.version + 1,
           updated_at = now()
       FROM jsonb_to_recordset($3::jsonb) AS item(record_id text, post jsonb)
       WHERE m.sheet_id = $1 AND m.id = item.record_id
         AND (m.data -> $2::text) IS DISTINCT FROM item.post
       RETURNING m.id, m.version, m.data`,
      [sheetId, fieldId, JSON.stringify(payload)],
    )
    const rewrittenRows = rewritten.rows as Array<{ id?: unknown; version?: unknown; data?: unknown }>
    // 行是锁着的、计划是锁下重算的，短写就是不变量被破坏，不是竞态。
    if (rewrittenRows.length !== touched.length) {
      throw new Error(`field retype convert rewrote ${rewrittenRows.length} of ${touched.length} cells; aborting`)
    }
    const postById = new Map(touched.map((row) => [row.recordId, row.post]))
    const revisions: RecordRevisionInput[] = rewrittenRows.map((row) => {
      const recordId = String(row.id)
      if (!postById.has(recordId) || !rowById.has(recordId)) throw new Error('field retype convert lost track of a rewritten record; aborting')
      return {
        sheetId,
        recordId,
        version: Number(row.version) || 0,
        action: 'update',
        source: FIELD_RETYPE_CONVERT_REVISION_SOURCE,
        actorId: input.historyActorId,
        changedFieldIds: [fieldId],
        patch: { [fieldId]: postById.get(recordId) },
        snapshot: asObject(row.data),
        batchId: convertRevisionId,
        ledger: operation,
      }
    })
    await recordRecordRevisionsBatch(query, revisions)
  }

  await recordConfigRevision(query, {
    id: convertRevisionId,
    batchId: convertRevisionId,
    sheetId,
    entityType: 'field',
    entityId: fieldId,
    action: 'update',
    before: { type: rawType, property: fieldRow.property ?? null },
    after: { type: targetType, property: plan.targetProperty },
    changedKeys: ['type', 'property'],
    actorId: input.historyActorId,
    source: 'mutation',
  })

  // 作业行：源端存**库里原样**的 type / property（撤销按它原样写回），目标端存刚写进去的那一份（撤销 ① 按它比对）。
  await query(
    `INSERT INTO meta_field_retype_conversions
       (convert_revision_id, sheet_id, field_id, source_type, source_property, target_type, target_property, record_count, actor_id)
     VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8::int, $9)`,
    [
      convertRevisionId,
      sheetId,
      fieldId,
      String(rawType ?? ''),
      JSON.stringify(fieldRow.property ?? null),
      targetType,
      JSON.stringify(plan.targetProperty),
      preImages.length,
      input.historyActorId,
    ],
  )

  await writeAuditRow(query, FIELD_RETYPE_CONVERT_AUDIT_ACTION, input.historyActorId, fieldId, {
    sheetId,
    fieldId,
    convertRevisionId,
    sourceType: 'string',
    targetType,
    recordCount: preImages.length,
    rewrittenRecordCount: touched.length,
    optionCount: plan.optionValues.length,
    droppedValidationRuleCount: plan.droppedValidationRuleCount,
  })

  await sealOperation(query, operation)

  return {
    ok: true,
    result: {
      convertRevisionId,
      sheetId,
      fieldId,
      sourceType: 'string',
      targetType,
      recordCount: preImages.length,
      cells: { rewritten: touched.length, unchanged: preImages.length - touched.length },
      options: { final: plan.optionValues.length, droppedValidationRuleCount: plan.droppedValidationRuleCount },
      touchedRecordIds: touched.map((row) => row.recordId),
    },
  }
}

// ── 整列撤销 ─────────────────────────────────────────────────────────────────────────────────────────────

export type FieldRetypeUndoPreconditionReason =
  | 'field_config_changed'
  | 'record_set_changed'
  | 'trashed_rows_with_post_state'
  | 'cells_changed'

export interface UndoFieldRetypeConvertInput {
  /** 门 ③④ 判定的表 = 事务外读到的字段 sheet_id。作业行必须绑在这张表与 `fieldId` 上。 */
  sheetId: string
  fieldId: string
  convertRevisionId: string
  historyActorId: string | null
  env?: NodeJS.ProcessEnv
}

export interface UndoFieldRetypeConvertResult {
  convertRevisionId: string
  undoRevisionId: string
  sheetId: string
  fieldId: string
  restoredType: string
  recordCount: number
  cells: { restored: number; unchanged: number }
  touchedRecordIds: string[]
}

export type UndoFieldRetypeConvertOutcome =
  | { ok: true; result: UndoFieldRetypeConvertResult }
  | { ok: false; failure: FieldRetypeConvertFailure }

function sortedIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort(compareCodeUnits)
}

function undoPrecondition(reason: FieldRetypeUndoPreconditionReason, extra: Record<string, unknown> = {}): FieldRetypeConvertFailure {
  return {
    status: 409,
    code: FIELD_RETYPE_UNDO_PRECONDITION_FAILED_CODE,
    message: MESSAGES.undoPrecondition,
    details: { reason, ...extra },
  }
}

/**
 * 整列撤销，一个事务。**判定顺序锁定，任一不过 ⇒ 零写入**（ADR §3 撤销判定表）：
 *   0  栅栏 → 作业行 `FOR UPDATE`（绑 convertRevisionId + fieldId + sheetId），无行 ⇒ 404（与不存在同码）
 *   1  已撤销 ⇒ 409 ALREADY_UNDONE
 *   2  前镜像 `FOR UPDATE`，行数 < record_count ⇒ 409 PRE_IMAGE_EXPIRED（先于 ①②③：整组被清后 ② 会把每条记录都报成「新增」）
 *   ①  字段行 `FOR UPDATE`，当前 {type, property} 与作业行目标端 jsonb 相等
 *   ②  live 行 `FOR UPDATE`，记录 id 集合 == 前镜像的 record_id 集合
 *   ②b 本表回收站行 `FOR UPDATE`，无行带「非字符串后态」
 *   ③  每行 `data->F` jsonb 等于信封 `post`（不比 version）
 * 通过后：写回 type / property → 按信封 `k` / `v` 四态精确回写（只碰原值 ≠ 后态的行）→ 每个被碰行一条记录修订 →
 * 配置修订（source='restore'，回指转换修订）→ 作业行 undone_at / undo_revision_id → 审计行 → sealOperation。
 * 没有强制覆盖、没有部分撤销、没有撤销的撤销。
 */
export async function undoFieldRetypeConvert(
  query: FieldRetypeConvertQuery,
  input: UndoFieldRetypeConvertInput,
): Promise<UndoFieldRetypeConvertOutcome> {
  const { sheetId, fieldId, convertRevisionId } = input
  const env = input.env ?? process.env

  await enterFence(query, sheetId)

  // 表级的两条先行（都不读任何记录、不取行锁），判定表 0-③ 随后连续执行：
  //   托管表并集（栅栏下复核）——转换之后表被插件登记 / 成了管线 staging 表，撤销同样不碰它；
  //   规模——超上限的表不该先被整表 FOR UPDATE 再被拒。
  const managedReason = await resolveFieldRetypeConvertManagedSheetReason(query, sheetId)
  if (managedReason) return { ok: false, failure: fieldRetypeConvertNotSupported(managedReason) }
  const cap = resolveSheetRevertMaxRecords(env)
  const counted = await countScanRows(query, sheetId)
  if (counted.live + counted.trash > cap) return { ok: false, failure: fieldRetypeConvertTooLarge(counted.live + counted.trash, cap) }

  // 0 —— 作业行。三个条件都在 WHERE 里：拿 B 表 / B 列的 id 来，读到的就是「没有」。
  const jobRes = await query(
    `SELECT convert_revision_id, source_type, source_property, target_type, target_property, record_count, undone_at
       FROM meta_field_retype_conversions
      WHERE convert_revision_id = $1::uuid AND field_id = $2 AND sheet_id = $3
      FOR UPDATE`,
    [convertRevisionId, fieldId, sheetId],
  )
  const job = (jobRes.rows as Array<{
    source_type?: unknown
    source_property?: unknown
    target_type?: unknown
    target_property?: unknown
    record_count?: unknown
    undone_at?: unknown
  }>)[0]
  if (!job) return { ok: false, failure: { status: 404, code: 'NOT_FOUND', message: MESSAGES.conversionNotFound } }

  // 1
  if (job.undone_at !== null && job.undone_at !== undefined) {
    return { ok: false, failure: { status: 409, code: FIELD_RETYPE_ALREADY_UNDONE_CODE, message: MESSAGES.alreadyUndone } }
  }

  // 2 —— 前镜像。FOR UPDATE 挡住保留期清理对这一组的 DELETE，直到本事务结束。
  const recordCount = Number(job.record_count ?? 0)
  const preRes = await query(
    `SELECT record_id, value
       FROM meta_field_value_tombstones
      WHERE config_revision_id = $1::uuid AND reason = '${RETYPE_CONVERT_TOMBSTONE_REASON}' AND field_id = $2 AND sheet_id = $3
      FOR UPDATE`,
    [convertRevisionId, fieldId, sheetId],
  )
  const preImages = (preRes.rows as Array<{ record_id?: unknown; value?: unknown }>).map((row) => {
    const envelope = asObject(row.value)
    return { recordId: String(row.record_id), hasKey: envelope.k === true, value: envelope.v ?? null, post: envelope.post ?? null }
  })
  if (preImages.length < recordCount) {
    return { ok: false, failure: { status: 409, code: FIELD_RETYPE_PRE_IMAGE_EXPIRED_CODE, message: MESSAGES.preImageExpired } }
  }
  if (preImages.length > recordCount) {
    throw new Error('field retype undo found more pre-image rows than the conversion recorded; refusing to restore from them')
  }

  // ① —— 字段行。相等由 PG 判（jsonb `=`：键序无关，选项序列与颜色都在内）。
  const fieldRes = await query(
    `SELECT id, sheet_id, type, property, (type = $2 AND property = $3::jsonb) AS matches_target
       FROM meta_fields WHERE id = $1 FOR UPDATE`,
    [fieldId, String(job.target_type ?? ''), JSON.stringify(job.target_property ?? null)],
  )
  const fieldRow = (fieldRes.rows as Array<{ sheet_id?: unknown; type?: unknown; property?: unknown; matches_target?: unknown }>)[0]
  if (!fieldRow) return { ok: false, failure: { status: 404, code: 'NOT_FOUND', message: MESSAGES.fieldNotFound } }
  if (String(fieldRow.sheet_id ?? '') !== sheetId || !toBool(fieldRow.matches_target)) {
    return { ok: false, failure: undoPrecondition('field_config_changed') }
  }

  // ② —— 记录集合。
  const liveRows = await lockLiveRows(query, sheetId, fieldId)
  const preIds = new Set(preImages.map((row) => row.recordId))
  const liveIds = new Set(liveRows.map((row) => row.recordId))
  const removed = sortedIds([...preIds].filter((id) => !liveIds.has(id)))
  const added = sortedIds([...liveIds].filter((id) => !preIds.has(id)))
  if (removed.length > 0 || added.length > 0) {
    return {
      ok: false,
      failure: undoPrecondition('record_set_changed', {
        recordCount: removed.length + added.length,
        recordIds: sortedIds([...removed, ...added]),
        removed: { recordCount: removed.length, recordIds: removed },
        added: { recordCount: added.length, recordIds: added },
      }),
    }
  }

  // ②b —— 本表回收站。放行：缺键 / null / '' / [] 与字符串；其余（多选目标下的 ["X"] 等）整次拒绝。
  const trashRes = await query(
    `SELECT record_id,
            (data ? $2::text
              AND jsonb_typeof(data -> $2::text) NOT IN ('string', 'null')
              AND (data -> $2::text) <> '[]'::jsonb) AS blocking
       FROM meta_records_trash WHERE sheet_id = $1 FOR UPDATE`,
    [sheetId, fieldId],
  )
  const trashedBlocking = sortedIds(
    (trashRes.rows as Array<{ record_id?: unknown; blocking?: unknown }>).filter((row) => toBool(row.blocking)).map((row) => String(row.record_id)),
  )
  if (trashedBlocking.length > 0) {
    return { ok: false, failure: undoPrecondition('trashed_rows_with_post_state', { recordCount: trashedBlocking.length, recordIds: trashedBlocking }) }
  }

  // ③ —— 每格仍是转换写进去的值。由 PG 判（jsonb 语义），行已锁。
  const editedRes = await query(
    `SELECT m.id
       FROM meta_records m
       JOIN meta_field_value_tombstones t ON t.record_id = m.id
      WHERE m.sheet_id = $1
        AND t.config_revision_id = $2::uuid AND t.reason = '${RETYPE_CONVERT_TOMBSTONE_REASON}' AND t.field_id = $3 AND t.sheet_id = $1
        AND (m.data -> $3::text) IS DISTINCT FROM (t.value -> 'post')`,
    [sheetId, convertRevisionId, fieldId],
  )
  const edited = sortedIds((editedRes.rows as Array<{ id?: unknown }>).map((row) => String(row.id)))
  if (edited.length > 0) {
    return { ok: false, failure: undoPrecondition('cells_changed', { recordCount: edited.length, recordIds: edited }) }
  }

  // ── 以下开始写 ──────────────────────────────────────────────────────────────────────────────────────
  const undoRevisionId = randomUUID()
  const operation = await mintOperation(query, sheetId)

  const fieldUpdate = await query(
    'UPDATE meta_fields SET type = $2, property = $3::jsonb, updated_at = now() WHERE id = $1 AND sheet_id = $4 RETURNING id',
    [fieldId, String(job.source_type ?? ''), JSON.stringify(job.source_property ?? null), sheetId],
  )
  if (fieldUpdate.rows.length !== 1) throw new Error('field retype undo could not update the field row it holds locked; aborting')

  // 只碰「原值 ≠ 后态」的行——正是转换碰过的那些（③ 已证当前值 == 后态）。
  const expectedTouched = preImages.filter((row) => !(row.hasKey && typeof row.value === 'string' && row.value === row.post))
  let touchedRecordIds: string[] = []
  if (expectedTouched.length > 0) {
    // lock-exempt: field retype undo — schema op restoring the converted field's key sheet-wide from its pre-image under canManageFields + the full-table-read gate; not a per-record user edit.
    // revision-emitted: one record revision per restored row at its new version — recordRecordRevisionsBatch below, same txn.
    const restored = await query(
      `UPDATE meta_records AS m
       SET data = CASE
                    WHEN (t.value -> 'k') = 'true'::jsonb
                      THEN jsonb_set(m.data, ARRAY[$3::text], t.value -> 'v', true)
                    ELSE m.data - $3::text
                  END,
           version = m.version + 1,
           updated_at = now()
       FROM meta_field_value_tombstones t
       WHERE m.sheet_id = $1 AND t.record_id = m.id
         AND t.config_revision_id = $2::uuid AND t.reason = '${RETYPE_CONVERT_TOMBSTONE_REASON}' AND t.field_id = $3 AND t.sheet_id = $1
         AND NOT ((t.value -> 'k') = 'true'::jsonb AND (t.value -> 'v') = (t.value -> 'post'))
       RETURNING m.id, m.version, m.data, ((t.value -> 'k') = 'true'::jsonb) AS had_key, t.value -> 'v' AS original`,
      [sheetId, convertRevisionId, fieldId],
    )
    const restoredRows = restored.rows as Array<{ id?: unknown; version?: unknown; data?: unknown; had_key?: unknown; original?: unknown }>
    if (restoredRows.length !== expectedTouched.length) {
      throw new Error(`field retype undo restored ${restoredRows.length} of ${expectedTouched.length} cells; aborting`)
    }
    const expectedIds = new Set(expectedTouched.map((row) => row.recordId))
    const revisions: RecordRevisionInput[] = restoredRows.map((row) => {
      const recordId = String(row.id)
      if (!expectedIds.has(recordId)) throw new Error('field retype undo lost track of a restored record; aborting')
      // 删键 ⇒ patch 里用 null 哨兵，快照里没有这个键；写回 JSON null ⇒ patch 同样是 null，但快照里键在、值为 null。
      return {
        sheetId,
        recordId,
        version: Number(row.version) || 0,
        action: 'update',
        source: FIELD_RETYPE_UNDO_REVISION_SOURCE,
        actorId: input.historyActorId,
        changedFieldIds: [fieldId],
        patch: { [fieldId]: toBool(row.had_key) ? (row.original ?? null) : null },
        snapshot: asObject(row.data),
        batchId: undoRevisionId,
        ledger: operation,
      }
    })
    await recordRecordRevisionsBatch(query, revisions)
    touchedRecordIds = restoredRows.map((row) => String(row.id))
  }

  await recordConfigRevision(query, {
    id: undoRevisionId,
    batchId: undoRevisionId,
    sheetId,
    entityType: 'field',
    entityId: fieldId,
    action: 'update',
    before: { type: job.target_type, property: job.target_property ?? null },
    after: { type: job.source_type, property: job.source_property ?? null },
    changedKeys: ['type', 'property'],
    actorId: input.historyActorId,
    source: 'restore',
    restoredFromId: convertRevisionId,
  })

  const jobUpdate = await query(
    `UPDATE meta_field_retype_conversions
        SET undone_at = now(), undo_revision_id = $2::uuid
      WHERE convert_revision_id = $1::uuid AND undone_at IS NULL
      RETURNING convert_revision_id`,
    [convertRevisionId, undoRevisionId],
  )
  if (jobUpdate.rows.length !== 1) throw new Error('field retype undo could not mark the conversion it holds locked; aborting')

  await writeAuditRow(query, FIELD_RETYPE_UNDO_AUDIT_ACTION, input.historyActorId, fieldId, {
    sheetId,
    fieldId,
    convertRevisionId,
    undoRevisionId,
    restoredType: String(job.source_type ?? ''),
    recordCount,
    restoredRecordCount: expectedTouched.length,
  })

  await sealOperation(query, operation)

  return {
    ok: true,
    result: {
      convertRevisionId,
      undoRevisionId,
      sheetId,
      fieldId,
      restoredType: String(job.source_type ?? ''),
      recordCount,
      cells: { restored: expectedTouched.length, unchanged: recordCount - expectedTouched.length },
      touchedRecordIds,
    },
  }
}

// ── Tier-2 配置回滚的拒绝（ADR §3.10）───────────────────────────────────────────────────────────────────

// 只缓存「表在」：表一旦建出来就不会消失；「表不在」每次重问（迁移可能在进程运行中落地）。
let conversionsTablePresent = false
export function __resetFieldRetypeConversionsTableProbe(): void {
  conversionsTablePresent = false
}

/**
 * `revisionId` 是不是某次转换或某次撤销留下的配置修订。是 ⇒ Time Machine 的配置回滚必须拒（422）：这类修订在历史里
 * 与普通 PATCH 改类型分不出来，而「只回滚 schema、单元格不动」对它不成立——回滚转换修订会把字段翻回文本、每一格却仍是
 * 选项形，之后整列撤销的 ① 永远不过、前镜像取不回。
 *
 * 表不存在（迁移未跑）⇒ `false`，这是事实而不是放行：没有这张表，任何转换都提交不了（执行事务要往里写一行）。
 * 存在性用 `to_regclass` 问，事务里也安全（问一个不存在的表不报错、不毒化事务）。
 */
export async function isFieldRetypeConversionRevision(query: FieldRetypeConvertQuery, revisionId: string): Promise<boolean> {
  if (!conversionsTablePresent) {
    const probe = await query("SELECT to_regclass('meta_field_retype_conversions') IS NOT NULL AS present")
    if (!toBool((probe.rows[0] as { present?: unknown } | undefined)?.present)) return false
    conversionsTablePresent = true
  }
  const res = await query(
    'SELECT 1 FROM meta_field_retype_conversions WHERE convert_revision_id = $1::uuid OR undo_revision_id = $1::uuid LIMIT 1',
    [revisionId],
  )
  return res.rows.length > 0
}

export function fieldRetypeConversionRestoreRefusal(): FieldRetypeConvertFailure {
  return {
    status: 422,
    code: FIELD_RETYPE_RESTORE_NOT_SUPPORTED_CODE,
    message:
      'This revision was written by a field type conversion or by its undo. It cannot be reverted from the configuration history; use the whole-column undo of the conversion instead.',
    details: { reason: FIELD_RETYPE_RESTORE_NOT_SUPPORTED_REASON },
  }
}
