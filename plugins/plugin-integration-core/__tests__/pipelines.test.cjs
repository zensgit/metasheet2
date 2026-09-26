'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const {
  createPipelineRegistry,
  PipelineNotFoundError,
  PipelineValidationError,
  PipelineConflictError,
  __internals,
} = require(path.join(__dirname, '..', 'lib', 'pipelines.cjs'))

function createIdGenerator() {
  let next = 1
  return () => `id_${next++}`
}

function createMockDb() {
  const tables = new Map([
    ['integration_external_systems', []],
    ['integration_pipelines', []],
    ['integration_field_mappings', []],
    ['integration_runs', []],
  ])
  const calls = []

  function tableRows(table) {
    if (!tables.has(table)) tables.set(table, [])
    return tables.get(table)
  }

  function matchesWhere(row, where) {
    return Object.entries(where || {}).every(([key, value]) => {
      if (value === null || value === undefined) return row[key] === null || row[key] === undefined
      return row[key] === value
    })
  }

  const db = {
    tables,
    calls,
    seed(table, rows) {
      tableRows(table).push(...rows)
    },
    async selectOne(table, where) {
      calls.push(['selectOne', table, { ...where }])
      return tableRows(table).find(row => matchesWhere(row, where)) || null
    },
    // Writer's half of the external-system delete lock protocol: the endpoint check reads the
    // external system FOR KEY SHARE on the transaction handle. Same lookup as selectOne here.
    async selectOneForKeyShare(table, where) {
      calls.push(['selectOneForKeyShare', table, { ...where }])
      return tableRows(table).find(row => matchesWhere(row, where)) || null
    },
    async insertOne(table, row) {
      calls.push(['insertOne', table, { ...row }])
      const stored = {
        ...row,
        created_at: row.created_at || '2026-04-24T00:00:00.000Z',
        updated_at: row.updated_at || '2026-04-24T00:00:00.000Z',
      }
      tableRows(table).push(stored)
      return [stored]
    },
    async insertMany(table, rows) {
      calls.push(['insertMany', table, rows.map(row => ({ ...row }))])
      const storedRows = rows.map((row, index) => ({
        ...row,
        created_at: row.created_at || `2026-04-24T00:00:0${index}.000Z`,
      }))
      tableRows(table).push(...storedRows)
      return storedRows
    },
    async updateRow(table, set, where) {
      calls.push(['updateRow', table, { ...set }, { ...where }])
      const row = tableRows(table).find(candidate => matchesWhere(candidate, where))
      if (!row) return []
      Object.assign(row, set, { updated_at: '2026-04-24T01:00:00.000Z' })
      return [row]
    },
    async deleteRows(table, where) {
      calls.push(['deleteRows', table, { ...where }])
      const rows = tableRows(table)
      const kept = []
      const removed = []
      for (const row of rows) {
        if (matchesWhere(row, where)) removed.push(row)
        else kept.push(row)
      }
      tables.set(table, kept)
      return removed
    },
    async select(table, options = {}) {
      calls.push(['select', table, JSON.parse(JSON.stringify(options))])
      const filtered = tableRows(table).filter(row => matchesWhere(row, options.where || {}))
      const ordered = filtered.slice()
      if (options.orderBy) {
        const [field, direction] = options.orderBy
        ordered.sort((a, b) => {
          const left = a[field]
          const right = b[field]
          if (left === right) return 0
          const result = left > right ? 1 : -1
          return direction === 'DESC' ? -result : result
        })
      }
      return ordered.slice(options.offset || 0, (options.offset || 0) + (options.limit || 1000))
    },
    async transaction(callback) {
      calls.push(['transaction'])
      return callback(this)
    },
  }

  return db
}

