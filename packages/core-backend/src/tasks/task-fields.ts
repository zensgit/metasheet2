/**
 * Task feature — custom fields: the type closed set, definition parsing (closed config schemas,
 * server-made option ids), value validation, the three permission layers (definition / binding /
 * value), binding events, and per-list value visibility. PURE, no I/O; timestamps and the option-id
 * random source come from the caller.
 *
 * Design: docs/development/task-e-m5-pure-functions-design-20261007.md §2.5
 * Lock:   task-feature-design-lock-20260917.md §3 (P2 scope), §4.2 (`task_fields` /
 *         `task_list_field_bindings` / `task_field_values`; event words `field_value_changed` in
 *         `task_events`, `field_bound` / `field_unbound` in `task_list_events`)
 *
 * External imports — both have no imports of their own and do nothing at module load (D16):
 *   - `../utils/calendar-date` — `isValidIsoCalendarDate`;
 *   - `../multitable/display-name-hygiene` — `checkDisplayNameHygiene` (field and option names).
 * Value validation is written here in full; this module does not use the multitable value codecs.
 */
import { checkDisplayNameHygiene } from '../multitable/display-name-hygiene'
import { isValidIsoCalendarDate } from '../utils/calendar-date'
import { can, type TaskListMembership, type TaskRole } from './task-access'
import { normalizeUserText } from './task-ids'

// RULED(2026-10-09): [S25] six types; no url / checkbox / dateTime. A `date` field is a floating
// calendar day; a `member` field holds user ids of the task's org; select options are identified
// by a server-made id and the stored value is that id, never the label.
export const TASK_FIELD_TYPES = ['text', 'number', 'select', 'multiSelect', 'member', 'date'] as const
export type TaskFieldType = (typeof TASK_FIELD_TYPES)[number]

// RULED(2026-10-09): [S28] soft limits, constants only (no DB CHECK): 200 definitions per org,
// 50 bindings per list, 100 options per field, option label 100 code points, text value 2000 code
// points, 50 users per member value, |number| < 1e15. `decimals` 0..6 is S25 (the `number` config).
// ASSUMPTION(task-e): [D18] the constants are defined once, here; a count over its limit answers
// `limit` (labels and numbers have their own codes, design doc §2.9).
// ASSUMPTION(task-e, own choice): a field NAME is at most 100 code points (the list-name ceiling).
// ASSUMPTION(task-e, own choice): a member value's user id is at most 50 characters — a rule kept
// from the first version of this module, so no id it refused is accepted now.
export const TASK_FIELD_LIMITS = Object.freeze({
  maxDefinitionsPerOrg: 200,
  maxBindingsPerList: 50,
  maxOptionsPerField: 100,
  maxOptionLabelCodePoints: 100,
  maxNameCodePoints: 100,
  maxTextValueCodePoints: 2000,
  maxMemberValues: 50,
  maxMemberIdChars: 50,
  maxNumberMagnitudeExclusive: 1e15,
  maxDecimals: 6,
})

export interface TaskFieldOption {
  id: string
  label: string
  /** Lower-case `#rrggbb`. */
  color?: string
}

export interface TaskTextFieldConfig {
  maxLength?: number
}
export interface TaskNumberFieldConfig {
  decimals: number
  format: 'plain' | 'percent'
}
export interface TaskOptionFieldConfig {
  options: TaskFieldOption[]
}
export interface TaskMemberFieldConfig {
  single: boolean
}
export type TaskDateFieldConfig = Record<string, never>

export type TaskFieldConfig =
  | TaskTextFieldConfig
  | TaskNumberFieldConfig
  | TaskOptionFieldConfig
  | TaskMemberFieldConfig
  | TaskDateFieldConfig

export interface TaskFieldDefinition {
  id: string
  type: TaskFieldType
  name: string
  config: TaskFieldConfig
}

/** Random source supplied by the caller for option ids: must return a non-empty `[A-Za-z0-9]` string. */
export type TaskFieldOptionRandom = (bytes: number) => string

