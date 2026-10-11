import { onAuthPrincipalChange, readAuthSessionSignature, readStoredToken, TOKEN_KEYS } from '../../composables/authPrincipal'
import { EXPLICIT_SESSION_ORG_KEY } from '../../utils/explicitSessionOrg'

export type AutomationReadTrigger = 'manual' | 'schedule' | 'record'
export type AutomationReadRecordTriggerType = 'record.created' | 'record.updated'
export type AutomationReadRecordCondition = Readonly<{ mode: 'unconditional' }
  | { mode: 'saved_conditions'; schemaRevision: string; businessTimeZone: string }>
export type AutomationReadDateFieldConfirmation = Readonly<{
  fieldId: string; fieldType: 'date' | 'dateTime'; schemaRevision: string
}>
export type AutomationReadDateScheduleConfig = Readonly<{
  dateFieldId: string; offsetDays: number; direction: 'before' | 'after'
  timeOfDay?: string; timezone?: string; effectiveAt?: string; scanIntervalMs?: number
}>
export type AutomationReadScheduleDefinition = Readonly<
  | { triggerType: 'schedule.cron'; config: Readonly<{ expression: string; cron?: never; timezone?: string } | { cron: string; expression?: never; timezone?: string }> }
  | { triggerType: 'schedule.interval'; intervalMs: number; anchorMs: number }
  | { triggerType: 'schedule.date_field'; config: AutomationReadDateScheduleConfig; dateField: AutomationReadDateFieldConfirmation }
>
export type AutomationReadSelector = { ruleId: string; actionId: string; systemId: string; targetId: string }
export type AutomationReadBudget = { maxRows: number; maxPages: number; maxReadCount: number; timeoutMs: number }
export type AutomationReadOption = {
  selector: AutomationReadSelector
  ruleName: string
  budget: AutomationReadBudget
  allowedTriggers: AutomationReadTrigger[]
  recordActivationEligible: boolean
  recordTriggerType: AutomationReadRecordTriggerType | null
  recordRuleRevision: string | null
  recordCondition: AutomationReadRecordCondition | null
  scheduleActivationEligible: boolean
  scheduleRuleRevision: string | null
  scheduleDefinition: AutomationReadScheduleDefinition | null
}
export type AutomationReadGrantInput = {
  selector: AutomationReadSelector
  projects: string[]
  triggers: AutomationReadTrigger[]
  budget: AutomationReadBudget
  expiresAt: string
  maxExecutions: number
}
export type AutomationReadInput = AutomationReadGrantInput
export type AutomationReadRecordActivationInput = {
  activationKey: string
  selector: AutomationReadSelector
  projectNo: string
  budget: AutomationReadBudget
  expiresAt: string
  maxExecutions: number
  expectedRuleRevision: string
  expectedRecordCondition: AutomationReadRecordCondition
}
export type AutomationReadRecordActivationRef = { activationId: string; grantId: string }
// Schedule never self-reports config or phase. Date metadata is only an explicit
// precondition: the server resolves the current field and rule independently.
export type AutomationReadScheduleActivationInput = Omit<AutomationReadRecordActivationInput, 'expectedRecordCondition'> & {
  expectedDateField?: AutomationReadDateFieldConfirmation
}
type ActivationFields = Omit<AutomationReadScheduleActivationInput, 'expectedRuleRevision' | 'expectedDateField'>
export type AutomationReadScheduleActivationRef = AutomationReadRecordActivationRef
export type AutomationReadGrant = AutomationReadGrantInput & {
  grantId: string
  purpose: 'standalone' | 'automatic' | 'retry'
  status: 'active' | 'revoked'
  usedExecutions: number
  createdAt: string
  updatedAt: string
}
export type AutomationReadRequestStatus = 'queued' | 'running' | 'succeeded' | 'blocked' | 'failed' | 'cancelled' | 'outcome_unknown'
export type AutomationReadPreview = {
  status: 'not_found' | 'large_bom_bounded' | 'ready' | 'manual_confirm_required'
  counts: { add: number; update: number; skip: number; inactive: number; manual_confirm: number }
  canApply: false
}
export type AutomationReadRequestRef = { requestId: string; status: AutomationReadRequestStatus }
export type AutomationReadRequestDetail = AutomationReadRequestRef & { result: AutomationReadPreview | null }
export type AutomationReadRequestSummary = AutomationReadRequestRef & {
  grantId: string
  projectNo: string
  trigger: AutomationReadTrigger
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}
export type AutomationReadPage<T> = { items: T[]; nextCursor: string | null }
export type AutomationReadPageInput = { limit?: number; after?: string }
export type AutomationReadOptionsInput = AutomationReadPageInput & { sheetId: string }
export type AutomationReadRequestPageInput = AutomationReadPageInput & { grantId?: string }
export type AutomationReadSubmitInput = { grantId: string; invocationId: string; projectNo: string }
export type AutomationReadRetryInput = Readonly<{
  retryKey: string
  budget: Readonly<AutomationReadBudget>
  expiresAt: string
  acknowledgeNewRead: true
}>
export type AutomationReadRetryRef = AutomationReadRequestRef & { parentRequestId: string; grantId: string }
export type AutomationReadDateScheduleOrigin = Readonly<{
  definition: Extract<AutomationReadScheduleDefinition, { triggerType: 'schedule.date_field' }>
  ruleRevision: string
}>
export type AutomationReadRetryContext = {
  request: AutomationReadRequestSummary
  grant: AutomationReadGrant
  nextAttempt: { requestId: string; grantId: string } | null
  dateScheduleOrigin?: AutomationReadDateScheduleOrigin
}

