import { createHash } from 'node:crypto'
import { types } from 'node:util'
import { assertAutomationIntegrationActor, type AutomationIntegrationActor } from './automation-live-authority'
import { createAutomationReadTargetContext, type AutomationReadTargetMaterialCodec } from './automation-read-target-context'
import type { AutomationReadProducerIdentity } from './automation-read-profiles'
import { canonicalizeConfig } from '../multitable/automation-action-idempotency'
import type { Queryable } from '../multitable/automation-durable-dispatcher'

type Row = Record<string, unknown>
type Dependencies = Readonly<{ producer: AutomationReadProducerIdentity; codec: AutomationReadTargetMaterialCodec;
  signal: AbortSignal; isCurrent(): boolean; track<T>(work: () => Promise<T>): Promise<T> }>
export type InstalledYidaAutomationBinding = Readonly<{
  binding: Readonly<{ baseId: string; sheetId: string; projectField: string }>
  installationRevisionInTransaction(trx: Queryable): Promise<string>
}>
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!
function denied(): never { throw new Error('YIDA_AUTOMATION_INSTALLATION_DENIED') }
function data(value: unknown, keys: readonly string[]): Row {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) denied()
  const prototype = Object.getPrototypeOf(value), descriptors = Object.getOwnPropertyDescriptors(value)
  if (prototype !== Object.prototype && prototype !== null || Reflect.ownKeys(descriptors).length !== keys.length) denied()
  return Object.fromEntries(keys.map(key => {
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) denied()
    return [key, descriptor.value]
  }))
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 128 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) denied()
  return value
}

/** Core-host only, constructed from the actual READ runtime's live producer and
 * reviewed codec, not a request, JSON proof or plugin communication envelope.
 * All rule/profile/epoch/field/ACL facts are reloaded from the caller's real RC
 * transaction. No source records, Connection, token or form IO occurs here. */
export function createYidaAutomationInstalledBindingSource(dependencies: Dependencies) {
  const p = data(dependencies.producer, ['generation', 'nonce'])
  if (typeof p.generation !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(p.generation)
    || BigInt(p.generation) > 9223372036854775807n || typeof p.nonce !== 'string' || !UUID.test(p.nonce)) denied()
  const producer = Object.freeze({ generation: p.generation, nonce: p.nonce })
  const signal = dependencies.signal, isCurrent = dependencies.isCurrent, track = dependencies.track
  if (!signal || types.isProxy(signal) || Object.getPrototypeOf(signal) !== AbortSignal.prototype
    || typeof isCurrent !== 'function' || types.isProxy(isCurrent) || typeof track !== 'function' || types.isProxy(track)) denied()
  try { aborted.call(signal) } catch { return denied() }
  const target = createAutomationReadTargetContext({ codec: dependencies.codec })
  function check() {
    if (aborted.call(signal)) denied()
    const value: unknown = isCurrent()
    if (value !== true) {
      // Malformed trusted callback is OFF, never a truthy Promise permission.
      try {
        if (types.isPromise(value) && !types.isProxy(value) && Object.getPrototypeOf(value) === Promise.prototype
          && !Object.hasOwn(value, 'constructor')) Promise.prototype.then.call(value, undefined, () => {})
      } catch { /* No coercion of a foreign value. */ }
      denied()
    }
  }
  async function capture(raw: Queryable, actor: Readonly<AutomationIntegrationActor>, ruleId: string, targetId?: string) {
    check()
    // Await the original SQL response even after stop. The outer transaction
    // can actually roll back; no Promise.race abandons an in-flight query.
    const trx: Queryable = Object.freeze({ async query(sql: string, params?: unknown[]) {
      check(); const result = await raw.query(sql, params); check(); return result
    } })
    await assertAutomationIntegrationActor(trx, actor)
    const rule = await trx.query(`SELECT sheet_id FROM automation_rules
      WHERE id=$1 AND created_by=$2 AND enabled IS TRUE AND action_type='integration_yida_send_authorized' FOR SHARE`,
    [ruleId, actor.actorId])
    if (rule.rows.length !== 1) denied()
    const sheetId = id(rule.rows[0].sheet_id)
    // Only this real producer's installation is eligible; do not select latest,
    // infer tenant from a sheet/base, or fall back to another generation. A
    // disabled row in the current generation is still checked, never hidden.
    const profiles = await trx.query(`SELECT target_id::text FROM automation_read_target_profiles
      WHERE tenant_id=$1 AND sheet_id=$2 AND producer_generation=$3::bigint AND producer_nonce=$4::uuid
      ORDER BY target_id LIMIT 2`, [actor.tenantId, sheetId, producer.generation, producer.nonce])
    if (profiles.rows.length !== 1) denied()
    const selected = id(profiles.rows[0].target_id)
    if (!UUID.test(selected) || targetId !== undefined && selected !== targetId) denied()
    const context = await target.lock(trx, { actor, producer, targetId: selected })
    target.materialFor(context) // Instance-owned context, not a serialized proof.
    check()
    const projection = context.targetContract.projection
    if (context.scope.sheetId !== sheetId || context.scope.tenantId !== actor.tenantId
      || context.scope.actorId !== actor.actorId || !projection.logicalFieldIds.includes('projectNo')
      || !projection.fieldIds.includes(projection.projectFieldId)) denied()
    // projectNo is the verified LOGICAL stock-preparation role. The actual
    // physical mapping/epochs are hashed below; no physical ID is fabricated.
    const binding = Object.freeze({ baseId: context.scope.baseId, sheetId, projectField: 'projectNo' })
    const revision = createHash('sha256').update(canonicalizeConfig({ kind: 'yida-installed-binding/v1',
      actor, ruleId, binding, scope: context.scope, revisions: context.revisions,
      executionKey: context.targetContract.executionKey, projection, content: context.content })).digest('hex')
    return Object.freeze({ binding, revision, targetId: selected })
  }
  async function resolveInTransaction(trx: Queryable, supplied: unknown, reference: unknown): Promise<InstalledYidaAutomationBinding> {
    try {
      const raw = data(supplied, ['actorId', 'tenantId', 'workspaceId'])
      if (raw.workspaceId !== null) denied()
      const actor = Object.freeze({ actorId: id(raw.actorId), tenantId: id(raw.tenantId), workspaceId: null })
      const ruleId = id(reference), initial = await track(() => capture(trx, actor, ruleId))
      return Object.freeze({ binding: initial.binding,
        async installationRevisionInTransaction(current: Queryable) {
          try {
            const fresh = await track(() => capture(current, actor, ruleId, initial.targetId))
            if (fresh.revision !== initial.revision) denied()
            return fresh.revision
          } catch { return denied() }
        } })
    } catch { return denied() }
  }
  // Private host lifetime check, not a serialized approval or permission.
  return Object.freeze({ resolveInTransaction, assertCurrent: check })
}
