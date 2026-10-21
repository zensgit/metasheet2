import { types } from 'node:util'
import { createYidaOwnerRuntimeBinding } from './yida-owner-runtime-factory.mjs'
import { createInternalYidaAutomationAuthorityPrimitives } from './yida-send-authority-primitives.mjs'
import { createInternalYidaAutomationSendAttempt } from './yida-delivery-runner.mjs'

function denied() { throw new Error('YIDA_AUTOMATION_BINDING_UNAVAILABLE') }
function record(value, keys) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) denied()
  const proto = Object.getPrototypeOf(value), properties = Object.getOwnPropertyDescriptors(value)
  if (proto !== Object.prototype && proto !== null || Reflect.ownKeys(properties).length !== keys.length) denied()
  return Object.fromEntries(keys.map(key => {
    const d = properties[key]
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) denied()
    return [key, d.value]
  }))
}
function capability(value, keys) {
  if (!value || typeof value !== 'object' || types.isProxy(value)) denied()
  return Object.freeze(Object.fromEntries(keys.map(key => {
    const d = Object.getOwnPropertyDescriptor(value, key)
    if (!d || !Object.hasOwn(d, 'value') || typeof d.value !== 'function' || types.isProxy(d.value)) denied()
    return [key, d.value.bind(value)]
  })))
}

// Actual reviewed native constructors, captured only by the core host. Neither
// this factory nor its authority/worker/permit enters communication or HTTP.
export function createYidaAutomationRuntimeBinding(options) {
  try {
    const parsed = record(options, ['db', 'security'])
    const db = capability(parsed.db, ['transaction', 'selectOne'])
    const security = capability(parsed.security, ['encrypt', 'decrypt'])
    const owner = createYidaOwnerRuntimeBinding({ db, security })
    return Object.freeze({ createPrimitives: owner.createPrimitives,
      createExecutionPrimitives(input) {
        const { grantor, workerId } = record(input, ['grantor', 'workerId'])
        const actor = record(grantor, ['actorId', 'tenantId', 'workspaceId'])
        return createInternalYidaAutomationAuthorityPrimitives({ security,
          context: { tenantId: actor.tenantId, workspaceId: actor.workspaceId, ownerId: actor.actorId }, workerId })
      },
      createAttempt(input) {
        const config = record(input, ['context', 'authority', 'permit', 'fetch', 'readEnablement', 'timeoutMs'])
        return createInternalYidaAutomationSendAttempt({ ...config, db })
      },
    })
  } catch { return denied() }
}
