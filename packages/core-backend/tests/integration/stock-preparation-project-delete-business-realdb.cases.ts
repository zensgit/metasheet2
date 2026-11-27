// Registered by the stock-preparation real-DB host. Every test uses the real migrated
// schema and discards its complete fixture on ROLLBACK.
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { describe, expect, test } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'

const require = createRequire(import.meta.url)
const plugin = '../../../../plugins/plugin-integration-core/lib/'
const { planBusiness, deleteBusiness } = require(plugin + 'stock-preparation-project-delete-business.cjs')
const { sheetWriteScopeKey } = require(plugin + 'stock-preparation-project-write-lock.cjs')

interface Tx {
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>
}

async function within(fn: (tx: Tx) => Promise<void>) {
  const client = await poolManager.get().getInternalPool().connect()
  try {
    await client.query('BEGIN')
    await fn({ query: async (sql, params) => (await client.query(sql, params)).rows })
  } finally {
    try {
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  }
}

function fixture() {
  const prefix = 'biz6991_' + randomUUID()
  const scope = { tenantId: prefix, projectNo: 'same-number' }
  const sheet = prefix + '-sheet'
  const sheetPlan = { identityPresent: true, dedicatedSheetId: sheet, ownedTargetSheetIds: [sheet], tables: [] }
  return { prefix, scope, sheet, sheetPlan }
}

async function batch(tx: Tx, scope: { tenantId: string, projectNo: string }, sheet: string) {
  const id = 'batch6991_' + randomUUID()
  await tx.query(`INSERT INTO integration_stock_prep_pull_batch
    (id, tenant_id, project_no, sheet_id, batch_no, origin, status, label, display_day, source_digest)
    VALUES ($1,$2,$3,$4,1,'live','open','synthetic',current_date,repeat('1',32))`, [id, scope.tenantId, scope.projectNo, sheet])
  return id
}

export function defineProjectDeleteBusinessRealDbCases() {
  describe('project deletion business ledgers', () => {
    test('same-count edits change the fingerprint and deletion preserves both controls and fences recreation', () => within(async tx => {
      const { prefix, scope, sheet, sheetPlan } = fixture()
      const target = await batch(tx, scope, sheet)
      const other = await batch(tx, { ...scope, projectNo: 'another' }, prefix + '-other')
      const tenant = await batch(tx, { ...scope, tenantId: prefix + '-tenant' }, prefix + '-tenant-sheet')
      const plan = await planBusiness(tx, scope, sheetPlan)
      expect(plan.counts.pullBatches).toBe(1)
      await tx.query("UPDATE integration_stock_prep_pull_batch SET label = 'changed' WHERE id = $1", [target])
      const edited = await planBusiness(tx, scope, sheetPlan)
      expect(edited.counts).toEqual(plan.counts)
      expect(edited.fingerprint).not.toBe(plan.fingerprint)
      await deleteBusiness(tx, scope, edited)
      expect(await tx.query('SELECT id FROM integration_stock_prep_pull_batch WHERE id = ANY($1::text[]) ORDER BY id',
        [[target, other, tenant]])).toEqual([other, tenant].sort().map(id => ({ id })))
      expect(await tx.query('SELECT generation, generation_reason FROM integration_stock_prep_project_write_lock WHERE scope_key = $1',
        [sheetWriteScopeKey(sheet)])).toEqual([{ generation: 1, generation_reason: 'project_delete' }])
    }))

    test('an unfinished batch writer blocks deletion and a closed child in a different project blocks both projects', () => within(async tx => {
      const { prefix, scope, sheet, sheetPlan } = fixture()
      const target = await batch(tx, scope, sheet)
      const link = prefix + '-link'
      await tx.query(`INSERT INTO integration_stock_prep_pull_batch_execution
        (id,batch_id,tenant_id,sheet_id,project_no,execution_ref,lane)
        VALUES ($1,$2,$3,$4,$5,$1,'small_apply')`, [link, target, scope.tenantId, sheet, scope.projectNo])
      await expect(planBusiness(tx, scope, sheetPlan)).rejects.toMatchObject({ status: 409, code: 'STOCK_PREPARATION_PROJECT_DELETE_BUSY' })
      const other = { ...scope, projectNo: 'another' }
      const otherSheet = prefix + '-other'
      await tx.query(`UPDATE integration_stock_prep_pull_batch_execution
        SET finished_at = now(), writer_status = 'succeeded', sheet_id = $2, project_no = $3 WHERE id = $1`,
      [link, otherSheet, other.projectNo])
      const ambiguous = { status: 409, code: 'STOCK_PREPARATION_PROJECT_DELETE_AMBIGUOUS' }
      await expect(planBusiness(tx, scope, sheetPlan)).rejects.toMatchObject(ambiguous)
      await expect(planBusiness(tx, other, {
        ...sheetPlan, dedicatedSheetId: otherSheet, ownedTargetSheetIds: [otherSheet],
      })).rejects.toMatchObject(ambiguous)
    }))

    test('legacy shared targets retain other project rows and reject an unverified sheet', () => within(async tx => {
      const { scope, sheet, sheetPlan } = fixture()
      const target = await batch(tx, scope, sheet)
      const other = await batch(tx, { ...scope, projectNo: 'another' }, sheet)
      const shared = { ...sheetPlan, dedicatedSheetId: null, tables: [{ sheetId: sheet }] }
      await expect(planBusiness(tx, scope, { ...shared, ownedTargetSheetIds: [] })).rejects.toMatchObject({
        status: 409, code: 'STOCK_PREPARATION_PROJECT_DELETE_AMBIGUOUS',
      })
      const plan = await planBusiness(tx, scope, shared)
      expect(plan.counts.pullBatches).toBe(1)
      await deleteBusiness(tx, scope, plan)
      expect(await tx.query('SELECT id FROM integration_stock_prep_pull_batch WHERE id = ANY($1::text[])', [[target, other]]))
        .toEqual([{ id: other }])
    }))
  })
}
