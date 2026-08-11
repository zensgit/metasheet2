'use strict'

// Process-local, values-free K3 wire-attempt counters. The adapter records only a
// closed operation name and an integer. Raw paths, URLs, query parameters,
// credentials, request bodies, responses, tenant ids, and business values never
// enter this state. A process restart intentionally resets the counters.

const K3_WISE_CALL_AUDIT_VERSION = '2026.08.v1'
const K3_WISE_CALL_AUDIT_OPERATIONS = Object.freeze([
  'materialGetDetail',
  'materialGetList',
  'materialSave',
  'materialSubmit',
  'materialAudit',
  'otherRead',
  'otherLifecycleWrite',
])
const OPERATION_SET = new Set(K3_WISE_CALL_AUDIT_OPERATIONS)
const counts = Object.fromEntries(K3_WISE_CALL_AUDIT_OPERATIONS.map((operation) => [operation, 0]))

function endpointStem(segment) {
  return String(segment || '').split('.')[0].toLowerCase()
}

function classifyK3WiseCall(wirePathname, intent) {
  const segments = String(wirePathname || '')
    .split('/')
    .filter(Boolean)
    .map(endpointStem)
  const materialIndex = segments.lastIndexOf('material')
  const materialOperation = materialIndex >= 0 ? segments.slice(materialIndex + 1) : []

  if (materialOperation.includes('getdetail')) return 'materialGetDetail'
  if (materialOperation.includes('getlist')) return 'materialGetList'
  if (materialOperation.includes('save')) return 'materialSave'
  if (materialOperation.includes('submit')) return 'materialSubmit'
  if (materialOperation.includes('audit')) return 'materialAudit'
  return intent === 'lifecycle-write' ? 'otherLifecycleWrite' : 'otherRead'
}

function recordK3WiseCall(wirePathname, intent) {
  const operation = classifyK3WiseCall(wirePathname, intent)
  if (!OPERATION_SET.has(operation)) return
  counts[operation] = Math.min(Number.MAX_SAFE_INTEGER, counts[operation] + 1)
}

function getK3WiseCallAuditSnapshot() {
  return Object.freeze({
    version: K3_WISE_CALL_AUDIT_VERSION,
    scope: 'process',
    counts: Object.freeze(Object.fromEntries(
      K3_WISE_CALL_AUDIT_OPERATIONS.map((operation) => [operation, counts[operation]]),
    )),
  })
}

module.exports = {
  K3_WISE_CALL_AUDIT_OPERATIONS,
  K3_WISE_CALL_AUDIT_VERSION,
  getK3WiseCallAuditSnapshot,
  recordK3WiseCall,
  __internals: {
    classifyK3WiseCall,
  },
}
