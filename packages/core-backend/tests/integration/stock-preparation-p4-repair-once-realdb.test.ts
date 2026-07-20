/**
 * P4 Option C real-DB proof: construct pre-P4 partial commits with the historical write order, then
 * run the owner-only repair through the production plugin facade. No HTTP route is mounted.
 */
import { createRequire } from 'module'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { STDERR_DIAGNOSTIC_MARKER } from '../../scripts/stock-preparation-persist-repair-once'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import type { LoadedPlugin } from '../../src/core/plugin-loader'
import type { PluginContext } from '../../src/types/plugin'

const require = createRequire(import.meta.url)
const {
  BATCH_OBJECT_ID,
  LINE_OBJECT_ID,
  PROJECT_OBJECT_ID,
  RUN_OBJECT_ID,
  persistStockPreparationSyncRun,
  __internals: {
    groundLineRow,
    resolveScopedTarget,
    upsertStockPreparationProject,
  },
} = require('../../../../plugins/plugin-integration-core/lib/stock-preparation-sync-run-persist.cjs')
const {
  planBomSnapshotSyncRun,
} = require('../../../../plugins/plugin-integration-core/lib/stock-preparation-sync-run-plan.cjs')
const {
  repairStockPreparationSyncRunOnce,
} = require('../../../../plugins/plugin-integration-core/lib/stock-preparation-sync-run-repair-once.cjs')
const {
  ensureStockPreparationMvpTargets,
  syncStockPreparationMvpOptions,
} = require('../../../../plugins/plugin-integration-core/lib/stock-preparation-mvp-provisioning.cjs')
const {
  createDb,
} = require('../../../../plugins/plugin-integration-core/lib/db.cjs')
const {
  createStockPreparationAuditStore,
} = require('../../../../plugins/plugin-integration-core/lib/stock-preparation-audit-store.cjs')
const {
  STOCK_PREPARATION_MVP_TABLE_TEMPLATES,
} = require('../../../../plugins/plugin-integration-core/lib/stock-preparation-templates.cjs')

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const execFileAsync = promisify(execFile)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const TOKEN = `${process.pid}_${Date.now().toString(36)}`
const TENANT_ID = `tenant_p4repair_${TOKEN}`
const TARGET_PROJECT_ID = `${TENANT_ID}:integration-core`
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

function createProductionPluginContext(): PluginContext {
  const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
  const loaded: LoadedPlugin = {
    manifest: { name: 'plugin-integration-core', version: 'repair-realdb' },
    plugin: { activate: async () => {} },
    path: 'realdb://stock-preparation-p4-repair-once',
    loadedAt: new Date(),
  }
  return (server as unknown as {
    createPluginContext: (plugin: LoadedPlugin) => PluginContext
  }).createPluginContext(loaded)
}

function expansionRows() {
  return [
    {
      componentSourceId: `component_a_${TOKEN}`,
      componentCode: `MATERIAL-A-${TOKEN}`,
      sourceVersion: 'A',
      path: `/root/MATERIAL-A-${TOKEN}`,
      rawQuantity: 1,
    },
    {
      componentSourceId: `component_b_${TOKEN}`,
      componentCode: `MATERIAL-B-${TOKEN}`,
      sourceVersion: 'A',
      path: `/root/MATERIAL-B-${TOKEN}`,
      rawQuantity: 2,
    },
  ]
}

function persistInput(
  multitable: NonNullable<PluginContext['api']['multitable']>,
  suffix: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    permission: 'admin',
    recordsApi: multitable.records,
    provisioning: multitable.provisioning,
    targetProjectId: TARGET_PROJECT_ID,
    lockTenantId: TENANT_ID,
    projectId: `project_${suffix}_${TOKEN}`,
    sourceProjectNo: `SOURCE-${suffix}-${TOKEN}`,
    sourceSystem: 'data-source:sql-readonly',
    syncRunId: `run_${suffix}_${TOKEN}`,
    snapshotBatchId: `batch_${suffix}_${TOKEN}`,
    snapshotVersion: 1,
    defaultDesignUnit: 'pcs',
    expansionResult: expansionRows(),
    ...overrides,
  }
}

function repairManifest(input: Record<string, unknown>) {
  const {
    permission: _permission,
    recordsApi: _recordsApi,
    provisioning: _provisioning,
    targetProjectId: _targetProjectId,
    lockTenantId: _lockTenantId,
    ...planInput
  } = input
  return {
    ...planInput,
    tenantId: TENANT_ID,
    actorId: 'p4_repair_realdb',
  }
}

