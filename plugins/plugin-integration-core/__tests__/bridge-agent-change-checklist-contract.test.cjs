'use strict'

// BA-APPLY-2a — contract/validator for the bridge-agent change checklist. Pure functions; no db,
// no network, no adapter, no route, no Agent. Design-lock
// docs/development/bridge-agent-controlled-apply-design-lock-20260708.md §2 形态 B + §4 hard locks.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  ALLOWED_OPS,
  CHECKLIST_SCHEMA_VERSION,
  MAX_OPERATIONS,
  MAX_FIELD_KEYS_PER_OPERATION,
  BRIDGE_AGENT_CHECKLIST_ERROR_CODES,
  BRIDGE_AGENT_CHECKLIST_ERROR_CODE_SET,
  validateBridgeAgentChangeChecklist,
} = require(path.join(__dirname, '..', 'lib', 'bridge-agent-change-checklist-contract.cjs'))

// Hard-coded here (NOT imported from source) so a mutation widening the source union — e.g. adding
// 'delete_object' — cannot silently satisfy this assertion: the test owns the truth of the whitelist.
const EXPECTED_ALLOWED_OPS = ['add_readonly_object', 'add_readonly_field']

function okChecklist(overrides = {}) {
  return {
    schemaVersion: 1,
    operations: [
      { op: 'add_readonly_object', objectName: 'material', fieldKeys: [] },
      { op: 'add_readonly_field', objectName: 'bom_child', fieldKeys: ['FQty', 'FUnit'] },
    ],
    ...overrides,
  }
}

// Assert every produced error code is a registered member of the coarse-code family, and its `field`
// is a structural path, never a submitted value.
function assertErrorsAreValuesFree(result, forbiddenSubstrings = []) {
  assert.equal(result.valid, false)
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0)
  const serialized = JSON.stringify(result.errors)
  for (const entry of result.errors) {
    assert.ok(
      BRIDGE_AGENT_CHECKLIST_ERROR_CODE_SET.has(entry.code),
      `error code ${entry.code} must be a registered BRIDGE_AGENT_CHECKLIST_* code`,
    )
    assert.equal(typeof entry.field, 'string')
    assert.equal(typeof entry.reason, 'string')
  }
  for (const leak of forbiddenSubstrings) {
    assert.ok(!serialized.includes(leak), `errors must not echo the submitted value: ${leak}`)
  }
}

function testAllowedOpsExactWhitelist() {
  assert.deepEqual([...ALLOWED_OPS], EXPECTED_ALLOWED_OPS, 'ALLOWED_OPS is exactly the two readonly-expand ops')
  // The set must contain NEITHER a write/delete/make-writable op — the exact mutation the gate targets.
  for (const forbidden of ['delete_object', 'make_writable', 'write_object', 'remove_field', 'update_object', 'add_object']) {
    assert.ok(!ALLOWED_OPS.includes(forbidden), `${forbidden} must not be in ALLOWED_OPS`)
  }
  assert.equal(CHECKLIST_SCHEMA_VERSION, 1)
}

function testErrorCodeFamilyRegistered() {
  // Every registered code is BRIDGE_AGENT_CHECKLIST_*-prefixed and the set/array agree.
  assert.equal(BRIDGE_AGENT_CHECKLIST_ERROR_CODE_SET.size, BRIDGE_AGENT_CHECKLIST_ERROR_CODES.length)
  for (const code of BRIDGE_AGENT_CHECKLIST_ERROR_CODES) {
    assert.match(code, /^BRIDGE_AGENT_CHECKLIST_[A-Z_]+$/)
  }
}

function testValidChecklistNormalizes() {
  const result = validateBridgeAgentChangeChecklist(okChecklist())
  assert.equal(result.valid, true)
  assert.deepEqual(JSON.parse(JSON.stringify(result.normalized)), {
    schemaVersion: 1,
    operations: [
      { op: 'add_readonly_object', objectName: 'material', fieldKeys: [] },
      { op: 'add_readonly_field', objectName: 'bom_child', fieldKeys: ['FQty', 'FUnit'] },
    ],
  })
  // Normalized output shape is exactly two keys — no extra fields ride through.
  assert.deepEqual(Object.keys(result.normalized).sort(), ['operations', 'schemaVersion'])
}

function testEmptyOperationsIsValid() {
  // BA-APPLY-1 can emit `operations: []` in its guided-empty state; the contract accepts it.
  const result = validateBridgeAgentChangeChecklist({ schemaVersion: 1, operations: [] })
  assert.equal(result.valid, true)
  assert.deepEqual(JSON.parse(JSON.stringify(result.normalized)), { schemaVersion: 1, operations: [] })
}

// THE hard lock: a write/delete/make-writable op is rejected, never accepted.
function testWriteDeleteOpsRejected() {
  for (const badOp of ['delete_object', 'make_writable', 'write_object', 'remove_field', 'DROP', 'add_writable_object']) {
    const result = validateBridgeAgentChangeChecklist({
      schemaVersion: 1,
      operations: [{ op: badOp, objectName: 'material', fieldKeys: [] }],
    })
    assert.equal(result.valid, false, `op ${badOp} must be rejected`)
    assert.ok(
      result.errors.some((e) => e.code === 'BRIDGE_AGENT_CHECKLIST_OP_NOT_ALLOWED' && e.field === 'operations[0].op'),
      `op ${badOp} yields OP_NOT_ALLOWED at operations[0].op`,
    )
    // the rejected op literal itself is a structural-path field, but never echoed as a value elsewhere
    assertErrorsAreValuesFree(result)
  }
}

