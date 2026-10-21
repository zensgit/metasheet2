import { assertInTransaction } from '../multitable/pg-transaction-guard'
import { performance } from 'node:perf_hooks'
import { cronHasNoMatchingDay, nextCronOccurrenceMs, parseCronExpression } from '../multitable/automation-scheduler'
import { getZonedParts, isValidIanaTimeZone, isZonedFallbackRepeat, utcMsFromParts } from '../multitable/automation-timezone'
import { scheduleIntervalMs } from '../multitable/automation-triggers'
import { assertReadRecordSignal, captureReadRecordData } from './automation-read-record-activation'
import { checkedReadDateFieldConfirmation, checkedReadDateScheduleConfig } from './automation-read-date-schedule'
import {
  AutomationReadLedgerError, canonicalReadId, readInput,
  type AutomationReadLedgerDependencies, type ReadScheduleOccurrence, type ReadScheduleDefinition,
} from './automation-read-contracts'

export type ReadScheduleConfig = Readonly<{ expression?: string; cron?: string; timezone?: string }>

/** Persist the exact closed config, including expression/cron spelling. */
export function checkedReadScheduleConfig(value: unknown): ReadScheduleConfig {
  readInput(!!value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null))
  const keys = Reflect.ownKeys(value)
  readInput(keys.every(key => key === 'expression' || key === 'cron' || key === 'timezone')
    && (Object.hasOwn(value, 'expression') !== Object.hasOwn(value, 'cron')))
  const data = captureReadRecordData(value, keys as string[])
  const expression = data.expression ?? data.cron
  readInput(canonicalReadId(expression) && !!parseCronExpression(expression) && !cronHasNoMatchingDay(expression))
  if (Object.hasOwn(data, 'timezone')) readInput(canonicalReadId(data.timezone)
    && /^[A-Za-z][A-Za-z0-9_+./-]*$/.test(data.timezone) && isValidIanaTimeZone(data.timezone))
  return Object.freeze({ ...(Object.hasOwn(data, 'expression') ? { expression } : { cron: expression }),
    ...(Object.hasOwn(data, 'timezone') ? { timezone: data.timezone as string } : {}) })
}

export function captureReadScheduleOccurrence(value: ReadScheduleOccurrence): Readonly<ReadScheduleOccurrence> {
  // Inspect a data descriptor, never invoke a supplied getter to choose a family.
  const type = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'triggerType') : undefined
  readInput(!type || (Object.hasOwn(type, 'value') && type.enumerable === true))
  const interval = type?.value === 'schedule.interval'
  const date = type?.value === 'schedule.date_field'
  const data = captureReadRecordData(value, interval
    ? ['ruleId', 'scheduledAtMs', 'triggerType', 'intervalMs', 'anchorMs']
    : type ? ['ruleId', 'scheduledAtMs', 'triggerType'] : ['ruleId', 'scheduledAtMs'])
  readInput(!type || data.triggerType === 'schedule.cron' || interval || date)
  readInput(canonicalReadId(data.ruleId) && Number.isSafeInteger(data.scheduledAtMs)
    && Number(data.scheduledAtMs) > 0 && (interval || date || Number(data.scheduledAtMs) % 60000 === 0)
    && Number.isFinite(new Date(Number(data.scheduledAtMs)).getTime()))
  if (interval) {
    const definition = checkedReadScheduleDefinition('schedule.interval', { intervalMs: data.intervalMs }, data.anchorMs)
    readInput(definition.triggerType === 'schedule.interval'
      && isReadScheduleDefinitionOccurrence(definition, Number(data.scheduledAtMs)))
    return Object.freeze({ ruleId: data.ruleId, scheduledAtMs: Number(data.scheduledAtMs), ...definition })
  }
  if (date) return Object.freeze({ ruleId: data.ruleId, scheduledAtMs: Number(data.scheduledAtMs), triggerType: 'schedule.date_field' })
  return Object.freeze({ ruleId: data.ruleId, scheduledAtMs: Number(data.scheduledAtMs) })
}

/** The DB persists floor(epoch(created_at)*1000), not a rounded bigint cast.
 * Historical rows must carry their own phase; never infer one from wall time. */
export function checkedReadIntervalAnchor(value: unknown): number {
  readInput(typeof value === 'number' || (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)))
  const anchor = Number(value)
  readInput(Number.isSafeInteger(anchor) && anchor > 0 && Number.isFinite(new Date(anchor).getTime()))
  return anchor
}

