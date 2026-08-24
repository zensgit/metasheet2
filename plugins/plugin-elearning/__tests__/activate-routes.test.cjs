'use strict'

const assert = require('node:assert/strict')
const { activate, deactivate, CANONICAL_METHOD, CANONICAL_PATH } = require('../index.cjs')
const { FLAG_NAMES } = require('../lib/feature-flags.cjs')
const { LOOKALIKES, withFlagsAsync, createMockContext } = require('./helpers.cjs')

async function main() {
  assert.equal(CANONICAL_METHOD, 'GET')
  assert.equal(CANONICAL_PATH, '/api/elearning/capabilities')
  assert.equal(typeof activate, 'function')
  assert.equal(typeof deactivate, 'function')

  await withFlagsAsync({}, async () => {
    const { context, routes } = createMockContext()
    await activate(context)
    assert.equal(routes.length, 0, 'default/missing master must register zero routes')
  })

  await withFlagsAsync({ ELEARNING_ENABLED: 'false' }, async () => {
    const { context, routes } = createMockContext()
    await activate(context)
    assert.equal(routes.length, 0, 'master false must register zero routes')
  })

  for (const lookalike of LOOKALIKES) {
    await withFlagsAsync({ ELEARNING_ENABLED: lookalike }, async () => {
      const { context, routes } = createMockContext()
      await activate(context)
      assert.equal(routes.length, 0, `master lookalike ${JSON.stringify(lookalike)} must register zero routes`)
    })
  }

  {
    const env = {}
    for (const name of FLAG_NAMES) {
      if (name !== 'ELEARNING_ENABLED') env[name] = 'true'
    }
    env.PRODUCT_MODE = 'platform'
    env.PLUGIN_STATUS = 'active'
    await withFlagsAsync(env, async () => {
      const { context, routes } = createMockContext()
      await activate(context)
      assert.equal(routes.length, 0, 'capability flags / product mode / plugin status must not register routes')
    })
  }

  await withFlagsAsync({ ELEARNING_ENABLED: 'true' }, async () => {
    const { context, routes } = createMockContext()
    await activate(context)
    assert.equal(routes.length, 1, 'master ON must register exactly one route')
    assert.equal(routes[0].method, 'GET')
    assert.equal(routes[0].path, '/api/elearning/capabilities')
    assert.equal(typeof routes[0].handler, 'function')
    const elearningPaths = routes.filter((route) => String(route.path).includes('elearning'))
    assert.equal(elearningPaths.length, 1)
  })

  await withFlagsAsync({ ELEARNING_ENABLED: 'true' }, async () => {
    const { context, routes } = createMockContext()
    await activate(context)
    await deactivate()
    assert.equal(routes.length, 1, 'deactivate must not invent extra routes')
  })

  console.log('✓ activate-routes: master OFF zero routes, master ON unique canonical route')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
