import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { describe, expect, test } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { authorizeStockPreparationProjectDeleteWithin } from '../../src/services/stock-preparation-project-delete-authority'
import type { ProjectDeleteTestStack } from './stock-preparation-project-delete-realdb.cases'

const { createStockPreparationProjectDelete } = createRequire(import.meta.url)(
  '../../../../plugins/plugin-integration-core/lib/stock-preparation-project-delete.cjs',
)
type Scope = { tenantId: string; projectNo: string; actor: string }
const busy = { status: 409, code: 'STOCK_PREPARATION_PROJECT_DELETE_BUSY' }
const query = (sql: string, args: unknown[] = []) => poolManager.get().query(sql, args)
const insertRecord = 'INSERT INTO meta_records (id, sheet_id, data) VALUES ($1, $2, $3::jsonb)'
function deferred() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

// Stop a real pinned service transaction immediately after its chosen statement. Race the
// callback against the service result so a failed prerequisite cannot leave the fixture hanging.
async function whilePaused<T>(fixture: ProjectDeleteTestStack, startsWith: string,
  run: (service: ProjectDeleteTestStack['service']) => Promise<T>, act: () => Promise<void>): Promise<T> {
  const held = deferred()
  const resume = deferred()
  const db = fixture.context.api.database
  const service = createStockPreparationProjectDelete({ auditStore: fixture.auditStore, authorizeWithin: authorizeStockPreparationProjectDeleteWithin,
    database: { transaction: (callback: (tx: { query(text: string, args?: unknown[]): Promise<unknown[]> }) => Promise<T>) => db.transaction(async tx => callback({
      async query(sql, args) {
        const rows = await tx.query(sql, args)
        if (sql.startsWith(startsWith)) { held.release(); await resume.promise }
        return rows
      },
    })) },
  })
  const pending = run(service)
  try {
    await Promise.race([held.promise, pending.then(() => { throw new Error('expected transaction pause was not reached') })])
    await act()
  } finally { resume.release(); await pending.catch(() => {}) }
  return pending
}

