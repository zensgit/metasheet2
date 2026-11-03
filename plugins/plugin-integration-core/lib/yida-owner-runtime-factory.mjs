import { types } from 'node:util'
import { createYidaSendAuthorityPrimitives } from './yida-send-authority-primitives.mjs'
import { createYidaOwnerSendPort } from './yida-owner-send-port.mjs'

// Host-private composition only. The core owns permission checks, authority
// construction and transactions. Neither request bodies nor plugin APIs may
// inject these dependencies or choose an owner independently of the actor.
const CONTEXT = ['actorId', 'tenantId', 'workspaceId']
const SEND_OPTIONS = ['context', 'authority', 'fetch', 'readEnablement', 'timeoutMs']
const ownErrors = new WeakSet()

class YidaOwnerRuntimeError extends Error {
  constructor(code) {
    super(`YIDA_OWNER_RUNTIME_${code}`)
    this.name = 'YidaOwnerRuntimeError'
    this.code = this.message
    ownErrors.add(this)
  }
}
function fail() { throw new YidaOwnerRuntimeError('INPUT') }
function closed(error) {
  if (ownErrors.has(error)) throw error
  throw new YidaOwnerRuntimeError('UNAVAILABLE')
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
  // Extra host service members remain private and cannot widen this binding.
  return Object.freeze(result)
}
function id(value) {
  if (typeof value !== 'string' || !value || value.length > 128 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) fail()
  return value
}
function context(value) {
  const parsed = record(value, CONTEXT)
  const actorId = id(parsed.actorId), tenantId = id(parsed.tenantId)
  if (parsed.workspaceId !== null) fail()
  return Object.freeze({ tenantId, workspaceId: null, ownerId: actorId, actorId })
}

export function createYidaOwnerRuntimeBinding(options) {
  try {
    const parsed = record(options, ['db', 'security'])
    const db = capability(parsed.db, ['transaction', 'selectOne'])
    const security = capability(parsed.security, ['encrypt', 'decrypt'])
    function createPrimitives(input) {
      try {
        const scope = context(input)
        return createYidaSendAuthorityPrimitives({ security, context: Object.freeze({
          tenantId: scope.tenantId, workspaceId: scope.workspaceId, ownerId: scope.ownerId,
        }) })
      } catch (error) { closed(error) }
    }
    function createSendPort(input) {
      try {
        const config = record(input, SEND_OPTIONS)
        const scope = context(config.context)
        const authority = capability(config.authority, ['admitForExecution', 'takeExecution', 'observe'])
        const fetch = callable(config.fetch)
        const readEnablement = callable(config.readEnablement)
        if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 10 || config.timeoutMs > 60000) fail()
        return createYidaOwnerSendPort({ db, context: scope, authority, fetch, readEnablement, timeoutMs: config.timeoutMs })
      } catch (error) { closed(error) }
    }
    return Object.freeze({ createPrimitives, createSendPort })
  } catch (error) { closed(error) }
}
