/**
 * 备料分批拉取第一期 step 3 (PR A) — the sheet-level GRID-EXPORT CLOSURE stamp against real PostgreSQL.
 *
 * This is a CASES MODULE, not a test file: `defineGridExportClosureRealDbCases()` registers one `describe` block and is
 * called from an already-wired real-DB host (tests/integration/multitable-conditional-rule-enforce-realdb.test.ts), so
 * the cases run in the existing "Run multitable real-DB integration" step of .github/workflows/plugin-tests.yml without
 * a new lane file (the pushing token has no `workflow` scope). Do NOT also list a standalone file for these cases.
 *
 * WHAT IS PROVEN HERE (real Postgres; the unit lane's fakes cannot answer these):
 *   GX1 the migration's columns and both CHECKs exist: a foreign reason is refused (23514), a reason without a time is
 *       refused (23514); up() re-runs cleanly (idempotent).
 *   GX2 the stamp: the host service in a real transaction stamps once; a second call writes nothing and reports the
 *       ORIGINAL time; an unstamped sibling stays NULL; a client-id sheet is refused before any statement.
 *   GX3 export-xlsx: a reader and an admin of the stamped sheet get 403 MULTITABLE_GRID_EXPORT_CLOSED for xlsx AND csv;
 *       the unstamped sibling still answers 200 with a file.
 *   GX4 /context: `capabilities.gridExportClosure` on the stamped sheet only; canExport false there, true on the sibling.
 *   GX5 copy-sheet: WITH data from the stamped sheet → 403 COPY_SOURCE_GRID_EXPORT_CLOSED and no copy row; structure
 *       only → 201.
 *   GX6 down() REFUSES while a stamp exists (typed code), and the columns are still there afterwards.
 *
 * Fail-not-skip: in the real-DB step (METASHEET_REAL_DB_TEST_STEP=1) a missing DATABASE_URL throws from a top-level
 * test OUTSIDE the DB-gated describe. Self-contained fixtures (own base / users / sheets, unique ids), own cleanup — the
 * stamped sheet is hard-deleted at the end so no stamp is left behind in the shared database.
 */
import { randomUUID } from 'node:crypto'

import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { db } from '../../src/db/db'
import {
  GRID_EXPORT_CLOSURE_DOWN_REFUSED_CODE,
  down as closureDown,
  up as closureUp,
} from '../../src/db/migrations/zzzz20261022150000_add_meta_sheets_grid_export_closure'
import { poolManager } from '../../src/integration/db/connection-pool'
import { getObjectSheetId } from '../../src/multitable/provisioning'
import { GRID_EXPORT_CLOSED_REFUSAL } from '../../src/multitable/sheet-grid-export-closure'
import { invalidateUserPerms } from '../../src/rbac/service'
import { createMultitableCopySheetRoutes } from '../../src/routes/multitable-copy-sheet'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { closeSheetGridExport } from '../../src/services/sheet-grid-export-closure-service'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

