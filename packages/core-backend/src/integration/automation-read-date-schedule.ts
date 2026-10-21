import { AutomationReadLedgerError, canonicalReadId, readInput,
  type ReadDateFieldConfirmation, type ReadDateScheduleConfig } from './automation-read-contracts'
import { lockAutomationReadRule, AutomationRuleAuthorityError,
  type AutomationReadRuleInput, type LockedAutomationReadRule } from './automation-read-rule-authority'
import { lockAutomationReadConditionFields, AutomationTargetAuthorityError } from './automation-read-target-authority'
import { captureAutomationRecordSchema, resolveAutomationRecordSchemaRevision, AutomationRecordSchemaError,
  type AutomationRecordSchemaToken } from '../multitable/automation-record-schema'
import { computeDateReminderOccurrence, dateReminderCandidateDateRange, dateReminderFloorMs,
  isDateReminderDue, DATE_REMINDER_GRACE_WINDOW_MS, MAX_DATE_REMINDER_OFFSET_DAYS } from '../multitable/automation-date-reminder'
import { isValidIanaTimeZone } from '../multitable/automation-timezone'
import type { Queryable } from '../multitable/automation-durable-dispatcher'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const dateValueBytes = 64
const denied = (): never => { throw new AutomationReadLedgerError('AUTOMATION_READ_DENIED') }
const unavailable = (): never => { throw new AutomationReadLedgerError('AUTOMATION_READ_UNAVAILABLE') }
const changed = (): never => { throw new AutomationReadLedgerError('AUTOMATION_READ_SCOPE_CHANGED') }

function capture(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  readInput(!!value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null))
  const keys = Reflect.ownKeys(value)
  readInput(required.every(key => keys.includes(key))
    && keys.every(key => typeof key === 'string' && (required.includes(key) || optional.includes(key))))
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    readInput(descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value'))
    result[key as string] = descriptor.value
  }
  return result
}

function civilDay(year: number, month: number, day: number): boolean {
  // The legacy pure helper uses Date.UTC, whose years 0..99 mean 1900..1999.
  // Do not grant a different civil day through that compatibility conversion.
  if (year < 100 || year > 9999 || month < 1 || month > 12 || day < 1) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
}

/** Explicit offset only: Date.parse alone normalizes invalid civil dates and accepts local time. */
function instant(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > dateValueBytes) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/u.exec(value)
  if (!match || !civilDay(Number(match[1]), Number(match[2]), Number(match[3]))
    || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return null
  if (match[8] !== 'Z') {
    const hours = Number(match[8].slice(1, 3)), minutes = Number(match[8].slice(4, 6))
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0) || match[8] === '-00:00') return null
  }
  const milliseconds = Date.parse(value)
  return Number.isSafeInteger(milliseconds) ? milliseconds : null
}

/** Closed persisted config, not the permissive legacy reminder normalizer. */
export function checkedReadDateScheduleConfig(value: unknown): ReadDateScheduleConfig {
  const row = capture(value, ['dateFieldId', 'offsetDays', 'direction'],
    ['timeOfDay', 'timezone', 'effectiveAt', 'scanIntervalMs'])
  readInput(canonicalReadId(row.dateFieldId) && Number.isSafeInteger(row.offsetDays)
    && Number(row.offsetDays) >= 0 && Number(row.offsetDays) <= MAX_DATE_REMINDER_OFFSET_DAYS
    && (row.direction === 'before' || row.direction === 'after'))
  if (Object.hasOwn(row, 'timeOfDay')) readInput(typeof row.timeOfDay === 'string'
    && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(row.timeOfDay))
  if (Object.hasOwn(row, 'timezone')) readInput(typeof row.timezone === 'string'
    && row.timezone.length <= 128 && /^[A-Za-z][A-Za-z0-9_+./-]*$/u.test(row.timezone)
    && isValidIanaTimeZone(row.timezone))
  if (Object.hasOwn(row, 'effectiveAt')) readInput(instant(row.effectiveAt) !== null)
  // Historical cadence is retained byte-for-byte but NEVER controls due/grace or scan budgets.
  if (Object.hasOwn(row, 'scanIntervalMs')) readInput(Number.isSafeInteger(row.scanIntervalMs) && Number(row.scanIntervalMs) > 0)
  return Object.freeze({ dateFieldId: row.dateFieldId, offsetDays: Number(row.offsetDays), direction: row.direction,
    ...(Object.hasOwn(row, 'timeOfDay') ? { timeOfDay: row.timeOfDay as string } : {}),
    ...(Object.hasOwn(row, 'timezone') ? { timezone: row.timezone as string } : {}),
    ...(Object.hasOwn(row, 'effectiveAt') ? { effectiveAt: row.effectiveAt as string } : {}),
    ...(Object.hasOwn(row, 'scanIntervalMs') ? { scanIntervalMs: Number(row.scanIntervalMs) } : {}),
  })
}