async function main() {
  const db = createMockDb()
  db.seed('integration_external_systems', [
    { id: 'plm_1', tenant_id: 'tenant_1', workspace_id: null, name: 'PLM', role: 'source', kind: 'plm:yuantus' },
    { id: 'erp_1', tenant_id: 'tenant_1', workspace_id: null, name: 'K3', role: 'target', kind: 'erp:k3-wise-webapi' },
    { id: 'target_in_other_workspace', tenant_id: 'tenant_1', workspace_id: 'other', name: 'K3 other', role: 'target', kind: 'erp:k3-wise-webapi' },
    { id: 'source_only', tenant_id: 'tenant_1', workspace_id: null, name: 'Source only', role: 'source', kind: 'http' },
  ])

  const registry = createPipelineRegistry({
    db,
    idGenerator: createIdGenerator(),
  })

  // --- 1. Create validates endpoint systems and writes mappings in tx ----
  const created = await registry.upsertPipeline({
    tenantId: 'tenant_1',
    workspaceId: '',
    projectId: 'project_1',
    name: 'Material sync',
    description: 'PLM material to K3',
    sourceSystemId: 'plm_1',
    sourceObject: 'materials',
    targetSystemId: 'erp_1',
    targetObject: 'BD_MATERIAL',
    stagingSheetId: 'sheet_1',
    mode: 'incremental',
    idempotencyKeyFields: ['sourceId', 'revision'],
    options: { batchSize: 100 },
    status: 'active',
    createdBy: 'admin',
    fieldMappings: [
      { sourceField: 'code', targetField: 'FNumber', defaultValue: 'PCS', sortOrder: 0 },
      { sourceField: 'name', targetField: 'FName', transform: { fn: 'trim' }, validation: [{ type: 'required' }], sortOrder: 1 },
    ],
  })

  assert.equal(created.id, 'id_1')
  assert.equal(created.workspaceId, null, 'empty workspace normalized to null')
  assert.equal(created.sourceSystemId, 'plm_1')
  assert.equal(created.targetSystemId, 'erp_1')
  assert.equal(created.status, 'active')
  assert.equal(created.fieldMappings.length, 2)
  assert.deepEqual(created.fieldMappings.map(mapping => mapping.id), ['id_2', 'id_3'])
  assert.equal(created.fieldMappings[0].defaultValue, 'PCS')
  assert.ok(db.calls.some(([name]) => name === 'transaction'), 'field mapping writes are transactional')
  const pipelineInsert = db.calls.find(call => call[0] === 'insertOne' && call[1] === 'integration_pipelines')
  assert.equal(pipelineInsert[2].idempotency_key_fields, '["sourceId","revision"]',
    'pipeline idempotency JSONB array is stored as JSON text')
  assert.equal(pipelineInsert[2].options, '{"batchSize":100}',
    'pipeline options JSONB object is stored as JSON text')
  const mappingInsert = db.calls.find(call => call[0] === 'insertMany' && call[1] === 'integration_field_mappings')
  assert.equal(mappingInsert[2][0].default_value, '"PCS"',
    'field mapping JSONB string default is stored as valid JSON text')
  assert.equal(mappingInsert[2][1].transform, '{"fn":"trim"}',
    'field mapping transform JSONB object is stored as JSON text')
  assert.equal(mappingInsert[2][1].validation, '[{"type":"required"}]',
    'field mapping validation JSONB array is stored as JSON text')

  // --- 2. getPipeline returns mappings and safe definition shape ---------
  const fetched = await registry.getPipeline({ tenantId: 'tenant_1', workspaceId: null, id: 'id_1' })
  assert.equal(fetched.id, 'id_1')
  assert.equal(fetched.fieldMappings.length, 2)
  assert.equal(fetched.fieldMappings[0].defaultValue, 'PCS')
  assert.equal(fetched.fieldMappings[1].transform.fn, 'trim')
  assert.equal(fetched.credentials, undefined, 'pipeline output never includes credentials')
  assert.equal(fetched.credentialsEncrypted, undefined, 'pipeline output never includes ciphertext')

  // --- 3. Update without fieldMappings preserves existing mappings -------
  const updated = await registry.upsertPipeline({
    tenantId: 'tenant_1',
    workspaceId: null,
    id: 'id_1',
    name: 'Material sync v2',
    sourceSystemId: 'plm_1',
    sourceObject: 'materials',
    targetSystemId: 'erp_1',
    targetObject: 'BD_MATERIAL',
    mode: 'manual',
    status: 'paused',
    createdBy: 'operator_should_not_replace_creator',
  })
  assert.equal(updated.id, 'id_1')
  assert.equal(updated.name, 'Material sync v2')
  assert.equal(updated.createdBy, 'admin', 'updates preserve original created_by audit field')
  const pipelineUpdate = db.calls.find(call => call[0] === 'updateRow' && call[1] === 'integration_pipelines')
  assert.equal(
    Object.hasOwn(pipelineUpdate[2], 'created_by'),
    false,
    'pipeline update does not write created_by',
  )
  assert.equal(updated.fieldMappings, undefined, 'omitted fieldMappings are not implicitly loaded/replaced')
  assert.equal(db.tables.get('integration_field_mappings').length, 2, 'existing mappings preserved when omitted')

  // --- 4. Explicit empty fieldMappings clears mappings ------------------
  const cleared = await registry.upsertPipeline({
    tenantId: 'tenant_1',
    workspaceId: null,
    id: 'id_1',
    name: 'Material sync v2',
    sourceSystemId: 'plm_1',
    sourceObject: 'materials',
    targetSystemId: 'erp_1',
    targetObject: 'BD_MATERIAL',
    fieldMappings: [],
  })
  assert.deepEqual(cleared.fieldMappings, [])
  assert.equal(db.tables.get('integration_field_mappings').length, 0, 'explicit empty mappings clears rows')

  // --- 5. list scopes by tenant/workspace and filters status ------------
  const listed = await registry.listPipelines({ tenantId: 'tenant_1', workspaceId: null, status: 'draft' })
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, 'id_1')

  const isolated = await registry.listPipelines({ tenantId: 'tenant_1', workspaceId: 'other' })
  assert.equal(isolated.length, 0, 'workspace scope isolates pipelines')

  // --- 6. Endpoint existence and roles are enforced ---------------------
  let missingSystem = null
  try {
    await registry.upsertPipeline({
      tenantId: 'tenant_1',
      name: 'Bad missing target',
      sourceSystemId: 'plm_1',
      sourceObject: 'x',
      targetSystemId: 'missing',
      targetObject: 'y',
    })
  } catch (error) {
    missingSystem = error
  }
  assert.ok(missingSystem instanceof PipelineValidationError, 'missing target rejected')

  let badRole = null
  try {
    await registry.upsertPipeline({
      tenantId: 'tenant_1',
      name: 'Bad target role',
      sourceSystemId: 'plm_1',
      sourceObject: 'x',
      targetSystemId: 'source_only',
      targetObject: 'y',
    })
  } catch (error) {
    badRole = error
  }
  assert.ok(badRole instanceof PipelineValidationError, 'source-only system cannot be target')
  assert.equal(badRole.details.field, 'targetSystemId')

  // --- 6b. Same external system can bridge different objects only when bidirectional.
  {
    const sameSystemDb = createMockDb()
    sameSystemDb.seed('integration_external_systems', [
      {
        id: 'crm_bidirectional',
        tenant_id: 'tenant_1',
        workspace_id: null,
        name: 'CRM bidirectional',
        role: 'bidirectional',
        kind: 'http',
      },
      {
        id: 'crm_source_only',
        tenant_id: 'tenant_1',
        workspace_id: null,
        name: 'CRM source only',
        role: 'source',
        kind: 'http',
      },
    ])
    const sameSystemRegistry = createPipelineRegistry({
      db: sameSystemDb,
      idGenerator: createIdGenerator(),
    })

    const sameSystemPipeline = await sameSystemRegistry.upsertPipeline({
      tenantId: 'tenant_1',
      name: 'CRM customer cleanse in-place',
      sourceSystemId: 'crm_bidirectional',
      sourceObject: 'customers_raw',
      targetSystemId: 'crm_bidirectional',
      targetObject: 'customers_clean',
      fieldMappings: [
        { sourceField: 'rawName', targetField: 'name', transform: { fn: 'trim' } },
      ],
    })
    assert.equal(sameSystemPipeline.sourceSystemId, 'crm_bidirectional')
    assert.equal(sameSystemPipeline.targetSystemId, 'crm_bidirectional')
    assert.equal(sameSystemPipeline.sourceObject, 'customers_raw')
    assert.equal(sameSystemPipeline.targetObject, 'customers_clean')

    const sameSystemBadRole = await sameSystemRegistry.upsertPipeline({
      tenantId: 'tenant_1',
      name: 'CRM bad in-place target',
      sourceSystemId: 'crm_source_only',
      sourceObject: 'customers_raw',
      targetSystemId: 'crm_source_only',
      targetObject: 'customers_clean',
    }).catch((error) => error)
    assert.ok(sameSystemBadRole instanceof PipelineValidationError, 'same source-only system cannot be target')
    assert.equal(sameSystemBadRole.details.field, 'targetSystemId')
  }

  // --- 7. Validation + not-found errors ---------------------------------
  let badMapping = null
  try {
    await registry.upsertPipeline({
      tenantId: 'tenant_1',
      name: 'Bad mapping',
      sourceSystemId: 'plm_1',
      sourceObject: 'x',
      targetSystemId: 'erp_1',
      targetObject: 'y',
      fieldMappings: [{ sourceField: 'a', targetField: '', sortOrder: -1 }],
    })
  } catch (error) {
    badMapping = error
  }
  assert.ok(badMapping instanceof PipelineValidationError, 'invalid mapping rejected')

  let notFound = null
  try {
    await registry.getPipeline({ tenantId: 'tenant_1', id: 'missing' })
  } catch (error) {
    notFound = error
  }
  assert.ok(notFound instanceof PipelineNotFoundError, 'missing pipeline throws not found')

  // --- 8. Run ledger creates pending metadata without executing adapters -
  const run = await registry.createPipelineRun({
    tenantId: 'tenant_1',
    workspaceId: null,
    pipelineId: 'id_1',
    mode: 'manual',
    triggeredBy: 'api',
    details: { dryRun: true },
  })
  assert.equal(run.id, 'id_4')
  assert.equal(run.pipelineId, 'id_1')
  assert.equal(run.status, 'pending')
  assert.equal(run.rowsRead, 0)
  assert.deepEqual(run.details, { dryRun: true })
  const runInsert = db.calls.find(call => call[0] === 'insertOne' && call[1] === 'integration_runs')
  assert.equal(runInsert[2].details, '{"dryRun":true}',
    'pipeline run details JSONB object is stored as JSON text')

  const completedRun = await registry.updatePipelineRun({
    tenantId: 'tenant_1',
    workspaceId: null,
    id: 'id_4',
    status: 'succeeded',
    rowsRead: 10,
    rowsCleaned: 9,
    rowsWritten: 8,
    rowsFailed: 1,
    durationMs: 1234,
    details: { batch: 1 },
  })
  assert.equal(completedRun.status, 'succeeded')
  assert.equal(completedRun.rowsWritten, 8)
  assert.equal(completedRun.durationMs, 1234)
  assert.ok(completedRun.finishedAt, 'terminal update sets finishedAt')

  // --- 8b. DF-N2-2b: provenance_events array is serialized to the JSONB column ---
  await registry.updatePipelineRun({
    tenantId: 'tenant_1',
    workspaceId: null,
    id: 'id_4',
    status: 'succeeded',
    rowsWritten: 1,
    provenanceEvents: [{ runId: 'id_4', rowId: 'k1', eventType: 'target_write_succeeded', at: '2026-04-24T00:00:00.000Z', attrs: {} }],
  })
  const provUpdate = db.calls.filter(call => call[0] === 'updateRow' && call[1] === 'integration_runs').pop()
  assert.equal(
    provUpdate[2].provenance_events,
    '[{"runId":"id_4","rowId":"k1","eventType":"target_write_succeeded","at":"2026-04-24T00:00:00.000Z","attrs":{}}]',
    'provenanceEvents array serialized to the provenance_events JSONB column',
  )
  // omitted from SET when not provided → migration 060 default '[]' is preserved (no overwrite)
  await registry.updatePipelineRun({ tenantId: 'tenant_1', workspaceId: null, id: 'id_4', status: 'succeeded', rowsWritten: 1 })
  const noProvUpdate = db.calls.filter(call => call[0] === 'updateRow' && call[1] === 'integration_runs').pop()
  assert.equal('provenance_events' in noProvUpdate[2], false, 'provenance_events omitted from SET when absent')

  const runs = await registry.listPipelineRuns({ tenantId: 'tenant_1', workspaceId: null, pipelineId: 'id_1', status: 'succeeded' })
  assert.equal(runs.length, 1)
  assert.equal(runs[0].id, 'id_4')

  // --- 8c. SC-04: getPipelineRun — single-run read, same projection as list ---------------
  const singleRun = await registry.getPipelineRun({ tenantId: 'tenant_1', workspaceId: null, id: 'id_4' })
  assert.equal(singleRun.id, 'id_4')
  assert.equal(singleRun.status, 'succeeded')
  assert.deepEqual(singleRun, runs[0], 'getPipelineRun projects the same rowToPipelineRun shape as listPipelineRuns')
  const singleRunSelect = db.calls.filter(call => call[0] === 'selectOne' && call[1] === 'integration_runs').pop()
  assert.deepEqual(singleRunSelect[2], { tenant_id: 'tenant_1', workspace_id: null, id: 'id_4' },
    'getPipelineRun WHERE carries all three scope keys (tenant_id, workspace_id, id)')

  // workspaceId omitted / '' normalizes to null, exactly like list (scopeWhere) — no widening
  await registry.getPipelineRun({ tenantId: 'tenant_1', id: 'id_4' })
  const omittedWsSelect = db.calls.filter(call => call[0] === 'selectOne' && call[1] === 'integration_runs').pop()
  assert.equal(omittedWsSelect[2].workspace_id, null, 'omitted workspaceId is pinned to null in the WHERE')
  assert.ok('workspace_id' in omittedWsSelect[2], 'workspace_id key is present (null), never dropped from the WHERE')

  // another tenant's id and a non-existent id both miss the three-key WHERE → PipelineNotFoundError
  let runNotFound = null
  try {
    await registry.getPipelineRun({ tenantId: 'tenant_other', workspaceId: null, id: 'id_4' })
  } catch (error) {
    runNotFound = error
  }
  assert.ok(runNotFound instanceof PipelineNotFoundError, 'foreign-tenant run id throws not found')
  const foreignSelect = db.calls.filter(call => call[0] === 'selectOne' && call[1] === 'integration_runs').pop()
  assert.equal(foreignSelect[2].tenant_id, 'tenant_other', 'the lookup was scoped to the caller tenant')

  let runMissing = null
  try {
    await registry.getPipelineRun({ tenantId: 'tenant_1', workspaceId: null, id: 'id_missing' })
  } catch (error) {
    runMissing = error
  }
  assert.ok(runMissing instanceof PipelineNotFoundError, 'missing run id throws not found')
  assert.equal(runMissing.name, runNotFound.name, 'foreign-tenant and missing ids raise the same error class')

  // input validation: id and tenantId are required (short-circuits before any db call)
  const selectOneCountBefore = db.calls.filter(call => call[0] === 'selectOne').length
  for (const badInput of [{ tenantId: 'tenant_1', workspaceId: null }, { workspaceId: null, id: 'id_4' }, undefined]) {
    let bad = null
    try {
      await registry.getPipelineRun(badInput)
    } catch (error) {
      bad = error
    }
    assert.ok(bad instanceof PipelineValidationError, `getPipelineRun rejects ${JSON.stringify(badInput)} before the db`)
  }
  assert.equal(db.calls.filter(call => call[0] === 'selectOne').length, selectOneCountBefore, 'validation failures issue no selectOne')

  // --- 8d. Q4a: listProvenanceByRun — per-run timeline off the migration-060 view -----------
  // The view rows are seeded directly (the SQL unnest itself is locked by migration-sql.test.cjs
  // and the write→view→read round-trip by df-n2-2c-provenance-read.test.cjs); what THIS block
  // pins is the registry's WHERE, its ordering and its limit ceiling.
  db.seed('integration_provenance_by_row', [
    // deliberately out of event_index order in storage, so an ordering regression is visible
    { tenant_id: 'tenant_1', workspace_id: null, pipeline_id: 'id_1', run_id: 'id_4', run_mode: 'full', run_status: 'succeeded', run_created_at: '2026-04-24T00:00:00.000Z', event_index: 2, row_id: 'k1', event_type: 'target_write_succeeded', event_at: '2026-04-24T00:00:02.000Z', attrs: {} },
    { tenant_id: 'tenant_1', workspace_id: null, pipeline_id: 'id_1', run_id: 'id_4', run_mode: 'full', run_status: 'succeeded', run_created_at: '2026-04-24T00:00:00.000Z', event_index: 1, row_id: 'k1', event_type: 'row_cleaned', event_at: '2026-04-24T00:00:01.000Z', attrs: {} },
    // another run of the SAME tenant — must not leak into the id_4 timeline
    { tenant_id: 'tenant_1', workspace_id: null, pipeline_id: 'id_1', run_id: 'other_run', run_mode: 'full', run_status: 'failed', run_created_at: '2026-04-24T00:10:00.000Z', event_index: 1, row_id: 'k9', event_type: 'target_write_failed', event_at: '2026-04-24T00:10:01.000Z', attrs: {} },
    // same run id under ANOTHER tenant — the cross-tenant row this WHERE has to exclude
    { tenant_id: 'tenant_other', workspace_id: null, pipeline_id: 'id_1', run_id: 'id_4', run_mode: 'full', run_status: 'succeeded', run_created_at: '2026-04-24T00:00:00.000Z', event_index: 1, row_id: 'leak', event_type: 'row_cleaned', event_at: '2026-04-24T00:00:01.000Z', attrs: {} },
    // same run id under another WORKSPACE of the caller's own tenant — excluded too
    { tenant_id: 'tenant_1', workspace_id: 'ws_other', pipeline_id: 'id_1', run_id: 'id_4', run_mode: 'full', run_status: 'succeeded', run_created_at: '2026-04-24T00:00:00.000Z', event_index: 1, row_id: 'ws_leak', event_type: 'row_cleaned', event_at: '2026-04-24T00:00:01.000Z', attrs: {} },
  ])

  const runTimeline = await registry.listProvenanceByRun({ tenantId: 'tenant_1', workspaceId: null, runId: 'id_4' })
  assert.deepEqual(runTimeline.map(entry => entry.eventIndex), [1, 2],
    'listProvenanceByRun returns the run timeline ordered by event_index')
  assert.deepEqual(runTimeline.map(entry => entry.rowId), ['k1', 'k1'],
    'only the requested run\'s rows are returned (no other run, no other tenant, no other workspace)')
  assert.deepEqual(
    Object.keys(runTimeline[0]).sort(),
    __internals.PROVENANCE_TIMELINE_ENTRY_FIELDS.slice().sort(),
    'listProvenanceByRun projects exactly the frozen timeline entry fields (same rowToProvenanceEntry as by-row)',
  )
  const byRunSelect = db.calls.filter(call => call[0] === 'select' && call[1] === 'integration_provenance_by_row').pop()
  assert.deepEqual(byRunSelect[2].where, { tenant_id: 'tenant_1', workspace_id: null, run_id: 'id_4' },
    'listProvenanceByRun WHERE carries tenant_id + workspace_id + run_id (drop tenant_id and the cross-tenant row leaks)')
  assert.deepEqual(byRunSelect[2].orderBy, ['event_index', 'ASC'], 'ordered by event_index ASC at the DB')
  assert.equal(byRunSelect[2].limit, __internals.PROVENANCE_BY_RUN_LIMIT_DEFAULT,
    'no caller limit → the server-held default page size')

  // omitted workspaceId normalizes to null exactly like the by-row read and the run reads
  await registry.listProvenanceByRun({ tenantId: 'tenant_1', runId: 'id_4' })
  const omittedWsByRun = db.calls.filter(call => call[0] === 'select' && call[1] === 'integration_provenance_by_row').pop()
  assert.equal(omittedWsByRun[2].where.workspace_id, null, 'omitted workspaceId is pinned to null in the WHERE')
  assert.ok('workspace_id' in omittedWsByRun[2].where, 'workspace_id key is present (null), never dropped')

  // another tenant sees only its own row for the SAME run id — no cross-tenant read
  const foreignTimeline = await registry.listProvenanceByRun({ tenantId: 'tenant_other', workspaceId: null, runId: 'id_4' })
  assert.deepEqual(foreignTimeline.map(entry => entry.rowId), ['leak'],
    'the foreign tenant reads only its own row, never tenant_1\'s events')

  // limit: caller value passes through, above the ceiling it is clamped, junk falls back
  await registry.listProvenanceByRun({ tenantId: 'tenant_1', workspaceId: null, runId: 'id_4', limit: 5 })
  assert.equal(db.calls.filter(c => c[0] === 'select' && c[1] === 'integration_provenance_by_row').pop()[2].limit, 5,
    'a small caller limit passes through unchanged')
  await registry.listProvenanceByRun({ tenantId: 'tenant_1', workspaceId: null, runId: 'id_4', limit: 100000 })
  assert.equal(db.calls.filter(c => c[0] === 'select' && c[1] === 'integration_provenance_by_row').pop()[2].limit,
    __internals.PROVENANCE_BY_RUN_LIMIT_MAX, 'an oversized caller limit is clamped to the ceiling')
  for (const junk of [0, -1, '50', 1.5, null]) {
    await registry.listProvenanceByRun({ tenantId: 'tenant_1', workspaceId: null, runId: 'id_4', limit: junk })
    assert.equal(db.calls.filter(c => c[0] === 'select' && c[1] === 'integration_provenance_by_row').pop()[2].limit,
      __internals.PROVENANCE_BY_RUN_LIMIT_DEFAULT, `a non-positive-integer limit (${JSON.stringify(junk)}) falls back to the default`)
  }

  // input validation short-circuits before any db call
  const provSelectsBefore = db.calls.filter(call => call[0] === 'select' && call[1] === 'integration_provenance_by_row').length
  for (const badInput of [{ tenantId: 'tenant_1', workspaceId: null }, { workspaceId: null, runId: 'id_4' }, undefined]) {
    let bad = null
    try {
      await registry.listProvenanceByRun(badInput)
    } catch (error) {
      bad = error
    }
    assert.ok(bad instanceof PipelineValidationError, `listProvenanceByRun rejects ${JSON.stringify(badInput)} before the db`)
  }
  assert.equal(db.calls.filter(call => call[0] === 'select' && call[1] === 'integration_provenance_by_row').length, provSelectsBefore,
    'validation failures issue no view select')

  // the by-ROW read is untouched: rowId is still mandatory there (Q4a added a route, it did not
  // widen the existing cross-run read).
  let byRowMissingRowId = null
  try {
    await registry.listProvenanceByRow({ tenantId: 'tenant_1', workspaceId: null })
  } catch (error) {
    byRowMissingRowId = error
  }
  assert.ok(byRowMissingRowId instanceof PipelineValidationError, 'listProvenanceByRow still requires rowId')

  let badCounter = null
  try {
    await registry.updatePipelineRun({
      tenantId: 'tenant_1',
      id: 'id_4',
      status: 'failed',
      rowsFailed: -1,
    })
  } catch (error) {
    badCounter = error
  }
  assert.ok(badCounter instanceof PipelineValidationError, 'negative run counters rejected')

  db.tables.get('integration_pipelines')[0].status = 'disabled'
  let disabledRun = null
  try {
    await registry.createPipelineRun({
      tenantId: 'tenant_1',
      pipelineId: 'id_1',
      mode: 'manual',
      triggeredBy: 'manual',
    })
  } catch (error) {
    disabledRun = error
  }
  assert.ok(disabledRun instanceof PipelineValidationError, 'disabled pipeline cannot create runs')

  // re-enable pipeline for remaining tests
  db.tables.get('integration_pipelines')[0].status = 'active'

  // --- 9. Concurrent run guard -------------------------------------------
  // Seed a 'running' run to simulate an in-progress execution
  db.seed('integration_runs', [{
    id: 'run_in_progress',
    tenant_id: 'tenant_1',
    workspace_id: null,
    pipeline_id: 'id_1',
    status: 'running',
    started_at: new Date().toISOString(),
  }])

  let conflictError = null
  try {
    await registry.createPipelineRun({
      tenantId: 'tenant_1',
      workspaceId: null,
      pipelineId: 'id_1',
      mode: 'manual',
      triggeredBy: 'api',
    })
  } catch (error) {
    conflictError = error
  }
  assert.ok(conflictError instanceof PipelineConflictError, 'concurrent run rejected with PipelineConflictError')
  assert.equal(conflictError.details.runningRunId, 'run_in_progress', 'conflict error includes the blocking run ID')
  assert.ok(conflictError.message.includes('already has a run'), 'conflict error message is descriptive')

  // A terminated run must not block future runs
  db.tables.get('integration_runs').find(r => r.id === 'run_in_progress').status = 'succeeded'
  const afterTerminal = await registry.createPipelineRun({
    tenantId: 'tenant_1',
    workspaceId: null,
    pipelineId: 'id_1',
    mode: 'manual',
    triggeredBy: 'api',
  })
  assert.ok(afterTerminal.id, 'new run allowed once previous run terminates')

  // A running run for a DIFFERENT pipeline must not block this pipeline
  db.seed('integration_runs', [{
    id: 'run_other_pipeline',
    tenant_id: 'tenant_1',
    workspace_id: null,
    pipeline_id: 'id_2',
    status: 'running',
    started_at: new Date().toISOString(),
  }])
  const unrelatedPipelineRun = await registry.createPipelineRun({
    tenantId: 'tenant_1',
    workspaceId: null,
    pipelineId: 'id_1',
    mode: 'manual',
    triggeredBy: 'api',
  })
  assert.ok(unrelatedPipelineRun.id, 'running run on other pipeline does not block this pipeline')

  // The guard must serialize the check+insert critical section in-process.
  // Without the keyed lock, both calls below can snapshot "no running rows" before
  // either insert happens, allowing two concurrent running runs for one pipeline.
  {
    const raceDb = createMockDb()
    raceDb.seed('integration_pipelines', [{
      id: 'pipe_race',
      tenant_id: 'tenant_1',
      workspace_id: null,
      status: 'active',
    }])
    const originalSelect = raceDb.select.bind(raceDb)
    let releaseSelect
    const selectGate = new Promise((resolve) => {
      releaseSelect = resolve
    })
    raceDb.select = async (table, options = {}) => {
      if (table === 'integration_runs' && options.where && options.where.status === 'running') {
        const snapshot = await originalSelect(table, options)
        await selectGate
        return snapshot
      }
      return originalSelect(table, options)
    }
    const raceRegistry = createPipelineRegistry({
      db: raceDb,
      idGenerator: createIdGenerator(),
    })
    const first = raceRegistry.createPipelineRun({
      tenantId: 'tenant_1',
      workspaceId: null,
      pipelineId: 'pipe_race',
      mode: 'manual',
      triggeredBy: 'api',
      status: 'running',
      startedAt: new Date().toISOString(),
    })
    const second = raceRegistry.createPipelineRun({
      tenantId: 'tenant_1',
      workspaceId: null,
      pipelineId: 'pipe_race',
      mode: 'manual',
      triggeredBy: 'api',
      status: 'running',
      startedAt: new Date().toISOString(),
    })
    await new Promise((resolve) => setImmediate(resolve))
    releaseSelect()
    const results = await Promise.allSettled([first, second])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1, 'only one concurrent run starts')
    const rejected = results.find((result) => result.status === 'rejected')
    assert.ok(rejected && rejected.reason instanceof PipelineConflictError, 'second concurrent run sees conflict')
    const runningRows = raceDb.tables.get('integration_runs').filter((row) => row.pipeline_id === 'pipe_race' && row.status === 'running')
    assert.equal(runningRows.length, 1, 'only one running row is inserted for the pipeline')
  }

  // A DB-level unique violation from a different process is also normalized to
  // PipelineConflictError. This covers the distributed race that an in-process
  // lock cannot serialize.
  {
    const dbRace = createMockDb()
    dbRace.seed('integration_pipelines', [{
      id: 'pipe_db_race',
      tenant_id: 'tenant_1',
      workspace_id: null,
      status: 'active',
    }])
    const originalInsert = dbRace.insertOne.bind(dbRace)
    const uniqueViolation = new Error(`duplicate key value violates unique constraint "${__internals.RUNNING_RUN_UNIQUE_INDEX}"`)
    uniqueViolation.code = '23505'
    uniqueViolation.constraint = __internals.RUNNING_RUN_UNIQUE_INDEX
    assert.equal(__internals.isRunningRunUniqueViolation(uniqueViolation), true,
      'running-run unique violation is recognized by constraint name')

    dbRace.insertOne = async (table, row) => {
      if (table === 'integration_runs') {
        dbRace.seed('integration_runs', [{
          id: 'run_other_node',
          tenant_id: row.tenant_id,
          workspace_id: row.workspace_id,
          pipeline_id: row.pipeline_id,
          status: 'running',
          started_at: new Date().toISOString(),
        }])
        throw uniqueViolation
      }
      return originalInsert(table, row)
    }
    const dbRaceRegistry = createPipelineRegistry({
      db: dbRace,
      idGenerator: createIdGenerator(),
    })
    const dbConflict = await dbRaceRegistry.createPipelineRun({
      tenantId: 'tenant_1',
      workspaceId: null,
      pipelineId: 'pipe_db_race',
      mode: 'manual',
      triggeredBy: 'api',
      status: 'running',
      startedAt: new Date().toISOString(),
    }).catch((error) => error)
    assert.ok(dbConflict instanceof PipelineConflictError, 'DB unique violation maps to PipelineConflictError')
    assert.equal(dbConflict.details.runningRunId, 'run_other_node',
      'conflict details include the run inserted by the other process')
    assert.equal(dbConflict.details.constraint, __internals.RUNNING_RUN_UNIQUE_INDEX,
      'conflict details include the enforcing DB constraint')
  }

  // --- 10. abandonStaleRuns -----------------------------------------------
  // Clean up runs table; seed one stale running run and one fresh running run
  db.tables.set('integration_runs', [])
  const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString()
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  db.seed('integration_runs', [
    {
      id: 'stale_run',
      tenant_id: 'tenant_1',
      workspace_id: null,
      pipeline_id: 'id_1',
      status: 'running',
      started_at: fiveHoursAgo,
    },
    {
      id: 'fresh_run',
      tenant_id: 'tenant_1',
      workspace_id: null,
      pipeline_id: 'id_1',
      status: 'running',
      started_at: thirtyMinutesAgo,
    },
    {
      id: 'other_tenant_stale',
      tenant_id: 'tenant_2',
      workspace_id: null,
      pipeline_id: 'id_1',
      status: 'running',
      started_at: fiveHoursAgo,
    },
  ])

  const abandoned = await registry.abandonStaleRuns({
    tenantId: 'tenant_1',
    workspaceId: null,
  })
  assert.equal(abandoned.length, 1, 'only the stale run is abandoned')
  assert.equal(abandoned[0].id, 'stale_run', 'abandoned run ID matches')
  assert.equal(abandoned[0].status, 'failed', 'abandoned run status is failed')
  assert.ok(abandoned[0].finishedAt, 'abandoned run has finishedAt')

  // The fresh run and other-tenant run must be untouched
  const stillRunning = db.tables.get('integration_runs').find(r => r.id === 'fresh_run')
  assert.equal(stillRunning.status, 'running', 'fresh run is not abandoned')
  const otherTenantRun = db.tables.get('integration_runs').find(r => r.id === 'other_tenant_stale')
  assert.equal(otherTenantRun.status, 'running', 'other-tenant stale run is not affected')

  // abandonStaleRuns with a custom olderThanMs: threshold of 1h abandons the 30-min-old run too
  db.tables.get('integration_runs').find(r => r.id === 'fresh_run').status = 'running'
  const abandonedShortWindow = await registry.abandonStaleRuns({
    tenantId: 'tenant_1',
    workspaceId: null,
    olderThanMs: 15 * 60 * 1000, // 15 minutes
  })
  assert.equal(abandonedShortWindow.length, 1, 'short threshold abandons the 30-min-old run')
  assert.equal(abandonedShortWindow[0].id, 'fresh_run', 'correct run abandoned with short threshold')

  console.log('✓ pipelines: registry + endpoint + field-mapping + run-ledger + concurrent-guard + stale-run-cleanup tests passed')
}

main().catch((err) => {
  console.error('✗ pipelines FAILED')
  console.error(err)
  process.exit(1)
})
