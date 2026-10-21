/**
 * 「复制数据表（含数据）」—— 服务层（设计锁 ADR docs/development/multitable-copy-sheet-with-data-adr-20260926.md，
 * 尤其 §4 权限模型、§5 字段语义、§7.2 单事务顺序、§8 失败模式）。S1：同 Base、`inherit` 权限模式、同步、
 * ≤ N 行（env MULTITABLE_COPY_SHEET_SYNC_MAX_ROWS，默认 2000）、≤ 500 字段。
 *
 * 两个入口：
 *   - {@link planCopySheet}：零写分析（dry-run 与执行共用）：字段计划 / 视图计划 / 规则 remap / 计数 / 披露。
 *   - {@link executeCopySheet}：§7.2 的单事务（READ COMMITTED = pool 裸 BEGIN）：
 *       ① 咨询锁（事务第一条语句，去重账本；等不到 → 409，不降级）→ ② 无锁预读源表 link 字段 → 全参与表
 *       围栏一次取全（**围栏先于行锁**：与每个围栏写者同向，ADR §7.2 第 4 步 r4 修订）→ ③ 源表行 `FOR UPDATE` +
 *       存活重读 → ④ tripwire 基线（在任何源数据读之前）→ ⑤ DB-fresh 两侧门（在任何计数之前）→ 计划 + 参与表
 *       集合核对 → ⑥ meta_sheets / 字段 / 视图 → ⑦ 记录（facade 上的 `RecordService.createRecord` 复制扩展）→
 *       ⑧ 授权行 + record_permissions remap → ⑨ 拒绝集等价断言 → ⑩ tripwire 比对 → ⑪ 两行审计 → 账本写回 →
 *       COMMIT。任一步抛错 = 整体回滚（CS-18）。账本未迁移（缺表 / 缺 `intent_kind` 列）→ 503 拒绝、不降级
 *       （2026-09-28，#6112 终审后续 3：无账本就无法兑现 CS-16「同意图只建一张表」，见 {@link executeCopySheet}）。
 *
 * 这个模块**不知道** req / res：路由层负责事务外快速拒、错误 → HTTP 映射、提交后的 formula 重算 / 事件 / 日志。
 * 所有错误都是 values-free 的：只带 code + 位置（rowIndex / fieldId / viewId / 计数），永不带单元格值。
 */

import { randomUUID } from 'crypto'

import type { EventBus } from '../integration/events/event-bus'
import { operatorFieldPermissionCreatedBy } from '../services/stock-preparation-field-permissions'
import { deriveCapabilities, type MultitableCapabilities, type ResolvedRequestAccess } from './access'
import { isApprovalProjectionBaseId } from './approval-projection-constants'
import {
  acquireCanonicalSheetFencesInOrder,
  assertNoActiveWriterBlock,
  isWriterFenceEnabled,
} from './canonical-sheet-fence'
import { configCreateDiff, fieldCreateDiff, recordConfigRevision } from './config-revision-recorder'
import { COPIED_FROM_KIND_PLUGIN_MANAGED, COPIED_FROM_KIND_USER, type CopiedFromKind } from './copied-sheet-plugin-scope'
import { COPY_SHEET_MAX_FIELDS, resolveCopySheetSyncMaxRows } from './copy-sheet-limits'
import {
  CopySheetRemapError,
  planFieldCopies,
  planViewCopies,
  remapConditionalRules,
  rulesReferenceAutoNumber,
  type CopyFieldDisclosure,
  type FieldCopyPlan,
  type FieldRemapContext,
  type SourceFieldRow,
  type SourceViewRow,
  type ViewCopyPlan,
} from './copy-sheet-remap'
import { isElearningProjectionBaseIdCandidate } from './elearning-projection-constants'
import { normalizeJson, normalizeJsonArray } from './field-codecs'
import { parseConditionalRules, type ConditionalRule } from './permission-rule-evaluator'
import {
  canReadWithSheetGrant,
  loadDeniedRecordIds,
  loadRuleDeniedRecordIds,
  resolveCopyTargetWritable,
  resolveSheetCapabilitiesForAccess,
} from './permission-service'
import {
  COPY_SHEET_RECORD_CAPABILITIES,
  RecordFieldForbiddenError,
  RecordPermissionError,
  RecordService,
  RecordValidationError,
  type QueryFn,
} from './record-service'
import { isPluginManagedSheet, isSystemManagedSheet } from './sheet-delete-guard'
import { assertSheetLiveForUpdate } from './sheet-liveness'
import {
  COPY_SHEET_INTENT_KIND,
  DedupeLockTimeoutError,
  TemplateInstallLedgerUnavailableError,
  runDeduplicatedIntent,
  type DedupeIntentScope,
  type TemplateInstallLedgerUnavailableSqlState,
} from './template-install-dedupe'
import { createTransactionBoundPool } from './transaction-bound-pool'

// ── 错误 ────────────────────────────────────────────────────────────────────

/** 路由把它映射成 HTTP：`statusCode` + `{ code, ...details }`；details 只含位置 / 计数，永不含值。 */
export class CopySheetError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(code)
    this.name = 'CopySheetError'
  }
}

export const COPY_SHEET_ERROR_CODES = {
  sourceNotFullyReadable: 'COPY_SOURCE_NOT_FULLY_READABLE',
  sourceSystemSheet: 'COPY_SOURCE_SYSTEM_SHEET',
  sourceChanged: 'COPY_SOURCE_CHANGED',
  tooLarge: 'COPY_TOO_LARGE',
  tooManyFields: 'COPY_TOO_MANY_FIELDS',
  rowValidationFailed: 'COPY_ROW_VALIDATION_FAILED',
  permissionParityFailed: 'COPY_PERMISSION_PARITY_FAILED',
  linkTargetNotLive: 'COPY_LINK_TARGET_NOT_LIVE',
  /** 去重账本未迁移（503，可重试）：见 {@link executeCopySheet} 与 {@link COPY_SHEET_LEDGER_MIGRATIONS}。 */
  temporarilyUnavailable: 'COPY_TEMPORARILY_UNAVAILABLE',
  forbidden: 'FORBIDDEN',
} as const

/**
 * 复制的去重账本依赖的两条迁移（按顺序）：账本表本身、以及把它一般化的 `intent_kind` 列。任一未跑，
 * `runDeduplicatedIntent` 抛 `TemplateInstallLedgerUnavailableError`（42P01 / 42703），复制拒绝（503）。
 * 路由把这两个名字写进一条 values-free 的 warn 日志，告诉运维该跑什么；响应体里不带。
 */
export const COPY_SHEET_LEDGER_MIGRATIONS = [
  'zzzz20260919140000_create_multitable_template_install_ledger',
  'zzzz20260927121000_add_multitable_install_ledger_intent_kind',
] as const

/**
 * 按 SQLSTATE 分诊（只进路由的 warn 日志，固定文案，values-free）。42703 不一定是「去跑迁移」：迁移已跑仍出现，
 * 就是账本语句点名了表里没有的列（代码缺陷）——日志必须把这层区分交给运维，不能一律报成「缺迁移」。
 */
export const COPY_SHEET_LEDGER_DIAGNOSIS: Readonly<Record<TemplateInstallLedgerUnavailableSqlState, { diagnosis: string; checkMigrations: readonly string[] }>> = {
  '42P01': {
    diagnosis: 'ledger table missing: run the listed migrations',
    checkMigrations: COPY_SHEET_LEDGER_MIGRATIONS,
  },
  '42703': {
    diagnosis: 'ledger column missing: run the listed migration; if it has already run, a ledger statement names a column the table does not have (code defect, not a pending migration)',
    checkMigrations: [COPY_SHEET_LEDGER_MIGRATIONS[1]],
  },
}

/**
 * 去重账本不可用 → 503 `COPY_TEMPORARILY_UNAVAILABLE`（CS-16 fail-closed，决策登记册 R-20）。`ledgerSqlState` 只给
 * 路由的 warn 日志用；响应体只有 code + 固定 message（`details` 为空），不带 SQLSTATE、不带迁移名。
 */
