#!/usr/bin/env node
'use strict'

// Stock-preparation MVP T2 (#3751) — REAL-Postgres smoke for the ERP material-master cache persist.
//
// This is the #4160/#4163-grade proof for T2: the unit tests inject a STRICT fake records API, but a
// fake can only ever prove "our code called our own fake". This harness runs the actual persist path
// against a REAL Postgres through the SAME host multitable API the server wires in
// packages/core-backend/src/index.ts (poolManager -> multitable/provisioning + multitable/records), so
// the logical->physical fieldId translation (createTargetScopedRecordsApi + provisioning.resolveFieldIds)
// is exercised against the real records service that rejects an unknown fieldId and stores rows keyed by
// the DERIVED physical fieldId.
//
// It proves, against real rows in meta_records / meta_fields:
//   1. persist ERP materials -> the erp_material_master sheet actually gains a row, and that row's
//      data is keyed by the PHYSICAL fieldIds provisioning stored in meta_fields (read straight from the
//      meta_fields table — NEVER re-derived in this script, so the check cannot be circular), NOT by the
//      template's logical keys ('erpMaterialId' etc.). The value landed in the RIGHT column
//      (erpMaterialCode's physical column holds the material code, cross-checked via meta_fields.name).
//   2. re-sync PATCHES the same row (upsert, no duplicate) and refreshes a mutable field.
//   3. the values-free evidence never carries the planted material name/spec sentinels.
//   4. THE OWNER-NAMED ACCEPTANCE POINT: confirm-writes.cjs's syncMaterialMappingCandidates — whose
//      ONLY erpMaterials input is queryAllRecords(materialTarget.scoped, {}) — now reads the JUST-CACHED
//      row and produces a mapping candidate referencing it (exact_code_candidate on the BOM line whose
//      drawing number equals the cached material's code). This unblocks T4 (generation resolving to a
//      prep-line needs a matching erp_material_master row).
//
// Run (fresh DB, local PG, no SSL):
//   createdb stockprep_t2_smoke
//   DATABASE_URL='postgresql://<user>@localhost:5432/stockprep_t2_smoke?sslmode=disable' \
//   NODE_ENV=production DB_SSL=false JWT_SECRET='<>=32 chars>' \
//   pnpm --filter @metasheet/core-backend db:migrate
//   DATABASE_URL=... NODE_ENV=production DB_SSL=false JWT_SECRET=... \
//   node --import tsx scripts/ops/stock-preparation-erp-material-sync-realdb-smoke.mjs --tenant-id t2smoke
//
// Values-free: prints counts / modes / booleans / field-key NAMES / objectId constants only.

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// ── args ────────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { tenantId: 't2smoke' }
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--tenant-id') args.tenantId = argv[++i]
    else throw new Error(`unknown flag: ${flag}`)
  }
  return args
}

function stage(msg) {
  process.stderr.write(`[realdb-smoke] .. ${msg}\n`)
}

const CHECKS = []
function check(name, ok, detail = '') {
  CHECKS.push({ name, ok: ok === true, detail })
  process.stderr.write(`[realdb-smoke] ${name}: ${ok === true ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}\n`)
  return ok === true
}

