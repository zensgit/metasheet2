'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const {
  createIntegrationTemplateRegistry,
  TemplateNotFoundError,
  TemplateVersionConflictError,
  __internals,
} = require(path.join(__dirname, '..', 'lib', 'integration-templates.cjs'))

function createFakeDb() {
  const rows = []
  const calls = []
  const matches = (row, where) => Object.entries(where).every(([k, v]) => (row[k] ?? null) === (v ?? null))
  return {
    rows,
    calls,
    async selectOne(table, where) {
      calls.push(['selectOne', table, { ...where }])
      return rows.find((r) => r._table === table && matches(r, where)) || null
    },
    async insertOne(table, row) {
      calls.push(['insertOne', table, { ...row }])
      const rec = { ...row, _table: table, created_at: 'now', updated_at: 'now' }
      rows.push(rec)
      return [rec]
    },
    async updateRow(table, set, where) {
      calls.push(['updateRow', table, { ...set }, { ...where }])
      const rec = rows.find((r) => r._table === table && matches(r, where))
      if (rec) Object.assign(rec, set)
      return rec ? [rec] : []
    },
    async select(table, options = {}) {
      calls.push(['select', table, JSON.parse(JSON.stringify(options))])
      return rows.filter((r) => r._table === table && matches(r, options.where || {}))
    },
    async deleteRows(table, where) {
      calls.push(['deleteRows', table, { ...where }])
      const before = rows.length
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (rows[i]._table === table && matches(rows[i], where)) rows.splice(i, 1)
      }
      return before - rows.length
    },
  }
}

