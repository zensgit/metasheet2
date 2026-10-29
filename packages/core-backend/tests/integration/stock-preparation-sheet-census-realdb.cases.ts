/**
 * Batch-refresh step 6d-1a (design-final §6.4, S6-0) — real-Postgres parity of the doubled-sheet census PACK
 * (scripts/ops/stock-prep-sheet-census-20261027/01-sheet-census.sql, the R-line psql pack) with the pure module
 * (plugins/plugin-integration-core/lib/stock-preparation-sheet-census.cjs `censusOfRows`).
 *
 * This is a CASES MODULE, not a test file: `defineStockPreparationSheetCensusRealDbCases()` registers its `describe`
 * block and is called from the already-wired stock-prep real-DB host
 * (tests/integration/stock-preparation-p4-repair-once-realdb.test.ts), so the cases run in the existing "Run
 * multitable real-DB integration" step of .github/workflows/plugin-tests.yml without a workflow edit (the pushing
 * token has no `workflow` scope; design §6.4 / OQ-11). Do NOT also list it as a standalone file in that step.
 * It is a module of its own (not a block of the write-lock cases module the design names) so it stays off the
 * regions the in-flight PR-8 round 2 edits.
 *
 *   S9D-02 pack parity: three synthetic project sheets built by the REAL provisioning (staging project
 *          `T:integration-core`, the project-sheet objectId, the registry row through the registry store), seeded
 *          with D1-D5 plus creator variants, a row of another project and an empty sheet. The pack's SQL text, run
 *          by the real `psql` on the same PostgreSQL, prints per-sheet counts EQUAL to `censusOfRows` over the
 *          project-scoped reader (`readExistingStockPreparationRows` over the host records API). Every count is
 *          non-zero on some sheet. The default output carries no project number, objectId, sheet id or tenant;
 *          the ordinal -> objectId map appears only with `-v emit_private_map=1` (SC-02 on real output).
 *   S9D-03 fail closed: a registry row whose sheet_id does not match the derived one reports
 *          `status=incomplete reason=sheet_id_mismatch` and NO counts; a registry row whose derived sheet was never
 *          provisioned reports `reason=sheet_missing`; the run's CENSUS_RESULT is then incomplete; the good sheets
 *          keep their complete lines.
 *
 * Edge cells (the string 'false', 0, NBSP, a creator) are shaped with direct `UPDATE meta_records` on this
 * throwaway database — the records API would coerce or refuse them, and the census must read what is stored.
 * Values-free: every id is synthetic and per-run.
 */
