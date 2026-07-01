'use strict'

// External-API read self-service S1 — config model + validator (validation-only; no persistence/route/
// runtime/write). Adversarially tests the SSRF endpoint guard, per-mode required fields, read-only +
// backend-reference-only credentials, and values-free errors.

const assert = require('node:assert/strict')
const path = require('node:path')
const {
  READ_SOURCE_MODES,
  isSafeRelativeReadPath,
  validateReadSourceConfig,
} = require(path.join(__dirname, '..', 'lib', 'read-source-config.cjs'))

function baseValid(mode) {
  const cfg = {
    version: 1,
    systemId: 'sys_1',
    requiredKind: 'erp:k3-wise-webapi',
    object: 'material-bom',
    mode,
    readPath: '/K3API/BOM/GetDetail',
    readMethod: 'POST',
    operations: ['read'],
  }
  if (mode === 'single_record') { cfg.keyField = 'FNumber'; cfg.keyEncoding = 'structured_json_field'; cfg.containerPaths = ['Data'] }
  if (mode === 'list_page') { cfg.containerPaths = ['Data.Data', 'Data.DATA'] }
  if (mode === 'detail_with_lines') { cfg.keyField = 'FBillNo'; cfg.headerContainerPaths = ['Data.Page1']; cfg.lineContainerPaths = ['Data.Page2'] }
  if (mode === 'resolver_lookup') { cfg.keyField = 'FMaterialId'; cfg.containerPaths = ['Data.Rows']; cfg.multiplicityRuleField = 'FIsCurrent' }
  return cfg
}
function codes(result) { return (result.errors || []).map((e) => e.code) }

// --- 1. Valid config for each of the four modes → normalized, read-only, frozen ---
for (const mode of READ_SOURCE_MODES) {
  const res = validateReadSourceConfig(baseValid(mode))
  assert.equal(res.valid, true, `${mode} valid config should pass: ${JSON.stringify(res.errors)}`)
  assert.deepEqual(res.normalized.operations, ['read'])
  assert.equal(res.normalized.mode, mode)
  assert.equal(res.normalized.readPath, '/K3API/BOM/GetDetail')
  assert.ok(Object.isFrozen(res.normalized), 'normalized config is frozen')
}
// readPath without a leading slash is normalized to have one
assert.equal(validateReadSourceConfig({ ...baseValid('list_page'), readPath: 'K3API/x' }).normalized.readPath, '/K3API/x')

// --- 2. THE crown-jewel: SSRF endpoint nasty-set (all reject) + safe relatives (accept) ---
const mustReject = [
  '//evil.com/x', 'http://evil.com', 'https://evil.com', 'HTTP://evil.com',
  'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x',
  '\\\\evil', '/\\evil', 'foo\\bar',
  '/../../etc/passwd', '/a/b/../../../c', '..',
  '/%2f%2fevil.com', '/%2F%2Fevil', '/%5cevil', '/x%5Cy',
  // Encoded-dot traversal (P1): Node's URL layer normalizes these post-guard — `/%2e%2e/admin`→`/admin`,
  // `/a/%2e%2e/b`→`/b`, `/%2E%2E/%2E%2E/etc`→`/etc` — so the guard must reject them (S1 rejects ALL `%`).
  '/%2e%2e/admin', '/a/%2e%2e/b', '/%2E%2E/%2E%2E/etc', '/%2e/admin',
  '/foo%20bar', '/x%00y',                                 // any other percent-encoding is rejected too
  '', '   ', '/foo bar', '/foo\tbar',
]
for (const p of mustReject) {
  assert.equal(isSafeRelativeReadPath(p), false, `endpoint guard must REJECT: ${JSON.stringify(p)}`)
  assert.deepEqual(codes(validateReadSourceConfig({ ...baseValid('list_page'), readPath: p })).filter((c) => c === 'READ_SOURCE_ENDPOINT_NOT_RELATIVE'), ['READ_SOURCE_ENDPOINT_NOT_RELATIVE'], `config with endpoint ${JSON.stringify(p)} must flag ENDPOINT_NOT_RELATIVE`)
}
for (const p of ['/K3API/BOM/GetDetail', '/api/foo-bar_baz.v2', 'relative/becomes/absolute', '/a/b.c/d']) {
  assert.equal(isSafeRelativeReadPath(p), true, `endpoint guard must ACCEPT safe relative: ${JSON.stringify(p)}`)
}

// --- 3. Read-only line (fail-closed) ---
assert.ok(codes(validateReadSourceConfig({ ...baseValid('list_page'), savePath: '/K3API/BOM/Save' })).includes('READ_SOURCE_WRITE_CONFIG_REJECTED'))
assert.ok(codes(validateReadSourceConfig({ ...baseValid('list_page'), operations: ['read', 'upsert'] })).includes('READ_SOURCE_WRITE_CONFIG_REJECTED'))
assert.ok(codes(validateReadSourceConfig({ ...baseValid('list_page'), operations: ['upsert'] })).includes('READ_SOURCE_WRITE_CONFIG_REJECTED'))

// --- 4. Backend-reference-only credentials (no inline key, no secret-shaped value) ---
assert.ok(codes(validateReadSourceConfig({ ...baseValid('list_page'), password: 'hunter2' })).includes('READ_SOURCE_CREDENTIAL_INLINE_REJECTED'))
assert.ok(codes(validateReadSourceConfig({ ...baseValid('list_page'), bearerToken: 'x' })).includes('READ_SOURCE_CREDENTIAL_INLINE_REJECTED'))

