/**
 * Task feature — the task → multitable projection, pure part: base / sheet / record / field id
 * derivation and the two candidate-id patterns, the column catalog and view specs, one projected
 * row plus its no-op digest, the capability clamp for projection sheets, the interaction `canEdit`
 * and the row-readability predicate. PURE, no I/O; the sha256 function is supplied by the caller
 * (no `crypto` import under `src/tasks`).
 *
 * Design: docs/development/task-e-m5-pure-functions-design-20261007.md §2.7
 * Lock:   task-feature-design-lock-20260917.md §7 (PK `(list_id, task_id)`, record id
 *         `rec_tsk_<listId>__<taskId>` and its parser, `canEdit` = list edit/owner, version from the
 *         mapping row), §4.4 (`due_at` for all-day = 23:59:59.999 in the task zone)
 *
 * Record ids pair with `task-ids.ts`'s `parseTaskProjectionRecordId` (already on main): the
 * deriver accepts exactly the (listId, taskId) pairs the parser can return.
 */
import type { TaskListMembership } from './task-access'
import { computeDueAt } from './task-dates'
import {
  TASK_FIELD_TYPES,
  type TaskFieldDefinition,
  type TaskMemberFieldConfig,
  type TaskNumberFieldConfig,
  type TaskOptionFieldConfig,
} from './task-fields'
import { isValidPrintableAsciiId, isValidTaskDomainId } from './task-ids'

export const TASK_PROJECTION_SYSTEM_KIND = 'task_projection' as const
// RULED(2026-10-09): [S03] provisioning re-checks that the base and sheet rows it finds are owned by
// this system owner and carry this kind; anything else fails instead of being reused.
export const TASK_PROJECTION_SYSTEM_OWNER = 'system:task-projection' as const

const BASE_ID_PREFIX = 'base_tsk_proj_'
const SHEET_ID_PREFIX = 'sht_tsk_proj_'
const RECORD_ID_PREFIX = 'rec_tsk_'
// RULED(2026-10-09): [S03] the two candidate-id patterns the base / sheet create routes refuse.
// They are written here once; the routes and their tests import them from here.
const BASE_ID_CANDIDATE_RE = /^base_tsk_proj_[a-f0-9]{32}$/
const SHEET_ID_CANDIDATE_RE = /^sht_tsk_proj_tlst_[A-Za-z0-9]+$/
const LIST_ID_RE = /^tlst_[A-Za-z0-9]+$/
// RULED(2026-10-09): [S30] custom field ids carry the `tfld_` prefix.
// ASSUMPTION(task-e): [D13] written here until PR-4a S0 adds `field: 'tfld'` to `TASK_ID_PREFIXES`;
// then this should derive from there.
const CUSTOM_FIELD_KEY_RE = /^tfld_[A-Za-z0-9]+$/
const SHA256_HEX_RE = /^[a-f0-9]{64}$/

/** Caller-supplied sha256: UTF-8 input, 64 lower-case hex characters out. */
export type TaskProjectionSha256Hex = (input: string) => string

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function digestOf(text: string, sha256Hex: unknown, fn: string): string {
  if (typeof sha256Hex !== 'function') throw new TypeError(`${fn}: sha256Hex must be a function`)
  const digest = (sha256Hex as TaskProjectionSha256Hex)(text)
  if (typeof digest !== 'string' || !SHA256_HEX_RE.test(digest)) {
    throw new TypeError(`${fn}: sha256Hex must return 64 lower-case hex characters`)
  }
  return digest
}

// ── Ids (S03) ──────────────────────────────────────────────────────────────────────────────────

// RULED(2026-10-09): [S03] one projection base per org: `base_tsk_proj_` + the first 32 hex
// characters of sha256(orgId). The org id is used exactly as stored (no trimming).
export function deriveTaskProjectionBaseId(orgId: string, sha256Hex: TaskProjectionSha256Hex): string {
  const fn = 'deriveTaskProjectionBaseId'
  if (!isValidPrintableAsciiId(orgId)) throw new TypeError(`${fn}: orgId must be a printable id`)
  return `${BASE_ID_PREFIX}${digestOf(orgId, sha256Hex, fn).slice(0, 32)}`
}