export function checkedReadDateFieldConfirmation(value: unknown): ReadDateFieldConfirmation {
  const row = capture(value, ['fieldId', 'fieldType', 'schemaRevision'])
  readInput(canonicalReadId(row.fieldId) && (row.fieldType === 'date' || row.fieldType === 'dateTime')
    && typeof row.schemaRevision === 'string' && uuid.test(row.schemaRevision))
  return Object.freeze({ fieldId: row.fieldId, fieldType: row.fieldType, schemaRevision: row.schemaRevision })
}

declare const contextBrand: unique symbol
declare const dueBrand: unique symbol
export type LockedAutomationReadDateSchedule = Readonly<{
  readonly [contextBrand]: true
  scope: Readonly<AutomationReadRuleInput>
  ruleRevision: string
  config: ReadDateScheduleConfig
  dateField: ReadDateFieldConfirmation
  createdAtMs: number
}>
/** Opaque same-transaction fact; raw dates never leave this module. */
export type AutomationReadDateDueProof = Readonly<{ readonly [dueBrand]: true }>
export type AutomationReadDateSchedulePageInput = Readonly<{
  afterId?: string; limit: number; scanAtMs: number; activatedAt: string; signal: AbortSignal
}>
type State = Readonly<{
  trx: Queryable; xid: string; schema: AutomationRecordSchemaToken; rule: LockedAutomationReadRule
  fieldFingerprint: string
}>
type DueState = Readonly<{ context: LockedAutomationReadDateSchedule; recordId: string; occurrenceAt: string }>

async function currentXid(trx: Queryable): Promise<string> {
  const result = await trx.query('SELECT pg_current_xact_id()::text AS xid')
  if (result.rows.length !== 1) return unavailable()
  const row = receipt(result.rows[0], ['xid'])
  return typeof row.xid === 'string' && /^\d+$/u.test(row.xid) ? row.xid : unavailable()
}
function receipt(value: unknown, keys: readonly string[]): Record<string, unknown> {
  try { return capture(value, keys) } catch { return unavailable() }
}
function boundary(error: unknown): never {
  if (error instanceof AutomationReadLedgerError) throw error
  if (error instanceof AutomationRuleAuthorityError || error instanceof AutomationTargetAuthorityError
    || error instanceof AutomationRecordSchemaError) {
    if (error.code.endsWith('_TRANSACTION_REQUIRED')) throw new AutomationReadLedgerError('AUTOMATION_READ_TRANSACTION_REQUIRED')
    if (error.code.endsWith('_DENIED')) return denied()
  }
  return unavailable()
}
function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new AutomationReadLedgerError('AUTOMATION_READ_FENCE_LOST')
}
function validDateValue(value: unknown, type: ReadDateFieldConfirmation['fieldType']): value is string {
  if (typeof value !== 'string') return false
  if (type === 'dateTime') return instant(value) !== null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  return !!match && civilDay(Number(match[1]), Number(match[2]), Number(match[3]))
}

/** Additional DATE gate only, called AFTER current grant/actor/source/target authority.
 * No tenant/Connection permission, grant, event or source IO is minted here. All proofs
 * are private to one factory and one exact RC transaction. Metadata lock never reads
 * record values. The existing conservative full-read gate precedes every date projection.
 */
