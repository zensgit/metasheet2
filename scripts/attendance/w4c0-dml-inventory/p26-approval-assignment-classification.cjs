'use strict'

const P26_GENERIC_ACTIONS = Object.freeze([
  'approve',
  'reject',
  'transfer',
  'revoke',
  'comment',
  'return',
  'add_sign',
  'reduce_sign',
])

const P26_ATTENDANCE_FIXTURE_KINDS = Object.freeze(['normal', 'adversary'])
const P26_TIMEOUT_EFFECTS = Object.freeze(['transfer', 'jump'])

function entry(relPath, enclosingSymbol, verb, count, owner) {
  return Object.freeze({ relPath, enclosingSymbol, verb, count, owner })
}

// Generated census keys come from collector.cjs. This table assigns an explicit owner to every
// current approval_assignments writer; count drift or a new key is a mandatory review event.
const P26_APPROVAL_ASSIGNMENT_CLASSIFICATIONS = Object.freeze([
  entry('packages/core-backend/src/services/AfterSalesApprovalBridgeService.ts', 'normalizeCommand', 'update', 1, 'after_sales_non_attendance'),
  entry('packages/core-backend/src/services/AfterSalesApprovalBridgeService.ts', 'normalizeCommand', 'insert', 1, 'after_sales_non_attendance'),
  entry('packages/core-backend/src/services/ApprovalBridgeService.ts', 'queryFn', 'update', 2, 'central_bridge_fail_closed'),
  entry('packages/core-backend/src/services/ApprovalBridgeService.ts', 'queryFn', 'insert', 1, 'central_bridge_fail_closed'),
  entry('packages/core-backend/src/services/ApprovalProductService.ts', 'skip', 'update', 1, 'bulk_reassign_contract'),
  entry('packages/core-backend/src/services/ApprovalProductService.ts', 'consumeAndSkip', 'update', 1, 'timeout_transfer_jump_fail_closed'),
  entry('packages/core-backend/src/services/ApprovalProductService.ts', 'targetUserIds', 'update', 5, 'generic_action_fail_closed'),
  entry('packages/core-backend/src/services/ApprovalProductService.ts', 'queryFn', 'update', 2, 'generic_action_helpers'),
  entry('packages/core-backend/src/services/ApprovalProductService.ts', 'queryFn', 'insert', 1, 'generic_action_helpers'),
  entry('plugins/plugin-attendance/index.cjs', 'replaceAttendanceApprovalAssignments', 'update', 1, 'attendance_request_boundary'),
  entry('plugins/plugin-attendance/index.cjs', 'replaceAttendanceApprovalAssignments', 'insert', 1, 'attendance_request_boundary'),
  entry('plugins/plugin-attendance/index.cjs', 'deactivateAttendanceApprovalAssignments', 'update', 1, 'attendance_request_boundary'),
  entry('scripts/ops/staging-attendance-dispatch-d5-smoke.mjs', 'cleanupStep', 'delete', 1, 'synthetic_cleanup'),
  entry('scripts/ops/staging-attendance-makeup-punch-mp6-smoke.mjs', 'cleanup', 'delete', 1, 'synthetic_cleanup'),
  entry('scripts/ops/staging-attendance-overtime-bank-v18-smoke.mjs', 'cleanup', 'delete', 1, 'synthetic_cleanup'),
  entry('scripts/ops/staging-attendance-shift-swap-sw5-smoke.mjs', 'cleanupStep', 'delete', 1, 'synthetic_cleanup'),
])

function keyOf(site) {
  return [site.relPath, site.enclosingSymbol, site.verb].join(' :: ')
}

function classifyP26ApprovalAssignmentSites(sites, classifications = P26_APPROVAL_ASSIGNMENT_CLASSIFICATIONS) {
  const expected = new Map()
  for (const classification of classifications) {
    const key = keyOf(classification)
    if (expected.has(key)) throw new Error(`ATTENDANCE_P26_DUPLICATE_CLASSIFICATION: ${key}`)
    expected.set(key, classification)
  }

  const actual = new Map()
  for (const site of sites.filter((candidate) => candidate.table === 'approval_assignments')) {
    const key = keyOf(site)
    const values = actual.get(key) || []
    values.push(site)
    actual.set(key, values)
  }

  const unclassified = []
  const countDrift = []
  const classifiedSites = []
  for (const [key, values] of actual) {
    const classification = expected.get(key)
    if (!classification) {
      unclassified.push(...values)
      continue
    }
    if (classification.count !== values.length) {
      countDrift.push({ key, expected: classification.count, actual: values.length })
      if (values.length > classification.count) unclassified.push(...values.slice(classification.count))
    }
    classifiedSites.push(...values.slice(0, classification.count).map((site) => ({
      ...site,
      owner: classification.owner,
    })))
  }
  const stale = [...expected.values()].filter((classification) => !actual.has(keyOf(classification)))
  return { unclassified, countDrift, stale, classifiedSites }
}

function parseConstStringArray(content, constName) {
  const match = content.match(new RegExp(`(?:export\\s+)?const\\s+${constName}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as\\s+const`))
  if (!match) throw new Error(`ATTENDANCE_P26_CONST_ARRAY_MISSING: ${constName}`)
  const values = [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((item) => item[1])
  if (new Set(values).size !== values.length) throw new Error(`ATTENDANCE_P26_CONST_ARRAY_DUPLICATE: ${constName}`)
  return values
}

function assertP26ActionAndFixtureContract(typeSource, testSource) {
  const actions = parseConstStringArray(typeSource, 'APPROVAL_ACTION_TYPES')
  const fixtureKinds = parseConstStringArray(testSource, 'P26_ATTENDANCE_FIXTURE_KINDS')
  const timeoutEffects = parseConstStringArray(testSource, 'P26_TIMEOUT_EFFECTS')
  if (JSON.stringify(actions) !== JSON.stringify(P26_GENERIC_ACTIONS)) {
    throw new Error(`ATTENDANCE_P26_ACTION_UNION_DRIFT: ${actions.join(',')}`)
  }
  if (JSON.stringify(fixtureKinds) !== JSON.stringify(P26_ATTENDANCE_FIXTURE_KINDS)) {
    throw new Error(`ATTENDANCE_P26_FIXTURE_MATRIX_DRIFT: ${fixtureKinds.join(',')}`)
  }
  if (JSON.stringify(timeoutEffects) !== JSON.stringify(P26_TIMEOUT_EFFECTS)) {
    throw new Error(`ATTENDANCE_P26_TIMEOUT_MATRIX_DRIFT: ${timeoutEffects.join(',')}`)
  }
  for (const requiredSource of [
    'for (const action of APPROVAL_ACTION_TYPES)',
    'product.dispatchAction(',
    'product.adminJump(',
    'for (const effect of P26_TIMEOUT_EFFECTS)',
    'service.applyNodeTimeoutEffect(',
  ]) {
    if (!testSource.includes(requiredSource)) {
      throw new Error(`ATTENDANCE_P26_BEHAVIOR_MATRIX_MISSING: ${requiredSource}`)
    }
  }
  return { actions, fixtureKinds, timeoutEffects }
}

module.exports = {
  P26_APPROVAL_ASSIGNMENT_CLASSIFICATIONS,
  P26_ATTENDANCE_FIXTURE_KINDS,
  P26_GENERIC_ACTIONS,
  P26_TIMEOUT_EFFECTS,
  assertP26ActionAndFixtureContract,
  classifyP26ApprovalAssignmentSites,
  keyOf,
  parseConstStringArray,
}
