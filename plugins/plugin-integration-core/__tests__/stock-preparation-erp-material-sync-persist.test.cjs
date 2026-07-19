'use strict'

// #3751 stock-prep MVP T2 — persist ALREADY-NORMALIZED ERP/K3 material-master intake rows into the
// internal erp_material_master CACHE table. Covered:
//   (a) happy path — new materials CREATE, grounded to template field ids, run record created with
//       runType 'erp_material_sync' + status 'succeeded';
//   (b) idempotent re-run — replaying the SAME rows + SAME syncRunId PATCHES (refreshes) the material
//       rows (never a duplicate create) and leaves the run record unchanged (same status => no patch);
//   (c) refresh semantics — a field present on sync 1 but ABSENT on sync 2 is explicitly NULLED on the
//       patch (explicit-clear refresh, mirroring generation-runtime.cjs's prep-line pattern) — this is
//       a CACHE, not an immutable snapshot, and every field is plm_system (no human_preserved to protect);
//   (d) a row missing a required field (erpMaterialCode / erpMaterialInternalId / the key) is SKIPPED
//       and counted (never crashes the whole sync; run status flips to 'partial');
//   (e) admin-permission-denied — 403 BEFORE any provisioning / records access;
//   (f) target not provisioned (material OR run sheet) — fail closed, no writes;
//   (g) provisioning API unavailable (missing resolveFieldIds) — 503;
//   (h) values-free evidence — a planted SECRET erpMaterialName / erpSpec never reaches evidence;
//   (i) #4160 — every create/patch/query key is a resolved PHYSICAL fieldId, never a logical key;
//   (j) upsert key is DERIVED from the template's keyFields[0], never a hardcoded literal;
//   (k) THE OWNER-MANDATED downstream-consumption proof: after this module persists an ERP material,
//       stock-preparation-confirm-writes.cjs's syncMaterialMappingCandidates (its ONLY erpMaterials
//       input channel is queryAllRecords(materialTarget.scoped, {}) — it takes no material rows as a
//       parameter) reads the JUST-PERSISTED cache row and produces a mapping candidate referencing it.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  persistStockPreparationErpMaterialSync,
  StockPreparationErpMaterialSyncError,
  MATERIAL_OBJECT_ID,
  MATERIAL_KEY_FIELD,
  RUN_OBJECT_ID,
  RUN_KEY_FIELD,
  ERP_MATERIAL_SYNC_RUN_TYPE,
  __internals: { MVP_OBJECT_ID_SET, MATERIAL_FIELD_IDS },
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-erp-material-sync-persist.cjs'))
const {
  persistStockPreparationSyncRun,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-sync-run-persist.cjs'))
const {
  syncMaterialMappingCandidates,
  MAPPING_OBJECT_ID,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-confirm-writes.cjs'))
const {
  STOCK_PREPARATION_MVP_TABLE_TEMPLATES,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-templates.cjs'))
const {
  makeFakeProvisioning,
  makeStrictRecordsApi,
  physicalFieldId,
  logicalData,
} = require(path.join(__dirname, 'fixtures', 'stock-preparation-multitable-fakes.cjs'))

function objectIdByRole(role) {
  return STOCK_PREPARATION_MVP_TABLE_TEMPLATES.find((template) => template.role === role).objectId
}

const MATERIAL_SHEET_ID = `sheet_${MATERIAL_OBJECT_ID}`
const RUN_SHEET_ID = `sheet_${RUN_OBJECT_ID}`
const BATCH_OBJECT_ID = objectIdByRole('bom_snapshot_batch')
const LINE_OBJECT_ID = objectIdByRole('bom_snapshot_line')
const MAPPING_SHEET_ID = `sheet_${MAPPING_OBJECT_ID}`

// The MVP tables live under the INTERNAL staging project (parity with every sibling test file).
const STAGING_PROJECT_ID = 'tenant_x:integration-core'

// A leaky business value carrying a unique token that MUST NEVER reach evidence.
const SECRET = 'SECRET_T2_8f3a'
const LEAKY_NAME = `Material ${SECRET}`
const LEAKY_SPEC = `SPEC_${SECRET}`

let passed = 0
let failed = 0
const failures = []

function run(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1
    })
    .catch((error) => {
      failed += 1
      failures.push({ name, error })
      console.error(`FAIL: ${name}`)
      console.error(error && error.stack ? error.stack : error)
    })
}

// The 9 frozen MVP objects, each on its own sheet (sheet_<objectId>) — mirrors
// stock-preparation-sync-run-persist.test.cjs's fixture convention exactly.
const SHEET_ID_BY_OBJECT_ID = Object.fromEntries([...MVP_OBJECT_ID_SET].map((objectId) => [objectId, `sheet_${objectId}`]))
const OBJECT_ID_BY_SHEET_ID = Object.fromEntries(Object.entries(SHEET_ID_BY_OBJECT_ID).map(([objectId, sheetId]) => [sheetId, objectId]))

// #4160 — STRICT records fake: accepts ONLY the physical fieldIds provisioning derived, exactly like
// the real service (`Unknown fieldId: X` otherwise).
function makeRecordsApi() {
  return makeStrictRecordsApi({ objectIdBySheetId: OBJECT_ID_BY_SHEET_ID, stagingProjectId: STAGING_PROJECT_ID })
}

function makeProvisioning({ missing = new Set(), stagingProjectId = STAGING_PROJECT_ID } = {}) {
  const fake = makeFakeProvisioning({ sheetIdByObjectId: SHEET_ID_BY_OBJECT_ID, stagingProjectId, missing })
  return {
    ...fake,
    get findObjectSheetCalls() {
      return fake.calls.findObjectSheet.length
    },
    findObjectSheet: fake.findObjectSheet,
    resolveFieldIds: fake.resolveFieldIds,
  }
}

function objectIdForSheet(sheetId) {
  return typeof sheetId === 'string' && sheetId.startsWith('sheet_') ? sheetId.slice('sheet_'.length) : null
}

function logicalOf(call) {
  return logicalData(STAGING_PROJECT_ID, objectIdForSheet(call.sheetId), call.data)
}

function logicalChangesOf(call) {
  return logicalData(STAGING_PROJECT_ID, objectIdForSheet(call.sheetId), call.changes)
}

function rawKeysArePhysical(call, dataKey = 'data') {
  const objectId = objectIdForSheet(call.sheetId)
  const payload = call[dataKey]
  return Object.keys(payload).every((key) => key.startsWith('fld_')) &&
    Object.keys(dataKey === 'data' ? logicalOf(call) : logicalChangesOf(call))
      .every((logical) => payload[physicalFieldId(STAGING_PROJECT_ID, objectId, logical)] !== undefined)
}

function baseMaterialRow(overrides = {}) {
  return {
    erpMaterialId: 'erp_1',
    erpMaterialCode: 'DRW-100',
    erpMaterialInternalId: 'INT-1',
    erpMaterialName: 'Test Material',
    erpSpec: 'SPEC-A',
    baseUnit: 'pcs',
    inventoryUnit: 'pcs',
    issueUnit: 'pcs',
    unitGroup: 'default',
    materialStatus: 'active',
    lastSyncedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

function baseSyncInputs(overrides = {}) {
  return {
    targetProjectId: STAGING_PROJECT_ID,
    syncRunId: 'erp_run_1',
    erpMaterials: [baseMaterialRow()],
    ...overrides,
  }
}

async function main() {
  // ---- (a) happy path: new material CREATEs, grounded, run record created ----
  await run('happy path creates a new material row grounded to template fields + creates the run record', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    const result = await persistStockPreparationErpMaterialSync({
      permission: 'admin',
      recordsApi,
      provisioning,
      ...baseSyncInputs(),
    })

    assert.equal(result.persisted, true)
    assert.equal(result.mode, 'created')
    assert.deepEqual(result.created, { materials: 1, run: 1 })
    assert.deepEqual(result.patched, { materials: 0, run: 0 })
    assert.deepEqual(result.skipped, { materials: 0 })
    assert.equal(result.runStatus, 'succeeded')

    assert.equal(recordsApi.createCalls.length, 2)
    assert.equal(recordsApi.createCalls[0].sheetId, MATERIAL_SHEET_ID)
    assert.equal(recordsApi.createCalls[1].sheetId, RUN_SHEET_ID)

    const materialRow = logicalOf(recordsApi.createCalls[0])
    assert.equal(materialRow.erpMaterialId, 'erp_1')
    assert.equal(materialRow.erpMaterialCode, 'DRW-100')
    assert.equal(materialRow.erpMaterialInternalId, 'INT-1')
    assert.equal(materialRow.erpMaterialName, 'Test Material')
    assert.equal(materialRow.materialStatus, 'active')
    for (const key of Object.keys(materialRow)) {
      assert.ok(MATERIAL_FIELD_IDS.includes(key), `persisted material key ${key} is template-declared`)
    }

    const runRow = logicalOf(recordsApi.createCalls[1])
    assert.equal(runRow.runId, 'erp_run_1')
    assert.equal(runRow.runType, ERP_MATERIAL_SYNC_RUN_TYPE)
    assert.equal(runRow.status, 'succeeded')

    assert.equal(recordsApi.patchCalls.length, 0)
    assert.equal(result.evidence.valuesFree, true)
    assert.equal(result.evidence.targets.material.objectId, MATERIAL_OBJECT_ID)
    assert.equal(result.evidence.targets.material.keyField, MATERIAL_KEY_FIELD)
    assert.equal(result.evidence.targets.run.objectId, RUN_OBJECT_ID)
    assert.equal(result.evidence.plannedMaterialCount, 1)
  })

  // ---- #4160: every write/read key is a resolved physical fieldId ----
  await run('#4160 every create/query key is a resolved physical fieldId, never a logical template key', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    await persistStockPreparationErpMaterialSync({ permission: 'admin', recordsApi, provisioning, ...baseSyncInputs() })

    for (const call of recordsApi.createCalls) {
      assert.ok(rawKeysArePhysical(call), `create on ${call.sheetId} used physical fieldIds`)
      assert.equal(Object.keys(call.data).some((key) => key === 'erpMaterialId' || key === 'runId'), false,
        'no raw logical key ever reaches the records service')
    }
    const materialProbe = recordsApi.queryCalls.find((call) => call.sheetId === MATERIAL_SHEET_ID)
    assert.ok(materialProbe, 'the material cache probe ran (queryAllRecords before upsert)')
    assert.ok(provisioning.calls.resolveFieldIds.length > 0, 'field ids resolved via provisioning.resolveFieldIds')
    for (const call of provisioning.calls.resolveFieldIds) {
      assert.equal(call.projectId, STAGING_PROJECT_ID, 'field ids resolved under the staging project')
    }
  })

  // ---- (j) upsert key is derived from the template, not hardcoded ----
  await run('the upsert key field is read from the frozen template (keyFields[0]), matching MATERIAL_KEY_FIELD export', () => {
    assert.equal(MATERIAL_KEY_FIELD, 'erpMaterialId')
    const template = STOCK_PREPARATION_MVP_TABLE_TEMPLATES.find((entry) => entry.role === 'erp_material_master')
    assert.equal(template.keyFields[0], MATERIAL_KEY_FIELD, 'export must track the template, never drift from a hardcoded literal')
  })

  // ---- (b)+(c) idempotent re-run: same erpMaterialId PATCHES (refresh), never duplicates; explicit-clear ----
  await run('a second sync of the SAME erpMaterialId PATCHES (refreshes) the row, never duplicates, and explicitly clears an absent field', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    const first = await persistStockPreparationErpMaterialSync({
      permission: 'admin',
      recordsApi,
      provisioning,
      ...baseSyncInputs({ erpMaterials: [baseMaterialRow({ erpSpec: 'SPEC-OLD', materialStatus: 'imported' })] }),
    })
    assert.deepEqual(first.created, { materials: 1, run: 1 })

    // Second sync: SAME erpMaterialId, materialStatus changed, erpSpec now ABSENT from the source row
    // (upstream stopped supplying it) — the refresh must explicitly NULL it, not just leave it alone.
    const second = await persistStockPreparationErpMaterialSync({
      permission: 'admin',
      recordsApi,
      provisioning,
      ...baseSyncInputs({
        syncRunId: 'erp_run_2',
        erpMaterials: [baseMaterialRow({ erpSpec: undefined, materialStatus: 'active' })],
      }),
    })
    assert.equal(second.persisted, true)
    assert.deepEqual(second.created, { materials: 0, run: 1 })
    assert.deepEqual(second.patched, { materials: 1, run: 0 })

    // Exactly ONE material row for this erpMaterialId — no duplicate.
    const materialRowsNow = recordsApi.rows(MATERIAL_SHEET_ID)
    assert.equal(materialRowsNow.length, 1, 'no duplicate material row for the same erpMaterialId')

    const materialPatchCalls = recordsApi.patchCalls.filter((call) => call.sheetId === MATERIAL_SHEET_ID)
    assert.equal(materialPatchCalls.length, 1)
    const patchedLogical = logicalChangesOf(materialPatchCalls[0])
    assert.equal(patchedLogical.materialStatus, 'active', 'mutable field refreshed to the NEW value')
    assert.equal('erpMaterialId' in patchedLogical, false, 'key field is never part of the patch changes')
    assert.equal(patchedLogical.erpSpec, null, 'a field ABSENT from the fresh row is explicitly nulled (explicit-clear refresh)')

    const finalRow = logicalData(STAGING_PROJECT_ID, MATERIAL_OBJECT_ID, materialRowsNow[0].data)
    assert.equal(finalRow.materialStatus, 'active')
    assert.equal(finalRow.erpSpec, null, 'the strict fake applies null via Object.assign, so the cleared key HOLDS null (not the stale "SPEC-OLD" string)')

    // The run record for run_2 is a DIFFERENT runId -> CREATED, not patched (run status parity unaffected).
    const runRowsNow = recordsApi.rows(RUN_SHEET_ID)
    assert.equal(runRowsNow.length, 2, 'two distinct syncRunIds -> two run rows')
  })

  // ---- P2-1 (owner independent review 2026-07-12): a NUMERIC erpMaterialId must stay idempotent ----
  // The ERP feed can hand erpMaterialId over as a JSON number (123) instead of "123". The existing-row
  // index and the per-row upsert lookup key are both normalized with optionalString(...), AND each cell is
  // grounded to its template field's declared type before persistence — so the string-typed key field
  // stores "123", and a second sync of the SAME numeric id HITS the index (patch) instead of missing it
  // and DOUBLE-CREATING. Regression for that double-create (revert the coercion + the optionalString on the
  // lookup key and this goes red: the second sync creates a 2nd row).
  await run('a NUMERIC erpMaterialId upserts idempotently (no duplicate) and is grounded to the string-typed key', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    const first = await persistStockPreparationErpMaterialSync({
      permission: 'admin', recordsApi, provisioning,
      ...baseSyncInputs({ syncRunId: 'erp_run_num_1', erpMaterials: [baseMaterialRow({ erpMaterialId: 123 })] }),
    })
    assert.deepEqual(first.created, { materials: 1, run: 1 })

    const second = await persistStockPreparationErpMaterialSync({
      permission: 'admin', recordsApi, provisioning,
      ...baseSyncInputs({ syncRunId: 'erp_run_num_2', erpMaterials: [baseMaterialRow({ erpMaterialId: 123 })] }),
    })
    assert.deepEqual(second.created, { materials: 0, run: 1 }, 'a re-sync of the SAME numeric id PATCHES, never re-creates')
    assert.deepEqual(second.patched, { materials: 1, run: 0 })

    const materialRowsNow = recordsApi.rows(MATERIAL_SHEET_ID)
    assert.equal(materialRowsNow.length, 1, 'exactly ONE material row for the numeric erpMaterialId — no duplicate')
    const persisted = logicalData(STAGING_PROJECT_ID, MATERIAL_OBJECT_ID, materialRowsNow[0].data)
    assert.strictEqual(persisted.erpMaterialId, '123', 'the numeric id is grounded to the string-typed key field ("123", not 123)')
  })

  // ---- P2-2 (owner independent review 2026-07-12): response + errors stay values-free (no echo-back) ----
  // "values-free" also means the caller's OWN inputs never bounce back: the raw syncRunId is a caller
  // handle, so the public result carries only counts/modes/statuses + a values-free evidence block, and the
  // ambiguous-key error names the FIELD, never the offending value.
  await run("the public result never echoes the caller's raw syncRunId (values-free response)", async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    const RUN_TOKEN = 'erp_run_LEAKBAIT_9c2'
    const result = await persistStockPreparationErpMaterialSync({
      permission: 'admin', recordsApi, provisioning, ...baseSyncInputs({ syncRunId: RUN_TOKEN }),
    })
    assert.equal('runId' in result, false, 'raw runId is not a public-result field')
    assert.equal('syncRunId' in result, false)
    assert.equal(JSON.stringify(result).includes(RUN_TOKEN), false, 'the caller-supplied syncRunId token never crosses into the response')
    assert.equal(result.evidence.runIdPresent, true, 'only a boolean trace of the run remains in evidence')
  })

  await run('the ambiguous-run error names the key FIELD, never the offending runId value', async () => {
    const DUP = 'erp_run_DUP_LEAKBAIT_4f1'
    const cell = (logical) => physicalFieldId(STAGING_PROJECT_ID, RUN_OBJECT_ID, logical)
    const dupRow = (id) => ({ id, data: { [cell(RUN_KEY_FIELD)]: DUP, [cell('runType')]: ERP_MATERIAL_SYNC_RUN_TYPE, [cell('status')]: 'running' } })
    const recordsApi = makeStrictRecordsApi({
      objectIdBySheetId: OBJECT_ID_BY_SHEET_ID,
      stagingProjectId: STAGING_PROJECT_ID,
      rowsBySheet: { [RUN_SHEET_ID]: [dupRow('rec_dup_1'), dupRow('rec_dup_2')] },
    })
    const provisioning = makeProvisioning()
    await assert.rejects(
      () => persistStockPreparationErpMaterialSync({ permission: 'admin', recordsApi, provisioning, ...baseSyncInputs({ syncRunId: DUP }) }),
      (error) => {
        assert.ok(error instanceof StockPreparationErpMaterialSyncError)
        assert.equal(error.code, 'ERP_MATERIAL_SYNC_KEY_AMBIGUOUS')
        assert.deepEqual(error.details, { keyField: RUN_KEY_FIELD }, 'error details name the field only')
        assert.equal(JSON.stringify(error.details).includes(DUP), false, 'the offending runId value never appears in the error')
        return true
      },
    )
  })

  // ---- run-record idempotency: replaying the SAME syncRunId with an unchanged status is a no-op ----
  await run('replaying the SAME syncRunId with an unchanged run status patches nothing on the run sheet', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    const first = await persistStockPreparationErpMaterialSync({ permission: 'admin', recordsApi, provisioning, ...baseSyncInputs() })
    assert.deepEqual(first.created, { materials: 1, run: 1 })

    const second = await persistStockPreparationErpMaterialSync({ permission: 'admin', recordsApi, provisioning, ...baseSyncInputs() })
    assert.equal(second.runStatus, 'succeeded')
    assert.deepEqual(second.created, { materials: 0, run: 0 })
    // The material row is upserted (refresh semantics apply even on an identical replay: it is patched,
    // not skipped — the cache does not try to detect "nothing changed").
    assert.deepEqual(second.patched, { materials: 1, run: 0 })
    const runRowsNow = recordsApi.rows(RUN_SHEET_ID)
    assert.equal(runRowsNow.length, 1, 'same syncRunId never duplicates the run row')
    const runPatchCalls = recordsApi.patchCalls.filter((call) => call.sheetId === RUN_SHEET_ID)
    assert.equal(runPatchCalls.length, 0, 'unchanged status -> zero patch calls on the run sheet')
  })

  // ---- (d) a row missing a required field is skipped, counted, and flips run status to partial ----
  await run('a row missing erpMaterialCode/erpMaterialInternalId/the key is skipped and counted, never crashes the sync', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    const result = await persistStockPreparationErpMaterialSync({
      permission: 'admin',
      recordsApi,
      provisioning,
      ...baseSyncInputs({
        erpMaterials: [
          baseMaterialRow({ erpMaterialId: 'erp_good' }),
          baseMaterialRow({ erpMaterialId: 'erp_bad_1', erpMaterialCode: undefined }),
          baseMaterialRow({ erpMaterialId: 'erp_bad_2', erpMaterialInternalId: undefined }),
          baseMaterialRow({ erpMaterialId: undefined, erpMaterialCode: 'no-key' }),
        ],
      }),
    })
    assert.deepEqual(result.created, { materials: 1, run: 1 })
    assert.deepEqual(result.skipped, { materials: 3 })
    assert.equal(result.runStatus, 'partial', 'any skipped row flips the run status to partial')
    const materialRowsNow = recordsApi.rows(MATERIAL_SHEET_ID)
    assert.equal(materialRowsNow.length, 1, 'only the ONE valid row was written')
  })

  // ---- empty erpMaterials: a valid, if unusual, outcome (zero writes to the material sheet) ----
  await run('an empty erpMaterials array is a valid sync (zero material writes, run record still created)', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    const result = await persistStockPreparationErpMaterialSync({
      permission: 'admin',
      recordsApi,
      provisioning,
      ...baseSyncInputs({ erpMaterials: [] }),
    })
    assert.equal(result.mode, 'skipped_empty')
    assert.deepEqual(result.created, { materials: 0, run: 1 })
    assert.equal(result.runStatus, 'succeeded')
    assert.equal(recordsApi.createCalls.filter((call) => call.sheetId === MATERIAL_SHEET_ID).length, 0)
  })

  // ---- (e) admin-permission-denied: 403 BEFORE any provisioning / records access ----
  await run('non-admin permission throws 403 before any provisioning or records call', async () => {
    for (const permission of ['read', 'write', undefined, null, '']) {
      const recordsApi = makeRecordsApi()
      const provisioning = makeProvisioning()
      await assert.rejects(
        () => persistStockPreparationErpMaterialSync({ permission, recordsApi, provisioning, ...baseSyncInputs() }),
        (error) =>
          error instanceof StockPreparationErpMaterialSyncError &&
          error.status === 403 &&
          error.code === 'ERP_MATERIAL_SYNC_PERMISSION_DENIED',
        `permission ${String(permission)} denied`,
      )
      assert.equal(provisioning.findObjectSheetCalls, 0, 'gate runs before provisioning')
      assert.equal(recordsApi.createCalls.length, 0)
      assert.equal(recordsApi.queryCalls.length, 0)
    }
  })

  // ---- (f) target not provisioned (material OR run) -> fail closed, no writes ----
  await run('any unprovisioned MVP target fails closed with no writes', async () => {
    for (const missingObjectId of [MATERIAL_OBJECT_ID, RUN_OBJECT_ID]) {
      const recordsApi = makeRecordsApi()
      const provisioning = makeProvisioning({ missing: new Set([missingObjectId]) })
      await assert.rejects(
        () => persistStockPreparationErpMaterialSync({ permission: 'admin', recordsApi, provisioning, ...baseSyncInputs() }),
        (error) =>
          error instanceof StockPreparationErpMaterialSyncError &&
          error.status === 409 &&
          error.code === 'ERP_MATERIAL_SYNC_TARGET_NOT_PROVISIONED' &&
          error.details.objectId === missingObjectId,
        `missing ${missingObjectId} fails closed`,
      )
      assert.equal(recordsApi.createCalls.length, 0, 'no rows written when a target is unprovisioned')
      assert.equal(recordsApi.patchCalls.length, 0)
    }
  })

  // ---- (g) provisioning API unavailable -> 503 (fail closed) ----
  await run('missing provisioning.resolveFieldIds is a 503 fail-closed', async () => {
    await assert.rejects(
      () => persistStockPreparationErpMaterialSync({
        permission: 'admin',
        recordsApi: makeRecordsApi(),
        provisioning: { findObjectSheet: async () => ({ id: 'x' }) },
        ...baseSyncInputs(),
      }),
      (error) => error instanceof StockPreparationErpMaterialSyncError && error.status === 503 && error.code === 'ERP_MATERIAL_SYNC_PROVISIONING_API_UNAVAILABLE',
    )
  })

  // ---- targetProjectId / syncRunId required, fail closed with NO writes ----
  await run('targetProjectId is required — omitting it fails closed with NO provisioning/records access', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    await assert.rejects(
      () => persistStockPreparationErpMaterialSync({
        permission: 'admin',
        recordsApi,
        provisioning,
        ...baseSyncInputs({ targetProjectId: undefined }),
      }),
      (error) => error instanceof StockPreparationErpMaterialSyncError && error.status === 422 && error.code === 'ERP_MATERIAL_SYNC_CONFIG_INVALID',
    )
    assert.equal(provisioning.findObjectSheetCalls, 0)
    assert.equal(recordsApi.createCalls.length, 0)
  })

  await run('syncRunId is required — omitting it fails closed with NO provisioning/records access', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    await assert.rejects(
      () => persistStockPreparationErpMaterialSync({
        permission: 'admin',
        recordsApi,
        provisioning,
        ...baseSyncInputs({ syncRunId: undefined }),
      }),
      (error) => error instanceof StockPreparationErpMaterialSyncError && error.status === 422 && error.code === 'ERP_MATERIAL_SYNC_CONFIG_INVALID',
    )
    assert.equal(provisioning.findObjectSheetCalls, 0)
    assert.equal(recordsApi.createCalls.length, 0)
  })

  // ---- (h) values-free evidence: a planted secret never reaches evidence (rows still carry it) ----
  await run('evidence never leaks erpMaterialName / erpSpec (rows still legitimately carry them)', async () => {
    const recordsApi = makeRecordsApi()
    const result = await persistStockPreparationErpMaterialSync({
      permission: 'admin',
      recordsApi,
      provisioning: makeProvisioning(),
      ...baseSyncInputs({
        erpMaterials: [baseMaterialRow({ erpMaterialName: LEAKY_NAME, erpSpec: LEAKY_SPEC })],
      }),
    })
    const materialWrite = recordsApi.createCalls.find((call) => call.sheetId === MATERIAL_SHEET_ID)
    assert.ok(materialWrite)
    assert.equal(logicalOf(materialWrite).erpMaterialName, LEAKY_NAME, 'the row itself legitimately carries the value')

    const evidenceJson = JSON.stringify(result.evidence)
    assert.equal(evidenceJson.includes(SECRET), false, 'secret token absent from evidence')
    assert.equal(evidenceJson.includes(LEAKY_NAME), false)
    assert.equal(evidenceJson.includes(LEAKY_SPEC), false)
    assert.equal(result.evidence.valuesFree, true)
    assert.ok(result.evidence.targets.material.fieldKeys.includes('erpMaterialName'), 'field-key NAMES are allowed')
  })

  // ---- (k) THE OWNER-MANDATED PROOF: confirm-writes reads the JUST-PERSISTED cache, not a request candidate ----
  await run('syncMaterialMappingCandidates reads the erp_material_master row THIS module just persisted (its only erpMaterials source)', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()

    // 1. Build a genuine, complete BOM snapshot batch via the REAL (already-landed) sync-run-persist
    //    module — one line whose childDrawingNo matches the ERP material's code we are about to cache.
    const cleanExpansion = [
      { componentSourceId: 'CS1', componentCode: 'DRW-100', sourceVersion: 'V1', path: '/root/DRW-100', rawQuantity: 3 },
    ]
    const syncResult = await persistStockPreparationSyncRun({
      permission: 'admin',
      recordsApi,
      provisioning,
      projectId: 'proj_1',
      targetProjectId: STAGING_PROJECT_ID,
      lockTenantId: 'tenant_x',
      syncRunId: 'bom_run_1',
      snapshotBatchId: 'batch_1',
      sourceProjectNo: 'PN-1',
      defaultDesignUnit: 'pcs',
      expansionResult: cleanExpansion,
    })
    assert.equal(syncResult.persisted, true)

    // 2. THIS module persists ONE ERP material whose code matches the BOM line's childDrawingNo.
    const erpResult = await persistStockPreparationErpMaterialSync({
      permission: 'admin',
      recordsApi,
      provisioning,
      targetProjectId: STAGING_PROJECT_ID,
      syncRunId: 'erp_run_1',
      erpMaterials: [baseMaterialRow({ erpMaterialId: 'erp_1', erpMaterialCode: 'DRW-100', erpMaterialInternalId: 'INT-1' })],
    })
    assert.equal(erpResult.created.materials, 1)

    // 3. confirm-writes.cjs's R5 candidate-sync: its ONLY erpMaterials input is
    //    queryAllRecords(materialTarget.scoped, {}) — there is no request-body channel for material rows
    //    at all. A produced mapping referencing DRW-100/INT-1 can only have come from the cache.
    const syncCandidatesResult = await syncMaterialMappingCandidates({
      permission: 'admin',
      recordsApi,
      provisioning,
      targetProjectId: STAGING_PROJECT_ID,
      projectId: 'proj_1',
      snapshotBatchId: 'batch_1',
      defaultVersionPolicy: 'drawing_and_version',
    })
    assert.equal(syncCandidatesResult.created.mappings, 1, 'exactly one candidate mapping produced')

    const mappingCreateCall = recordsApi.createCalls.find((call) => call.sheetId === MAPPING_SHEET_ID)
    assert.ok(mappingCreateCall, 'a mapping candidate row was written')
    const mappingRow = logicalOf(mappingCreateCall)
    assert.equal(mappingRow.erpMaterialCode, 'DRW-100', 'the candidate carries the CACHED material code')
    assert.equal(mappingRow.erpMaterialInternalId, 'INT-1', 'the candidate carries the CACHED material internal id')
    assert.equal(mappingRow.matchStatus, 'pending_confirm')
    assert.equal(mappingRow.matchMethod, 'exact_code_candidate')
  })

  console.log(`\nstock-preparation-erp-material-sync-persist.test.cjs: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    for (const { name } of failures) console.error(`  - ${name}`)
    process.exit(1)
  }
  console.log('stock-preparation-erp-material-sync-persist.test.cjs OK')
}

main().catch((error) => {
  console.error('stock-preparation-erp-material-sync-persist.test.cjs FAILED')
  console.error(error)
  process.exit(1)
})
