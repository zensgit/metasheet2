import { createHash } from 'node:crypto'
import { canonicalReadId } from './automation-read-contracts'
import { lockAutomationReadRule, AutomationRuleAuthorityError, type AutomationReadRuleInput,
  type LockedAutomationReadRule } from './automation-read-rule-authority'
import { lockAutomationReadConditionFields, AutomationTargetAuthorityError } from './automation-read-target-authority'
import { captureAutomationRecordSchema, resolveAutomationRecordSchemaRevision, AutomationRecordSchemaError,
  type AutomationRecordSchemaToken } from '../multitable/automation-record-schema'
import { compileStrictAutomationConditions, inspectStrictAutomationConditionFieldIds,
  evaluateStrictAutomationConditions, StrictConditionValidationError,
  type CompiledStrictAutomationConditions, type StrictAutomationConditionField } from '../multitable/automation-conditions'
import { resolveDateTimeFieldTimeZone, BUSINESS_TIMEZONE_ENV_KEY } from '../multitable/business-timezone'
import { isValidIanaTimeZone } from '../multitable/automation-timezone'
import { canonicalizeConfig } from '../multitable/automation-action-idempotency'
import type { Queryable } from '../multitable/automation-durable-dispatcher'

export type AutomationReadRecordConditionsErrorCode = 'AUTOMATION_READ_RECORD_CONDITIONS_INPUT_INVALID'
  | 'AUTOMATION_READ_RECORD_CONDITIONS_TRANSACTION_REQUIRED' | 'AUTOMATION_READ_RECORD_CONDITIONS_UNAVAILABLE'
  | 'AUTOMATION_READ_RECORD_CONDITIONS_DENIED'
export class AutomationReadRecordConditionsError extends Error {
  constructor(readonly code: AutomationReadRecordConditionsErrorCode) {
    super(code)
    this.name = 'AutomationReadRecordConditionsError'
  }
}
export type LockedAutomationReadRecordConditions = Readonly<{
  scope: Readonly<AutomationReadRuleInput>
  ruleRevision: string
  schemaRevision: string
  fieldIds: readonly string[]
  fingerprint: string
}>
export type AutomationReadRecordConditionEvent = Readonly<{
  outboxId: string; eventId: string; eventType: 'multitable.record.created' | 'multitable.record.updated'
}>
export type AutomationReadRecordConditionResult = Readonly<{ kind: 'match' | 'no_match' }>
  | Readonly<{ kind: 'unreadable'; reason: 'CONTEXT_INVALID' | 'SCHEMA_CHANGED' | 'RULE_CHANGED'
    | 'FIELD_ACCESS_DENIED' | 'AFTER_IMAGE_UNAVAILABLE' | 'VALUE_UNREADABLE' }>