const OPTION_ID_RANDOM_BYTES = 16
const OPTION_ID_RE = /^opt_[A-Za-z0-9]+$/
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function codePointLength(text: string): number {
  return [...text].length
}

function isIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function isTaskFieldType(value: unknown): value is TaskFieldType {
  return typeof value === 'string' && (TASK_FIELD_TYPES as readonly string[]).includes(value)
}

/** NFC + edge trim (normalizeUserText), a code-point ceiling, then display-name hygiene. */
function normalizeDisplayText(raw: unknown, maxCodePoints: number): string | null {
  const text = normalizeUserText(raw)
  if (text === null) return null
  if (codePointLength(text) > maxCodePoints) return null
  if (checkDisplayNameHygiene(text) !== null) return null
  return text
}

function expandColor(color: string): string {
  const hex = color.toLowerCase()
  if (hex.length === 7) return hex
  return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
}

export type ParseFieldDefinitionReason = 'invalid_type' | 'invalid_name' | 'invalid_config' | 'limit'

export type ParseFieldDefinitionResult =
  | { ok: true; type: TaskFieldType; name: string; config: TaskFieldConfig }
  | { ok: false; reason: ParseFieldDefinitionReason }

function previousOptionIds(previous: { type: TaskFieldType; config: unknown } | null | undefined): Set<string> {
  const ids = new Set<string>()
  if (!previous || (previous.type !== 'select' && previous.type !== 'multiSelect')) return ids
  const options = isPlainObject(previous.config) ? previous.config.options : undefined
  if (!Array.isArray(options)) throw new TypeError('parseFieldDefinition: previous options must be an array')
  for (const option of options) {
    if (!isPlainObject(option) || typeof option.id !== 'string') {
      throw new TypeError('parseFieldDefinition: every previous option needs an id')
    }
    ids.add(option.id)
  }
  return ids
}

function parseOptions(
  raw: unknown,
  keepIds: Set<string>,
  random: TaskFieldOptionRandom | undefined,
): { ok: true; options: TaskFieldOption[] } | { ok: false; reason: ParseFieldDefinitionReason } {
  if (!Array.isArray(raw)) return { ok: false, reason: 'invalid_config' }
  if (raw.length > TASK_FIELD_LIMITS.maxOptionsPerField) return { ok: false, reason: 'limit' }
  const seenLabels = new Set<string>()
  const seenIds = new Set<string>()
  const options: TaskFieldOption[] = []
  for (const entry of raw) {
    if (!isPlainObject(entry) || !hasOnlyKeys(entry, ['id', 'label', 'color'])) return { ok: false, reason: 'invalid_config' }
    const label = normalizeDisplayText(entry.label, TASK_FIELD_LIMITS.maxOptionLabelCodePoints)
    if (label === null) return { ok: false, reason: 'invalid_config' }
    // ASSUMPTION(task-e): [D10] labels are unique within a field, compared case-insensitively.
    const labelKey = label.toLowerCase()
    if (seenLabels.has(labelKey)) return { ok: false, reason: 'invalid_config' }
    seenLabels.add(labelKey)
    let id: string
    if (entry.id !== undefined) {
      // An id may only name an option the field already had (an update keeps its ids), once.
      if (typeof entry.id !== 'string' || !keepIds.has(entry.id) || seenIds.has(entry.id)) {
        return { ok: false, reason: 'invalid_config' }
      }
      id = entry.id
    } else {
      if (typeof random !== 'function') {
        throw new TypeError('parseFieldDefinition: random must be a function when new options are added')
      }
      const suffix = random(OPTION_ID_RANDOM_BYTES)
      id = `opt_${typeof suffix === 'string' ? suffix : ''}`
      if (!OPTION_ID_RE.test(id)) {
        throw new TypeError('parseFieldDefinition: random(bytes) must return a non-empty alphanumeric string')
      }
      if (seenIds.has(id) || keepIds.has(id)) {
        throw new TypeError('parseFieldDefinition: random(bytes) returned an option id that is already in use')
      }
    }
    seenIds.add(id)
    const option: TaskFieldOption = { id, label }
    if (entry.color !== undefined) {
      // ASSUMPTION(task-e, own choice): a colour is `#rgb` or `#rrggbb`, stored as lower-case
      // `#rrggbb` (the shape the multitable option palette produces).
      if (typeof entry.color !== 'string' || !HEX_COLOR_RE.test(entry.color)) return { ok: false, reason: 'invalid_config' }
      option.color = expandColor(entry.color)
    }
    options.push(option)
  }
  return { ok: true, options }
}