export class CopySheetLedgerUnavailableError extends CopySheetError {
  constructor(public readonly ledgerSqlState: TemplateInstallLedgerUnavailableSqlState) {
    super(503, COPY_SHEET_ERROR_CODES.temporarilyUnavailable)
  }
}

// ── 输入 / 输出形状 ─────────────────────────────────────────────────────────

export type CopyPermissionMode = 'inherit'

export interface CopySheetRequest {
  sourceSheetId: string
  /** trim 后；null = 默认「<源表名> 副本」（CS-4）。 */
  name: string | null
  withData: boolean
  permissionMode: CopyPermissionMode
}

export interface CopySheetActor {
  /** 事务外由 resolveSheetCapabilities 解析出的访问快照；事务内用它 DB-fresh 重跑能力解析。 */
  access: ResolvedRequestAccess
  actorId: string
  /** 只来自 req.authenticatedTenantId（去重指纹的租户段）。 */
  tenantId: string | null
}

/** 配置历史的快照 / 键 —— 与 `routes/univer-meta.ts` 的授权 PUT 路由同一套（由路由注入，避免两份定义漂移）。 */
export interface CopySheetHistoryHelpers {
  permissionConfigEntityId: (scope: 'field' | 'sheet' | 'view', parts: string[]) => string
  sheetPermissionSnapshot: (args: { subjectType: string; subjectId: string; accessLevel: string }) => Record<string, unknown>
  fieldPermissionSnapshot: (args: { fieldId: string; subjectType: string; subjectId: string; visible: boolean; readOnly: boolean }) => Record<string, unknown>
  viewPermissionSnapshot: (args: { viewId: string; subjectType: string; subjectId: string; permission: string }) => Record<string, unknown>
  viewConfigSnapshot: (view: { name: string; type: string; filterInfo?: Record<string, unknown>; sortInfo?: Record<string, unknown>; groupInfo?: Record<string, unknown>; hiddenFieldIds?: string[]; config?: Record<string, unknown> }) => Record<string, unknown>
  sheetPermissionHistoryKeys: ReadonlyArray<string>
  fieldPermissionHistoryKeys: ReadonlyArray<string>
  viewPermissionHistoryKeys: ReadonlyArray<string>
  viewConfigHistoryKeys: ReadonlyArray<string>
  /** `perm_code` → accessLevel（spreadsheet_permissions 的配置修订用 accessLevel 表述）。 */
  deriveSheetAccessLevel: (codes: string[]) => string | null
}

export interface CopySheetDeps {
  eventBus: EventBus
  /**
   * `univer-meta.ts` 的全表读门（§1.9 三轴），事务外与事务内（DB-fresh）都用它。`query` 是当前连接的
   * query；事务内传事务 query。
   */
  hasFullTableReadAccess: (
    query: QueryFn,
    sheetId: string,
    access: ResolvedRequestAccess,
    capabilities: MultitableCapabilities,
  ) => Promise<boolean>
  /** relation-aggregation formula 的 link 依赖（`extractRelationAggregationLinkFieldId`）；缺省不登记。 */
  relationAggregationLinkFieldId?: (expression: string) => string | null
  history: CopySheetHistoryHelpers
  /** 可注入的 id mint（测试用）。默认 `<prefix>_<uuid>`。 */
  mintId?: (prefix: 'sheet' | 'fld' | 'view') => string
  now?: () => Date
}

export interface CopySheetPlanSummary {
  sourceSheetId: string
  sourceName: string
  baseId: string
  targetName: string
  copiedFromKind: CopiedFromKind
  rowCount: number
  fieldCount: number
  /** 将建出的字段数（= fieldCount − 未建的镜像列数）。 */
  builtFieldCount: number
  viewCount: number
  disclosures: CopyFieldDisclosure[]
  droppedViewFilterLeaves: Array<{ viewId: string; count: number }>
  autoNumberRenumberedRows: number
  nullCellsOmitted: number
  permissionRowCount: number
  fieldPermissionRowCount: number
  viewPermissionRowCount: number
  recordPermissionRowCount: number
  rowLevelReadEnabled: boolean
  conditionalRuleCount: number
  notCopied: readonly string[]
  limits: { maxRows: number; maxFields: number }
  /**
   * dry-run 专用（ADR §3「超限与否」/ FE-2）：`withData` 且源行数 > `limits.maxRows` → true，此时记录**未读**
   * （`rowCount` 仍是源行数、结构披露照常）。执行路径永不 true —— 超限在执行时是 413 `COPY_TOO_LARGE`。
   */
  overLimit: boolean
}

/** 不复制项（ADR §3 / §10），固定清单，dry-run 与结果一并透出。 */
export const COPY_SHEET_NOT_COPIED = Object.freeze([
  'automations', 'comments', 'subscriptions', 'form-shares', 'record-locks', 'revision-history', 'personal-view-configs', 'attachment-blobs',
] as const)

export interface CopySheetResult {
  sheetId: string
  baseId: string
  name: string
  summary: CopySheetPlanSummary
  batchId: string
  /** 新表全部字段 id（建出的）。提交后 formula 重算用。 */
  newFieldIds: string[]
  newRecordIds: string[]
  formulaFieldIds: string[]
}

// ── 内部：源表读取 ──────────────────────────────────────────────────────────

interface SourceSheetRow {
  id: string
  baseId: string
  name: string
  description: string | null
  rowLevelReadEnabled: boolean
  conditionalReadRulesRaw: unknown
  systemKind: string | null
  /** 源表自己的 provenance kind（源表本身是托管表的快照 → 'plugin-managed'；SEC-1：二次复制不洗白）。 */
  copiedFromKind: string | null
}

async function loadSourceSheet(query: QueryFn, sheetId: string): Promise<SourceSheetRow | null> {
  // `to_jsonb(...) ->> col` 对尚未迁移的列回 NULL 而不是 42703（provenance / 行级开关 / 规则 / system_kind 都是后加列）。
  const res = await query(
    `SELECT id, base_id, name, description,
            (to_jsonb(meta_sheets) ->> 'row_level_read_permissions_enabled') AS row_level,
            (to_jsonb(meta_sheets) -> 'conditional_read_rules') AS rules,
            (to_jsonb(meta_sheets) ->> 'system_kind') AS system_kind,
            (to_jsonb(meta_sheets) ->> 'copied_from_kind') AS copied_from_kind
       FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL`,
    [sheetId],
  )
  const row = res.rows[0] as Record<string, unknown> | undefined
  if (!row) return null
  return {
    id: String(row.id),
    baseId: typeof row.base_id === 'string' ? row.base_id : '',
    name: String(row.name ?? ''),
    description: typeof row.description === 'string' ? row.description : null,
    rowLevelReadEnabled: row.row_level === 'true' || row.row_level === true,
    conditionalReadRulesRaw: row.rules ?? [],
    systemKind: typeof row.system_kind === 'string' ? row.system_kind : null,
    copiedFromKind: typeof row.copied_from_kind === 'string' ? row.copied_from_kind : null,
  }
}

/** 无锁预读：源表每个 link 字段的外表 id（围栏集合用；§7.2 第 4 步 r4 —— 围栏必须先于行锁、先于计划）。 */
async function loadSourceLinkTargets(query: QueryFn, sheetId: string): Promise<string[]> {
  const res = await query('SELECT id, type, property FROM meta_fields WHERE sheet_id = $1', [sheetId])
  const targets: string[] = []
  for (const row of res.rows as Array<Record<string, unknown>>) {
    if (row.type !== 'link') continue
    const property = normalizeJson(row.property)
    const foreign = ['foreignSheetId', 'foreignDatasheetId', 'datasheetId']
      .map((k) => property[k])
      .find((v) => typeof v === 'string' && v.trim()) as string | undefined
    if (foreign) targets.push(foreign.trim())
  }
  return targets
}

async function loadSourceFields(query: QueryFn, sheetId: string): Promise<SourceFieldRow[]> {
  const res = await query(
    'SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC',
    [sheetId],
  )
  return (res.rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    name: String(row.name ?? ''),
    type: String(row.type ?? 'string'),
    property: normalizeJson(row.property),
    order: Number.isFinite(Number(row.order)) ? Number(row.order) : 0,
  }))
}

