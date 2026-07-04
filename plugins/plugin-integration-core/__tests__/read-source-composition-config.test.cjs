'use strict'

// Read-source resolver composition C-R1 — chain config model + validator only.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  COMPOSITION_MAX_STEPS,
  validateReadSourceCompositionConfig,
} = require(path.join(__dirname, '..', 'lib', 'read-source-composition-config.cjs'))

function chain(overrides = {}) {
  return {
    version: 1,
    name: 'material_to_bom',
    operations: ['read'],
    steps: [
      { id: 'resolve_item', readSourceConfigId: 'read_cfg_material_item' },
      {
        id: 'resolve_bom',
        readSourceConfigId: 'read_cfg_bom_number',
        input: { fromStep: 'resolve_item', sourceTarget: 'resolved_item_id', toInput: 'key' },
      },
    ],
    ...overrides,
  }
}

function resolverConfig({ id, target, status = 'approved', mode = 'resolver_lookup', operations = ['read'] }) {
  return {
    id,
    status,
    config: {
      version: 1,
      systemId: 'sys_1',
      requiredKind: 'erp:k3-wise-webapi',
      object: 'material',
      mode,
      readPath: '/K3API/Material/GetDetail',
      readMethod: 'POST',
      operations,
      keyField: 'FNumber',
      containerPaths: ['Data'],
      resolverRule: 'exactly_one',
      fieldMap: [{ source: 'Data.FItemID', target }],
    },
  }
}

function approvedRefs(overrides = {}) {
  return new Map([
    ['read_cfg_material_item', resolverConfig({ id: 'read_cfg_material_item', target: 'resolved_item_id', ...(overrides.first || {}) })],
    ['read_cfg_bom_number', resolverConfig({ id: 'read_cfg_bom_number', target: 'resolved_bom_number', ...(overrides.second || {}) })],
  ])
}

function codes(result) {
  return (result.errors || []).map((e) => e.code)
}

{
  const res = validateReadSourceCompositionConfig(chain(), { readConfigsById: approvedRefs() })
  assert.equal(res.valid, true, JSON.stringify(res.errors))
  assert.equal(COMPOSITION_MAX_STEPS, 2)
  assert.ok(Object.isFrozen(res.normalized))
  assert.ok(Object.isFrozen(res.normalized.steps))
  assert.deepEqual(res.normalized.operations, ['read'])
  assert.deepEqual(res.normalized.steps[1].input, { fromStep: 'resolve_item', sourceTarget: 'resolved_item_id', toInput: 'key' })
}

// v1 is deliberately the two-hop composition demand, not arbitrary graphs or recursion.
assert.ok(codes(validateReadSourceCompositionConfig(chain({ steps: [chain().steps[0]] }))).includes('READ_SOURCE_COMPOSITION_STEPS_INVALID'))
assert.ok(codes(validateReadSourceCompositionConfig(chain({ steps: [...chain().steps, { id: 'third', readSourceConfigId: 'read_cfg_3', input: { fromStep: 'resolve_bom', sourceTarget: 'resolved_bom_number', toInput: 'key' } }] }))).includes('READ_SOURCE_COMPOSITION_STEPS_INVALID'))

// Runtime/request-bearing shapes are not allowed in the config.
assert.ok(codes(validateReadSourceCompositionConfig(chain({ endpoint: 'https://evil.example/x' }))).includes('READ_SOURCE_COMPOSITION_UNEXPECTED_FIELD'))
assert.ok(codes(validateReadSourceCompositionConfig(chain({ operations: ['read', 'write'] }))).includes('READ_SOURCE_COMPOSITION_WRITE_CONFIG_REJECTED'))
assert.ok(codes(validateReadSourceCompositionConfig(chain({ savePath: '/K3API/BOM/Save' }))).includes('READ_SOURCE_COMPOSITION_WRITE_CONFIG_REJECTED'))
assert.ok(codes(validateReadSourceCompositionConfig(chain({ steps: [{ ...chain().steps[0], writePath: '/x' }, chain().steps[1]] }))).includes('READ_SOURCE_COMPOSITION_WRITE_CONFIG_REJECTED'))