// ASSUMPTION(task-e): [D10] closed config schema per type; any unknown key is `invalid_config`.
// RULED(2026-10-09): [S25] `number` config is `{decimals: 0..6, format: plain|percent}`, absent
// keys default to `0` / `'plain'`; `member` config is `{single: boolean}`, default `false`.
// ASSUMPTION(task-e, own choice): a definition's type cannot change (`invalid_type` on update).
/**
 * Parses a create (no `previous`) or an update (`previous` = the stored type + config). Option ids
 * are server-made: an entry without `id` gets `opt_<random>`; an entry with an `id` must name an
 * option of `previous`.
 */
export function parseFieldDefinition(input: {
  type: unknown
  name: unknown
  config: unknown
  previous?: { type: TaskFieldType; config: unknown } | null
  random?: TaskFieldOptionRandom
}): ParseFieldDefinitionResult {
  const fn = 'parseFieldDefinition'
  if (!isPlainObject(input)) throw new TypeError(`${fn}: input must be an object`)
  const { type, previous, random } = input
  if (previous !== undefined && previous !== null && (!isPlainObject(previous) || !isTaskFieldType(previous.type))) {
    throw new TypeError(`${fn}: previous must be { type, config } or null`)
  }
  if (!isTaskFieldType(type)) return { ok: false, reason: 'invalid_type' }
  if (previous && previous.type !== type) return { ok: false, reason: 'invalid_type' }
  const name = normalizeDisplayText(input.name, TASK_FIELD_LIMITS.maxNameCodePoints)
  if (name === null) return { ok: false, reason: 'invalid_name' }
  const config = input.config === undefined ? {} : input.config
  if (!isPlainObject(config)) return { ok: false, reason: 'invalid_config' }
  switch (type) {
    case 'text': {
      if (!hasOnlyKeys(config, ['maxLength'])) return { ok: false, reason: 'invalid_config' }
      if (config.maxLength === undefined) return { ok: true, type, name, config: {} }
      if (!isIntInRange(config.maxLength, 1, TASK_FIELD_LIMITS.maxTextValueCodePoints)) return { ok: false, reason: 'invalid_config' }
      return { ok: true, type, name, config: { maxLength: config.maxLength } }
    }
    case 'number': {
      if (!hasOnlyKeys(config, ['decimals', 'format'])) return { ok: false, reason: 'invalid_config' }
      const decimals = config.decimals === undefined ? 0 : config.decimals
      const format = config.format === undefined ? 'plain' : config.format
      if (!isIntInRange(decimals, 0, TASK_FIELD_LIMITS.maxDecimals)) return { ok: false, reason: 'invalid_config' }
      if (format !== 'plain' && format !== 'percent') return { ok: false, reason: 'invalid_config' }
      return { ok: true, type, name, config: { decimals, format } }
    }
    case 'select':
    case 'multiSelect': {
      if (!hasOnlyKeys(config, ['options'])) return { ok: false, reason: 'invalid_config' }
      const parsed = parseOptions(config.options, previousOptionIds(previous), random)
      if (parsed.ok === false) return { ok: false, reason: (parsed as { reason: ParseFieldDefinitionReason }).reason }
      return { ok: true, type, name, config: { options: (parsed as { options: TaskFieldOption[] }).options } }
    }
    case 'member': {
      if (!hasOnlyKeys(config, ['single'])) return { ok: false, reason: 'invalid_config' }
      const single = config.single === undefined ? false : config.single
      if (typeof single !== 'boolean') return { ok: false, reason: 'invalid_config' }
      return { ok: true, type, name, config: { single } }
    }
    case 'date': {
      if (Object.keys(config).length > 0) return { ok: false, reason: 'invalid_config' }
      return { ok: true, type, name, config: {} }
    }
    default:
      return { ok: false, reason: 'invalid_type' }
  }
}

