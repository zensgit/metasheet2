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
      { sourceField: 'code', targetField: 'FNumber', sortOrder: 0 },
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
  assert.ok(db.calls.some(([name]) => name === 'transaction'), 'field mapping writes are transactional')

  // --- 2. getPipeline returns mappings and safe definition shape ---------
  const fetched = await registry.getPipeline({ tenantId: 'tenant_1', workspaceId: null, id: 'id_1' })
  assert.equal(fetched.id, 'id_1')
  assert.equal(fetched.fieldMappings.length, 2)
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

  const runs = await registry.listPipelineRuns({ tenantId: 'tenant_1', workspaceId: null, pipelineId: 'id_1', status: 'succeeded' })
  assert.equal(runs.length, 1)
  assert.equal(runs[0].id, 'id_4')

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
