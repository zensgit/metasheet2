'use strict'

const assert = require('node:assert/strict')
const { activate } = require('../index.cjs')
const { CAPABILITY_KEYS, CAPABILITY_FLAGS } = require('../lib/feature-flags.cjs')
const { FEATURE_DISABLED_CODE } = require('../lib/http-errors.cjs')
const {
  LOOKALIKES,
  withFlagsAsync,
  createMockContext,
  invokeHandler,
} = require('./helpers.cjs')

function assertCanonicalPayload(body, expected) {
  assert.deepEqual(Object.keys(body), ['enabled', 'capabilities'])
  assert.deepEqual(Object.keys(body.capabilities), [...CAPABILITY_KEYS])
  assert.deepEqual(body, expected)
}

function assertFeatureDisabled(result) {
  assert.equal(result.status, 404)
  assert.equal(result.body.ok, false)
  assert.equal(result.body.error.code, FEATURE_DISABLED_CODE)
  const serialized = JSON.stringify(result.body)
  assert.equal(serialized.includes('ELEARNING'), false, '404 body must be values-free of flag names')
  assert.equal(
    Object.prototype.hasOwnProperty.call(result.body, 'capabilities'),
    false,
    'disabled handler must not return capabilities',
  )
  assert.equal(
    Object.prototype.hasOwnProperty.call(result.body, 'enabled'),
    false,
    'disabled handler must not return enabled',
  )
}

async function activateHandler(flagMap) {
  return withFlagsAsync(flagMap, async () => {
    const { context, routes } = createMockContext()
    await activate(context)
    assert.equal(routes.length, 1)
    return routes[0].handler
  })
}

async function main() {
  {
    const handler = await activateHandler({ ELEARNING_ENABLED: 'true' })
    const result = await withFlagsAsync({ ELEARNING_ENABLED: 'true' }, () => invokeHandler(handler, {
      user: { role: 'admin', permissions: ['elearning:admin'] },
    }))
    assert.equal(result.status, 200)
    assertCanonicalPayload(result.body, {
      enabled: true,
      capabilities: {
        content: false,
        assignment: false,
        assessment: false,
        incentive: false,
        analytics: false,
        media: false,
      },
    })
  }

  {
    const env = { ELEARNING_ENABLED: 'true' }
    for (const key of CAPABILITY_KEYS) {
      env[CAPABILITY_FLAGS[key]] = 'true'
    }
    const handler = await activateHandler({ ELEARNING_ENABLED: 'true' })
    const result = await withFlagsAsync(env, () => invokeHandler(handler))
    assert.equal(result.status, 200)
    assertCanonicalPayload(result.body, {
      enabled: true,
      capabilities: {
        content: true,
        assignment: true,
        assessment: true,
        incentive: true,
        analytics: true,
        media: true,
      },
    })
  }

  {
    const handler = await activateHandler({ ELEARNING_ENABLED: 'true' })
    const result = await withFlagsAsync({
      ELEARNING_ENABLED: 'true',
      ELEARNING_CONTENT_ENABLED: 'true',
      ELEARNING_ASSIGNMENT_ENABLED: 'TRUE',
      ELEARNING_ASSESSMENT_ENABLED: 'false',
      ELEARNING_INCENTIVE_ENABLED: undefined,
      ELEARNING_ANALYTICS_ENABLED: '1',
      ELEARNING_MEDIA_ENABLED: 'true',
    }, () => invokeHandler(handler))
    assert.equal(result.status, 200)
    assertCanonicalPayload(result.body, {
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
  }

  {
    const handler = await activateHandler({ ELEARNING_ENABLED: 'true' })
    const result = await withFlagsAsync({}, () => invokeHandler(handler))
    assertFeatureDisabled(result)
  }

  {
    const handler = await activateHandler({ ELEARNING_ENABLED: 'true' })
    const result = await withFlagsAsync({ ELEARNING_ENABLED: 'false' }, () => invokeHandler(handler))
    assertFeatureDisabled(result)
  }

  for (const lookalike of LOOKALIKES) {
    const handler = await activateHandler({ ELEARNING_ENABLED: 'true' })
    const result = await withFlagsAsync({ ELEARNING_ENABLED: lookalike }, () => invokeHandler(handler))
    assertFeatureDisabled(result)
  }

  {
    const handler = await activateHandler({ ELEARNING_ENABLED: 'true' })
    const result = await withFlagsAsync({
      ELEARNING_CONTENT_ENABLED: 'true',
      ELEARNING_ASSIGNMENT_ENABLED: 'true',
      ELEARNING_ASSESSMENT_ENABLED: 'true',
      ELEARNING_INCENTIVE_ENABLED: 'true',
      ELEARNING_ANALYTICS_ENABLED: 'true',
      ELEARNING_MEDIA_ENABLED: 'true',
      PRODUCT_MODE: 'platform',
    }, () => invokeHandler(handler, { user: { role: 'admin' } }))
    assertFeatureDisabled(result)
  }

  console.log('✓ capabilities-handler: payload shape, capability AND, secondary master gate')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
