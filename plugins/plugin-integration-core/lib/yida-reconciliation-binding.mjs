import { types } from 'node:util'
import { createYidaReconciliationPort } from './yida-reconciliation-port.mjs'

// Host-private composition for the ⑦.5 cut-over reconciliation (the fourth private YiDa runtime). The core
// owns permission checks (live integration admin + anchor owner) and the switch; neither request bodies nor
// plugin APIs can inject these dependencies or choose an owner independently of the authorized actor.
const CONTEXT = ['actorId', 'tenantId', 'workspaceId']
const PORT_OPTIONS = ['context', 'fetch', 'readEnablement', 'timeoutMs']
const ownErrors = new WeakSet()

class YidaReconciliationBindingError extends Error {
  constructor(code) {
    super(`YIDA_RECONCILE_BINDING_${code}`)
    this.name = 'YidaReconciliationBindingError'
    this.code = this.message
    ownErrors.add(this)
  }
}
function fail() { throw new YidaReconciliationBindingError('INPUT') }
function closed(error) {
  if (ownErrors.has(error)) throw error
  throw new YidaReconciliationBindingError('UNAVAILABLE')
}
function record(value, keys) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) fail()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail()
  const properties = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(properties).some(key => typeof key !== 'string' || !keys.includes(key))
    || keys.some(key => !Object.hasOwn(properties, key))) fail()
  const result = Object.create(null)
  for (const key of Object.keys(properties)) {
    const property = properties[key]
    if (!property.enumerable || !Object.hasOwn(property, 'value')) fail()
    result[key] = property.value
  }
  return result
}
function callable(value) {
  if (typeof value !== 'function' || types.isProxy(value)) fail()
  return value
}
function capability(value, keys) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) fail()
  const result = Object.create(null)
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key)
    if (!property || !Object.hasOwn(property, 'value')) fail()
    const method = callable(property.value)
    result[key] = (...args) => Reflect.apply(method, value, args)
  }
  return Object.freeze(result)
}
function id(value) {
  if (typeof value !== 'string' || !value || value.length > 128 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) fail()
  return value
}

export function createYidaReconciliationBinding(options) {
  try {
    const parsed = record(options, ['db', 'security'])
    const db = capability(parsed.db, ['transaction', 'selectOne'])
    const security = capability(parsed.security, ['encrypt', 'decrypt'])
    function createReconciliationPort(input) {
      try {
        const config = record(input, PORT_OPTIONS)
        const scope = record(config.context, CONTEXT)
        const actorId = id(scope.actorId), tenantId = id(scope.tenantId)
        if (scope.workspaceId !== null) fail()
        if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 10 || config.timeoutMs > 60000) fail()
        return createYidaReconciliationPort({ db, security, context: Object.freeze({ tenantId, workspaceId: null, ownerId: actorId, actorId }),
          fetch: callable(config.fetch), readEnablement: callable(config.readEnablement), timeoutMs: config.timeoutMs })
      } catch (error) { closed(error) }
    }
    return Object.freeze({ createReconciliationPort })
  } catch (error) { closed(error) }
}
