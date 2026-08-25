'use strict'

const assert = require('node:assert/strict')
const { activate } = require('../index.cjs')
const { CAPABILITY_KEYS } = require('../lib/feature-flags.cjs')
const { FEATURE_DISABLED_CODE } = require('../lib/http-errors.cjs')
const {
  LOOKALIKES,
  PRIVILEGED_CALLER,
  UNAUTHORIZED_CALLER,
  ALL_FLAGS_ON,
  allCapabilities,
  withFlagsAsync,
  createMockContext,
  invokeHandler,
} = require('./helpers.cjs')

function assertCanonicalPayload(body, expected) {
  assert.deepEqual(Object.keys(body), ['enabled', 'capabilities'])
  assert.deepEqual(Object.keys(body.capabilities), [...CAPABILITY_KEYS])
  assert.deepEqual(body, expected)
}

function assertValuesFree(body) {
  const serialized = JSON.stringify(body)
  assert.equal(serialized.includes('ELEARNING'), false, 'body must be values-free of flag names')
  assert.equal(serialized.includes('elearning:'), false, 'body must be values-free of permission codes')
}

function assertFeatureDisabled(result) {
  assert.equal(result.status, 404)
  assert.equal(result.body.ok, false)
  assert.equal(result.body.error.code, FEATURE_DISABLED_CODE)
  assertValuesFree(result.body)
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

function assertUnauthenticated(result) {
  assert.equal(result.status, 401)
  assert.equal(result.body.ok, false)
  assert.equal(result.body.error.code, 'UNAUTHORIZED')
  assertValuesFree(result.body)
  assert.equal(Object.prototype.hasOwnProperty.call(result.body, 'capabilities'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(result.body, 'enabled'), false)
}

async function activateHandler(flagMap) {
  return withFlagsAsync(flagMap, async () => {
    const { context, routes } = createMockContext()
    await activate(context)
    assert.equal(routes.length, 1)
    return routes[0].handler
  })
}

async function invokeWith(handler, flagMap, req) {
  return withFlagsAsync(flagMap, () => invokeHandler(handler, req))
}

async function main() {
  {
    const handler = await activateHandler({ ELEARNING_ENABLED: 'true' })
    const result = await invokeWith(handler, { ELEARNING_ENABLED: 'true' }, {
      user: { role: 'admin', permissions: ['elearning:admin'] },
    })
    assert.equal(result.status, 200)
    assertCanonicalPayload(result.body, {
      enabled: true,
      capabilities: allCapabilities(false),
    })
  }

  {
    const handler = await activateHandler({ ELEARNING_ENABLED: 'true' })
    const result = await invokeWith(handler, { ...ALL_FLAGS_ON }, { user: PRIVILEGED_CALLER })
    assert.equal(result.status, 200)
    assertCanonicalPayload(result.body, {
      enabled: true,
      capabilities: allCapabilities(true),
    })
  }

  {
    const handler = await activateHandler({ ELEARNING_ENABLED: 'true' })
    const result = await invokeWith(handler, {
      ELEARNING_ENABLED: 'true',
      ELEARNING_CONTENT_ENABLED: 'true',
      ELEARNING_ASSIGNMENT_ENABLED: 'TRUE',
      ELEARNING_ASSESSMENT_ENABLED: 'false',
      ELEARNING_INCENTIVE_ENABLED: undefined,
      ELEARNING_ANALYTICS_ENABLED: '1',
      ELEARNING_MEDIA_ENABLED: 'true',
    }, { user: PRIVILEGED_CALLER })
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
    const result = await invokeWith(handler, {}, { user: PRIVILEGED_CALLER })
    assertFeatureDisabled(result)
  }

  {
    const handler = await activateHandler({ ELEARNING_ENABLED: 'true' })
    const result = await invokeWith(handler, { ELEARNING_ENABLED: 'false' }, { user: PRIVILEGED_CALLER })
    assertFeatureDisabled(result)
  }

  for (const lookalike of LOOKALIKES) {
    const handler = await activateHandler({ ELEARNING_ENABLED: 'true' })
    const result = await invokeWith(handler, { ELEARNING_ENABLED: lookalike }, { user: PRIVILEGED_CALLER })
    assertFeatureDisabled(result)
  }

  {
    const handler = await activateHandler({ ELEARNING_ENABLED: 'true' })
    const result = await invokeWith(handler, {
      ELEARNING_CONTENT_ENABLED: 'true',
      ELEARNING_ASSIGNMENT_ENABLED: 'true',
      ELEARNING_ASSESSMENT_ENABLED: 'true',
      ELEARNING_INCENTIVE_ENABLED: 'true',
      ELEARNING_ANALYTICS_ENABLED: 'true',
      ELEARNING_MEDIA_ENABLED: 'true',
      PRODUCT_MODE: 'platform',
    }, { user: { role: 'admin' } })
    assertFeatureDisabled(result)
  }

  {
    const handler = await activateHandler({ ELEARNING_ENABLED: 'true' })
    const result = await invokeWith(handler, { ...ALL_FLAGS_ON })
    assertUnauthenticated(result)
  }

  {
    const handler = await activateHandler({ ELEARNING_ENABLED: 'true' })
    const result = await invokeWith(handler, { ...ALL_FLAGS_ON }, { user: null })
    assertUnauthenticated(result)
  }

  {
    const handler = await activateHandler({ ELEARNING_ENABLED: 'true' })
    const result = await invokeWith(handler, { ...ALL_FLAGS_ON }, { user: UNAUTHORIZED_CALLER })
    assert.equal(result.status, 200)
    assertCanonicalPayload(result.body, {
      enabled: true,
      capabilities: allCapabilities(false),
    })
  }

  {
    const handler = await activateHandler({ ELEARNING_ENABLED: 'true' })
    const result = await invokeWith(handler, { ...ALL_FLAGS_ON }, {
      user: { role: 'user', permissions: ['elearning:read'] },
    })
    assert.equal(result.status, 200)
    assertCanonicalPayload(result.body, {
      enabled: true,
      capabilities: {
        content: true,
        assignment: true,
        assessment: true,
        incentive: true,
        analytics: false,
        media: true,
      },
    })
  }

  {
    const handler = await activateHandler({ ELEARNING_ENABLED: 'true' })
    const result = await invokeWith(handler, { ...ALL_FLAGS_ON }, {
      user: { permissions: ['elearning:write'] },
    })
    assert.equal(result.status, 200)
    assert.equal(result.body.capabilities.analytics, false)
    assert.equal(result.body.capabilities.content, true)
    assert.equal(result.body.capabilities.assessment, true)
  }

  {
    const handler = await activateHandler({ ELEARNING_ENABLED: 'true' })
    const result = await invokeWith(handler, { ...ALL_FLAGS_ON }, {
      user: { permissions: ['elearning:grade'] },
    })
    assert.equal(result.status, 200)
    assertCanonicalPayload(result.body, {
      enabled: true,
      capabilities: {
        content: false,
        assignment: false,
        assessment: true,
        incentive: false,
        analytics: false,
        media: false,
      },
    })
  }

  {
    const handler = await activateHandler({ ELEARNING_ENABLED: 'true' })
    const result = await invokeWith(handler, { ...ALL_FLAGS_ON }, {
      user: { permissions: ['elearning:stats'] },
    })
    assert.equal(result.status, 200)
    assertCanonicalPayload(result.body, {
      enabled: true,
      capabilities: {
        content: false,
        assignment: false,
        assessment: false,
        incentive: false,
        analytics: true,
        media: false,
      },
    })
  }

  {
    const handler = await activateHandler({ ELEARNING_ENABLED: 'true' })
    const result = await invokeWith(handler, { ...ALL_FLAGS_ON }, {
      user: { permissions: ['elearning:*'] },
    })
    assert.equal(result.status, 200)
    assertCanonicalPayload(result.body, { enabled: true, capabilities: allCapabilities(true) })
  }

  {
    const handler = await activateHandler({ ELEARNING_ENABLED: 'true' })
    const result = await invokeWith(handler, { ...ALL_FLAGS_ON }, {
      user: { permissions: ['*:*'] },
    })
    assert.equal(result.status, 200)
    assertCanonicalPayload(result.body, { enabled: true, capabilities: allCapabilities(true) })
  }

  {
    const handler = await activateHandler({ ELEARNING_ENABLED: 'true' })
    const result = await invokeWith(handler, { ...ALL_FLAGS_ON }, {
      user: {
        role: 'user',
        permissions: [],
        perms: ['elearning:admin', '*:*', 'elearning:stats'],
      },
    })
    assert.equal(result.status, 200)
    assertCanonicalPayload(result.body, {
      enabled: true,
      capabilities: allCapabilities(false),
    })
  }

  {
    const handler = await activateHandler({ ELEARNING_ENABLED: 'true' })
    const result = await invokeWith(handler, { ...ALL_FLAGS_ON }, {
      user: { roles: ['admin'], permissions: [] },
    })
    assert.equal(result.status, 200)
    assertCanonicalPayload(result.body, { enabled: true, capabilities: allCapabilities(true) })
  }

  console.log('✓ capabilities-handler: payload shape, capability AND, secondary master gate')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
