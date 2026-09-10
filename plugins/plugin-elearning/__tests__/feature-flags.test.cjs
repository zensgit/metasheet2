'use strict'

const assert = require('node:assert/strict')
const {
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
} = require('../lib/feature-flags.cjs')
const {
  LOOKALIKES,
  PRIVILEGED_CALLER,
  UNAUTHORIZED_CALLER,
  ALL_FLAGS_ON,
  allCapabilities,
  withFlags,
} = require('./helpers.cjs')

function emptyEnv() {
  return {}
}

assert.deepEqual(
  [...FLAG_NAMES],
  [
    'ELEARNING_ENABLED',
    'ELEARNING_CONTENT_ENABLED',
    'ELEARNING_ASSIGNMENT_ENABLED',
    'ELEARNING_ASSESSMENT_ENABLED',
    'ELEARNING_INCENTIVE_ENABLED',
    'ELEARNING_ANALYTICS_ENABLED',
    'ELEARNING_MEDIA_ENABLED',
    'ELEARNING_ENROLLMENT_ENABLED',
  ],
)
assert.equal(FLAG_NAMES.length, 8)
assert.equal(MASTER_FLAG, 'ELEARNING_ENABLED')
assert.ok(!FLAG_NAMES.join(' ').includes('TASKS'))
assert.ok(!FLAG_NAMES.join(' ').includes('STATS'))

assert.deepEqual(CAPABILITY_PERMISSIONS, {
  content: ['elearning:read', 'elearning:write', 'elearning:admin'],
  assignment: ['elearning:read', 'elearning:write', 'elearning:admin'],
  assessment: ['elearning:read', 'elearning:write', 'elearning:grade', 'elearning:admin'],
  incentive: ['elearning:read', 'elearning:write', 'elearning:admin'],
  analytics: ['elearning:stats', 'elearning:admin'],
  media: ['elearning:read', 'elearning:write', 'elearning:admin'],
  enrollment: ['elearning:read', 'elearning:write', 'elearning:admin'],
})
assert.deepEqual(Object.keys(CAPABILITY_PERMISSIONS), [...CAPABILITY_KEYS])

assert.equal(isExactTrue('true'), true)
assert.equal(isExactTrue(true), false)
assert.equal(isExactTrue('TRUE'), false)
assert.equal(isExactTrue(undefined), false)
assert.equal(isExactTrue(''), false)

assert.equal(isMasterEnabled(emptyEnv()), false)
assert.equal(isMasterEnabled({ ELEARNING_ENABLED: 'true' }), true)

assert.equal(isHydratedCaller(undefined), false)
assert.equal(isHydratedCaller(null), false)
assert.equal(isHydratedCaller('admin'), false)
assert.equal(isHydratedCaller(['admin']), false)
assert.equal(isHydratedCaller({}), true)
assert.equal(isHydratedCaller(UNAUTHORIZED_CALLER), true)

assert.equal(authenticatedOrgId(undefined), null)
assert.equal(authenticatedOrgId(null), null)
assert.equal(authenticatedOrgId('org-a'), null)
assert.equal(authenticatedOrgId(['org-a']), null)
assert.equal(authenticatedOrgId({}), null)
assert.equal(authenticatedOrgId({ authenticatedTenantId: '' }), null)
assert.equal(authenticatedOrgId({ authenticatedTenantId: '   ' }), null)
assert.equal(authenticatedOrgId({ authenticatedTenantId: 12 }), null)
assert.equal(authenticatedOrgId({ user: { tenantId: 'header-org' } }), null)
assert.equal(authenticatedOrgId({ headers: { 'x-tenant-id': 'header-org' } }), null)
assert.equal(
  authenticatedOrgId({
    user: { tenantId: 'header-org' },
    headers: { 'x-tenant-id': 'forged-org' },
  }),
  null,
)
assert.equal(authenticatedOrgId({ authenticatedTenantId: 'org-bound' }), 'org-bound')
assert.equal(authenticatedOrgId({ authenticatedTenantId: '  org-bound  ' }), 'org-bound')
assert.equal(
  authenticatedOrgId({
    authenticatedTenantId: 'org-bound',
    user: { tenantId: 'header-org' },
    headers: { 'x-tenant-id': 'forged-org' },
  }),
  'org-bound',
)

