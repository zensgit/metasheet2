'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const {
  createIntegrationTemplateRegistry,
  TemplateNotFoundError,
  TemplateValidationError,
  TemplateVersionConflictError,
  TemplateInstantiationConflictError,
  __internals,
} = require(path.join(__dirname, '..', 'lib', 'integration-templates.cjs'))

function createFakeDb() {
  const rows = []
  const calls = []
  const matches = (row, where) => Object.entries(where).every(([k, v]) => (row[k] ?? null) === (v ?? null))
  const api = {
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
    async insertMany(table, newRows) {
      calls.push(['insertMany', table, newRows.map((r) => ({ ...r }))])
      const recs = newRows.map((row) => ({ ...row, _table: table, created_at: 'now', updated_at: 'now' }))
      for (const rec of recs) rows.push(rec)
      return recs
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
    // Real rollback semantics: snapshot the rows before the callback; on throw, restore them.
    // This lets the atomicity test prove no orphan pipeline row survives a mid-tx failure.
    async transaction(fn) {
      calls.push(['transaction'])
      const snapshot = rows.map((r) => ({ ...r }))
      try {
        return await fn(api)
      } catch (error) {
        rows.length = 0
        for (const r of snapshot) rows.push(r)
        throw error
      }
    },
  }
  return api
}

// Fake external-system registry: getExternalSystem throws (ExternalSystemNotFoundError-shaped)
// when absent, exactly like the real one — instantiation must map that to a 422 bind error.
function createFakeExternalSystemRegistry(systems) {
  return {
    async getExternalSystem({ tenantId, workspaceId, id }) {
      const sys = systems.find((s) =>
        s.id === id &&
        (s.tenantId ?? null) === (tenantId ?? null) &&
        (s.workspaceId ?? null) === (workspaceId ?? null))
      if (!sys) {
        const err = new Error('external system not found')
        err.name = 'ExternalSystemNotFoundError'
        err.status = 404
        err.code = 'INTEGRATION_EXTERNAL_SYSTEM_NOT_FOUND'
        throw err
      }
      return { ...sys }
    },
  }
}

// Seed a system into BOTH the db (so writePipelineRow#requireExternalSystem sees role+existence)
// AND the registry (so instantiate's kind-validation can resolve it).
function seedSystem(db, systems, { id, tenantId = 't1', workspaceId = 'w1', kind, role }) {
  db.rows.push({ _table: 'integration_external_systems', id, tenant_id: tenantId, workspace_id: workspaceId, kind, role })
  systems.push({ id, tenantId, workspaceId, kind, role })
}

function pipelineRowsByName(db, name) {
  return db.rows.filter((r) => r._table === 'integration_pipelines' && r.name === name)
}
// pipelines.cjs stores `options` as a JSONB-as-text column (jsonbParam = JSON.stringify), so a raw
// row read returns a string; parse it the way rowToPipeline does. target_field is a plain column.
function parseOptions(row) {
  return typeof row.options === 'string' ? JSON.parse(row.options) : (row.options || {})
}
function fieldMappingRows(db, pipelineId) {
  return db.rows
    .filter((r) => r._table === 'integration_field_mappings' && r.pipeline_id === pipelineId)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
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

  // --- 3. instantiate is a REGISTRY method (S3-2), not a free module export ---
  const mod = require(path.join(__dirname, '..', 'lib', 'integration-templates.cjs'))
  assert.equal(typeof mod.instantiateTemplate, 'undefined', 'instantiate is a registry method, not a module-level export')
  assert.equal(typeof reg.instantiateTemplate, 'function', 'registry exposes instantiateTemplate (S3-2)')
  // a registry built WITHOUT externalSystemRegistry still constructs, but instantiate fails loudly
  await assert.rejects(
    () => reg.instantiateTemplate({ tenantId: 't1', workspaceId: 'w1', templateId: 'x', targetSystemId: 'a', sourceSystemId: 'b' }),
    /externalSystemRegistry/,
    'instantiate without a wired externalSystemRegistry throws a clear error',
  )

  // --- 4. S3-2 instantiation: BIND to caller-supplied systems, single tx, SNAPSHOT provenance ---
  {
    const idb = createFakeDb()
    const systems = []
    seedSystem(idb, systems, { id: 'sys_mt', kind: 'metasheet:multitable', role: 'target' })
    seedSystem(idb, systems, { id: 'sys_src', kind: 'data-source:sql-readonly', role: 'source' })
    let seq = 0
    const ireg = createIntegrationTemplateRegistry({
      db: idb,
      idGenerator: () => `gen_${++seq}`,
      now: () => 'ts',
      externalSystemRegistry: createFakeExternalSystemRegistry(systems),
    })

    const tmpl = await ireg.upsertTemplate({
      tenantId: 't1', workspaceId: 'w1', name: 'k3-material-pipeline',
      sourceKind: 'data-source:sql-readonly', sourceObject: 'dbo.materials',
      targetKind: 'metasheet:multitable', targetObject: 'approved_materials',
      keyFields: ['code'],
      mappingDef: [
        { sourceField: 'c', targetField: 'code' },
        { sourceField: 'n', targetField: 'name' },
      ],
      orchestrationConfig: { schedule: 'manual' },
      createdBy: 'owner-1',
    })
    assert.equal(tmpl.version, 1)

    // happy path: instantiate -> a live pipeline materialized from the v1 snapshot
    const pipe = await ireg.instantiateTemplate({
      tenantId: 't1', workspaceId: 'w1', templateId: tmpl.id,
      targetSystemId: 'sys_mt', sourceSystemId: 'sys_src', createdBy: 'owner-1',
    })
    assert.equal(pipe.name, 'k3-material-pipeline', 'pipeline name defaults to template name')
    assert.equal(pipe.sourceSystemId, 'sys_src', 'bound source system')
    assert.equal(pipe.targetSystemId, 'sys_mt', 'bound target system')
    assert.equal(pipe.sourceObject, 'dbo.materials', 'source object from template')
    assert.equal(pipe.targetObject, 'approved_materials', 'target object from template')
    assert.equal(pipe.status, 'draft', 'instantiated pipelines start as draft')
    assert.deepEqual(pipe.idempotencyKeyFields, ['code'], 'key fields copied from template')
    assert.equal(pipe.mode, 'incremental', 'mode is DEFAULTED, never taken from orchestrationConfig')
    assert.equal(pipe.options.schedule, 'manual', 'orchestrationConfig merged into options')
    assert.equal(pipe.options.provenance.instantiatedFromTemplateId, tmpl.id, 'provenance: source template id')
    assert.equal(pipe.options.provenance.templateVersion, 1, 'provenance: snapshot version')
    assert.deepEqual(pipe.fieldMappings.map((m) => m.targetField), ['code', 'name'], 'mappings materialized from template')

    // --- SNAPSHOT (load-bearing): edit the template AFTER instantiation; the live pipeline must NOT re-sync ---
    const edited = await ireg.upsertTemplate({
      tenantId: 't1', workspaceId: 'w1', name: 'k3-material-pipeline',
      sourceKind: 'data-source:sql-readonly', sourceObject: 'dbo.materials',
      targetKind: 'metasheet:multitable', targetObject: 'approved_materials',
      keyFields: ['code'],
      mappingDef: [
        { sourceField: 'c', targetField: 'code_CHANGED' }, // mutate a mapping target
        { sourceField: 'n', targetField: 'name' },
        { sourceField: 'x', targetField: 'extra' },        // add a mapping
      ],
      orchestrationConfig: { schedule: 'cron' },
    })
    assert.equal(edited.version, 2, 'template edit bumped to v2')
    assert.equal(edited.mappingDef[0].targetField, 'code_CHANGED', 'template definition changed')

    // re-read the LIVE pipeline straight from storage (not via the template)
    const pipeRow = pipelineRowsByName(idb, 'k3-material-pipeline')
    assert.equal(pipeRow.length, 1, 'still exactly one pipeline')
    assert.equal(parseOptions(pipeRow[0]).provenance.templateVersion, 1, 'provenance still pins v1 (no silent re-sync)')
    const liveMappings = fieldMappingRows(idb, pipeRow[0].id).map((m) => m.target_field)
    assert.deepEqual(liveMappings, ['code', 'name'], 'materialized mappings are the v1 SNAPSHOT, UNCHANGED by the v2 edit')

    // --- idempotency: re-instantiate the same resolved name -> 409, no duplicate pipeline ---
    await assert.rejects(
      () => ireg.instantiateTemplate({
        tenantId: 't1', workspaceId: 'w1', templateId: tmpl.id,
        targetSystemId: 'sys_mt', sourceSystemId: 'sys_src',
      }),
      (e) => e instanceof TemplateInstantiationConflictError && e.status === 409 && e.code === 'INTEGRATION_TEMPLATE_INSTANTIATION_CONFLICT',
      'second instantiate with same resolved name is a 409 conflict',
    )
    assert.equal(pipelineRowsByName(idb, 'k3-material-pipeline').length, 1, 'idempotent: still exactly one pipeline row')

    // a DISTINCT pipelineName instantiates a second pipeline, snapshotting the CURRENT (v2) template
    const pipe2 = await ireg.instantiateTemplate({
      tenantId: 't1', workspaceId: 'w1', templateId: tmpl.id,
      targetSystemId: 'sys_mt', sourceSystemId: 'sys_src', pipelineName: 'k3-material-pipeline-copy',
    })
    assert.equal(pipe2.options.provenance.templateVersion, 2, 'a fresh instantiation snapshots the CURRENT (v2) version')
    assert.deepEqual(pipe2.fieldMappings.map((m) => m.targetField), ['code_CHANGED', 'name', 'extra'], 'fresh snapshot reflects v2 mappings')
  }

  // --- 5. bind fail-closed (422), creating NO pipeline ---
  {
    const idb = createFakeDb()
    const systems = []
    seedSystem(idb, systems, { id: 'sys_mt', kind: 'metasheet:multitable', role: 'target' })
    seedSystem(idb, systems, { id: 'sys_src', kind: 'data-source:sql-readonly', role: 'source' })
    seedSystem(idb, systems, { id: 'sys_wrongkind', kind: 'erp:k3-wise-webapi', role: 'target' })
    let seq = 0
    const ireg = createIntegrationTemplateRegistry({
      db: idb, idGenerator: () => `gen_${++seq}`, now: () => 'ts',
      externalSystemRegistry: createFakeExternalSystemRegistry(systems),
    })
    const tmpl = await ireg.upsertTemplate({
      tenantId: 't1', workspaceId: 'w1', name: 'bind-tmpl',
      sourceKind: 'data-source:sql-readonly', sourceObject: 'dbo.m',
      targetKind: 'metasheet:multitable', targetObject: 'approved',
      mappingDef: [{ sourceField: 'c', targetField: 'code' }],
    })
    const pipelineCount = () => idb.rows.filter((r) => r._table === 'integration_pipelines').length

    // (a) missing targetSystemId -> 422
    await assert.rejects(
      () => ireg.instantiateTemplate({ tenantId: 't1', workspaceId: 'w1', templateId: tmpl.id, sourceSystemId: 'sys_src' }),
      (e) => e instanceof TemplateValidationError && e.status === 422,
      'missing targetSystemId fails closed (422)',
    )
    // (b) bound target system kind != template.targetKind -> 422
    await assert.rejects(
      () => ireg.instantiateTemplate({ tenantId: 't1', workspaceId: 'w1', templateId: tmpl.id, targetSystemId: 'sys_wrongkind', sourceSystemId: 'sys_src' }),
      (e) => e instanceof TemplateValidationError && e.status === 422 && e.details.field === 'targetSystemId',
      'target kind mismatch fails closed (422)',
    )
    // (c) non-existent targetSystemId -> 422 (registry throws not-found, mapped to a bind error)
    await assert.rejects(
      () => ireg.instantiateTemplate({ tenantId: 't1', workspaceId: 'w1', templateId: tmpl.id, targetSystemId: 'sys_ghost', sourceSystemId: 'sys_src' }),
      (e) => e instanceof TemplateValidationError && e.status === 422,
      'non-existent target system fails closed (422), not a 404/500',
    )
    assert.equal(pipelineCount(), 0, 'no pipeline created by any failed bind')
  }

  // --- 6. atomicity: a mid-tx field-mapping failure leaves NO orphan pipeline row ---
  {
    const idb = createFakeDb()
    const systems = []
    seedSystem(idb, systems, { id: 'sys_mt', kind: 'metasheet:multitable', role: 'target' })
    seedSystem(idb, systems, { id: 'sys_src', kind: 'data-source:sql-readonly', role: 'source' })
    let seq = 0
    const ireg = createIntegrationTemplateRegistry({
      db: idb, idGenerator: () => `gen_${++seq}`, now: () => 'ts',
      externalSystemRegistry: createFakeExternalSystemRegistry(systems),
    })
    const tmpl = await ireg.upsertTemplate({
      tenantId: 't1', workspaceId: 'w1', name: 'atomic-tmpl',
      sourceKind: 'data-source:sql-readonly', sourceObject: 'dbo.m',
      targetKind: 'metasheet:multitable', targetObject: 'approved',
      mappingDef: [{ sourceField: 'c', targetField: 'code' }],
    })
    // make the field-mapping insert blow up AFTER the pipeline row is inserted, inside the tx
    idb.insertMany = async () => { throw new Error('mappings insert boom') }
    await assert.rejects(
      () => ireg.instantiateTemplate({ tenantId: 't1', workspaceId: 'w1', templateId: tmpl.id, targetSystemId: 'sys_mt', sourceSystemId: 'sys_src' }),
      /boom/,
      'a mid-tx failure propagates out',
    )
    assert.equal(idb.rows.filter((r) => r._table === 'integration_pipelines').length, 0, 'transaction rolled back: NO orphan pipeline row')
    assert.ok(idb.calls.some((c) => c[0] === 'transaction'), 'instantiation used db.transaction (all-or-nothing)')
  }

  console.log('✓ integration-templates: normalizer + CRUD + S3-2 instantiate (snapshot/idempotency/bind/atomicity) tests passed')
}

main().catch((err) => {
  console.error('✗ integration-templates FAILED')
  console.error(err)
  process.exit(1)
})
