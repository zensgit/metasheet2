import { createHash } from 'node:crypto'
import { types } from 'node:util'
import { yidaProtocolBusinessKey } from './yida-static-plan.mjs'

// R-71 ⑦.5 cut-over reconciliation: PURE functions only (no IO, no clock, no network).
// A legacy YiDa record that is already in the customer's form is registered in the delivery ledger
// as `reconciled_existing` under the SAME seven-key digest the send path computes, so the 091 create
// fence keeps the send path from creating it again. Nothing here can write to YiDa.
//
// The business key of a remote record is derived from the SEALED key definition of the approved target
// (`{ algorithm: 'yida-protocol-v2', fields: [{ target, type, empty }] }`, yida-draft-compiler.mjs), never
// from a request-supplied config, through the one shared key algorithm of the planner
// (`yidaProtocolBusinessKey`, yida-static-plan.mjs). The empty-key rule mirrors the planner exactly:
// an empty-allowed key whose value is undefined / null / '' becomes ''; a whitespace-only value of an
// empty-allowed key, or any missing value of a required key, can never have been planned and is
// `key_unmatchable`; a value whose typeof differs from the declared type is `key_unmatchable` too.

export const YIDA_RECONCILE_SEARCH_ENDPOINT = 'https://api.dingtalk.com/v1.0/yida/forms/instances/advances/query'
export const YIDA_RECONCILE_LIMITS = Object.freeze({
  defaultPageSize: 50,
  maxPageSize: 100,
  defaultPagesPerStep: 3,
  maxPagesPerStep: 10,
  minPageIntervalMs: 1000,
  throttleRetries: 2,
  throttleSleepMs: 1000,
  maxRunPages: 600,
  maxResponseBytes: 1024 * 1024,
  // 30000 is the documented search ceiling; twice that is refused as an implausible count.
  maxTotalCount: 60000,
})
// Every outcome a remote record can get (closed vocabulary; stored as count columns).
export const YIDA_RECONCILE_OUTCOMES = Object.freeze([
  'registered', 'would_register', 'already_reconciled', 'duplicate_remote', 'own_acknowledged',
  'duplicate_with_own', 'own_in_flight', 'observed_for_unknown', 'own_not_sent', 'project_mismatch',
  'key_unmatchable',
])
// Outcomes that leave an observation row (a person must look at them in YiDa).
export const YIDA_RECONCILE_OBSERVED_OUTCOMES = Object.freeze([
  'duplicate_remote', 'duplicate_with_own', 'own_in_flight', 'observed_for_unknown', 'own_not_sent', 'key_unmatchable',
])
export const YIDA_RECONCILE_ERROR_CODES = Object.freeze([
  'RETRY', 'THROTTLED', 'RESPONSE', 'TOO_LARGE', 'UNAVAILABLE', 'ABORTED', 'BUDGET', 'TOTAL_CHANGED',
])
export const YIDA_RECONCILE_MODES = Object.freeze(['count', 'register'])
export const YIDA_RECONCILE_TARGET_REVISION = 'evidence-1'
const OUTCOMES = new Set(YIDA_RECONCILE_OUTCOMES)
const INSTANCE_ID = /^[A-Za-z0-9_-]{1,128}$/
const KEY_TYPES = new Set(['string', 'number', 'boolean'])
const MAX_KEY_FIELDS = 32

export class YidaReconciliationPlanError extends Error {
  constructor(code) {
    const fixed = ['INPUT', 'CONFLICT', 'UNAVAILABLE'].includes(code) ? code : 'INPUT'
    super(`YIDA_RECONCILE_PLAN_${fixed}`)
    this.name = 'YidaReconciliationPlanError'
    this.code = this.message
  }
}
function fail(code) { throw new YidaReconciliationPlanError(code) }

function plainObject(value) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
function ownValue(object, key) {
  const property = Object.getOwnPropertyDescriptor(object, key)
  if (!property) return undefined
  if (!Object.hasOwn(property, 'value')) fail('INPUT')
  return property.value
}
function sha256(text) { return createHash('sha256').update(text, 'utf8').digest('hex') }

/** The sealed key layout, validated: sorted unique targets, closed types, boolean empty flags. */
export function yidaReconcileKeyFields(keyDefinition) {
  if (!plainObject(keyDefinition) || ownValue(keyDefinition, 'algorithm') !== 'yida-protocol-v2') fail('INPUT')
  const fields = ownValue(keyDefinition, 'fields')
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > MAX_KEY_FIELDS) fail('INPUT')
  const seen = new Set()
  return Object.freeze(fields.map((field) => {
    if (!plainObject(field)) fail('INPUT')
    const target = ownValue(field, 'target'), type = ownValue(field, 'type'), empty = ownValue(field, 'empty')
    if (typeof target !== 'string' || !target || target.length > 128 || seen.has(target)
      || !KEY_TYPES.has(type) || typeof empty !== 'boolean') fail('INPUT')
    seen.add(target)
    return Object.freeze({ target, type, empty })
  }))
}

/**
 * The run's key layout check (before any network): the sealed key targets must be exactly the expected
 * template targets (the seven material keys), and the project key target must be one of them and not
 * empty-allowed. A different layout would compute digests that are not the send path's digests.
 */
export function assertYidaReconcileLayout({ keyDefinition, expectedKeyTargets, projectKeyTarget }) {
  const fields = yidaReconcileKeyFields(keyDefinition)
  if (!Array.isArray(expectedKeyTargets) || expectedKeyTargets.length !== fields.length
    || expectedKeyTargets.some(target => typeof target !== 'string')) fail('CONFLICT')
  const expected = new Set(expectedKeyTargets)
  if (expected.size !== fields.length || fields.some(field => !expected.has(field.target))) fail('CONFLICT')
  const project = fields.find(field => field.target === projectKeyTarget)
  if (!project || project.empty || project.type !== 'string') fail('CONFLICT')
  return fields
}

