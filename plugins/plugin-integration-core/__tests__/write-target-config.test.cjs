'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  WRITE_TARGET_OPERATIONS,
  WRITE_TARGET_METHODS,
  WRITE_TARGET_KEY_ENCODINGS,
  validateWriteTargetConfig,
} = require(path.join(__dirname, '..', 'lib', 'write-target-config.cjs'))

function validConfig(overrides = {}) {
  return {
    version: 1,
    systemId: 'k3_prod',
    sandboxSystemId: 'k3_sandbox',
    requiredKind: 'erp:k3-wise-webapi',
    object: 'material',
    operation: 'upsert',
    writePath: '/K3API/Material/Save',
    writeMethod: 'POST',
    operations: ['write'],
    keyField: 'FNumber',
    keyEncoding: 'structured_json_field',
    fieldMap: [{ source: 'cleansing_name', target: 'Data.FName' }],
    ...overrides,
  }
}

function codes(result) {
  return (result.errors || []).map((error) => error.code)
}

function reasons(result) {
  return (result.errors || []).map((error) => error.reason)
}

assert.deepEqual([...WRITE_TARGET_OPERATIONS], ['upsert', 'save_only'])
assert.deepEqual([...WRITE_TARGET_METHODS], ['POST', 'PUT', 'PATCH'])
assert.deepEqual([...WRITE_TARGET_KEY_ENCODINGS], ['structured_json_field', 'filter_expression', 'numeric_id'])

{
  const result = validateWriteTargetConfig(validConfig({ writePath: 'K3API/Material/Save' }))
  assert.equal(result.valid, true)
  assert.equal(result.normalized.writePath, '/K3API/Material/Save')
  assert.deepEqual(result.normalized.operations, ['write'])
  assert.deepEqual(result.normalized.fieldMap, [{ source: 'cleansing_name', target: 'Data.FName' }])
  assert.ok(Object.isFrozen(result.normalized))
}

for (const pathValue of [
  'https://evil.example.com/x',
  '//evil.example.com/x',
  '/%2e%2e/admin',
  '/K3API/%20/Save',
  '/K3API/../admin',
  '/K3API/Material/Save?x=1',
  '/K3API\\Material\\Save',
]) {
  const result = validateWriteTargetConfig(validConfig({ writePath: pathValue }))
  assert.equal(result.valid, false, `writePath ${JSON.stringify(pathValue)} should be rejected`)
  assert.ok(codes(result).includes('WRITE_TARGET_ENDPOINT_NOT_RELATIVE'))
  assert.ok(!JSON.stringify(result.errors).includes('evil.example.com'), 'error evidence must not echo host/path values')
}

for (const bad of [
  { operation: 'delete' },
  { writeMethod: 'DELETE' },
  { operations: ['read'] },
  { operations: ['write', 'delete'] },
  { deletePath: '/K3API/Delete' },
  { submitPath: '/K3API/Submit' },
  { auditPath: '/K3API/Audit' },
  { rawSql: 'DELETE FROM t' },
  { body: { FNumber: 'MAT-001' } },
  { headers: { Authorization: 'Bearer secret' } },
]) {
  const result = validateWriteTargetConfig(validConfig(bad))
  assert.equal(result.valid, false, `bad write shape rejected: ${JSON.stringify(bad)}`)
}
assert.ok(codes(validateWriteTargetConfig(validConfig({ deletePath: '/K3API/Delete' }))).includes('WRITE_TARGET_DELETE_REJECTED'))
assert.ok(codes(validateWriteTargetConfig(validConfig({ rawSql: 'DELETE FROM t' }))).includes('WRITE_TARGET_RAW_WRITE_CONFIG_REJECTED'))
assert.ok(codes(validateWriteTargetConfig(validConfig({ operations: ['read'] }))).includes('WRITE_TARGET_OPERATION_NOT_ALLOWED'))

{
  const sameSandbox = validateWriteTargetConfig(validConfig({ sandboxSystemId: 'k3_prod' }))
  assert.ok(codes(sameSandbox).includes('WRITE_TARGET_SANDBOX_REQUIRED'))
  assert.ok(reasons(sameSandbox).includes('must_differ_from_production'))
}

{
  const result = validateWriteTargetConfig(validConfig({
    requiredKind: 'postgres://user:pw@host/db',
  }))
  assert.equal(result.valid, false)
  assert.ok(codes(result).includes('WRITE_TARGET_KIND_REQUIRED'))
  const text = JSON.stringify(result.errors)
  for (const leak of ['postgres://user:pw@host/db', 'user:pw', 'host']) {
    assert.ok(!text.includes(leak), `requiredKind errors must not echo ${leak}`)
  }
}

{
  const result = validateWriteTargetConfig(validConfig({ keyEncoding: 'raw_filter_body' }))
  assert.equal(result.valid, false)
  assert.ok(codes(result).includes('WRITE_TARGET_KEY_ENCODING_INVALID'))
}

for (const secret of [
  { password: 'hunter2' },
  { bearerToken: 'x' },
  { fieldMap: [{ source: 'Bearer abc.def.ghi', target: 'Data.FName' }] },
  { fieldMap: [{ source: 'cleansing_name', target: 'Data.FName', value: 'MAT-001' }] },
]) {
  const result = validateWriteTargetConfig(validConfig(secret))
  assert.equal(result.valid, false)
  const text = JSON.stringify(result.errors)
  assert.ok(!text.includes('hunter2'))
  assert.ok(!text.includes('abc.def.ghi'))
  assert.ok(!text.includes('MAT-001'))
}
assert.ok(codes(validateWriteTargetConfig(validConfig({ password: 'hunter2' }))).includes('WRITE_TARGET_CREDENTIAL_INLINE_REJECTED'))

{
  const result = validateWriteTargetConfig(validConfig({ 'sk-secret-in-key-name': 'ignored' }))
  assert.ok(codes(result).includes('WRITE_TARGET_UNEXPECTED_FIELD'))
  const text = JSON.stringify(result.errors)
  assert.ok(!text.includes('sk-secret-in-key-name'), 'unexpected-field errors must not echo arbitrary key names')
}

for (const badFieldMap of [
  [],
  [{ source: 'MAT-001', target: 'Data.FName' }],
  [{ source: '../../x', target: 'Data.FName' }],
  [{ source: 'cleansing_name', target: '../Data' }],
  [{ source: 'cleansing name', target: 'Data.FName' }],
]) {
  const result = validateWriteTargetConfig(validConfig({ fieldMap: badFieldMap }))
  assert.ok(codes(result).includes('WRITE_TARGET_FIELD_MAP_INVALID'), `fieldMap rejected: ${JSON.stringify(badFieldMap)}`)
}

for (const missing of ['systemId', 'sandboxSystemId', 'requiredKind', 'object', 'operation', 'writePath', 'writeMethod', 'operations', 'keyField', 'fieldMap']) {
  const cfg = validConfig()
  delete cfg[missing]
  const result = validateWriteTargetConfig(cfg)
  assert.equal(result.valid, false, `${missing} must be required`)
}

assert.ok(codes(validateWriteTargetConfig({ valid: false })).includes('WRITE_TARGET_UNEXPECTED_FIELD'))
assert.equal(validateWriteTargetConfig(null).errors[0].code, 'WRITE_TARGET_CONFIG_NOT_OBJECT')

console.log('write-target-config.test.cjs OK')
