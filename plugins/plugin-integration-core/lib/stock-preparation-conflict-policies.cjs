'use strict'

// #2343 D2/D3: duplicate-expanded-key policy review/persistence.
// This module records operator/admin policy intent only. The D3 planner decides
// whether a reviewed policy can resolve rows; this module never writes.

const crypto = require('node:crypto')

const {
  DUPLICATE_EXPANDED_KEY_POLICIES,
} = require('./stock-preparation-conflict-planner.cjs')

const CONFLICT_TYPE_DUPLICATE_EXPANDED_KEY = 'duplicate_expanded_key'
const POLICY_SCOPE_RUN_ONLY = 'run_only'
const POLICY_SCOPE_TABLE = 'table_scope'
const DEFAULT_DUPLICATE_POLICY = 'hold'
const MAX_CONFLICT_POLICIES = 200
const FINGERPRINT_RE = /^sha16:[0-9a-f]{16}$/
const STORAGE_PREFIX = 'integration:table-action:conflict-policies:'

class StockPreparationConflictPolicyError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationConflictPolicyError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function hashJson(value) {
  return sha256(stableStringify(value))
}

function publicFingerprint(value) {
  return `sha16:${sha256(value).slice(0, 16)}`
}

function conflictPolicyStoreKey(action) {
  const scope = {
    actionId: action && action.actionId,
    target: {
      sheetId: action && action.target && action.target.sheetId,
      objectId: action && action.target && action.target.objectId,
      keyField: action && action.target && action.target.keyField,
    },
  }
  return `${STORAGE_PREFIX}${hashJson(scope)}`
}

function targetScopeFingerprint(action) {
  const scope = {
    actionId: action && action.actionId,
    target: {
      sheetId: action && action.target && action.target.sheetId,
      objectId: action && action.target && action.target.objectId,
      keyField: action && action.target && action.target.keyField,
    },
  }
  return publicFingerprint(stableStringify(scope))
}

function requirePolicyStore(store) {
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
    throw new StockPreparationConflictPolicyError(501, 'CONFLICT_POLICY_STORE_UNAVAILABLE', 'conflict policy review requires plugin storage')
  }
  return store
}

function normalizeConflictType(value, field = 'conflictType') {
  const conflictType = optionalString(value) || CONFLICT_TYPE_DUPLICATE_EXPANDED_KEY
  if (conflictType !== CONFLICT_TYPE_DUPLICATE_EXPANDED_KEY) {
    throw new StockPreparationConflictPolicyError(422, 'CONFLICT_POLICY_INVALID', `${field} must be duplicate_expanded_key`, { field })
  }
  return conflictType
}

function normalizeFingerprint(value, field) {
  const fingerprint = optionalString(value)
  if (!fingerprint || !FINGERPRINT_RE.test(fingerprint)) {
    throw new StockPreparationConflictPolicyError(422, 'CONFLICT_POLICY_INVALID', `${field} must be a sha16 fingerprint`, { field })
  }
  return fingerprint
}

function normalizePolicy(value, field) {
  const policy = optionalString(value)
  if (!policy || !DUPLICATE_EXPANDED_KEY_POLICIES.includes(policy)) {
    throw new StockPreparationConflictPolicyError(422, 'CONFLICT_POLICY_INVALID', `${field} must be one of the duplicate-expanded-key policies`, {
      field,
      allowedPolicies: DUPLICATE_EXPANDED_KEY_POLICIES.slice(),
    })
  }
  return policy
}

