'use strict'

// CUSTOMER-PACK INSTALL LEDGER — the persistence half of the executable surface.
//
// What this suite is actually defending:
//
//   1. TERMINAL-ONLY. There is no representable 'pending' row, and the installer writes the ledger
//      as its LAST act — so a crash anywhere in the install leaves NO row at all. That is what makes
//      "no row means nothing landed" true and a retry safe. The negative control (an install that
//      throws at the last host call) is the load-bearing test here, not the happy path.
//   2. DERIVED STATUS. warnings.length === 0 ? 'installed' : 'partial', the after-sales rule.
//   3. UPSERT IDEMPOTENCE. A re-install refreshes ONE row on (tenant, project, object, pack) and
//      keeps the row's original id, rather than appending install history.
//   4. THE OWNERSHIP JOIN. The install summary buckets ids by ACTION TAKEN; the ledger needs them
//      by OWNERSHIP BAND. Those are different axes and only the pack knows the second.
//   5. VALUES-FREE BY CONSTRUCTION. The store's guards reject anything that is not an id, a frozen
//      ownership token, a boolean, a finite number or an enum-shaped token — and reject WITHOUT
//      echoing the offending value.
//   6. OPTIONAL. No store supplied → byte-identical to the pre-ledger installer.
//
// Hermetic: no DB, no network, no clock. The fake db implements the two primitives the store uses
// (upsertOne / select) with real conflict-key semantics, so idempotence is proven against the same
// keying the migration's UNIQUE index declares.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const {
  PACK_INSTALL_TABLE,
  PACK_INSTALL_STATUSES,
  StockPreparationPackInstallError,
  createStockPreparationPackInstallStore,
} = require(path.join(LIB, 'stock-preparation-pack-install-store.cjs'))

const {
  installCustomerPack,
  StockPreparationCustomerPackInstallError,
} = require(path.join(LIB, 'stock-preparation-customer-pack-installer.cjs'))

const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require(path.join(LIB, 'stock-preparation-templates.cjs'))

const PROJECT_ID = 'tenant-a:integration-core'
const TENANT_ID = 'tenant-a'
const OBJECT_ID = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

// The two db primitives the store uses, with the migration's UNIQUE key enforced for real so
// "idempotent" is a fact about the same conflict target Postgres would use.
function createFakeDb() {
  const rows = new Map()
  const calls = []
  function keyOf(row, conflictColumns) {
    return conflictColumns.map((column) => String(row[column])).join('\u0000')
  }
  return {
    calls,
    rows,
    async upsertOne(table, row, { conflictColumns, updateColumns } = {}) {
      calls.push(['upsertOne', table, row, conflictColumns, updateColumns])
      assert.equal(table, PACK_INSTALL_TABLE)
      assert.ok(Array.isArray(conflictColumns) && conflictColumns.length > 0, 'upsert must be keyed')
      const key = keyOf(row, conflictColumns)
      const existing = rows.get(key)
      if (!existing) {
        const created = { ...row, last_install_at: `t${rows.size + 1}`, created_at: `t${rows.size + 1}` }
        rows.set(key, created)
        return [created]
      }
      const updated = { ...existing }
      for (const column of updateColumns || Object.keys(row)) {
        if (conflictColumns.includes(column)) continue
        // EXCLUDED semantics: a column the INSERT omitted carries the proposed row's default.
        updated[column] = Object.prototype.hasOwnProperty.call(row, column) ? row[column] : `t${calls.length}`
      }
      rows.set(key, updated)
      return [updated]
    },
    async select(table, { where, limit } = {}) {
      calls.push(['select', table, where, limit])
      assert.equal(table, PACK_INSTALL_TABLE)
      return [...rows.values()].filter((row) =>
        Object.entries(where || {}).every(([column, value]) => row[column] === value))
    },
  }
}

let idSeq = 0
function newStore(db) {
  idSeq = 0
  return createStockPreparationPackInstallStore({ db, idGenerator: () => `ledger_${++idSeq}` })
}

const BASE_SCOPE = Object.freeze({
  tenantId: TENANT_ID,
  projectId: PROJECT_ID,
  objectId: OBJECT_ID,
  packId: 'suite-pack',
  packVersion: '1',
})