{
  const flagsSrc = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../lib/feature-flags.cjs'),
    'utf8',
  )
  assert.match(flagsSrc, /req\.authenticatedTenantId/)
  assert.equal(flagsSrc.includes('x-tenant-id'), false)
  assert.equal(flagsSrc.includes('user.tenantId'), false)
}

for (const lookalike of LOOKALIKES) {
  const env = {}
  for (const name of FLAG_NAMES) {
    env[name] = lookalike
  }
  const payload = getCapabilitiesPayload(env, PRIVILEGED_CALLER)
  assert.equal(payload.enabled, false, `lookalike ${JSON.stringify(lookalike)} must keep master off`)
  for (const key of CAPABILITY_KEYS) {
    assert.equal(
      payload.capabilities[key],
      false,
      `lookalike ${JSON.stringify(lookalike)} must keep ${key} off`,
    )
    assert.equal(isCapabilityEnabled(key, env), false)
  }
}

{
  const env = { ELEARNING_ENABLED: 'true' }
  const payload = getCapabilitiesPayload(env, PRIVILEGED_CALLER)
  assert.equal(payload.enabled, true)
  for (const key of CAPABILITY_KEYS) {
    assert.equal(payload.capabilities[key], false, `missing ${key} flag must stay off`)
  }
}

{
  const env = { ELEARNING_ENABLED: 'true' }
  for (const key of CAPABILITY_KEYS) {
    env[CAPABILITY_FLAGS[key]] = 'false'
  }
  const payload = getCapabilitiesPayload(env, PRIVILEGED_CALLER)
  assert.equal(payload.enabled, true)
  for (const key of CAPABILITY_KEYS) {
    assert.equal(payload.capabilities[key], false, `false ${key} flag must stay off`)
  }
}

for (const lookalike of LOOKALIKES) {
  const env = { ELEARNING_ENABLED: 'true' }
  for (const key of CAPABILITY_KEYS) {
    env[CAPABILITY_FLAGS[key]] = lookalike
  }
  const payload = getCapabilitiesPayload(env, PRIVILEGED_CALLER)
  assert.equal(payload.enabled, true, `master exact true stays on when capabilities are ${JSON.stringify(lookalike)}`)
  for (const key of CAPABILITY_KEYS) {
    assert.equal(
      payload.capabilities[key],
      false,
      `whole-set lookalike ${JSON.stringify(lookalike)} must keep ${key} off`,
    )
    assert.equal(isCapabilityEnabled(key, env), false)
  }
}

for (const key of CAPABILITY_KEYS) {
  for (const lookalike of LOOKALIKES) {
    const env = { ELEARNING_ENABLED: 'true' }
    for (const other of CAPABILITY_KEYS) {
      env[CAPABILITY_FLAGS[other]] = other === key ? lookalike : 'true'
    }
    const payload = getCapabilitiesPayload(env, PRIVILEGED_CALLER)
    assert.equal(payload.enabled, true)
    for (const other of CAPABILITY_KEYS) {
      const expected = other !== key
      assert.equal(
        payload.capabilities[other],
        expected,
        `per-flag lookalike ${JSON.stringify(lookalike)} on ${key}: ${other} should be ${expected}`,
      )
    }
    assert.equal(isCapabilityEnabled(key, env), false)
  }
}

{
  const payload = getCapabilitiesPayload({ ...ALL_FLAGS_ON }, PRIVILEGED_CALLER)
  assert.equal(payload.enabled, true)
  for (const key of CAPABILITY_KEYS) {
    assert.equal(payload.capabilities[key], true, `exact true must enable ${key}`)
  }
}