export function defineProjectDeleteConcurrencyRealDbCases(getFixture: () => ProjectDeleteTestStack, newScope: (no: string) => Scope) {
  describe('scoped PostgreSQL project-cleanup fences', () => {
    test('an already-open grid edit in a different tenant admits both preview and confirmation', async () => {
      const f = getFixture(), target = newScope('lock-target'), other = newScope('lock-target')
      await f.dedicated(target)
      const foreign = await f.dedicated(other)
      await poolManager.get().transaction(async tx => {
        await tx.query('UPDATE meta_records SET version = version + 1 WHERE id = $1', [foreign.ids[0]])
        const preview = await f.service.preview(target)
        expect(await f.service.confirm({ ...target, ...preview })).toMatchObject({ counts: preview.counts })
      })
      expect((await query('SELECT id FROM meta_records WHERE id = $1', [foreign.ids[0]])).rowCount).toBe(1)
    })

    test('paused preview leaves another tenant and a sibling project on the same shared sheet writable', async () => {
      const f = getFixture(), target = newScope('snapshot-target'), other = newScope('snapshot-target')
      const sibling = { ...target, projectNo: 'snapshot-sibling' }
      await f.shared(target)
      const neighbor = (await f.shared(sibling))[0], foreign = await f.dedicated(other)
      await whilePaused(f, 'INSERT INTO integration_stock_prep_project_delete_challenges', s => s.preview(target), async () => {
        await poolManager.get().transaction(async tx => {
          await tx.query("SET LOCAL lock_timeout = '300ms'")
          const rows = await tx.query('UPDATE meta_records SET version = version + 1 WHERE id = ANY($1::text[]) RETURNING id', [[neighbor.recordId, foreign.ids[0]]])
          expect(rows.rowCount).toBe(2)
        })
      })
    })

    test('an open target insert refuses confirmation and its committed phantom requires a new preview', async () => {
      const f = getFixture(), scope = newScope('phantom')
      const sheet = await f.dedicated(scope), preview = await f.service.preview(scope)
      const input = { ...scope, ...preview }
      await poolManager.get().transaction(async tx => {
        await tx.query(insertRecord, [randomUUID(), sheet.sheetId, { [sheet.fields.projectNo]: scope.projectNo }])
        await expect(f.service.confirm(input)).rejects.toMatchObject(busy)
      })
      await expect(f.service.confirm(input)).rejects.toMatchObject({ status: 409, code: 'STOCK_PREPARATION_PROJECT_DELETE_STALE' })
      expect((await query('SELECT id FROM meta_records WHERE sheet_id = $1', [sheet.sheetId])).rowCount).toBe(3)
    })

    test('a held confirmation refuses target and foreign-reference phantoms but admits an unrelated grid edit', async () => {
      const f = getFixture(), target = newScope('held-target'), other = newScope('held-target')
      const sheet = await f.dedicated(target), foreign = await f.dedicated(other), preview = await f.service.preview(target)
      await whilePaused(f, 'SELECT id FROM meta_records WHERE id = ANY', s => s.confirm({ ...target, ...preview }), async () => {
        await expect(query(insertRecord, [randomUUID(), sheet.sheetId, {}])).rejects.toMatchObject({ code: '55P03' })
        await expect(query(`UPDATE meta_fields SET property = coalesce(property, '{}'::jsonb) || jsonb_build_object('foreignSheetId', $2::text)
          WHERE id = $1`, [foreign.fields.notes, sheet.sheetId])).rejects.toMatchObject({ code: '55P03' })
        const receipt = 'integration:stock-prep:refresh-read-receipt:' + randomUUID()
        const insertReceipt = "INSERT INTO plugin_kv (plugin, key, value) VALUES ('plugin-integration-core', $1, $2::jsonb)"
        await expect(query(insertReceipt, [receipt, target])).rejects.toMatchObject({ code: '55P03' })
        try {
          expect((await query(insertReceipt, [receipt, other])).rowCount).toBe(1)
        } finally {
          await query("DELETE FROM plugin_kv WHERE plugin = 'plugin-integration-core' AND key = $1", [receipt])
        }
        const updated = await query('UPDATE meta_records SET version = version + 1 WHERE id = $1 RETURNING id', [foreign.ids[0]])
        expect(updated.rows).toEqual([{ id: foreign.ids[0] }])
      })
      expect((await query('SELECT id FROM meta_records WHERE sheet_id = $1', [sheet.sheetId])).rowCount).toBe(0)
    })

    test('a multi-row grid edit takes one shared scope lock and permits a simultaneous edit on the same sheet', async () => {
      const f = getFixture(), scope = newScope('ordinary-edit'), sheet = await f.dedicated(scope)
      await poolManager.get().transaction(async tx => {
        await tx.query(`INSERT INTO meta_records (id, sheet_id, data)
          SELECT $1::text || n::text, $2, '{}'::jsonb FROM generate_series(1, 64) n`, [randomUUID(), sheet.sheetId])
        const locks = await tx.query(`SELECT mode FROM pg_catalog.pg_locks WHERE pid = pg_backend_pid()
          AND locktype = 'advisory' AND classid = 16991::oid`)
        expect(locks.rows).toEqual([{ mode: 'ShareLock' }])
        const update = await query('UPDATE meta_records SET version = version + 1 WHERE id = $1', [sheet.ids[0]])
        expect(update.rowCount).toBe(1)
      })
    })

    test('a column-limited grid writer needs no new SELECT grants on the recycle bin', async () => {
      const f = getFixture(), scope = newScope('role-scope'), sheet = await f.dedicated(scope)
      const role = 'scope_test_' + randomUUID().replaceAll('-', '')
      const client = await poolManager.get().getInternalPool().connect()
      try {
        await client.query('BEGIN')
        await client.query(`CREATE ROLE ${role}`)
        await client.query(`GRANT INSERT (id, sheet_id, data) ON meta_records TO ${role}`)
        await client.query(`SET LOCAL ROLE ${role}`)
        const grants = await client.query("SELECT has_table_privilege(current_user, 'meta_records_trash', 'SELECT') AS allowed")
        expect(grants.rows).toEqual([{ allowed: false }])
        expect((await client.query(insertRecord, [randomUUID(), sheet.sheetId, {}])).rowCount).toBe(1)
      } finally { try { await client.query('ROLLBACK') } finally { client.release() } }
    })
  })
}
