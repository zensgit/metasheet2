import { types } from 'node:util'
import { createHash } from 'node:crypto'
import { checkedYidaIntervalOccurrence } from './yida-automation-authoring-policy'
import { lockAutomationReadRule } from './automation-read-rule-authority'
import { scheduleIntervalMs } from '../multitable/automation-triggers'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { assertAutomationIntegrationActor, type AutomationIntegrationActor } from './automation-live-authority'
import { createYidaAutomationLiveAuthority } from './yida-automation-live-authority'
import { createYidaAutomationAuthorizationStore } from './yida-automation-authorization-store'
import { enqueueYidaAutomationRequestInTransaction } from './yida-automation-outbox'
import { checkedYidaAutomationAuthorization, checkedYidaAutomationRequest,
  type YidaAutomationAuthorizationInput } from './yida-automation-authorization-contracts'

type Dependencies = Parameters<typeof createYidaAutomationLiveAuthority>[0] & {
  database: { transaction<T>(work: (trx: Queryable) => Promise<T>): Promise<T> }
  activationId: string
  monotonicNow?: () => number
}
type Code = 'INPUT' | 'CONFLICT' | 'DENIED' | 'CLOSED'
const ownErrors = new WeakMap<object, Code>()
export class YidaAutomationManagementError extends Error {
  constructor(code: Code) {
    super('YIDA_AUTOMATION_MANAGEMENT_' + code)
    this.name = 'YidaAutomationManagementError'
    ownErrors.set(this, code)
  }
}
export function yidaAutomationManagementErrorCode(error: unknown): string | undefined {
  const code = ownErrors.get(error as object)
  return code === undefined ? undefined : 'YIDA_AUTOMATION_MANAGEMENT_' + code
}
function fail(code: Code): never { throw new YidaAutomationManagementError(code) }
function close(error: unknown): never { fail(ownErrors.get(error as object) ?? 'DENIED') }
function actor(input: unknown): Readonly<AutomationIntegrationActor> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input)) fail('INPUT')
  const proto = Object.getPrototypeOf(input), descriptors = Object.getOwnPropertyDescriptors(input)
  if (proto !== Object.prototype && proto !== null || Reflect.ownKeys(descriptors).length !== 3) fail('INPUT')
  const own = (key: string) => {
    const value = descriptors[key]
    if (!value?.enumerable || !Object.hasOwn(value, 'value')) fail('INPUT')
    return value.value
  }
  const actorId = own('actorId'), tenantId = own('tenantId')
  if (own('workspaceId') !== null || [actorId, tenantId].some(value => typeof value !== 'string'
    || !value || value.length > 128 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value))) fail('INPUT')
  return Object.freeze({ actorId, tenantId, workspaceId: null }) as Readonly<AutomationIntegrationActor>
}
function rawConsent(consent: YidaAutomationAuthorizationInput) {
  const { maxTotalRows: _maxTotalRows, ...input } = consent
  return input
}

/** Host-private local management composition, not a route/sender. Authentication
 * must supply the trusted grantor and actual installation binding. No request
 * may supply constructor dependencies or promote a description to authority. */
