'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  firstValue,
  isPlainObject,
  optionalString,
  sameText,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-common.cjs'))

function main() {
  assert.equal(isPlainObject({}), true)
  assert.equal(isPlainObject(Object.create(null)), true)
  assert.equal(isPlainObject([]), false)
  assert.equal(isPlainObject(null), false)
  assert.equal(isPlainObject(new Date()), false)

  assert.equal(optionalString(undefined), null)
  assert.equal(optionalString(null), null)
  assert.equal(optionalString(''), null)
  assert.equal(optionalString('  '), null)
  assert.equal(optionalString('  DRAW-001  '), 'DRAW-001')
  assert.equal(optionalString(2313), '2313')
  assert.equal(optionalString(0), '0')
  assert.equal(optionalString(true), 'true')
  assert.equal(optionalString(false), 'false')
  assert.equal(optionalString({ value: 'DRAW-001' }), null)

  assert.equal(sameText(null, undefined), true)
  assert.equal(sameText('', '  '), true)
  assert.equal(sameText('DRAW-001', ' draw-001 '), true)
  assert.equal(sameText(2313, '2313'), true)
  assert.equal(sameText(false, 'FALSE'), true)
  assert.equal(sameText(null, 'DRAW-001'), false)
  assert.equal(sameText('DRAW-001', 'DRAW-002'), false)

  assert.equal(firstValue({ a: '', b: 0, c: 'later' }, ['a', 'b', 'c']), '0')
  assert.equal(firstValue({ a: { nested: true }, b: false }, ['a', 'b']), 'false')
  assert.equal(firstValue(0, ['toString']), null)
  assert.equal(firstValue(false, ['valueOf']), null)
  assert.equal(firstValue('', ['length']), null)
  assert.equal(firstValue([], ['length']), null)
  assert.equal(firstValue({}, ['missing']), null)

  console.log('stock-preparation-common.test.cjs OK')
}

main()