async function loadSourceViews(query: QueryFn, sheetId: string): Promise<SourceViewRow[]> {
  const res = await query(
    `SELECT id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config
       FROM meta_views WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC`,
    [sheetId],
  )
  return (res.rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    name: String(row.name ?? ''),
    type: String(row.type ?? 'grid'),
    filterInfo: normalizeJson(row.filter_info),
    sortInfo: normalizeJson(row.sort_info),
    groupInfo: normalizeJson(row.group_info),
    hiddenFieldIds: normalizeJsonArray(row.hidden_field_ids),
    config: normalizeJson(row.config),
  }))
}

interface SourceRecordRow {
  id: string
  data: Record<string, unknown>
  createdBy: string | null
}

async function countSourceRecords(query: QueryFn, sheetId: string): Promise<number> {
  const res = await query('SELECT COUNT(*)::int AS n FROM meta_records WHERE sheet_id = $1', [sheetId])
  return Number((res.rows[0] as { n?: unknown } | undefined)?.n ?? 0)
}

/** 默认列表序（`univer-meta.ts` 的 ORDER BY created_at ASC, id ASC）；LIMIT N+1 作行数 tripwire。 */
async function loadSourceRecords(query: QueryFn, sheetId: string, maxRows: number): Promise<SourceRecordRow[]> {
  const res = await query(
    'SELECT id, data, created_by FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC LIMIT $2',
    [sheetId, maxRows + 1],
  )
  return (res.rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    data: normalizeJson(row.data),
    createdBy: typeof row.created_by === 'string' ? row.created_by : null,
  }))
}

/** link 值以 `meta_links` 为准（`POST /records/:id/duplicate` 先例）。返回 recordId → fieldId → foreignIds。 */
async function loadLinkValues(
  query: QueryFn,
  linkFieldIds: readonly string[],
  recordIds: readonly string[],
): Promise<Map<string, Map<string, string[]>>> {
  const out = new Map<string, Map<string, string[]>>()
  if (linkFieldIds.length === 0 || recordIds.length === 0) return out
  const CHUNK = 1000
  for (let i = 0; i < recordIds.length; i += CHUNK) {
    const chunk = recordIds.slice(i, i + CHUNK)
    const res = await query(
      `SELECT field_id, record_id, foreign_record_id FROM meta_links
        WHERE field_id = ANY($1::text[]) AND record_id = ANY($2::text[])
        ORDER BY created_at ASC, id ASC`,
      [[...linkFieldIds], chunk],
    )
    for (const row of res.rows as Array<Record<string, unknown>>) {
      const recordId = String(row.record_id)
      const fieldId = String(row.field_id)
      const foreignId = String(row.foreign_record_id)
      let byField = out.get(recordId)
      if (!byField) { byField = new Map(); out.set(recordId, byField) }
      const ids = byField.get(fieldId) ?? []
      if (!ids.includes(foreignId)) ids.push(foreignId)
      byField.set(fieldId, ids)
    }
  }
  return out
}

interface PermissionRows {
  sheet: Array<{ user_id: string | null; subject_type: string; subject_id: string; perm_code: string }>
  field: Array<{ field_id: string; subject_type: string; subject_id: string; visible: boolean; read_only: boolean }>
  view: Array<{ view_id: string; subject_type: string; subject_id: string; permission: string }>
  record: Array<{ record_id: string; subject_type: string; subject_id: string; access_level: string; created_by: string | null }>
}

function isUndefinedTableError(err: unknown): boolean {
  return (err as { code?: unknown } | null | undefined)?.code === '42P01'
}

async function tolerantRows<T>(promise: Promise<{ rows: unknown[] }>): Promise<T[]> {
  try {
    return (await promise).rows as T[]
  } catch (err) {
    if (isUndefinedTableError(err)) return [] // pre-feature deployment without the table ⇒ no rows to copy
    throw err
  }
}

async function loadPermissionRows(query: QueryFn, sheetId: string, viewIds: readonly string[]): Promise<PermissionRows> {
  const sheet = await tolerantRows<PermissionRows['sheet'][number]>(query(
    `SELECT user_id, subject_type, subject_id, perm_code FROM spreadsheet_permissions
      WHERE sheet_id = $1 ORDER BY subject_type, subject_id, perm_code`,
    [sheetId],
  ))
  const field = await tolerantRows<PermissionRows['field'][number]>(query(
    `SELECT field_id, subject_type, subject_id, visible, read_only FROM field_permissions
      WHERE sheet_id = $1 ORDER BY field_id, subject_type, subject_id`,
    [sheetId],
  ))
  const view = viewIds.length > 0
    ? await tolerantRows<PermissionRows['view'][number]>(query(
      `SELECT view_id, subject_type, subject_id, permission FROM meta_view_permissions
        WHERE view_id = ANY($1::text[]) ORDER BY view_id, subject_type, subject_id`,
      [[...viewIds]],
    ))
    : []
  const record = await tolerantRows<PermissionRows['record'][number]>(query(
    `SELECT record_id, subject_type, subject_id, access_level, created_by FROM record_permissions
      WHERE sheet_id = $1 ORDER BY record_id, subject_type, subject_id`,
    [sheetId],
  ))
  return { sheet, field, view, record }
}

// ── 分析（零写） ────────────────────────────────────────────────────────────

export interface CopySheetPlan {
  source: SourceSheetRow
  fields: SourceFieldRow[]
  views: SourceViewRow[]
  fieldPlans: FieldCopyPlan[]
  viewPlans: ViewCopyPlan[]
  ctx: FieldRemapContext
  rules: ConditionalRule[]
  remappedRules: ConditionalRule[]
  records: SourceRecordRow[]
  linkValues: Map<string, Map<string, string[]>>
  permissions: PermissionRows
  newSheetId: string
  targetName: string
  copiedFromKind: CopiedFromKind
  summary: CopySheetPlanSummary
}

function defaultMintId(prefix: 'sheet' | 'fld' | 'view'): string {
  return `${prefix}_${randomUUID()}`.slice(0, 50)
}

/**
 * 系统表拒绝作为源（CS-14 / §6）：`system_kind` / People 哨兵（`isSystemManagedSheet`），审批 / e-learning 投影
 * Base。门后才回（调用方保证已过 canRead）。
 */
export async function assertSourceIsNotSystemSheet(query: QueryFn, source: { id: string; baseId: string }): Promise<void> {
  if (await isSystemManagedSheet(query, source.id)
    || isApprovalProjectionBaseId(source.baseId)
    || isElearningProjectionBaseIdCandidate(source.baseId)) {
    throw new CopySheetError(422, COPY_SHEET_ERROR_CODES.sourceSystemSheet)
  }
}

/**
 * 零写分析。前置：调用方已跑事务外快速拒（canRead / liveness / 全表读门 / 目标 Base 可写 / 系统表）。
 * 这里再做：字段数与行数上限、字段 / 视图 / 规则 remap（fail-closed）、计数与披露。
 */
export interface PlanCopySheetOptions {
  copierCanManageSourceFields: boolean
  /** 执行路径预 mint（围栏集合要先于计划知道新表 id）；dry-run 缺省 mint。 */
  newSheetId?: string
  /**
   * `withData` 且源行数 > 上限时：`'refuse'`（执行路径，默认）→ 413 `COPY_TOO_LARGE`；`'report'`（dry-run）→
   * 不读记录、`summary.overLimit = true`、结构披露照常（ADR §3 / FE-2）。
   */
  overLimit?: 'refuse' | 'report'
  /** 调用方已在同事务里读过的源表行（执行路径：门先于计划）；缺省自读。 */
  source?: SourceSheetRow
}

