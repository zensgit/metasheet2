'use strict'

const MASTER_FLAG = 'ELEARNING_ENABLED'

const CAPABILITY_KEYS = Object.freeze([
  'content',
  'assignment',
  'assessment',
  'incentive',
  'analytics',
  'media',
])

const CAPABILITY_FLAGS = Object.freeze({
  content: 'ELEARNING_CONTENT_ENABLED',
  assignment: 'ELEARNING_ASSIGNMENT_ENABLED',
  assessment: 'ELEARNING_ASSESSMENT_ENABLED',
  incentive: 'ELEARNING_INCENTIVE_ENABLED',
  analytics: 'ELEARNING_ANALYTICS_ENABLED',
  media: 'ELEARNING_MEDIA_ENABLED',
})

const FLAG_NAMES = Object.freeze([
  MASTER_FLAG,
  CAPABILITY_FLAGS.content,
  CAPABILITY_FLAGS.assignment,
  CAPABILITY_FLAGS.assessment,
  CAPABILITY_FLAGS.incentive,
  CAPABILITY_FLAGS.analytics,
  CAPABILITY_FLAGS.media,
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

function getCapabilitiesPayload(env) {
  const source = env || process.env
  const enabled = isMasterEnabled(source)
  const capabilities = {}
  for (const key of CAPABILITY_KEYS) {
    capabilities[key] = enabled && isExactTrue(source[CAPABILITY_FLAGS[key]])
  }
  return { enabled, capabilities }
}

module.exports = {
  MASTER_FLAG,
  CAPABILITY_KEYS,
  CAPABILITY_FLAGS,
  FLAG_NAMES,
  isExactTrue,
  isMasterEnabled,
  isCapabilityEnabled,
  getCapabilitiesPayload,
}
