import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeImportTemplatePayloadExample } from './attendance-import-perf.mjs'

test('sanitizeImportTemplatePayloadExample removes display-only string columns', () => {
  const sanitized = sanitizeImportTemplatePayloadExample({
    source: 'dingtalk',
    mode: 'override',
    columns: ['日期', '工号'],
    requiredFields: ['日期'],
    userMap: {},
  })

  assert.equal(sanitized.source, 'dingtalk')
  assert.equal(sanitized.mode, 'override')
  assert.deepEqual(sanitized.userMap, {})
  assert.equal('columns' in sanitized, false)
  assert.equal('requiredFields' in sanitized, false)
})

test('sanitizeImportTemplatePayloadExample keeps API column objects', () => {
  const sanitized = sanitizeImportTemplatePayloadExample({
    columns: [
      { id: 'workDate', name: 'workDate' },
      { id: 1, alias: 'userId' },
    ],
    requiredFields: ['workDate'],
  })

  assert.deepEqual(sanitized.columns, [
    { id: 'workDate', name: 'workDate' },
    { id: 1, alias: 'userId' },
  ])
  assert.equal('requiredFields' in sanitized, false)
})

test('sanitizeImportTemplatePayloadExample ignores non-object examples', () => {
  assert.deepEqual(sanitizeImportTemplatePayloadExample(null), {})
  assert.deepEqual(sanitizeImportTemplatePayloadExample(['日期']), {})
  assert.deepEqual(sanitizeImportTemplatePayloadExample('template'), {})
})