// RULED(2026-10-09): [S03] one sheet per list: `sht_tsk_proj_<listId>`, the list id used as is.
// Only a generated list id (`tlst_` + alphanumerics) is accepted, so every derived sheet id matches
// the sheet candidate pattern.
export function deriveTaskProjectionSheetId(listId: string): string {
  if (typeof listId !== 'string' || !LIST_ID_RE.test(listId)) {
    throw new TypeError('deriveTaskProjectionSheetId: listId must be a generated list id (tlst_…)')
  }
  return `${SHEET_ID_PREFIX}${listId}`
}

/** `rec_tsk_<listId>__<taskId>` — accepts exactly the pairs `parseTaskProjectionRecordId` returns. */
export function deriveTaskProjectionRecordId(listId: string, taskId: string): string {
  if (!isValidTaskDomainId(listId) || !isValidTaskDomainId(taskId)) {
    throw new TypeError('deriveTaskProjectionRecordId: listId and taskId must be valid task-domain ids')
  }
  return `${RECORD_ID_PREFIX}${listId}__${taskId}`
}

export function isTaskProjectionBaseIdCandidate(id: unknown): boolean {
  return typeof id === 'string' && BASE_ID_CANDIDATE_RE.test(id)
}

export function isTaskProjectionSheetIdCandidate(id: unknown): boolean {
  return typeof id === 'string' && SHEET_ID_CANDIDATE_RE.test(id)
}

// ── Columns and views (S05 / D7) ───────────────────────────────────────────────────────────────

export type TaskProjectionColumnType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'dateTime'
  | 'select'
  | 'multiSelect'
  | 'person'
  | 'link'

export const TASK_PROJECTION_BUILTIN_KEYS = [
  'title',
  'status',
  'assignees',
  'creator',
  'startDate',
  'dueDate',
  'completedAt',
  'isMilestone',
  'taskVersion',
  'dependencies',
  'listGroup',
] as const
export type TaskProjectionBuiltinKey = (typeof TASK_PROJECTION_BUILTIN_KEYS)[number]

// ASSUMPTION(task-e, own choice): the column display names.
const BUILTIN_LABELS: Record<TaskProjectionBuiltinKey, string> = {
  title: '标题',
  status: '状态',
  assignees: '负责人',
  creator: '创建人',
  startDate: '开始时间',
  dueDate: '截止时间',
  completedAt: '完成时间',
  isMilestone: '里程碑',
  taskVersion: '版本',
  dependencies: '前置任务',
  listGroup: '分组',
}

// RULED(2026-10-09): [S03] a projection field id is `${sheetId}__<key>`.
/** `<sheetId>__<key>`: `key` is a built-in column key or a custom field id (`tfld_…`). */
export function deriveTaskProjectionFieldId(sheetId: string, key: string): string {
  const fn = 'deriveTaskProjectionFieldId'
  if (!isTaskProjectionSheetIdCandidate(sheetId)) throw new TypeError(`${fn}: sheetId must be a task projection sheet id`)
  const builtin = (TASK_PROJECTION_BUILTIN_KEYS as readonly string[]).includes(key)
  if (typeof key !== 'string' || (!builtin && !CUSTOM_FIELD_KEY_RE.test(key))) {
    throw new TypeError(`${fn}: key must be a built-in column key or a custom field id`)
  }
  return `${sheetId}__${key}`
}

export interface TaskProjectionColumn {
  key: string
  fieldId: string
  label: string
  type: TaskProjectionColumnType
  property: Record<string, unknown>
  readOnly: boolean
}

// RULED(2026-10-09): [S05] as soon as any task has a time of day, start and due are both `dateTime`
// columns.
// ASSUMPTION(task-e): [D7] a list whose tasks are all all-day projects start/due as `date` columns.
export function resolveTaskProjectionDateColumnType(tasks: readonly { dueTime: string | null; startTime: string | null }[]): 'date' | 'dateTime' {
  if (!Array.isArray(tasks) || tasks.some((t) => !isPlainObject(t))) {
    throw new TypeError('resolveTaskProjectionDateColumnType: tasks must be an array of objects')
  }
  return tasks.some((t) => (t.dueTime !== null && t.dueTime !== undefined) || (t.startTime !== null && t.startTime !== undefined))
    ? 'dateTime'
    : 'date'
}

