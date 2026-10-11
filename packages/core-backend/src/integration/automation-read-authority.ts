import { createHash } from 'node:crypto'
import { AutomationReadLedgerError, canonicalReadId, checkedReadBudget, checkedReadSelector, checkedReadRecordCondition,
  checkedReadSourceReference, type AutomationReadAuthorityPort, type ReadBudget, type ReadSelector, type ReadSourceReference,
  type ReadRecordCondition } from './automation-read-contracts'
import { assertAutomationIntegrationActor, type AutomationIntegrationActor } from './automation-live-authority'
import { lockAutomationReadProfile, type AutomationReadProducerIdentity } from './automation-read-profiles'
import { createAutomationReadTargetContext, type AutomationReadTargetMaterialCodec } from './automation-read-target-context'
import type { LockedAutomationReadTargetContext, AutomationReadTargetExecutionMaterial } from './automation-read-target-context'
import { lockAutomationReadSourceObservation } from './automation-read-source-observation'
import { lockAutomationReadSourcePointer } from './automation-read-source-pointer'
import { lockAutomationReadRule, type LockedAutomationReadRule } from './automation-read-rule-authority'
import { deriveAutomationReadOperationPolicy } from './automation-read-operation-policy'
import { canonicalizeConfig } from '../multitable/automation-action-idempotency'
import { assertInTransaction } from '../multitable/pg-transaction-guard'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { resolveMultitableBusinessTimezone } from '../multitable/business-timezone'
import { createAutomationReadRecordConditions, AutomationReadRecordConditionsError, type LockedAutomationReadRecordConditions,
  type AutomationReadRecordConditionEvent } from './automation-read-record-conditions'

type Json = null | boolean | string | number | readonly Json[] | { readonly [key: string]: Json }
type Row = { readonly [key: string]: Json }
export type AutomationReadAuthorityCodec = AutomationReadTargetMaterialCodec & Readonly<{
  composeStockPreparationAutomationExecution(input: {
    action: unknown; scope: { tenantId: string; workspaceId: null }; active: unknown; systemId: string; budgetCeiling: ReadBudget
  }): unknown
}>
export type AutomationReadAuthorityOptions = {
  producer: AutomationReadProducerIdentity
  codec: AutomationReadAuthorityCodec
  sourceStore: { lockActiveForAutomation(trx: Queryable, input: {
    tenantId: string; workspaceId: null; actor: string; actionId: string; systemId: string
  }): Promise<unknown> }
  budgetCeiling: ReadBudget
}
type ExecutionProof = Awaited<ReturnType<AutomationReadAuthorityPort['lockExecution']>>
export type AutomationReadExecutionMaterial = Readonly<AutomationReadTargetExecutionMaterial & {
  action: Row
  target: LockedAutomationReadTargetContext
  sourceValidation: Readonly<{ connectionId: string; connectionRevision: string; bindingRevision: string }>
}>
export type AutomationReadExecutionAuthority = AutomationReadAuthorityPort & Readonly<{
  /** Private captured material only, never a continuing authorization lease. */
  materialFor(proof: ExecutionProof): AutomationReadExecutionMaterial
  /** Explicit record preparation; ordinary/manual lockExecution remains unchanged.
   * Call before grant/delivery locks. This does NOT activate or admit a record request. */
  lockRecordExecution(trx: Queryable, actor: AutomationIntegrationActor, selector: ReadSelector): Promise<ExecutionProof>
  recordConditionFor(proof: ExecutionProof): ReadRecordCondition
  evaluateRecordConditions(
    trx: Queryable, proof: ExecutionProof, event: AutomationReadRecordConditionEvent,
  ): ReturnType<ReturnType<typeof createAutomationReadRecordConditions>['evaluate']>
}>
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
function unavailable(): never { throw new AutomationReadLedgerError('AUTOMATION_READ_UNAVAILABLE') }
function denied(): never { throw new AutomationReadLedgerError('AUTOMATION_READ_DENIED') }
function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}
function data(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!plain(value) || Reflect.ownKeys(value).length !== keys.length) unavailable()
  return Object.fromEntries(keys.map(key => {
    const d = Object.getOwnPropertyDescriptor(value, key)
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) unavailable()
    return [key, d.value]
  }))
}
function json(value: unknown, seen = new Set<object>(), depth = 0): Json {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!value || typeof value !== 'object' || seen.has(value) || depth > 64) unavailable()
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) unavailable()
      return Object.freeze(Array.from({ length: value.length }, (_, index) => {
        const d = Object.getOwnPropertyDescriptor(value, String(index))
        if (!d?.enumerable || !Object.hasOwn(d, 'value')) unavailable()
        return json(d.value, seen, depth + 1)
      }))
    }
    if (!plain(value)) unavailable()
    return Object.freeze(Object.fromEntries(Reflect.ownKeys(value).map(key => {
      const d = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== 'string' || !d?.enumerable || !Object.hasOwn(d, 'value')) unavailable()
      return [key, json(d.value, seen, depth + 1)]
    })))
  } finally { seen.delete(value) }
}
function row(value: unknown): Row {
  const result = json(value)
  if (!plain(result)) unavailable()
  return result as Row
}
function actorData(value: unknown): AutomationIntegrationActor {
  const a = data(value, ['actorId', 'tenantId', 'workspaceId'])
  if (!canonicalReadId(a.actorId) || !canonicalReadId(a.tenantId) || a.workspaceId !== null) denied()
  return Object.freeze({ actorId: a.actorId, tenantId: a.tenantId, workspaceId: null })
}
function hash(value: unknown): string { return createHash('sha256').update(canonicalizeConfig(value)).digest('hex') }