const PLM_FIELD = Object.freeze({
  fieldId: 'ext_legacyRowId',
  ownership: 'plm_system',
  preserveOnRefresh: false,
  extension: true,
})
const HUMAN_FIELD = Object.freeze({
  fieldId: 'ext_blankLength',
  ownership: 'human_preserved',
  preserveOnRefresh: true,
  extension: true,
})

// The smallest pack that still exercises BOTH ownership bands — the join is the whole point.
const SUITE_PACK = Object.freeze({
  packId: 'suite-pack',
  packVersion: 1,
  label: 'ledger suite pack',
  extensionFields: [
    { id: 'ext_legacyRowId', label: 'legacy id', type: 'string', ownership: 'plm_system' },
    { id: 'ext_plmObjectId', label: 'plm id', type: 'string', ownership: 'plm_system' },
    { id: 'ext_blankLength', label: 'blank length', type: 'number', ownership: 'human_preserved' },
  ],
  optionSets: [],
  roleViews: [
    { viewId: 'production', label: 'production view', hideOwnerships: ['human_preserved'], hideFieldIds: [] },
  ],
})

function physicalFieldId(projectId, objectId, fieldId) {
  return `fld_${projectId}_${objectId}_${fieldId}`
}

// Enough of the host provisioning surface for a full install, with a switch for the failure the
// terminal-only invariant is actually about.
function createFakeProvisioning({ failAt } = {}) {
  const calls = []
  const existing = new Map()
  function maybeFail(method) {
    if (failAt === method) {
      const error = new Error(`fake host failure at ${method}`)
      error.code = 'FAKE_HOST_FAILURE'
      throw error
    }
  }
  return {
    calls,
    existing,
    async findObjectSheet({ objectId }) {
      calls.push(['findObjectSheet', objectId])
      maybeFail('findObjectSheet')
      return { id: `sheet_${objectId}`, baseId: null, name: objectId, description: null }
    },
    getFieldId(projectId, objectId, fieldId) {
      return physicalFieldId(projectId, objectId, fieldId)
    },
    async readObjectFieldsContent({ fieldIds }) {
      calls.push(['readObjectFieldsContent', [...fieldIds].sort()])
      maybeFail('readObjectFieldsContent')
      const out = {}
      for (const fieldId of fieldIds) {
        if (existing.has(fieldId)) out[fieldId] = existing.get(fieldId)
      }
      return out
    },
    async ensureMissingObjectFields({ projectId, objectId, fields }) {
      calls.push(['ensureMissingObjectFields', fields.map((field) => field.id)])
      maybeFail('ensureMissingObjectFields')
      const addedFieldIds = []
      const skippedExistingFieldIds = []
      for (const field of fields) {
        const physical = physicalFieldId(projectId, objectId, field.id)
        if (existing.has(field.id)) skippedExistingFieldIds.push(physical)
        else {
          existing.set(field.id, { name: field.name, type: field.type, property: field.property, order: field.order })
          addedFieldIds.push(physical)
        }
      }
      return { addedFieldIds, skippedExistingFieldIds }
    },
    async patchObjectFieldProperty({ fieldId, propertyPatch }) {
      calls.push(['patchObjectFieldProperty', fieldId])
      maybeFail('patchObjectFieldProperty')
      const current = existing.get(fieldId) || { name: fieldId, type: 'string', property: {}, order: 0 }
      existing.set(fieldId, {
        ...current,
        property: {
          ...current.property,
          stockPreparation: { ...(current.property.stockPreparation || {}), ...propertyPatch.stockPreparation },
        },
      })
      return { ok: true }
    },
    async ensureView({ descriptor }) {
      calls.push(['ensureView', descriptor.id])
      maybeFail('ensureView')
      return { id: `view_${descriptor.id}` }
    },
  }
}

const SILENT_LOGGER = { info() {}, warn() {} }

async function rejects(fn, code, message) {
  let error = null
  try { await fn() } catch (err) { error = err }
  assert.ok(error, `${message}: expected a rejection`)
  assert.equal(error.code, code, `${message}: expected code ${code}, got ${error.code}`)
  return error
}