export function createYidaAutomationAuthorizationService(dependencies: Dependencies) {
  const grantor = actor(dependencies.grantor)
  const transaction = dependencies.database.transaction.bind(dependencies.database)
  const live = createYidaAutomationLiveAuthority({ grantor, binding: dependencies.binding, primitives: dependencies.primitives,
    installationRevisionInTransaction: dependencies.installationRevisionInTransaction })
  const store = createYidaAutomationAuthorizationStore({ scope: { tenantId: grantor.tenantId,
    workspaceId: null, ownerId: grantor.actorId }, activationId: dependencies.activationId,
    monotonicNow: dependencies.monotonicNow })
  let closed = false
  function active() { if (closed) fail('CLOSED') }
  async function authorized<T>(requiresActive: boolean, work: (trx: Queryable) => Promise<T>): Promise<T> {
    try {
      if (requiresActive) active()
      return await transaction(async trx => {
        // The trusted provider has BEGIN; this precedes even xid/ACL probes.
        await trx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
        await assertAutomationIntegrationActor(trx, grantor)
        if (requiresActive) active()
        const result = await work(trx)
        if (requiresActive) active()
        return result
      }) // No permit is ever minted here, including on a lost COMMIT response.
    } catch (error) { return close(error) }
  }
  function consent(input: unknown) {
    try { return checkedYidaAutomationAuthorization(input) } catch { return fail('INPUT') }
  }
  async function create(input: unknown) {
    const captured = consent(input), raw = rawConsent(captured)
    return authorized(true, async trx => {
      const previous = await store.findConfirmationInTransaction(trx, captured.confirmationId)
      if (previous) {
        if (JSON.stringify(previous.consent) !== JSON.stringify(captured)) fail('CONFLICT')
        return Object.freeze({ ...previous.summary, reused: true }) // History, no material revalidation or new eligibility.
      }
      const proof = await live.lockForApprovalInTransaction(trx, raw)
      const material = await live.takeInTransaction(trx, proof)
      const created = await store.createInTransaction(trx, raw, material.materialRevision)
      return Object.freeze({ ...(await store.readInTransaction(trx, created.grantId)).summary, reused: created.reused })
    })
  }
  async function inspect(grantId: string) {
    return authorized(false, trx => store.inspectInTransaction(trx, grantId))
  }
  async function revoke(grantId: string) {
    return authorized(false, async trx => {
      await store.revokeInTransaction(trx, grantId)
      return (await store.readInTransaction(trx, grantId)).summary
    })
  }
  function checkedRequest(input: unknown) {
    let request: Readonly<{ requestKey: string }>
    try { request = checkedYidaAutomationRequest(input) } catch { return fail('INPUT') }
    return request
  }
  async function reserveManualInTransaction(trx: Queryable, grantId: string, request: Readonly<{ requestKey: string }>) {
    const existing = await store.readInTransaction(trx, grantId)
    if (!existing.consent.allowedTriggers.includes('manual')) fail('DENIED')
    const occurrence = Object.freeze({ grantId, activationId: existing.activationId,
      ruleId: existing.consent.ruleId, ruleRevision: existing.consent.expectedRuleRevision,
      actionId: existing.consent.actionId, triggerType: 'manual', requestKey: request.requestKey })
    const history = await store.findReservationInTransaction(trx, grantId, occurrence)
    if (history) return Object.freeze({ ...history, deliveryQueued: false, canSend: false, externalWriteAttempted: false })
    const proof = await live.lockForExecutionInTransaction(trx, rawConsent(existing.consent), existing.materialRevision)
    await live.takeInTransaction(trx, proof)
    const reservation = await store.reserveInTransaction(trx, grantId, occurrence)
    return Object.freeze({ ...reservation, deliveryQueued: false, canSend: false, externalWriteAttempted: false })
  }
  /** Internal reservation only, never an accepted/202 delivery. */
  async function reserveManual(grantId: string, input: unknown) {
    const request = checkedRequest(input)
    return authorized(true, trx => reserveManualInTransaction(trx, grantId, request))
  }
  /** Staged host-private producer; not registered in global routing or HTTP.
   * Return only after the provider reports COMMIT. No execution handle here. */
  async function requestManual(grantId: string, input: unknown) {
    const request = checkedRequest(input)
    return authorized(true, async trx => {
      const reserved = await reserveManualInTransaction(trx, grantId, request)
      const accepted = await enqueueYidaAutomationRequestInTransaction(trx, grantId, reserved)
      // Enqueue/lock waits consume the SAME grant TTL. History is observation,
      // so an already committed replay must not refresh eligibility or expiry.
      if (!reserved.reused) await store.assertCurrentInTransaction(trx, grantId)
      return accepted
    })
  }
  /** Private existing-scheduler producer. The description cannot choose grantor,
   * scope, target or payload. Re-prove DB rule/version/material and actual time. */
  async function requestInterval(grantId: string, input: unknown) {
    let occurrence: ReturnType<typeof checkedYidaIntervalOccurrence>
    try { occurrence = checkedYidaIntervalOccurrence(input) } catch { return fail('INPUT') }
    return authorized(true, async trx => {
      const saved = await store.readInTransaction(trx, grantId), approved = saved.consent
      if (!approved.allowedTriggers.includes('schedule.interval') || occurrence.ruleId !== approved.ruleId) fail('DENIED')
      const proof = await live.lockForExecutionInTransaction(trx, rawConsent(approved), saved.materialRevision)
      await live.takeInTransaction(trx, proof)
      const rule = await lockAutomationReadRule(trx, { actorId: grantor.actorId, ruleId: approved.ruleId,
        baseId: dependencies.binding.baseId, sheetId: dependencies.binding.sheetId })
      if (rule.authorityRevision !== approved.expectedRuleRevision
        || scheduleIntervalMs(rule.triggerConfig, true) !== occurrence.intervalMs) fail('DENIED')
      const result = await trx.query(`SELECT floor(extract(epoch FROM created_at)*1000)::text AS anchor_ms,
        floor(extract(epoch FROM clock_timestamp())*1000)::text AS now_ms
        FROM automation_rules WHERE id=$1 AND created_by=$2 FOR SHARE`, [approved.ruleId, grantor.actorId])
      if (result.rows.length !== 1) fail('DENIED')
      const clock = result.rows[0]
      if (typeof clock.anchor_ms !== 'string' || !/^[0-9]+$/u.test(clock.anchor_ms)
        || typeof clock.now_ms !== 'string' || !/^[0-9]+$/u.test(clock.now_ms)) fail('DENIED')
      const anchor = Number(clock.anchor_ms), now = Number(clock.now_ms)
      if (!Number.isSafeInteger(anchor) || !Number.isSafeInteger(now) || anchor !== occurrence.anchorMs
        || now < occurrence.scheduledAtMs || now - occurrence.scheduledAtMs >= occurrence.intervalMs) fail('DENIED')
      const scheduleDefinitionDigest = createHash('sha256').update(JSON.stringify(['yida-interval-definition/v1',
        approved.ruleId, approved.expectedRuleRevision, approved.actionId, anchor, occurrence.intervalMs])).digest('hex')
      const captured = Object.freeze({ grantId, activationId: saved.activationId,
        ruleRevision: approved.expectedRuleRevision, actionId: approved.actionId, ...occurrence, scheduleDefinitionDigest })
      const previous = await store.findReservationInTransaction(trx, grantId, captured)
      const reservation = previous ?? await store.reserveInTransaction(trx, grantId, captured)
      const accepted = await enqueueYidaAutomationRequestInTransaction(trx, grantId, reservation)
      if (!reservation.reused) await store.assertCurrentInTransaction(trx, grantId)
      return accepted
    })
  }
  return Object.freeze({ create, inspect, revoke, reserveManual, requestManual, requestInterval,
    close() { closed = true; live.close() } })
}