const errorStatuses = {
  UNAUTHORIZED: 401,
  AUTOMATION_READ_INPUT_INVALID: 400,
  AUTOMATION_READ_DENIED: 403,
  AUTOMATION_READ_SCOPE_CHANGED: 409,
  AUTOMATION_READ_BUDGET_EXHAUSTED: 409,
  AUTOMATION_READ_IDEMPOTENCY_CONFLICT: 409,
  AUTOMATION_READ_FENCE_LOST: 409,
  AUTOMATION_READ_ROUTING_UNAVAILABLE: 503,
  AUTOMATION_READ_TRANSACTION_REQUIRED: 503,
  AUTOMATION_READ_UNAVAILABLE: 503,
  AUTOMATION_READ_RUNTIME_INACTIVE: 503,
  AUTOMATION_ACTOR_INPUT_INVALID: 400,
  AUTOMATION_ACTOR_TRANSACTION_REQUIRED: 503,
  AUTOMATION_ACTOR_AUTHORITY_UNAVAILABLE: 503,
  AUTOMATION_ACTOR_AUTHORITY_DENIED: 403,
  AUTOMATION_READ_RESPONSE_INVALID: 502,
  AUTOMATION_READ_SESSION_CHANGED: 401,
} as const
export type AutomationReadErrorCode = keyof typeof errorStatuses

/** Only fixed codes cross the UI boundary: never retain the raw response/error. */
export class AutomationReadClientError extends Error {
  readonly status: number
  readonly code: AutomationReadErrorCode
  constructor(code: AutomationReadErrorCode) {
    super(code)
    this.name = 'AutomationReadClientError'
    this.code = code
    this.status = errorStatuses[code]
  }
}

const prefix = '/api/integration/automation-read'
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const requestStatuses: readonly AutomationReadRequestStatus[] = ['queued', 'running', 'succeeded', 'blocked', 'failed', 'cancelled', 'outcome_unknown']
const maximumBodyBytes = 1024 * 1024
type Row = Record<string, unknown>

function invalid(): never { throw new AutomationReadClientError('AUTOMATION_READ_INPUT_INVALID') }
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalid()
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string' || (!required.includes(key) && !optional.includes(key)))
    || required.some(key => !Object.prototype.hasOwnProperty.call(value, key))) invalid()
  const result: Row = Object.create(null) as Row
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) invalid()
    result[key as string] = descriptor.value
  }
  return result
}
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) invalid()
  const result: unknown[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) invalid()
    result.push(descriptor.value)
  }
  return result
}
function canonical(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255 || value !== value.trim()
    // eslint-disable-next-line no-control-regex -- Match the owner HTTP opaque-ID contract.
    || /[\u0000-\u001f\u007f]/u.test(value)) invalid()
  return value
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) invalid()
  return value
}
/** Closed values-free consent only. Shared with the panel's defensive fake-port guard. */
export function checkedAutomationReadRecordCondition(value: unknown): AutomationReadRecordCondition {
  const row = object(value, ['mode'], ['schemaRevision', 'businessTimeZone'])
  if (row.mode === 'unconditional') {
    object(value, ['mode'])
    return Object.freeze({ mode: 'unconditional' })
  }
  if (row.mode !== 'saved_conditions') invalid()
  object(value, ['mode', 'schemaRevision', 'businessTimeZone'])
  const schemaRevision = uuid(row.schemaRevision), zone = row.businessTimeZone
  if (typeof zone !== 'string' || zone.length === 0 || zone.length > 128 || zone !== zone.trim()) invalid()
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions() } catch { invalid() }
  return Object.freeze({ mode: 'saved_conditions', schemaRevision, businessTimeZone: zone })
}
/** Bounded display validation, not a scheduler or an occurrence authorization.
 * Field grammar follows the existing FE automation-trigger-timezone parser.
 * Keep the exact expression/cron spelling and config; never silently repair it. */