async function main() {
  // --- 1. normalizer validation ---
  assert.throws(() => __internals.normalizeTemplateInput({ tenantId: 't', name: 'x' }), /targetKind is required/, 'targetKind required')
  assert.throws(() => __internals.normalizeTemplateInput({ tenantId: 't', targetKind: 'k' }), /name is required/, 'name required')
  assert.throws(() => __internals.normalizeTemplateInput({ name: 'x', targetKind: 'k' }), /tenantId is required/, 'tenantId required')
  assert.throws(() => __internals.normalizeTemplateInput({ tenantId: 't', name: 'x', targetKind: 'k', status: 'bogus' }), /status must be one of/, 'status enum')
  assert.throws(() => __internals.normalizeTemplateInput({ tenantId: 't', name: 'x', targetKind: 'k', version: 0 }), /positive integer/, 'version positive')
  assert.throws(() => __internals.normalizeTemplateInput({ tenantId: 't', name: 'x', targetKind: 'k', keyFields: 'nope' }), /must be an array/, 'keyFields array')
  assert.throws(() => __internals.normalizeTemplateInput({ tenantId: 't', name: 'x', targetKind: 'k', orchestrationConfig: [] }), /must be an object/, 'orchestrationConfig object')

  const norm = __internals.normalizeTemplateInput({ tenantId: 't1', name: 'tmpl', targetKind: 'metasheet:multitable' })
  assert.equal(norm.version, undefined, 'normalizer does NOT default version (system-managed; resolved in upsert)')
  assert.equal(norm.status, 'active', 'status defaults active')
  assert.equal(norm.workspaceId, null, 'workspaceId nullable')
  assert.deepEqual(norm.keyFields, [])
  assert.deepEqual(norm.mappingDef, [])
  assert.deepEqual(norm.orchestrationConfig, {})

  // --- 2. CRUD round-trip against a fake db ---
  const db = createFakeDb()
  const reg = createIntegrationTemplateRegistry({ db, idGenerator: () => 'tmpl_1', now: () => 'updated-ts' })

  const created = await reg.upsertTemplate({
    tenantId: 't1', workspaceId: 'w1', name: 'k3-material',
    targetKind: 'metasheet:multitable', targetObject: 'approved_materials',
    keyFields: ['code'], mappingDef: [{ sourceField: 'c', targetField: 'code' }],
    orchestrationConfig: { mode: 'upsert' }, createdBy: 'owner-1',
  })
  assert.equal(created.id, 'tmpl_1')
  assert.equal(created.version, 1)
  assert.equal(created.targetKind, 'metasheet:multitable')
  assert.deepEqual(created.keyFields, ['code'])
  assert.deepEqual(created.mappingDef, [{ sourceField: 'c', targetField: 'code' }])

  const got = await reg.getTemplate({ tenantId: 't1', workspaceId: 'w1', id: 'tmpl_1' })
  assert.equal(got.name, 'k3-material')
  assert.equal(got.targetObject, 'approved_materials')

  // upsert again (no id) matches the existing by scope+name -> update path, bumps updated_at
  const updated = await reg.upsertTemplate({
    tenantId: 't1', workspaceId: 'w1', name: 'k3-material',
    targetKind: 'metasheet:multitable', targetObject: 'approved_materials_v2',
  })
  assert.equal(updated.id, 'tmpl_1', 'upsert matched existing by scope+name (no duplicate)')
  assert.equal(updated.targetObject, 'approved_materials_v2')
  assert.equal(updated.version, 2, 'S3-1b: edit without a supplied version auto-bumps v1 -> v2')
  assert.equal(updated.updatedAt, 'updated-ts', 'update bumps updated_at (061 trigger in PG; in-memory test db bumps in app)')
  assert.equal(db.rows.filter((r) => r._table === 'integration_templates').length, 1, 'no duplicate row')

  // --- S3-1b: version-bump + optimistic-concurrency semantics ---
  // another plain edit (no version supplied) -> v3
  const v3 = await reg.upsertTemplate({
    tenantId: 't1', workspaceId: 'w1', name: 'k3-material',
    targetKind: 'metasheet:multitable', targetObject: 'approved_materials_v3',
  })
  assert.equal(v3.version, 3, 'consecutive edit auto-bumps v2 -> v3')
  // stale supplied version (current is 3) -> 409 conflict, NOT a silent overwrite
  await assert.rejects(
    () => reg.upsertTemplate({
      tenantId: 't1', workspaceId: 'w1', name: 'k3-material',
      targetKind: 'metasheet:multitable', targetObject: 'x', version: 1,
    }),
    (e) => e instanceof TemplateVersionConflictError && e.status === 409 && e.details.expected === 3 && e.details.actual === 1,
    'stale supplied version is an optimistic conflict (409), not a silent overwrite',
  )
  // the conflict did not mutate the row
  assert.equal((await reg.getTemplate({ tenantId: 't1', workspaceId: 'w1', id: 'tmpl_1' })).version, 3, 'conflicted update left version at 3')
  assert.equal((await reg.getTemplate({ tenantId: 't1', workspaceId: 'w1', id: 'tmpl_1' })).targetObject, 'approved_materials_v3', 'conflicted update did not overwrite fields')
  // correct supplied version (3) -> passes optimistic check and bumps to 4
  const v4 = await reg.upsertTemplate({
    tenantId: 't1', workspaceId: 'w1', name: 'k3-material',
    targetKind: 'metasheet:multitable', targetObject: 'approved_materials_v4', version: 3,
  })
  assert.equal(v4.version, 4, 'matching supplied version passes the optimistic check and bumps v3 -> v4')

  const list = await reg.listTemplates({ tenantId: 't1', workspaceId: 'w1' })
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'tmpl_1')

  // scope isolation: different tenant sees nothing
  assert.equal((await reg.listTemplates({ tenantId: 'other', workspaceId: 'w1' })).length, 0, 'tenant scoped')

  const del = await reg.deleteTemplate({ tenantId: 't1', workspaceId: 'w1', id: 'tmpl_1' })
  assert.equal(del.deleted, 1)
  await assert.rejects(() => reg.getTemplate({ tenantId: 't1', workspaceId: 'w1', id: 'tmpl_1' }), /not found/, 'deleted -> not found')
  await assert.rejects(
    () => reg.deleteTemplate({ tenantId: 't1', workspaceId: 'w1', id: 'missing' }),
    (e) => e instanceof TemplateNotFoundError && e.code === 'INTEGRATION_TEMPLATE_NOT_FOUND',
    'delete missing -> 404',
  )

  // --- 3. NO instantiation surface (S3-1 is contract+storage only) ---
  const mod = require(path.join(__dirname, '..', 'lib', 'integration-templates.cjs'))
  assert.equal(typeof mod.instantiateTemplate, 'undefined', 'no module-level instantiate')
  assert.equal(typeof reg.instantiateTemplate, 'undefined', 'registry exposes no instantiate')
  // and the registry never wrote to pipelines / external_systems tables
  assert.ok(db.calls.every((c) => c[1] === 'integration_templates'), 'registry only touches integration_templates')

  console.log('✓ integration-templates: normalizer + CRUD + no-instantiate tests passed')
}

main().catch((err) => {
  console.error('✗ integration-templates FAILED')
  console.error(err)
  process.exit(1)
})
