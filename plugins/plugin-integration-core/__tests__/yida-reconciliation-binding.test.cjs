'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

// R-71 ⑦.5 reconciliation binding: the host receives exactly one factory; the context it passes is the
// authorized actor and the owner is never chosen independently of it. Synthetic only; no IO.
const bindingPromise = import(pathToFileURL(path.join(__dirname, '..', 'lib', 'yida-reconciliation-binding.mjs')).href)
const db = { transaction: async () => { throw new Error('SYNTHETIC_NO_DB') }, selectOne: async () => null }
const security = { encrypt: () => 'x', decrypt: () => 'x' }
const options = (patch = {}) => ({ context: { actorId: 'synthetic-owner', tenantId: 'synthetic-tenant', workspaceId: null },
  fetch: async () => { throw new Error('SYNTHETIC_NO_NETWORK') }, readEnablement: () => 'true', timeoutMs: 5000, ...patch })

test('binding exposes only createReconciliationPort, and the port only step/inspect/abandon', async () => {
  const { createYidaReconciliationBinding } = await bindingPromise
  const binding = createYidaReconciliationBinding({ db, security })
  assert.deepEqual(Object.keys(binding), ['createReconciliationPort'])
  assert.equal(Object.isFrozen(binding), true)
  const port = binding.createReconciliationPort(options())
  assert.deepEqual(Object.keys(port).sort(), ['abandon', 'inspect', 'step'])
})

test('binding refuses widened or malformed host input (closed keys, workspace, timeout)', async () => {
  const { createYidaReconciliationBinding } = await bindingPromise
  assert.throws(() => createYidaReconciliationBinding({ db, security, extra: 1 }), { code: 'YIDA_RECONCILE_BINDING_INPUT' })
  assert.throws(() => createYidaReconciliationBinding({ db: { transaction() {} }, security }), { code: 'YIDA_RECONCILE_BINDING_INPUT' })
  const binding = createYidaReconciliationBinding({ db, security })
  for (const patch of [{ context: { actorId: 'a', tenantId: 't', workspaceId: 'w' } }, { timeoutMs: 5 }, { timeoutMs: 60001 },
    { fetch: 'nope' }, { readEnablement: undefined }, { extra: true }]) {
    assert.throws(() => binding.createReconciliationPort(options(patch)), { code: 'YIDA_RECONCILE_BINDING_INPUT' })
  }
})

test('a port built by the binding is DISABLED without the exact literal and touches no db or network', async () => {
  const { createYidaReconciliationBinding } = await bindingPromise
  let touched = 0
  const counting = { transaction: async () => { touched += 1 }, selectOne: async () => { touched += 1 } }
  const binding = createYidaReconciliationBinding({ db: counting, security })
  for (const value of ['TRUE', ' true', 'true ', '', undefined, Promise.resolve('true')]) {
    const port = binding.createReconciliationPort(options({ readEnablement: () => value,
      fetch: async () => { touched += 1; throw new Error('SYNTHETIC') } }))
    await assert.rejects(port.step({ commandId: '11111111-2222-4333-8444-555555555555', mode: 'count', projectNo: 'DEMO-P1',
      projectKeyTarget: 'project', expectedKeyTargets: ['project'] }), { code: 'YIDA_RECONCILE_DISABLED' })
  }
  assert.equal(touched, 0)
})