function checkedCronExpression(value: unknown): string {
  const expression = canonical(value), parts = expression.split(/\s+/u)
  if (parts.length !== 5) invalid()
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const
  const fields = parts.map((raw, index) => {
    const [min, max] = ranges[index], values = new Set<number>()
    for (const piece of raw.split(',')) {
      if (!piece || piece.split('/').length > 2) invalid()
      const [range, stepRaw] = piece.split('/'), step = stepRaw === undefined ? 1 : Number(stepRaw)
      if (!Number.isInteger(step) || step < 1) invalid()
      let start: number, end: number
      if (range === '*') { start = min; end = max }
      else if (range.includes('-')) {
        const pair = range.split('-')
        if (pair.length !== 2 || !pair[0] || !pair[1]) invalid()
        start = Number(pair[0]); end = Number(pair[1])
      } else { start = Number(range); end = start }
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) invalid()
      for (let number = start; number <= end; number += step) values.add(number)
    }
    if (!values.size) invalid()
    return values
  })
  // Restricted DOW uses OR semantics, so it can still match an impossible DOM.
  const monthDays = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (parts[4] === '*' && parts[2] !== '*'
    && Math.min(...fields[2]) > Math.max(...[...fields[3]].map(month => monthDays[month]))) invalid()
  return expression
}
export function checkedAutomationReadDateFieldConfirmation(value: unknown): AutomationReadDateFieldConfirmation {
  const row = object(value, ['fieldId', 'fieldType', 'schemaRevision'])
  if (row.fieldType !== 'date' && row.fieldType !== 'dateTime') invalid()
  return Object.freeze({ fieldId: canonical(row.fieldId), fieldType: row.fieldType, schemaRevision: uuid(row.schemaRevision) })
}
/** Match the server's strict date floor grammar without normalizing its original
 * offset or microsecond spelling. Date.parse alone accepts invalid calendar days. */