function testMissingOrNonStringOpRejected() {
  for (const badOp of [undefined, null, 42, {}, ['add_readonly_object']]) {
    const result = validateBridgeAgentChangeChecklist({
      schemaVersion: 1,
      operations: [{ op: badOp, objectName: 'material', fieldKeys: [] }],
    })
    assert.equal(result.valid, false)
    assert.ok(result.errors.some((e) => e.code === 'BRIDGE_AGENT_CHECKLIST_OP_NOT_ALLOWED'))
  }
}

function testIdentifierGateOnObjectName() {
  // A host/connection-string/secret pasted as an object name fails the identifier gate and is never echoed.
  const attacks = [
    'server=1.2.3.4;uid=sa;pwd=Secret123',
    'https://exfil.example.com/steal',
    'material name',      // whitespace
    'material-1',         // hyphen
    'material.child',     // dot
    'Bearer sk-abc',
    '',                   // empty
    '1material',          // leading digit
    'x'.repeat(65),       // over length
  ]
  for (const objectName of attacks) {
    const result = validateBridgeAgentChangeChecklist({
      schemaVersion: 1,
      operations: [{ op: 'add_readonly_object', objectName, fieldKeys: [] }],
    })
    assert.equal(result.valid, false, `object name ${JSON.stringify(objectName)} must be rejected`)
    assert.ok(result.errors.some((e) => e.code === 'BRIDGE_AGENT_CHECKLIST_OBJECT_NAME_INVALID'))
    assertErrorsAreValuesFree(result, [objectName].filter((s) => s.length > 3))
  }
}

function testIdentifierGateOnFieldKeys() {
  const result = validateBridgeAgentChangeChecklist({
    schemaVersion: 1,
    operations: [{ op: 'add_readonly_field', objectName: 'material', fieldKeys: ['FNumber', 'pwd=Secret123!'] }],
  })
  assert.equal(result.valid, false)
  assert.ok(
    result.errors.some((e) => e.code === 'BRIDGE_AGENT_CHECKLIST_FIELD_KEY_INVALID' && e.field === 'operations[0].fieldKeys[1]'),
  )
  assertErrorsAreValuesFree(result, ['pwd=Secret123!', 'Secret123'])
}

function testOpFieldKeysInvariant() {
  // add_readonly_object must carry no field keys.
  const withKeys = validateBridgeAgentChangeChecklist({
    schemaVersion: 1,
    operations: [{ op: 'add_readonly_object', objectName: 'material', fieldKeys: ['FNumber'] }],
  })
  assert.equal(withKeys.valid, false)
  assert.ok(withKeys.errors.some((e) => e.reason === 'not_allowed_for_add_readonly_object'))

  // add_readonly_field must carry at least one field key.
  const noKeys = validateBridgeAgentChangeChecklist({
    schemaVersion: 1,
    operations: [{ op: 'add_readonly_field', objectName: 'material', fieldKeys: [] }],
  })
  assert.equal(noKeys.valid, false)
  assert.ok(noKeys.errors.some((e) => e.reason === 'required_for_add_readonly_field'))
}

function testSchemaVersionStrict() {
  for (const bad of [undefined, 0, 2, '1', null, 1.5]) {
    const result = validateBridgeAgentChangeChecklist({ schemaVersion: bad, operations: [] })
    assert.equal(result.valid, false, `schemaVersion ${JSON.stringify(bad)} rejected`)
    assert.ok(result.errors.some((e) => e.code === 'BRIDGE_AGENT_CHECKLIST_SCHEMA_VERSION_INVALID'))
  }
}

function testTopLevelUnexpectedKeyCoarsened() {
  const result = validateBridgeAgentChangeChecklist({
    schemaVersion: 1,
    operations: [],
    'https://exfil.example.com/steal?token=abc': true,
  })
  assert.equal(result.valid, false)
  const unexpected = result.errors.find((e) => e.code === 'BRIDGE_AGENT_CHECKLIST_UNEXPECTED_FIELD')
  assert.ok(unexpected)
  assert.equal(unexpected.field, '(unexpected)', 'unexpected top-level key is coarsened to a fixed sentinel')
  assertErrorsAreValuesFree(result, ['exfil.example.com', 'token=abc', 'https://'])
}

function testOperationUnexpectedKeyCoarsened() {
  const result = validateBridgeAgentChangeChecklist({
    schemaVersion: 1,
    operations: [{ op: 'add_readonly_object', objectName: 'material', fieldKeys: [], 'pwd=Secret123': 1 }],
  })
  assert.equal(result.valid, false)
  const unexpected = result.errors.find((e) => e.code === 'BRIDGE_AGENT_CHECKLIST_UNEXPECTED_FIELD')
  assert.ok(unexpected)
  assert.equal(unexpected.field, 'operations[0].(unexpected)')
  assertErrorsAreValuesFree(result, ['pwd=Secret123', 'Secret123'])
}