export function checkedReadScheduleDefinition(triggerType: unknown, config: unknown, anchor: unknown, dateField?: unknown): ReadScheduleDefinition {
  if (triggerType === 'schedule.date_field') {
    readInput(anchor === null)
    const checked = checkedReadDateScheduleConfig(config), confirmation = checkedReadDateFieldConfirmation(dateField)
    readInput(checked.dateFieldId === confirmation.fieldId)
    return Object.freeze({ triggerType, config: checked, dateField: confirmation })
  }
  readInput(dateField === undefined || dateField === null)
  if (triggerType === 'schedule.cron') {
    readInput(anchor === null)
    return Object.freeze({ triggerType, config: checkedReadScheduleConfig(config) })
  }
  readInput(triggerType === 'schedule.interval')
  const intervalMs = scheduleIntervalMs(config, true)
  readInput(intervalMs !== null)
  return Object.freeze({ triggerType, intervalMs, anchorMs: checkedReadIntervalAnchor(anchor) })
}

export function isReadScheduleDefinitionOccurrence(definition: ReadScheduleDefinition, at: number): boolean {
  // A host wake is not a record occurrence. Only the private date proof admits one.
  if (definition.triggerType === 'schedule.date_field') return false
  if (definition.triggerType === 'schedule.cron') return isReadScheduleOccurrence(definition.config, at)
  return Number.isSafeInteger(at) && Number.isFinite(new Date(at).getTime())
    && at > definition.anchorMs && (at - definition.anchorMs) % definition.intervalMs === 0
}

export function readSchedulePlanMatches(definition: ReadScheduleDefinition, occurrence: ReadScheduleOccurrence): boolean {
  if (definition.triggerType === 'schedule.date_field' || occurrence.triggerType === 'schedule.date_field') return false
  if (definition.triggerType === 'schedule.cron') return occurrence.triggerType !== 'schedule.interval'
    && isReadScheduleDefinitionOccurrence(definition, occurrence.scheduledAtMs)
  return occurrence.triggerType === 'schedule.interval' && occurrence.intervalMs === definition.intervalMs
    && occurrence.anchorMs === definition.anchorMs && isReadScheduleDefinitionOccurrence(definition, occurrence.scheduledAtMs)
}

/** Cheap reject before the scheduler's potentially multi-year next scan. The
 * scheduler remains the final minute/DST proof, not this conservative prefilter. */
export function isReadScheduleOccurrence(config: ReadScheduleConfig, at: number): boolean {
  const expression = config.expression ?? config.cron!
  const parsed = parseCronExpression(expression)
  if (!parsed || !Number.isSafeInteger(at) || at % 60000 !== 0) return false
  const date = new Date(at)
  const parts = config.timezone ? getZonedParts(at, config.timezone) : {
    year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
    hour: date.getUTCHours(), minute: date.getUTCMinutes(),
  }
  const dow = new Date(utcMsFromParts(parts.year, parts.month, parts.day)).getUTCDay()
  if (!parsed.minute.has(parts.minute) || !parsed.hour.has(parts.hour) || !parsed.month.has(parts.month)
    || (!parsed.dayOfMonthWildcard && !parsed.dayOfWeekWildcard
      && !parsed.dayOfMonth.has(parts.day) && !parsed.dayOfWeek.has(dow))
    || (parsed.dayOfMonthWildcard && !parsed.dayOfWeekWildcard && !parsed.dayOfWeek.has(dow))
    || (!parsed.dayOfMonthWildcard && parsed.dayOfWeekWildcard && !parsed.dayOfMonth.has(parts.day))
    || (config.timezone && config.timezone !== 'UTC' && config.timezone !== 'Etc/UTC'
      && isZonedFallbackRepeat(at, config.timezone))) return false
  return nextCronOccurrenceMs(expression, at - 60000, config.timezone) === at
}

/** Metadata clock readiness, not permission or a future-time tolerance. Every
 * probe finishes its short transaction before a cancellable timer is armed.
 * Limits bound active waiting/probe count, not physical SQL/network duration;
 * an in-flight PG promise is always awaited/drained, never raced away. */