export async function planCopySheet(
  query: QueryFn,
  request: CopySheetRequest,
  actor: CopySheetActor,
  deps: Pick<CopySheetDeps, 'mintId'>,
  opts: PlanCopySheetOptions,
): Promise<CopySheetPlan> {
  const mintId = deps.mintId ?? defaultMintId
  const source = opts.source ?? await loadSourceSheet(query, request.sourceSheetId)
  if (!source) throw new CopySheetError(404, 'NOT_FOUND')
  await assertSourceIsNotSystemSheet(query, source)

  const maxRows = resolveCopySheetSyncMaxRows()
  const fields = await loadSourceFields(query, source.id)
  if (fields.length > COPY_SHEET_MAX_FIELDS) {
    throw new CopySheetError(413, COPY_SHEET_ERROR_CODES.tooManyFields, { fieldCount: fields.length, limit: COPY_SHEET_MAX_FIELDS })
  }
  const rowCount = await countSourceRecords(query, source.id)
  const overLimit = request.withData && rowCount > maxRows
  if (overLimit && opts.overLimit !== 'report') {
    throw new CopySheetError(413, COPY_SHEET_ERROR_CODES.tooLarge, { rowCount, limit: maxRows })
  }

  const newSheetId = opts.newSheetId ?? mintId('sheet')
  let planned: ReturnType<typeof planFieldCopies>
  let viewPlans: ViewCopyPlan[]
  const views = await loadSourceViews(query, source.id)
  try {
    planned = planFieldCopies(fields, source.id, newSheetId, () => mintId('fld'), {
      copierCanManageSourceFields: opts.copierCanManageSourceFields,
    })
    viewPlans = planViewCopies(planned.ctx, views, () => mintId('view'))
  } catch (err) {
    if (err instanceof CopySheetRemapError) {
      throw new CopySheetError(422, err.code, {
        ...(err.fieldId ? { fieldId: err.fieldId } : {}),
        ...(err.viewId ? { viewId: err.viewId } : {}),
      })
    }
    throw err
  }
  const { plans: fieldPlans, ctx } = planned

  // 记录（withData 才读）—— dry-run 也读：autoNumber 重编号与 null 省略计数需要看数据（复制者已过全表读门）。
  // 超限的 dry-run（'report'）不读记录：只回结构披露 + overLimit。
  const readRecords = request.withData && !overLimit
  const records = readRecords ? await loadSourceRecords(query, source.id, maxRows) : []
  if (records.length > maxRows) {
    throw new CopySheetError(413, COPY_SHEET_ERROR_CODES.tooLarge, { rowCount: records.length, limit: maxRows })
  }
  const linkFieldIds = fieldPlans
    .filter((p) => p.build && p.copyValues && p.type === 'link')
    .map((p) => p.sourceFieldId)
  const linkValues = readRecords
    ? await loadLinkValues(query, linkFieldIds, records.map((r) => r.id))
    : new Map<string, Map<string, string[]>>()

  // autoNumber 重编号（CS-12）：新表按默认序从 config.start 起编；源值 ≠ 将得到的值的行数。
  const autoNumberPlans = fieldPlans.filter((p) => p.type === 'autoNumber')
  let autoNumberRenumberedRows = 0
  if (request.withData && autoNumberPlans.length > 0) {
    for (const plan of autoNumberPlans) {
      const start = Number((plan.property as { start?: unknown }).start)
      const base = Number.isFinite(start) ? start : 1
      records.forEach((row, index) => {
        const current = row.data[plan.sourceFieldId]
        if (current !== base + index) autoNumberRenumberedRows += 1
      })
    }
  }

  // null 省略计数（CS-21；'' / [] 保留，见 isEmptyCell）。
  let nullCellsOmitted = 0
  if (request.withData) {
    for (const row of records) {
      for (const plan of fieldPlans) {
        if (!plan.build || !plan.copyValues) continue
        if (isEmptyCell(sourceCellValue(row, plan, linkValues))) nullCellsOmitted += 1
      }
    }
  }

  const parsedRules = parseConditionalRules(source.conditionalReadRulesRaw)
  const rules = parsedRules.rules
  let remappedRules: ConditionalRule[]
  try {
    const renumbered = rulesReferenceAutoNumber(ctx, rules) && autoNumberRenumberedRows > 0
    remappedRules = remapConditionalRules(ctx, rules, renumbered)
  } catch (err) {
    if (err instanceof CopySheetRemapError) {
      throw new CopySheetError(422, err.code, { ...(err.fieldId ? { fieldId: err.fieldId } : {}) })
    }
    throw err
  }

  const permissions = await loadPermissionRows(query, source.id, views.map((v) => v.id))
  // CS-14 / SEC-1：源是托管表（registry 有行）**或**源本身已是托管表的快照 → 'plugin-managed'。快照的快照不洗白。
  const copiedFromKind: CopiedFromKind = (await isPluginManagedSheet(query, source.id)) || source.copiedFromKind === COPIED_FROM_KIND_PLUGIN_MANAGED
    ? COPIED_FROM_KIND_PLUGIN_MANAGED
    : COPIED_FROM_KIND_USER

  const targetName = request.name && request.name.trim() ? request.name.trim() : `${source.name} 副本`
  const disclosures = fieldPlans.flatMap((p) => p.disclosures)
  const summary: CopySheetPlanSummary = {
    sourceSheetId: source.id,
    sourceName: source.name,
    baseId: source.baseId,
    targetName,
    copiedFromKind,
    rowCount: request.withData ? (overLimit ? rowCount : records.length) : 0,
    fieldCount: fields.length,
    builtFieldCount: fieldPlans.filter((p) => p.build).length,
    viewCount: views.length,
    disclosures,
    droppedViewFilterLeaves: viewPlans.filter((v) => v.droppedFilterLeaves > 0).map((v) => ({ viewId: v.sourceViewId, count: v.droppedFilterLeaves })),
    autoNumberRenumberedRows,
    nullCellsOmitted,
    permissionRowCount: permissions.sheet.length,
    fieldPermissionRowCount: permissions.field.filter((r) => !ctx.unbuiltFieldIds.has(r.field_id)).length,
    viewPermissionRowCount: permissions.view.length,
    recordPermissionRowCount: request.withData ? permissions.record.length : 0,
    rowLevelReadEnabled: source.rowLevelReadEnabled,
    conditionalRuleCount: rules.length,
    notCopied: COPY_SHEET_NOT_COPIED,
    limits: { maxRows, maxFields: COPY_SHEET_MAX_FIELDS },
    overLimit,
  }

  return {
    source, fields, views, fieldPlans, viewPlans, ctx, rules, remappedRules, records, linkValues, permissions,
    newSheetId, targetName, copiedFromKind, summary,
  }
}

/**
 * CS-21「null 键省略」只省略 null / undefined。`''` 与 `[]` **保留**：规则求值器对缺失键走 asStringOrThrow /
 * asArrayOrThrow → deny，对 `''` / `[]` 正常求值 → 不 deny；省略它们会让源 / 新表的规则拒绝集不等（DATA-5，
 * 拒绝集等价断言 500）。
 */
function isEmptyCell(value: unknown): boolean {
  return value === null || value === undefined
}

/**
 * 一个源单元格将写入新表的值。link 列以 `meta_links` 为准；links 为空时只保留源 `data` 里**显式**的 `[]`
 * （规则求值 undefined ≠ []，DATA-5），不复活 `data` 里没有对应 links 的陈旧 id。
 */
function sourceCellValue(row: SourceRecordRow, plan: FieldCopyPlan, linkValues: ReadonlyMap<string, ReadonlyMap<string, string[]>>): unknown {
  if (plan.type !== 'link') return row.data[plan.sourceFieldId]
  const linked = linkValues.get(row.id)?.get(plan.sourceFieldId)
  if (linked && linked.length > 0) return linked
  const stored = row.data[plan.sourceFieldId]
  return Array.isArray(stored) && stored.length === 0 ? [] : undefined
}

// ── 执行（单事务） ──────────────────────────────────────────────────────────

interface TripwireBaseline {
  fields: string
  views: string
  records: string
  links: string
}

/**
 * tripwire 基线 / 重读（§7.2 第 4 / 6 步）：字段 id 集来自**它自己**的 meta_fields SELECT（不依赖计划 —— 基线必须
 * 在计划读任何源数据之前取到，SEC-2 / TX-1 / DATA-6）。
 */