export type TaskFieldValueReason = 'invalid_value' | 'not_in_options' | 'not_a_candidate' | 'too_long' | 'out_of_range' | 'limit'

export type ValidateFieldValueResult = { ok: true; value: unknown } | { ok: false; reason: TaskFieldValueReason }

export interface TaskFieldValueContext {
  /** Active users of the task's org — required for `member` fields, loaded by the caller. */
  memberCandidates?: ReadonlySet<string>
}

function requireDefinition(def: unknown, fn: string): TaskFieldDefinition {
  if (!isPlainObject(def) || typeof def.id !== 'string' || def.id.length === 0 || !isTaskFieldType(def.type) || !isPlainObject(def.config)) {
    throw new TypeError(`${fn}: def must be a parsed field definition`)
  }
  return def as unknown as TaskFieldDefinition
}

function optionIdsOf(def: TaskFieldDefinition, fn: string): string[] {
  const options = (def.config as TaskOptionFieldConfig).options
  if (!Array.isArray(options)) throw new TypeError(`${fn}: an option field needs config.options`)
  return options.map((option) => option.id)
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0)
}

// ASSUMPTION(task-e, own choice): `null` and `''` both mean "clear the value", for every type.
// ASSUMPTION(task-e, own choice): option ids and user ids are compared exactly as sent — no
// trimming, and a blank entry is not skipped — so a padded or blank id is refused.
/**
 * Validates one value against its definition. Success returns the value to store (`null` = clear).
 * select: an option id of this field (by id, never by label). multiSelect: an array of option ids,
 * de-duplicated in first-seen order; an empty array clears. member: user ids, each at most 50
 * characters and each in `ctx.memberCandidates`, de-duplicated in first-seen order, at most 50
 * users, at most 1 when `single`; an empty array clears. number: a finite JSON number with
 * |x| < 1e15 (numeric strings are refused). date: a real `YYYY-MM-DD`. text: `normalizeUserText`;
 * more than 2000 code points ⇒ `limit`; within 2000 but more than the field's `maxLength` ⇒
 * `too_long`.
 */
