import { createHash } from 'node:crypto'
import { types } from 'node:util'
import { assertAutomationIntegrationActor, type AutomationIntegrationActor } from './automation-live-authority'
import { lockAutomationReadRule } from './automation-read-rule-authority'
import { scheduleIntervalMs } from '../multitable/automation-triggers'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import type { YidaSendAuthorityPrimitives, YidaSendAuthoritySelection } from './yida-send-approval-service'
import { checkedYidaAutomationAuthorization, type YidaAutomationAuthorizationInput } from './yida-automation-authorization-contracts'

// HOST PRIVATE. This is a same-transaction material prerequisite, NOT a bearer
// permit or sender. No dependency/context/binding comes from an HTTP body or a
// communication API. A later admission must commit before execution is possible.
type Row = Record<string, unknown>
type Binding = Readonly<{ baseId: string; sheetId: string; projectField: string }>
type Dependencies = {
  grantor: AutomationIntegrationActor
  // Actual host-installed sheet/project role binding; never infer tenant from base.
  binding: Binding
  primitives: Pick<YidaSendAuthorityPrimitives, 'resolveSelectionInTransaction'>
  // Only the installed host supplies this private callback. Bare synthetic
  // component composition remains explicitly uninstalled, never a host proof.
  installationRevisionInTransaction?: (trx: Queryable) => Promise<string>
}
type Locked = Readonly<{
  grantor: Readonly<AutomationIntegrationActor>; binding: Binding
  consent: YidaAutomationAuthorizationInput; materialRevision: string; ruleFingerprint: string
  selections: readonly YidaSendAuthoritySelection[]
}>
type Proof = Readonly<Record<string, never>>
const DIGEST = /^[0-9a-f]{64}$/u
const selectionKeys = ['tenantId', 'workspaceId', 'ownerId', 'operationId', 'rowKey', 'targetRef',
  'targetRevision', 'planRevision', 'credentialRef', 'credentialGeneration', 'businessKeyDigest',
  'rowPayloadDigest', 'planDigest', 'config', 'selectedRow', 'source', 'plan']
export class YidaAutomationAuthorityError extends Error {
  constructor() {
    super('YIDA_AUTOMATION_AUTHORITY_DENIED')
    this.name = 'YidaAutomationAuthorityError'
  }
}
function denied(): never { throw new YidaAutomationAuthorityError() }
function data(input: unknown, keys: readonly string[]): Row {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input)) denied()
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) denied()
  const descriptors = Object.getOwnPropertyDescriptors(input)
  if (Reflect.ownKeys(descriptors).length !== keys.length) denied()
  return Object.fromEntries(keys.map(key => {
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) denied()
    return [key, descriptor.value]
  }))
}
function id(input: unknown): string {
  if (typeof input !== 'string' || !input || input.length > 128 || input.trim() !== input
    || /[\u0000-\u001f\u007f]/u.test(input)) denied()
  return input
}
function field(input: unknown, name: string): unknown {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input)) denied()
  const descriptor = Object.getOwnPropertyDescriptor(input, name)
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) denied()
  return descriptor.value
}
function empty(input: unknown): boolean {
  return input === null || (Array.isArray(input) && !types.isProxy(input)
    && Object.getPrototypeOf(input) === Array.prototype && input.length === 0 && Reflect.ownKeys(input).length === 1)
}
function singleAction(input: unknown, slot: string): boolean {
  if (empty(input)) return true
  if (!Array.isArray(input) || types.isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype
    || input.length !== 1 || Reflect.ownKeys(input).length !== 2) return false
  const entry = Object.getOwnPropertyDescriptor(input, '0')
  if (!entry?.enumerable || !Object.hasOwn(entry, 'value')) return false
  const action = data(entry.value, ['type', 'config'])
  return action.type === 'integration_yida_send_authorized'
    && data(action.config, ['authorizationSlot']).authorizationSlot === slot
}
async function xid(trx: Queryable): Promise<string> {
  const result = await trx.query('SELECT pg_current_xact_id()::text AS xid')
  if (result.rows.length !== 1 || typeof result.rows[0].xid !== 'string' || !/^[1-9][0-9]*$/u.test(result.rows[0].xid)) denied()
  return result.rows[0].xid
}