// ── the real host multitable API (replicates packages/core-backend/src/index.ts:455-665) ──────────
function buildHostMultitableApi(poolManager, prov, recs, p4) {
  const readFn = async (sql, params) => {
    const r = await poolManager.get().query(sql, params)
    return {
      rows: Array.isArray(r && r.rows) ? r.rows : [],
      rowCount: typeof (r && r.rowCount) === 'number' ? r.rowCount : undefined,
    }
  }
  const txFnFrom = (query) => async (sql, params) => {
    const r = await query(sql, params)
    return {
      rows: Array.isArray(r && r.rows) ? r.rows : [],
      rowCount: typeof (r && r.rowCount) === 'number' ? r.rowCount : undefined,
    }
  }
  const provisioning = {
    findObjectSheet: ({ projectId, objectId }) => prov.findObjectSheet(readFn, projectId, objectId),
    resolveFieldIds: async ({ projectId, objectId, fieldIds }) => prov.resolveObjectFieldIds(projectId, objectId, fieldIds),
    ensureObject: ({ projectId, baseId, descriptor }) =>
      poolManager.get().transaction(async ({ query }) => prov.ensureObject({ query: txFnFrom(query), projectId, baseId, descriptor })),
    patchObjectFieldProperty: ({ projectId, objectId, fieldId, propertyPatch }) =>
      poolManager.get().transaction(async ({ query }) => prov.patchObjectFieldProperty({ query: txFnFrom(query), projectId, objectId, fieldId, propertyPatch })),
  }
  const records = {
    queryRecords: ({ sheetId, filters, search, orderBy, limit, offset }) =>
      recs.queryRecords({ query: readFn, sheetId, filters, search, orderBy, limit, offset }),
    createRecord: ({ sheetId, data }) =>
      poolManager.get().transaction(async ({ query }) => recs.createRecord({ query: txFnFrom(query), sheetId, data })),
    patchRecord: ({ sheetId, recordId, changes }) =>
      poolManager.get().transaction(async ({ query }) => recs.patchRecord({ query: txFnFrom(query), sheetId, recordId, changes })),
    runStockPreparationPersistUnitOfWork: (input, operation) =>
      poolManager.get().transaction(async ({ query }) => {
        const txQuery = txFnFrom(query)
        await p4.acquireStockPreparationPersistUnitOfWorkLocks(txQuery, input)
        return operation({
          queryRecords: (recordInput) => recs.queryRecords({ query: txQuery, ...recordInput }),
          createRecord: (recordInput) => recs.createRecord({ query: txQuery, ...recordInput }),
          patchRecord: (recordInput) => recs.patchRecord({ query: txQuery, ...recordInput }),
        })
      }),
  }
  return { provisioning, records }
}