export function createAutomationReadDateSchedule() {
  const contexts = new WeakMap<object, State>()
  const proofs = new WeakMap<object, DueState>()
  async function recheck(trx: Queryable, context: LockedAutomationReadDateSchedule): Promise<State> {
    const state = context && typeof context === 'object' ? contexts.get(context) : undefined
    if (!state || state.trx !== trx) return denied()
    if (await currentXid(trx) !== state.xid) return denied()
    if (await resolveAutomationRecordSchemaRevision(trx, context.scope.sheetId, state.schema) !== context.dateField.schemaRevision) return changed()
    const rule = await lockAutomationReadRule(trx, context.scope)
    if (rule.authorityRevision !== context.ruleRevision || rule.fingerprint !== state.rule.fingerprint) return changed()
    const metadata = await lockAutomationReadConditionFields(trx, { actorId: context.scope.actorId,
      baseId: context.scope.baseId, sheetId: context.scope.sheetId, fieldIds: [context.dateField.fieldId] })
    if (metadata.fingerprint !== state.fieldFingerprint || metadata.fields.length !== 1
      || metadata.fields[0].id !== context.dateField.fieldId || metadata.fields[0].type !== context.dateField.fieldType) return changed()
    if (await resolveAutomationRecordSchemaRevision(trx, context.scope.sheetId, state.schema) !== context.dateField.schemaRevision) return changed()
    return state
  }
  return Object.freeze({
    async lock(trx: Queryable, input: AutomationReadRuleInput): Promise<LockedAutomationReadDateSchedule> {
      const raw = capture(input, ['actorId', 'baseId', 'sheetId', 'ruleId'])
      readInput(Object.values(raw).every(canonicalReadId))
      const scope = Object.freeze({ actorId: raw.actorId as string, baseId: raw.baseId as string,
        sheetId: raw.sheetId as string, ruleId: raw.ruleId as string })
      try {
        const schema = await captureAutomationRecordSchema(trx, scope.sheetId, { AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true' })
        if (!schema) return unavailable()
        const schemaRevision = await resolveAutomationRecordSchemaRevision(trx, scope.sheetId, schema)
        if (schemaRevision === null) return unavailable()
        const rule = await lockAutomationReadRule(trx, scope)
        if (rule.triggerType !== 'schedule.date_field' || rule.conditions !== null) return denied()
        let config: ReadDateScheduleConfig
        try { config = checkedReadDateScheduleConfig(rule.triggerConfig) } catch { return denied() }
        const metadata = await lockAutomationReadConditionFields(trx, { actorId: scope.actorId,
          baseId: scope.baseId, sheetId: scope.sheetId, fieldIds: [config.dateFieldId] })
        const field = metadata.fields[0]
        if (metadata.fields.length !== 1 || field?.id !== config.dateFieldId || (field.type !== 'date' && field.type !== 'dateTime')) return denied()
        const dates = await trx.query(`SELECT CASE WHEN pg_catalog.isfinite(created_at)
          THEN floor(extract(epoch FROM created_at)*1000)::text ELSE NULL END AS created_at_ms
          FROM automation_rules WHERE id=$1 AND integration_authority_revision=$2::uuid`, [scope.ruleId, rule.authorityRevision])
        if (dates.rows.length !== 1) return changed()
        const created = receipt(dates.rows[0], ['created_at_ms']).created_at_ms
        if (typeof created !== 'string' || !/^\d+$/u.test(created) || !Number.isSafeInteger(Number(created))
          || !Number.isFinite(new Date(Number(created)).getTime())) return denied()
        if (await resolveAutomationRecordSchemaRevision(trx, scope.sheetId, schema) !== schemaRevision) return changed()
        const finalRule = await lockAutomationReadRule(trx, scope)
        if (finalRule.authorityRevision !== rule.authorityRevision || finalRule.fingerprint !== rule.fingerprint) return changed()
        const context = Object.freeze({ scope, ruleRevision: rule.authorityRevision, config,
          dateField: checkedReadDateFieldConfirmation({ fieldId: field.id, fieldType: field.type, schemaRevision }),
          createdAtMs: Number(created) }) as LockedAutomationReadDateSchedule
        contexts.set(context, Object.freeze({ trx, xid: await currentXid(trx), schema, rule, fieldFingerprint: metadata.fingerprint }))
        return context
      } catch (error) { return boundary(error) }
    },

    async page(trx: Queryable, context: LockedAutomationReadDateSchedule, input: AutomationReadDateSchedulePageInput): Promise<Readonly<{
      items: readonly AutomationReadDateDueProof[]; nextCursor: string | null; scanned: number
    }>> {
      const page = capture(input, ['limit', 'scanAtMs', 'activatedAt', 'signal'], ['afterId'])
      readInput(Number.isSafeInteger(page.limit) && Number(page.limit) >= 1 && Number(page.limit) <= 100
        && Number.isSafeInteger(page.scanAtMs) && Number(page.scanAtMs) > 0
        && Number.isFinite(new Date(Number(page.scanAtMs)).getTime()) && page.signal instanceof AbortSignal)
      if (Object.hasOwn(page, 'afterId')) readInput(canonicalReadId(page.afterId))
      const activatedAtMs = instant(page.activatedAt)
      readInput(activatedAtMs !== null)
      const signal = page.signal as AbortSignal, limit = Number(page.limit), scanAtMs = Number(page.scanAtMs)
      const afterId = page.afterId === undefined ? null : page.afterId as string
      try {
        checkSignal(signal)
        await recheck(trx, context)
        checkSignal(signal)
        const clock = await trx.query('SELECT extract(epoch FROM pg_catalog.clock_timestamp())*1000 AS now_ms')
        if (clock.rows.length !== 1) return unavailable()
        const rawNow = receipt(clock.rows[0], ['now_ms']).now_ms
        if ((typeof rawNow !== 'number' && typeof rawNow !== 'string')
          || (typeof rawNow === 'string' && !/^\d+(?:\.\d+)?$/u.test(rawNow)) || !Number.isFinite(Number(rawNow))) return unavailable()
        const nowMs = Number(rawNow)
        if (!Number.isFinite(new Date(nowMs).getTime()) || scanAtMs > nowMs) return unavailable()
        const { loIso, hiIso } = dateReminderCandidateDateRange(scanAtMs, context.config, DATE_REMINDER_GRACE_WINDOW_MS)
        checkSignal(signal)
        const rows = (await trx.query(`SELECT r.id,
          CASE WHEN pg_catalog.jsonb_typeof(r.data->$2::text)='string'
            AND octet_length(r.data->>$2::text)<=${dateValueBytes} THEN r.data->>$2::text ELSE NULL END AS date_value
          FROM meta_records r WHERE r.sheet_id=$1 AND ($3::text IS NULL OR r.id COLLATE "C">$3::text COLLATE "C")
            AND r.data->>$2::text BETWEEN $4 AND $5
          ORDER BY r.id COLLATE "C" LIMIT $6 FOR SHARE OF r NOWAIT`,
        [context.scope.sheetId, context.dateField.fieldId, afterId, loIso, hiIso, limit])).rows
        checkSignal(signal)
        if (rows.length > limit) return unavailable()
        const due: AutomationReadDateDueProof[] = []
        let last = afterId
        for (const row of rows) {
          const value = receipt(row, ['id', 'date_value'])
          if (!canonicalReadId(value.id) || (last !== null && Buffer.compare(Buffer.from(value.id), Buffer.from(last)) <= 0)) return unavailable()
          last = value.id
          if (value.date_value !== null && (typeof value.date_value !== 'string' || Buffer.byteLength(value.date_value, 'utf8') > dateValueBytes)) return unavailable()
          if (!validDateValue(value.date_value, context.dateField.fieldType)) continue
          const occurrenceAt = computeDateReminderOccurrence(value.date_value, context.config, { floating: context.dateField.fieldType === 'date' })
          if (!occurrenceAt || !isDateReminderDue(occurrenceAt, nowMs, DATE_REMINDER_GRACE_WINDOW_MS,
            dateReminderFloorMs(context.createdAtMs, context.config.effectiveAt)) || Date.parse(occurrenceAt) > scanAtMs
            || Date.parse(occurrenceAt) <= activatedAtMs) continue
          const proof = Object.freeze({}) as AutomationReadDateDueProof
          proofs.set(proof, Object.freeze({ context, recordId: value.id, occurrenceAt }))
          due.push(proof)
        }
        // Look ahead with ID ONLY: limit=100 never transfers a 101st date value.
        // Advance over the last processed candidate, including malformed/not-due values.
        let nextCursor: string | null = null
        if (rows.length === limit && last !== null) {
          checkSignal(signal)
          const lookahead = (await trx.query(`SELECT r.id FROM meta_records r
            WHERE r.sheet_id=$1 AND r.id COLLATE "C">$3::text COLLATE "C" AND r.data->>$2::text BETWEEN $4 AND $5
            ORDER BY r.id COLLATE "C" LIMIT 1 FOR SHARE OF r NOWAIT`,
          [context.scope.sheetId, context.dateField.fieldId, last, loIso, hiIso])).rows
          checkSignal(signal)
          if (lookahead.length > 1) return unavailable()
          if (lookahead.length === 1) {
            const next = receipt(lookahead[0], ['id']).id
            if (!canonicalReadId(next) || Buffer.compare(Buffer.from(next), Buffer.from(last)) <= 0) return unavailable()
            nextCursor = last
          }
        }
        await recheck(trx, context)
        checkSignal(signal)
        return Object.freeze({ items: Object.freeze(due), nextCursor, scanned: rows.length })
      } catch (error) { return boundary(error) }
    },

    async facts(trx: Queryable, context: LockedAutomationReadDateSchedule, proof: AutomationReadDateDueProof): Promise<Readonly<{
      recordId: string; occurrenceAt: string
    }>> {
      const fact = proof && typeof proof === 'object' ? proofs.get(proof) : undefined
      if (!fact || fact.context !== context) return denied()
      try {
        await recheck(trx, context)
        return Object.freeze({ recordId: fact.recordId, occurrenceAt: fact.occurrenceAt })
      } catch (error) { return boundary(error) }
    },
  })
}