async function runRepairCli(manifestPath: string, extraArgs: string[] = []) {
  const { stdout, stderr } = await execFileAsync(
    PNPM,
    ['--silent', 'ops:stock-prep-persist-repair-once', '--input', manifestPath, ...extraArgs],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
      maxBuffer: 1024 * 1024,
    },
  )
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean)
  expect(lines).toHaveLength(1)
  expect(stderr).toContain(STDERR_DIAGNOSTIC_MARKER)
  expect(stderr).not.toContain(`MATERIAL-A-${TOKEN}`)
  expect(stderr).not.toContain(`MATERIAL-B-${TOKEN}`)
  return { summary: JSON.parse(lines[0]) as Record<string, unknown>, stdout, stderr }
}

async function resolveTargets(multitable: NonNullable<PluginContext['api']['multitable']>) {
  const args = [multitable.records, multitable.provisioning, TARGET_PROJECT_ID]
  return {
    batch: await resolveScopedTarget(...args, BATCH_OBJECT_ID),
    line: await resolveScopedTarget(...args, LINE_OBJECT_ID),
    run: await resolveScopedTarget(...args, RUN_OBJECT_ID),
    project: await resolveScopedTarget(...args, PROJECT_OBJECT_ID),
  }
}

async function seedLegacyPartial(
  multitable: NonNullable<PluginContext['api']['multitable']>,
  input: Record<string, unknown>,
  state: { lineCount: number; includeRun: boolean },
) {
  const plan = planBomSnapshotSyncRun({ permission: 'admin', ...input })
  const targets = await resolveTargets(multitable)
  await targets.batch.scoped.createRecord({ data: plan.snapshotBatch })
  for (const line of plan.snapshotLines.slice(0, state.lineCount)) {
    await targets.line.scoped.createRecord({ data: groundLineRow(line) })
  }
  if (state.includeRun) await targets.run.scoped.createRecord({ data: plan.syncRun })
  return { plan, targets }
}

// Seed ONLY the immutable batch row for `input` (no lines / run / project) — a legacy orphan batch,
// used to construct history that the pointer-repair proof must reject (advanced_history /
// ambiguous_history) without any prior pointer move.
async function seedOrphanBatch(
  multitable: NonNullable<PluginContext['api']['multitable']>,
  input: Record<string, unknown>,
) {
  const plan = planBomSnapshotSyncRun({ permission: 'admin', ...input })
  const targets = await resolveTargets(multitable)
  await targets.batch.scoped.createRecord({ data: plan.snapshotBatch })
  return { plan, targets }
}

if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
  test('P4 repair real-DB allowlist must provide DATABASE_URL', () => {
    throw new Error('P4 repair real-DB allowlist step is missing DATABASE_URL')
  })
}