async function main() {
  const args = parseArgs(process.argv)
  const salt = `t${Math.floor(Date.now() / 1000)}${Math.floor(Math.random() * 1000)}`
  const stagingProjectId = `${args.tenantId}:integration-core`
  const businessProjectId = `${args.tenantId}-proj-${salt}`

  // Fixture (all salted; the name/spec double as leak-scan sentinels).
  const drawingA = `RDBDWG-${salt}`
  const erpMaterialId = `rdb_erp_${salt}`
  const erpMaterialInternalId = `RDBINT-${salt}`
  const NAME_SENTINEL = `RDB_MATERIAL_NAME_${salt}`
  const SPEC_SENTINEL = `RDB_SPEC_${salt}`
  const bomSyncRunId = `rdb_bomrun_${salt}`
  const snapshotBatchId = `rdb_batch_${salt}`
  const erpSyncRunId = `rdb_erprun_${salt}`
  const sourceProjectNo = `RDB-PN-${salt}`

  // Dynamic-import the core-backend TS (same idiom as host-loader-smoke.test.mjs). poolManager reads
  // DATABASE_URL at construction, so env must already be set (it is — see the run recipe above).
  stage('importing connection-pool')
  const cp = await import(new URL('../../packages/core-backend/src/integration/db/connection-pool.ts', import.meta.url).href)
  stage('importing provisioning')
  const prov = await import(new URL('../../packages/core-backend/src/multitable/provisioning.ts', import.meta.url).href)
  stage('importing records')
  const recs = await import(new URL('../../packages/core-backend/src/multitable/records.ts', import.meta.url).href)
  stage('importing stock-preparation P4 unit-of-work')
  const p4 = await import(new URL('../../packages/core-backend/src/multitable/stock-preparation-persist-unit-of-work.ts', import.meta.url).href)
  stage('core imports done')
  const { poolManager } = cp

  const { provisioning, records } = buildHostMultitableApi(poolManager, prov, recs, p4)
  const context = { api: { multitable: { provisioning, records } } }

  const {
    ensureStockPreparationMvpTargets,
    syncStockPreparationMvpOptions,
  } = require('../../plugins/plugin-integration-core/lib/stock-preparation-mvp-provisioning.cjs')
  const { persistStockPreparationSyncRun } = require('../../plugins/plugin-integration-core/lib/stock-preparation-sync-run-persist.cjs')
  const {
    persistStockPreparationErpMaterialSync,
    MATERIAL_OBJECT_ID,
    MATERIAL_KEY_FIELD,
  } = require('../../plugins/plugin-integration-core/lib/stock-preparation-erp-material-sync-persist.cjs')
  const { syncMaterialMappingCandidates, MAPPING_OBJECT_ID } = require('../../plugins/plugin-integration-core/lib/stock-preparation-confirm-writes.cjs')
  const { STOCK_PREPARATION_MVP_TABLE_TEMPLATES } = require('../../plugins/plugin-integration-core/lib/stock-preparation-templates.cjs')

  const materialTemplate = STOCK_PREPARATION_MVP_TABLE_TEMPLATES.find((t) => t.role === 'erp_material_master')
  // logical fieldId -> display label (the label is what provisioning stores as meta_fields.name; we use
  // it below to look the PHYSICAL id up FROM the DB by name, never re-deriving it here).
  const labelByLogical = new Map(materialTemplate.fields.map((f) => [f.id, f.label]))

  let failed = false
  const must = (name, ok, detail) => { if (!check(name, ok, detail)) failed = true }

  // Direct read-only SQL for the DB cross-checks (NOT through the plugin/host API).
  const sql = (text, params) => poolManager.get().query(text, params)

  try {
    // 0. sanity: the connection is live and the DB is the fresh migrated one.
    const now = await sql('SELECT 1 AS ok', [])
    must('postgres connection live', (now.rows[0] || {}).ok === 1)

    // 1. provision the 9 frozen MVP tables under the STAGING project (real meta_sheets + meta_fields).
    stage('provisioning MVP tables')
    const ensure = await ensureStockPreparationMvpTargets({ context, projectId: stagingProjectId, permission: 'admin' })
    must('provisioned all 9 MVP tables', ensure.ready === true && ensure.tables.length === 9, `tables=${ensure.tables.length}`)

    // 1b. sync the select-field option vocabularies — the real records service REJECTS a select value
    //     that is not a registered option (records.ts normalizeSelectValue), so every select column must
    //     carry its options before any row is written. Reuse the postdeploy smoke's closed vocabulary.
    stage('syncing option sets')
    const smoke = await import(new URL('./stock-preparation-mvp-postdeploy-smoke.mjs', import.meta.url).href)
    const optionSync = await syncStockPreparationMvpOptions({
      context, projectId: stagingProjectId, permission: 'admin', optionSets: smoke.buildOptionSetsFixture(),
    })
    must('option sync covered every select field (0 skipped)',
      optionSync.evidence.syncedFieldCount > 0 && optionSync.evidence.skippedFieldCount === 0,
      `synced=${optionSync.evidence.syncedFieldCount} skipped=${optionSync.evidence.skippedFieldCount}`)

    // 2. persist a complete BOM sync run (so there is a batch/line/run for the mapping step). The single
    //    BOM line's componentCode === drawingA — the join key the material match will use.
    const bomPersist = await persistStockPreparationSyncRun({
      permission: 'admin', recordsApi: records, provisioning,
      projectId: businessProjectId, targetProjectId: stagingProjectId,
      lockTenantId: args.tenantId,
      syncRunId: bomSyncRunId, snapshotBatchId, snapshotVersion: 1, sourceSystem: 'rdb_smoke',
      sourceProjectNo, defaultDesignUnit: 'pcs',
      expansionResult: [{ componentSourceId: `OBJ_${salt}`, componentCode: drawingA, sourceVersion: 'V1', path: `/root/${drawingA}`, rawQuantity: 3 }],
    })
    must('BOM sync-run persisted (batch+line+run+project) against real PG',
      bomPersist.persisted === true && bomPersist.created.batch === 1 && bomPersist.created.lines === 1 && bomPersist.created.run === 1,
      `mode=${bomPersist.mode}`)

    // 3. persist ONE ERP material into the cache (code === drawingA). Name/spec carry leak sentinels.
    const erpPersist = await persistStockPreparationErpMaterialSync({
      permission: 'admin', recordsApi: records, provisioning,
      targetProjectId: stagingProjectId, syncRunId: erpSyncRunId,
      erpMaterials: [{
        erpMaterialId, erpMaterialCode: drawingA, erpMaterialInternalId,
        erpMaterialName: NAME_SENTINEL, erpSpec: SPEC_SENTINEL,
        baseUnit: 'pcs', inventoryUnit: 'pcs', issueUnit: 'pcs', unitGroup: 'default',
        materialStatus: 'active', lastSyncedAt: new Date().toISOString(),
      }],
    })
    must('ERP material persist -> created 1 material + run (erp_material_sync)',
      erpPersist.persisted === true && erpPersist.created.materials === 1 && erpPersist.runStatus === 'succeeded',
      `mode=${erpPersist.mode} runStatus=${erpPersist.runStatus}`)
    // 3b. values-free evidence: the planted name/spec sentinels never reach the evidence.
    const erpEvidenceJson = JSON.stringify(erpPersist.evidence)
    must('ERP persist evidence is values-free (no material name/spec sentinel)',
      !erpEvidenceJson.includes(NAME_SENTINEL) && !erpEvidenceJson.includes(SPEC_SENTINEL) && erpPersist.evidence.valuesFree === true)

    // 4. DB CROSS-CHECK — the #4160/#4163 heart. Resolve the material sheet (via the host, which reads
    //    meta_sheets), then read meta_fields for that sheet STRAIGHT FROM THE DB and build the
    //    physical-fieldId map from meta_fields.name — NEVER re-deriving the id in this script.
    const materialSheet = await provisioning.findObjectSheet({ projectId: stagingProjectId, objectId: MATERIAL_OBJECT_ID })
    const materialSheetId = materialSheet && materialSheet.id
    must('erp_material_master sheet is provisioned (meta_sheets row exists)', Boolean(materialSheetId))

    const fieldRows = (await sql('SELECT id, name FROM meta_fields WHERE sheet_id = $1', [materialSheetId])).rows
    const physicalIdByLabel = new Map(fieldRows.map((r) => [String(r.name), String(r.id)]))
    const physIdOf = (logical) => physicalIdByLabel.get(labelByLogical.get(logical))
    const physKeyId = physIdOf(MATERIAL_KEY_FIELD)          // physical id for erpMaterialId
    const physCodeId = physIdOf('erpMaterialCode')          // physical id for erpMaterialCode
    const physNameId = physIdOf('erpMaterialName')          // physical id for erpMaterialName
    must('meta_fields carries a physical fieldId (fld_*) per template field, read from the DB',
      typeof physKeyId === 'string' && physKeyId.startsWith('fld_') &&
      typeof physCodeId === 'string' && physCodeId.startsWith('fld_'),
      `keyPhys=${(physKeyId || '').slice(0, 8)}… codePhys=${(physCodeId || '').slice(0, 8)}…`)

    // Read the actual persisted row from meta_records and confirm it is keyed by the DB's physical ids.
    const recRows = (await sql(
      `SELECT id, data FROM meta_records WHERE sheet_id = $1 AND data ->> $2 = $3`,
      [materialSheetId, physKeyId, erpMaterialId],
    )).rows
    must('erp_material_master has exactly 1 row keyed by the DB physical erpMaterialId column', recRows.length === 1, `rows=${recRows.length}`)
    const rowData = recRows.length === 1 ? recRows[0].data : {}
    const rowKeys = Object.keys(rowData)
    // (a) the row is keyed by PHYSICAL ids (fld_*), never the template's LOGICAL keys.
    must('row data is keyed ONLY by physical fld_* ids (never logical template keys)',
      rowKeys.length > 0 && rowKeys.every((k) => k.startsWith('fld_')) &&
      !('erpMaterialId' in rowData) && !('erpMaterialCode' in rowData),
      `keys=${rowKeys.length} allPhysical=${rowKeys.every((k) => k.startsWith('fld_'))}`)
    // (b) EVERY row key is a real meta_fields id of THIS sheet (no orphan/unknown column slipped in).
    const knownPhysical = new Set(fieldRows.map((r) => String(r.id)))
    must('every row data key is a provisioned meta_fields.id of this sheet', rowKeys.every((k) => knownPhysical.has(k)))
    // (c) the VALUE landed in the RIGHT column: the code lives under erpMaterialCode's physical id.
    must('erpMaterialCode value landed under the DB physical column for erpMaterialCode',
      rowData[physCodeId] === drawingA, `match=${rowData[physCodeId] === drawingA}`)
    must('erpMaterialName value landed under the DB physical column for erpMaterialName',
      rowData[physNameId] === NAME_SENTINEL)

    // 5. re-sync PATCHES the same row (upsert; materialStatus refreshed, no duplicate row).
    const erpResync = await persistStockPreparationErpMaterialSync({
      permission: 'admin', recordsApi: records, provisioning,
      targetProjectId: stagingProjectId, syncRunId: `${erpSyncRunId}_v2`,
      erpMaterials: [{
        erpMaterialId, erpMaterialCode: drawingA, erpMaterialInternalId,
        erpMaterialName: NAME_SENTINEL, erpSpec: SPEC_SENTINEL,
        baseUnit: 'pcs', inventoryUnit: 'pcs', issueUnit: 'pcs', unitGroup: 'default',
        materialStatus: 'inactive', lastSyncedAt: new Date().toISOString(),
      }],
    })
    const materialRowCount = Number((await sql('SELECT count(*)::int AS n FROM meta_records WHERE sheet_id = $1', [materialSheetId])).rows[0].n)
    must('re-sync patched the material (no duplicate row) + refreshed materialStatus',
      erpResync.patched.materials === 1 && erpResync.created.materials === 0 && materialRowCount === 1,
      `patched=${erpResync.patched.materials} rows=${materialRowCount}`)
    const statusPhysId = physIdOf('materialStatus')
    const refreshedRow = (await sql(`SELECT data FROM meta_records WHERE sheet_id = $1 AND data ->> $2 = $3`, [materialSheetId, physKeyId, erpMaterialId])).rows[0].data
    must('materialStatus refreshed to the new value in the DB', refreshedRow[statusPhysId] === 'inactive', `status=${refreshedRow[statusPhysId]}`)

    // 6. OWNER-NAMED ACCEPTANCE POINT — confirm-writes reads the cache. syncMaterialMappingCandidates'
    //    ONLY erpMaterials source is queryAllRecords(materialTarget.scoped, {}); a candidate carrying the
    //    cached code/internalId therefore PROVES the just-persisted cache row was read back downstream.
    const mappingSync = await syncMaterialMappingCandidates({
      permission: 'admin', recordsApi: records, provisioning,
      targetProjectId: stagingProjectId, projectId: businessProjectId,
      snapshotBatchId, defaultVersionPolicy: 'drawing_and_version',
    })
    must('mapping candidate-sync created exactly 1 candidate from the cached material',
      mappingSync.created.mappings === 1, `created=${mappingSync.created.mappings}`)

    const mappingSheet = await provisioning.findObjectSheet({ projectId: stagingProjectId, objectId: MAPPING_OBJECT_ID })
    const mappingFieldRows = (await sql('SELECT id, name FROM meta_fields WHERE sheet_id = $1', [mappingSheet.id])).rows
    const mappingPhysByName = new Map(mappingFieldRows.map((r) => [String(r.name), String(r.id)]))
    const mappingRows = (await sql('SELECT data FROM meta_records WHERE sheet_id = $1', [mappingSheet.id])).rows
    const mappingRow = mappingRows.length === 1 ? mappingRows[0].data : {}
    const mCodePhys = mappingPhysByName.get('ERP Material Code')
    const mInternalPhys = mappingPhysByName.get('ERP/K3 Material Internal ID')
    const mStatusPhys = mappingPhysByName.get('Match Status')
    const mMethodPhys = mappingPhysByName.get('Match Method')
    must('the candidate carries the CACHED material code+internalId (confirm-writes read erp_material_master)',
      mappingRows.length === 1 && mappingRow[mCodePhys] === drawingA && mappingRow[mInternalPhys] === erpMaterialInternalId,
      `code=${mappingRow[mCodePhys] === drawingA} internal=${mappingRow[mInternalPhys] === erpMaterialInternalId}`)
    must('the candidate is an exact_code_candidate pending_confirm (the cache drove the match)',
      mappingRow[mStatusPhys] === 'pending_confirm' && mappingRow[mMethodPhys] === 'exact_code_candidate',
      `status=${mappingRow[mStatusPhys]} method=${mappingRow[mMethodPhys]}`)
  } catch (error) {
    check('harness ran without an unexpected throw', false, `${error && error.name}: ${error && error.message}`)
    failed = true
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`)
  } finally {
    try { await poolManager.get().close?.() } catch { /* best-effort */ }
  }

  const pass = !failed && CHECKS.every((c) => c.ok)
  process.stdout.write(`\nSTOCK_PREPARATION_T2_ERP_MATERIAL_REALDB_SMOKE\n`)
  process.stdout.write(`checks=${CHECKS.length} passed=${CHECKS.filter((c) => c.ok).length} failed=${CHECKS.filter((c) => !c.ok).length}\n`)
  process.stdout.write(`pass=${pass}\n`)
  // The pg pool keeps the event loop alive; force-exit so the process terminates deterministically.
  process.exit(pass ? 0 : 1)
}

// Watchdog: never hang a CI/manual run — fail loudly if something blocks.
const watchdog = setTimeout(() => {
  process.stderr.write('[realdb-smoke] fatal: watchdog timeout (120s)\n')
  process.stdout.write('pass=false\n')
  process.exit(1)
}, 120000)
watchdog.unref()

main().catch((error) => {
  process.stderr.write(`[realdb-smoke] fatal: ${error && error.stack ? error.stack : error}\n`)
  process.stdout.write('pass=false\n')
  process.exit(1)
})