export function validateFieldValue(def: TaskFieldDefinition, value: unknown, ctx?: TaskFieldValueContext): ValidateFieldValueResult {
  const fn = 'validateFieldValue'
  const field = requireDefinition(def, fn)
  if (value === null || value === '') return { ok: true, value: null }
  switch (field.type) {
    case 'text': {
      if (typeof value !== 'string') return { ok: false, reason: 'invalid_value' }
      const text = normalizeUserText(value)
      if (text === null) return { ok: true, value: null }
      const length = codePointLength(text)
      // ASSUMPTION(task-e): [D18] the 2000-code-point ceiling holds for every text value, whatever
      // the stored config says, and a value over it answers `limit` (D18's code). A field's own
      // `maxLength` (1..2000, D10) is a narrower config rule: a value over it answers `too_long`.
      if (length > TASK_FIELD_LIMITS.maxTextValueCodePoints) return { ok: false, reason: 'limit' }
      const maxLength = (field.config as TaskTextFieldConfig).maxLength
      if (maxLength !== undefined && length > maxLength) return { ok: false, reason: 'too_long' }
      return { ok: true, value: text }
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: 'invalid_value' }
      if (Math.abs(value) >= TASK_FIELD_LIMITS.maxNumberMagnitudeExclusive) return { ok: false, reason: 'out_of_range' }
      return { ok: true, value }
    }
    case 'select': {
      if (typeof value !== 'string') return { ok: false, reason: 'invalid_value' }
      if (!optionIdsOf(field, fn).includes(value)) return { ok: false, reason: 'not_in_options' }
      return { ok: true, value }
    }
    case 'multiSelect': {
      if (!isNonEmptyStringArray(value)) return { ok: false, reason: 'invalid_value' }
      const allowed = new Set(optionIdsOf(field, fn))
      const ids = [...new Set(value)]
      if (ids.some((id) => !allowed.has(id))) return { ok: false, reason: 'not_in_options' }
      return { ok: true, value: ids.length === 0 ? null : ids }
    }
    case 'member': {
      const candidates = ctx?.memberCandidates
      if (!(candidates instanceof Set)) throw new TypeError(`${fn}: ctx.memberCandidates must be a Set for a member field`)
      if (!isNonEmptyStringArray(value)) return { ok: false, reason: 'invalid_value' }
      const userIds = [...new Set(value)]
      for (const userId of userIds) {
        if (userId.length > TASK_FIELD_LIMITS.maxMemberIdChars) return { ok: false, reason: 'not_a_candidate' }
        if (!candidates.has(userId)) return { ok: false, reason: 'not_a_candidate' }
      }
      if (userIds.length > TASK_FIELD_LIMITS.maxMemberValues) return { ok: false, reason: 'limit' }
      if ((field.config as TaskMemberFieldConfig).single === true && userIds.length > 1) return { ok: false, reason: 'invalid_value' }
      return { ok: true, value: userIds.length === 0 ? null : userIds }
    }
    case 'date': {
      if (typeof value !== 'string' || !isValidIsoCalendarDate(value)) return { ok: false, reason: 'invalid_value' }
      return { ok: true, value }
    }
    default:
      throw new TypeError(`${fn}: unknown field type`)
  }
}

export interface TaskFieldValueEvent {
  type: 'field_value_changed'
  userId: string
  occurredAt: Date
  payload: { fieldId: string }
}

export type ApplySetFieldValueResult =
  | { ok: false; reason: TaskFieldValueReason }
  | { ok: true; value: unknown; noop: boolean; events: TaskFieldValueEvent[] }

function requireActorAndNow(actorId: unknown, now: unknown, fn: string): void {
  if (typeof actorId !== 'string' || actorId.length === 0) throw new TypeError(`${fn}: actorId must be a non-empty string`)
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError(`${fn}: now must be a valid Date`)
}

/** `validateFieldValue`, then: the same stored value ⇒ no-op; otherwise one `field_value_changed`. */
export function applySetFieldValue(input: {
  def: TaskFieldDefinition
  current: unknown
  next: unknown
  ctx?: TaskFieldValueContext
  actorId: string
  now: Date
}): ApplySetFieldValueResult {
  const fn = 'applySetFieldValue'
  if (!isPlainObject(input)) throw new TypeError(`${fn}: input must be an object`)
  requireActorAndNow(input.actorId, input.now, fn)
  const verdict = validateFieldValue(input.def, input.next, input.ctx)
  if (verdict.ok === false) return { ok: false, reason: (verdict as { reason: TaskFieldValueReason }).reason }
  const value = (verdict as { value: unknown }).value
  const current = input.current === undefined ? null : input.current
  if (JSON.stringify(current) === JSON.stringify(value)) return { ok: true, value, noop: true, events: [] }
  return {
    ok: true,
    value,
    noop: false,
    events: [{ type: 'field_value_changed', userId: input.actorId, occurredAt: input.now, payload: { fieldId: input.def.id } }],
  }
}

// ── Permissions (S26) ──────────────────────────────────────────────────────────────────────────

type ViewerListRole = TaskListMembership['role'] | null