function normalizePolicyRows(value, field = 'policies') {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new StockPreparationConflictPolicyError(422, 'CONFLICT_POLICY_INVALID', `${field} must be an array`, { field })
  }
  if (value.length > MAX_CONFLICT_POLICIES) {
    throw new StockPreparationConflictPolicyError(422, 'CONFLICT_POLICY_TOO_LARGE', `${field} exceeds the maximum policy count`, {
      field,
      maxPolicies: MAX_CONFLICT_POLICIES,
    })
  }
  const out = []
  const seen = new Set()
  for (const [index, row] of value.entries()) {
    if (!isPlainObject(row)) {
      throw new StockPreparationConflictPolicyError(422, 'CONFLICT_POLICY_INVALID', `${field}[${index}] must be an object`, { field: `${field}[${index}]` })
    }
    const fingerprint = normalizeFingerprint(row.fingerprint, `${field}[${index}].fingerprint`)
    const policy = normalizePolicy(row.policy, `${field}[${index}].policy`)
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    out.push({ fingerprint, policy })
  }
  return out
}

function normalizeRunOnlyConflictPolicyReview(input) {
  if (input === undefined || input === null || input === '') return null
  if (!isPlainObject(input)) {
    throw new StockPreparationConflictPolicyError(422, 'CONFLICT_POLICY_INVALID', 'conflictPolicyReview must be an object', {
      field: 'conflictPolicyReview',
    })
  }
  normalizeConflictType(input.conflictType, 'conflictPolicyReview.conflictType')
  const scope = optionalString(input.scope) || POLICY_SCOPE_RUN_ONLY
  if (scope !== POLICY_SCOPE_RUN_ONLY) {
    throw new StockPreparationConflictPolicyError(422, 'CONFLICT_POLICY_INVALID', 'conflictPolicyReview.scope must be run_only', {
      field: 'conflictPolicyReview.scope',
    })
  }
  return {
    conflictType: CONFLICT_TYPE_DUPLICATE_EXPANDED_KEY,
    scope: POLICY_SCOPE_RUN_ONLY,
    policies: normalizePolicyRows(input.policies, 'conflictPolicyReview.policies'),
  }
}

function normalizeTableScopePolicyRequest(input = {}) {
  if (!isPlainObject(input)) {
    throw new StockPreparationConflictPolicyError(400, 'CONFLICT_POLICY_REQUEST_INVALID', 'request body must be an object')
  }
  for (const key of Object.keys(input)) {
    if (!['conflictType', 'policies'].includes(key)) {
      throw new StockPreparationConflictPolicyError(400, 'CONFLICT_POLICY_REQUEST_INVALID', `unsupported request field: ${key}`, { field: key })
    }
  }
  normalizeConflictType(input.conflictType)
  return {
    conflictType: CONFLICT_TYPE_DUPLICATE_EXPANDED_KEY,
    scope: POLICY_SCOPE_TABLE,
    policies: normalizePolicyRows(input.policies, 'policies'),
  }
}

function normalizeDeletePolicyRequest(input = {}) {
  if (!isPlainObject(input)) {
    throw new StockPreparationConflictPolicyError(400, 'CONFLICT_POLICY_REQUEST_INVALID', 'request body must be an object')
  }
  for (const key of Object.keys(input)) {
    if (!['conflictType', 'fingerprints'].includes(key)) {
      throw new StockPreparationConflictPolicyError(400, 'CONFLICT_POLICY_REQUEST_INVALID', `unsupported request field: ${key}`, { field: key })
    }
  }
  normalizeConflictType(input.conflictType)
  const fingerprints = input.fingerprints === undefined || input.fingerprints === null
    ? []
    : input.fingerprints
  if (!Array.isArray(fingerprints)) {
    throw new StockPreparationConflictPolicyError(422, 'CONFLICT_POLICY_INVALID', 'fingerprints must be an array', { field: 'fingerprints' })
  }
  if (fingerprints.length > MAX_CONFLICT_POLICIES) {
    throw new StockPreparationConflictPolicyError(422, 'CONFLICT_POLICY_TOO_LARGE', 'fingerprints exceeds the maximum policy count', {
      field: 'fingerprints',
      maxPolicies: MAX_CONFLICT_POLICIES,
    })
  }
  return {
    conflictType: CONFLICT_TYPE_DUPLICATE_EXPANDED_KEY,
    fingerprints: Array.from(new Set(fingerprints.map((fingerprint, index) => normalizeFingerprint(fingerprint, `fingerprints[${index}]`)))),
  }
}

