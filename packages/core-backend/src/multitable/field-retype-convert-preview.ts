/**
 * 字段类型转换只读预览的**读库**半（第 2 刀，ADR docs/development/multitable-field-retype-first-batch-adr-20260926.md §1 / §2）。
 *
 * 只读：每条语句都是 `SELECT`，走调用方给的 `query`（路由传 `pool.query`）——不开事务、不取栅栏、不写任何表。
 * 纯计算在 field-retype-convert.ts；本文件只负责「托管表并集」判定与本表 live / 回收站单元格的读取。
 *
 * 行序：所有读取**不带** `ORDER BY`。确定性由 field-retype-convert.ts 的码元比较器在内存里保证——演示库的 PG 是
 * 中文 locale，`ORDER BY record_id` 的次序与 JS 码元序不同，依赖它会让预览与执行的 planHash 在不同库上分叉。
 */
import { isUndefinedTableError } from '../utils/database-errors'
import { isPluginManagedSheet, isSystemManagedSheet } from './sheet-delete-guard'
import type {
  FieldRetypeConvertLiveCell,
  FieldRetypeConvertManagedSheetReason,
  FieldRetypeConvertTrashCell,
} from './field-retype-convert'

export type FieldRetypeConvertQueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>

/** 插件写入列的两个命名空间（plugin-integration-core adapters/multitable-ownership-guard.cjs 的同一对）。 */
export const FIELD_RETYPE_CONVERT_PLUGIN_FIELD_NAMESPACES: readonly string[] = Object.freeze(['stockPreparation', 'stockPreparationMvp'])

function normalizeProperty(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      return null
    }
  }
  return null
}

/**
 * (c) 本表任一字段的 property 带插件命名空间（键存在即算，值为何不论——fail-closed）。在内存里判而不用 jsonb `?`：
 * 以 JSON 字符串形态存进 jsonb 的旧 property 对 `?` 是字符串标量，会漏判。
 */
export async function hasPluginTaggedFields(query: FieldRetypeConvertQueryFn, sheetId: string): Promise<boolean> {
  const res = await query('SELECT property FROM meta_fields WHERE sheet_id = $1', [sheetId])
  for (const row of res.rows as Array<{ property?: unknown }>) {
    const property = normalizeProperty(row?.property)
    if (!property) continue
    for (const ns of FIELD_RETYPE_CONVERT_PLUGIN_FIELD_NAMESPACES) {
      if (Object.prototype.hasOwnProperty.call(property, ns)) return true
    }
  }
  return false
}

/** (d) 本表是某条集成管线的 staging 表（migrations/057_create_integration_core_tables.sql `staging_sheet_id`）。 */
export async function isPipelineStagingSheet(query: FieldRetypeConvertQueryFn, sheetId: string): Promise<boolean> {
  const res = await query('SELECT 1 FROM integration_pipelines WHERE staging_sheet_id = $1 LIMIT 1', [sheetId])
  return res.rows.length > 0
}

/**
 * (e) 本表有审批投影行。**不依赖 `system_kind`**：`system_kind` 列缺失的部署窗口里建的投影表 kind 为 NULL，且投影侧
 * `ON CONFLICT (id) DO NOTHING` 永不回填（ADR §3.11 表行 19），(b) 看不见它们。
 */
export async function isApprovalProjectionSheet(query: FieldRetypeConvertQueryFn, sheetId: string): Promise<boolean> {
  const res = await query('SELECT 1 FROM approval_record_projection WHERE sheet_id = $1 LIMIT 1', [sheetId])
  return res.rows.length > 0
}

/**
 * 托管表并集（ADR §1，fail-closed，**首个命中**即返回、不再往下查）：
 *   (a) plugin_managed_sheet → (b) system_managed_sheet → (c) plugin_tagged_fields → (d) pipeline_staging_sheet →
 *   (e) approval_projection_sheet。任一查询出错即抛（路由答 5xx，同样不扫描、不签凭证）——不把「查不了」当「没命中」。
 * 只答原因、不回插件名 / 管线 / 审批标识。
 */
export async function resolveFieldRetypeConvertManagedSheetReason(
  query: FieldRetypeConvertQueryFn,
  sheetId: string,
): Promise<FieldRetypeConvertManagedSheetReason | null> {
  if (await isPluginManagedSheet(query, sheetId)) return 'plugin_managed_sheet'
  if (await isSystemManagedSheet(query, sheetId)) return 'system_managed_sheet'
  if (await hasPluginTaggedFields(query, sheetId)) return 'plugin_tagged_fields'
  if (await isPipelineStagingSheet(query, sheetId)) return 'pipeline_staging_sheet'
  if (await isApprovalProjectionSheet(query, sheetId)) return 'approval_projection_sheet'
  return null
}

function readCount(res: { rows: unknown[] }): number {
  const n = Number((res.rows[0] as { c?: unknown } | undefined)?.c ?? 0)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

/**
 * 扫描规模（live + 本表回收站），供 413 判定。回收站表不存在（迁移前）⇒ 0：那时既没有回收站行、恢复路径也不可用。
 */
export async function countFieldRetypeConvertScanRows(
  query: FieldRetypeConvertQueryFn,
  sheetId: string,
): Promise<{ live: number; trash: number }> {
  const live = readCount(await query('SELECT count(*)::int AS c FROM meta_records WHERE sheet_id = $1', [sheetId]))
  let trash = 0
  try {
    trash = readCount(await query('SELECT count(*)::int AS c FROM meta_records_trash WHERE sheet_id = $1', [sheetId]))
  } catch (err) {
    if (!isUndefinedTableError(err, 'meta_records_trash')) throw err
  }
  return { live, trash }
}

function toBool(value: unknown): boolean {
  return value === true || value === 't' || value === 'true'
}

/** 本表 live 行的目标列：只取 `data ? F` 与 `data -> F`（不取整行 data），外加 version。无 `ORDER BY`（见文件头）。 */
export async function loadFieldRetypeConvertLiveCells(
  query: FieldRetypeConvertQueryFn,
  sheetId: string,
  fieldId: string,
): Promise<FieldRetypeConvertLiveCell[]> {
  const res = await query(
    'SELECT id, version, (data ? $2::text) AS has_key, data -> $2::text AS cell FROM meta_records WHERE sheet_id = $1',
    [sheetId, fieldId],
  )
  return (res.rows as Array<{ id?: unknown; version?: unknown; has_key?: unknown; cell?: unknown }>).map((row) => ({
    recordId: String(row.id),
    version: Number(row.version ?? 0),
    hasKey: toBool(row.has_key),
    value: row.cell === undefined ? null : row.cell,
  }))
}

/** 本表回收站行的目标列（同形，无 version：回收站行没有 live 版本）。回收站表不存在 ⇒ 空。 */
export async function loadFieldRetypeConvertTrashCells(
  query: FieldRetypeConvertQueryFn,
  sheetId: string,
  fieldId: string,
): Promise<FieldRetypeConvertTrashCell[]> {
  let res: { rows: unknown[] }
  try {
    res = await query(
      'SELECT record_id, (data ? $2::text) AS has_key, data -> $2::text AS cell FROM meta_records_trash WHERE sheet_id = $1',
      [sheetId, fieldId],
    )
  } catch (err) {
    if (!isUndefinedTableError(err, 'meta_records_trash')) throw err
    return []
  }
  return (res.rows as Array<{ record_id?: unknown; has_key?: unknown; cell?: unknown }>).map((row) => ({
    recordId: String(row.record_id),
    hasKey: toBool(row.has_key),
    value: row.cell === undefined ? null : row.cell,
  }))
}
