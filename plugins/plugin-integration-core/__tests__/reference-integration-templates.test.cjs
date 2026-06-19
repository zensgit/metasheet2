'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  listReferenceIntegrationTemplates,
  assertReferenceTemplateValuesFree,
  ReferenceIntegrationTemplateError,
} = require(path.join(__dirname, '..', 'lib', 'reference-integration-templates.cjs'))
const { __internals } = require(path.join(__dirname, '..', 'lib', 'integration-templates.cjs'))

async function main() {
  // 1. catalog is non-empty + values-free (no scope / secret / content keys)
  const list = listReferenceIntegrationTemplates()
  assert.ok(list.length >= 1, 'catalog non-empty')
  for (const def of list) {
    assert.ok(def.refId && def.name && def.targetKind, `def has refId/name/targetKind (${def.refId})`)
    for (const k of ['tenantId', 'workspaceId', 'id', 'credentials', 'credentialsEncrypted', 'sheetId', 'rows', 'records', 'data', 'config']) {
      assert.ok(!(k in def), `def ${def.refId} must not carry "${k}"`)
    }
  }

  // 2. multitable-first: at least one reference targets metasheet:multitable
  assert.ok(list.some((d) => d.targetKind === 'metasheet:multitable'), 'at least one multitable reference')

  // 3. each def is a VALID template input once the operator adds scope (so POST /templates upsert works)
  for (const def of list) {
    const normalized = __internals.normalizeTemplateInput({ ...def, tenantId: 't1', workspaceId: 'w1' })
    assert.equal(normalized.targetKind, def.targetKind, `${def.refId} targetKind round-trips`)
    assert.equal(normalized.name, def.name, `${def.refId} name round-trips`)
    assert.deepEqual(normalized.keyFields, def.keyFields, `${def.refId} keyFields round-trip`)
    // version is system-managed (S3-1b): normalizer must NOT default it here
    assert.equal(normalized.version, undefined, `${def.refId} carries no version (system-managed)`)
  }

  // 4. validator is non-vacuous: rejects a conn-string (the real leak vector) AND a content key
  assert.throws(
    () => assertReferenceTemplateValuesFree({ refId: 'x', sourceObject: 'Server=db;Database=x;User Id=sa;Password=Hunter2;' }, 'x'),
    (e) => e instanceof ReferenceIntegrationTemplateError && e.code === 'INTEGRATION_REFERENCE_TEMPLATE_INVALID',
    'rejects a secret-shaped (conn-string) value',
  )
  assert.throws(
    () => assertReferenceTemplateValuesFree({ refId: 'y', rows: [{ a: 1 }] }, 'y'),
    /must not carry a "rows"/,
    'rejects a forbidden content key',
  )

  // 5. a K3 reference (if present) is flagged runtime-write S2-gated so discovery surfaces the gate
  const k3 = list.find((d) => d.sourceKind === 'erp:k3-wise-webapi')
  if (k3) assert.equal(k3.runtimeWriteGate, 's2-k3-webapi', 'K3 reference flags runtime write as S2-gated')

  // 6. returned list is a deep copy — mutating it must not corrupt the frozen catalog
  list[0].name = 'MUTATED'
  list[0].keyFields.push('__injected__')
  const fresh = listReferenceIntegrationTemplates()
  assert.notEqual(fresh[0].name, 'MUTATED', 'catalog name not mutated by a caller')
  assert.ok(!fresh[0].keyFields.includes('__injected__'), 'catalog keyFields not mutated by a caller')

  console.log('✓ reference-integration-templates: values-free + valid-input + non-vacuous validator + deep-copy tests passed')
}

main().catch((e) => {
  console.error('✗ reference-integration-templates FAILED')
  console.error(e)
  process.exit(1)
})