function emptyStoredPolicies(action) {
  return {
    version: 1,
    conflictType: CONFLICT_TYPE_DUPLICATE_EXPANDED_KEY,
    actionId: action.actionId,
    targetScopeFingerprint: targetScopeFingerprint(action),
    policies: [],
  }
}

function publicStoredPolicy(row) {
  return {
    fingerprint: row.fingerprint,
    policy: row.policy,
    scope: POLICY_SCOPE_TABLE,
    approvedAtPresent: Boolean(row.approvedAt),
    approvedByPresent: Boolean(row.approvedBy),
  }
}

function publicTableScopePolicies(record) {
  const policies = Array.isArray(record && record.policies) ? record.policies.map(publicStoredPolicy) : []
  return {
    conflictType: CONFLICT_TYPE_DUPLICATE_EXPANDED_KEY,
    scope: POLICY_SCOPE_TABLE,
    targetScopeFingerprint: record && record.targetScopeFingerprint,
    policyCount: policies.length,
    policies,
  }
}

function normalizeStoredPolicies(rows) {
  const policies = []
  for (const row of Array.isArray(rows) ? rows : []) {
    try {
      const fingerprint = normalizeFingerprint(row.fingerprint, 'stored.policies[].fingerprint')
      const policy = normalizePolicy(row.policy, 'stored.policies[].policy')
      policies.push({
        fingerprint,
        policy,
        approvedAt: row.approvedAt,
        approvedBy: row.approvedBy,
      })
    } catch {
      // Corrupt stored rows are ignored rather than crashing dry-run/list.
    }
  }
  return policies
}

async function loadTableScopeConflictPolicies({ action, policyStore }) {
  const store = requirePolicyStore(policyStore)
  const stored = await store.get(conflictPolicyStoreKey(action))
  if (!isPlainObject(stored)) return publicTableScopePolicies(emptyStoredPolicies(action))
  return publicTableScopePolicies({
    ...emptyStoredPolicies(action),
    policies: normalizeStoredPolicies(stored.policies),
  })
}

async function saveTableScopeConflictPolicies({ action, policyStore, request, approver }) {
  const store = requirePolicyStore(policyStore)
  const normalized = normalizeTableScopePolicyRequest(request)
  const key = conflictPolicyStoreKey(action)
  const now = new Date().toISOString()
  const storedValue = await store.get(key)
  const stored = isPlainObject(storedValue) ? storedValue : emptyStoredPolicies(action)
  const byFingerprint = new Map()
  for (const row of normalizeStoredPolicies(stored.policies)) {
    byFingerprint.set(row.fingerprint, row)
  }
  for (const row of normalized.policies) {
    byFingerprint.set(row.fingerprint, {
      ...row,
      approvedAt: now,
      approvedBy: optionalString(approver) || null,
    })
  }
  const next = {
    ...emptyStoredPolicies(action),
    policies: Array.from(byFingerprint.values()).sort((left, right) => left.fingerprint.localeCompare(right.fingerprint)),
  }
  await store.set(key, next)
  return publicTableScopePolicies(next)
}

async function deleteTableScopeConflictPolicies({ action, policyStore, request }) {
  const store = requirePolicyStore(policyStore)
  const normalized = normalizeDeletePolicyRequest(request)
  const key = conflictPolicyStoreKey(action)
  const storedValue = await store.get(key)
  const stored = isPlainObject(storedValue) ? storedValue : emptyStoredPolicies(action)
  if (normalized.fingerprints.length === 0) {
    throw new StockPreparationConflictPolicyError(400, 'CONFLICT_POLICY_DELETE_EMPTY', 'fingerprints array must not be empty', {
      field: 'fingerprints',
    })
  }
  const remove = new Set(normalized.fingerprints)
  const next = {
    ...emptyStoredPolicies(action),
    policies: normalizeStoredPolicies(stored.policies)
      .filter((row) => row && !remove.has(row.fingerprint))
  }
  await store.set(key, next)
  return publicTableScopePolicies(next)
}