describeIfDatabase('stock-preparation P4 one-shot repair (real DB)', () => {
  const pluginContext = createProductionPluginContext()
  const multitable = pluginContext.api.multitable
  if (!multitable) throw new Error('production plugin context is missing multitable APIs')
  const context = { api: { multitable }, storage: {}, config: {} }
  const auditStore = createStockPreparationAuditStore({
    db: createDb({ database: pluginContext.api.database }),
  })
  const objectIds = [PROJECT_OBJECT_ID, BATCH_OBJECT_ID, LINE_OBJECT_ID, RUN_OBJECT_ID]
  const sheetIds: string[] = []

  beforeAll(async () => {
    const ensured = await ensureStockPreparationMvpTargets({
      context,
      projectId: TARGET_PROJECT_ID,
      permission: 'admin',
      objectIds,
    })
    expect(ensured).toMatchObject({ ready: true })
    await syncStockPreparationMvpOptions({
      context,
      projectId: TARGET_PROJECT_ID,
      permission: 'admin',
      objectIds,
      optionSets: {
        stock_preparation_project_status_v1: ['active'].map((value) => ({ value })),
        stock_preparation_snapshot_status_v1: ['draft', 'active', 'superseded', 'rejected']
          .map((value) => ({ value })),
        stock_preparation_bom_line_status_v1: ['imported', 'active', 'inactive', 'incomplete']
          .map((value) => ({ value })),
        stock_preparation_run_type_v1: ['plm_sync', 'erp_material_sync', 'mapping_match', 'unit_match', 'prep_generate']
          .map((value) => ({ value })),
        stock_preparation_run_status_v1: ['running', 'succeeded', 'failed', 'partial']
          .map((value) => ({ value })),
      },
    })
    for (const objectId of objectIds) {
      const sheet = await multitable.provisioning.findObjectSheet({ projectId: TARGET_PROJECT_ID, objectId })
      if (!sheet) throw new Error(`P4 repair real-DB provisioning did not create ${objectId}`)
      sheetIds.push(sheet.id)
    }
  })

  afterAll(async () => {
    if (sheetIds.length === 0) return
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = ANY($1::text[])', [sheetIds]).catch(() => {})
    await q(
      'DELETE FROM meta_links WHERE record_id IN (SELECT id FROM meta_records WHERE sheet_id = ANY($1::text[])) OR foreign_record_id IN (SELECT id FROM meta_records WHERE sheet_id = ANY($1::text[]))',
      [sheetIds],
    ).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [sheetIds]).catch(() => {})
    await q('DELETE FROM meta_views WHERE sheet_id = ANY($1::text[])', [sheetIds]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [sheetIds]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [sheetIds]).catch(() => {})
  })

  test('CW1, CW2, CW3, and CW4-first repair to exact replay and are idempotent', async () => {
    const scenarios = [
      { name: 'cw1', lineCount: 0, includeRun: false },
      { name: 'cw2', lineCount: 1, includeRun: false },
      { name: 'cw3', lineCount: 2, includeRun: false },
      { name: 'cw4_first', lineCount: 2, includeRun: true },
    ]
    for (const scenario of scenarios) {
      const input = persistInput(multitable, scenario.name)
      await seedLegacyPartial(multitable, input, scenario)
      const repaired = await repairStockPreparationSyncRunOnce({
        ...input,
        auditStore,
        auditActor: 'p4_repair_realdb',
        apply: true,
      })
      expect(repaired).toMatchObject({ persisted: true, mode: 'repaired', applied: true })
      await expect(persistStockPreparationSyncRun(input)).resolves.toMatchObject({
        persisted: false,
        mode: 'skipped_existing',
      })
      await expect(repairStockPreparationSyncRunOnce({
        ...input,
        auditStore,
        auditActor: 'p4_repair_realdb',
        apply: true,
      })).resolves.toMatchObject({ persisted: false, mode: 'noop', repairable: false })
    }
  }, 30_000)

  test('CW4-existing advances only the stale live pointer and preserves immutable rows', async () => {
    const suffix = 'cw4_existing'
    const base = persistInput(multitable, suffix, {
      syncRunId: `run_${suffix}_v1_${TOKEN}`,
      snapshotBatchId: `batch_${suffix}_v1_${TOKEN}`,
      snapshotVersion: 1,
    })
    await persistStockPreparationSyncRun(base)
    const next = persistInput(multitable, suffix, {
      syncRunId: `run_${suffix}_v2_${TOKEN}`,
      snapshotBatchId: `batch_${suffix}_v2_${TOKEN}`,
      snapshotVersion: 2,
    })
    await seedLegacyPartial(multitable, next, { lineCount: 2, includeRun: true })

    const before = await q('SELECT count(*)::int AS count FROM meta_records WHERE sheet_id = ANY($1::text[])', [sheetIds])
    const repaired = await repairStockPreparationSyncRunOnce({
      ...next,
      auditStore,
      auditActor: 'p4_repair_realdb',
      apply: true,
    })
    expect(repaired).toMatchObject({
      persisted: true,
      mode: 'repaired',
      created: { lines: 0, run: 0, project: 0 },
      patched: { project: 1 },
    })
    const after = await q('SELECT count(*)::int AS count FROM meta_records WHERE sheet_id = ANY($1::text[])', [sheetIds])
    expect(after.rows).toEqual(before.rows)
    await expect(persistStockPreparationSyncRun(next)).resolves.toMatchObject({ mode: 'skipped_existing' })
  }, 30_000)

  test('a frozen-projection mismatch is refused and audited without adding rows', async () => {
    const input = persistInput(multitable, 'mismatch')
    const { plan, targets } = await seedLegacyPartial(multitable, input, { lineCount: 0, includeRun: false })
    await targets.line.scoped.createRecord({
      data: groundLineRow({ ...plan.snapshotLines[0], designQty: 999 }),
    })
    const before = await q('SELECT count(*)::int AS count FROM meta_records WHERE sheet_id = ANY($1::text[])', [sheetIds])

    await expect(repairStockPreparationSyncRunOnce({
      ...input,
      auditStore,
      auditActor: 'p4_repair_realdb',
      apply: true,
    })).rejects.toMatchObject({
      status: 409,
      code: 'PERSIST_REPAIR_REFUSED',
      details: { target: 'snapshot_line', reason: 'content_mismatch' },
    })
    const after = await q('SELECT count(*)::int AS count FROM meta_records WHERE sheet_id = ANY($1::text[])', [sheetIds])
    expect(after.rows).toEqual(before.rows)
    const audit = await q(
      "SELECT action, mode, detail FROM integration_stock_prep_audit WHERE tenant_id = $1 AND action = 'persist_repair_once' ORDER BY created_at DESC LIMIT 1",
      [TENANT_ID],
    )
    expect(audit.rows[0]).toMatchObject({
      action: 'persist_repair_once',
      mode: 'refused',
      detail: { persisted: false, result: 'refused', failureCode: 'PERSIST_REPAIR_REFUSED' },
    })
  }, 30_000)

  // #4473 P3-1 (owner review): the three CORRUPTING-prevention refusal branches — non_suffix_gap
  // (a middle gap that a broken guard would double-append), advanced_history and ambiguous_history
  // (pointer-repair proofs) — were executed only by the path-filtered, NON-required .cjs suite.
  // These real-DB cases put them in the required gate: each asserts a 409 refusal and that the state
  // is untouched (ZERO rows added, and — for the pointer cases — the live pointer unchanged), so
  // deleting a guard turns a required check red instead of an advisory. The gap case additionally
  // asserts the refused audit row; the audit path is already covered elsewhere for the other two.

  test('a middle line gap is refused as non_suffix_gap and adds no rows (a broken guard would double-append)', async () => {
    const input = persistInput(multitable, 'gap')
    const { plan, targets } = await seedLegacyPartial(multitable, input, { lineCount: 0, includeRun: false })
    // Seed ONLY the SECOND plan line — a non-prefix, plan-order middle/tail gap (line[0] missing).
    await targets.line.scoped.createRecord({ data: groundLineRow(plan.snapshotLines[1]) })
    const before = await q('SELECT count(*)::int AS count FROM meta_records WHERE sheet_id = ANY($1::text[])', [sheetIds])

    await expect(repairStockPreparationSyncRunOnce({
      ...input,
      auditStore,
      auditActor: 'p4_repair_realdb',
      apply: true,
    })).rejects.toMatchObject({
      status: 409,
      code: 'PERSIST_REPAIR_REFUSED',
      details: { target: 'snapshot_line', reason: 'non_suffix_gap' },
    })
    const after = await q('SELECT count(*)::int AS count FROM meta_records WHERE sheet_id = ANY($1::text[])', [sheetIds])
    expect(after.rows).toEqual(before.rows)
    const audit = await q(
      "SELECT mode, detail FROM integration_stock_prep_audit WHERE tenant_id = $1 AND action = 'persist_repair_once' ORDER BY created_at DESC LIMIT 1",
      [TENANT_ID],
    )
    expect(audit.rows[0]).toMatchObject({ mode: 'refused', detail: { result: 'refused', reason: 'non_suffix_gap' } })
  }, 30_000)

  test('a stale pointer is not patched when a higher batch version exists in history (advanced_history)', async () => {
    // V1 commits fully — the live pointer names run_v1 (version 1).
    const v1 = persistInput(multitable, 'adv', {
      syncRunId: `run_adv_v1_${TOKEN}`,
      snapshotBatchId: `batch_adv_v1_${TOKEN}`,
      snapshotVersion: 1,
    })
    await persistStockPreparationSyncRun(v1)
    // A legacy ORPHAN batch at version 3 exists in history (pointer NOT moved to it).
    await seedOrphanBatch(multitable, persistInput(multitable, 'adv', {
      syncRunId: `run_adv_v3_${TOKEN}`,
      snapshotBatchId: `batch_adv_v3_${TOKEN}`,
      snapshotVersion: 3,
    }))
    // A structurally-complete V2 whose only gap is the stale pointer (still on v1).
    const v2 = persistInput(multitable, 'adv', {
      syncRunId: `run_adv_v2_${TOKEN}`,
      snapshotBatchId: `batch_adv_v2_${TOKEN}`,
      snapshotVersion: 2,
    })
    await seedLegacyPartial(multitable, v2, { lineCount: 2, includeRun: true })
    const before = await q('SELECT count(*)::int AS count FROM meta_records WHERE sheet_id = ANY($1::text[])', [sheetIds])
    // Capture the live pointer row's full data blob so a "patch-then-throw" bug (rows count would
    // stay equal but the pointer would already point at v2) is caught directly, not just by count.
    const pointerBefore = await q(
      "SELECT data FROM meta_records WHERE sheet_id = $1 AND data::text LIKE '%' || $2 || '%'",
      [sheetIds[0], v2.projectId],
    )
    expect(pointerBefore.rows).toHaveLength(1)

    // Repairing V2 would patch the pointer (v1 < v2), but history's max version is 3 > 2 → refused.
    await expect(repairStockPreparationSyncRunOnce({
      ...v2,
      auditStore,
      auditActor: 'p4_repair_realdb',
      apply: true,
    })).rejects.toMatchObject({
      status: 409,
      code: 'PERSIST_REPAIR_REFUSED',
      details: { target: 'project', reason: 'advanced_history' },
    })
    const after = await q('SELECT count(*)::int AS count FROM meta_records WHERE sheet_id = ANY($1::text[])', [sheetIds])
    expect(after.rows).toEqual(before.rows)
    const pointerAfter = await q(
      "SELECT data FROM meta_records WHERE sheet_id = $1 AND data::text LIKE '%' || $2 || '%'",
      [sheetIds[0], v2.projectId],
    )
    // The live pointer still names run_v1 — unchanged blob proves no partial patch preceded the throw.
    expect(pointerAfter.rows).toEqual(pointerBefore.rows)
  }, 30_000)

  test('a project pointer is not created when the top history version is tied across batches (ambiguous_history)', async () => {
    // A structurally-complete candidate at version 2, project row MISSING (would create the pointer).
    const candidate = persistInput(multitable, 'amb', {
      syncRunId: `run_amb_cand_${TOKEN}`,
      snapshotBatchId: `batch_amb_cand_${TOKEN}`,
      snapshotVersion: 2,
    })
    await seedLegacyPartial(multitable, candidate, { lineCount: 2, includeRun: true })
    // A second batch of the SAME project ties the top version (also version 2).
    await seedOrphanBatch(multitable, persistInput(multitable, 'amb', {
      syncRunId: `run_amb_other_${TOKEN}`,
      snapshotBatchId: `batch_amb_other_${TOKEN}`,
      snapshotVersion: 2,
    }))
    const before = await q('SELECT count(*)::int AS count FROM meta_records WHERE sheet_id = ANY($1::text[])', [sheetIds])

    await expect(repairStockPreparationSyncRunOnce({
      ...candidate,
      auditStore,
      auditActor: 'p4_repair_realdb',
      apply: true,
    })).rejects.toMatchObject({
      status: 409,
      code: 'PERSIST_REPAIR_REFUSED',
      details: { target: 'project', reason: 'ambiguous_history' },
    })
    const after = await q('SELECT count(*)::int AS count FROM meta_records WHERE sheet_id = ANY($1::text[])', [sheetIds])
    expect(after.rows).toEqual(before.rows)
  }, 30_000)

  test('the real CLI defaults to dry-run, emits one values-free line, and writes no snapshot rows', async () => {
    const input = persistInput(multitable, 'cli_cw1')
    await seedLegacyPartial(multitable, input, { lineCount: 0, includeRun: false })
    const directory = await mkdtemp(path.join(tmpdir(), 'stock-prep-p4-repair-'))
    const manifestPath = path.join(directory, 'repair.json')
    await writeFile(manifestPath, JSON.stringify(repairManifest(input)), { mode: 0o600 })
    try {
      const before = await q('SELECT count(*)::int AS count FROM meta_records WHERE sheet_id = ANY($1::text[])', [sheetIds])
      const dryRun = await runRepairCli(manifestPath)
      expect(dryRun.summary).toMatchObject({
        status: 'PASS',
        mode: 'dry_run',
        result: {
          applied: false,
          repairable: true,
          evidence: { externalWrite: false, valuesFree: true },
        },
      })
      expect(dryRun.stdout).not.toContain(`MATERIAL-A-${TOKEN}`)
      expect(dryRun.stdout).not.toContain(`MATERIAL-B-${TOKEN}`)
      const afterDryRun = await q('SELECT count(*)::int AS count FROM meta_records WHERE sheet_id = ANY($1::text[])', [sheetIds])
      expect(afterDryRun.rows).toEqual(before.rows)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 45_000)

  test('the frozen templates used by the real-DB fixture remain present', () => {
    const available = new Set(STOCK_PREPARATION_MVP_TABLE_TEMPLATES.map((entry: { objectId: string }) => entry.objectId))
    for (const objectId of objectIds) expect(available.has(objectId)).toBe(true)
  })
})