// Ordered handoff only: first step has no input; second step consumes previous output as named key.
assert.ok(codes(validateReadSourceCompositionConfig(chain({ steps: [{ ...chain().steps[0], input: { fromStep: 'x', sourceTarget: 'y', toInput: 'key' } }, chain().steps[1]] }))).includes('READ_SOURCE_COMPOSITION_HANDOFF_INVALID'))
assert.ok(codes(validateReadSourceCompositionConfig(chain({ steps: [chain().steps[0], { ...chain().steps[1], input: { ...chain().steps[1].input, fromStep: 'not_previous' } }] }))).includes('READ_SOURCE_COMPOSITION_HANDOFF_INVALID'))
assert.ok(codes(validateReadSourceCompositionConfig(chain({ steps: [chain().steps[0], { ...chain().steps[1], input: { ...chain().steps[1].input, toInput: 'rawPayload' } }] }))).includes('READ_SOURCE_COMPOSITION_HANDOFF_INVALID'))

// Referenced configs must be approved resolver_lookup reads with exactly one resolver output target.
assert.ok(codes(validateReadSourceCompositionConfig(chain(), { readConfigsById: approvedRefs({ first: { status: 'draft' } }) })).includes('READ_SOURCE_COMPOSITION_STEP_NOT_APPROVED'))
assert.ok(codes(validateReadSourceCompositionConfig(chain(), { readConfigsById: approvedRefs({ first: { mode: 'list_page' } }) })).includes('READ_SOURCE_COMPOSITION_STEP_MODE_INVALID'))
assert.ok(codes(validateReadSourceCompositionConfig(chain(), { readConfigsById: approvedRefs({ first: { operations: ['read', 'upsert'] } }) })).includes('READ_SOURCE_COMPOSITION_WRITE_CONFIG_REJECTED'))
assert.ok(codes(validateReadSourceCompositionConfig(chain(), { readConfigsById: approvedRefs({ first: { target: 'different_item_id' } }) })).includes('READ_SOURCE_COMPOSITION_HANDOFF_INVALID'))
{
  const refs = approvedRefs()
  refs.get('read_cfg_material_item').config.fieldMap = [
    { source: 'A', target: 'a' },
    { source: 'B', target: 'b' },
  ]
  assert.ok(codes(validateReadSourceCompositionConfig(chain(), { readConfigsById: refs })).includes('READ_SOURCE_COMPOSITION_STEP_OUTPUT_INVALID'))
}

// Values-free errors: submitted refs/targets/host-shaped values are not echoed by the error tuples.
{
  const res = validateReadSourceCompositionConfig(chain({
    name: 'bad name',
    'sk-secret-in-key-name': true,
    steps: [
      { id: 'resolve_item', readSourceConfigId: 'SECRET-CONFIG-ID-001', 'MAT-001': true },
      {
        id: 'resolve_bom',
        readSourceConfigId: 'read_cfg_bom_number',
        input: { fromStep: 'resolve_item', sourceTarget: 'SECRET_TARGET_001', toInput: 'http://evil.example/key', 'evil.example.com': true },
      },
    ],
  }), { readConfigsById: approvedRefs() })
  assert.equal(res.valid, false)
  const text = JSON.stringify(res.errors)
  assert.ok(res.errors.some((e) => e.field === '(unexpected)'), 'root unexpected key must use a fixed marker')
  assert.ok(res.errors.some((e) => e.field === 'steps.0.(unexpected)'), 'step unexpected key must use a fixed marker')
  assert.ok(res.errors.some((e) => e.field === 'steps.1.input.(unexpected)'), 'input unexpected key must use a fixed marker')
  for (const leak of ['SECRET-CONFIG-ID-001', 'SECRET_TARGET_001', 'evil.example', 'sk-secret-in-key-name', 'MAT-001']) {
    assert.ok(!text.includes(leak), `errors must not leak ${leak}: ${text}`)
  }
  for (const e of res.errors) assert.deepEqual(Object.keys(e).sort(), ['code', 'field', 'reason'])
}

console.log('read-source-composition-config.test.cjs OK')
