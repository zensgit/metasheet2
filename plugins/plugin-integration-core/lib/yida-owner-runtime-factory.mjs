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
    // YiDa 发料确认日期回写 (slice Y9): the plugin MAY hand one more frozen capability (index.cjs builds it from its own
    // db, project registry, sheet write lock and multitable records; lib/yida-issue-confirm-writeback-ports.mjs).
    // Absent, the binding keeps its original two members exactly.
    const withWriteback = Boolean(options) && typeof options === 'object' && !types.isProxy(options)
      && Object.hasOwn(options, 'issueConfirmWriteback')
    const parsed = record(options, withWriteback ? ['db', 'security', 'issueConfirmWriteback'] : ['db', 'security'])
    const db = capability(parsed.db, ['transaction', 'selectOne'])
    const security = capability(parsed.security, ['encrypt', 'decrypt'])
    const writeback = withWriteback ? capability(parsed.issueConfirmWriteback, ['enabled', 'create']) : null
    // The host's live re-check (owner live integration admin + role-granted stock-prep code + sheet read), supplied per
    // call by the host runtime and never by a request. The executor calls it under the sheet write lease.
    function boundWriteback(scope, recheck) {
      const check = callable(recheck)
      const created = capability(writeback.create(Object.freeze({
        context: Object.freeze({ tenantId: scope.tenantId, ownerId: scope.ownerId }),
        recheck: (input) => Reflect.apply(check, undefined, [input]),
      })), ['run'])
      return Object.freeze({ run: (input) => created.run(input) })
    }
    function createIssueConfirmWriteback(input) {
      try {
        const config = record(input, ['context', 'recheck'])
        return boundWriteback(context(config.context), config.recheck)
      } catch (error) { closed(error) }
    }
    // Display/shape bit for the host route (generic 404 while OFF): the core's own exact-literal predicate. Never
    // authority: every run reads the same switch again before any dependency is touched.
    function issueConfirmWritebackEnabled() {
      try { return writeback.enabled() === true } catch { return false }
    }
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
        // Y9: the host may add its live re-check, which arms the best-effort post-ACK write-back hook of this port.
        const withRecheck = writeback !== null && Boolean(input) && typeof input === 'object' && !types.isProxy(input)
          && Object.hasOwn(input, 'issueConfirmRecheck')
        const config = record(input, withRecheck ? [...SEND_OPTIONS, 'issueConfirmRecheck'] : SEND_OPTIONS)
        const scope = context(config.context)
        const authority = capability(config.authority, ['admitForExecution', 'takeExecution', 'observe'])
        const fetch = callable(config.fetch)
        const readEnablement = callable(config.readEnablement)
        if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 10 || config.timeoutMs > 60000) fail()
        // Best effort end to end: a write-back that cannot even be bound leaves the send port exactly as before (no
        // hook); the owner recovery entry fills the date later. It never refuses or alters a send.
        let issueConfirmWriteback = null
        if (withRecheck) {
          try { issueConfirmWriteback = boundWriteback(scope, config.issueConfirmRecheck) } catch { issueConfirmWriteback = null }
        }
        return createYidaOwnerSendPort({ db, context: scope, authority, fetch, readEnablement, timeoutMs: config.timeoutMs,
          ...(issueConfirmWriteback ? { issueConfirmWriteback } : {}) })
      } catch (error) { closed(error) }
    }
    if (writeback) return Object.freeze({ createPrimitives, createSendPort, createIssueConfirmWriteback, issueConfirmWritebackEnabled })
    return Object.freeze({ createPrimitives, createSendPort })
  } catch (error) { closed(error) }
}