// RULED(2026-10-09): [S25] custom field types map onto the multitable types: text → string,
// number → number (`decimals` kept), select / multiSelect → select / multiSelect with the option
// LABELS, member → person, date → date.
// ASSUMPTION(task-e, own choice): the percent format of a number field is not rendered in the
// projection.
function customColumnShape(def: TaskFieldDefinition): { type: TaskProjectionColumnType; property: Record<string, unknown> } {
  switch (def.type) {
    case 'text':
      return { type: 'string', property: {} }
    case 'number':
      return { type: 'number', property: { decimals: (def.config as TaskNumberFieldConfig).decimals } }
    case 'select':
    case 'multiSelect':
      return {
        type: def.type,
        property: {
          options: (def.config as TaskOptionFieldConfig).options.map((o) => (o.color ? { value: o.label, color: o.color } : { value: o.label })),
        },
      }
    case 'member':
      return { type: 'person', property: { limitSingleRecord: (def.config as TaskMemberFieldConfig).single === true } }
    case 'date':
      return { type: 'date', property: {} }
    default:
      throw new TypeError('taskProjectionColumns: unknown custom field type')
  }
}

function requireBoundFields(boundFields: unknown, fn: string): TaskFieldDefinition[] {
  if (!Array.isArray(boundFields)) throw new TypeError(`${fn}: boundFields must be an array`)
  for (const def of boundFields) {
    if (!isPlainObject(def) || typeof def.id !== 'string' || !CUSTOM_FIELD_KEY_RE.test(def.id) || typeof def.name !== 'string' || !isPlainObject(def.config)) {
      throw new TypeError(`${fn}: every bound field needs a tfld_ id, a name and a config`)
    }
    // The closed type set (S25) holds for the row data as well as for the column catalog.
    if (!(TASK_FIELD_TYPES as readonly unknown[]).includes(def.type)) {
      throw new TypeError(`${fn}: every bound field needs a type of the closed set`)
    }
    if ((def.type === 'select' || def.type === 'multiSelect') && !Array.isArray(def.config.options)) {
      throw new TypeError(`${fn}: an option field needs config.options`)
    }
  }
  return boundFields as TaskFieldDefinition[]
}

function requireDateColumnType(value: unknown, fn: string): 'date' | 'dateTime' {
  if (value !== 'date' && value !== 'dateTime') throw new TypeError(`${fn}: dateColumnType must be 'date' or 'dateTime'`)
  return value
}

// ASSUMPTION(task-e): [D7] the column catalog: title, status (open/done), assignees, creator,
// start/due (date or dateTime), completedAt, isMilestone (boolean), taskVersion (read-only number:
// the task version at projection time), dependencies (self link), listGroup (the list's group
// names), then the list's bound custom fields in binding order.
/** Every column of one list's projection sheet, in catalog order. */
export function taskProjectionColumns(input: {
  listId: string
  dateColumnType: 'date' | 'dateTime'
  groupNames: readonly string[]
  boundFields: readonly TaskFieldDefinition[]
}): TaskProjectionColumn[] {
  const fn = 'taskProjectionColumns'
  if (!isPlainObject(input)) throw new TypeError(`${fn}: input must be an object`)
  const sheetId = deriveTaskProjectionSheetId(input.listId)
  const dateType = requireDateColumnType(input.dateColumnType, fn)
  if (!Array.isArray(input.groupNames) || input.groupNames.some((n) => typeof n !== 'string')) {
    throw new TypeError(`${fn}: groupNames must be an array of strings`)
  }
  const boundFields = requireBoundFields(input.boundFields, fn)
  const builtinShape: Record<TaskProjectionBuiltinKey, { type: TaskProjectionColumnType; property: Record<string, unknown>; readOnly?: boolean }> = {
    title: { type: 'string', property: {} },
    status: { type: 'select', property: { options: [{ value: 'open' }, { value: 'done' }] } },
    assignees: { type: 'person', property: { limitSingleRecord: false } },
    creator: { type: 'person', property: { limitSingleRecord: true } },
    startDate: { type: dateType, property: {} },
    dueDate: { type: dateType, property: {} },
    completedAt: { type: 'dateTime', property: {} },
    isMilestone: { type: 'boolean', property: {} },
    taskVersion: { type: 'number', property: { decimals: 0 }, readOnly: true },
    dependencies: { type: 'link', property: { foreignSheetId: sheetId } },
    listGroup: { type: 'select', property: { options: [...new Set(input.groupNames)].map((value) => ({ value })) } },
  }
  const columns: TaskProjectionColumn[] = TASK_PROJECTION_BUILTIN_KEYS.map((key) => ({
    key,
    fieldId: deriveTaskProjectionFieldId(sheetId, key),
    label: BUILTIN_LABELS[key],
    type: builtinShape[key].type,
    property: builtinShape[key].property,
    readOnly: builtinShape[key].readOnly === true,
  }))
  for (const def of boundFields) {
    const shape = customColumnShape(def)
    columns.push({ key: def.id, fieldId: deriveTaskProjectionFieldId(sheetId, def.id), label: def.name, type: shape.type, property: shape.property, readOnly: false })
  }
  return columns
}

