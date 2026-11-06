'use strict'

// Gate 4 (R-71 ⑦.2): the ONE definition of the YiDa owner send budgets.
//
// The runner bounds the execution snapshot with boundYidaExecutionSnapshot and the form transport
// encodes and bounds the request body with encodeYidaFormRequestBody; both take their limits from
// here. assessYidaSendBudget runs those same two checks BEFORE a grant is written and BEFORE an
// admission prepares the ledger, so a row that the runner or the transport would refuse after the
// permit is never approved or admitted. The runner and transport checks stay as defence in depth.
//
// Credentials are never read here. The assessment substitutes the worst encoding the credential
// store allows (yida-credential-material-store.cjs limits the length only, not control characters):
// every UTF-16 unit costs at most 6 bytes under JSON.stringify ('\u0001' -> "\\u0001"), so a token
// of control characters at the maximum length is a strict upper bound for every real token, both
// for the serialized snapshot / request body and for the snapshot's raw string byte count (raw
// bytes never exceed serialized bytes).
const { types: { isProxy } } = require('node:util')
const { deepCloneFrozenCanonical, stableCanonicalStringify } = require('./gip-canonical-json.cjs')

const YIDA_SEND_SNAPSHOT_MAX_BYTES = 262144
const YIDA_SEND_REQUEST_MAX_BYTES = 262144
const YIDA_SEND_SNAPSHOT_MAX_NODES = 4096
const YIDA_SEND_SNAPSHOT_MAX_DEPTH = 12
const YIDA_SEND_SYSTEM_TOKEN_MAX_LENGTH = 4096
const YIDA_SEND_USER_ID_MAX_LENGTH = 128
const WORST_SYSTEM_TOKEN = '\u0001'.repeat(YIDA_SEND_SYSTEM_TOKEN_MAX_LENGTH)
const WORST_USER_ID = '\u0001'.repeat(YIDA_SEND_USER_ID_MAX_LENGTH)
const CREATE_DATA_KEYS = ['appType', 'formUuid', 'formDataJson']

class YidaSendBudgetError extends Error {
  constructor() {
    super('YIDA_SEND_BUDGET_INVALID')
    this.name = 'YidaSendBudgetError'
    this.code = this.message
  }
}

function fail() { throw new YidaSendBudgetError() }

// The serialized form request body: the form transport sends exactly this text.
function encodeYidaFormRequestBody(data, systemToken, userId) {
  return JSON.stringify({ ...data, systemToken, userId })
}

// Bound the raw strict domain BEFORE canonical cloning (which normalizes -0). Moved here unchanged
// from the delivery runner; the runner maps every failure to YIDA_RUN_SNAPSHOT_INVALID.
function boundYidaExecutionSnapshot(value) {
  let nodes = 0
  let bytes = 0
  const ancestors = new Set()
  function visit(entry, depth) {
    if (++nodes > YIDA_SEND_SNAPSHOT_MAX_NODES || depth > YIDA_SEND_SNAPSHOT_MAX_DEPTH) fail()
    if (entry === null || typeof entry === 'boolean') return
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry) || Object.is(entry, -0)) fail()
      return
    }
    if (typeof entry === 'string') {
      bytes += Buffer.byteLength(entry, 'utf8')
      if (bytes > YIDA_SEND_SNAPSHOT_MAX_BYTES) fail()
      return
    }
    if (!entry || typeof entry !== 'object' || isProxy(entry) || ancestors.has(entry)) fail()
    const array = Array.isArray(entry)
    const proto = Object.getPrototypeOf(entry)
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) fail()
    const descriptors = Object.getOwnPropertyDescriptors(entry)
    const keys = Reflect.ownKeys(descriptors)
    if (keys.length > YIDA_SEND_SNAPSHOT_MAX_NODES + 1) fail()
    if (array && (keys.length !== entry.length + 1 || entry.length > YIDA_SEND_SNAPSHOT_MAX_NODES)) fail()
    ancestors.add(entry)
    for (const key of keys) {
      if (array && key === 'length') continue
      const property = descriptors[key]
      if (typeof key !== 'string' || !property.enumerable || !('value' in property)
        || (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= entry.length))) fail()
      bytes += Buffer.byteLength(key, 'utf8')
      if (bytes > YIDA_SEND_SNAPSHOT_MAX_BYTES) fail()
      visit(property.value, depth + 1)
    }
    ancestors.delete(entry)
  }
  visit(value, 0)
  try {
    const serialized = stableCanonicalStringify(value)
    if (Buffer.byteLength(serialized, 'utf8') > YIDA_SEND_SNAPSHOT_MAX_BYTES) fail()
    return { snapshot: deepCloneFrozenCanonical(value), serialized }
  } catch { fail() }
}

function plainRecord(value) {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) fail()
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) fail()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const result = {}
  for (const key of Reflect.ownKeys(descriptors)) {
    const property = descriptors[key]
    if (typeof key !== 'string' || !property.enumerable || !Object.hasOwn(property, 'value')) fail()
    Object.defineProperty(result, key, { value: property.value, enumerable: true })
  }
  return result
}

// Pure and values-free: the answer is one boolean. `snapshot` is the execution snapshot without its
// two credential fields (they are substituted with the worst-case placeholders); `data` is the create
// request data the runner compiles from that snapshot. Malformed input throws a fixed error.
function assessYidaSendBudget(input) {
  const parsed = plainRecord(input)
  if (Reflect.ownKeys(parsed).length !== 2 || !Object.hasOwn(parsed, 'snapshot') || !Object.hasOwn(parsed, 'data')) fail()
  const snapshot = plainRecord(parsed.snapshot)
  if (Object.hasOwn(snapshot, 'systemToken') || Object.hasOwn(snapshot, 'userId')) fail()
  const data = plainRecord(parsed.data)
  if (Reflect.ownKeys(data).length !== CREATE_DATA_KEYS.length
    || CREATE_DATA_KEYS.some((key) => typeof data[key] !== 'string')) fail()
  let snapshotWithin = true
  try {
    boundYidaExecutionSnapshot({ ...snapshot, systemToken: WORST_SYSTEM_TOKEN, userId: WORST_USER_ID })
  } catch { snapshotWithin = false }
  const body = encodeYidaFormRequestBody(data, WORST_SYSTEM_TOKEN, WORST_USER_ID)
  const bodyWithin = Buffer.byteLength(body, 'utf8') <= YIDA_SEND_REQUEST_MAX_BYTES
  return Object.freeze({ withinBudget: snapshotWithin && bodyWithin })
}

module.exports = {
  YIDA_SEND_SNAPSHOT_MAX_BYTES,
  YIDA_SEND_REQUEST_MAX_BYTES,
  YIDA_SEND_SNAPSHOT_MAX_NODES,
  YIDA_SEND_SNAPSHOT_MAX_DEPTH,
  YIDA_SEND_SYSTEM_TOKEN_MAX_LENGTH,
  YIDA_SEND_USER_ID_MAX_LENGTH,
  encodeYidaFormRequestBody,
  boundYidaExecutionSnapshot,
  assessYidaSendBudget,
}