function requireViewerListRole(role: unknown, fn: string): ViewerListRole {
  if (role !== null && role !== 'editor' && role !== 'reader') {
    throw new TypeError(`${fn}: the list role must be 'editor', 'reader' or null`)
  }
  return role as ViewerListRole
}

// RULED(2026-10-09): [S26] renaming a field or editing its options: the field's creator, or anyone
// who is edit/owner on a list that binds the field. No admin parameter (`tasks:admin` still has no
// consumer).
export function canManageFieldDefinition(input: { actorId: string; createdBy: string; actorEditsBindingList: boolean }): boolean {
  const fn = 'canManageFieldDefinition'
  if (!isPlainObject(input) || typeof input.actorId !== 'string' || typeof input.createdBy !== 'string') {
    throw new TypeError(`${fn}: actorId and createdBy must be strings`)
  }
  if (typeof input.actorEditsBindingList !== 'boolean') throw new TypeError(`${fn}: actorEditsBindingList must be a boolean`)
  return (input.actorId.length > 0 && input.actorId === input.createdBy) || input.actorEditsBindingList
}

export type PlanDeleteFieldDefinitionResult = { ok: true } | { ok: false; reason: 'forbidden' | 'field_in_use' }

// RULED(2026-10-09): [S26] only the creator deletes a definition, and only once no list binds it
// (`field_in_use`, 422); deleting it removes its values.
export function planDeleteFieldDefinition(input: { actorId: string; createdBy: string; bindingCount: number }): PlanDeleteFieldDefinitionResult {
  const fn = 'planDeleteFieldDefinition'
  if (!isPlainObject(input) || typeof input.actorId !== 'string' || typeof input.createdBy !== 'string') {
    throw new TypeError(`${fn}: actorId and createdBy must be strings`)
  }
  if (!isIntInRange(input.bindingCount, 0, Number.MAX_SAFE_INTEGER)) throw new TypeError(`${fn}: bindingCount must be a non-negative integer`)
  if (input.actorId.length === 0 || input.actorId !== input.createdBy) return { ok: false, reason: 'forbidden' }
  if (input.bindingCount > 0) return { ok: false, reason: 'field_in_use' }
  return { ok: true }
}

// RULED(2026-10-09): [S26] binding, unbinding, ordering and hiding fields on a list: that list's
// edit/owner (`'editor'` in the `TaskListMembership` bridge).
export function canBindField(viewerListRole: TaskListMembership['role'] | null): boolean {
  return requireViewerListRole(viewerListRole, 'canBindField') === 'editor'
}

// RULED(2026-10-09): [S26] writing a value: `edit` on the task AND the field is bound to one of the
// lists the task is in.
export function canWriteFieldValue(input: { taskRoles: TaskRole[]; fieldBoundToTaskList: boolean }): boolean {
  const fn = 'canWriteFieldValue'
  if (!isPlainObject(input) || !Array.isArray(input.taskRoles)) throw new TypeError(`${fn}: taskRoles must be an array`)
  if (typeof input.fieldBoundToTaskList !== 'boolean') throw new TypeError(`${fn}: fieldBoundToTaskList must be a boolean`)
  return input.fieldBoundToTaskList && can(input.taskRoles, 'edit')
}

/** Per-org definition quota: `existingCount` definitions already exist; may one more be created? */
export function checkFieldDefinitionQuota(existingCount: number): { ok: true } | { ok: false; reason: 'limit' } {
  if (!isIntInRange(existingCount, 0, Number.MAX_SAFE_INTEGER)) {
    throw new TypeError('checkFieldDefinitionQuota: existingCount must be a non-negative integer')
  }
  return existingCount + 1 > TASK_FIELD_LIMITS.maxDefinitionsPerOrg ? { ok: false, reason: 'limit' } : { ok: true }
}

export interface TaskFieldBindingEvent {
  listId: string
  type: 'field_bound' | 'field_unbound'
  userId: string
  occurredAt: Date
  payload: { fieldId: string }
}