// ---------------------------------------------------------------------------
// 1. terminal states + derived status
// ---------------------------------------------------------------------------

async function statusIsTerminalAndDerived() {
  const db = createFakeDb()
  const store = newStore(db)

  const clean = await store.recordInstall({ ...BASE_SCOPE, installedFields: [PLM_FIELD], warnings: [] })
  assert.equal(clean.status, 'installed', 'no warnings derives installed')
  assert.equal(clean.mode, 'install', 'mode defaults to install')

  const warned = await store.recordInstall({
    ...BASE_SCOPE,
    packId: 'suite-pack-2',
    installedFields: [PLM_FIELD],
    warnings: ['option_sync_skipped'],
  })
  assert.equal(warned.status, 'partial', 'a warning derives partial')

  const failed = await store.recordInstall({
    ...BASE_SCOPE,
    packId: 'suite-pack-3',
    status: 'failed',
    installedFields: [],
    warnings: [],
  })
  assert.equal(failed.status, 'failed', 'an explicit terminal status is honoured')

  // The vocabulary is exactly the three terminal states, and nothing outside it is writable.
  assert.deepEqual([...PACK_INSTALL_STATUSES], ['installed', 'partial', 'failed'])
  for (const nonTerminal of ['pending', 'installing', 'in_progress', 'INSTALLED', '']) {
    await rejects(
      () => store.recordInstall({ ...BASE_SCOPE, status: nonTerminal }),
      'PACK_INSTALL_STATUS_INVALID',
      `non-terminal status ${JSON.stringify(nonTerminal)}`,
    )
  }
  for (const badMode of ['enable', 'upgrade', 'INSTALL']) {
    await rejects(
      () => store.recordInstall({ ...BASE_SCOPE, mode: badMode }),
      'PACK_INSTALL_MODE_INVALID',
      `mode ${badMode}`,
    )
  }

  // Scope is mandatory: a row that cannot be attributed is not a row worth having.
  for (const missing of ['tenantId', 'projectId', 'objectId', 'packId', 'packVersion']) {
    const input = { ...BASE_SCOPE }
    delete input[missing]
    const error = await rejects(() => store.recordInstall(input), 'PACK_INSTALL_CONFIG_INVALID', `missing ${missing}`)
    assert.equal(error.details.field, missing)
  }
}

// ---------------------------------------------------------------------------
// 2. UPSERT idempotence
// ---------------------------------------------------------------------------

async function reinstallRefreshesOneRow() {
  const db = createFakeDb()
  const store = newStore(db)

  const first = await store.recordInstall({ ...BASE_SCOPE, installedFields: [PLM_FIELD], warnings: [] })
  const second = await store.recordInstall({
    ...BASE_SCOPE,
    packVersion: '2',
    mode: 'reinstall',
    installedFields: [PLM_FIELD, HUMAN_FIELD],
    warnings: [],
  })

  assert.equal(db.rows.size, 1, 'the identity key collapses a re-install onto one row')
  assert.equal(second.id, first.id, 'the row keeps the id it was first inserted with')
  assert.equal(second.packVersion, '2', 'a re-install refreshes the recorded version')
  assert.equal(second.mode, 'reinstall', 'mode records the last attempted mode')
  assert.equal(second.installedFields.length, 2)

  // The conflict target is exactly the migration's UNIQUE index.
  const upserts = db.calls.filter(([name]) => name === 'upsertOne')
  for (const [, , , conflictColumns] of upserts) {
    assert.deepEqual(conflictColumns, ['tenant_id', 'project_id', 'object_id', 'pack_id'])
  }

  // A different pack on the SAME sheet is a different row, not an overwrite.
  await store.recordInstall({ ...BASE_SCOPE, packId: 'other-pack', installedFields: [HUMAN_FIELD] })
  assert.equal(db.rows.size, 2)
  // …and so is the same pack in a different project.
  await store.recordInstall({ ...BASE_SCOPE, projectId: 'tenant-b:integration-core' })
  assert.equal(db.rows.size, 3)
}

// ---------------------------------------------------------------------------
// 3. values-free guards
// ---------------------------------------------------------------------------