// ASSUMPTION(task-e): [D7] every provisioned view carries this marker key in its config; the
// projection endpoint finds views by the marker (not by view type) and re-creates a missing one.
export const TASK_PROJECTION_VIEW_MARKER = 'taskProjectionView' as const
export const TASK_PROJECTION_VIEW_KINDS = ['grid', 'kanban', 'gantt'] as const
export type TaskProjectionViewKind = (typeof TASK_PROJECTION_VIEW_KINDS)[number]

export interface TaskProjectionViewSpec {
  kind: TaskProjectionViewKind
  type: TaskProjectionViewKind
  name: string
  config: Record<string, unknown>
}

// ASSUMPTION(task-e): [D7] grid (default), kanban grouped by status, gantt from startDate to dueDate
// with the dependencies column as its dependency field.
// ASSUMPTION(task-e, own choice): the view display names.
export function buildTaskProjectionViewSpecs(listId: string): TaskProjectionViewSpec[] {
  const sheetId = deriveTaskProjectionSheetId(listId)
  const field = (key: TaskProjectionBuiltinKey) => deriveTaskProjectionFieldId(sheetId, key)
  return [
    { kind: 'grid', type: 'grid', name: '表格', config: { [TASK_PROJECTION_VIEW_MARKER]: 'grid' } },
    { kind: 'kanban', type: 'kanban', name: '看板', config: { [TASK_PROJECTION_VIEW_MARKER]: 'kanban', groupFieldId: field('status') } },
    {
      kind: 'gantt',
      type: 'gantt',
      name: '甘特图',
      config: {
        [TASK_PROJECTION_VIEW_MARKER]: 'gantt',
        startFieldId: field('startDate'),
        endFieldId: field('dueDate'),
        titleFieldId: field('title'),
        dependencyFieldId: field('dependencies'),
      },
    },
  ]
}

// ── One projected row + no-op digest (S08 / D9) ────────────────────────────────────────────────

export interface TaskProjectionTaskInput {
  id: string
  title: string
  status: 'open' | 'done'
  createdBy: string
  timeZone: string
  startDate: string | null
  startTime: string | null
  dueDate: string | null
  dueTime: string | null
  completedAt: Date | null
  isMilestone: boolean
  /** `tasks.version` at projection time. */
  version: number
}

export interface TaskProjectionLink {
  fieldId: string
  fromRecordId: string
  toRecordId: string
}

export interface ProjectedTaskRow {
  recordId: string
  data: Record<string, unknown>
  links: TaskProjectionLink[]
  digest: string
}