function requireBindingInput(input: unknown, fn: string): { listId: string; fieldId: string; boundFieldIds: string[] } {
  if (!isPlainObject(input)) throw new TypeError(`${fn}: input must be an object`)
  if (typeof input.listId !== 'string' || input.listId.length === 0) throw new TypeError(`${fn}: listId must be a non-empty string`)
  if (typeof input.fieldId !== 'string' || input.fieldId.length === 0) throw new TypeError(`${fn}: fieldId must be a non-empty string`)
  if (!Array.isArray(input.boundFieldIds) || input.boundFieldIds.some((id) => typeof id !== 'string')) {
    throw new TypeError(`${fn}: boundFieldIds must be an array of strings`)
  }
  requireActorAndNow(input.actorId, input.now, fn)
  return { listId: input.listId, fieldId: input.fieldId, boundFieldIds: input.boundFieldIds as string[] }
}

export type ApplyBindFieldResult =
  | { ok: false; reason: 'limit' }
  | { ok: true; noop: boolean; events: TaskFieldBindingEvent[] }

/** Binds `fieldId` to `listId`. Already bound ⇒ no-op. More than 50 bindings ⇒ `limit`. */
export function applyBindField(input: {
  listId: string
  fieldId: string
  /** Field ids currently bound to this list. */
  boundFieldIds: readonly string[]
  actorId: string
  now: Date
}): ApplyBindFieldResult {
  const { listId, fieldId, boundFieldIds } = requireBindingInput(input, 'applyBindField')
  if (boundFieldIds.includes(fieldId)) return { ok: true, noop: true, events: [] }
  if (new Set(boundFieldIds).size + 1 > TASK_FIELD_LIMITS.maxBindingsPerList) return { ok: false, reason: 'limit' }
  return {
    ok: true,
    noop: false,
    events: [{ listId, type: 'field_bound', userId: input.actorId, occurredAt: input.now, payload: { fieldId } }],
  }
}

// RULED(2026-10-09): [S26] unbinding keeps the stored values (binding the field again shows them).
/** Unbinds `fieldId` from `listId`. Not bound ⇒ no-op. Values are not touched. */
export function applyUnbindField(input: {
  listId: string
  fieldId: string
  boundFieldIds: readonly string[]
  actorId: string
  now: Date
}): { noop: boolean; events: TaskFieldBindingEvent[] } {
  const { listId, fieldId, boundFieldIds } = requireBindingInput(input, 'applyUnbindField')
  if (!boundFieldIds.includes(fieldId)) return { noop: true, events: [] }
  return {
    noop: false,
    events: [{ listId, type: 'field_unbound', userId: input.actorId, occurredAt: input.now, payload: { fieldId } }],
  }
}

// ── Visibility (S27) and reuse (S24) ───────────────────────────────────────────────────────────

export interface TaskFieldBinding {
  listId: string
  fieldId: string
  position: number
  hidden: boolean
}

export interface VisibleTaskFieldGroup {
  listId: string
  fields: { fieldId: string; hidden: boolean; value: unknown }[]
}

function requireStringList(value: unknown, name: string, fn: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`${fn}: ${name} must be an array of strings`)
  }
  return value as string[]
}

function requireBindings(value: unknown, fn: string): TaskFieldBinding[] {
  if (!Array.isArray(value)) throw new TypeError(`${fn}: bindings must be an array`)
  for (const binding of value) {
    if (!isPlainObject(binding) || typeof binding.listId !== 'string' || typeof binding.fieldId !== 'string') {
      throw new TypeError(`${fn}: every binding needs listId and fieldId`)
    }
  }
  return value as TaskFieldBinding[]
}