async function ledgerRowsAreValuesFree() {
  const db = createFakeDb()
  const store = newStore(db)

  const badFields = [
    [[{ fieldId: 'ext_x', ownership: 'operator_owned', preserveOnRefresh: false, extension: true }], 'unrecognized ownership token'],
    [[{ fieldId: 'ext_x', ownership: 'plm_system', preserveOnRefresh: 'false', extension: true }], 'stringly preserveOnRefresh'],
    [[{ fieldId: 'ext_x', ownership: 'plm_system', preserveOnRefresh: false, extension: 'yes' }], 'stringly extension'],
    [[{ fieldId: 'ext_x', ownership: 'plm_system', preserveOnRefresh: false, extension: true, label: '毛胚长度' }], 'a label riding along'],
    [[{ fieldId: '名称及规格', ownership: 'plm_system', preserveOnRefresh: false, extension: true }], 'a business label as a field id'],
    [[PLM_FIELD, PLM_FIELD], 'duplicate field ids'],
    ['ext_x', 'a non-array'],
  ]
  for (const [installedFields, why] of badFields) {
    const error = await rejects(
      () => store.recordInstall({ ...BASE_SCOPE, installedFields }),
      'PACK_INSTALL_FIELDS_INVALID',
      why,
    )
    // The refusal names the PATH, never the offending value.
    assert.equal(JSON.stringify(error.details).includes('毛胚长度'), false, 'a rejection must not echo the value')
    assert.equal(JSON.stringify(error.details).includes('operator_owned'), false, 'a rejection must not echo the value')
  }

  // summary is arithmetic; a string of any shape is refused.
  for (const summary of [{ created: '3' }, { created: 3, note: 'ok' }, { created: Number.NaN }, ['created']]) {
    await rejects(() => store.recordInstall({ ...BASE_SCOPE, summary }), 'PACK_INSTALL_SUMMARY_INVALID', 'non-numeric summary')
  }
  // warnings are reason codes, never messages.
  for (const warnings of [['option sync failed for 毛胚长度'], [42], 'skipped']) {
    await rejects(() => store.recordInstall({ ...BASE_SCOPE, warnings }), 'PACK_INSTALL_WARNINGS_INVALID', 'free-text warning')
  }

  // The happy-path row itself carries nothing but ids, tokens, booleans and counts.
  const row = await store.recordInstall({
    ...BASE_SCOPE,
    installedFields: [PLM_FIELD, HUMAN_FIELD],
    summary: { created: 2, stamped: 0 },
    warnings: [],
  })
  const serialized = JSON.stringify(row)
  for (const leak of ['毛胚长度', '名称及规格', 'Q345R', '生产备料视图', 'password', 'https://']) {
    assert.equal(serialized.includes(leak), false, `ledger row must not contain ${leak}`)
  }
  assert.deepEqual(row.installedFields.map((entry) => Object.keys(entry).sort()), [
    ['extension', 'fieldId', 'ownership', 'preserveOnRefresh'],
    ['extension', 'fieldId', 'ownership', 'preserveOnRefresh'],
  ])
  assert.ok(StockPreparationPackInstallError)
}

// ---------------------------------------------------------------------------
// 4. the refresh read
// ---------------------------------------------------------------------------

async function installedFieldIdsSkipFailedRows() {
  const db = createFakeDb()
  const store = newStore(db)

  await store.recordInstall({ ...BASE_SCOPE, packId: 'pack-a', installedFields: [HUMAN_FIELD, PLM_FIELD] })
  await store.recordInstall({
    ...BASE_SCOPE,
    packId: 'pack-b',
    installedFields: [{ ...PLM_FIELD, fieldId: 'ext_plmObjectId' }, PLM_FIELD],
  })
  await store.recordInstall({
    ...BASE_SCOPE,
    packId: 'pack-failed',
    status: 'failed',
    installedFields: [{ ...PLM_FIELD, fieldId: 'ext_neverLanded' }],
  })

  const { fieldIds, packIds } = await store.listInstalledFieldIds({
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    objectId: OBJECT_ID,
  })
  // Sorted, de-duplicated across packs, and a FAILED row contributes nothing: its field list records
  // an attempt, never a live column.
  assert.deepEqual(fieldIds, ['ext_blankLength', 'ext_legacyRowId', 'ext_plmObjectId'])
  assert.deepEqual(packIds, ['pack-a', 'pack-b'])

  // Another sheet's rows never leak into this one's candidate set.
  const otherObject = await store.listInstalledFieldIds({
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    objectId: 'plm_stock_preparation_other',
  })
  assert.deepEqual(otherObject.fieldIds, [])

  const listed = await store.listInstalls({ tenantId: TENANT_ID, projectId: PROJECT_ID, objectId: OBJECT_ID })
  assert.equal(listed.rowCount, 3, 'the LIST read still shows the failed row (it is the retry signal)')
  const single = await store.getInstall({ ...BASE_SCOPE, packId: 'pack-a' })
  assert.equal(single.packId, 'pack-a')
  assert.equal(await store.getInstall({ ...BASE_SCOPE, packId: 'absent' }), null)
}