/** A plain JSON object: not an array, not a Date / Map / class instance. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function canonicalJson(value: unknown, fn: string): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${fn}: projected numbers must be finite`)
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, fn)).join(',')}]`
  if (isJsonObject(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], fn)}`).join(',')}}`
  }
  throw new TypeError(`${fn}: projected values must be JSON values`)
}

// RULED(2026-10-09): [S08] "did the projection change" is answered by a content digest, not by
// `tasks.version`. When the digest is unchanged the service skips the record writes but still moves
// the mapping row's projected version up to the current task version.
// ASSUMPTION(task-e): [D9] the digest is sha256 over a canonical serialization (object keys sorted;
// set-like arrays are already sorted in the row itself) of the projected payload (`projectTaskRow`'s
// `data` + `links`), not of a stored record read back from the table; the link writes are skipped
// along with the record writes, and the digest never leaves the service layer.
export function taskProjectionNoopDigest(
  projected: { data: Record<string, unknown>; links: readonly TaskProjectionLink[] },
  sha256Hex: TaskProjectionSha256Hex,
): string {
  const fn = 'taskProjectionNoopDigest'
  if (!isPlainObject(projected) || !isPlainObject(projected.data) || !Array.isArray(projected.links)) {
    throw new TypeError(`${fn}: the input must be { data, links }`)
  }
  const { data, links } = projected
  return digestOf(canonicalJson({ data, links }, fn), sha256Hex, fn)
}

function requireTask(task: unknown, fn: string): TaskProjectionTaskInput {
  if (!isPlainObject(task)) throw new TypeError(`${fn}: task must be an object`)
  const t = task as unknown as TaskProjectionTaskInput
  if (!isValidTaskDomainId(t.id)) throw new TypeError(`${fn}: task.id must be a valid task id`)
  if (typeof t.title !== 'string') throw new TypeError(`${fn}: task.title must be a string`)
  if (t.status !== 'open' && t.status !== 'done') throw new TypeError(`${fn}: task.status must be open|done`)
  if (!isValidPrintableAsciiId(t.createdBy)) throw new TypeError(`${fn}: task.createdBy must be a printable id`)
  if (typeof t.timeZone !== 'string' || t.timeZone.length === 0) throw new TypeError(`${fn}: task.timeZone must be a non-empty string`)
  for (const key of ['startDate', 'startTime', 'dueDate', 'dueTime'] as const) {
    if (t[key] !== null && typeof t[key] !== 'string') throw new TypeError(`${fn}: task.${key} must be a string or null`)
  }
  if (t.completedAt !== null && (!(t.completedAt instanceof Date) || Number.isNaN(t.completedAt.getTime()))) {
    throw new TypeError(`${fn}: task.completedAt must be a valid Date or null`)
  }
  if (typeof t.isMilestone !== 'boolean') throw new TypeError(`${fn}: task.isMilestone must be a boolean`)
  if (typeof t.version !== 'number' || !Number.isSafeInteger(t.version) || t.version < 0) {
    throw new TypeError(`${fn}: task.version must be a non-negative integer`)
  }
  return t
}

/**
 * One start or due value. In a `date` column: the civil date. In a `dateTime` column: the instant of
 * (date, time) in the task zone; without a time, a DUE is 23:59:59.999 of its day (= `due_at`) and a
 * START is the first instant of its day, both through `computeDueAt`'s wall-clock conversion.
 */
function projectDate(date: string | null, time: string | null, timeZone: string, columnType: 'date' | 'dateTime', edge: 'start' | 'due'): string | null {
  if (date === null) return null
  if (columnType === 'date') return date
  const wallTime = time === null && edge === 'start' ? '00:00' : time
  return computeDueAt({ dueDate: date, dueTime: wallTime, timeZone }).toISOString()
}

function projectCustomValue(def: TaskFieldDefinition, stored: unknown): unknown {
  if (stored === null || stored === undefined) return null
  if (def.type === 'select') {
    const option = (def.config as TaskOptionFieldConfig).options.find((o) => o.id === stored)
    return option ? option.label : null
  }
  if (def.type === 'multiSelect') {
    if (!Array.isArray(stored)) return null
    const labelOf = new Map((def.config as TaskOptionFieldConfig).options.map((o) => [o.id, o.label]))
    const labels = stored.filter((id) => labelOf.has(id)).map((id) => labelOf.get(id) as string)
    return labels.length === 0 ? null : labels
  }
  return stored
}

function requireIdList(value: unknown, name: string, fn: string): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new TypeError(`${fn}: ${name} must be an array of non-empty strings`)
  }
  return value as string[]
}