// RULED(2026-10-09): [S27] a value follows its bindings: the viewer sees field F on task T only if
// they may view T AND some list L binds F, contains T, and has the viewer as a member. A viewer who
// holds only a direct role (creator / assignee / follower) and is in none of those lists sees no
// custom-field values.
// ASSUMPTION(task-e, own choice): groups follow the order of `taskListIds`; a list that binds no
// field is left out; fields are ordered by binding position, then field id.
/**
 * `viewerListIds`: lists the viewer is a member of under the session tenant. `taskListIds`: lists
 * the task is in. `values`: the task's stored values (a bound field without a stored value shows
 * `null`).
 */
export function resolveVisibleTaskFieldValues(input: {
  canView: boolean
  viewerListIds: readonly string[]
  taskListIds: readonly string[]
  bindings: readonly TaskFieldBinding[]
  values: readonly { fieldId: string; value: unknown }[]
}): VisibleTaskFieldGroup[] {
  const fn = 'resolveVisibleTaskFieldValues'
  if (!isPlainObject(input)) throw new TypeError(`${fn}: input must be an object`)
  if (typeof input.canView !== 'boolean') throw new TypeError(`${fn}: canView must be a boolean`)
  const viewerLists = new Set(requireStringList(input.viewerListIds, 'viewerListIds', fn))
  const taskLists = requireStringList(input.taskListIds, 'taskListIds', fn)
  const bindings = requireBindings(input.bindings, fn)
  for (const binding of bindings) {
    if (typeof binding.position !== 'number' || !Number.isFinite(binding.position) || typeof binding.hidden !== 'boolean') {
      throw new TypeError(`${fn}: every binding needs a numeric position and a boolean hidden`)
    }
  }
  if (!Array.isArray(input.values)) throw new TypeError(`${fn}: values must be an array`)
  if (!input.canView) return []
  const valueOf = new Map<string, unknown>()
  for (const entry of input.values) {
    if (!isPlainObject(entry) || typeof entry.fieldId !== 'string') throw new TypeError(`${fn}: every value needs a fieldId`)
    valueOf.set(entry.fieldId, entry.value)
  }
  const groups: VisibleTaskFieldGroup[] = []
  for (const listId of new Set(taskLists)) {
    if (!viewerLists.has(listId)) continue
    const bound = bindings
      .filter((binding) => binding.listId === listId)
      .sort((a, b) => a.position - b.position || (a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : 0))
    if (bound.length === 0) continue
    groups.push({
      listId,
      fields: bound.map((binding) => ({
        fieldId: binding.fieldId,
        hidden: binding.hidden,
        value: valueOf.has(binding.fieldId) ? valueOf.get(binding.fieldId) : null,
      })),
    })
  }
  return groups
}

// RULED(2026-10-09): [S24] definitions are org-wide, bindings per list, values per task. The
// "already created" fields a user may reuse are those bound to any list they can edit, plus those
// they created themselves.
export function listReusableTaskFieldIds(input: {
  actorId: string
  fields: readonly { id: string; createdBy: string }[]
  bindings: readonly { listId: string; fieldId: string }[]
  editableListIds: readonly string[]
}): string[] {
  const fn = 'listReusableTaskFieldIds'
  if (!isPlainObject(input) || typeof input.actorId !== 'string' || input.actorId.length === 0) {
    throw new TypeError(`${fn}: actorId must be a non-empty string`)
  }
  if (!Array.isArray(input.fields) || input.fields.some((f) => !isPlainObject(f) || typeof f.id !== 'string' || typeof f.createdBy !== 'string')) {
    throw new TypeError(`${fn}: fields must be an array of { id, createdBy }`)
  }
  const bindings = requireBindings(input.bindings, fn)
  const editable = new Set(requireStringList(input.editableListIds, 'editableListIds', fn))
  const known = new Set(input.fields.map((f) => f.id))
  const result = new Set<string>()
  for (const field of input.fields) {
    if (field.createdBy === input.actorId) result.add(field.id)
  }
  for (const binding of bindings) {
    if (editable.has(binding.listId) && known.has(binding.fieldId)) result.add(binding.fieldId)
  }
  return [...result].sort()
}