export function createYidaAutomationLiveAuthority(dependencies: Dependencies) {
  const rawGrantor = data(dependencies.grantor, ['actorId', 'tenantId', 'workspaceId'])
  if (rawGrantor.workspaceId !== null) denied()
  const grantor = Object.freeze({ actorId: id(rawGrantor.actorId), tenantId: id(rawGrantor.tenantId), workspaceId: null })
  const rawBinding = data(dependencies.binding, ['baseId', 'sheetId', 'projectField'])
  const binding = Object.freeze({ baseId: id(rawBinding.baseId), sheetId: id(rawBinding.sheetId), projectField: id(rawBinding.projectField) })
  const resolveSelection = dependencies.primitives.resolveSelectionInTransaction.bind(dependencies.primitives)
  let closed = false
  const installation = dependencies.installationRevisionInTransaction
  if (installation !== undefined && (typeof installation !== 'function' || types.isProxy(installation))) denied()
  let proofs = new WeakMap<object, { trx: Queryable; xid: string; locked: Locked; installationRevision: string | null }>()
  function active() { if (closed) denied() }

  async function lock(trx: Queryable, input: unknown, expected?: string): Promise<Proof> {
    try {
      active()
      const consent = checkedYidaAutomationAuthorization(input)
      await assertAutomationIntegrationActor(trx, grantor)
      active()
      const rule = await lockAutomationReadRule(trx, { actorId: grantor.actorId,
        ruleId: consent.ruleId, sheetId: binding.sheetId, baseId: binding.baseId })
      // A stable slot avoids changing the rule nonce when a grant is attached.
      // Grant references belong to private activation state, not rule-save data.
      const config = data(rule.actionConfig, ['authorizationSlot'])
      if (rule.actionType !== 'integration_yida_send_authorized' || config.authorizationSlot !== consent.actionId
        || rule.authorityRevision !== consent.expectedRuleRevision || rule.triggerType !== 'schedule.interval'
        || scheduleIntervalMs(rule.triggerConfig, true) === null || !singleAction(rule.actions, consent.actionId) || !empty(rule.conditions)
        || (rule.executionMode !== null && rule.executionMode !== 'legacy')) denied()
      const selections: YidaSendAuthoritySelection[] = []
      const tuples: unknown[][] = []
      for (const rowKey of consent.rowKeys) {
        active()
        const selection = await resolveSelection(trx, { operationId: consent.operationId, rowKey })
        active()
        const row = data(selection, selectionKeys)
        if (!Object.isFrozen(selection) || row.tenantId !== grantor.tenantId || row.workspaceId !== null
          || row.ownerId !== grantor.actorId || row.operationId !== consent.operationId || row.rowKey !== rowKey
          || row.targetRevision !== 'evidence-1' || row.planRevision !== row.planDigest
          || !Number.isInteger(row.credentialGeneration) || Number(row.credentialGeneration) < 1
          || Number(row.credentialGeneration) > 2147483647) denied()
        for (const name of ['targetRef', 'credentialRef']) id(row[name])
        for (const name of ['planRevision', 'planDigest', 'businessKeyDigest', 'rowPayloadDigest']) {
          if (typeof row[name] !== 'string' || !DIGEST.test(row[name] as string)) denied()
        }
        if (field(row.config, 'intent') !== 'create' || field(row.selectedRow, binding.projectField) !== consent.projectNo) denied()
        const key = field(row.config, 'businessKey')
        if (!Array.isArray(key) || types.isProxy(key)
          || !Array.prototype.includes.call(key, binding.projectField)) denied()
        if (selections.length) {
          const first = selections[0]
          if (row.targetRef !== first.targetRef || row.planDigest !== first.planDigest
            || row.credentialRef !== first.credentialRef || row.credentialGeneration !== first.credentialGeneration) denied()
        }
        tuples.push([row.operationId, row.rowKey, row.targetRef, row.targetRevision, row.planRevision,
          row.credentialRef, row.credentialGeneration, row.businessKeyDigest, row.rowPayloadDigest])
        selections.push(selection)
      }
      const installationRevision = installation === undefined ? null : await installation(trx)
      active()
      if (installation !== undefined && (typeof installationRevision !== 'string' || !DIGEST.test(installationRevision))) denied()
      const materialV1 = ['yida-automation-material/v1',
        grantor.tenantId, null, grantor.actorId, binding.baseId, binding.sheetId, binding.projectField,
        consent.projectNo, consent.actionId, rule.fingerprint,
        [consent.confirmationId, consent.expectedRuleRevision, consent.operationId, consent.allowedTriggers,
          consent.maxExecutions, consent.maxTotalRows, consent.ttlMs], tuples]
      const materialRoot = installationRevision === null ? materialV1 : ['yida-automation-material/v2', installationRevision, materialV1]
      const materialRevision = createHash('sha256').update(JSON.stringify(materialRoot)).digest('hex')
      if (expected !== undefined && expected !== materialRevision) denied()
      const proof: Proof = Object.freeze({})
      const transactionId = await xid(trx)
      active()
      proofs.set(proof, { trx, xid: transactionId, installationRevision, locked: Object.freeze({ grantor, binding, consent,
        materialRevision, ruleFingerprint: rule.fingerprint, selections: Object.freeze(selections) }) })
      return proof
    } catch { return denied() }
  }
  async function takeInTransaction(trx: Queryable, proof: unknown): Promise<Locked> {
    const found = proofs.get(proof as object)
    if (!found || found.trx !== trx || closed) denied()
    proofs.delete(proof as object) // Consumption precedes await; no concurrent reuse.
    try {
      if (await xid(trx) !== found.xid) denied()
      if (installation !== undefined && await installation(trx) !== found.installationRevision) denied()
      active()
      return found.locked
    } catch { return denied() }
  }
  return Object.freeze({
    lockForApprovalInTransaction: (trx: Queryable, input: unknown) => lock(trx, input),
    lockForExecutionInTransaction(trx: Queryable, input: unknown, expectedMaterialRevision: string) {
      if (typeof expectedMaterialRevision !== 'string' || !DIGEST.test(expectedMaterialRevision)) return Promise.reject(new YidaAutomationAuthorityError())
      return lock(trx, input, expectedMaterialRevision)
    },
    takeInTransaction,
    close() { closed = true; proofs = new WeakMap() },
  })
}