function policyMapFromReview(review) {
  const map = new Map()
  if (!review || !Array.isArray(review.policies)) return map
  for (const row of review.policies) {
    if (!row || typeof row.fingerprint !== 'string' || typeof row.policy !== 'string') continue
    map.set(row.fingerprint, row)
  }
  return map
}

function increment(map, key) {
  map[key] = (map[key] || 0) + 1
}

function buildConflictPolicyReview({ diagnostics, runOnlyReview, tableScopeReview }) {
  if (!isPlainObject(diagnostics) || diagnostics.conflictType !== CONFLICT_TYPE_DUPLICATE_EXPANDED_KEY) return undefined
  const groups = Array.isArray(diagnostics.groups) ? diagnostics.groups.filter(isPlainObject) : []
  const runOnly = policyMapFromReview(runOnlyReview)
  const tableScope = policyMapFromReview(tableScopeReview)
  const seen = new Set(groups.map((group) => group.fingerprint).filter((value) => typeof value === 'string'))
  const ignoredFingerprints = new Set()
  for (const fingerprint of runOnly.keys()) if (!seen.has(fingerprint)) ignoredFingerprints.add(fingerprint)
  for (const fingerprint of tableScope.keys()) if (!seen.has(fingerprint)) ignoredFingerprints.add(fingerprint)
  const ignoredPolicyCount = ignoredFingerprints.size

  const policyCounts = {}
  const scopeCounts = {}
  const selectedPolicies = groups.map((group) => {
    const fingerprint = group.fingerprint
    const runRow = runOnly.get(fingerprint)
    const tableRow = tableScope.get(fingerprint)
    const selected = runRow || tableRow || { policy: DEFAULT_DUPLICATE_POLICY }
    const scope = runRow ? POLICY_SCOPE_RUN_ONLY : tableRow ? POLICY_SCOPE_TABLE : 'default'
    increment(policyCounts, selected.policy)
    increment(scopeCounts, scope)
    return {
      fingerprint,
      policy: selected.policy,
      scope,
      writeEffect: 'manual_confirm_held',
      approvedAtPresent: scope === POLICY_SCOPE_TABLE ? Boolean(tableRow && tableRow.approvedAtPresent) : undefined,
      approvedByPresent: scope === POLICY_SCOPE_TABLE ? Boolean(tableRow && tableRow.approvedByPresent) : undefined,
    }
  })

  return {
    conflictType: CONFLICT_TYPE_DUPLICATE_EXPANDED_KEY,
    defaultPolicy: DEFAULT_DUPLICATE_POLICY,
    writeEffect: 'manual_confirm_held',
    groupCount: selectedPolicies.length,
    configuredPolicyCount: selectedPolicies.filter((row) => row.scope !== 'default').length,
    runOnlyPolicyCount: runOnly.size,
    tableScopePolicyCount: tableScope.size,
    ignoredPolicyCount,
    policyCounts,
    scopeCounts,
    selectedPolicies,
  }
}

module.exports = {
  CONFLICT_TYPE_DUPLICATE_EXPANDED_KEY,
  DEFAULT_DUPLICATE_POLICY,
  POLICY_SCOPE_RUN_ONLY,
  POLICY_SCOPE_TABLE,
  StockPreparationConflictPolicyError,
  buildConflictPolicyReview,
  deleteTableScopeConflictPolicies,
  loadTableScopeConflictPolicies,
  normalizeRunOnlyConflictPolicyReview,
  saveTableScopeConflictPolicies,
  __internals: {
    conflictPolicyStoreKey,
    normalizePolicyRows,
    normalizeTableScopePolicyRequest,
    publicTableScopePolicies,
    targetScopeFingerprint,
  },
}