function dateScheduleEffectiveAt(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64) invalid()
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/u.exec(value)
  if (!match) invalid()
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  if (year < 100 || year > 9999 || month < 1 || month > 12 || day < 1
    || day > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) invalid()
  if (match[8] !== 'Z') {
    const hours = Number(match[8].slice(1, 3)), minutes = Number(match[8].slice(4, 6))
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0) || match[8] === '-00:00') invalid()
  }
  if (!Number.isSafeInteger(Date.parse(value))) invalid()
  return value
}
function checkedDateScheduleConfig(value: unknown): AutomationReadDateScheduleConfig {
  const row = object(value, ['dateFieldId', 'offsetDays', 'direction'], ['timeOfDay', 'timezone', 'effectiveAt', 'scanIntervalMs'])
  const dateFieldId = canonical(row.dateFieldId), offsetDays = integer(row.offsetDays, 0, 36500)
  if (row.direction !== 'before' && row.direction !== 'after') invalid()
  const config: { dateFieldId: string; offsetDays: number; direction: 'before' | 'after'; timeOfDay?: string; timezone?: string; effectiveAt?: string; scanIntervalMs?: number } = {
    dateFieldId, offsetDays, direction: row.direction,
  }
  if (Object.prototype.hasOwnProperty.call(row, 'timeOfDay')) {
    if (typeof row.timeOfDay !== 'string' || !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u.test(row.timeOfDay)) invalid()
    config.timeOfDay = row.timeOfDay
  }
  if (Object.prototype.hasOwnProperty.call(row, 'timezone')) {
    const timezone = canonical(row.timezone)
    if (timezone.length > 128 || !/^[A-Za-z][A-Za-z0-9_+./-]*$/u.test(timezone)) invalid()
    try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions() } catch { invalid() }
    config.timezone = timezone
  }
  if (Object.prototype.hasOwnProperty.call(row, 'effectiveAt')) config.effectiveAt = dateScheduleEffectiveAt(row.effectiveAt)
  // Retain this deprecated cadence exactly; it never controls date scheduling.
  if (Object.prototype.hasOwnProperty.call(row, 'scanIntervalMs')) config.scanIntervalMs = integer(row.scanIntervalMs, 1, Number.MAX_SAFE_INTEGER)
  return Object.freeze(config)
}
export function checkedAutomationReadScheduleDefinition(value: unknown): AutomationReadScheduleDefinition {
  const row = object(value, ['triggerType'], ['config', 'intervalMs', 'anchorMs', 'dateField'])
  if (row.triggerType === 'schedule.date_field') {
    object(value, ['triggerType', 'config', 'dateField'])
    const config = checkedDateScheduleConfig(row.config), dateField = checkedAutomationReadDateFieldConfirmation(row.dateField)
    if (config.dateFieldId !== dateField.fieldId) invalid()
    return Object.freeze({ triggerType: 'schedule.date_field', config, dateField })
  }
  if (row.triggerType === 'schedule.interval') {
    object(value, ['triggerType', 'intervalMs', 'anchorMs'])
    const intervalMs = integer(row.intervalMs, 1000), anchorMs = integer(row.anchorMs, 1, Number.MAX_SAFE_INTEGER)
    if (!Number.isFinite(new Date(anchorMs).getTime())) invalid()
    return Object.freeze({ triggerType: 'schedule.interval', intervalMs, anchorMs })
  }
  if (row.triggerType !== 'schedule.cron') invalid()
  object(value, ['triggerType', 'config'])
  const config = object(row.config, [], ['expression', 'cron', 'timezone'])
  if (Object.prototype.hasOwnProperty.call(config, 'expression') === Object.prototype.hasOwnProperty.call(config, 'cron')) invalid()
  const expression = checkedCronExpression(config.expression ?? config.cron)
  let zone: { timezone?: string } = {}
  if (Object.prototype.hasOwnProperty.call(config, 'timezone')) {
    const timezone = canonical(config.timezone)
    if (!/^[A-Za-z][A-Za-z0-9_+./-]*$/u.test(timezone)) invalid()
    try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions() } catch { invalid() }
    zone = { timezone }
  }
  const closed = Object.prototype.hasOwnProperty.call(config, 'expression') ? { expression, ...zone } : { cron: expression, ...zone }
  return Object.freeze({ triggerType: 'schedule.cron', config: Object.freeze(closed) })
}
function integer(value: unknown, minimum: number, maximum = 2147483647): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) invalid()
  return value as number
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid()
  return value
}
function selector(value: unknown): AutomationReadSelector {
  const row = object(value, ['ruleId', 'actionId', 'systemId', 'targetId'])
  return { ruleId: canonical(row.ruleId), actionId: canonical(row.actionId), systemId: canonical(row.systemId), targetId: canonical(row.targetId) }
}
function budget(value: unknown): AutomationReadBudget {
  const row = object(value, ['maxRows', 'maxPages', 'maxReadCount', 'timeoutMs'])
  return { maxRows: integer(row.maxRows, 1), maxPages: integer(row.maxPages, 1), maxReadCount: integer(row.maxReadCount, 1), timeoutMs: integer(row.timeoutMs, 1) }
}
function trigger(value: unknown): AutomationReadTrigger {
  if (value !== 'manual' && value !== 'schedule' && value !== 'record') invalid()
  return value
}
function triggers(value: unknown): AutomationReadTrigger[] {
  const result = array(value, 3).map(trigger)
  if (result.length === 0 || new Set(result).size !== result.length) invalid()
  return result
}
function projects(value: unknown): string[] {
  const result = array(value, 256).map(canonical)
  if (result.length === 0 || new Set(result).size !== result.length) invalid()
  return result
}
function grantInput(value: unknown): AutomationReadGrantInput {
  const row = object(value, ['selector', 'projects', 'triggers', 'budget', 'expiresAt', 'maxExecutions'])
  return { selector: selector(row.selector), projects: projects(row.projects), triggers: triggers(row.triggers), budget: budget(row.budget),
    expiresAt: timestamp(row.expiresAt), maxExecutions: integer(row.maxExecutions, 1) }
}
function option(value: unknown): AutomationReadOption {
  const row = object(value, ['selector', 'ruleName', 'budget', 'allowedTriggers', 'recordActivationEligible', 'recordTriggerType', 'recordRuleRevision', 'recordCondition', 'scheduleActivationEligible', 'scheduleRuleRevision', 'scheduleDefinition'])
  if (typeof row.ruleName !== 'string' || row.ruleName.length > 160 || typeof row.recordActivationEligible !== 'boolean') invalid()
  const allowedTriggers = triggers(row.allowedTriggers)
  if (row.recordActivationEligible && !allowedTriggers.includes('record')) invalid()
  if (row.recordActivationEligible
    ? row.recordTriggerType !== 'record.created' && row.recordTriggerType !== 'record.updated'
    : row.recordTriggerType !== null) invalid()
  const recordRuleRevision = row.recordActivationEligible ? uuid(row.recordRuleRevision) : null
  if (!row.recordActivationEligible && row.recordRuleRevision !== null) invalid()
  const recordCondition = row.recordActivationEligible ? checkedAutomationReadRecordCondition(row.recordCondition) : null
  if (!row.recordActivationEligible && row.recordCondition !== null) invalid()
  if (typeof row.scheduleActivationEligible !== 'boolean'
    || (row.scheduleActivationEligible && !allowedTriggers.includes('schedule'))
    || (row.recordActivationEligible && row.scheduleActivationEligible)) invalid()
  const scheduleRuleRevision = row.scheduleActivationEligible ? uuid(row.scheduleRuleRevision) : null
  const scheduleDefinition = row.scheduleActivationEligible ? checkedAutomationReadScheduleDefinition(row.scheduleDefinition) : null
  if (!row.scheduleActivationEligible && (row.scheduleRuleRevision !== null || row.scheduleDefinition !== null)) invalid()
  return { selector: selector(row.selector), ruleName: row.ruleName, budget: budget(row.budget),
    allowedTriggers, recordActivationEligible: row.recordActivationEligible,
    recordTriggerType: row.recordTriggerType as AutomationReadRecordTriggerType | null,
    recordRuleRevision, recordCondition,
    scheduleActivationEligible: row.scheduleActivationEligible, scheduleRuleRevision, scheduleDefinition }
}
function grant(value: unknown): AutomationReadGrant {
  const row = object(value, ['grantId', 'purpose', 'status', 'selector', 'projects', 'triggers', 'budget', 'expiresAt', 'maxExecutions', 'usedExecutions', 'createdAt', 'updatedAt'])
  if ((row.status !== 'active' && row.status !== 'revoked')
    || (row.purpose !== 'standalone' && row.purpose !== 'automatic' && row.purpose !== 'retry')) invalid()
  const maxExecutions = integer(row.maxExecutions, 1)
  const projectList = projects(row.projects), triggerList = triggers(row.triggers)
  if (row.purpose === 'automatic' && (projectList.length !== 1 || triggerList.length !== 1
    || !['record', 'schedule'].includes(triggerList[0]))) invalid()
  if (row.purpose === 'retry' && (maxExecutions !== 1 || projectList.length !== 1
    || triggerList.length !== 1 || !['manual', 'schedule'].includes(triggerList[0]))) invalid()
  return { grantId: uuid(row.grantId), purpose: row.purpose, status: row.status, selector: selector(row.selector), projects: projectList,
    triggers: triggerList, budget: budget(row.budget), expiresAt: timestamp(row.expiresAt), maxExecutions,
    usedExecutions: integer(row.usedExecutions, 0, maxExecutions), createdAt: timestamp(row.createdAt), updatedAt: timestamp(row.updatedAt) }
}
function recordActivationInput(value: unknown): AutomationReadRecordActivationInput {
  const row = object(value, ['activationKey', 'selector', 'projectNo', 'budget', 'expiresAt', 'maxExecutions', 'expectedRuleRevision', 'expectedRecordCondition'])
  return { ...activationFields(row), expectedRuleRevision: uuid(row.expectedRuleRevision),
    expectedRecordCondition: checkedAutomationReadRecordCondition(row.expectedRecordCondition) }
}
function scheduleActivationInput(value: unknown): AutomationReadScheduleActivationInput {
  const row = object(value, ['activationKey', 'selector', 'projectNo', 'budget', 'expiresAt', 'maxExecutions', 'expectedRuleRevision'], ['expectedDateField'])
  return { ...activationFields(row), expectedRuleRevision: uuid(row.expectedRuleRevision),
    ...(Object.prototype.hasOwnProperty.call(row, 'expectedDateField') ? { expectedDateField: checkedAutomationReadDateFieldConfirmation(row.expectedDateField) } : {}) }
}
function activationFields(row: Row): ActivationFields {
  return { activationKey: uuid(row.activationKey), selector: selector(row.selector), projectNo: canonical(row.projectNo),
    budget: budget(row.budget), expiresAt: timestamp(row.expiresAt), maxExecutions: integer(row.maxExecutions, 1) }
}
function recordActivationRef(value: unknown): AutomationReadRecordActivationRef {
  const row = object(value, ['activationId', 'grantId'])
  return { activationId: uuid(row.activationId), grantId: uuid(row.grantId) }
}
function state(value: unknown): AutomationReadRequestStatus {
  if (typeof value !== 'string' || !requestStatuses.includes(value as AutomationReadRequestStatus)) invalid()
  return value as AutomationReadRequestStatus
}
function preview(value: unknown): AutomationReadPreview {
  const row = object(value, ['status', 'counts', 'canApply'])
  if (row.canApply !== false || (row.status !== 'not_found' && row.status !== 'large_bom_bounded'
    && row.status !== 'ready' && row.status !== 'manual_confirm_required')) invalid()
  const counts = object(row.counts, ['add', 'update', 'skip', 'inactive', 'manual_confirm'])
  return { status: row.status, canApply: false, counts: {
    add: integer(counts.add, 0, Number.MAX_SAFE_INTEGER), update: integer(counts.update, 0, Number.MAX_SAFE_INTEGER),
    skip: integer(counts.skip, 0, Number.MAX_SAFE_INTEGER), inactive: integer(counts.inactive, 0, Number.MAX_SAFE_INTEGER),
    manual_confirm: integer(counts.manual_confirm, 0, Number.MAX_SAFE_INTEGER),
  } }
}
function requestRef(value: unknown): AutomationReadRequestRef {
  const row = object(value, ['requestId', 'status'])
  return { requestId: uuid(row.requestId), status: state(row.status) }
}
function requestDetail(value: unknown): AutomationReadRequestDetail {
  const row = object(value, ['requestId', 'status', 'result'])
  const status = state(row.status)
  if (row.result !== null && status !== 'succeeded') invalid()
  return { requestId: uuid(row.requestId), status, result: row.result === null ? null : preview(row.result) }
}
function requestSummary(value: unknown): AutomationReadRequestSummary {
  const row = object(value, ['requestId', 'grantId', 'status', 'projectNo', 'trigger', 'createdAt', 'startedAt', 'finishedAt'])
  return { requestId: uuid(row.requestId), grantId: uuid(row.grantId), status: state(row.status), projectNo: canonical(row.projectNo),
    trigger: trigger(row.trigger), createdAt: timestamp(row.createdAt), startedAt: row.startedAt === null ? null : timestamp(row.startedAt),
    finishedAt: row.finishedAt === null ? null : timestamp(row.finishedAt) }
}
/** Closed, detached observation only. It is not current execution eligibility. */
export function checkedAutomationReadRetryContext(value: unknown, parentRequestId: string): AutomationReadRetryContext {
  const parent = uuid(parentRequestId), row = object(value, ['request', 'grant', 'nextAttempt'], ['dateScheduleOrigin'])
  const request = requestSummary(row.request), authorization = grant(row.grant)
  if (request.requestId !== parent || request.grantId !== authorization.grantId
    || !authorization.projects.includes(request.projectNo) || !authorization.triggers.includes(request.trigger)) invalid()
  let dateScheduleOrigin: AutomationReadDateScheduleOrigin | undefined
  if (Object.prototype.hasOwnProperty.call(row, 'dateScheduleOrigin')) {
    const origin = object(row.dateScheduleOrigin, ['definition', 'ruleRevision'])
    const definition = checkedAutomationReadScheduleDefinition(origin.definition)
    if (definition.triggerType !== 'schedule.date_field' || request.trigger !== 'schedule'
      || (authorization.purpose !== 'automatic' && authorization.purpose !== 'retry')
      || authorization.triggers.length !== 1 || authorization.triggers[0] !== 'schedule') invalid()
    dateScheduleOrigin = Object.freeze({ definition, ruleRevision: uuid(origin.ruleRevision) })
  }
  // A schedule retry is date-only. Other historical schedule grants remain
  // observable without origin metadata, which never implies retry eligibility.
  if (authorization.purpose === 'retry' && request.trigger === 'schedule' && !dateScheduleOrigin) invalid()
  let nextAttempt = null
  if (row.nextAttempt !== null) {
    const next = object(row.nextAttempt, ['requestId', 'grantId'])
    nextAttempt = { requestId: uuid(next.requestId), grantId: uuid(next.grantId) }
    if (nextAttempt.requestId === parent || nextAttempt.grantId === authorization.grantId) invalid()
  }
  return { request, grant: authorization, nextAttempt, ...(dateScheduleOrigin ? { dateScheduleOrigin } : {}) }
}
export function checkedAutomationReadRetryInput(value: unknown): AutomationReadRetryInput {
  const row = object(value, ['retryKey', 'budget', 'expiresAt', 'acknowledgeNewRead'])
  if (row.acknowledgeNewRead !== true) invalid()
  return Object.freeze({ retryKey: uuid(row.retryKey), budget: Object.freeze(budget(row.budget)),
    expiresAt: timestamp(row.expiresAt), acknowledgeNewRead: true })
}
export function checkedAutomationReadRetryRef(value: unknown, parentRequestId: string): AutomationReadRetryRef {
  const parent = uuid(parentRequestId), row = object(value, ['parentRequestId', 'grantId', 'requestId', 'status'])
  const requestId = uuid(row.requestId)
  if (uuid(row.parentRequestId) !== parent || requestId === parent) invalid()
  return { parentRequestId: parent, grantId: uuid(row.grantId), requestId, status: state(row.status) }
}
function page<T>(value: unknown, parse: (item: unknown) => T, key: (item: T) => string, optionCursor = false): AutomationReadPage<T> {
  const row = object(value, ['items', 'nextCursor'])
  const items = array(row.items, 50).map(parse)
  const nextCursor = row.nextCursor === null ? null : optionCursor ? canonical(row.nextCursor) : uuid(row.nextCursor)
  if (new Set(items.map(key)).size !== items.length || (nextCursor !== null && nextCursor !== (items.length ? key(items[items.length - 1]) : null))) invalid()
  return { items, nextCursor }
}
function query(value: unknown, kind: 'options' | 'grants' | 'requests'): string {
  const row = object(value, kind === 'options' ? ['sheetId'] : [], ['limit', 'after', ...(kind === 'requests' ? ['grantId'] : [])])
  const params = new URLSearchParams()
  if (kind === 'options') params.set('sheetId', canonical(row.sheetId))
  if (Object.prototype.hasOwnProperty.call(row, 'limit')) params.set('limit', String(integer(row.limit, 1, 50)))
  if (Object.prototype.hasOwnProperty.call(row, 'after')) params.set('after', kind === 'options' ? canonical(row.after) : uuid(row.after))
  if (Object.prototype.hasOwnProperty.call(row, 'grantId')) params.set('grantId', uuid(row.grantId))
  const encoded = params.toString()
  return encoded ? `?${encoded}` : ''
}
function checkedInput<T>(read: () => T): T {
  try { return read() } catch { throw new AutomationReadClientError('AUTOMATION_READ_INPUT_INVALID') }
}

