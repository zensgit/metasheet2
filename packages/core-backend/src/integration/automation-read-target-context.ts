import { canonicalReadId } from './automation-read-contracts'
import { assertAutomationIntegrationActor, type AutomationIntegrationActor } from './automation-live-authority'
import { lockAutomationReadProfile, type AutomationReadProducerIdentity } from './automation-read-profiles'
import { loadAutomationReadInstalledMaterial } from './automation-read-installed-material'
import type { AutomationReadInstalledMaterial } from './automation-read-installed-material'
import { lockAutomationReadTarget } from './automation-read-target-authority'
import { canonicalizeConfig } from '../multitable/automation-action-idempotency'
import { assertInTransaction } from '../multitable/pg-transaction-guard'
import type { Queryable } from '../multitable/automation-durable-dispatcher'

type Json = null | string | boolean | number | readonly Json[] | { readonly [key: string]: Json }
type JsonObject = { readonly [key: string]: Json }
export type AutomationReadTargetMaterialCodec = Readonly<{
  restoreStockPreparationAutomationProfileMaterial(input: { material: unknown }): unknown
  deriveAutomationReadTargetContract(input: { action: unknown; installedFieldProperties: unknown; extFieldMapping: unknown }): unknown
}>
export type AutomationReadTargetContextInput = {
  actor: AutomationIntegrationActor
  producer: AutomationReadProducerIdentity
  targetId: string
}
export type LockedAutomationReadTargetContext = Readonly<{
  scope: Readonly<AutomationIntegrationActor & {
    targetId: string; actionId: string; projectId: string; objectId: string; sheetId: string; baseId: string
  }>
  revisions: Readonly<{
    producer: AutomationReadProducerIdentity; profileRevision: string
    sheetRevision: string; baseRevision: string; packRevision: string | null
  }>
  targetContract: Readonly<{
    action: JsonObject
    projection: Readonly<{ logicalFieldIds: readonly string[]; fieldIds: readonly string[]; projectFieldId: string; activeFieldId: string }>
    executionKey: string
  }>
  content: Readonly<{ installedFingerprint: string; targetFingerprint: string }>
}>
export type AutomationReadTargetContextErrorCode = 'AUTOMATION_TARGET_CONTEXT_INPUT_INVALID'
  | 'AUTOMATION_TARGET_CONTEXT_TRANSACTION_REQUIRED' | 'AUTOMATION_TARGET_CONTEXT_UNAVAILABLE' | 'AUTOMATION_TARGET_CONTEXT_DENIED'
export type AutomationReadTargetExecutionMaterial = Readonly<{
  installedFieldProperties: AutomationReadInstalledMaterial['installedFieldProperties']
  // Keep the genuine plugin closure-branded mapping; it cannot be serialized
  // and reconstructed as a permission/capability proof.
  extFieldMapping: unknown
}>
export class AutomationReadTargetContextError extends Error {
  constructor(readonly code: AutomationReadTargetContextErrorCode) { super(code); this.name = 'AutomationReadTargetContextError' }
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const digest = /^[a-f0-9]{64}$/u
function fail(code: AutomationReadTargetContextErrorCode): never { throw new AutomationReadTargetContextError(code) }
function unavailable(): never { return fail('AUTOMATION_TARGET_CONTEXT_UNAVAILABLE') }
function denied(): never { return fail('AUTOMATION_TARGET_CONTEXT_DENIED') }
function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}
function data(value: unknown, keys: string[]): Record<string, unknown> {
  if (!plain(value) || Reflect.ownKeys(value).length !== keys.length) return unavailable()
  return Object.fromEntries(keys.map(key => {
    const d = Object.getOwnPropertyDescriptor(value, key)
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) return unavailable()
    return [key, d.value]
  }))
}
function json(value: unknown, seen = new Set<object>(), depth = 0): Json {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!value || typeof value !== 'object' || seen.has(value) || depth > 64) return unavailable()
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) return unavailable()
      return Object.freeze(Array.from({ length: value.length }, (_, index) => {
        const d = Object.getOwnPropertyDescriptor(value, String(index))
        if (!d?.enumerable || !Object.hasOwn(d, 'value')) return unavailable()
        return json(d.value, seen, depth + 1)
      }))
    }
    if (!plain(value)) return unavailable()
    return Object.freeze(Object.fromEntries(Reflect.ownKeys(value).map(key => {
      const d = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== 'string' || !d?.enumerable || !Object.hasOwn(d, 'value')) return unavailable()
      return [key, json(d.value, seen, depth + 1)]
    })))
  } finally { seen.delete(value) }
}
function jsonObject(value: unknown): JsonObject {
  const captured = json(value)
  if (!plain(captured)) return unavailable()
  return captured as JsonObject
}
function same(a: unknown, b: unknown): boolean { return canonicalizeConfig(a) === canonicalizeConfig(b) }
function ids(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 256 || !value.every(canonicalReadId)
    || new Set(value).size !== value.length) return unavailable()
  return Object.freeze([...value] as string[])
}

