import { canonicalReadId } from './automation-read-contracts'
import { AutomationTargetAuthorityError, lockAutomationReadTarget } from './automation-read-target-authority'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { injectSystemFieldValues } from '../multitable/record-system-fields'

export type AutomationReadTargetRecordsInput = {
  actorId: string
  baseId: string
  sheetId: string
  fieldIds: string[]
  projectNo: string
  projectFieldId: string
  activeFieldId: string
  maxRows: number
  maxQueries: number
  signal: AbortSignal
}

type FrozenJson = null | string | number | boolean | readonly FrozenJson[]
  | { readonly [key: string]: FrozenJson }

export type AutomationReadTargetRecord = Readonly<{
  id: string
  sheetId: string
  data: Readonly<Record<string, FrozenJson>>
  createdBy?: string
}>

export type AutomationReadTargetRecordsQuery = {
  sheetId: string
  filters: Record<string, string>
  limit: number
  offset: number
}

export type AutomationReadTargetRecords = Readonly<{
  queryRecords(input: AutomationReadTargetRecordsQuery): Promise<readonly AutomationReadTargetRecord[]>
  close(): void
}>

export type AutomationTargetRecordsErrorCode =
  | 'AUTOMATION_TARGET_RECORDS_INPUT_INVALID'
  | 'AUTOMATION_TARGET_RECORDS_UNAVAILABLE'
  | 'AUTOMATION_TARGET_RECORDS_PROJECTION_INVALID'
  | 'AUTOMATION_TARGET_RECORDS_ROW_LIMIT_EXCEEDED'
  | 'AUTOMATION_TARGET_RECORDS_QUERY_LIMIT_EXCEEDED'
  | 'AUTOMATION_TARGET_RECORDS_ABORTED'
  | 'AUTOMATION_TARGET_RECORDS_CLOSED'

export class AutomationTargetRecordsError extends Error {
  constructor(readonly code: AutomationTargetRecordsErrorCode) {
    super(code)
    this.name = 'AutomationTargetRecordsError'
  }
}

function fail(code: AutomationTargetRecordsErrorCode): never { throw new AutomationTargetRecordsError(code) }
function invalid(): never { return fail('AUTOMATION_TARGET_RECORDS_INPUT_INVALID') }
function projectionInvalid(): never { return fail('AUTOMATION_TARGET_RECORDS_PROJECTION_INVALID') }
function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}
function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return plainObject(value) && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'))
}
function boundedInteger(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max
}
function frozenJson(value: unknown): FrozenJson {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return Object.freeze(Array.from(value, frozenJson))
  if (!plainObject(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string')) return projectionInvalid()
  return Object.freeze(Object.fromEntries(Object.keys(value).map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return projectionInvalid()
    return [key, frozenJson(descriptor.value)]
  })))
}

const inputKeys = ['actorId', 'baseId', 'sheetId', 'fieldIds', 'projectNo', 'projectFieldId',
  'activeFieldId', 'maxRows', 'maxQueries', 'signal'] as const
const rowKeys = ['id', 'data_type', 'matches_project', 'projected_data',
  'created_at', 'updated_at', 'created_by', 'modified_by'] as const
const systemTypes = new Set(['createdTime', 'modifiedTime', 'createdBy', 'modifiedBy'])

/**
 * HOST-PRIVATE, unwired, bounded memory snapshot. The live target prerequisite is
 * called here on the caller's SAME real RC transaction; no supplied proof or cached
 * authority can replace it. Caller still owns live actor/source/rule/deployment
 * authorization and commit/rollback. This is not a complete host/provider port.
 *
 * One bounded statement reads the whole sheet in id order. PostgreSQL compares raw
 * stored data ->> project field, just like queryRecords; system fields are injected
 * afterwards with the unchanged shared mapper. Thus project matching intentionally
 * precedes system injection, while the whole-sheet scan sees injected project/active
 * cells. Foreign rows never bring unrelated data or system metadata into this module.
 *
 * Replays use immutable memory only: complete for this one statement's snapshot,
 * not a continuing DB/permission lease. Caller must close it and revalidate before
 * source IO/result publication. No writes, transaction control, external IO or host
 * registration; no production caller can use this as a general records API.
 */