{
  const env = {
    ELEARNING_ENABLED: 'true',
    ELEARNING_CONTENT_ENABLED: 'true',
    ELEARNING_ASSIGNMENT_ENABLED: 'TRUE',
    ELEARNING_ASSESSMENT_ENABLED: 'false',
    ELEARNING_INCENTIVE_ENABLED: '1',
    ELEARNING_ANALYTICS_ENABLED: 'yes',
    ELEARNING_MEDIA_ENABLED: 'true',
    ELEARNING_ENROLLMENT_ENABLED: 'false',
    ELEARNING_TASKS_ENABLED: 'true',
    ELEARNING_STATS_ENABLED: 'true',
    PRODUCT_MODE: 'platform',
    ENABLE_ELEARNING: 'true',
  }
  const payload = getCapabilitiesPayload(env, PRIVILEGED_CALLER)
  assert.deepEqual(payload, {
    enabled: true,
    capabilities: {
      content: true,
      assignment: false,
      assessment: false,
      incentive: false,
      analytics: false,
      media: true,
      enrollment: false,
    },
  })
  assert.equal(Object.keys(payload).join(','), 'enabled,capabilities')
  assert.deepEqual(Object.keys(payload.capabilities), [...CAPABILITY_KEYS])
}

{
  const env = {
    ELEARNING_CONTENT_ENABLED: 'true',
    ELEARNING_ASSIGNMENT_ENABLED: 'true',
    ELEARNING_ASSESSMENT_ENABLED: 'true',
    ELEARNING_INCENTIVE_ENABLED: 'true',
    ELEARNING_ANALYTICS_ENABLED: 'true',
    ELEARNING_MEDIA_ENABLED: 'true',
    ELEARNING_ENROLLMENT_ENABLED: 'true',
  }
  const payload = getCapabilitiesPayload(env, PRIVILEGED_CALLER)
  assert.equal(payload.enabled, false)
  for (const key of CAPABILITY_KEYS) {
    assert.equal(payload.capabilities[key], false, `${key} cannot enable without master`)
  }
}

{
  const payload = getCapabilitiesPayload({
    ELEARNING_ENABLED: 'true',
    role: 'admin',
    PRODUCT_MODE: 'platform',
    PLUGIN_STATUS: 'active',
  })
  assert.equal(payload.enabled, true)
  for (const key of CAPABILITY_KEYS) {
    assert.equal(payload.capabilities[key], false, 'must not infer capability from admin/role/product/plugin')
  }
}

{
  const payload = getCapabilitiesPayload({ ...ALL_FLAGS_ON })
  assert.equal(payload.enabled, true, 'absent caller keeps master enabled')
  assert.deepEqual(payload.capabilities, allCapabilities(false), 'absent caller fail-closes every capability')
}

{
  const payload = getCapabilitiesPayload({ ...ALL_FLAGS_ON }, UNAUTHORIZED_CALLER)
  assert.equal(payload.enabled, true)
  assert.deepEqual(payload.capabilities, allCapabilities(false))
}

{
  const payload = getCapabilitiesPayload({ ...ALL_FLAGS_ON }, { role: 'user', permissions: [] })
  assert.equal(payload.enabled, true)
  assert.deepEqual(payload.capabilities, allCapabilities(false))
}

function assertCaps(caller, expected) {
  const payload = getCapabilitiesPayload({ ...ALL_FLAGS_ON }, caller)
  assert.equal(payload.enabled, true)
  assert.deepEqual(payload.capabilities, expected)
}

assertCaps({ role: 'admin' }, allCapabilities(true))
assertCaps({ roles: ['admin'], permissions: [] }, allCapabilities(true))
assertCaps({ role: 'user', roles: ['admin'] }, allCapabilities(true))
assertCaps({ permissions: ['elearning:admin'] }, allCapabilities(true))
assertCaps({ permissions: ['elearning:*'] }, allCapabilities(true))
assertCaps({ permissions: ['*:*'] }, allCapabilities(true))