import { execFile, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'module'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import type { LoadedPlugin } from '../../src/core/plugin-loader'
import type { PluginContext } from '../../src/types/plugin'

const require = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const PLUGIN_LIB = path.join(REPO_ROOT, 'plugins/plugin-integration-core/lib')
const PACK_FILE = path.join(REPO_ROOT, 'scripts/ops/stock-prep-sheet-census-20261027/01-sheet-census.sql')

const { createDb } = require(path.join(PLUGIN_LIB, 'db.cjs')) as any
const censusLib = require(path.join(PLUGIN_LIB, 'stock-preparation-sheet-census.cjs')) as any
const tableActionsLib = require(path.join(PLUGIN_LIB, 'stock-preparation-table-actions.cjs')) as any
const projectTargetStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-project-target-store.cjs')) as any
const projectTargetsLib = require(path.join(PLUGIN_LIB, 'stock-preparation-project-targets.cjs')) as any
const ownBaseLib = require(path.join(PLUGIN_LIB, 'stock-preparation-own-base.cjs')) as any
const { ensureStockPreparationSandboxTarget } = require(path.join(PLUGIN_LIB, 'stock-preparation-target-provisioning.cjs')) as any
const { syncStockPreparationContractOptionsForObject } = require(path.join(PLUGIN_LIB, 'stock-preparation-option-sync.cjs')) as any

const { censusOfRows, SHEET_CENSUS_COUNT_KEYS } = censusLib
const { readExistingStockPreparationRows } = tableActionsLib.__internals

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const execFileAsync = promisify(execFile)
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

// `PSQL` may name the binary (the inventory-pack precedent) or a node shim (.cjs/.mjs/.js) — e.g. a local one that
// forwards to a psql inside WSL. CI uses the runner's own `psql`.
const PSQL = process.env.PSQL || 'psql'
const PSQL_IS_SCRIPT = /\.(?:c|m)?js$/.test(PSQL)
function psqlCommand(args: string[]): [string, string[]] {
  return PSQL_IS_SCRIPT ? [process.execPath, [PSQL, ...args]] : [PSQL, args]
}
function psqlAvailable(): boolean {
  const [command, args] = psqlCommand(['--version'])
  const result = spawnSync(command, args, { encoding: 'utf8' })
  return result.status === 0
}

const snake = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
const sha1Id = (prefix: string, ...parts: string[]) => `${prefix}_${createHash('sha1').update(parts.join(':')).digest('hex').slice(0, 24)}`

function createProductionPluginContext(): PluginContext {
  const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
  const loaded: LoadedPlugin = {
    manifest: { name: 'plugin-integration-core', version: 'sheet-census-realdb' },
    plugin: { activate: async () => {} },
    path: 'realdb://stock-preparation-sheet-census',
    loadedAt: new Date(),
  }
  return (server as unknown as { createPluginContext: (plugin: LoadedPlugin) => PluginContext }).createPluginContext(loaded)
}

type PackLine = { kind: string; fields: Record<string, string> }
function parsePack(stdout: string): PackLine[] {
  return stdout.split(/\r?\n/).filter((line) => /^CENSUS_[A-Z]+ /.test(line)).map((line) => {
    const [kind, ...pairs] = line.trim().split(' ')
    return { kind, fields: Object.fromEntries(pairs.map((pair) => { const at = pair.indexOf('='); return [pair.slice(0, at), pair.slice(at + 1)] })) }
  })
}

export function defineStockPreparationSheetCensusRealDbCases(): void {
  test('sheet census real-DB sentinel: the real-DB step must have DATABASE_URL and psql (fail-not-skip)', () => {
    if (process.env.METASHEET_REAL_DB_TEST_STEP !== '1') return
    if (!process.env.DATABASE_URL) throw new Error('METASHEET_REAL_DB_TEST_STEP=1 but DATABASE_URL is unset — the S6-0 census parity cases would skip-green')
    if (!psqlAvailable()) throw new Error(`METASHEET_REAL_DB_TEST_STEP=1 but ${PSQL} is not runnable — the S6-0 census pack cannot be executed`)
  })

  describeIfDatabase('S9 step-6 doubled-sheet census: R-line psql pack parity with censusOfRows (real Postgres, S6-0)', () => {
    const TOKEN = `${process.pid}_${Date.now().toString(36)}`
    const TENANT = `tenant_s60_${TOKEN}`
    const PROJECT_ID = `${TENANT}:integration-core`
    const SENTINEL_PROJECT = `S60-SENTINEL-${TOKEN}`
    const sheets: string[] = []
    const pluginContext = createProductionPluginContext()
    const multitable: any = pluginContext.api.multitable
    const registry = projectTargetStoreLib.createStockPreparationProjectTargetStore({ db: createDb({ database: pluginContext.api.database }) })
    type Sheet = { projectNo: string; objectId: string; sheetId: string; fields: Record<string, string>; target: any }
    const built: Sheet[] = []

    async function projectSheet(projectNo: string): Promise<Sheet> {
      const objectId: string = ownBaseLib.deriveStockPreparationProjectSheetObjectId(TENANT, projectNo)
      const ensured = await ensureStockPreparationSandboxTarget({ context: { api: { multitable } }, projectId: PROJECT_ID, permission: 'admin', objectId })
      expect(ensured.ready).toBe(true)
      await syncStockPreparationContractOptionsForObject({ provisioning: multitable.provisioning, projectId: PROJECT_ID, objectId })
      await projectTargetsLib.markProjectSheetPlmSystemColumns({ provisioning: multitable.provisioning, projectId: PROJECT_ID, objectId })
      const sheetId: string = ensured.target.sheetId
      sheets.push(sheetId)
      await registry.create({ tenantId: TENANT, projectNo, sheetId, objectId, createdBy: 'u_s60_puller' })
      const sheet = { projectNo, objectId, sheetId, fields: ensured.target.fieldIdMap || {}, target: ensured.target }
      built.push(sheet)
      return sheet
    }

    // One row: created through the host records API (projectNo only), then its stored cells shaped directly.
    async function seed(sheet: Sheet, cells: Record<string, unknown>, creator?: string) {
      const created = await multitable.records.createRecord({ sheetId: sheet.sheetId, data: { [sheet.fields.projectNo]: sheet.projectNo } })
      const patch: Record<string, unknown> = {}
      for (const [logical, value] of Object.entries(cells)) {
        const physical = sheet.fields[logical]
        if (!physical) throw new Error(`fixture field ${logical} is not on the sheet`)
        patch[physical] = value
      }
      await q('UPDATE meta_records SET data = data || $2::jsonb WHERE id = $1', [created.id, JSON.stringify(patch)])
      if (creator !== undefined) await q('UPDATE meta_records SET created_by = $2 WHERE id = $1', [created.id, creator])
    }

    async function runPack(extra: string[] = []) {
      const [command, args] = psqlCommand(['-X', '-q', '-d', String(process.env.DATABASE_URL), '-v', `tenant=${TENANT}`, ...extra, '-f', PACK_FILE])
      const { stdout, stderr } = await execFileAsync(command, args, { env: { ...process.env, PGCLIENTENCODING: 'UTF8' }, maxBuffer: 4 * 1024 * 1024 })
      return { stdout, stderr, lines: parsePack(stdout) }
    }

    async function moduleCensus(sheet: Sheet) {
      const rows = await readExistingStockPreparationRows(multitable.records, sheet.target, sheet.projectNo)
      return censusOfRows(rows)
    }

    beforeAll(async () => {
      // Sheet A (the sentinel project): D1, D3, D4 (both kinds; a blank created_by is no creator), D5 ('false' and 0), a null active, a row of
      // ANOTHER project (outside the project-scoped counts), a filled copy.
      const a = await projectSheet(SENTINEL_PROJECT)
      await seed(a, { idempotencyKey: 'a-S', componentSourceId: 'S60-S', parentSourceId: '', active: true })
      await seed(a, { idempotencyKey: 'a-S-C', componentSourceId: 'S60-C', parentSourceId: 'S60-S', active: true })
      await seed(a, { idempotencyKey: 'a-P', componentSourceId: 'S60-P', active: true })
      await seed(a, { idempotencyKey: 'a-P-S', componentSourceId: 'S60-S', parentSourceId: 'S60-P', active: true, notes: 'S60 filled on the copy' })
      await seed(a, { idempotencyKey: 'a-dup', componentSourceId: 'S60-D', parentSourceId: 'S60-P', active: true })
      await seed(a, { idempotencyKey: 'a-dup', componentSourceId: 'S60-D', parentSourceId: 'S60-P', active: false })
      await seed(a, { componentSourceId: 'S60-K1', parentSourceId: 'S60-P', active: true })
      await seed(a, { idempotencyKey: '   ', componentSourceId: 'S60-K2', parentSourceId: 'S60-P', active: true })
      await seed(a, { componentSourceId: 'S60-M1', parentSourceId: 'S60-P', active: true }, 'u_s60_hand')
      await seed(a, { componentSourceId: 'S60-M3', parentSourceId: 'S60-P', active: true }, '  ')
      await seed(a, { idempotencyKey: 'a-str-false', componentSourceId: 'S60-F', parentSourceId: 'S60-P', active: 'false', procurementReply: 'S60 reply' })
      await seed(a, { idempotencyKey: 'a-zero', componentSourceId: 'S60-Z', parentSourceId: 'S60-P', active: 0 })
      await seed(a, { idempotencyKey: 'a-null', componentSourceId: 'S60-N', parentSourceId: 'S60-P', active: null })
      await seed(a, { idempotencyKey: 'a-other', componentSourceId: 'S60-S', parentSourceId: '', active: true, projectNo: `S60-OTHER-${TOKEN}` })
      // Sheet B: the item-10 shape (D2) with fills on the hidden rows (boolean false is a fill, a whitespace note
      // is blank), a filled copy, an NBSP / U+3000 parent (a root), two hand-added keyless rows, a numeric key.
      const b = await projectSheet(`S60-B-${TOKEN}`)
      await seed(b, { idempotencyKey: 'b-S', componentSourceId: 'S60-S', parentSourceId: '', active: false, materialType: 'S60-type' })
      await seed(b, { idempotencyKey: 'b-S-C', componentSourceId: 'S60-C', parentSourceId: 'S60-S', active: false, procurementDone: false })
      await seed(b, { idempotencyKey: 'b-S-D', componentSourceId: 'S60-D', parentSourceId: 'S60-S', active: false, notes: '  \t ' })
      await seed(b, { idempotencyKey: 'b-P', componentSourceId: 'S60-P', parentSourceId: null, active: true })
      await seed(b, { idempotencyKey: 'b-P-S', componentSourceId: 'S60-S', parentSourceId: 'S60-P', active: true, warehouseConfirmation: 'S60 copy note' })
      await seed(b, { idempotencyKey: 'b-P-S-C', componentSourceId: 'S60-C', parentSourceId: 'S60-S', active: true })
      await seed(b, { idempotencyKey: 'b-R', componentSourceId: 'S60-R', parentSourceId: ' 　', active: true })
      await seed(b, { idempotencyKey: 'b-P-R', componentSourceId: 'S60-R', parentSourceId: 'S60-P', active: true })
      await seed(b, { componentSourceId: 'S60-M2', parentSourceId: 'S60-P', active: true }, 'u_s60_hand')
      await seed(b, { idempotencyKey: '', parentSourceId: 'S60-P', active: true }, 'u_s60_hand')
      await seed(b, { idempotencyKey: 7, componentSourceId: 'S60-K3', parentSourceId: 'S60-P', active: true })
      // Sheet C: provisioned and registered, no rows.
      await projectSheet(`S60-C-${TOKEN}`)
    }, 300000)

    afterAll(async () => {
      await q('DELETE FROM integration_stock_prep_project_target WHERE tenant_id = $1', [TENANT]).catch(() => {})
      for (const sheetId of sheets) {
        await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_views WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_sheets WHERE id = $1', [sheetId]).catch(() => {})
      }
    })

    test('S9D-02 the pack\'s per-sheet counts equal censusOfRows over the reader; every count is exercised; the default output is values-free', async () => {
      if (!psqlAvailable()) {
        if (process.env.METASHEET_REAL_DB_TEST_STEP === '1') throw new Error('psql is required in the real-DB step')
        console.warn('[S9D-02] psql not runnable — skipped outside the real-DB step')
        return
      }
      const plain = await runPack()
      const priv = await runPack(['-v', 'emit_private_map=1'])
      // The provisioning derivation the pack re-derives in SQL.
      for (const sheet of built) expect(sheet.sheetId).toBe(sha1Id('sheet', PROJECT_ID, sheet.objectId))

      const ordinalOf = new Map<string, string>()
      for (const line of priv.lines.filter((entry) => entry.kind === 'CENSUS_PRIVATE')) ordinalOf.set(line.fields.object_id, line.fields.ordinal)
      expect(ordinalOf.size).toBe(built.length)
      const sheetLines = new Map(plain.lines.filter((entry) => entry.kind === 'CENSUS_SHEET').map((entry) => [entry.fields.ordinal, entry.fields]))
      const observed: Record<string, unknown> = {}
      const expected: Record<string, unknown> = {}
      for (const sheet of built) {
        const fields = sheetLines.get(String(ordinalOf.get(sheet.objectId)))
        expect(fields).toBeTruthy()
        const census = await moduleCensus(sheet)
        observed[sheet.projectNo] = { status: fields!.status, ...Object.fromEntries(SHEET_CENSUS_COUNT_KEYS.map((key: string) => [key, Number(fields![snake(key)])])) }
        expected[sheet.projectNo] = { status: 'complete', ...Object.fromEntries(SHEET_CENSUS_COUNT_KEYS.map((key: string) => [key, census[key]])) }
      }
      console.log(`[S9D-02] ${JSON.stringify(Object.values(observed))}`)
      expect(observed).toEqual(expected)
      // No vacuous parity: every count is non-zero on some sheet, and the sheets differ.
      for (const key of SHEET_CENSUS_COUNT_KEYS) {
        expect(Object.values(observed).some((entry: any) => entry[key] > 0), `${key} exercised`).toBe(true)
      }
      expect(new Set(Object.values(observed).map((entry) => JSON.stringify(entry))).size).toBe(built.length)
      // Pinned values for the two shaped sheets (the module and the pack could otherwise agree on a shared bug).
      expect(observed[SENTINEL_PROJECT]).toMatchObject({ rowCount: 13, activeRowCount: 12, twoCopyComponents: 1, inactiveRootRemnantComponents: 0, duplicateKeyGroups: 1, keylessRowsWithoutCreator: 3, keylessRowsWithCreator: 1, nonBooleanActiveCells: 2, inactiveRowsWithHumanCells: 0, nestedCopiesWithHumanCells: 1 })
      expect(observed[`S60-B-${TOKEN}`]).toMatchObject({ rowCount: 11, activeRowCount: 8, twoCopyComponents: 1, inactiveRootRemnantComponents: 1, duplicateKeyGroups: 0, keylessRowsWithoutCreator: 1, keylessRowsWithCreator: 2, nonBooleanActiveCells: 0, inactiveRowsWithHumanCells: 2, nestedCopiesWithHumanCells: 1 })
      const sentinelLine = sheetLines.get(String(ordinalOf.get(built[0].objectId)))!
      expect(sentinelLine.sheet_rows_all_projects).toBe('14')

      const result = plain.lines[plain.lines.length - 1]
      expect(result.kind).toBe('CENSUS_RESULT')
      expect(result.fields).toMatchObject({ status: 'complete', sheets: '3', complete: '3', incomplete: '0', tenant_filter: 'on' })
      // SC-02 on the real output: nothing value-bearing in the default run; the private map only on request.
      for (const needle of [SENTINEL_PROJECT, TENANT, ...built.map((sheet) => sheet.objectId), ...built.map((sheet) => sheet.sheetId), 'S60-S', 'S60 filled']) {
        expect(plain.stdout.includes(needle), needle).toBe(false)
      }
      expect(plain.lines.every((line) => line.kind !== 'CENSUS_PRIVATE')).toBe(true)
      for (const sheet of built) expect(priv.stdout.includes(sheet.objectId)).toBe(true)
      expect(priv.stdout.includes(SENTINEL_PROJECT)).toBe(false)
    }, 300000)

    test('S9D-03 a registry row whose derived sheet id does not match reports sheet_id_mismatch and no counts; an unprovisioned sheet reports sheet_missing; the run is incomplete', async () => {
      if (!psqlAvailable()) {
        if (process.env.METASHEET_REAL_DB_TEST_STEP === '1') throw new Error('psql is required in the real-DB step')
        console.warn('[S9D-03] psql not runnable — skipped outside the real-DB step')
        return
      }
      const mismatchProject = `S60-MISMATCH-${TOKEN}`
      const mismatchObject: string = ownBaseLib.deriveStockPreparationProjectSheetObjectId(TENANT, mismatchProject)
      await q(
        'INSERT INTO integration_stock_prep_project_target (id, tenant_id, project_no, sheet_id, object_id, status) VALUES ($1, $2, $3, $4, $5, $6)',
        [`spt_s60_mm_${TOKEN}`, TENANT, mismatchProject, `sheet_s60_not_derived_${TOKEN}`, mismatchObject, 'active'],
      )
      const missingProject = `S60-MISSING-${TOKEN}`
      const missingObject: string = ownBaseLib.deriveStockPreparationProjectSheetObjectId(TENANT, missingProject)
      await q(
        'INSERT INTO integration_stock_prep_project_target (id, tenant_id, project_no, sheet_id, object_id, status, archived_at) VALUES ($1, $2, $3, $4, $5, $6, now())',
        [`spt_s60_ms_${TOKEN}`, TENANT, missingProject, sha1Id('sheet', PROJECT_ID, missingObject), missingObject, 'archived'],
      )
      const priv = await runPack(['-v', 'emit_private_map=1'])
      const plain = await runPack()
      const ordinalOf = new Map(priv.lines.filter((entry) => entry.kind === 'CENSUS_PRIVATE').map((entry) => [entry.fields.object_id, entry.fields.ordinal]))
      const lineOf = (objectId: string) => plain.stdout.split(/\r?\n/).find((line) => line.startsWith(`CENSUS_SHEET ordinal=${ordinalOf.get(objectId)} `))
      expect(lineOf(mismatchObject)).toBe(`CENSUS_SHEET ordinal=${ordinalOf.get(mismatchObject)} registry_status=active status=incomplete reason=sheet_id_mismatch`)
      expect(lineOf(missingObject)).toBe(`CENSUS_SHEET ordinal=${ordinalOf.get(missingObject)} registry_status=archived status=incomplete reason=sheet_missing`)
      for (const sheet of built) expect(lineOf(sheet.objectId)).toMatch(/ status=complete row_count=\d+ /)
      const result = plain.lines[plain.lines.length - 1]
      expect(result.kind).toBe('CENSUS_RESULT')
      expect(result.fields).toMatchObject({ status: 'incomplete', reason: 'sheet_checks_failed', sheets: '5', complete: '3', incomplete: '2' })
      expect(plain.stdout.includes(mismatchProject) || plain.stdout.includes(mismatchObject)).toBe(false)
    }, 300000)
  })
}