export async function loadAutomationReadTargetRecords(
  trx: Queryable,
  input: AutomationReadTargetRecordsInput,
): Promise<AutomationReadTargetRecords> {
  if (!exactKeys(input, inputKeys)) invalid()
  const { actorId, baseId, sheetId, projectNo, projectFieldId, activeFieldId, maxRows, maxQueries, signal } = input
  const fieldIds = Array.isArray(input.fieldIds) ? [...input.fieldIds] : []
  if (![actorId, baseId, sheetId, projectNo, projectFieldId, activeFieldId].every(canonicalReadId)
    || fieldIds.length < 2 || fieldIds.length > 256 || !fieldIds.every(canonicalReadId)
    || new Set(fieldIds).size !== fieldIds.length || projectFieldId === activeFieldId
    || !fieldIds.includes(projectFieldId) || !fieldIds.includes(activeFieldId)
    || !boundedInteger(maxRows, 1, 100000) || !boundedInteger(maxQueries, 1, 200)
    || !(signal instanceof AbortSignal)) invalid()
  fieldIds.sort()
  const scanFieldIds = [activeFieldId, projectFieldId].sort()
  const checkAbort = (): void => {
    if (signal.aborted) fail('AUTOMATION_TARGET_RECORDS_ABORTED')
  }
  // This wrapper applies the caller's abort to EVERY gate/metadata/record query,
  // not just the final SELECT. No query may start after cancellation is observed.
  const query = async (sql: string, params?: unknown[]) => {
    checkAbort()
    const result = await trx.query(sql, params)
    checkAbort()
    return result
  }
  try {
    checkAbort()
    await lockAutomationReadTarget({ query }, { actorId, baseId, sheetId, fieldIds })
    checkAbort()
    // The gate already holds these rows; keep the production authority helper's
    // narrow return unchanged and read only mapper metadata from the same handle.
    const metadata = (await query(`SELECT id, type FROM meta_fields
      WHERE sheet_id = $1 AND id = ANY($2::text[]) ORDER BY id`, [sheetId, fieldIds])).rows
    if (metadata.length !== fieldIds.length || new Set(metadata.map(field => field.id)).size !== fieldIds.length) projectionInvalid()
    const fields = metadata.map(field => {
      if (!exactKeys(field, ['id', 'type']) || typeof field.id !== 'string' || !fieldIds.includes(field.id)
        || typeof field.type !== 'string' || !field.type) projectionInvalid()
      return { id: field.id, type: field.type }
    })
    const scanFields = fields.filter(field => scanFieldIds.includes(field.id))
    const requiredSystemTypes = fields.filter(field => systemTypes.has(field.type)).map(field => field.type)
    const scanSystemTypes = scanFields.filter(field => systemTypes.has(field.type)).map(field => field.type)
    const result = await query(`SELECT r.id, pg_catalog.jsonb_typeof(r.data) AS data_type,
      project_match.matches_project,
      (SELECT COALESCE(pg_catalog.jsonb_object_agg(cell.key, cell.value), '{}'::jsonb)
         FROM pg_catalog.jsonb_each(CASE WHEN pg_catalog.jsonb_typeof(r.data) = 'object'
           THEN r.data ELSE '{}'::jsonb END) AS cell
        WHERE cell.key = ANY(CASE WHEN project_match.matches_project THEN $4::text[] ELSE $5::text[] END)
      ) AS projected_data,
      CASE WHEN (project_match.matches_project AND 'createdTime' = ANY($7::text[]))
        OR 'createdTime' = ANY($8::text[]) THEN r.created_at ELSE NULL END AS created_at,
      CASE WHEN (project_match.matches_project AND 'modifiedTime' = ANY($7::text[]))
        OR 'modifiedTime' = ANY($8::text[]) THEN r.updated_at ELSE NULL END AS updated_at,
      CASE WHEN project_match.matches_project OR 'createdBy' = ANY($8::text[])
        THEN r.created_by ELSE NULL END AS created_by,
      CASE WHEN (project_match.matches_project AND 'modifiedBy' = ANY($7::text[]))
        OR 'modifiedBy' = ANY($8::text[]) THEN r.modified_by ELSE NULL END AS modified_by
      FROM meta_records r
      CROSS JOIN LATERAL (SELECT COALESCE(r.data ->> $2::text = $3::text, false) AS matches_project) AS project_match
      WHERE r.sheet_id = $1 ORDER BY r.id LIMIT $6`,
    [sheetId, projectFieldId, projectNo, fieldIds, scanFieldIds, maxRows + 1, requiredSystemTypes, scanSystemTypes])
    if (result.rows.length > maxRows) fail('AUTOMATION_TARGET_RECORDS_ROW_LIMIT_EXCEEDED')

    const whole: AutomationReadTargetRecord[] = [], project: AutomationReadTargetRecord[] = []
    const seen = new Set<string>()
    for (const row of result.rows) {
      if (!exactKeys(row, rowKeys) || !canonicalReadId(row.id) || seen.has(row.id)
        || row.data_type !== 'object' || typeof row.matches_project !== 'boolean'
        || !plainObject(row.projected_data)) projectionInvalid()
      seen.add(row.id)
      const allowedIds = row.matches_project ? fieldIds : scanFieldIds
      if (Reflect.ownKeys(row.projected_data).some(key => typeof key !== 'string' || !allowedIds.includes(key))) projectionInvalid()
      const rowFields = row.matches_project ? fields : scanFields
      const needs = new Set(rowFields.map(field => field.type))
      for (const [key, type] of [['created_at', 'createdTime'], ['updated_at', 'modifiedTime'],
        ['created_by', 'createdBy'], ['modified_by', 'modifiedBy']] as const) {
        const needed = needs.has(type) || (key === 'created_by' && row.matches_project)
        if (!needed && row[key] !== null) projectionInvalid()
        if (row[key] !== null && (key.endsWith('_by') ? typeof row[key] !== 'string'
          : typeof row[key] !== 'string' && !(row[key] instanceof Date))) projectionInvalid()
      }
      const copied = frozenJson(row.projected_data) as Readonly<Record<string, FrozenJson>>
      const mapped = frozenJson(injectSystemFieldValues(copied, row, rowFields)) as Readonly<Record<string, FrozenJson>>
      const scanData = Object.fromEntries(scanFieldIds.filter(key => Object.hasOwn(mapped, key)).map(key => [key, mapped[key]]))
      whole.push(Object.freeze({ id: row.id, sheetId, data: Object.freeze(scanData) }))
      if (row.matches_project) project.push(Object.freeze({ id: row.id, sheetId, data: mapped,
        ...(typeof row.created_by === 'string' ? { createdBy: row.created_by } : {}),
      }))
    }
    checkAbort()
    let snapshot: { whole: readonly AutomationReadTargetRecord[]; project: readonly AutomationReadTargetRecord[] } | null = {
      whole: Object.freeze(whole), project: Object.freeze(project),
    }
    let queryCount = 0
    return Object.freeze({
      async queryRecords(request: AutomationReadTargetRecordsQuery): Promise<readonly AutomationReadTargetRecord[]> {
        checkAbort()
        if (!snapshot) fail('AUTOMATION_TARGET_RECORDS_CLOSED')
        // Count every replay attempt, including malformed calls; this is a finite
        // per-snapshot request budget, not a new database query budget.
        if (++queryCount > maxQueries) fail('AUTOMATION_TARGET_RECORDS_QUERY_LIMIT_EXCEEDED')
        if (!exactKeys(request, ['sheetId', 'filters', 'limit', 'offset']) || request.sheetId !== sheetId
          || !boundedInteger(request.limit, 1, 1000) || !boundedInteger(request.offset, 0, 100000)) invalid()
        const all = exactKeys(request.filters, [])
        if (!all && (!exactKeys(request.filters, [projectFieldId]) || request.filters[projectFieldId] !== projectNo)) invalid()
        const page = (all ? snapshot.whole : snapshot.project).slice(request.offset, request.offset + request.limit)
        checkAbort()
        return Object.freeze(page)
      },
      close(): void { snapshot = null },
    })
  } catch (error) {
    // Abort can be caught and sanitized by the nested target gate; restore only
    // our fixed cancellation code, never the AbortSignal's arbitrary reason.
    checkAbort()
    if (error instanceof AutomationTargetRecordsError || error instanceof AutomationTargetAuthorityError) throw error
    fail('AUTOMATION_TARGET_RECORDS_UNAVAILABLE')
  }
}