type State = Readonly<{
  trx: Queryable; xid: string; schema: AutomationRecordSchemaToken; rule: LockedAutomationReadRule
  compiled: CompiledStrictAutomationConditions
}>
const AST_BYTES = 65536
const PROPERTY_BYTES = 131072
const IMAGE_BYTES = 262144
const fail = (code: AutomationReadRecordConditionsErrorCode): never => {
  throw new AutomationReadRecordConditionsError(code)
}
const inputInvalid = (): never => fail('AUTOMATION_READ_RECORD_CONDITIONS_INPUT_INVALID')
const unavailable = (): never => fail('AUTOMATION_READ_RECORD_CONDITIONS_UNAVAILABLE')
const denied = (): never => fail('AUTOMATION_READ_RECORD_CONDITIONS_DENIED')
function data(value: unknown, keys: readonly string[], invalid: () => never = inputInvalid): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Reflect.ownKeys(value).length !== keys.length) return invalid()
  return Object.fromEntries(keys.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid()
    return [key, descriptor.value]
  }))
}
function captureInput(value: AutomationReadRuleInput): Readonly<AutomationReadRuleInput> {
  const row = data(value, ['actorId', 'ruleId', 'sheetId', 'baseId'])
  if (!Object.values(row).every(canonicalReadId)) return inputInvalid()
  return Object.freeze({ actorId: row.actorId as string, ruleId: row.ruleId as string,
    sheetId: row.sheetId as string, baseId: row.baseId as string })
}
function captureEvent(value: AutomationReadRecordConditionEvent): AutomationReadRecordConditionEvent {
  const row = data(value, ['outboxId', 'eventId', 'eventType'])
  if (!canonicalReadId(row.outboxId) || !canonicalReadId(row.eventId)
    || (row.eventType !== 'multitable.record.created' && row.eventType !== 'multitable.record.updated')) return inputInvalid()
  return Object.freeze({ outboxId: row.outboxId, eventId: row.eventId, eventType: row.eventType })
}
function boundary(error: unknown): never {
  if (error instanceof AutomationReadRecordConditionsError) throw error
  if (error instanceof StrictConditionValidationError) return denied()
  if (error instanceof AutomationRuleAuthorityError || error instanceof AutomationTargetAuthorityError
    || error instanceof AutomationRecordSchemaError) {
    if (error.code.endsWith('_TRANSACTION_REQUIRED')) return fail('AUTOMATION_READ_RECORD_CONDITIONS_TRANSACTION_REQUIRED')
    if (error.code.endsWith('_DENIED')) return denied()
  }
  return unavailable()
}
async function xid(trx: Queryable): Promise<string> {
  const result = await trx.query('SELECT pg_current_xact_id()::text AS xid')
  if (result.rows.length !== 1) return unavailable()
  const value = data(result.rows[0], ['xid'], unavailable).xid
  if (typeof value !== 'string' || !/^[0-9]+$/u.test(value)) return unavailable()
  return value
}
function decoded(text: unknown, limit: number): { value: unknown; json: string } {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > limit) return denied()
  try {
    const value: unknown = JSON.parse(text)
    return { value, json: JSON.stringify(value) }
  } catch { return denied() }
}
function exact(result: Awaited<ReturnType<Queryable['query']>>): boolean {
  return result.rows.length === 1 && data(result.rows[0], ['exact'], unavailable).exact === true
}
const unreadable = (reason: Extract<AutomationReadRecordConditionResult, { kind: 'unreadable' }>['reason']): AutomationReadRecordConditionResult =>
  Object.freeze({ kind: 'unreadable', reason })

/** HOST PRIVATE preparation only. The trusted host must independently prove the live owner/tenant,
 * Connection/source/receipt, fixed operation and grant. This module does not itself admit requests
 * or authorize source IO; the record ledger owns that gate. All locks/material belong to one RC txn.
 * Raw JSON round trips compare mathematical PG JSONB values, not lossy driver objects. The existing
 * rule-authority helper still reads its complete private raw rule; only our added transfers are bounded.
 */
