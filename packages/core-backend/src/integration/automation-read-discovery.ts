import { assertAutomationIntegrationActor, AutomationActorAuthorityError, type AutomationIntegrationActor } from './automation-live-authority'
import { AutomationReadLedgerError, canonicalReadId, checkedReadBudget, checkedReadSelector,
  checkedReadSourceReference, checkedReadTriggers, checkedReadRecordCondition, readInput, type AutomationReadLedgerDependencies,
  type ReadBudget, type ReadRecordCondition, type ReadScheduleDefinition, type ReadSelector, type ReadTrigger } from './automation-read-contracts'
import { AutomationReadProfileError, lockAutomationReadProducerForRead, type AutomationReadProducerIdentity } from './automation-read-profiles'
import { checkedReadScheduleDefinition } from './automation-read-schedule-activation'
import { checkedReadDateScheduleConfig, createAutomationReadDateSchedule } from './automation-read-date-schedule'
import { readRecordTriggerType, type ReadRecordTriggerType } from './automation-read-record-activation'
import type { Queryable } from '../multitable/automation-durable-dispatcher'

export const AUTOMATION_READ_OPTION_NAME_MAX = 160
export type AutomationReadOptionsInput = { sheetId: string; limit?: number; after?: string }
export type AutomationReadOption = {
  selector: ReadSelector; ruleName: string; budget: ReadBudget; allowedTriggers: readonly ReadTrigger[]
  recordActivationEligible: boolean; scheduleActivationEligible: boolean
  recordTriggerType: ReadRecordTriggerType | null
  /** Current eligible rule snapshot only; never a historical grant event type. */
  recordRuleRevision: string | null
  recordCondition: ReadRecordCondition | null
  scheduleRuleRevision: string | null
  scheduleDefinition: ReadScheduleDefinition | null
}
export type AutomationReadOptionsPage = { items: AutomationReadOption[]; nextCursor: string | null }
type Dependencies = Pick<AutomationReadLedgerDependencies, 'transaction' | 'authority'> & {
  producer: AutomationReadProducerIdentity
}

function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  readInput(value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null))
  const keys = Reflect.ownKeys(value)
  readInput(required.every(key => Object.hasOwn(value, key))
    && keys.every(key => typeof key === 'string' && (required.includes(key) || optional.includes(key))))
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key)
    readInput(d?.enumerable === true && Object.hasOwn(d, 'value'))
    result[key as string] = d.value
  }
  return result
}
function denied(): never { throw new AutomationReadLedgerError('AUTOMATION_READ_DENIED') }
function unavailable(): never { throw new AutomationReadLedgerError('AUTOMATION_READ_UNAVAILABLE') }

// These unlocked metadata joins are ONLY bounded candidate hints. They do not
// authorize a name or selector. In particular a present source pointer never
// falls back to deployment material, even if that pointer is malformed.
const candidates = `SELECT r.id AS "ruleId", p.action_id AS "actionId", e.id AS "systemId", p.target_id::text AS "targetId"
  FROM automation_rules r
  JOIN meta_sheets s ON s.id=r.sheet_id AND s.deleted_at IS NULL
  JOIN meta_bases base ON base.id=s.base_id AND base.deleted_at IS NULL
  JOIN automation_read_target_bindings b ON b.sheet_id=s.id AND b.tenant_id=$2
  JOIN automation_read_target_profiles p ON p.sheet_id=b.sheet_id AND p.tenant_id=b.tenant_id
    AND p.enabled=true AND p.producer_generation=$3::bigint AND p.producer_nonce=$4::uuid
    AND p.action_id='plm.stock-preparation.pull-bom.v1'
  LEFT JOIN integration_stock_prep_source_binding pointer ON pointer.tenant_id=p.tenant_id
    AND COALESCE(pointer.workspace_id,'')='' AND pointer.action_id=p.action_id
  JOIN integration_external_systems e ON e.id=CASE WHEN pointer.id IS NULL
    THEN p.material#>>'{action,source,externalSystemId}' ELSE pointer.external_system_id END
    AND e.tenant_id=$2 AND e.workspace_id IS NULL AND e.kind='data-source:sql-readonly'
    AND e.status='active' AND e.role IN ('source','bidirectional')
  JOIN data_sources d ON d.id=e.connection_id AND d.tenant_id=$2 AND d.owner_id=$1
    AND d.workspace_id IS NULL AND d.scope_kind='private' AND d.is_active=true AND d.deleted_at IS NULL
  JOIN integration_data_source_validation_revisions m ON m.data_source_id=d.id
    AND m.tenant_id=d.tenant_id AND m.owner_id=d.owner_id AND m.workspace_id IS NULL
    AND m.scope_kind=d.scope_kind AND m.is_active=d.is_active AND m.deleted_at IS NULL
    AND m.type=d.type AND m.validation_revision=d.validation_revision AND m.connection_incarnation=d.connection_incarnation
  WHERE r.sheet_id=$5 AND r.created_by=$1 AND r.enabled=true AND r.action_type='integration_read_preview'
    AND (r.execution_mode IS NULL OR r.execution_mode='legacy')`

