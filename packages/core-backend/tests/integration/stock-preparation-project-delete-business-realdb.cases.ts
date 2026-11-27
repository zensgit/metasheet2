// Registered by the stock-preparation real-DB host. Every test uses the real migrated
// schema and discards its complete fixture on ROLLBACK.
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { describe, expect, test } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'

const require = createRequire(import.meta.url)
const plugin = '../../../../plugins/plugin-integration-core/lib/'
const { planBusiness, deleteBusiness, businessDeleteFenceKeys, BUSINESS_LOCK_TABLES } = require(plugin + 'stock-preparation-project-delete-business.cjs')
const { runtimeFenceKeys } = require(plugin + 'stock-preparation-project-delete-runtime.cjs')
const { projectDeleteDedicatedSheetId } = require(plugin + 'stock-preparation-project-delete-sheets.cjs')
const { __internals: policies } = require(plugin + 'stock-preparation-conflict-policies.cjs')
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
  describe.skipIf(!process.env.DATABASE_URL)('project deletion business ledgers', () => {
    test('direct ledger writers honor both versions of ownership, foreign parent sheets, and opaque scope keys', async () => {
      const { prefix, scope, sheet } = fixture()
      scope.projectNo = 'same-number,"备料"'
      const pool = poolManager.get()
      const direct: Tx = { query: async (sql, params) => (await pool.query(sql, params)).rows }
      const parent = await batch(direct, scope, sheet)
      try {
        const installed = await direct.query(`SELECT c.relname AS name FROM pg_trigger t
          JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND t.tgname='stock_prep_project_delete_business_write' AND t.tgenabled='O'
          ORDER BY c.relname COLLATE "C"`)
        expect(installed.map(row => row.name)).toEqual([...BUSINESS_LOCK_TABLES].sort())
        await within(async deleting => {
          await deleting.query('SELECT pg_advisory_xact_lock(6991,hashtext($1))', [JSON.stringify([scope.tenantId, scope.projectNo])])
          const keys: string[] = businessDeleteFenceKeys(scope, [sheet])
          const runtimeKeys: string[] = runtimeFenceKeys(scope, [projectDeleteDedicatedSheetId(scope)])
          await deleting.query('SELECT public.stock_prep_project_delete_fence($1::text[],false)', [['sheet:' + sheet, ...keys, ...runtimeKeys]])
          await within(async writer => {
            const blocked = async (sql: string, args: unknown[]) => {
              await writer.query('SAVEPOINT before_writer')
              await expect(writer.query(sql, args)).rejects.toMatchObject({ code: '55P03' })
              await writer.query('ROLLBACK TO SAVEPOINT before_writer')
            }
            const handoff = 'INSERT INTO integration_stock_prep_handoff(id,tenant_id,project_no) VALUES ($1,$2,$3)'
            // Exact project scope is independent of any sheet id, including for a no-sheet handoff.
            await blocked(handoff, [prefix + '-handoff', scope.tenantId, scope.projectNo])
            await writer.query(handoff, [prefix + '-other-handoff', scope.tenantId, 'elsewhere'])
            await writer.query(handoff, [prefix + '-other-tenant', prefix + '-tenant', scope.projectNo])
            const neighbor = await batch(writer, { ...scope, projectNo: 'elsewhere' }, prefix + '-other-sheet')
            await blocked('UPDATE integration_stock_prep_pull_batch SET project_no=$2, sheet_id=$3 WHERE id=$1',
              [parent, 'moved', prefix + '-other-sheet'])
            await blocked('UPDATE integration_stock_prep_pull_batch SET sheet_id=$2 WHERE id=$1', [neighbor, sheet])
            // Both explicit ownership columns are foreign. Only the batch_id projects the deleted sheet.
            await blocked(`INSERT INTO integration_stock_prep_pull_batch_execution
              (id,batch_id,tenant_id,sheet_id,project_no,execution_ref,lane)
              VALUES ($1,$2,$3,$4,$5,$1,'small_apply')`,
            [prefix + '-child', parent, prefix + '-tenant', prefix + '-other-sheet', 'elsewhere'])
            const policyKey = runtimeKeys.find(key => key.startsWith('policy:'))!.slice('policy:'.length)
            const policyStamp = runtimeKeys.find(key => key.startsWith('policy-fp:'))!.slice('policy-fp:'.length)
            const neighborKey = policies.STORAGE_PREFIX + randomUUID()
            const put = "INSERT INTO plugin_kv(plugin,key,value) VALUES('plugin-integration-core',$1,$2::jsonb)"
            await blocked(put, [policyKey, JSON.stringify({ policies: [] })])
            await blocked(put, [neighborKey, JSON.stringify({ targetScopeFingerprint: policyStamp, policies: [] })])
            await writer.query(put, [neighborKey, JSON.stringify({ policies: [] })])
            const identifier = (tag: string) => keys.find(key => key.startsWith(tag + ':'))!.slice(tag.length + 1)
            await blocked('INSERT INTO integration_stock_prep_project_write_lock(scope_key,generation_token) VALUES ($1,$2)',
              [identifier('write'), 'generation'])
            await blocked(`INSERT INTO integration_stock_prep_confirmation_reconcile_lease(scope_key,lease_id,acquired_at,expires_at)
              VALUES ($1,'lease',now(),now())`, [identifier('lease')])
            await blocked(`INSERT INTO integration_stock_prep_pack_installs(id,tenant_id,project_id,object_id,pack_id,pack_version,mode,status)
              VALUES ($1,$2,'other',$3,'pack','1','install','installed')`, [prefix + '-pack', prefix + '-tenant', identifier('pack')])
          })
        })
      } finally {
        await direct.query('DELETE FROM integration_stock_prep_pull_batch WHERE id=$1', [parent])
      }
    })

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