{
  const learner = {
    content: true,
    assignment: true,
    assessment: true,
    incentive: true,
    analytics: false,
    media: true,
    enrollment: true,
  }
  assertCaps({ permissions: ['elearning:read'] }, learner)
  assertCaps({ permissions: ['elearning:write'] }, learner)
  assertCaps({ role: 'user', permissions: ['elearning:read', 'elearning:write'] }, learner)
}

assertCaps({ permissions: ['elearning:grade'] }, {
  content: false,
  assignment: false,
  assessment: true,
  incentive: false,
  analytics: false,
  media: false,
  enrollment: false,
})

assertCaps({ permissions: ['elearning:stats'] }, {
  content: false,
  assignment: false,
  assessment: false,
  incentive: false,
  analytics: true,
  media: false,
  enrollment: false,
})

assertCaps({ permissions: ['elearning:read', 'elearning:stats'] }, {
  content: true,
  assignment: true,
  assessment: true,
  incentive: true,
  analytics: true,
  media: true,
  enrollment: true,
})

assertCaps({ permissions: ['elearning:grade', 'elearning:stats'] }, {
  content: false,
  assignment: false,
  assessment: true,
  incentive: false,
  analytics: true,
  media: false,
  enrollment: false,
})

{
  const rawPerms = {
    perms: ['elearning:admin', 'elearning:read', 'elearning:stats', '*:*'],
    permissions: [],
    role: 'user',
  }
  assertCaps(rawPerms, allCapabilities(false))
  assert.equal(callerAllowsCapability(rawPerms, 'content'), false)
  assert.equal(callerAllowsCapability(rawPerms, 'analytics'), false)
}

assertCaps({ roles: ['elearning:admin'], permissions: [] }, allCapabilities(false))
assertCaps({ role: 'elearning:admin', permissions: [] }, allCapabilities(false))
assertCaps({ permissions: ['ELEARNING:ADMIN'] }, allCapabilities(false))
assertCaps({ permissions: ['elearning:Admin'] }, allCapabilities(false))

{
  const payload = getCapabilitiesPayload(
    { ELEARNING_ENABLED: 'true', ELEARNING_CONTENT_ENABLED: 'true', ELEARNING_ANALYTICS_ENABLED: 'true' },
    { permissions: ['elearning:read'] },
  )
  assert.equal(payload.enabled, true)
  assert.deepEqual(payload.capabilities, {
    content: true,
    assignment: false,
    assessment: false,
    incentive: false,
    analytics: false,
    media: false,
    enrollment: false,
  })
}

{
  const payload = getCapabilitiesPayload(
    { ...ALL_FLAGS_ON, ELEARNING_ANALYTICS_ENABLED: 'TRUE' },
    { permissions: ['elearning:stats'] },
  )
  assert.equal(payload.enabled, true)
  assert.equal(payload.capabilities.analytics, false, 'analytics still exact-literal even when authorized')
}

{
  const extraKey = 'PLUGIN_STATUS'
  const hadExtra = Object.prototype.hasOwnProperty.call(process.env, extraKey)
  const originalExtra = process.env[extraKey]
  const hadProduct = Object.prototype.hasOwnProperty.call(process.env, 'PRODUCT_MODE')
  const originalProduct = process.env.PRODUCT_MODE
  delete process.env[extraKey]
  delete process.env.PRODUCT_MODE
  try {
    withFlags({
      ELEARNING_ENABLED: 'true',
      PRODUCT_MODE: 'platform',
      PLUGIN_STATUS: 'active',
    }, () => {
      assert.equal(process.env.PRODUCT_MODE, 'platform')
      assert.equal(process.env.PLUGIN_STATUS, 'active')
    })
    assert.equal(Object.prototype.hasOwnProperty.call(process.env, extraKey), false)
    assert.equal(Object.prototype.hasOwnProperty.call(process.env, 'PRODUCT_MODE'), false)
  } finally {
    if (hadExtra) process.env[extraKey] = originalExtra
    else delete process.env[extraKey]
    if (hadProduct) process.env.PRODUCT_MODE = originalProduct
    else delete process.env.PRODUCT_MODE
  }
}

console.log('✓ feature-flags: exact-literal master/capability matrix')