export function createAutomationReadRecordConditions(options: { businessTimeZone: string }) {
  const captured = data(options, ['businessTimeZone'])
  const zone = captured.businessTimeZone
  if (typeof zone !== 'string' || zone.length > 128 || zone !== zone.trim() || !isValidIanaTimeZone(zone)) return inputInvalid()
  const env = Object.freeze({ [BUSINESS_TIMEZONE_ENV_KEY]: zone })
  const states = new WeakMap<object, State>()
  return Object.freeze({
    async lock(trx: Queryable, input: AutomationReadRuleInput): Promise<LockedAutomationReadRecordConditions> {
      const scope = captureInput(input)
      try {
        const schema = await captureAutomationRecordSchema(trx, scope.sheetId, { AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true' })
        if (!schema) return denied()
        const schemaRevision = await resolveAutomationRecordSchemaRevision(trx, scope.sheetId, schema)
        if (schemaRevision === null) return denied()
        const rule = await lockAutomationReadRule(trx, scope)
        if ((rule.triggerType !== 'record.created' && rule.triggerType !== 'record.updated') || rule.conditions === null) return denied()
        if (rule.triggerConfig !== null) {
          try { data(rule.triggerConfig, []) } catch { return denied() }
        }
        const rows = (await trx.query(`SELECT integration_authority_revision::text AS rule_revision,
          CASE WHEN octet_length(conditions::text)<=${AST_BYTES} THEN conditions::text ELSE NULL END AS conditions_json,
          octet_length(conditions::text)>${AST_BYTES} AS conditions_oversized
          FROM automation_rules WHERE id=$1`, [scope.ruleId])).rows
        if (rows.length !== 1) return denied()
        const raw = data(rows[0], ['rule_revision', 'conditions_json', 'conditions_oversized'], unavailable)
        if (raw.rule_revision !== rule.authorityRevision || raw.conditions_oversized !== false) return denied()
        const condition = decoded(raw.conditions_json, AST_BYTES)
        if (!exact(await trx.query(`SELECT conditions=$2::jsonb AS exact FROM automation_rules
          WHERE id=$1 AND integration_authority_revision=$3::uuid`, [scope.ruleId, condition.json, rule.authorityRevision]))) return denied()
        const fieldIds = inspectStrictAutomationConditionFieldIds(condition.value)
        const metadata = await lockAutomationReadConditionFields(trx, { actorId: scope.actorId, baseId: scope.baseId,
          sheetId: scope.sheetId, fieldIds: [...fieldIds] })
        let bytes = 0
        const fields: StrictAutomationConditionField[] = []
        for (const field of metadata.fields) {
          bytes += Buffer.byteLength(field.propertyJson, 'utf8')
          if (bytes > PROPERTY_BYTES) return denied()
          const property = decoded(field.propertyJson, AST_BYTES)
          if (!exact(await trx.query(`SELECT COALESCE(NULLIF(property,'null'::jsonb),'{}'::jsonb)=$3::jsonb AS exact
            FROM meta_fields WHERE sheet_id=$1 AND id=$2`, [scope.sheetId, field.id, property.json]))) return denied()
          fields.push({ id: field.id, type: field.type, property: property.value,
            resolvedTimeZone: resolveDateTimeFieldTimeZone(property.value, env) })
        }
        const compiled = compileStrictAutomationConditions(condition.value, fields)
        if (await resolveAutomationRecordSchemaRevision(trx, scope.sheetId, schema) !== schemaRevision) return denied()
        const finalRule = await lockAutomationReadRule(trx, scope)
        if (finalRule.authorityRevision !== rule.authorityRevision || finalRule.fingerprint !== rule.fingerprint) return denied()
        const context = Object.freeze({ scope, ruleRevision: rule.authorityRevision, schemaRevision,
          fieldIds: Object.freeze([...compiled.fieldIds]), fingerprint: createHash('sha256').update(canonicalizeConfig({
            scope, rule: rule.fingerprint, schemaRevision, conditions: condition.json,
            fields: metadata.fields, businessTimeZone: zone,
          })).digest('hex') })
        states.set(context, Object.freeze({ trx, xid: await xid(trx), schema, rule, compiled }))
        return context
      } catch (error) { return boundary(error) }
    },
    async evaluate(trx: Queryable, context: LockedAutomationReadRecordConditions,
      inputEvent: AutomationReadRecordConditionEvent): Promise<AutomationReadRecordConditionResult> {
      const event = captureEvent(inputEvent)
      const state = context && typeof context === 'object' ? states.get(context) : undefined
      if (!state || state.trx !== trx) return unreadable('CONTEXT_INVALID')
      try {
        if (await xid(trx) !== state.xid) return unreadable('CONTEXT_INVALID')
        if (await resolveAutomationRecordSchemaRevision(trx, context.scope.sheetId, state.schema) !== context.schemaRevision) return unreadable('SCHEMA_CHANGED')
        let current: LockedAutomationReadRule
        try { current = await lockAutomationReadRule(trx, context.scope) } catch (error) {
          if (error instanceof AutomationRuleAuthorityError && error.code === 'AUTOMATION_RULE_AUTHORITY_DENIED') return unreadable('RULE_CHANGED')
          throw error
        }
        if (current.authorityRevision !== context.ruleRevision || current.fingerprint !== state.rule.fingerprint) return unreadable('RULE_CHANGED')
        const eventType = state.rule.triggerType === 'record.created' ? 'multitable.record.created' : 'multitable.record.updated'
        if (event.eventType !== eventType) return unreadable('AFTER_IMAGE_UNAVAILABLE')
        // A caller can change ACL rows in its own transaction, or roll back a later savepoint
        // that held the ACL locks while keeping the earlier schema fence. Reprove current read
        // access before transferring any private values; never treat SQL/lock failure as denial.
        try {
          await lockAutomationReadConditionFields(trx, { actorId: context.scope.actorId,
            baseId: context.scope.baseId, sheetId: context.scope.sheetId, fieldIds: [...context.fieldIds] })
        } catch (error) {
          if (error instanceof AutomationTargetAuthorityError && error.code === 'AUTOMATION_TARGET_AUTHORITY_DENIED') return unreadable('FIELD_ACCESS_DENIED')
          throw error
        }
        // The stored field projection preserves absent keys and explicit JSON null. It never reads a
        // current record, synthesizes system fields or sends raw/condition values in public evidence.
        const result = await trx.query(`SELECT (
            o.event_type=$3 AND o.event_id=$2 AND i.event_type=o.event_type AND i.event_id=o.event_id
            AND pg_catalog.jsonb_typeof(o.payload->'sheetId')='string'
            AND pg_catalog.jsonb_typeof(o.payload->'recordId')='string'
            AND o.payload->>'sheetId'=$5 AND i.sheet_id=$5
            AND o.payload->>'recordId'=i.record_id AND i.format_version=1 AND i.status='captured'
            AND i.record_version BETWEEN 1 AND 9007199254740991 AND i.schema_revision=$6::uuid
            AND pg_catalog.jsonb_typeof(i.after_image)='object') IS TRUE AS identity_valid,
          CASE WHEN octet_length(p.projected::text)<=${IMAGE_BYTES} THEN p.projected::text ELSE NULL END AS projected_json
          FROM meta_automation_outbox o JOIN meta_automation_record_after_images i ON i.outbox_id=o.id
          CROSS JOIN LATERAL (SELECT COALESCE(jsonb_object_agg(e.key,e.value),'{}'::jsonb) AS projected
            FROM jsonb_each(CASE WHEN jsonb_typeof(i.after_image)='object' THEN i.after_image ELSE '{}'::jsonb END) e
            WHERE e.key=ANY($4::text[])) p WHERE o.id=$1 FOR SHARE OF o,i NOWAIT`,
        [event.outboxId, event.eventId, event.eventType, [...context.fieldIds], context.scope.sheetId, context.schemaRevision])
        if (result.rows.length !== 1) return unreadable('AFTER_IMAGE_UNAVAILABLE')
        const image = data(result.rows[0], ['identity_valid', 'projected_json'], unavailable)
        if (image.identity_valid !== true) return unreadable('AFTER_IMAGE_UNAVAILABLE')
        let parsed: { value: unknown; json: string }
        try { parsed = decoded(image.projected_json, IMAGE_BYTES) } catch { return unreadable('VALUE_UNREADABLE') }
        const roundTrip = await trx.query(`SELECT p.projected=$3::jsonb AS exact
          FROM meta_automation_outbox o JOIN meta_automation_record_after_images i ON i.outbox_id=o.id
          CROSS JOIN LATERAL (SELECT COALESCE(jsonb_object_agg(e.key,e.value),'{}'::jsonb) AS projected
            FROM jsonb_each(i.after_image) e WHERE e.key=ANY($2::text[])) p WHERE o.id=$1`,
        [event.outboxId, [...context.fieldIds], parsed.json])
        if (!exact(roundTrip)) return unreadable('VALUE_UNREADABLE')
        const evaluated = evaluateStrictAutomationConditions(state.compiled, parsed.value)
        return evaluated.kind === 'unreadable' ? unreadable('VALUE_UNREADABLE') : Object.freeze({ kind: evaluated.kind })
      } catch (error) {
        // SQL/lock failures must not become an ACK-able semantic non-match/unreadable event.
        if (error instanceof AutomationReadRecordConditionsError) throw error
        return unavailable()
      }
    },
  })
}