async function readTripwireBaseline(query: QueryFn, sheetId: string): Promise<TripwireBaseline> {
  const fields = await query(
    'SELECT id, updated_at FROM meta_fields WHERE sheet_id = $1 ORDER BY id ASC',
    [sheetId],
  )
  const fieldIds = (fields.rows as Array<Record<string, unknown>>).map((r) => String(r.id))
  const views = await query(
    'SELECT id, updated_at FROM meta_views WHERE sheet_id = $1 ORDER BY id ASC',
    [sheetId],
  )
  const records = await query(
    'SELECT COUNT(*)::int AS n, MAX(updated_at)::text AS max_updated FROM meta_records WHERE sheet_id = $1',
    [sheetId],
  )
  const links = fieldIds.length > 0
    ? await query('SELECT COUNT(*)::int AS n FROM meta_links WHERE field_id = ANY($1::text[])', [[...fieldIds]])
    : { rows: [{ n: 0 }] }
  const stamp = (rows: unknown[]) => JSON.stringify((rows as Array<Record<string, unknown>>).map((r) => [String(r.id), String((r.updated_at as Date | string | null) ?? '')]))
  return {
    fields: stamp(fields.rows),
    views: stamp(views.rows),
    records: JSON.stringify(records.rows[0] ?? null),
    links: JSON.stringify(links.rows[0] ?? null),
  }
}

/**
 * 参与表围栏集合（§7.2 第 4 步）—— 从**无锁预读**的 link 外表算（围栏先于行锁、先于计划）：源表、新表（预 mint）、
 * 全部 link 外表（自指 → 新表，已在集合里）。可能比计划最终的集合**大**（镜像列不建但其外表也进来了）——多围一把
 * 只是多等一会儿，不影响正确性；计划算出的集合必须 ⊆ 它（`copyInsideTransaction` 核对，否则 409）。
 */
export function participatingSheetIdsFromLinkTargets(sourceSheetId: string, newSheetId: string, linkTargets: readonly string[]): string[] {
  const ids = new Set<string>([sourceSheetId, newSheetId])
  for (const foreign of linkTargets) if (foreign && foreign !== sourceSheetId) ids.add(foreign)
  return [...ids]
}

/**
 * 计划最终的参与表集合：源表、新表、新表全部 link 字段（非自指）的 foreignSheetId。排序去重后一次取全，
 * 之后每行 `createRecord` 对同键的重取是同会话重入（PG §13.3.5），零等待、零新键。
 */
