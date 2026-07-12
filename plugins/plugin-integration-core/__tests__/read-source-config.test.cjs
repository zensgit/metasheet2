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
  if (mode === 'resolver_lookup') { cfg.keyField = 'FMaterialId'; cfg.containerPaths = ['Data.Rows']; cfg.resolverRule = 'exactly_one'; cfg.fieldMap = [{ source: 'FItemID', target: 'item_id' }] }
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
// A duplicate TARGET is rejected: the mapping is a sequence of writes, so two entries on the same column
// are not "try both spellings, whichever resolves" — the last entry wins, and an entry that resolves nowhere
// writes null OVER a real value the earlier one already read. That column then reads as empty on every row
// while the source had a value all along. Reject it where it is written.
{
  const duplicated = validateReadSourceConfig({
    ...baseValid('list_page'),
    fieldMap: [
      { source: 'quantity', target: 'designQty' },
      { source: 'FQty', target: 'designQty' },
    ],
  })
  assert.equal(duplicated.valid, false, 'a fieldMap writing the same target twice must be rejected')
  assert.ok(duplicated.errors.some((e) => e.code === 'READ_SOURCE_FIELD_MAP_INVALID' && e.reason === 'duplicate_target'))
  // Same SOURCE feeding two different targets is fine — that is a fan-out, not a lossy write.
  assert.equal(validateReadSourceConfig({
    ...baseValid('list_page'),
    fieldMap: [
      { source: 'childCode', target: 'pathKey' },
      { source: 'childCode', target: 'childDrawingNo' },
    ],
  }).valid, true, 'one source may feed several targets')
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

// --- 6b. R0 resolver_lookup contract (rule-specific fields, values-free) ---
const resolver = (over) => ({ ...baseValid('resolver_lookup'), ...over })
// pre-R0 fail-closed: an old resolver row (no resolverRule, multiplicityRuleField-only) is INVALID now.
{
  const old = baseValid('resolver_lookup'); delete old.resolverRule; delete old.fieldMap; old.multiplicityRuleField = 'FIsCurrent'
  const c = codes(validateReadSourceConfig(old))
  assert.ok(c.includes('READ_SOURCE_MODE_FIELD_REQUIRED'), 'pre-R0 resolver without resolverRule is fail-closed')
}
// exactly_one: valid with no rule fields; INVALID if a rule-specific field is present.
assert.equal(validateReadSourceConfig(resolver({ resolverRule: 'exactly_one' })).valid, true)
assert.ok(codes(validateReadSourceConfig(resolver({ resolverRule: 'exactly_one', multiplicityRuleField: 'X' }))).includes('READ_SOURCE_RESOLVER_RULE_INVALID'))
assert.ok(codes(validateReadSourceConfig(resolver({ resolverRule: 'exactly_one', resolverSortDirection: 'asc' }))).includes('READ_SOURCE_RESOLVER_RULE_INVALID'))
// first_when_sorted: needs multiplicityRuleField(sort) + resolverSortDirection; discriminator forbidden.
assert.equal(validateReadSourceConfig(resolver({ resolverRule: 'first_when_sorted', multiplicityRuleField: 'FDate', resolverSortDirection: 'desc' })).valid, true)
assert.ok(codes(validateReadSourceConfig(resolver({ resolverRule: 'first_when_sorted', multiplicityRuleField: 'FDate' }))).includes('READ_SOURCE_RESOLVER_RULE_INVALID'))
assert.ok(codes(validateReadSourceConfig(resolver({ resolverRule: 'first_when_sorted', resolverSortDirection: 'desc' }))).includes('READ_SOURCE_RESOLVER_RULE_INVALID'))
assert.ok(codes(validateReadSourceConfig(resolver({ resolverRule: 'first_when_sorted', multiplicityRuleField: 'FDate', resolverSortDirection: 'sideways' }))).includes('READ_SOURCE_RESOLVER_RULE_INVALID'))
// field_equals: needs multiplicityRuleField(discriminator) + resolverDiscriminatorValue; sort forbidden.
assert.equal(validateReadSourceConfig(resolver({ resolverRule: 'field_equals', multiplicityRuleField: 'FIsCurrent', resolverDiscriminatorValue: 'true' })).valid, true)
assert.ok(codes(validateReadSourceConfig(resolver({ resolverRule: 'field_equals', multiplicityRuleField: 'FIsCurrent' }))).includes('READ_SOURCE_RESOLVER_RULE_INVALID'))
assert.ok(codes(validateReadSourceConfig(resolver({ resolverRule: 'field_equals', resolverDiscriminatorValue: 'true' }))).includes('READ_SOURCE_RESOLVER_RULE_INVALID'))
// resolverRule not in the set → RULE_NOT_SUPPORTED.
assert.ok(codes(validateReadSourceConfig(resolver({ resolverRule: 'take_the_first' }))).includes('READ_SOURCE_RESOLVER_RULE_NOT_SUPPORTED'))
// discriminator value must be a bounded enum-like token, never a free/secret/host-shaped value.
assert.ok(codes(validateReadSourceConfig(resolver({ resolverRule: 'field_equals', multiplicityRuleField: 'FIsCurrent', resolverDiscriminatorValue: 'https://evil/x?a=b c' }))).includes('READ_SOURCE_RESOLVER_RULE_INVALID'))
// fieldMap must be exactly ONE resolver output target.
assert.ok(codes(validateReadSourceConfig(resolver({ resolverRule: 'exactly_one', fieldMap: [{ source: 'A', target: 'a' }, { source: 'B', target: 'b' }] }))).includes('READ_SOURCE_RESOLVER_RULE_INVALID'))
assert.ok(codes(validateReadSourceConfig(resolver({ resolverRule: 'exactly_one', fieldMap: undefined }))).includes('READ_SOURCE_RESOLVER_RULE_INVALID'))
// resolver-only keys are rejected on a NON-resolver mode.
assert.ok(codes(validateReadSourceConfig({ ...baseValid('list_page'), resolverRule: 'exactly_one' })).includes('READ_SOURCE_RESOLVER_KEY_NOT_ALLOWED'))
// normalized output carries the resolver fields (field_equals sample).
{
  const n = validateReadSourceConfig(resolver({ resolverRule: 'field_equals', multiplicityRuleField: 'FIsCurrent', resolverDiscriminatorValue: 'current' })).normalized
  assert.equal(n.resolverRule, 'field_equals'); assert.equal(n.multiplicityRuleField, 'FIsCurrent'); assert.equal(n.resolverDiscriminatorValue, 'current')
  assert.ok(Object.isFrozen(n))
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