/**
 * HOST PRIVATE, dormant composition. Dependencies come from one trusted host
 * activation's real plugin exports, never a request, communication API, callback
 * permission proof or persisted function. No source IO, consumer registration,
 * public rule serialization or business writes occur here.
 *
 * Actor/profile -> EXT/mirror/version/receipt/activation -> source pointer ->
 * target metadata -> rule NOWAIT -> final producer lifetime. Never take a DS
 * row lock after mirror (DS writers own the opposite order). All locks end at
 * caller commit; a future consumer must reauthorize around IO and publication.
 */
export function createAutomationReadAuthority(options: AutomationReadAuthorityOptions): AutomationReadExecutionAuthority {
  let producer: AutomationReadProducerIdentity, ceiling: ReadBudget
  let source: AutomationReadAuthorityOptions['sourceStore']['lockActiveForAutomation']
  let compose: AutomationReadAuthorityCodec['composeStockPreparationAutomationExecution']
  let target: ReturnType<typeof createAutomationReadTargetContext>
  try {
    const o = data(options, ['producer', 'codec', 'sourceStore', 'budgetCeiling'])
    const p = data(o.producer, ['generation', 'nonce'])
    if (typeof p.generation !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(p.generation)
      || BigInt(p.generation) > 9223372036854775807n || typeof p.nonce !== 'string' || !uuid.test(p.nonce)) unavailable()
    producer = Object.freeze({ generation: p.generation, nonce: p.nonce })
    ceiling = Object.freeze(checkedReadBudget(data(o.budgetCeiling, ['maxRows', 'maxPages', 'maxReadCount', 'timeoutMs'])))
    const codec = data(o.codec, ['restoreStockPreparationAutomationProfileMaterial',
      'deriveAutomationReadTargetContract', 'composeStockPreparationAutomationExecution'])
    const store = data(o.sourceStore, ['lockActiveForAutomation'])
    if (typeof store.lockActiveForAutomation !== 'function' || typeof codec.composeStockPreparationAutomationExecution !== 'function') unavailable()
    source = store.lockActiveForAutomation as typeof source
    compose = codec.composeStockPreparationAutomationExecution as typeof compose
    target = createAutomationReadTargetContext({ codec: {
      restoreStockPreparationAutomationProfileMaterial: codec.restoreStockPreparationAutomationProfileMaterial as AutomationReadAuthorityCodec['restoreStockPreparationAutomationProfileMaterial'],
      deriveAutomationReadTargetContract: codec.deriveAutomationReadTargetContract as AutomationReadAuthorityCodec['deriveAutomationReadTargetContract'],
    } })
  } catch { throw new AutomationReadLedgerError('AUTOMATION_READ_INPUT_INVALID') }
  const materials = new WeakMap<object, AutomationReadExecutionMaterial>()
  const ruleRevisions = new WeakMap<object, string>()
  const lockedRules = new WeakMap<object, LockedAutomationReadRule>()
  const conditionContexts = new WeakMap<object, LockedAutomationReadRecordConditions>()
  const recordDescriptions = new WeakMap<object, ReadRecordCondition>()
  // Fixed host configuration, not event/request input or an ambient value sampled during evaluation.
  const businessTimeZone = resolveMultitableBusinessTimezone()
  const recordConditions = createAutomationReadRecordConditions({ businessTimeZone })
  const authority: AutomationReadExecutionAuthority = {
    materialFor(proof: ExecutionProof): AutomationReadExecutionMaterial {
      const material = materials.get(proof)
      if (!material) unavailable()
      return material
    },
    async lockExecution(trx: Queryable, inputActor: AutomationIntegrationActor, inputSelector: ReadSelector) {
      let actor: AutomationIntegrationActor, selector: ReadSelector
      try {
        actor = actorData(inputActor)
        selector = Object.freeze(checkedReadSelector(data(inputSelector, ['ruleId', 'actionId', 'systemId', 'targetId'])))
      } catch { throw new AutomationReadLedgerError('AUTOMATION_READ_INPUT_INVALID') }
      try {
        const isolation = await trx.query("SELECT current_setting('transaction_isolation') AS isolation")
        if (isolation.rows.length !== 1 || isolation.rows[0]?.isolation !== 'read committed') unavailable()
        await assertInTransaction(trx, 'Automation read authority')
      } catch { throw new AutomationReadLedgerError('AUTOMATION_READ_TRANSACTION_REQUIRED') }
      try {
        await assertAutomationIntegrationActor(trx, actor)
        const initialProfile = await lockAutomationReadProfile(trx, producer, { tenantId: actor.tenantId, targetId: selector.targetId })
        const locked = data(row(await source(trx, { tenantId: actor.tenantId, workspaceId: null,
          actor: actor.actorId, actionId: selector.actionId, systemId: selector.systemId })),
        ['activation', 'version', 'sourceValidation', 'sourceAuthority'])
        const validation = data(locked.sourceValidation, ['connectionId', 'connectionRevision', 'bindingRevision'])
        const epochs = data(locked.sourceAuthority, ['versionRevision', 'receiptRevision', 'activationRevision', 'receipt'])
        if (!canonicalReadId(validation.connectionId)
          || ![validation.connectionRevision, validation.bindingRevision, epochs.versionRevision, epochs.receiptRevision, epochs.activationRevision]
            .every(value => typeof value === 'string' && uuid.test(value)) || !plain(epochs.receipt)) unavailable()
        // Mirror is already locked by the actual source store. Capture the true
        // incarnation, then prove the actual DS entity and current owner match.
        const mirrors = (await trx.query('SELECT connection_incarnation FROM integration_data_source_validation_revisions WHERE data_source_id=$1 FOR SHARE NOWAIT',
          [validation.connectionId])).rows
        if (mirrors.length !== 1) denied()
        const sourceReference = checkedReadSourceReference({ connectionId: validation.connectionId,
          connectionIncarnation: data(mirrors[0], ['connection_incarnation']).connection_incarnation })
        await lockAutomationReadSourceObservation(trx, actor, sourceReference)
        const pointer = await lockAutomationReadSourcePointer(trx, { tenantId: actor.tenantId, workspaceId: null, actionId: selector.actionId })
        const context = await target.lock(trx, { actor, producer, targetId: selector.targetId })
        const deploymentSource = row(context.targetContract.action.source)
        if (context.scope.actionId !== selector.actionId || initialProfile.actionId !== selector.actionId
          || deploymentSource.kind !== 'data-source:sql-readonly'
          || (pointer.state === 'bound' ? pointer.externalSystemId : deploymentSource.externalSystemId) !== selector.systemId) denied()
        const rule = await lockAutomationReadRule(trx, { actorId: actor.actorId, ruleId: selector.ruleId,
          sheetId: context.scope.sheetId, baseId: context.scope.baseId })
        const policy = deriveAutomationReadOperationPolicy({ actionType: rule.actionType, actionConfig: rule.actionConfig,
          actions: rule.actions, executionMode: rule.executionMode, triggerType: rule.triggerType })
        const effective = data(row(compose({ action: context.targetContract.action,
          scope: { tenantId: actor.tenantId, workspaceId: null },
          active: { activation: locked.activation, version: locked.version }, systemId: selector.systemId, budgetCeiling: ceiling })),
        ['action', 'budget'])
        const budget = Object.freeze(checkedReadBudget(effective.budget))
        if ((Object.keys(ceiling) as (keyof ReadBudget)[]).some(key => budget[key] > ceiling[key])) denied()
        const finalProfile = await lockAutomationReadProfile(trx, producer, { tenantId: actor.tenantId, targetId: selector.targetId })
        if (canonicalizeConfig(initialProfile) !== canonicalizeConfig(finalProfile)
          || finalProfile.revision !== context.revisions.profileRevision) denied()
        // Full source receipt + three DB nonces prevent A->B->A restoration.
        // ACLs are checked fresh; targetFingerprint is not an ACL epoch.
        const key = hash({ contract: 'automation-read-authority.v1', actor, selector, sourceReference,
          source: locked, pointer, rule, policy, target: context,
          deploymentTargetExecutionKey: context.targetContract.executionKey,
          effectiveActionFingerprint: hash(effective.action), ceiling, budget })
        const proof = Object.freeze({ ...actor, key, budget, sourceReference, allowedTriggers: policy.allowedTriggers })
        materials.set(proof, Object.freeze({ ...target.materialFor(context), action: row(effective.action), target: context,
          sourceValidation: Object.freeze({ connectionId: validation.connectionId,
            connectionRevision: validation.connectionRevision as string, bindingRevision: validation.bindingRevision as string }) }))
        ruleRevisions.set(proof, rule.authorityRevision)
        lockedRules.set(proof, rule)
        return proof
      } catch (error) {
        if (error instanceof AutomationReadLedgerError) throw error
        return unavailable()
      }
    },
    async lockRecordExecution(trx, inputActor, inputSelector) {
      let actor: AutomationIntegrationActor, selector: ReadSelector
      try {
        actor = actorData(inputActor)
        selector = Object.freeze(checkedReadSelector(data(inputSelector, ['ruleId', 'actionId', 'systemId', 'targetId'])))
      } catch { throw new AutomationReadLedgerError('AUTOMATION_READ_INPUT_INVALID') }
      const baseProof = await authority.lockExecution(trx, actor, selector)
      const material = authority.materialFor(baseProof)
      try {
        const rule = lockedRules.get(baseProof)
        if (!rule || (rule.triggerType !== 'record.created' && rule.triggerType !== 'record.updated')) denied()
        if (rule.triggerConfig !== null && (!plain(rule.triggerConfig) || Reflect.ownKeys(rule.triggerConfig).length !== 0)) denied()
        if (rule.conditions === null) {
          // A fresh record proof retains the ordinary key for legacy unconditional grants.
          // Merely obtaining an ordinary proof never registers record authority.
          recordDescriptions.set(baseProof, checkedReadRecordCondition({ mode: 'unconditional' }))
          return baseProof
        }
        const condition = await recordConditions.lock(trx, { actorId: actor.actorId, ruleId: selector.ruleId,
          sheetId: material.target.scope.sheetId, baseId: material.target.scope.baseId })
        if (condition.ruleRevision !== ruleRevisions.get(baseProof)
          || condition.schemaRevision !== material.target.revisions.sheetRevision) denied()
        // Additional metadata work must not extend a producer's wall-clock lifetime.
        const profile = await lockAutomationReadProfile(trx, producer, { tenantId: actor.tenantId, targetId: selector.targetId })
        if (profile.revision !== material.target.revisions.profileRevision) denied()
        const proof = Object.freeze({ ...baseProof,
          key: hash({ contract: 'automation-read-record-conditions.v1', base: baseProof.key, condition: condition.fingerprint }) })
        materials.set(proof, material)
        ruleRevisions.set(proof, condition.ruleRevision)
        conditionContexts.set(proof, condition)
        recordDescriptions.set(proof, checkedReadRecordCondition({ mode: 'saved_conditions',
          schemaRevision: condition.schemaRevision, businessTimeZone }))
        return proof
      } catch (error) {
        if (error instanceof AutomationReadLedgerError) throw error
        if (error instanceof AutomationReadRecordConditionsError && error.code === 'AUTOMATION_READ_RECORD_CONDITIONS_DENIED') denied()
        return unavailable()
      }
    },
    recordConditionFor(proof) {
      const description = recordDescriptions.get(proof)
      if (!description) denied()
      return description
    },
    async evaluateRecordConditions(trx, proof, event) {
      if (recordDescriptions.get(proof)?.mode === 'unconditional') return Object.freeze({ kind: 'match' })
      const context = conditionContexts.get(proof)
      if (!context) return { kind: 'unreadable', reason: 'CONTEXT_INVALID' }
      return recordConditions.evaluate(trx, context, event)
    },
    async lockObservation(trx: Queryable, inputActor: AutomationIntegrationActor, inputReference: ReadSourceReference) {
      let actor: AutomationIntegrationActor, reference: ReadSourceReference
      try { actor = actorData(inputActor); reference = checkedReadSourceReference(inputReference) }
      catch { throw new AutomationReadLedgerError('AUTOMATION_READ_INPUT_INVALID') }
      try {
        await assertAutomationIntegrationActor(trx, actor)
        return await lockAutomationReadSourceObservation(trx, actor, reference)
      } catch (error) {
        if (error instanceof AutomationReadLedgerError) throw error
        return unavailable()
      }
    },
  }
  return Object.freeze(authority)
}
