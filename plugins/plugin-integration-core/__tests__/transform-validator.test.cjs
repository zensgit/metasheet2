'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const {
  TransformError,
  transformRecord,
  transformValue,
} = require(path.join(__dirname, '..', 'lib', 'transform-engine.cjs'))
const {
  validateRecord,
  validateValue,
} = require(path.join(__dirname, '..', 'lib', 'validator.cjs'))

function assertStructuredError(error) {
  assert.equal(typeof error.field === 'string' || error.field === null, true)
  assert.equal(typeof error.code, 'string')
  assert.equal(typeof error.message, 'string')
  assert.equal(typeof error.rule, 'string')
  assert.equal(typeof error.details, 'object')
}

async function main() {
  // --- 1. Built-in transforms cover string, number, date, defaults, concat, map
  const transformed = transformRecord({
    sku: ' ab-1 ',
    quantity: '1,234.50',
    effectiveDate: '2026-04-24',
    first: 'PLM',
    second: 'ERP',
    status: 'A',
    missingName: '',
    nested: { code: ' xYz ' },
    childCode: ' mat-child-001 ',
    childQty: '2.5',
  }, [
    { sourceField: 'sku', targetField: 'sku', transform: ['trim', 'upper'] },
    { sourceField: 'quantity', targetField: 'quantity', transform: 'toNumber' },
    { sourceField: 'effectiveDate', targetField: 'effectiveDate', transform: { fn: 'toDate', format: 'date' } },
    { sourceField: 'missingName', targetField: 'name', transform: { fn: 'defaultValue', value: 'UNKNOWN' } },
    { sourceField: 'first', targetField: 'syncKey', transform: { fn: 'concat', fields: ['second'], values: ['DONE'], separator: '|' } },
    { sourceField: 'status', targetField: 'status', transform: { fn: 'dictMap', map: { A: 'active' }, defaultValue: 'unknown' } },
    { sourceField: 'nested.code', targetField: 'nested.code', transform: ['trim', 'lower'] },
    { sourceField: 'childCode', targetField: 'FChildItems[].FItemNumber', transform: ['trim', 'upper'] },
    { sourceField: 'childQty', targetField: 'FChildItems[].FQty', transform: 'toNumber' },
  ])

  assert.equal(transformed.ok, true)
  assert.deepEqual(transformed.errors, [])
  assert.deepEqual(transformed.value, {
    sku: 'AB-1',
    quantity: 1234.5,
    effectiveDate: '2026-04-24',
    name: 'UNKNOWN',
    syncKey: 'PLM|ERP|DONE',
    status: 'active',
    nested: { code: 'xyz' },
    FChildItems: [
      { FItemNumber: 'MAT-CHILD-001', FQty: 2.5 },
    ],
  })

  // --- 2. Transform failures are typed and record-level errors are structured
  assert.throws(() => transformValue('not-a-number', 'toNumber'), TransformError)

  let userJsRan = false
  const blocked = transformRecord({ value: 'abc' }, [
    {
      sourceField: 'value',
      targetField: 'unsafe',
      transform: () => {
        userJsRan = true
        return 'should-not-run'
      },
    },
    {
      sourceField: 'value',
      targetField: 'script',
      transform: { fn: 'javascript', code: 'return process.env' },
    },
  ])

  assert.equal(userJsRan, false, 'transform functions are rejected, not executed')
  assert.equal(blocked.ok, false)
  assert.deepEqual(blocked.errors.map((error) => error.code), ['TRANSFORM_FAILED', 'TRANSFORM_FAILED'])
  assert.match(blocked.errors[1].message, /unsupported transform: javascript/)

  const polluted = transformRecord({ value: 'owned' }, [
    { sourceField: 'value', targetField: '__proto__.polluted', transform: 'trim' },
    { sourceField: 'value', targetField: 'constructor.prototype.polluted', transform: 'trim' },
  ])
  assert.equal(polluted.ok, false)
  assert.deepEqual(polluted.errors.map((error) => error.code), ['TRANSFORM_FAILED', 'TRANSFORM_FAILED'])
  assert.equal({}.polluted, undefined, 'unsafe target paths cannot pollute Object.prototype')

  // --- 3. Validator accepts required, pattern, enum, min, and max
  const valid = validateRecord(transformed.value, [
    { targetField: 'sku', validation: [{ type: 'required' }, { type: 'pattern', params: { regex: '^[A-Z]+-\\d$' } }] },
    { targetField: 'status', validation: { type: 'enum', params: { values: ['active', 'inactive'] } } },
    { targetField: 'quantity', validation: [{ type: 'min', value: 1 }, { type: 'max', value: 2000 }] },
  ])

  assert.equal(valid.ok, true)
  assert.equal(valid.valid, true)
  assert.deepEqual(valid.errors, [])

  // --- 4. Business validation failures return structured errors, not throws
  const invalid = validateRecord({
    sku: ' ',
    code: 'bad-code',
    status: 'archived',
    low: 2,
    high: 20,
  }, [
    { targetField: 'sku', validation: { type: 'required' } },
    { targetField: 'code', validation: { type: 'pattern', params: { regex: '^MAT-\\d+$' } } },
    { targetField: 'status', validation: { type: 'enum', params: { values: ['active', 'inactive'] } } },
    { targetField: 'low', validation: { type: 'min', params: { value: 5 } } },
    { targetField: 'high', validation: { type: 'max', params: { value: 10 } } },
  ])

  assert.equal(invalid.ok, false)
  assert.deepEqual(invalid.errors.map((error) => error.code), ['REQUIRED', 'PATTERN', 'ENUM', 'MIN', 'MAX'])
  invalid.errors.forEach(assertStructuredError)

  // --- 5. Invalid validation config is also reported structurally
  const invalidPattern = validateValue('abc', [{ type: 'pattern', params: { regex: '[' } }], 'badPattern')
  assert.equal(invalidPattern.length, 1)
  assert.equal(invalidPattern[0].code, 'INVALID_RULE')
  assertStructuredError(invalidPattern[0])

  const unsupported = validateValue('abc', [{ type: 'custom', code: 'return true' }], 'custom')
  assert.equal(unsupported.length, 1)
  assert.equal(unsupported[0].code, 'UNSUPPORTED_RULE')
  assertStructuredError(unsupported[0])

  console.log('[pass] transform-validator: transform engine + validator tests passed')
}

main().catch((err) => {
  console.error('[fail] transform-validator FAILED')
  console.error(err)
  process.exit(1)
})
