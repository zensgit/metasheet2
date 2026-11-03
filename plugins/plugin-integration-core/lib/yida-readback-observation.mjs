import { types } from 'node:util'
import canonical from './gip-canonical-json.cjs'
import { buildYidaStaticPlan } from './yida-static-plan.mjs'

// Pure observation of a supplied known instance. Neither the current plan nor
// this comparison establishes historical delivery, form ownership or authority.
const { deepCloneFrozenCanonical, stableCanonicalStringify } = canonical
const INPUT_KEYS = ['config', 'row', 'expectedInstanceId', 'observation']
const OBSERVATION_KEYS = ['statusCode', 'instanceId', 'formData']
const INSTANCE_ID = /^[A-Za-z0-9_-]{1,128}$/
const MAX_BYTES = 256 * 1024
const CODES = new Set(['YIDA_OBSERVATION_INPUT', 'YIDA_OBSERVATION_PLAN'])

export class YidaReadbackObservationError extends Error {
  constructor(code) {
    const safeCode = CODES.has(code) ? code : 'YIDA_OBSERVATION_INPUT'
    super(safeCode)
    this.name = 'YidaReadbackObservationError'
    this.code = safeCode
  }
}

function fail(kind) { throw new YidaReadbackObservationError(`YIDA_OBSERVATION_${kind}`) }

// Validate bounds and -0 on the ORIGINAL domain: canonical cloning intentionally
// normalizes -0. Descriptor reads never execute a supplied getter or Proxy trap.
function boundedClone(input) {
  let nodes = 0
  let stringBytes = 0
  const ancestors = new Set()
  function visit(value, depth) {
    if (++nodes > 4096 || depth > 12) fail('INPUT')
    if (value === null || typeof value === 'boolean') return
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Object.is(value, -0)) fail('INPUT')
      return
    }
    if (typeof value === 'string') {
      stringBytes += Buffer.byteLength(value, 'utf8')
      if (stringBytes > MAX_BYTES) fail('INPUT')
      return
    }
    if (!value || typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) fail('INPUT')
    const array = Array.isArray(value)
    const proto = Object.getPrototypeOf(value)
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) fail('INPUT')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    if (keys.length > 4097) fail('INPUT')
    if (array && (value.length > 4096 || keys.length !== value.length + 1)) fail('INPUT')
    ancestors.add(value)
    for (const key of keys) {
      if (array && key === 'length') continue
      const property = descriptors[key]
      if (typeof key !== 'string' || !property.enumerable || !Object.hasOwn(property, 'value')
        || (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) fail('INPUT')
      stringBytes += Buffer.byteLength(key, 'utf8')
      if (stringBytes > MAX_BYTES) fail('INPUT')
      visit(property.value, depth + 1)
    }
    ancestors.delete(value)
  }
  visit(input, 0)
  try {
    if (Buffer.byteLength(stableCanonicalStringify(input), 'utf8') > MAX_BYTES) fail('INPUT')
    return deepCloneFrozenCanonical(input)
  } catch { fail('INPUT') }
}

// Only owned canonical objects reach schema checks and field comparison.
function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INPUT')
  if (keys && (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))) fail('INPUT')
  return value
}

function instanceId(value) {
  if (typeof value !== 'string' || !INSTANCE_ID.test(value)) fail('INPUT')
}

function planRow(config, row, expectedInstanceId) {
  if (!config || config.version !== 2) fail('PLAN')
  let plan
  try { plan = buildYidaStaticPlan({ config, rows: [row] }) } catch { fail('PLAN') }
  const planned = plan.rows[0]
  if (plan.rows.length !== 1 || planned.status !== `planned_${config.intent}`
    || planned.issues.length !== 0 || !planned.protocolPreview
    || typeof planned.localBusinessKey !== 'string' || planned.localBusinessKey.length === 0
    || !planned.payload || Object.keys(planned.payload).length < 1
    || Object.keys(planned.payload).length > 32) fail('PLAN')
  if (config.intent === 'update' && expectedInstanceId !== null && expectedInstanceId !== planned.instanceId) fail('PLAN')
  return planned
}

function emptyKey(value) { return value === undefined || value === null || value === '' }

function result(status, counts, reasonCodes) {
  return Object.freeze({
    kind: 'yida_known_instance_observation', status,
    businessVerified: false, historyVerified: false, formOwnershipVerified: false,
    canRetry: false, ...counts, reasonCodes: Object.freeze(reasonCodes),
  })
}

export function compareYidaReadback(input) {
  const { config, row, expectedInstanceId, observation } = record(boundedClone(input), INPUT_KEYS)
  if (expectedInstanceId !== null) instanceId(expectedInstanceId)
  const planned = planRow(config, row, expectedInstanceId)
  if (observation !== null) {
    record(observation, OBSERVATION_KEYS)
    if (!Number.isInteger(observation.statusCode) || observation.statusCode < 200 || observation.statusCode > 299) fail('INPUT')
    instanceId(observation.instanceId)
    record(observation.formData)
  }
  const counts = {
    comparedFieldCount: 0, matchedFieldCount: 0, mismatchedFieldCount: 0,
    missingFieldCount: 0, businessKeyMismatchCount: 0,
  }
  if (expectedInstanceId === null) return result('inconclusive', counts, ['INSTANCE_UNRESOLVED'])
  if (observation === null) return result('inconclusive', counts, ['NO_OBSERVATION'])
  if (observation.instanceId !== expectedInstanceId) return result('inconclusive', counts, ['INSTANCE_MISMATCH'])

  const emptySources = new Set(config.emptyKeyFields)
  const keyTargets = new Map(config.businessKey.map((source) => {
    const target = config.fieldMap.find((entry) => entry.source === source).target
    return [target, { source, allowsEmpty: emptySources.has(source) }]
  }))
  const fields = new Set([...Object.keys(planned.payload), ...keyTargets.keys()])
  for (const target of fields) {
    counts.comparedFieldCount += 1
    const key = keyTargets.get(target)
    const hasActual = Object.hasOwn(observation.formData, target)
    const actual = hasActual ? observation.formData[target] : undefined
    // Empty identity fields omitted from the actual sent payload still belong
    // to the comparison. Only the explicit emptyKeyFields rule equates them.
    const localEmpty = key?.allowsEmpty
      && emptyKey(Object.hasOwn(row, key.source) ? row[key.source] : undefined)
    if (localEmpty && emptyKey(actual)) {
      counts.matchedFieldCount += 1
    } else if (!hasActual) {
      counts.missingFieldCount += 1
      if (key) counts.businessKeyMismatchCount += 1
    } else {
      const expected = localEmpty ? '' : planned.payload[target]
      if (typeof actual === typeof expected && actual === expected) {
        counts.matchedFieldCount += 1
      } else {
        counts.mismatchedFieldCount += 1
        if (key) counts.businessKeyMismatchCount += 1
      }
    }
  }
  const reasons = []
  if (counts.mismatchedFieldCount > 0) reasons.push('FIELD_MISMATCH')
  if (counts.missingFieldCount > 0) reasons.push('FIELD_MISSING')
  return result(reasons.length ? 'observed_mismatch' : 'observed_match', counts, reasons)
}