/**
 * The business key of one remote record. Returns `{ comparable: false }` for a record that no local row
 * could ever have planned (the reconciliation then records `key_unmatchable` and never registers it).
 */
export function yidaObservedBusinessKey({ locator, keyDefinition, formData }) {
  if (!plainObject(locator) || typeof locator.appType !== 'string' || typeof locator.formUuid !== 'string') fail('INPUT')
  if (!plainObject(formData)) fail('INPUT')
  const fields = yidaReconcileKeyFields(keyDefinition)
  const pairs = []
  for (const field of fields) {
    const raw = ownValue(formData, field.target)
    if (field.empty) {
      if (raw === undefined || raw === null || raw === '') { pairs.push([field.target, 'string', '']); continue }
      // The planner refuses a whitespace-only value of an empty-allowed key (keyMissing): never planned.
      if (typeof raw === 'string' && raw.trim() === '') return Object.freeze({ comparable: false })
    } else if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      // A required key part that is missing is KEY_MISSING locally: no local identity exists.
      return Object.freeze({ comparable: false })
    }
    // No conversion is guessed: typeof is part of the pair, so another type is another digest.
    if (typeof raw !== field.type) return Object.freeze({ comparable: false })
    if (typeof raw === 'number' && (!Number.isFinite(raw) || Object.is(raw, -0))) return Object.freeze({ comparable: false })
    pairs.push([field.target, typeof raw, raw])
  }
  const businessKey = yidaProtocolBusinessKey(locator, pairs)
  return Object.freeze({ comparable: true, businessKeyDigest: sha256(businessKey) })
}

/** The local exact-equality project filter: the remote filter is only a pre-filter. */
export function yidaReconcileProjectMatches({ formData, projectKeyTarget, projectNo }) {
  if (!plainObject(formData)) return false
  const property = Object.getOwnPropertyDescriptor(formData, projectKeyTarget)
  return Boolean(property) && Object.hasOwn(property, 'value') && property.value === projectNo
}

/** The remote pre-filter, a fixed JSON string (the operator table is unverified; see §2.4 of the plan). */
export function buildYidaReconcileSearchCondition({ projectKeyTarget, projectNo }) {
  if (typeof projectKeyTarget !== 'string' || !projectKeyTarget || typeof projectNo !== 'string' || !projectNo) fail('INPUT')
  return JSON.stringify([{ key: projectKeyTarget, value: projectNo, type: 'TEXT', operator: 'eq', componentName: 'TextField' }])
}

/**
 * Who holds the fence tuple decides the outcome. `holder` is the ledger row that holds
 * (tenant, workspace, target_ref, business_key_digest, intent='create'), or null. The reconciliation
 * never UPDATEs a ledger row: every non-null holder only produces an outcome code.
 */
export function classifyYidaReconcileRecord({ mode, holder, observedInstanceId }) {
  if (!YIDA_RECONCILE_MODES.includes(mode) || typeof observedInstanceId !== 'string' || !INSTANCE_ID.test(observedInstanceId)) fail('INPUT')
  if (holder === null) return mode === 'register' ? 'registered' : 'would_register'
  if (!holder || typeof holder !== 'object') fail('INPUT')
  switch (holder.status) {
    case 'reconciled_existing':
      return holder.observed_instance_id === observedInstanceId ? 'already_reconciled' : 'duplicate_remote'
    case 'acknowledged':
      return holder.ack_instance_id === observedInstanceId ? 'own_acknowledged' : 'duplicate_with_own'
    case 'prepared':
    case 'dispatching':
      return 'own_in_flight'
    case 'outcome_unknown':
      return 'observed_for_unknown'
    case 'not_sent':
      return 'own_not_sent'
    default:
      fail('UNAVAILABLE')
  }
}

/**
 * Completion of one page: a short page, or the last page by count, ends the run. A changed totalCount
 * at completion fails it (the remote changed while it was read); the page budget stops it.
 */
export function yidaReconcileCompletion({ pageNumber, pageSize, recordCount, totalCount, totalCountFirst }) {
  for (const value of [pageNumber, pageSize, recordCount, totalCount, totalCountFirst]) {
    if (!Number.isSafeInteger(value) || value < 0) fail('INPUT')
  }
  const last = recordCount < pageSize || pageNumber * pageSize >= totalCount
  if (last) return Object.freeze(totalCount === totalCountFirst ? { done: true, errorCode: null } : { done: true, errorCode: 'TOTAL_CHANGED' })
  if (pageNumber >= YIDA_RECONCILE_LIMITS.maxRunPages) return Object.freeze({ done: true, errorCode: 'BUDGET' })
  return Object.freeze({ done: false, errorCode: null })
}

/** Values-free evidence digest of one registered record: keys only by digest, no field value. */
export function yidaReconcilePayloadDigest({ formUuid, observedInstanceId, businessKeyDigest }) {
  return sha256(JSON.stringify(['yida-legacy-readback-observation', 1, formUuid, observedInstanceId, businessKeyDigest]))
}

export function emptyYidaReconcileCounts() {
  const counts = { scanned: 0 }
  for (const outcome of YIDA_RECONCILE_OUTCOMES) counts[outcome] = 0
  return counts
}
export function isYidaReconcileOutcome(value) { return OUTCOMES.has(value) }