/**
 * HOST-PRIVATE target-side composition only, currently not registered. The codec
 * is installed once by the trusted host from the real plugin's two pure exports;
 * it is never selected by a request, persisted material or plugin communication.
 * It supplies no DB handle, field-read permission, actor proof or source capability.
 * All live authorities below are direct core calls on the caller-owned RC handle.
 *
 * Actor is locked FIRST, before any metadata table lock. The future full provider
 * must coordinate actor -> source/rule -> target lock order; never call a blocking
 * source authority after this target context has acquired metadata locks.
 * No source/rule authority, installer-completion proof, grant or consumer is claimed.
 * Epochs detect metadata ABA, not authentic install completion. ACLs are read fresh;
 * no ACL lease or permission continuity after commit is represented by this vector.
 */
export function createAutomationReadTargetContext(options: { codec: AutomationReadTargetMaterialCodec }): Readonly<{
  lock(trx: Queryable, input: AutomationReadTargetContextInput): Promise<LockedAutomationReadTargetContext>
  materialFor(context: LockedAutomationReadTargetContext): AutomationReadTargetExecutionMaterial
}> {
  let restore: AutomationReadTargetMaterialCodec['restoreStockPreparationAutomationProfileMaterial']
  let derive: AutomationReadTargetMaterialCodec['deriveAutomationReadTargetContract']
  try {
    const captured = data(options, ['codec'])
    const codec = data(captured.codec, ['restoreStockPreparationAutomationProfileMaterial', 'deriveAutomationReadTargetContract'])
    if (typeof codec.restoreStockPreparationAutomationProfileMaterial !== 'function'
      || typeof codec.deriveAutomationReadTargetContract !== 'function') unavailable()
    restore = codec.restoreStockPreparationAutomationProfileMaterial as typeof restore
    derive = codec.deriveAutomationReadTargetContract as typeof derive
  } catch { return fail('AUTOMATION_TARGET_CONTEXT_INPUT_INVALID') }

  const materials = new WeakMap<object, AutomationReadTargetExecutionMaterial>()
  return Object.freeze({
    materialFor(context: LockedAutomationReadTargetContext): AutomationReadTargetExecutionMaterial {
      const material = materials.get(context)
      if (!material) unavailable()
      return material
    },
    async lock(trx: Queryable, input: AutomationReadTargetContextInput): Promise<LockedAutomationReadTargetContext> {
      let actor: Readonly<AutomationIntegrationActor>, producer: AutomationReadProducerIdentity, targetId: string
      try {
        const captured = data(input, ['actor', 'producer', 'targetId'])
        const a = data(captured.actor, ['actorId', 'tenantId', 'workspaceId'])
        const p = data(captured.producer, ['generation', 'nonce'])
        if (!canonicalReadId(a.actorId) || !canonicalReadId(a.tenantId) || a.workspaceId !== null
          || typeof p.generation !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(p.generation)
          || BigInt(p.generation) > 9223372036854775807n || typeof p.nonce !== 'string' || !uuid.test(p.nonce)
          || typeof captured.targetId !== 'string' || !uuid.test(captured.targetId)) unavailable()
        actor = Object.freeze({ actorId: a.actorId, tenantId: a.tenantId, workspaceId: null })
        producer = Object.freeze({ generation: p.generation, nonce: p.nonce })
        targetId = captured.targetId
      } catch { return fail('AUTOMATION_TARGET_CONTEXT_INPUT_INVALID') }
      try {
        const isolation = await trx.query("SELECT current_setting('transaction_isolation') AS isolation")
        if (isolation.rows.length !== 1 || isolation.rows[0]?.isolation !== 'read committed') unavailable()
        await assertInTransaction(trx, 'Automation target context')
      } catch { return fail('AUTOMATION_TARGET_CONTEXT_TRANSACTION_REQUIRED') }
      try {
        await assertAutomationIntegrationActor(trx, actor)
        const profile = await lockAutomationReadProfile(trx, producer, { tenantId: actor.tenantId, targetId })
        const restored = data(restore({ material: profile.material }), ['action', 'packCatalog', 'extFieldMapping'])
        const action = jsonObject(restored.action)
        if (!plain(action.target) || !plain(action.target.fieldIdMap)
          || action.actionId !== profile.actionId || action.target.sheetId !== profile.sheetId
          || action.target.objectId !== profile.objectId) denied()
        const installed = await loadAutomationReadInstalledMaterial(trx, {
          tenantId: profile.tenantId, workspaceId: null, projectId: profile.projectId,
          objectId: profile.objectId, sheetId: profile.sheetId, fieldIdMap: action.target.fieldIdMap as Record<string, string>,
        })
        const derived = data(derive({ action, installedFieldProperties: installed.installedFieldProperties,
          extFieldMapping: restored.extFieldMapping }), ['action', 'projection', 'installedFieldProperties', 'extFieldMapping', 'executionKey'])
        const contractAction = jsonObject(derived.action)
        const projection = data(json(derived.projection), ['logicalFieldIds', 'fieldIds', 'projectFieldId', 'activeFieldId'])
        if (!same(action, contractAction) || !same(json(derived.installedFieldProperties), installed.installedFieldProperties)
          || typeof derived.executionKey !== 'string' || !digest.test(derived.executionKey)) unavailable()
        const logicalFieldIds = ids(projection.logicalFieldIds), fieldIds = ids(projection.fieldIds)
        if (logicalFieldIds.length !== fieldIds.length || !logicalFieldIds.includes('projectNo') || !logicalFieldIds.includes('active')
          || !canonicalReadId(projection.projectFieldId) || !canonicalReadId(projection.activeFieldId)
          || projection.projectFieldId === projection.activeFieldId || !fieldIds.includes(projection.projectFieldId)
          || !fieldIds.includes(projection.activeFieldId)) unavailable()
        // No permission or supplied proof can replace this actual finite-field gate.
        const target = await lockAutomationReadTarget(trx, { actorId: actor.actorId, baseId: installed.baseId,
          sheetId: profile.sheetId, fieldIds: [...fieldIds] })
        // SHARE locks cannot freeze wall-clock lifetime. Recheck producer expiry
        // after every target read and require the same private persisted profile.
        const finalProfile = await lockAutomationReadProfile(trx, producer, { tenantId: actor.tenantId, targetId })
        if (!same(profile, finalProfile)) denied()
        const context = Object.freeze({
          scope: Object.freeze({ ...actor, targetId, actionId: profile.actionId, projectId: profile.projectId,
            objectId: profile.objectId, sheetId: profile.sheetId, baseId: installed.baseId }),
          revisions: Object.freeze({ producer, profileRevision: profile.revision, sheetRevision: installed.revisions.sheet,
            baseRevision: installed.revisions.base, packRevision: installed.revisions.pack }),
          targetContract: Object.freeze({ action: contractAction, executionKey: derived.executionKey,
            projection: Object.freeze({ logicalFieldIds, fieldIds, projectFieldId: projection.projectFieldId, activeFieldId: projection.activeFieldId }) }),
          content: Object.freeze({ installedFingerprint: installed.fingerprint, targetFingerprint: target.fingerprint }),
        })
        materials.set(context, Object.freeze({ installedFieldProperties: installed.installedFieldProperties,
          extFieldMapping: derived.extFieldMapping }))
        return context
      } catch (error) {
        if (error instanceof AutomationReadTargetContextError) throw error
        return unavailable()
      }
    },
  })
}