/** Owner-only discovery of this sheet's currently executable preview selectors.
 * No source adapter, target records API, result reader or material exporter is
 * available here. Every hint (including cursor and lookahead) must pass genuine
 * execution authority before any name is fetched. A failure rejects the whole
 * page; never skip a failed proof inside an aborted PostgreSQL transaction.
 */
export function createAutomationReadDiscovery(deps: Dependencies) {
  const producer = Object.freeze({ ...deps.producer })
  const dateSchedule = createAutomationReadDateSchedule()
  async function fence(trx: Queryable): Promise<void> {
    try { await lockAutomationReadProducerForRead(trx, producer) }
    catch (error) {
      if (error instanceof AutomationReadProfileError && error.code === 'AUTOMATION_PROFILE_FENCE_LOST') {
        throw new AutomationReadLedgerError('AUTOMATION_READ_FENCE_LOST')
      }
      throw error
    }
  }
  return Object.freeze({
    async options(actor: AutomationIntegrationActor, input: AutomationReadOptionsInput): Promise<AutomationReadOptionsPage> {
      let owner: AutomationIntegrationActor, sheetId: string, limit: number, after: string | undefined
      try {
        const scope = record(actor, ['actorId', 'tenantId', 'workspaceId'])
        readInput(canonicalReadId(scope.actorId) && canonicalReadId(scope.tenantId) && scope.workspaceId === null)
        owner = Object.freeze({ actorId: scope.actorId, tenantId: scope.tenantId, workspaceId: null })
        const page = record(input, ['sheetId'], ['limit', 'after'])
        readInput(canonicalReadId(page.sheetId))
        sheetId = page.sheetId
        limit = Object.hasOwn(page, 'limit') ? page.limit as number : 20
        readInput(Number.isSafeInteger(limit) && limit >= 1 && limit <= 50)
        if (Object.hasOwn(page, 'after')) { readInput(canonicalReadId(page.after)); after = page.after }
      } catch { throw new AutomationReadLedgerError('AUTOMATION_READ_INPUT_INVALID') }
      try {
        return await deps.transaction(async trx => {
          // This also probes RC + a genuine same-transaction xid, even for empty pages.
          await assertAutomationIntegrationActor(trx, owner)
          await fence(trx)
          const params = [owner.actorId, owner.tenantId, producer.generation, producer.nonce, sheetId]
          async function authorize(hint: unknown): Promise<AutomationReadOption> {
            const selector = Object.freeze(checkedReadSelector(record(hint, ['ruleId', 'actionId', 'systemId', 'targetId'])))
            const proof = record(await deps.authority.lockExecution(trx, owner, selector),
              ['actorId', 'tenantId', 'workspaceId', 'key', 'budget', 'sourceReference', 'allowedTriggers'])
            if (proof.actorId !== owner.actorId || proof.tenantId !== owner.tenantId || proof.workspaceId !== null
              || typeof proof.key !== 'string' || !/^[a-f0-9]{64}$/u.test(proof.key)) denied()
            // Validate private proof data, but never return it or access materialFor.
            checkedReadSourceReference(proof.sourceReference)
            const budget = checkedReadBudget(record(proof.budget, ['maxRows', 'maxPages', 'maxReadCount', 'timeoutMs']))
            const allowedTriggers = checkedReadTriggers(proof.allowedTriggers)
            // Authority holds the exact rule SHARE lock; fetch no name before it.
            const names = (await trx.query(`SELECT name,trigger_type,trigger_config,conditions,
                (SELECT base_id FROM meta_sheets WHERE id=automation_rules.sheet_id AND deleted_at IS NULL) AS base_id,
                integration_authority_revision::text AS rule_revision,
                CASE WHEN trigger_type='schedule.interval' AND pg_catalog.isfinite(created_at)
                  THEN floor(extract(epoch FROM created_at)*1000)::text ELSE NULL END AS interval_anchor_ms FROM automation_rules
              WHERE id=$1 AND sheet_id=$2 AND created_by=$3 AND enabled=true`, [selector.ruleId, sheetId, owner.actorId])).rows
            if (names.length !== 1) denied()
            const name = names[0].name
            if (name !== null && typeof name !== 'string') denied()
            const config = names[0].trigger_config
            // Display eligibility only, derived AFTER the actual rule lock.
            // It never replaces either activation's independent current checks.
            const currentRecordType = readRecordTriggerType(names[0].trigger_type)
            let recordActivationEligible = allowedTriggers.includes('record')
              && currentRecordType !== null
              && (config === null || (typeof config === 'object' && !Array.isArray(config)
                && (Object.getPrototypeOf(config) === Object.prototype || Object.getPrototypeOf(config) === null)
                && Reflect.ownKeys(config).length === 0))
            let recordCondition: ReadRecordCondition | null = null
            if (recordActivationEligible) {
              if (typeof deps.authority.lockRecordExecution !== 'function'
                || typeof deps.authority.evaluateRecordConditions !== 'function'
                || typeof deps.authority.recordConditionFor !== 'function') unavailable()
              // Preparation is genuine authority, not a metadata eligibility
              // guess. Preserve the original proof identity for the private
              // descriptor lookup; no copied proof, AST or digest crosses HTTP.
              let original
              try { original = await deps.authority.lockRecordExecution(trx, owner, selector) }
              catch (error) {
                // A genuine, explicit unsupported/denied preparation leaves
                // ordinary/manual discovery intact. Never downgrade SQL/lock
                // failures or a missing capability into display-only denial.
                if (!(error instanceof AutomationReadLedgerError) || error.code !== 'AUTOMATION_READ_DENIED') throw error
                recordActivationEligible = false
              }
              if (original) {
                const prepared = record(original,
                  ['actorId', 'tenantId', 'workspaceId', 'key', 'budget', 'sourceReference', 'allowedTriggers'])
                if (prepared.actorId !== owner.actorId || prepared.tenantId !== owner.tenantId || prepared.workspaceId !== null
                  || typeof prepared.key !== 'string' || !/^[a-f0-9]{64}$/u.test(prepared.key)) denied()
                checkedReadSourceReference(prepared.sourceReference)
                checkedReadBudget(record(prepared.budget, ['maxRows', 'maxPages', 'maxReadCount', 'timeoutMs']))
                if (!checkedReadTriggers(prepared.allowedTriggers).includes('record')) denied()
                recordCondition = checkedReadRecordCondition(deps.authority.recordConditionFor(original))
                if ((names[0].conditions === null) !== (recordCondition.mode === 'unconditional')) unavailable()
              } else if (recordActivationEligible) unavailable()
            }
            const recordRuleRevision = recordActivationEligible ? names[0].rule_revision : null
            if (recordActivationEligible && (typeof recordRuleRevision !== 'string'
              || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(recordRuleRevision))) unavailable()
            let scheduleActivationEligible = false
            let scheduleDefinition: ReadScheduleDefinition | null = null
            if (allowedTriggers.includes('schedule') && ['schedule.cron', 'schedule.interval'].includes(String(names[0].trigger_type))
              && names[0].conditions === null) {
              // Only parsing is downgraded to display-ineligible. The authority
              // and SQL awaits above remain outside this catch and reject the page.
              try {
                scheduleDefinition = checkedReadScheduleDefinition(names[0].trigger_type, config, names[0].interval_anchor_ms)
                scheduleActivationEligible = true
              } catch { /* Saved schedule is not eligible for this activation contract. */ }
            }
            if (allowedTriggers.includes('schedule') && names[0].trigger_type === 'schedule.date_field'
              && names[0].conditions === null) {
              let validConfig = false
              try { checkedReadDateScheduleConfig(config); validConfig = true } catch { /* Ineligible saved config, no new consent. */ }
              if (validConfig) {
                if (!canonicalReadId(names[0].base_id)) unavailable()
                try {
                  // Metadata and current field/full-read authority only. Discovery
                  // never scans records, including while preparing date consent.
                  const prepared = await dateSchedule.lock(trx, { actorId: owner.actorId,
                    baseId: names[0].base_id, sheetId, ruleId: selector.ruleId })
                  if (prepared.ruleRevision !== names[0].rule_revision) unavailable()
                  scheduleDefinition = checkedReadScheduleDefinition('schedule.date_field', prepared.config, null, prepared.dateField)
                  scheduleActivationEligible = true
                } catch (error) {
                  if (!(error instanceof AutomationReadLedgerError) || error.code !== 'AUTOMATION_READ_DENIED') throw error
                }
              }
            }
            const scheduleRuleRevision = scheduleActivationEligible ? names[0].rule_revision : null
            if (scheduleActivationEligible && (typeof scheduleRuleRevision !== 'string'
              || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(scheduleRuleRevision))) unavailable()
            return { selector, ruleName: typeof name === 'string' ? name.slice(0, AUTOMATION_READ_OPTION_NAME_MAX) : '',
              budget, allowedTriggers, recordActivationEligible, scheduleActivationEligible,
              recordTriggerType: recordActivationEligible ? currentRecordType : null,
              recordRuleRevision: typeof recordRuleRevision === 'string' ? recordRuleRevision : null, recordCondition,
              scheduleRuleRevision: typeof scheduleRuleRevision === 'string' ? scheduleRuleRevision : null, scheduleDefinition }
          }
          if (after !== undefined) {
            const cursor = (await trx.query(`${candidates} AND r.id=$6`, [...params, after])).rows
            if (cursor.length !== 1) denied()
            await authorize(cursor[0])
          }
          const rows = (await trx.query(`${candidates}
            AND ($6::text IS NULL OR r.id COLLATE "C" > $6::text COLLATE "C")
            ORDER BY r.id COLLATE "C" ASC LIMIT $7`, [...params, after ?? null, limit + 1])).rows
          if (rows.length > limit + 1) unavailable()
          const items: AutomationReadOption[] = [], seen = new Set<string>()
          for (const row of rows) {
            const item = await authorize(row)
            if (seen.has(item.selector.ruleId)) unavailable()
            seen.add(item.selector.ruleId); items.push(item)
          }
          // Locks cannot suspend wall-clock expiry. Check again even on empty pages.
          await fence(trx)
          return { items: items.slice(0, limit), nextCursor: items.length > limit ? items[limit - 1].selector.ruleId : null }
        })
      } catch (error) {
        if (error instanceof AutomationReadLedgerError || error instanceof AutomationActorAuthorityError) throw error
        // Do not serialize SQL, profile or actor-provider exception details.
        return unavailable()
      }
    },
  })
}
