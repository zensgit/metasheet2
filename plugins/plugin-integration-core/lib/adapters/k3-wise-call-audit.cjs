'use strict'

const crypto = require('node:crypto')

// Process-local, values-free K3 wire-attempt counters. The adapter records only a
// closed operation name and an integer. Raw paths, URLs, query parameters,
// credentials, request bodies, responses, and business values never enter this
// state. Counts are partitioned by the adapter's existing tenant scope; tenant ids
// are never returned by the snapshot. A process restart intentionally resets both
// the counters and epoch so consumers can reject cross-restart comparisons.

const K3_WISE_CALL_AUDIT_VERSION = '2026.08.v2'
const PROCESS_EPOCH = crypto.randomBytes(16).toString('hex')
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
const countsByTenant = new Map()

function createCounts() {
  return Object.fromEntries(K3_WISE_CALL_AUDIT_OPERATIONS.map((operation) => [operation, 0]))
}

function tenantKey(tenantId) {
  return typeof tenantId === 'string' && tenantId.trim() ? tenantId.trim() : null
}

function countsForTenant(tenantId, { create = false } = {}) {
  const key = tenantKey(tenantId)
  if (!key) return null
  if (!countsByTenant.has(key) && create) countsByTenant.set(key, createCounts())
  return countsByTenant.get(key) || null
}

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

function recordK3WiseCall(wirePathname, intent, tenantId) {
  const operation = classifyK3WiseCall(wirePathname, intent)
  if (!OPERATION_SET.has(operation)) return
  const counts = countsForTenant(tenantId, { create: true })
  if (!counts) return
  counts[operation] = Math.min(Number.MAX_SAFE_INTEGER, counts[operation] + 1)
}

function getK3WiseCallAuditSnapshot({ tenantId } = {}) {
  const counts = countsForTenant(tenantId) || createCounts()
  return Object.freeze({
    version: K3_WISE_CALL_AUDIT_VERSION,
    scope: 'process',
    processEpoch: PROCESS_EPOCH,
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
    tenantKey,
  },
}