// RULED(2026-10-09): [S05] start/due in a `dateTime` column are instants in the task's own zone: a
// timed value at its (date, time); an untimed DUE at 23:59:59.999 (the same rule as `due_at`). The
// dependencies column holds this list's predecessors only (cross-list edges are not drawn), and the
// same edges are returned as `links` for the link table.
// ASSUMPTION(task-e, own choice): an untimed START is 00:00:00.000 of its day in the task zone, not
// 23:59:59.999: an all-day task then spans its whole day and an untimed start never lands after a
// same-day due. S05 (ruled) and D7 state the 23:59:59.999 rule for start and due together, and tie
// it to `due_at`, which only due has; this departs from the ruled text, is recorded as a deviation
// in the design doc (§3 item 17) and waits for the owner.
// RULED(2026-10-09): [S06] `taskVersion` carries `tasks.version`, so the client sends it back as
// `expectedVersion` (never the multitable record's own version).
/**
 * One task as one row of one list's projection sheet. Set-like arrays (assignees, dependencies,
 * links) are sorted so the same task state always gives the same row; custom multi-value fields
 * keep their stored order. Select values are projected as labels; an option id that no longer
 * exists projects as nothing.
 */
export function projectTaskRow(input: {
  listId: string
  task: TaskProjectionTaskInput
  assigneeIds: readonly string[]
  dateColumnType: 'date' | 'dateTime'
  /** Task ids of this task's predecessors that are in the same list (filtered by the caller). */
  predecessorIdsInList: readonly string[]
  groupName: string | null
  boundFields: readonly TaskFieldDefinition[]
  fieldValues: readonly { fieldId: string; value: unknown }[]
  sha256Hex: TaskProjectionSha256Hex
}): ProjectedTaskRow {
  const fn = 'projectTaskRow'
  if (!isPlainObject(input)) throw new TypeError(`${fn}: input must be an object`)
  const sheetId = deriveTaskProjectionSheetId(input.listId)
  const task = requireTask(input.task, fn)
  const dateType = requireDateColumnType(input.dateColumnType, fn)
  const assignees = [...new Set(requireIdList(input.assigneeIds, 'assigneeIds', fn))].sort()
  const predecessors = [...new Set(requireIdList(input.predecessorIdsInList, 'predecessorIdsInList', fn))]
  if (input.groupName !== null && typeof input.groupName !== 'string') throw new TypeError(`${fn}: groupName must be a string or null`)
  const boundFields = requireBoundFields(input.boundFields, fn)
  if (!Array.isArray(input.fieldValues) || input.fieldValues.some((v) => !isPlainObject(v) || typeof v.fieldId !== 'string')) {
    throw new TypeError(`${fn}: fieldValues must be an array of { fieldId, value }`)
  }
  const recordId = deriveTaskProjectionRecordId(input.listId, task.id)
  const field = (key: string) => deriveTaskProjectionFieldId(sheetId, key)
  const predecessorRecordIds = predecessors.map((id) => deriveTaskProjectionRecordId(input.listId, id)).sort()
  const data: Record<string, unknown> = {
    [field('title')]: task.title,
    [field('status')]: task.status,
    [field('assignees')]: assignees,
    [field('creator')]: [task.createdBy],
    [field('startDate')]: projectDate(task.startDate, task.startTime, task.timeZone, dateType, 'start'),
    [field('dueDate')]: projectDate(task.dueDate, task.dueTime, task.timeZone, dateType, 'due'),
    [field('completedAt')]: task.completedAt === null ? null : task.completedAt.toISOString(),
    [field('isMilestone')]: task.isMilestone,
    [field('taskVersion')]: task.version,
    [field('dependencies')]: predecessorRecordIds,
    [field('listGroup')]: input.groupName,
  }
  const stored = new Map(input.fieldValues.map((v) => [v.fieldId, v.value]))
  for (const def of boundFields) {
    data[field(def.id)] = projectCustomValue(def, stored.get(def.id))
  }
  const links = predecessorRecordIds.map((toRecordId) => ({ fieldId: field('dependencies'), fromRecordId: recordId, toRecordId }))
  return { recordId, data, links, digest: taskProjectionNoopDigest({ data, links }, input.sha256Hex) }
}

// ── Capabilities and visibility (S01 / S02 / S06 / S36) ────────────────────────────────────────