// --- 5. Enum / format guardrails ---
assert.ok(codes(validateReadSourceConfig({ ...baseValid('list_page'), mode: 'arbitrary_sql' })).includes('READ_SOURCE_MODE_NOT_ALLOWED'))
assert.ok(codes(validateReadSourceConfig({ ...baseValid('list_page'), readMethod: 'DELETE' })).includes('READ_SOURCE_METHOD_NOT_ALLOWED'))
assert.ok(codes(validateReadSourceConfig({ ...baseValid('list_page'), containerPaths: ['../etc'] })).includes('READ_SOURCE_CONTAINER_PATH_INVALID'))
assert.ok(codes(validateReadSourceConfig({ ...baseValid('list_page'), containerPaths: ['Data[0].x'] })).includes('READ_SOURCE_CONTAINER_PATH_INVALID'))
assert.ok(codes(validateReadSourceConfig({ ...baseValid('single_record'), keyEncoding: 'raw_sql' })).includes('READ_SOURCE_KEY_ENCODING_INVALID'))
assert.ok(codes(validateReadSourceConfig({ ...baseValid('list_page'), fieldMap: [{ source: 'a', target: 'b', value: 'SECRET' }] })).includes('READ_SOURCE_FIELD_MAP_INVALID'))
// fieldMap is config metadata (P2): source = field/container path, target = bounded id — NOT values / free text.
assert.equal(validateReadSourceConfig({ ...baseValid('list_page'), fieldMap: [{ source: 'FNumber', target: 'material_no' }, { source: 'Data.FQty', target: 'qty' }] }).valid, true, 'a well-shaped fieldMap must pass')
for (const bad of [
  [{ source: 'MAT-001', target: 'material_no' }],   // source is a VALUE (hyphen), not a field path
  [{ source: '../../x', target: 'material_no' }],    // source path-traversal shaped
  [{ source: 'Data[0].x', target: 'material_no' }],  // source has brackets/wildcard
  [{ source: 'FNumber', target: 'foo bar' }],        // target has whitespace
  [{ source: 'FNumber', target: '../evil' }],        // target path-shaped
  [{ source: '', target: 'x' }],                     // empty source
]) {
  assert.ok(codes(validateReadSourceConfig({ ...baseValid('list_page'), fieldMap: bad })).includes('READ_SOURCE_FIELD_MAP_INVALID'), `fieldMap must REJECT ${JSON.stringify(bad)}`)
}
// fieldMap leak-bait: a value-shaped source is rejected AND never echoed in the (values-free) errors
{
  const res = validateReadSourceConfig({ ...baseValid('list_page'), fieldMap: [{ source: 'FIELDMAP-VALUE-LEAK-001', target: 'x' }] })
  assert.equal(res.valid, false)
  assert.ok(!JSON.stringify(res.errors).includes('FIELDMAP-VALUE-LEAK'), 'fieldMap errors must not echo the offending value')
}
assert.ok(codes(validateReadSourceConfig({ ...baseValid('list_page'), version: 0 })).includes('READ_SOURCE_VERSION_INVALID'))
assert.ok(codes(validateReadSourceConfig({ ...baseValid('list_page'), systemId: 'has space' })).includes('READ_SOURCE_SYSTEM_REF_INVALID'))
assert.ok(codes(validateReadSourceConfig({ ...baseValid('list_page'), nefariousKey: 'x' })).includes('READ_SOURCE_UNEXPECTED_FIELD'))

// --- 6. Per-mode required fields ---
{
  const cfg = baseValid('detail_with_lines'); delete cfg.lineContainerPaths
  assert.ok(codes(validateReadSourceConfig(cfg)).includes('READ_SOURCE_MODE_FIELD_REQUIRED'))
}
{
  const cfg = baseValid('resolver_lookup'); delete cfg.multiplicityRuleField
  assert.ok(codes(validateReadSourceConfig(cfg)).includes('READ_SOURCE_MODE_FIELD_REQUIRED'))
}
assert.deepEqual(validateReadSourceConfig({ valid: false }).errors[0].code, 'READ_SOURCE_UNEXPECTED_FIELD')
assert.equal(validateReadSourceConfig(null).errors[0].code, 'READ_SOURCE_CONFIG_NOT_OBJECT')

// --- 7. Values-free errors (leak-bait): a secret-shaped value + a hostile endpoint must NOT appear in errors ---
const leaky = {
  ...baseValid('list_page'),
  readPath: 'https://EVIL-HOST-LEAK.example/steal',
  bearerToken: 'Bearer SECRET-TOKEN-LEAK-eyJhbGciOiJIUzI1NiJ9.payload.signature',
}
const leakyRes = validateReadSourceConfig(leaky)
assert.equal(leakyRes.valid, false)
const errStr = JSON.stringify(leakyRes.errors)
for (const leak of ['EVIL-HOST-LEAK', 'SECRET-TOKEN-LEAK', 'eyJhbGciOiJIUzI1NiJ9', 'steal', 'signature']) {
  assert.ok(!errStr.includes(leak), `errors must not leak ${leak}: ${errStr}`)
}
// error shape is {code, field, reason} only
for (const e of leakyRes.errors) {
  assert.deepEqual(Object.keys(e).sort(), ['code', 'field', 'reason'])
}

console.log('read-source-config.test.cjs OK')