function testNonObjectAndNonArrayOperations() {
  for (const bad of [null, undefined, 42, 'x', []]) {
    const result = validateBridgeAgentChangeChecklist(bad)
    assert.equal(result.valid, false)
    assert.ok(result.errors.some((e) => e.code === 'BRIDGE_AGENT_CHECKLIST_NOT_OBJECT'), `${JSON.stringify(bad)} → NOT_OBJECT`)
  }
  const badOps = validateBridgeAgentChangeChecklist({ schemaVersion: 1, operations: 'nope' })
  assert.equal(badOps.valid, false)
  assert.ok(badOps.errors.some((e) => e.code === 'BRIDGE_AGENT_CHECKLIST_OPERATIONS_INVALID'))
}

function testClamps() {
  const tooManyOps = {
    schemaVersion: 1,
    operations: Array.from({ length: MAX_OPERATIONS + 1 }, () => ({ op: 'add_readonly_object', objectName: 'material', fieldKeys: [] })),
  }
  const r1 = validateBridgeAgentChangeChecklist(tooManyOps)
  assert.equal(r1.valid, false)
  assert.ok(r1.errors.some((e) => e.reason === 'too_many_operations'))

  const tooManyKeys = {
    schemaVersion: 1,
    operations: [{ op: 'add_readonly_field', objectName: 'material', fieldKeys: Array.from({ length: MAX_FIELD_KEYS_PER_OPERATION + 1 }, (_, i) => `F${i}`) }],
  }
  const r2 = validateBridgeAgentChangeChecklist(tooManyKeys)
  assert.equal(r2.valid, false)
  assert.ok(r2.errors.some((e) => e.reason === 'too_many_field_keys'))
}

// SENTINEL: a host/secret planted anywhere in a submitted checklist is rejected by the identifier
// gate and never appears — as a value — in the errors or in any normalized output.
function testSentinelNoLeak() {
  const SENTINEL = 'server=10.0.0.9;pwd=SENTINEL_S3cr3t;'
  const result = validateBridgeAgentChangeChecklist({
    schemaVersion: 1,
    operations: [
      { op: 'add_readonly_object', objectName: SENTINEL, fieldKeys: [] },
      { op: 'add_readonly_field', objectName: 'material', fieldKeys: ['FNumber', SENTINEL] },
    ],
  })
  assert.equal(result.valid, false)
  const full = JSON.stringify(result)
  assert.ok(!full.includes('SENTINEL_S3cr3t'), 'sentinel secret never rides into the validator output')
  assert.ok(!full.includes('10.0.0.9'), 'sentinel host never rides into the validator output')
}

// Round-trip: BA-APPLY-1's buildImplementationChecklist output must be accepted as-is by this
// contract — the frontend export and the backend gate agree on the exact wire shape.
function testRoundTripWithBaApply1Shape() {
  // Reproduce the exact BA-APPLY-1 output shape (from bridgeAgentConfigCheck.ts) without importing
  // the TS module: a fixed-schema { schemaVersion: 1, operations } where op is derived from field count.
  const ba1Output = {
    schemaVersion: 1,
    operations: [
      { op: 'add_readonly_object', objectName: 'material', fieldKeys: [] },
      { op: 'add_readonly_field', objectName: 'bom', fieldKeys: ['FBOMNumber'] },
    ],
  }
  const result = validateBridgeAgentChangeChecklist(ba1Output)
  assert.equal(result.valid, true, 'BA-APPLY-1 exact output is accepted by the BA-APPLY-2a contract')
  assert.deepEqual(JSON.parse(JSON.stringify(result.normalized)), ba1Output)
}

function testNeverThrows() {
  // Adversarial inputs must resolve to a verdict object, never throw.
  const weird = [
    Object.create(null),
    { schemaVersion: 1, operations: [Object.create(null)] },
    { schemaVersion: 1, operations: [{ op: 'add_readonly_field', objectName: 'x', fieldKeys: [null, 1, {}] }] },
  ]
  for (const input of weird) {
    const result = validateBridgeAgentChangeChecklist(input)
    assert.ok(typeof result === 'object' && typeof result.valid === 'boolean')
  }
}

function main() {
  testAllowedOpsExactWhitelist()
  testErrorCodeFamilyRegistered()
  testValidChecklistNormalizes()
  testEmptyOperationsIsValid()
  testWriteDeleteOpsRejected()
  testMissingOrNonStringOpRejected()
  testIdentifierGateOnObjectName()
  testIdentifierGateOnFieldKeys()
  testOpFieldKeysInvariant()
  testSchemaVersionStrict()
  testTopLevelUnexpectedKeyCoarsened()
  testOperationUnexpectedKeyCoarsened()
  testNonObjectAndNonArrayOperations()
  testClamps()
  testSentinelNoLeak()
  testRoundTripWithBaApply1Shape()
  testNeverThrows()
  console.log('bridge-agent-change-checklist-contract.test.cjs OK')
}

main()