// ---------------------------------------------------------------------------
// 5. the installer writes it — and only after everything landed
// ---------------------------------------------------------------------------

async function installWritesTheLedgerLast() {
  const db = createFakeDb()
  const store = newStore(db)
  const provisioning = createFakeProvisioning()

  const summary = await installCustomerPack({
    provisioning,
    projectId: PROJECT_ID,
    pack: SUITE_PACK,
    logger: SILENT_LOGGER,
    packInstallStore: store,
    tenantId: TENANT_ID,
    workspaceId: 'workspace-default',
  })

  assert.equal(db.rows.size, 1)
  const row = await store.getInstall({ ...BASE_SCOPE, packVersion: '1' })
  assert.equal(row.status, 'installed')
  assert.equal(row.mode, 'install')
  assert.equal(row.objectId, OBJECT_ID)

  // THE JOIN: the summary buckets by action taken, the ledger by ownership band.
  assert.deepEqual(row.installedFields, [
    { fieldId: 'ext_blankLength', ownership: 'human_preserved', preserveOnRefresh: true, extension: true },
    { fieldId: 'ext_legacyRowId', ownership: 'plm_system', preserveOnRefresh: false, extension: true },
    { fieldId: 'ext_plmObjectId', ownership: 'plm_system', preserveOnRefresh: false, extension: true },
  ])
  // The four write-scope numbers are present even for a pack that declares no fieldWritePolicies —
  // all zero — so the ledger row's shape does not depend on whether the optional feature was used,
  // and "this install touched no permission" is readable from the row instead of inferred from an
  // absent key. They stay FLAT because the store's own values-free guard accepts finite numbers
  // only and would refuse a nested object outright.
  assert.deepEqual(row.summary, {
    created: 3, skipped: 0, stamped: 0, alreadyStamped: 0, optionFields: 0, views: 1,
    writeScopesApplied: 0, writeScopesRemoved: 0, writeScopeStale: 0, writeScopeRoles: 0,
    writeScopeOperatorHeld: 0, writeScopeOtherPacks: 0,
  })
  assert.deepEqual(row.warnings, [])
  // The returned summary reports the ledger outcome without re-serializing the row.
  assert.deepEqual(summary.ledger, {
    status: 'installed',
    mode: 'install',
    packId: 'suite-pack',
    packVersion: '1',
    objectId: OBJECT_ID,
    fieldCount: 3,
  })

  // A second install over the converged sheet: same one row, still terminal, created drops to 0.
  await installCustomerPack({
    provisioning,
    projectId: PROJECT_ID,
    pack: SUITE_PACK,
    logger: SILENT_LOGGER,
    packInstallStore: store,
    tenantId: TENANT_ID,
    mode: 'reinstall',
  })
  assert.equal(db.rows.size, 1, 'a re-install refreshes the row rather than appending one')
  const reinstalled = await store.getInstall({ ...BASE_SCOPE })
  assert.equal(reinstalled.mode, 'reinstall')
  assert.equal(reinstalled.summary.created, 0)
  assert.equal(reinstalled.summary.alreadyStamped, 3, 'the converged sheet re-runs to alreadyStamped')
  assert.equal(reinstalled.installedFields.length, 3, 'the field list is unchanged by the re-run')
}

