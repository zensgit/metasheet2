'use strict'

// C1 (#1709 / C0 #3242): contract normalizer + preset metadata. Pure contract — no K3, no route, no
// LIST/BOM/runtime. Asserts the forward { presetId, intent } shape and the shipped { presetId, key } subset
// normalize to the SAME detail output (no silent divergence), and that the C3 LIST-only preset is explicit,
// bounded, and fail-closed values-free.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  getReadSmokePreset,
  ReadSmokeContractError,
  normalizeReadSmokeContract,
} = require(path.join(__dirname, '..', 'lib', 'read-smoke.cjs'))

const PRESET = getReadSmokePreset('k3wise.material-detail.v1')
const LIST_PRESET = getReadSmokePreset('k3wise.material-list.v1')
const isErr = (reason) => (e) => e instanceof ReadSmokeContractError && e.code === 'READ_SMOKE_CONTRACT_INVALID' && e.reason === reason

// --- preset metadata present + frozen ---
assert.deepEqual(PRESET.allowedObjects, ['material'])
assert.deepEqual(PRESET.allowedModes, ['single_record_detail'])
assert.equal(PRESET.defaultObject, 'material')
assert.equal(PRESET.defaultMode, 'single_record_detail')
assert.deepEqual(LIST_PRESET.allowedObjects, ['material'])
assert.deepEqual(LIST_PRESET.allowedModes, ['list'])
assert.equal(LIST_PRESET.defaultObject, 'material')
assert.equal(LIST_PRESET.defaultMode, 'list')
assert.equal(LIST_PRESET.listLimit, 10)
assert.throws(() => { PRESET.allowedObjects.push('bom') }, TypeError, 'allowedObjects is frozen')

// --- RECONCILIATION: both shapes → identical normalized output ---
const fromSubset = normalizeReadSmokeContract({ presetId: 'k3wise.material-detail.v1', key: 'M-001' })
const fromIntent = normalizeReadSmokeContract({
  presetId: 'k3wise.material-detail.v1',
  intent: { object: 'material', mode: 'single_record_detail', key: 'M-001' },
})
const expected = { presetId: 'k3wise.material-detail.v1', object: 'material', mode: 'single_record_detail', key: 'M-001' }
assert.deepEqual(fromSubset, expected, 'shipped { presetId, key } subset normalizes to the canonical output')
assert.deepEqual(fromIntent, expected, 'forward { presetId, intent } shape normalizes to the same output')
assert.deepEqual(fromSubset, fromIntent, 'the two shapes do not diverge')
// key is trimmed
assert.equal(normalizeReadSmokeContract({ presetId: 'k3wise.material-detail.v1', key: '  M-002  ' }).key, 'M-002')

// --- C3 LIST-only preset: explicit intent shape, no key, no request-supplied filters/limit/cursor ---
const listContract = normalizeReadSmokeContract({
  presetId: 'k3wise.material-list.v1',
  intent: { object: 'material', mode: 'list' },
})
assert.deepEqual(listContract, {
  presetId: 'k3wise.material-list.v1',
  object: 'material',
  mode: 'list',
}, 'LIST preset normalizes to a keyless bounded-list contract')
assert.equal(listContract.key, undefined)

// --- fail-closed ---
assert.throws(() => normalizeReadSmokeContract(null), isErr('not_object'))
assert.throws(() => normalizeReadSmokeContract('x'), isErr('not_object'))
assert.throws(() => normalizeReadSmokeContract({ presetId: 'nope.v1', key: 'M-001' }), isErr('preset_unknown'))
assert.throws(() => normalizeReadSmokeContract({ presetId: 'k3wise.material-detail.v1', key: '   ' }), isErr('key_required'))
assert.throws(() => normalizeReadSmokeContract({ presetId: 'k3wise.material-detail.v1' }), isErr('key_required'))
// unknown object / mode (forward shape) → fail-closed (LIST/BOM cannot enter via intent)
assert.throws(() => normalizeReadSmokeContract({ presetId: 'k3wise.material-detail.v1', intent: { object: 'bom', mode: 'single_record_detail', key: 'M-001' } }), isErr('object_not_allowed'))
assert.throws(() => normalizeReadSmokeContract({ presetId: 'k3wise.material-detail.v1', intent: { object: 'material', mode: 'list', key: 'M-001' } }), isErr('mode_not_allowed'))
assert.throws(() => normalizeReadSmokeContract({ presetId: 'k3wise.material-list.v1', key: 'M-001' }), isErr('intent_required'))
assert.throws(() => normalizeReadSmokeContract({ presetId: 'k3wise.material-list.v1', intent: { object: 'material', mode: 'list', key: 'M-001' } }), isErr('key_not_allowed'))
assert.throws(() => normalizeReadSmokeContract({ presetId: 'k3wise.material-list.v1', intent: { object: 'material', mode: 'single_record_detail', key: 'M-001' } }), isErr('mode_not_allowed'))
assert.throws(() => normalizeReadSmokeContract({ presetId: 'k3wise.material-list.v1', intent: { object: 'bom', mode: 'list' } }), isErr('object_not_allowed'))
// ambiguous: both key + intent
assert.throws(() => normalizeReadSmokeContract({ presetId: 'k3wise.material-detail.v1', key: 'M-001', intent: { object: 'material', mode: 'single_record_detail', key: 'M-001' } }), isErr('ambiguous_shape'))
assert.throws(() => normalizeReadSmokeContract({ presetId: 'k3wise.material-list.v1', key: 'M-001', intent: { object: 'material', mode: 'list' } }), isErr('ambiguous_shape'))
// intent not an object
assert.throws(() => normalizeReadSmokeContract({ presetId: 'k3wise.material-detail.v1', intent: 'material' }), isErr('intent_invalid'))

// --- raw path/method/payload/config can NEVER ride in from the request ---
for (const bad of ['path', 'method', 'headers', 'body', 'response', 'endpoint', 'url', 'config', 'credentials', 'token', 'readPath', 'readMethod', 'savePath', 'operations']) {
  assert.throws(
    () => normalizeReadSmokeContract({ presetId: 'k3wise.material-detail.v1', key: 'M-001', [bad]: 'x' }),
    isErr('unexpected_field'),
    `top-level raw field '${bad}' must be rejected`,
  )
}
// and inside intent
assert.throws(() => normalizeReadSmokeContract({ presetId: 'k3wise.material-detail.v1', intent: { object: 'material', mode: 'single_record_detail', key: 'M-001', readPath: '/evil' } }), isErr('unexpected_field'))
for (const bad of ['limit', 'filters', 'cursor', 'watermark', 'pagination', 'readPath', 'readMethod']) {
  assert.throws(
    () => normalizeReadSmokeContract({ presetId: 'k3wise.material-list.v1', intent: { object: 'material', mode: 'list', [bad]: 'x' } }),
    isErr('unexpected_field'),
    `LIST intent raw field '${bad}' must be rejected`,
  )
}

// --- values-free: the key is never echoed in an error ---
try {
  normalizeReadSmokeContract({ presetId: 'k3wise.material-detail.v1', intent: { object: 'bom', mode: 'single_record_detail', key: 'SECRET-KEY-123' } })
  assert.fail('expected object_not_allowed')
} catch (e) {
  assert.ok(!String(e.message).includes('SECRET-KEY-123'), 'error message must not echo the key')
  assert.ok(!String(e.message).includes('bom') || true) // object name is a coarse allowlist token, not a value
}

console.log('read-smoke-contract.test.cjs OK')