export function participatingSheetIds(plan: Pick<CopySheetPlan, 'source' | 'newSheetId' | 'fieldPlans'>): string[] {
  const ids = new Set<string>([plan.source.id, plan.newSheetId])
  for (const p of plan.fieldPlans) {
    if (!p.build || p.type !== 'link') continue
    const foreign = ['foreignSheetId', 'foreignDatasheetId', 'datasheetId']
      .map((k) => p.property[k])
      .find((v) => typeof v === 'string' && v.trim()) as string | undefined
    if (foreign && foreign !== plan.newSheetId) ids.add(foreign.trim())
  }
  return [...ids]
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

function foreignSheetIdOfPlan(plan: FieldCopyPlan): string {
  for (const key of ['foreignSheetId', 'foreignDatasheetId', 'datasheetId']) {
    const v = plan.property[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

/**
 * §4.2：每个建出的 link 字段过字段创建路由的同一组校验的**服务层等价**：悬空 / 已删外表 fail-closed；
 * 外表在别的 Base 而未声明 `foreignBaseId` → 拒（§2a.2 墙）。自指（→ 新表）跳过（新表行刚建）。
 */
async function assertLinkTargetsLive(query: QueryFn, plan: CopySheetPlan): Promise<void> {
  const targets = new Map<string, FieldCopyPlan>()
  for (const p of plan.fieldPlans) {
    if (!p.build || p.type !== 'link') continue
    const foreign = foreignSheetIdOfPlan(p)
    if (!foreign) throw new CopySheetError(422, COPY_SHEET_ERROR_CODES.linkTargetNotLive, { fieldId: p.sourceFieldId })
    if (foreign === plan.newSheetId) continue
    targets.set(foreign, p)
  }
  if (targets.size === 0) return
  const res = await query(
    'SELECT id, base_id FROM meta_sheets WHERE id = ANY($1::text[]) AND deleted_at IS NULL',
    [[...targets.keys()]],
  )
  const live = new Map((res.rows as Array<{ id: string; base_id: string | null }>).map((r) => [String(r.id), r.base_id]))
  for (const [foreign, p] of targets) {
    if (!live.has(foreign)) throw new CopySheetError(422, COPY_SHEET_ERROR_CODES.linkTargetNotLive, { fieldId: p.sourceFieldId })
    const foreignBase = live.get(foreign)
    const declared = typeof p.property.foreignBaseId === 'string' ? p.property.foreignBaseId : ''
    if (foreignBase !== plan.source.baseId && declared !== foreignBase) {
      throw new CopySheetError(422, COPY_SHEET_ERROR_CODES.linkTargetNotLive, { fieldId: p.sourceFieldId })
    }
  }
}

/** 一次复制的写账本 / 事件 / 日志计数（values-free）。 */
export interface CopySheetCounts {
  rowCount: number
  fieldCount: number
  blankedFieldCount: number
  permissionRowCount: number
  recordPermissionRowCount: number
  viewCount: number
}

/**
 * §7.2 第 4-6 步（在已持有咨询锁的事务内）。返回 201 body 用的结果。
 */
async function copyInsideTransaction(
  query: QueryFn,
  request: CopySheetRequest,
  actor: CopySheetActor,
  deps: CopySheetDeps,
  preplan: { copierCanManageSourceFields: boolean },
): Promise<CopySheetResult> {
  const now = deps.now ?? (() => new Date())
  const startedAt = now()
  const batchId = randomUUID()
  const mintId = deps.mintId ?? defaultMintId

  // ② 围栏**先于**行锁（ADR §7.2 第 4 步 r4 修订，TX-2）：无锁预读源表 link 外表 → 参与表集合 {源, 新（预 mint）,
  //    全部 link 外表} → 排序一次取全。锁序 = 围栏 → 源表行锁，与每个围栏写者同向（createRecord：围栏 →
  //    INSERT meta_records 的 FK `FOR KEY SHARE` 于 meta_sheets(源)）；反过来（行锁 → 围栏）会与它们构成 40P01 环
  //    （trust-checkpoint-activation-authz.ts 记录的仓库不变量：任何 meta_sheets 行锁都不得在围栏之前）。
  const newSheetId = mintId('sheet')
  const linkTargets = await loadSourceLinkTargets(query, request.sourceSheetId)
  const fenced = new Set(await acquireCanonicalSheetFencesInOrder(query, participatingSheetIdsFromLinkTargets(request.sourceSheetId, newSheetId, linkTargets)))
  if (isWriterFenceEnabled()) {
    for (const sid of fenced) await assertNoActiveWriterBlock(query, sid)
  }

  // ③ 源表行 FOR UPDATE + 存活重读（与五路授权 PUT 同一把行锁；围栏已在手，行锁之后再无新围栏）。
  await assertSheetLiveForUpdate(query, request.sourceSheetId)

  // ④ tripwire 基线 —— 在任何源数据读之前（SEC-2 / TX-1 / DATA-6）。围栏 flag 关时不取围栏也不取行锁的源表写者
  //    （patchRecords / deleteRecord / 字段 PATCH / 视图 PATCH）由它兜底：基线之后任何已提交的改动都让 ⑩ 不等 → 409。
  const baseline = await readTripwireBaseline(query, request.sourceSheetId)

  // ⑤ DB-fresh 两侧门（§4.1 / §4.2）—— 在任何计数 / 413 / 422 之前（SEC-3；ADR §3「先门后 COUNT」）。
  const source = await loadSourceSheet(query, request.sourceSheetId)
  if (!source) throw new CopySheetError(404, 'NOT_FOUND')
  const fresh = await resolveSheetCapabilitiesForAccess(query, source.id, actor.access)
  const baseCaps = deriveCapabilities(actor.access.permissions, actor.access.isAdminRole)
  // 纵深防御：路由调用者过了 rbacGuard('multitable','write')，而 deriveCapabilities 让 multitable:write ⇒ canRead
  // （access.ts:109-112），所以撤销复制者自己的表级授权到不了这里的 403（真库 G14a/G14b 的结构说明）。留着是为了
  // 非路由调用方与 liveness 重读；对路由调用者，事务内能收紧的是下面的 hasFullTableReadAccess：表上的读
  // （fresh.capabilities.canRead，即投影围栏收紧之后的读）加三轴。
  if (fresh.sheetLiveness !== 'live' || !canReadWithSheetGrant(baseCaps, fresh.sheetScope, actor.access.isAdminRole)) {
    throw new CopySheetError(403, COPY_SHEET_ERROR_CODES.forbidden)
  }
  if (!(await deps.hasFullTableReadAccess(query, source.id, actor.access, fresh.capabilities))) {
    throw new CopySheetError(403, COPY_SHEET_ERROR_CODES.sourceNotFullyReadable)
  }
  // 目标侧门 DB-fresh 终审（§4.2）：与路由快速拒、/context 探针**同一个**谓词 —— 平台管理员 ∨ resolveBaseWritable，
  // 投影 Base 对谁都拒（CS-3，2026-09-28 修订）。身份取 actor.access（路由把 actorId 设为 access.userId，两者同源）。
  if (!(await resolveCopyTargetWritable(actor.access, query, source.baseId))) {
    throw new CopySheetError(403, COPY_SHEET_ERROR_CODES.forbidden)
  }
  // 第二层：property-hidden 列的值只在复制者持有源表 canManageFields 时复制（§4.1）。计划按事务外判定建；
  // 事务内若能力**收窄**（撤销）→ 409（收紧方向，不静默改计划）。
  if (preplan.copierCanManageSourceFields && !fresh.capabilities.canManageFields) {
    throw new CopySheetError(409, COPY_SHEET_ERROR_CODES.sourceChanged)
  }

  // 计划（读结构、记录、授权行；fail-closed remap）。行锁 + 围栏都已在手；flag 关时的字段 / 视图写者由 ⑩ 兜底。
  const plan = await planCopySheet(query, request, actor, deps, { ...preplan, newSheetId, overLimit: 'refuse', source })

  // 参与表集合核对：无锁预读与计划之间有人加 / 改 link 字段 → 围栏可能缺一把 → 不补取（补取 = 行锁之后取围栏，
  // 正是要避免的锁序），整体 409 让调用方重试。
  for (const sid of participatingSheetIds(plan)) {
    if (!fenced.has(sid)) throw new CopySheetError(409, COPY_SHEET_ERROR_CODES.sourceChanged)
  }

  await assertLinkTargetsLive(query, plan)

  // ⑥ 新表（provenance 三列 + 行级开关 + remap 后的规则）。
  const insertSheet = await query(
    `INSERT INTO meta_sheets
       (id, base_id, name, description, row_level_read_permissions_enabled, conditional_read_rules,
        copied_from_sheet_id, copied_from_kind, copied_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::timestamptz)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [
      plan.newSheetId,
      plan.source.baseId,
      plan.targetName,
      plan.source.description,
      plan.source.rowLevelReadEnabled,
      JSON.stringify(plan.remappedRules),
      plan.source.id,
      plan.copiedFromKind,
      startedAt.toISOString(),
    ],
  )
  if (insertSheet.rows.length === 0) throw new CopySheetError(409, 'CONFLICT')

  // 字段（新 id、remap 后的 property、逐条 field create 修订共用 batchId）。
  const builtPlans = plan.fieldPlans.filter((p) => p.build)
  for (const p of builtPlans) {
    await query(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [p.newFieldId, plan.newSheetId, p.name, p.type, JSON.stringify(p.property), p.order],
    )
    if (p.type === 'formula' && typeof p.property.expression === 'string' && p.property.expression) {
      const refs = extractFormulaRefs(p.property.expression)
      const rel = deps.relationAggregationLinkFieldId?.(p.property.expression) ?? null
      if (rel && !refs.includes(rel)) refs.push(rel)
      for (const dep of refs) {
        await query(
          `INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id)
           VALUES ($1, $2, $3, NULL) ON CONFLICT ON CONSTRAINT uq_formula_dep DO NOTHING`,
          [plan.newSheetId, p.newFieldId, dep],
        )
      }
    }
    await recordConfigRevision(query, {
      sheetId: plan.newSheetId,
      entityType: 'field',
      entityId: p.newFieldId,
      action: 'create',
      ...fieldCreateDiff({ name: p.name, type: p.type, property: p.property, order: p.order }),
      batchId,
      actorId: actor.actorId,
    })
  }

  // 视图（序数 created_at 保序；publicForm 已剥离；逐条 view create 修订）。
  for (let i = 0; i < plan.viewPlans.length; i += 1) {
    const v = plan.viewPlans[i]!
    await query(
      `INSERT INTO meta_views (id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::timestamptz + ($11::int * interval '1 microsecond'))`,
      [
        v.newViewId, plan.newSheetId, v.name, v.type,
        JSON.stringify(v.filterInfo), JSON.stringify(v.sortInfo), JSON.stringify(v.groupInfo),
        JSON.stringify(v.hiddenFieldIds), JSON.stringify(v.config), startedAt.toISOString(), i,
      ],
    )
    await recordConfigRevision(query, {
      sheetId: plan.newSheetId,
      entityType: 'view',
      entityId: v.newViewId,
      action: 'create',
      ...configCreateDiff(deps.history.viewConfigSnapshot({
        name: v.name, type: v.type, filterInfo: v.filterInfo, sortInfo: v.sortInfo, groupInfo: v.groupInfo,
        hiddenFieldIds: v.hiddenFieldIds, config: v.config,
      }), deps.history.viewConfigHistoryKeys),
      batchId,
      actorId: actor.actorId,
    })
  }

  // ⑦ 记录先于授权写（§7.2 第 5 步）。服务端常量能力 + 事务绑定 facade；首个失败即停。
  const recordIdMap = new Map<string, string>()
  const newRecordIds: string[] = []
  if (request.withData && plan.records.length > 0) {
    const service = new RecordService(createTransactionBoundPool(query), deps.eventBus)
    const valuePlans = plan.fieldPlans.filter((p) => p.build && p.copyValues)
    for (let rowIndex = 0; rowIndex < plan.records.length; rowIndex += 1) {
      const row = plan.records[rowIndex]!
      const data: Record<string, unknown> = {}
      for (const p of valuePlans) {
        const value = sourceCellValue(row, p, plan.linkValues)
        if (isEmptyCell(value)) continue // CS-21：null 键省略（'' / [] 保留）
        data[p.newFieldId] = value
      }
      try {
        const created = await service.createRecord({
          sheetId: plan.newSheetId,
          data,
          actorId: actor.actorId,
          capabilities: COPY_SHEET_RECORD_CAPABILITIES,
          copy: { batchId, ordinal: rowIndex, startedAt, createdBy: row.createdBy },
        })
        recordIdMap.set(row.id, created.recordId)
        newRecordIds.push(created.recordId)
      } catch (err) {
        throw rowFailure(err, rowIndex, plan.ctx)
      }
    }
  }

  // ⑧ 授权行逐行复制（主体照抄、id remap），逐条 permission create 修订共用 batchId。
  let permissionRowCount = 0
  const bySubject = new Map<string, string[]>()
  for (const row of plan.permissions.sheet) {
    await query(
      `INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [plan.newSheetId, row.subject_type === 'user' ? row.subject_id : null, row.subject_type, row.subject_id, row.perm_code],
    )
    permissionRowCount += 1
    const key = JSON.stringify([row.subject_type, row.subject_id])
    bySubject.set(key, [...(bySubject.get(key) ?? []), row.perm_code])
  }
  for (const [key, codes] of bySubject) {
    const [subjectType, subjectId] = JSON.parse(key) as [string, string]
    const accessLevel = deps.history.deriveSheetAccessLevel(codes)
    if (!accessLevel) continue
    await recordConfigRevision(query, {
      sheetId: plan.newSheetId,
      entityType: 'permission',
      entityId: deps.history.permissionConfigEntityId('sheet', [subjectType, subjectId]),
      action: 'create',
      ...configCreateDiff(deps.history.sheetPermissionSnapshot({ subjectType, subjectId, accessLevel }), deps.history.sheetPermissionHistoryKeys),
      batchId,
      actorId: actor.actorId,
    })
  }
  for (const row of plan.permissions.field) {
    if (plan.ctx.unbuiltFieldIds.has(row.field_id)) continue // 镜像列不建 → 它的授权行无落点
    const newFieldId = plan.ctx.fieldIdMap.get(row.field_id)
    if (!newFieldId) continue
    await query(
      `INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [plan.newSheetId, newFieldId, row.subject_type, row.subject_id, row.visible !== false, row.read_only === true, operatorFieldPermissionCreatedBy(actor.actorId)],
    )
    permissionRowCount += 1
    await recordConfigRevision(query, {
      sheetId: plan.newSheetId,
      entityType: 'permission',
      entityId: deps.history.permissionConfigEntityId('field', [newFieldId, row.subject_type, row.subject_id]),
      action: 'create',
      ...configCreateDiff(deps.history.fieldPermissionSnapshot({
        fieldId: newFieldId, subjectType: row.subject_type, subjectId: row.subject_id,
        visible: row.visible !== false, readOnly: row.read_only === true,
      }), deps.history.fieldPermissionHistoryKeys),
      batchId,
      actorId: actor.actorId,
    })
  }
  const viewIdMap = new Map(plan.viewPlans.map((v) => [v.sourceViewId, v.newViewId]))
  for (const row of plan.permissions.view) {
    const newViewId = viewIdMap.get(row.view_id)
    if (!newViewId) continue
    await query(
      `INSERT INTO meta_view_permissions (view_id, subject_type, subject_id, permission)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [newViewId, row.subject_type, row.subject_id, row.permission],
    )
    permissionRowCount += 1
    await recordConfigRevision(query, {
      sheetId: plan.newSheetId,
      entityType: 'permission',
      entityId: deps.history.permissionConfigEntityId('view', [newViewId, row.subject_type, row.subject_id]),
      action: 'create',
      ...configCreateDiff(deps.history.viewPermissionSnapshot({
        viewId: newViewId, subjectType: row.subject_type, subjectId: row.subject_id, permission: row.permission,
      }), deps.history.viewPermissionHistoryKeys),
      batchId,
      actorId: actor.actorId,
    })
  }
  // record_permissions：record_id 经事务内映射 remap，含全部 'none' 行（CS-7）。映射缺失（源行在快照外）→ 丢弃。
  let recordPermissionRowCount = 0
  if (request.withData) {
    for (const row of plan.permissions.record) {
      const newRecordId = recordIdMap.get(row.record_id)
      if (!newRecordId) continue
      await query(
        `INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (record_id, subject_type, subject_id) DO NOTHING`,
        [plan.newSheetId, newRecordId, row.subject_type, row.subject_id, row.access_level, row.created_by],
      )
      recordPermissionRowCount += 1
    }
  }

  // ⑨ 拒绝集等价断言（§4.3）：源侧**重读**（READ COMMITTED 看得见期间提交的 record_permissions 变更）。
  if (request.withData) {
    await assertDenyParity(query, plan, recordIdMap)
  }

  // ⑩ 源表变更 tripwire（§7.2 第 6 步）。
  const after = await readTripwireBaseline(query, plan.source.id)
  if (after.fields !== baseline.fields || after.views !== baseline.views || after.records !== baseline.records || after.links !== baseline.links) {
    throw new CopySheetError(409, COPY_SHEET_ERROR_CODES.sourceChanged)
  }

  // ⑪ operation_audit_logs 两行（resource=目标、resource=源），metadata values-free。
  const counts: CopySheetCounts = {
    rowCount: newRecordIds.length,
    fieldCount: builtPlans.length,
    blankedFieldCount: plan.ctx.blankedFieldIds.size,
    permissionRowCount,
    recordPermissionRowCount,
    viewCount: plan.viewPlans.length,
  }
  const auditMeta = JSON.stringify({
    sourceSheetId: plan.source.id,
    targetSheetId: plan.newSheetId,
    targetBaseId: plan.source.baseId,
    batchId,
    permissionMode: request.permissionMode,
    withData: request.withData,
    copiedFromKind: plan.copiedFromKind,
    ...counts,
  })
  await query(
    `INSERT INTO operation_audit_logs (actor_id, actor_type, action, resource_type, resource_id, metadata, meta)
     VALUES ($1, 'user', 'multitable.sheet.copy', 'meta_sheet', $2, $3::jsonb, $3::jsonb)`,
    [actor.actorId, plan.newSheetId, auditMeta],
  )
  await query(
    `INSERT INTO operation_audit_logs (actor_id, actor_type, action, resource_type, resource_id, metadata, meta)
     VALUES ($1, 'user', 'multitable.sheet.copy-source', 'meta_sheet', $2, $3::jsonb, $3::jsonb)`,
    [actor.actorId, plan.source.id, auditMeta],
  )

  return {
    sheetId: plan.newSheetId,
    baseId: plan.source.baseId,
    name: plan.targetName,
    summary: { ...plan.summary, rowCount: newRecordIds.length, recordPermissionRowCount },
    batchId,
    newFieldIds: builtPlans.map((p) => p.newFieldId),
    newRecordIds,
    formulaFieldIds: builtPlans.filter((p) => p.type === 'formula').map((p) => p.newFieldId),
  }
}

const FORMULA_REF = /\{(fld_[a-zA-Z0-9_-]+)\}/g
function extractFormulaRefs(expression: string): string[] {
  const refs: string[] = []
  const pattern = new RegExp(FORMULA_REF.source, 'g')
  let m: RegExpExecArray | null
  while ((m = pattern.exec(expression)) !== null) if (!refs.includes(m[1])) refs.push(m[1])
  return refs
}

/** 行写入失败 → 422 `{ rowIndex, fieldId, code }`（CS-18），永不转发 message。 */
function rowFailure(err: unknown, rowIndex: number, ctx: FieldRemapContext): unknown {
  const sourceFieldIdOf = (newFieldId: string | undefined): string | undefined => {
    if (!newFieldId) return undefined
    for (const [src, next] of ctx.fieldIdMap) if (next === newFieldId) return src
    return undefined
  }
  if (err instanceof RecordValidationError) {
    return new CopySheetError(422, COPY_SHEET_ERROR_CODES.rowValidationFailed, {
      rowIndex, fieldId: sourceFieldIdOf(err.fieldId) ?? null, code: err.code,
    })
  }
  if (err instanceof RecordFieldForbiddenError) {
    return new CopySheetError(422, COPY_SHEET_ERROR_CODES.rowValidationFailed, {
      rowIndex, fieldId: sourceFieldIdOf(err.fieldId) ?? null, code: err.code,
    })
  }
  if (err instanceof RecordPermissionError) {
    return new CopySheetError(500, COPY_SHEET_ERROR_CODES.rowValidationFailed, { rowIndex, fieldId: null, code: 'RECORD_PERMISSION' })
  }
  return err
}

/**
 * §4.3 拒绝集等价断言：
 *   - 对源表每个持有 'none' 行的主体：源 'none' 记录集经映射 == 新表该主体的 'none' 记录集（三种主体都覆盖）；
 *   - 对 user 主体再走 `loadDeniedRecordIds`（grant ∪ rule ∪ projection 的真实读侧函数）核对；
 *   - 规则臂：map(loadRuleDeniedRecordIds(src)) == loadRuleDeniedRecordIds(new)。
 * 源侧全部**重读**。任一不等 → 500 COPY_PERMISSION_PARITY_FAILED，回滚。
 */
async function assertDenyParity(query: QueryFn, plan: CopySheetPlan, recordIdMap: ReadonlyMap<string, string>): Promise<void> {
  const mapSet = (ids: Iterable<string>): Set<string> => {
    const out = new Set<string>()
    for (const id of ids) {
      const mapped = recordIdMap.get(id)
      if (mapped) out.add(mapped)
    }
    return out
  }
  const subjects = new Map<string, { subjectType: string; subjectId: string }>()
  try {
    const src = await query(
      `SELECT DISTINCT subject_type, subject_id FROM record_permissions WHERE sheet_id = $1 AND access_level = 'none'`,
      [plan.source.id],
    )
    for (const row of src.rows as Array<{ subject_type: string; subject_id: string }>) {
      subjects.set(JSON.stringify([row.subject_type, row.subject_id]), { subjectType: String(row.subject_type), subjectId: String(row.subject_id) })
    }
  } catch (err) {
    if (!isUndefinedTableError(err)) throw err
  }
  for (const { subjectType, subjectId } of subjects.values()) {
    const srcRows = await query(
      `SELECT record_id FROM record_permissions WHERE sheet_id = $1 AND access_level = 'none' AND subject_type = $2 AND subject_id = $3`,
      [plan.source.id, subjectType, subjectId],
    )
    const newRows = await query(
      `SELECT record_id FROM record_permissions WHERE sheet_id = $1 AND access_level = 'none' AND subject_type = $2 AND subject_id = $3`,
      [plan.newSheetId, subjectType, subjectId],
    )
    const expected = mapSet((srcRows.rows as Array<{ record_id: string }>).map((r) => String(r.record_id)))
    const actual = new Set((newRows.rows as Array<{ record_id: string }>).map((r) => String(r.record_id)))
    if (!setsEqual(expected, actual)) throw new CopySheetError(500, COPY_SHEET_ERROR_CODES.permissionParityFailed)
    if (subjectType === 'user') {
      const deniedSrc = await loadDeniedRecordIds(query, plan.source.id, subjectId)
      const deniedNew = await loadDeniedRecordIds(query, plan.newSheetId, subjectId)
      if (!setsEqual(mapSet(deniedSrc), deniedNew)) throw new CopySheetError(500, COPY_SHEET_ERROR_CODES.permissionParityFailed)
    }
  }
  if (plan.rules.length > 0) {
    const ruleSrc = await loadRuleDeniedRecordIds(query, plan.source.id)
    const ruleNew = await loadRuleDeniedRecordIds(query, plan.newSheetId)
    if (!setsEqual(mapSet(ruleSrc), ruleNew)) throw new CopySheetError(500, COPY_SHEET_ERROR_CODES.permissionParityFailed)
  }
}

export interface ExecuteCopySheetOutcome {
  replayed: boolean
  lockHeld: boolean
  result: CopySheetResult
  /** 重放时 = 账本里的 body（原样）；fresh 时 = 本次构造。 */
  body: unknown
}

export interface ExecuteCopySheetInput {
  pool: { transaction: <T>(handler: (client: { query: QueryFn }) => Promise<T>) => Promise<T> }
  request: CopySheetRequest
  actor: CopySheetActor
  deps: CopySheetDeps
  /** S1 = 源表所在 Base（事务外门已解析）；进去重指纹（CS-16）。 */
  targetBaseId: string
  copierCanManageSourceFields: boolean
  /** 把 result 变成 201 body（账本重放的是这个 body）。 */
  buildBody: (result: CopySheetResult) => unknown
  /** 去重窗口 / 锁等待（测试注入）。 */
  dedupe?: { windowMs?: number; lockWaitMs?: number; lockPollMs?: number; sleep?: (ms: number) => Promise<void> }
}

/** CS-16 指纹的 intentKey：(sourceSheetId, targetBaseId, name, withData, permissionMode)。JSON 数组不可伪造分隔。 */
export function buildCopySheetIntentKey(request: CopySheetRequest, targetBaseId: string): string {
  return JSON.stringify([request.sourceSheetId, targetBaseId, request.name, request.withData, request.permissionMode])
}

/**
 * §7.2 的完整单事务（含 ① 咨询锁 = 第一条语句，去重账本读写同事务）。返回 fresh / replayed 结果。
 *
 * 账本不可用（未迁移：缺表 42P01 / 缺 `intent_kind` 列 42703 → `TemplateInstallLedgerUnavailableError`）→
 * **拒绝**，503 `COPY_TEMPORARILY_UNAVAILABLE`，不降级（2026-09-28，#6112 终审后续 3；模板安装保持 fail-open 不变）。
 * 为什么不是「降级照常复制」（修订前的姿态）也不是「降级但保留意图锁」：意图锁只能把两个同意图请求**排队**，
 * 去重靠的是后到者在锁后读到先到者写的账本行并重放它——账本读不了，后到者拿到锁后找不到先到者的结果，
 * 只能再建一张，CS-16「窗口内同意图只建一张表」照样破。复制的每一次降级都是一张用户看得见的多余表，
 * 而模板安装那边多一个 Base 是被接受的代价（`template-install-dedupe.ts` 头注释「未迁移时」）——两者口径不同。
 * 上一个事务在抛出时已回滚、什么都没写；等迁移跑完（{@link COPY_SHEET_LEDGER_MIGRATIONS}）即恢复。
 * 决策留痕：`docs/development/takeover-beiliao-20260821/decision-register.md` R-20；ADR §7.7（2026-09-28 修订）。
 */
export async function executeCopySheet(input: ExecuteCopySheetInput): Promise<ExecuteCopySheetOutcome> {
  const { pool, request, actor, deps } = input
  const preplan = { copierCanManageSourceFields: input.copierCanManageSourceFields }
  const scope: DedupeIntentScope = {
    tenantId: actor.tenantId,
    actorId: actor.actorId,
    intentKind: COPY_SHEET_INTENT_KIND,
    intentKey: buildCopySheetIntentKey(request, input.targetBaseId),
    workspaceId: null,
    baseName: null,
  }
  let fresh: CopySheetResult | null = null
  try {
    const outcome = await pool.transaction(async ({ query }) => runDeduplicatedIntent({
      query,
      scope,
      ...(input.dedupe ?? {}),
      // TX-4：等不到咨询锁 → 拒绝（409），不降级成「读账本 + 照常复制」——先到者还没提交时账本读不到它，
      // 降级会建出第二张表；模板安装保持旧的降级姿态（那边多一个 Base 可接受，这边违反 CS-16）。
      onLockTimeout: 'refuse',
      install: async () => {
        const result = await copyInsideTransaction(query, request, actor, deps, preplan)
        fresh = result
        return { baseId: result.baseId, sheetIds: [result.sheetId], body: input.buildBody(result) }
      },
    }))
    if (outcome.replayed || !fresh) {
      return {
        replayed: true,
        lockHeld: outcome.lockHeld,
        result: fresh ?? replayedResultFromBody(outcome.body, outcome.baseId),
        body: outcome.body,
      }
    }
    return { replayed: false, lockHeld: outcome.lockHeld, result: fresh, body: outcome.body }
  } catch (err) {
    if (err instanceof DedupeLockTimeoutError) throw new CopySheetError(409, 'CONFLICT')
    // 账本不可用：fail-closed（见上方 docblock）。不开第二个事务、不重跑复制；事务已回滚、零写入。
    // SQLSTATE 随错误带给路由的 warn 日志（42P01 缺表 / 42703 缺列），响应体里不带。
    if (err instanceof TemplateInstallLedgerUnavailableError) throw new CopySheetLedgerUnavailableError(err.sqlState)
    throw err
  }
}

/** 重放时只有 body：从 body 里把 sheetId / name 捞出来给日志与 Location 用（缺失就置空，不猜）。 */
function replayedResultFromBody(body: unknown, baseId: string): CopySheetResult {
  const data = (body as { data?: { sheet?: { id?: unknown; name?: unknown } } } | null)?.data
  const sheetId = typeof data?.sheet?.id === 'string' ? data.sheet.id : ''
  const name = typeof data?.sheet?.name === 'string' ? data.sheet.name : ''
  return {
    sheetId,
    baseId,
    name,
    summary: {
      sourceSheetId: '', sourceName: '', baseId, targetName: name, copiedFromKind: COPIED_FROM_KIND_USER,
      rowCount: 0, fieldCount: 0, builtFieldCount: 0, viewCount: 0, disclosures: [], droppedViewFilterLeaves: [],
      autoNumberRenumberedRows: 0, nullCellsOmitted: 0, permissionRowCount: 0, fieldPermissionRowCount: 0,
      viewPermissionRowCount: 0, recordPermissionRowCount: 0, rowLevelReadEnabled: false, conditionalRuleCount: 0,
      notCopied: COPY_SHEET_NOT_COPIED, limits: { maxRows: resolveCopySheetSyncMaxRows(), maxFields: COPY_SHEET_MAX_FIELDS },
      overLimit: false,
    },
    batchId: '',
    newFieldIds: [],
    newRecordIds: [],
    formulaFieldIds: [],
  }
}
