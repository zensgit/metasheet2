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

  function matchesRange(row, range) {
    return Object.entries(range || {}).every(([key, spec]) => {
      if (spec.gte !== undefined && spec.gte !== null && !(row[key] >= spec.gte)) return false
      if (spec.lte !== undefined && spec.lte !== null && !(row[key] <= spec.lte)) return false
      return true
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
      // `range` mirrors db.cjs buildRangeClause: inclusive gte/lte bounds, nothing else.
      const filtered = tableRows(table).filter(row => matchesWhere(row, options.where || {})
        && matchesRange(row, options.range))
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
    async countRows(table, where) {
      calls.push(['countRows', table, { ...where }])
      return tableRows(table).filter(row => matchesWhere(row, where || {})).length
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

  const runPage = await registry.listProvenanceByRun({ tenantId: 'tenant_1', workspaceId: null, runId: 'id_4' })
  assert.deepEqual(Object.keys(runPage).sort(), ['items', 'nextCursor', 'total', 'truncated'],
    'listProvenanceByRun answers a page envelope, never a bare array')
  const runTimeline = runPage.items
  assert.deepEqual(runTimeline.map(entry => entry.eventIndex), [1, 2],
    'listProvenanceByRun returns the run timeline ordered by event_index')
  assert.deepEqual(runTimeline.map(entry => entry.rowId), ['k1', 'k1'],
    'only the requested run\'s rows are returned (no other run, no other tenant, no other workspace)')
  assert.deepEqual(
    Object.keys(runTimeline[0]).sort(),
    __internals.PROVENANCE_TIMELINE_ENTRY_FIELDS.slice().sort(),
    'listProvenanceByRun projects exactly the frozen timeline entry fields (same rowToProvenanceEntry as by-row)',
  )
  assert.deepEqual({ total: runPage.total, truncated: runPage.truncated, nextCursor: runPage.nextCursor },
    { total: 2, truncated: false, nextCursor: null },
    'a two-event run is disclosed as complete: total 2, not truncated, no cursor (the foreign-scope rows are not counted)')
  const byRunSelect = db.calls.filter(call => call[0] === 'select' && call[1] === 'integration_provenance_by_row').pop()
  assert.deepEqual(byRunSelect[2].where, { tenant_id: 'tenant_1', workspace_id: null, run_id: 'id_4' },
    'listProvenanceByRun WHERE carries tenant_id + workspace_id + run_id (drop tenant_id and the cross-tenant row leaks)')
  assert.deepEqual(byRunSelect[2].orderBy, ['event_index', 'ASC'], 'ordered by event_index ASC at the DB')
  assert.equal(byRunSelect[2].limit, __internals.PROVENANCE_BY_RUN_LIMIT_DEFAULT + 1,
    'no caller limit → the server-held default page size, plus the one-row look-ahead')
  assert.equal(byRunSelect[2].range, undefined, 'the first page carries no keyset range')
  const byRunCount = db.calls.filter(call => call[0] === 'countRows' && call[1] === 'integration_provenance_by_row').pop()
  assert.deepEqual(byRunCount[2], { tenant_id: 'tenant_1', workspace_id: null, run_id: 'id_4' },
    'total is counted under the SAME three-key WHERE as the page (drop a key and foreign events inflate it)')

  // omitted workspaceId normalizes to null exactly like the by-row read and the run reads
  await registry.listProvenanceByRun({ tenantId: 'tenant_1', runId: 'id_4' })
  const omittedWsByRun = db.calls.filter(call => call[0] === 'select' && call[1] === 'integration_provenance_by_row').pop()
  assert.equal(omittedWsByRun[2].where.workspace_id, null, 'omitted workspaceId is pinned to null in the WHERE')
  assert.ok('workspace_id' in omittedWsByRun[2].where, 'workspace_id key is present (null), never dropped')

  // another tenant sees only its own row for the SAME run id — no cross-tenant read
  const foreignPage = await registry.listProvenanceByRun({ tenantId: 'tenant_other', workspaceId: null, runId: 'id_4' })
  assert.deepEqual(foreignPage.items.map(entry => entry.rowId), ['leak'],
    'the foreign tenant reads only its own row, never tenant_1\'s events')
  assert.equal(foreignPage.total, 1, 'the foreign tenant\'s total counts only its own row')

  // limit: caller value passes through, above the ceiling it is clamped, junk falls back (each
  // plus the one-row look-ahead the registry adds to decide `truncated`)
  await registry.listProvenanceByRun({ tenantId: 'tenant_1', workspaceId: null, runId: 'id_4', limit: 5 })
  assert.equal(db.calls.filter(c => c[0] === 'select' && c[1] === 'integration_provenance_by_row').pop()[2].limit, 5 + 1,
    'a small caller limit passes through unchanged')
  await registry.listProvenanceByRun({ tenantId: 'tenant_1', workspaceId: null, runId: 'id_4', limit: 100000 })
  assert.equal(db.calls.filter(c => c[0] === 'select' && c[1] === 'integration_provenance_by_row').pop()[2].limit,
    __internals.PROVENANCE_BY_RUN_LIMIT_MAX + 1, 'an oversized caller limit is clamped to the ceiling')
  for (const junk of [0, -1, '50', 1.5, null]) {
    await registry.listProvenanceByRun({ tenantId: 'tenant_1', workspaceId: null, runId: 'id_4', limit: junk })
    assert.equal(db.calls.filter(c => c[0] === 'select' && c[1] === 'integration_provenance_by_row').pop()[2].limit,
      __internals.PROVENANCE_BY_RUN_LIMIT_DEFAULT + 1, `a non-positive-integer limit (${JSON.stringify(junk)}) falls back to the default`)
  }

  // input validation short-circuits before any db call — including a malformed cursor, which is
  // REFUSED (not ignored): silently restarting at page one would re-serve events a "load more"
  // caller already holds.
  const provSelectsBefore = db.calls.filter(call => call[0] === 'select' && call[1] === 'integration_provenance_by_row').length
  const provCountsBefore = db.calls.filter(call => call[0] === 'countRows' && call[1] === 'integration_provenance_by_row').length
  for (const badInput of [
    { tenantId: 'tenant_1', workspaceId: null },
    { workspaceId: null, runId: 'id_4' },
    undefined,
    { tenantId: 'tenant_1', workspaceId: null, runId: 'id_4', cursor: 'abc' },
    { tenantId: 'tenant_1', workspaceId: null, runId: 'id_4', cursor: '-1' },
    { tenantId: 'tenant_1', workspaceId: null, runId: 'id_4', cursor: '1.5' },
    { tenantId: 'tenant_1', workspaceId: null, runId: 'id_4', cursor: -1 },
    { tenantId: 'tenant_1', workspaceId: null, runId: 'id_4', cursor: ['1'] },
    // f-prov200 review r2: the registry refuses on its OWN every shape the route refuses, rather
    // than relying on the route having checked first — exponent, hex, sign, surrounding space,
    // whitespace-only, and more than 15 digits (even when the value is still a safe integer).
    ...['1e3', '0x10', '+1', ' 1', '1 ', ' ', '1_000', '1234567890123456', '12345678901234567890']
      .map(cursor => ({ tenantId: 'tenant_1', workspaceId: null, runId: 'id_4', cursor })),
    // ...and every non-string shape that is not a non-negative safe integer.
    ...[1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, true, {}]
      .map(cursor => ({ tenantId: 'tenant_1', workspaceId: null, runId: 'id_4', cursor })),
  ]) {
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
  assert.equal(db.calls.filter(call => call[0] === 'countRows' && call[1] === 'integration_provenance_by_row').length, provCountsBefore,
    'validation failures issue no count')
  // ...while every cursor the route lets through is accepted here too (the two rules agree at the
  // edges): '0', leading zeros, and the widest 15-digit value, each as a keyset strictly after it.
  for (const [goodCursor, gte] of [['0', 1], ['007', 8], ['999999999999999', 1000000000000000], [0, 1], [42, 43]]) {
    await registry.listProvenanceByRun({ tenantId: 'tenant_1', workspaceId: null, runId: 'id_4', cursor: goodCursor })
    assert.deepEqual(db.calls.filter(call => call[0] === 'select' && call[1] === 'integration_provenance_by_row').pop()[2].range,
      { event_index: { gte } }, `cursor ${JSON.stringify(goodCursor)} is accepted as "strictly after ${gte - 1}"`)
  }

  // --- 8e. f-prov200: the 199 / 200 / 201 boundary of the default page -----------------------
  // One run per size, seeded out of order and next to a same-run-id row under ANOTHER tenant, so
  // total/truncated are checked against a scope that has something to leak. The default page is
  // PROVENANCE_BY_RUN_LIMIT_DEFAULT (200): 199 and 200 are the whole timeline, 201 is not.
  assert.equal(__internals.PROVENANCE_BY_RUN_LIMIT_DEFAULT, 200, 'the boundary below is written against a 200 default')
  function boundaryRows(runId, tenantId, count) {
    const rows = []
    for (let index = count; index >= 1; index -= 1) {
      rows.push({
        tenant_id: tenantId, workspace_id: null, pipeline_id: 'id_1', run_id: runId, run_mode: 'full',
        run_status: 'partial', run_created_at: '2026-04-25T00:00:00.000Z', event_index: index,
        row_id: `${runId}-row-${index}`, event_type: 'row_cleaned', event_at: '2026-04-25T00:00:01.000Z', attrs: {},
      })
    }
    return rows
  }
  for (const size of [199, 200, 201]) {
    const runId = `boundary_run_${size}`
    db.seed('integration_provenance_by_row', boundaryRows(runId, 'tenant_1', size))
    db.seed('integration_provenance_by_row', boundaryRows(runId, 'tenant_other', 3))
  }

  const page199 = await registry.listProvenanceByRun({ tenantId: 'tenant_1', workspaceId: null, runId: 'boundary_run_199' })
  assert.equal(page199.items.length, 199, '199 events: all 199 returned')
  assert.deepEqual({ total: page199.total, truncated: page199.truncated, nextCursor: page199.nextCursor },
    { total: 199, truncated: false, nextCursor: null }, '199 events: total 199, NOT truncated')

  const page200 = await registry.listProvenanceByRun({ tenantId: 'tenant_1', workspaceId: null, runId: 'boundary_run_200' })
  assert.equal(page200.items.length, 200, '200 events: all 200 returned')
  assert.deepEqual({ total: page200.total, truncated: page200.truncated, nextCursor: page200.nextCursor },
    { total: 200, truncated: false, nextCursor: null },
    '200 events (exactly one full page): total 200, NOT truncated — the look-ahead finds nothing')

  const page201 = await registry.listProvenanceByRun({ tenantId: 'tenant_1', workspaceId: null, runId: 'boundary_run_201' })
  assert.equal(page201.items.length, 200, '201 events: the first page holds 200')
  assert.deepEqual(page201.items.map(entry => entry.eventIndex), Array.from({ length: 200 }, (_, i) => i + 1),
    '201 events: the first page is events #1..#200 in order (the look-ahead row is not returned)')
  assert.deepEqual({ total: page201.total, truncated: page201.truncated, nextCursor: page201.nextCursor },
    { total: 201, truncated: true, nextCursor: '200' },
    '201 events: total 201, truncated, nextCursor = the last returned eventIndex')

  const page201b = await registry.listProvenanceByRun({
    tenantId: 'tenant_1', workspaceId: null, runId: 'boundary_run_201', cursor: page201.nextCursor,
  })
  const page201bSelect = db.calls.filter(call => call[0] === 'select' && call[1] === 'integration_provenance_by_row').pop()
  assert.deepEqual(page201bSelect[2].range, { event_index: { gte: 201 } },
    'the cursor becomes a keyset lower bound strictly after the last event already returned')
  assert.deepEqual(page201bSelect[2].where, { tenant_id: 'tenant_1', workspace_id: null, run_id: 'boundary_run_201' },
    'a cursor page keeps the same three-key WHERE (a cursor never widens the scope)')
  assert.deepEqual(page201b.items.map(entry => entry.eventIndex), [201], 'page two holds exactly the one remaining event')
  assert.deepEqual({ total: page201b.total, truncated: page201b.truncated, nextCursor: page201b.nextCursor },
    { total: 201, truncated: false, nextCursor: null },
    'page two: total is still the whole run (201), and the timeline is now complete')
  const stitched = page201.items.concat(page201b.items).map(entry => entry.eventIndex)
  assert.deepEqual(stitched, Array.from({ length: 201 }, (_, i) => i + 1),
    'first page + cursor page = every event exactly once (no skip, no repeat)')

  // a cursor past the end is an empty, complete page — not an error and not page one again
  const pastEnd = await registry.listProvenanceByRun({
    tenantId: 'tenant_1', workspaceId: null, runId: 'boundary_run_201', cursor: '201',
  })
  assert.deepEqual({ items: pastEnd.items.length, total: pastEnd.total, truncated: pastEnd.truncated, nextCursor: pastEnd.nextCursor },
    { items: 0, total: 201, truncated: false, nextCursor: null }, 'a cursor past the last event answers an empty final page')

  // an explicit small limit pages the same run in fixed steps and still discloses correctly
  const small = await registry.listProvenanceByRun({
    tenantId: 'tenant_1', workspaceId: null, runId: 'boundary_run_199', limit: 50, cursor: '150',
  })
  assert.deepEqual({ first: small.items[0].eventIndex, count: small.items.length, total: small.total, truncated: small.truncated, nextCursor: small.nextCursor },
    { first: 151, count: 49, total: 199, truncated: false, nextCursor: null },
    'limit 50 after #150 of 199: the last 49 events, complete')
  const smallMid = await registry.listProvenanceByRun({
    tenantId: 'tenant_1', workspaceId: null, runId: 'boundary_run_199', limit: 50, cursor: '100',
  })
  assert.deepEqual({ count: smallMid.items.length, truncated: smallMid.truncated, nextCursor: smallMid.nextCursor },
    { count: 50, truncated: true, nextCursor: '150' }, 'limit 50 after #100 of 199: a full page, truncated, cursor #150')

  // A run whose event_index has a HOLE. The migration-060 view drops non-object slots of the
  // persisted array, so ordinals can skip. Every fixture above is contiguous (1..N), where "the
  // last returned eventIndex" and "cursor + items returned" are the same number and an offset-style
  // cursor would pass unnoticed. Here #100 is missing (#1..#99, #101..#202 = 201 events), so the two
  // differ: an offset cursor would say 200 and re-serve #201 on the next page.
  const gappedRows = boundaryRows('gapped_run', 'tenant_1', 202).filter((row) => row.event_index !== 100)
  db.seed('integration_provenance_by_row', gappedRows)
  const gappedIndexes = gappedRows.map((row) => row.event_index).sort((a, b) => a - b)
  const gapPage1 = await registry.listProvenanceByRun({ tenantId: 'tenant_1', workspaceId: null, runId: 'gapped_run' })
  assert.equal(gapPage1.items.length, 200, 'gapped run: the first page holds 200 events')
  assert.equal(gapPage1.items[gapPage1.items.length - 1].eventIndex, 201,
    'gapped run: the 200th event is #201 (the hole at #100 shifts every later ordinal)')
  assert.deepEqual({ total: gapPage1.total, truncated: gapPage1.truncated, nextCursor: gapPage1.nextCursor },
    { total: 201, truncated: true, nextCursor: '201' },
    'gapped run: nextCursor is the last RETURNED eventIndex (201), not an offset (200)')
  const gapPage2 = await registry.listProvenanceByRun({
    tenantId: 'tenant_1', workspaceId: null, runId: 'gapped_run', cursor: gapPage1.nextCursor,
  })
  const gapPage2Select = db.calls.filter(call => call[0] === 'select' && call[1] === 'integration_provenance_by_row').pop()
  assert.deepEqual(gapPage2Select[2].range, { event_index: { gte: 202 } },
    'gapped run: page two starts strictly after the last event page one returned')
  assert.deepEqual(gapPage2.items.map(entry => entry.eventIndex), [202], 'gapped run: page two is exactly the one remaining event')
  assert.deepEqual({ total: gapPage2.total, truncated: gapPage2.truncated, nextCursor: gapPage2.nextCursor },
    { total: 201, truncated: false, nextCursor: null }, 'gapped run: page two completes the timeline')
  assert.deepEqual(gapPage1.items.concat(gapPage2.items).map(entry => entry.eventIndex), gappedIndexes,
    'gapped run: first page + cursor page = every seeded event exactly once (no repeat, no skip across the hole)')
  // ...and from a mid-run cursor with a caller limit, the hole inside the page moves the cursor too.
  const gapMid = await registry.listProvenanceByRun({
    tenantId: 'tenant_1', workspaceId: null, runId: 'gapped_run', limit: 100, cursor: '50',
  })
  assert.deepEqual({ first: gapMid.items[0].eventIndex, count: gapMid.items.length, truncated: gapMid.truncated, nextCursor: gapMid.nextCursor },
    { first: 51, count: 100, truncated: true, nextCursor: '151' },
    'gapped run, limit 100 after #50: #51..#99 + #101..#151, cursor #151 (an offset cursor would say 150)')

  // a count the db layer cannot produce is a server fault, never "0 events"
  const brokenCountDb = createMockDb()
  brokenCountDb.seed('integration_provenance_by_row', boundaryRows('broken_count_run', 'tenant_1', 2))
  brokenCountDb.countRows = async () => undefined
  const brokenCountRegistry = createPipelineRegistry({ db: brokenCountDb, idGenerator: createIdGenerator() })
  let brokenCountError = null
  try {
    await brokenCountRegistry.listProvenanceByRun({ tenantId: 'tenant_1', workspaceId: null, runId: 'broken_count_run' })
  } catch (error) {
    brokenCountError = error
  }
  assert.ok(brokenCountError instanceof Error && /count unavailable/.test(brokenCountError.message),
    'an unusable count throws instead of disclosing a made-up total')

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