export function defineGridExportClosureRealDbCases(): void {
  test('grid-export closure real-DB sentinel: the real-DB step must have DATABASE_URL (fail-not-skip)', () => {
    if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
      throw new Error('METASHEET_REAL_DB_TEST_STEP=1 but DATABASE_URL is unset — the grid-export closure real-DB cases would skip-green')
    }
  })

  const TS = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`
  const ADMIN = `u_gec_admin_${TS}`
  const READER = `u_gec_reader_${TS}`
  const BASE = `base_gec_${TS}`
  const PROJECT = `tenant_gec${TS}:integration-core`
  const CLOSED = getObjectSheetId(PROJECT, 'plm_stock_preparation_sandbox_p_0123456789abcdef01234567')
  const OPEN = getObjectSheetId(PROJECT, 'plm_stock_preparation_sandbox_p_fedcba9876543210fedcba98')
  const FIELD = (sheetId: string) => `fld_gec_title_${sheetId.slice(-8)}_${TS}`

  const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
  let app: Express
  let currentUserId = ADMIN
  let currentRoles: string[] = ['admin']
  const as = (userId: string, roles: string[] = []) => { currentUserId = userId; currentRoles = roles }

  const stamp = (sheetId: string, actorId: string) =>
    poolManager.get().transaction(async ({ query }) => closeSheetGridExport(
      async (sql, params) => {
        const result = await query(sql, params)
        return { rows: (result as { rows?: unknown[] }).rows ?? [], rowCount: (result as { rowCount?: number | null }).rowCount ?? null }
      },
      { sheetId, actorId },
    ))

  const binaryParser = (res: { on: (e: string, cb: (...a: unknown[]) => void) => void }, cb: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = []
    res.on('data', (c: unknown) => chunks.push(Buffer.from(c as Buffer)))
    res.on('end', () => cb(null, Buffer.concat(chunks)))
  }

  describeIfDatabase('grid-export closure stamp (real DB)', () => {
    beforeAll(async () => {
      // The feature's own migration, applied again — proves the DDL is idempotent on a real server.
      await closureUp(db as never)

      app = express()
      app.use(express.json())
      app.use((req, _res, next) => {
        ;(req as { user?: unknown }).user = { id: currentUserId, roles: currentRoles, perms: [] }
        next()
      })
      app.use('/api/multitable', univerMetaRouter())
      app.use('/api/multitable', createMultitableCopySheetRoutes())

      await q(`INSERT INTO permissions (code, name, description) VALUES ('multitable:read', 'multitable:read', 'GEC test') ON CONFLICT (code) DO NOTHING`)
      for (const id of [ADMIN, READER]) {
        await q(
          `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
           VALUES ($1, $2, $1, 'x', 'user', '[]'::jsonb, TRUE, FALSE)
           ON CONFLICT (id) DO UPDATE SET is_active = TRUE, is_admin = FALSE, role = 'user'`,
          [id, `${id}@example.test`],
        )
      }
      await q('INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING', [READER, 'multitable:read'])
      invalidateUserPerms(READER)

      await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1, $2, $3)', [BASE, 'GEC Base', ADMIN])
      for (const [sheetId, name] of [[CLOSED, '试点项目表'], [OPEN, '普通项目表']] as const) {
        await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [sheetId, BASE, name])
        await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1, $2, $3, $4, $5::jsonb, $6)', [FIELD(sheetId), sheetId, 'Title', 'string', '{}', 0])
        await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1, $2, $3::jsonb, 1)', [`rec_gec_${sheetId.slice(-8)}_${TS}`, sheetId, JSON.stringify({ [FIELD(sheetId)]: 'synthetic-row' })])
      }
    })

    afterAll(async () => {
      const ids = ((await q('SELECT id FROM meta_sheets WHERE base_id = $1', [BASE])).rows as Array<{ id: string }>).map((r) => r.id)
      for (const [table, col] of [['meta_record_revisions', 'sheet_id'], ['meta_config_revisions', 'sheet_id'], ['operation_audit_logs', 'resource_id'], ['spreadsheet_permissions', 'sheet_id'], ['field_permissions', 'sheet_id']] as const) {
        await q(`DELETE FROM ${table} WHERE ${col} = ANY($1::text[])`, [ids]).catch(() => {})
      }
      await q('DELETE FROM meta_multitable_template_installs WHERE actor_id = ANY($1::text[])', [[ADMIN, READER]]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE base_id = $1', [BASE]).catch(() => {}) // cascades fields / records / views
      await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
      await q('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[ADMIN, READER]]).catch(() => {})
      await q('DELETE FROM users WHERE id = ANY($1::text[])', [[ADMIN, READER]]).catch(() => {})
    })

    test('GX1 columns and both CHECKs exist; a foreign reason and a reason without a time are refused', async () => {
      const columns = ((await q(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'meta_sheets' AND column_name LIKE 'grid_export_%' ORDER BY column_name`,
      )).rows as Array<{ column_name: string }>).map((r) => r.column_name)
      expect(columns).toEqual(['grid_export_closed_at', 'grid_export_closed_by', 'grid_export_closure'])
      await expect(q(`UPDATE meta_sheets SET grid_export_closure = 'other', grid_export_closed_at = now() WHERE id = $1`, [OPEN])).rejects.toMatchObject({ code: '23514' })
      await expect(q(`UPDATE meta_sheets SET grid_export_closure = 'stock_prep_pilot' WHERE id = $1`, [OPEN])).rejects.toMatchObject({ code: '23514' })
      expect(((await q('SELECT grid_export_closure FROM meta_sheets WHERE id = $1', [OPEN])).rows[0] as { grid_export_closure: unknown }).grid_export_closure).toBeNull()
    })

    test('GX2 the host service stamps once; a repeat keeps the original time; the sibling stays open; a client id is refused', async () => {
      const first = await stamp(CLOSED, 'u_pilot_admin')
      expect(first).toMatchObject({ sheetId: CLOSED, closure: 'stock_prep_pilot', closedBy: 'u_pilot_admin', alreadyClosed: false })
      const second = await stamp(CLOSED, 'u_someone_else')
      expect(second).toMatchObject({ closure: 'stock_prep_pilot', closedBy: 'u_pilot_admin', alreadyClosed: true, closedAt: first.closedAt })
      const rows = (await q('SELECT id, grid_export_closure, grid_export_closed_by FROM meta_sheets WHERE id = ANY($1::text[]) ORDER BY id', [[CLOSED, OPEN]])).rows as Array<Record<string, unknown>>
      expect(Object.fromEntries(rows.map((r) => [r.id, r.grid_export_closure]))).toEqual({ [CLOSED]: 'stock_prep_pilot', [OPEN]: null })
      await expect(stamp(`sheet_gec_client_${TS}`, 'u_x')).rejects.toMatchObject({ code: 'MULTITABLE_GRID_EXPORT_CLOSURE_SHEET_INVALID' })
    })

    test('GX3 export-xlsx: reader and admin get 403 MULTITABLE_GRID_EXPORT_CLOSED (xlsx and csv) on the stamped sheet; the sibling exports', async () => {
      for (const [userId, roles] of [[READER, []], [ADMIN, ['admin']]] as const) {
        as(userId, [...roles])
        for (const format of ['xlsx', 'csv'] as const) {
          const res = await request(app).get(`/api/multitable/sheets/${CLOSED}/export-xlsx`).query(format === 'csv' ? { format } : {})
          expect(res.status, `${userId} ${format}`).toBe(403)
          expect(res.body, `${userId} ${format}`).toEqual(JSON.parse(JSON.stringify(GRID_EXPORT_CLOSED_REFUSAL)))
        }
        const open = await request(app).get(`/api/multitable/sheets/${OPEN}/export-xlsx`).buffer(true).parse(binaryParser as never)
        expect(open.status, userId).toBe(200)
        expect(String(open.headers['content-disposition'] ?? '')).toContain('attachment')
      }
    })

    test('GX4 /context: the marker and canExport false on the stamped sheet only', async () => {
      as(READER)
      const closed = await request(app).get('/api/multitable/context').query({ sheetId: CLOSED })
      expect(closed.status).toBe(200)
      expect(closed.body.data.capabilities.gridExportClosure).toEqual({ reason: 'stock_prep_pilot' })
      expect(closed.body.data.capabilities.canExport).toBe(false)
      const open = await request(app).get('/api/multitable/context').query({ sheetId: OPEN })
      expect(open.status).toBe(200)
      expect(open.body.data.capabilities).not.toHaveProperty('gridExportClosure')
      expect(open.body.data.capabilities.canExport).toBe(true)
    })

    test('GX5 copy-sheet: WITH data from the stamped sheet is refused and writes nothing; structure only is copied', async () => {
      as(ADMIN, ['admin'])
      const refused = await request(app).post(`/api/multitable/sheets/${CLOSED}/copy`).send({ withData: true, permissionMode: 'inherit' })
      expect(refused.status).toBe(403)
      expect(refused.body.error.code).toBe('COPY_SOURCE_GRID_EXPORT_CLOSED')
      const dryRun = await request(app).post(`/api/multitable/sheets/${CLOSED}/copy/dry-run`).send({ withData: true, permissionMode: 'inherit' })
      expect(dryRun.status).toBe(403)
      expect(dryRun.body.error.code).toBe('COPY_SOURCE_GRID_EXPORT_CLOSED')
      expect((await q('SELECT 1 FROM meta_sheets WHERE copied_from_sheet_id = $1', [CLOSED])).rows).toHaveLength(0)
      const structure = await request(app).post(`/api/multitable/sheets/${CLOSED}/copy`).send({ withData: false, permissionMode: 'inherit' })
      expect(structure.status).toBe(201)
      const copies = (await q('SELECT id FROM meta_sheets WHERE copied_from_sheet_id = $1', [CLOSED])).rows as Array<{ id: string }>
      expect(copies).toHaveLength(1)
      expect((await q('SELECT count(*)::int AS n FROM meta_records WHERE sheet_id = $1', [copies[0].id])).rows[0]).toEqual({ n: 0 })
    })

    test('GX6 down() refuses while a stamp exists, and the columns stay', async () => {
      const error = await closureDown(db as never).then(() => null, (caught: unknown) => caught as Error & { code?: string })
      expect(error?.code).toBe(GRID_EXPORT_CLOSURE_DOWN_REFUSED_CODE)
      const columns = (await q(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'meta_sheets' AND column_name LIKE 'grid_export_%'`)).rows[0]
      expect(columns).toEqual({ n: 3 })
      expect(((await q('SELECT grid_export_closure FROM meta_sheets WHERE id = $1', [CLOSED])).rows[0] as { grid_export_closure: unknown }).grid_export_closure).toBe('stock_prep_pilot')
    })
  })
}