export async function waitForReadScheduleDbClock(
  transaction: AutomationReadLedgerDependencies['transaction'], input: Readonly<ReadScheduleOccurrence>, signal: AbortSignal,
): Promise<void> {
  const occurrence = captureReadScheduleOccurrence(input), started = performance.now()
  const unavailable = () => { throw new AutomationReadLedgerError('AUTOMATION_READ_UNAVAILABLE') }
  const remaining = () => {
    const elapsed = performance.now() - started
    if (!Number.isFinite(started) || !Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 1000) return unavailable()
    return 1000 - elapsed
  }
  function sleep(milliseconds: number): Promise<void> {
    assertReadRecordSignal(signal)
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined, settled = false
      const finish = (aborted: boolean) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        if (aborted) reject(new AutomationReadLedgerError('AUTOMATION_READ_FENCE_LOST'))
        else resolve()
      }
      const onAbort = () => finish(true)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) finish(true)
      else timer = setTimeout(() => finish(false), milliseconds)
    })
  }
  try {
    for (let probe = 0; probe < 4; probe++) {
      assertReadRecordSignal(signal)
      remaining()
      const clock = await transaction(async trx => {
        const isolation = await trx.query("SELECT current_setting('transaction_isolation') AS isolation")
        if (isolation.rows.length !== 1 || isolation.rows[0]?.isolation !== 'read committed') return unavailable()
        await assertInTransaction(trx, 'Automation read schedule clock readiness')
        assertReadRecordSignal(signal)
        const result = await trx.query('SELECT extract(epoch FROM pg_catalog.clock_timestamp()) * 1000 AS now_ms')
        const value = result.rows[0]?.now_ms
        if (result.rows.length !== 1 || (typeof value !== 'number' && typeof value !== 'string')
          || (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value))
          || !Number.isFinite(Number(value))) return unavailable()
        return Number(value)
      })
      assertReadRecordSignal(signal)
      const budget = remaining(), lag = occurrence.scheduledAtMs - clock
      if (!Number.isFinite(lag) || lag > 1000) return unavailable()
      if (lag <= 0) return
      if (probe === 3) return unavailable()
      await sleep(Math.min(Math.ceil(lag), budget))
    }
  } catch (error) {
    if (error instanceof AutomationReadLedgerError && error.code === 'AUTOMATION_READ_FENCE_LOST') throw error
    return unavailable()
  }
}

/** Bounded metadata only. No source/actor authority and no new scheduler. Every
 * candidate must be reauthorized on submit's own transaction. */
export async function findAutomationReadScheduleCandidates(
  transaction: AutomationReadLedgerDependencies['transaction'], input: ReadScheduleOccurrence, signal: AbortSignal,
): Promise<readonly string[]> {
  const occurrence = captureReadScheduleOccurrence(input)
  assertReadRecordSignal(signal)
  try {
    return await transaction(async trx => {
      const isolation = await trx.query("SELECT current_setting('transaction_isolation') AS isolation")
      if (isolation.rows.length !== 1 || isolation.rows[0]?.isolation !== 'read committed') {
        throw new AutomationReadLedgerError('AUTOMATION_READ_TRANSACTION_REQUIRED')
      }
      await assertInTransaction(trx, 'Automation read schedule candidates')
      assertReadRecordSignal(signal)
      const rows = (await trx.query(`SELECT a.id,a.cron_config,a.trigger_type,a.interval_anchor_ms,a.date_field_confirmation FROM integration_automation_read_schedule_activations a
        JOIN integration_automation_read_grants g ON g.id=a.grant_id AND g.tenant_id=a.tenant_id AND g.owner_id=a.owner_id
        JOIN automation_rules r ON r.id=a.rule_id
        WHERE a.rule_id=$1 AND g.purpose='automatic' AND g.status='active' AND g.workspace_id IS NULL
          AND g.triggers=ARRAY['schedule']::text[] AND g.projects=ARRAY[a.project_no]::text[]
          AND g.expires_at>pg_catalog.clock_timestamp() AND g.used_executions<g.max_executions
          AND pg_catalog.to_timestamp($2::double precision/1000)>a.activated_at
          AND pg_catalog.to_timestamp($2::double precision/1000)<=pg_catalog.clock_timestamp()
          AND r.created_by=a.owner_id AND r.enabled=true AND r.integration_authority_revision=a.rule_revision
          AND r.trigger_type=a.trigger_type AND a.trigger_type=$3 AND (r.conditions IS NULL OR r.conditions='null'::jsonb)
          AND r.trigger_config=a.cron_config
          AND (a.trigger_type IN ('schedule.cron','schedule.date_field') OR (a.trigger_type='schedule.interval'
            AND pg_catalog.isfinite(r.created_at)
            AND a.interval_anchor_ms=floor(extract(epoch FROM r.created_at)*1000)))
        ORDER BY a.id LIMIT 101`, [occurrence.ruleId, occurrence.scheduledAtMs, occurrence.triggerType ?? 'schedule.cron'])).rows
      assertReadRecordSignal(signal)
      if (rows.length > 100) throw new AutomationReadLedgerError('AUTOMATION_READ_UNAVAILABLE')
      const ids = rows.filter(row => {
        const definition = checkedReadScheduleDefinition(row.trigger_type, row.cron_config, row.interval_anchor_ms, row.date_field_confirmation)
        return definition.triggerType === 'schedule.date_field'
          ? occurrence.triggerType === 'schedule.date_field' : readSchedulePlanMatches(definition, occurrence)
      }).map(row => {
        if (typeof row.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.id)) {
          throw new AutomationReadLedgerError('AUTOMATION_READ_DENIED')
        }
        return row.id
      })
      assertReadRecordSignal(signal)
      return Object.freeze(ids)
    })
  } catch (error) {
    if (error instanceof AutomationReadLedgerError) throw error
    throw new AutomationReadLedgerError('AUTOMATION_READ_UNAVAILABLE')
  }
}