// RULED(2026-10-09): [S01] on a projection sheet these nine write capabilities are false for
// EVERYONE — there is deliberately no administrator parameter anywhere in this section.
export const TASK_PROJECTION_DENIED_CAPABILITY_KEYS = [
  'canCreateRecord',
  'canEditRecord',
  'canDeleteRecord',
  'canManageFields',
  'canManageSheetAccess',
  'canComment',
  'canManageAutomation',
  'canSendNotification',
  'canSubmitApproval',
] as const

/**
 * The viewer's role on the sheet's list as seen under the SESSION tenant: `null` when the viewer is
 * not a member, when the list's org is not the session tenant, or when the caller has no tenant
 * context at all. (The tenant comparison happens where the role is loaded — S01 / S02.)
 */
export type TaskProjectionViewerListRole = TaskListMembership['role'] | null

function requireViewerListRole(role: unknown, fn: string): TaskProjectionViewerListRole {
  if (role !== null && role !== 'editor' && role !== 'reader') {
    throw new TypeError(`${fn}: viewerListRole must be 'editor', 'reader' or null`)
  }
  return role as TaskProjectionViewerListRole
}

function requireBoolean(value: unknown, name: string, fn: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${fn}: ${name} must be a boolean`)
  return value
}

// RULED(2026-10-09): [S01] read = list member; export = never (the task line has its own CSV
// export, S10); arranging views = list edit/owner. [S36] an archived list's sheet is read-only for
// view arrangement too.
/**
 * Not a projection sheet ⇒ `capabilities` unchanged (same object). A projection sheet ⇒ a copy
 * with the nine write keys false (a key the input does not have is not added), `canRead` = member,
 * `canExport` = false, `canManageViews` = editor on a list that is not archived.
 */
export function restrictTaskProjectionCapabilities<T extends { canRead: boolean; canExport: boolean; canManageViews: boolean }>(
  capabilities: T,
  isProjectionSheet: boolean,
  viewerListRole: TaskProjectionViewerListRole,
  listArchived: boolean,
): T {
  const fn = 'restrictTaskProjectionCapabilities'
  if (!isPlainObject(capabilities)) throw new TypeError(`${fn}: capabilities must be an object`)
  const projection = requireBoolean(isProjectionSheet, 'isProjectionSheet', fn)
  const role = requireViewerListRole(viewerListRole, fn)
  const archived = requireBoolean(listArchived, 'listArchived', fn)
  if (!projection) return capabilities
  const restricted: Record<string, unknown> = { ...capabilities }
  for (const key of TASK_PROJECTION_DENIED_CAPABILITY_KEYS) {
    if (key in restricted) restricted[key] = false
  }
  restricted.canRead = role !== null
  restricted.canExport = false
  restricted.canManageViews = role === 'editor' && !archived
  return restricted as T
}

// RULED(2026-10-09): [S06][S36] dragging on the projection's gantt/kanban writes through the task
// API; it is offered to list edit/owner only, and never on an archived list.
export function taskProjectionInteractionCanEdit(viewerListRole: TaskProjectionViewerListRole, listArchived: boolean): boolean {
  const fn = 'taskProjectionInteractionCanEdit'
  const role = requireViewerListRole(viewerListRole, fn)
  return role === 'editor' && !requireBoolean(listArchived, 'listArchived', fn)
}

// RULED(2026-10-09): [S02] who reads which row: the whole sheet is closed to non-members; for a
// member, a row is readable only while its task is not soft-deleted and is still in the list —
// both take effect immediately, before any reconcile removes the row.
export function isTaskProjectionRowReadable(input: {
  viewerListRole: TaskProjectionViewerListRole
  taskDeleted: boolean
  taskListed: boolean
}): boolean {
  const fn = 'isTaskProjectionRowReadable'
  if (!isPlainObject(input)) throw new TypeError(`${fn}: input must be an object`)
  const role = requireViewerListRole(input.viewerListRole, fn)
  const deleted = requireBoolean(input.taskDeleted, 'taskDeleted', fn)
  const listed = requireBoolean(input.taskListed, 'taskListed', fn)
  return role !== null && !deleted && listed
}
