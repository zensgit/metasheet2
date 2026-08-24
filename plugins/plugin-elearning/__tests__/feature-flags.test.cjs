'use strict'

const assert = require('node:assert/strict')
const {
  MASTER_FLAG,
  CAPABILITY_KEYS,
  CAPABILITY_FLAGS,
  FLAG_NAMES,
  isExactTrue,
  isMasterEnabled,
  isCapabilityEnabled,
  getCapabilitiesPayload,
} = require('../lib/feature-flags.cjs')
const { LOOKALIKES } = require('./helpers.cjs')

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
  ],
)
assert.equal(FLAG_NAMES.length, 7)
assert.equal(MASTER_FLAG, 'ELEARNING_ENABLED')
assert.ok(!FLAG_NAMES.join(' ').includes('TASKS'))
assert.ok(!FLAG_NAMES.join(' ').includes('STATS'))

assert.equal(isExactTrue('true'), true)
assert.equal(isExactTrue(true), false)
assert.equal(isExactTrue('TRUE'), false)
assert.equal(isExactTrue(undefined), false)
assert.equal(isExactTrue(''), false)

assert.equal(isMasterEnabled(emptyEnv()), false)
assert.equal(isMasterEnabled({ ELEARNING_ENABLED: 'true' }), true)

for (const lookalike of LOOKALIKES) {
  const env = {}
  for (const name of FLAG_NAMES) {
    env[name] = lookalike
  }
  const payload = getCapabilitiesPayload(env)
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
  const payload = getCapabilitiesPayload(env)
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
  const payload = getCapabilitiesPayload(env)
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
  const payload = getCapabilitiesPayload(env)
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
    const payload = getCapabilitiesPayload(env)
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
  const env = { ELEARNING_ENABLED: 'true' }
  for (const key of CAPABILITY_KEYS) {
    env[CAPABILITY_FLAGS[key]] = 'true'
  }
  const payload = getCapabilitiesPayload(env)
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
    ELEARNING_TASKS_ENABLED: 'true',
    ELEARNING_STATS_ENABLED: 'true',
    PRODUCT_MODE: 'platform',
    ENABLE_ELEARNING: 'true',
  }
  const payload = getCapabilitiesPayload(env)
  assert.deepEqual(payload, {
    enabled: true,
    capabilities: {
      content: true,
      assignment: false,
      assessment: false,
      incentive: false,
      analytics: false,
      media: true,
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
  }
  const payload = getCapabilitiesPayload(env)
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

console.log('✓ feature-flags: exact-literal master/capability matrix')