// The load-bearing one: a crash BEFORE the ledger write must leave no row at all.
async function crashBeforeLedgerWriteLeavesNoRow() {
  for (const failAt of ['findObjectSheet', 'readObjectFieldsContent', 'ensureMissingObjectFields', 'ensureView']) {
    const db = createFakeDb()
    const store = newStore(db)
    const provisioning = createFakeProvisioning({ failAt })

    let error = null
    try {
      await installCustomerPack({
        provisioning,
        projectId: PROJECT_ID,
        pack: SUITE_PACK,
        logger: SILENT_LOGGER,
        packInstallStore: store,
        tenantId: TENANT_ID,
      })
    } catch (err) { error = err }

    assert.ok(error, `install must fail at ${failAt}`)
    // Most host failures are wrapped into the installer's own error; a findObjectSheet throw is not
    // (the precondition read has no wrapper today). Either way the ledger invariant is the same, so
    // the assertion below is what this loop is really about.
    if (failAt !== 'findObjectSheet') {
      assert.ok(error instanceof StockPreparationCustomerPackInstallError, `install error at ${failAt} is the installer's own`)
    }
    assert.equal(db.rows.size, 0, `a crash at ${failAt} must leave NO ledger row`)
    assert.equal(
      db.calls.filter(([name]) => name === 'upsertOne').length,
      0,
      `a crash at ${failAt} must not even attempt a ledger write (no pending row exists to write)`,
    )
  }
}

// A ledger that is asked for and cannot be written is an error, not a silent skip: the caller would
// otherwise go on planning refreshes against template bands while believing the pack is enumerable.
async function ledgerWriteFailureIsReported() {
  const provisioning = createFakeProvisioning()
  const exploding = {
    async recordInstall() {
      const error = new Error('ledger unavailable')
      error.code = 'LEDGER_DOWN'
      throw error
    },
  }
  const error = await rejects(
    () => installCustomerPack({
      provisioning,
      projectId: PROJECT_ID,
      pack: SUITE_PACK,
      logger: SILENT_LOGGER,
      packInstallStore: exploding,
      tenantId: TENANT_ID,
    }),
    'CUSTOMER_PACK_LEDGER_WRITE_FAILED',
    'ledger write failure',
  )
  assert.equal(error.status, 500)
  assert.equal(error.details.errorCode, 'LEDGER_DOWN')
  // The message says the columns DID land, because they did — the install is additive and a retry
  // is a no-op, so telling the operator otherwise would provoke the wrong recovery.
  assert.match(error.message, /re-install is safe and idempotent/)

  // A store object without the method is refused up front rather than half-used.
  await rejects(
    () => installCustomerPack({
      provisioning: createFakeProvisioning(),
      projectId: PROJECT_ID,
      pack: SUITE_PACK,
      logger: SILENT_LOGGER,
      packInstallStore: {},
      tenantId: TENANT_ID,
    }),
    'CUSTOMER_PACK_LEDGER_UNAVAILABLE',
    'store without recordInstall',
  )
}

// The optionality guarantee: no store → the pre-ledger behaviour, exactly.
async function absentStoreIsTodaysBehaviour() {
  const provisioning = createFakeProvisioning()
  const summary = await installCustomerPack({
    provisioning,
    projectId: PROJECT_ID,
    pack: SUITE_PACK,
    logger: SILENT_LOGGER,
  })
  assert.equal('ledger' in summary, false, 'no store → no ledger stanza on the summary')
  assert.equal(summary.createdFields.length, 3, 'and the install itself is unchanged')
  // installedFields is present regardless: it is the summary's own ownership projection (F5), not
  // the ledger's, so a caller without a ledger still gets the band per id.
  assert.equal(summary.installedFields.length, 3)
}

async function main() {
  await statusIsTerminalAndDerived()
  await reinstallRefreshesOneRow()
  await ledgerRowsAreValuesFree()
  await installedFieldIdsSkipFailedRows()
  await installWritesTheLedgerLast()
  await crashBeforeLedgerWriteLeavesNoRow()
  await ledgerWriteFailureIsReported()
  await absentStoreIsTodaysBehaviour()
}

main().then(
  () => {
    console.log('stock-preparation-pack-install-ledger.test.cjs OK')
  },
  (error) => {
    console.error(error)
    process.exit(1)
  },
)