/** One client belongs to ONE captured session. No cookie/header scope fallback,
 * origin override, automatic retry or persisted client cache is supported.
 * A failed mutation may already have committed: callers must retain the SAME
 * invocationId when explicitly recovering a submit, never silently re-execute.
 */
export function createAutomationReadClient() {
  const token = readStoredToken()
  const signature = readAuthSessionSignature()
  if (!token || token.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)
    || signature === 'invalid' || readStoredToken() !== token) throw new AutomationReadClientError('UNAUTHORIZED')
  let disposed = false
  const controllers = new Set<AbortController>()
  let unsubscribe = () => {}
  const dispose = () => {
    if (disposed) return
    disposed = true
    unsubscribe()
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('focus', checkExternalSession)
    }
    for (const controller of controllers) controller.abort()
    controllers.clear()
  }
  const checkExternalSession = () => {
    if (readAuthSessionSignature() !== signature || readStoredToken() !== token) dispose()
  }
  const onStorage = (event: StorageEvent) => {
    // Cross-tab events may arrive after A → B → A already restored A. The
    // relevant event itself invalidates the captured session, not its final value.
    if (event.key == null || event.key === EXPLICIT_SESSION_ORG_KEY
      || TOKEN_KEYS.some(key => key === event.key)) dispose()
  }
  // Invalidate synchronously, before the auth funnel writes a new token. This
  // permanently closes A → B → A even if its deferred signature equals A again.
  unsubscribe = onAuthPrincipalChange(dispose)
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage)
    window.addEventListener('focus', checkExternalSession)
  }
  const assertSession = () => {
    checkExternalSession()
    if (disposed) throw new AutomationReadClientError('AUTOMATION_READ_SESSION_CHANGED')
  }
  async function request<T>(path: string, method: 'GET' | 'POST', expectedStatus: number, parse: (data: unknown) => T, body?: unknown): Promise<T> {
    assertSession()
    const controller = new AbortController()
    controllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), 15000)
    try {
      let response: Response
      try {
        response = await fetch(`${prefix}${path}`, { method, credentials: 'omit', mode: 'same-origin', redirect: 'error',
          cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      } catch { assertSession(); throw new AutomationReadClientError('AUTOMATION_READ_UNAVAILABLE') }
      assertSession()
      // Global JWT/RBAC middleware need not use our owner DTO. Refuse and
      // invalidate by transport status BEFORE reading any private error body.
      if (response.status === 401 || response.status === 403) {
        dispose()
        throw new AutomationReadClientError(response.status === 401 ? 'UNAUTHORIZED' : 'AUTOMATION_READ_DENIED')
      }
      let envelope: Row
      try {
        const contentType = response.headers.get('content-type')
        if (!contentType || !/^application\/json(?:\s*;|$)/iu.test(contentType)) invalid()
        const length = response.headers.get('content-length')
        if (length !== null && (!/^[0-9]+$/u.test(length) || Number(length) > maximumBodyBytes)) invalid()
        if (!response.body) invalid()
        const reader = response.body.getReader()
        const decoder = new TextDecoder('utf-8', { fatal: true })
        let bytes = 0
        let text = ''
        try {
          for (;;) {
            const chunk = await reader.read()
            assertSession()
            if (chunk.done) break
            bytes += chunk.value.byteLength
            if (bytes > maximumBodyBytes) invalid()
            text += decoder.decode(chunk.value, { stream: true })
          }
          text += decoder.decode()
        } finally { reader.releaseLock() }
        const decoded: unknown = JSON.parse(text)
        envelope = object(decoded, response.ok ? ['ok', 'data'] : ['ok', 'error'])
        if (envelope.ok !== response.ok) invalid()
      } catch {
        controller.abort()
        assertSession()
        throw new AutomationReadClientError('AUTOMATION_READ_RESPONSE_INVALID')
      }
      if (!response.ok) {
        let code: AutomationReadErrorCode
        try {
          const error = object(envelope.error, ['code'])
          if (typeof error.code !== 'string' || !Object.prototype.hasOwnProperty.call(errorStatuses, error.code)
            || error.code === 'AUTOMATION_READ_RESPONSE_INVALID' || error.code === 'AUTOMATION_READ_SESSION_CHANGED'
            || errorStatuses[error.code as AutomationReadErrorCode] !== response.status) invalid()
          code = error.code as AutomationReadErrorCode
        } catch { throw new AutomationReadClientError('AUTOMATION_READ_RESPONSE_INVALID') }
        throw new AutomationReadClientError(code)
      }
      try {
        if (response.status !== expectedStatus) invalid()
        const result = parse(envelope.data)
        assertSession()
        return result
      } catch {
        assertSession()
        throw new AutomationReadClientError('AUTOMATION_READ_RESPONSE_INVALID')
      }
    } finally {
      clearTimeout(timeout)
      controllers.delete(controller)
    }
  }
  return {
    dispose,
    async options(input: AutomationReadOptionsInput): Promise<AutomationReadPage<AutomationReadOption>> {
      assertSession()
      return request(`/options${checkedInput(() => query(input, 'options'))}`, 'GET', 200, data => page(data, option, item => item.selector.ruleId, true))
    },
    async createGrant(input: AutomationReadGrantInput): Promise<{ grantId: string }> {
      assertSession()
      const body = checkedInput(() => grantInput(input))
      return request('/grants', 'POST', 201, data => ({ grantId: uuid(object(data, ['grantId']).grantId) }), body)
    },
    async activateRecord(input: AutomationReadRecordActivationInput): Promise<AutomationReadRecordActivationRef> {
      assertSession()
      const body = checkedInput(() => recordActivationInput(input))
      return request('/record-activations', 'POST', 201, recordActivationRef, body)
    },
    async activateSchedule(input: AutomationReadScheduleActivationInput): Promise<AutomationReadScheduleActivationRef> {
      assertSession()
      const body = checkedInput(() => scheduleActivationInput(input))
      return request('/schedule-activations', 'POST', 201, recordActivationRef, body)
    },
    async listGrants(input: AutomationReadPageInput = {}): Promise<AutomationReadPage<AutomationReadGrant>> {
      assertSession()
      return request(`/grants${checkedInput(() => query(input, 'grants'))}`, 'GET', 200, data => page(data, grant, item => item.grantId))
    },
    async grantDetail(id: string): Promise<AutomationReadGrant> {
      assertSession()
      const checkedId = checkedInput(() => uuid(id))
      return request(`/grants/${checkedId}`, 'GET', 200, data => { const result = grant(data); if (result.grantId !== checkedId) invalid(); return result })
    },
    async revoke(id: string): Promise<{ grantId: string; status: 'revoked' }> {
      assertSession()
      const checkedId = checkedInput(() => uuid(id))
      return request(`/grants/${checkedId}/revoke`, 'POST', 200, data => {
        const row = object(data, ['grantId', 'status'])
        if (uuid(row.grantId) !== checkedId || row.status !== 'revoked') invalid()
        return { grantId: checkedId, status: 'revoked' }
      })
    },
    async submit(input: AutomationReadSubmitInput): Promise<AutomationReadRequestRef> {
      assertSession()
      const body = checkedInput(() => { const row = object(input, ['grantId', 'invocationId', 'projectNo']); return {
        grantId: uuid(row.grantId), invocationId: canonical(row.invocationId), projectNo: canonical(row.projectNo),
      } })
      return request('/requests', 'POST', 202, requestRef, body)
    },
    async listRequests(input: AutomationReadRequestPageInput = {}): Promise<AutomationReadPage<AutomationReadRequestSummary>> {
      assertSession()
      return request(`/requests${checkedInput(() => query(input, 'requests'))}`, 'GET', 200, data => page(data, requestSummary, item => item.requestId))
    },
    async observe(id: string): Promise<AutomationReadRequestDetail> {
      assertSession()
      const checkedId = checkedInput(() => uuid(id))
      return request(`/requests/${checkedId}`, 'GET', 200, data => { const result = requestDetail(data); if (result.requestId !== checkedId) invalid(); return result })
    },
    async retryContext(id: string): Promise<AutomationReadRetryContext> {
      assertSession()
      const checkedId = checkedInput(() => uuid(id))
      return request(`/requests/${checkedId}/retry-context`, 'GET', 200,
        data => checkedAutomationReadRetryContext(data, checkedId))
    },
    async retry(id: string, input: AutomationReadRetryInput): Promise<AutomationReadRetryRef> {
      assertSession()
      const checkedId = checkedInput(() => uuid(id)), body = checkedInput(() => checkedAutomationReadRetryInput(input))
      return request(`/requests/${checkedId}/retry`, 'POST', 202,
        data => checkedAutomationReadRetryRef(data, checkedId), body)
    },
    async cancel(id: string): Promise<AutomationReadRequestRef> {
      assertSession()
      const checkedId = checkedInput(() => uuid(id))
      return request(`/requests/${checkedId}/cancel`, 'POST', 200, data => { const result = requestRef(data); if (result.requestId !== checkedId) invalid(); return result })
    },
  }
}

export type AutomationReadClient = ReturnType<typeof createAutomationReadClient>
