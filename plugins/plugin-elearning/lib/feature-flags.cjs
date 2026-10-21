'use strict'

const MASTER_FLAG = 'ELEARNING_ENABLED'

const CAPABILITY_KEYS = Object.freeze([
  'content',
  'assignment',
  'assessment',
  'incentive',
  'analytics',
  'media',
  'enrollment',
])

const CAPABILITY_FLAGS = Object.freeze({
  content: 'ELEARNING_CONTENT_ENABLED',
  assignment: 'ELEARNING_ASSIGNMENT_ENABLED',
  assessment: 'ELEARNING_ASSESSMENT_ENABLED',
  incentive: 'ELEARNING_INCENTIVE_ENABLED',
  analytics: 'ELEARNING_ANALYTICS_ENABLED',
  media: 'ELEARNING_MEDIA_ENABLED',
  enrollment: 'ELEARNING_ENROLLMENT_ENABLED',
})

const FLAG_NAMES = Object.freeze([
  MASTER_FLAG,
  CAPABILITY_FLAGS.content,
  CAPABILITY_FLAGS.assignment,
  CAPABILITY_FLAGS.assessment,
  CAPABILITY_FLAGS.incentive,
  CAPABILITY_FLAGS.analytics,
  CAPABILITY_FLAGS.media,
  CAPABILITY_FLAGS.enrollment,
])

function isExactTrue(value) {
  return value === 'true'
}

function isMasterEnabled(env) {
  const source = env || process.env
  return isExactTrue(source[MASTER_FLAG])
}

function isCapabilityEnabled(key, env) {
  const source = env || process.env
  const flagName = CAPABILITY_FLAGS[key]
  if (!flagName) return false
  return isMasterEnabled(source) && isExactTrue(source[flagName])
}

const CAPABILITY_PERMISSIONS = Object.freeze({
  content: Object.freeze(['elearning:read', 'elearning:write', 'elearning:admin']),
  assignment: Object.freeze(['elearning:read', 'elearning:write', 'elearning:admin']),
  assessment: Object.freeze(['elearning:read', 'elearning:write', 'elearning:grade', 'elearning:admin']),
  incentive: Object.freeze(['elearning:read', 'elearning:write', 'elearning:admin']),
  analytics: Object.freeze(['elearning:stats', 'elearning:admin']),
  media: Object.freeze(['elearning:read', 'elearning:write', 'elearning:admin']),
  enrollment: Object.freeze(['elearning:read', 'elearning:write', 'elearning:admin']),
})

function isHydratedCaller(caller) {
  return caller != null && typeof caller === 'object' && !Array.isArray(caller)
}

/** JWT-bound req.authenticatedTenantId only. Never headers or hydrated user tenant fields. */
function authenticatedOrgId(req) {
  if (req == null || typeof req !== 'object' || Array.isArray(req)) return null
  const tenant = req.authenticatedTenantId
  return typeof tenant === 'string' && tenant.trim() ? tenant.trim() : null
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return []
  const result = []
  for (const item of value) {
    const text = String(item ?? '').trim()
    if (text) result.push(text)
  }
  return result
}

function isGlobalAdmin(caller) {
  if (!isHydratedCaller(caller)) return false
  if (caller.role === 'admin') return true
  return normalizeStringArray(caller.roles).includes('admin')
}

function hydratedPermissionCodes(caller) {
  if (!isHydratedCaller(caller)) return []
  // Hydrated req.user.permissions only. Never raw `perms` claims.
  return normalizeStringArray(caller.permissions)
}

function hasPermissionCode(codes, permissionCode) {
  if (codes.includes(permissionCode) || codes.includes('*:*')) return true
  const resource = permissionCode.split(':')[0]
  return resource ? codes.includes(`${resource}:*`) : false
}

function callerAllowsCapability(caller, key) {
  if (!isHydratedCaller(caller)) return false
  if (isGlobalAdmin(caller)) return true
  const required = CAPABILITY_PERMISSIONS[key]
  if (!required) return false
  const codes = hydratedPermissionCodes(caller)
  for (const permissionCode of required) {
    if (hasPermissionCode(codes, permissionCode)) return true
  }
  return false
}

function getCapabilitiesPayload(env, caller) {
  const source = env || process.env
  const enabled = isMasterEnabled(source)
  const capabilities = {}
  for (const key of CAPABILITY_KEYS) {
    capabilities[key] = enabled
      && isExactTrue(source[CAPABILITY_FLAGS[key]])
      && callerAllowsCapability(caller, key)
  }
  return { enabled, capabilities }
}

module.exports = {
  MASTER_FLAG,
  CAPABILITY_KEYS,
  CAPABILITY_FLAGS,
  CAPABILITY_PERMISSIONS,
  FLAG_NAMES,
  isExactTrue,
  isMasterEnabled,
  isCapabilityEnabled,
  isHydratedCaller,
  authenticatedOrgId,
  callerAllowsCapability,
  getCapabilitiesPayload,
}
