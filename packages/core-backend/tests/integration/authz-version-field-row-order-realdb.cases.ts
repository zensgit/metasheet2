/**
 * D21 × #6792 — the FIELD-ROW WRITER RULE against real PostgreSQL (slice Y5a follow-up).
 *
 * #6792 locks the meta_fields row on PATCH /fields (late re-read), the plugin property port (locked read) and the
 * config revert (snapshot lock). Y5a's visibility trigger takes the sheet version row inside the UPDATE, i.e. after
 * the row is locked. The rule (authz-version-protocol.ts): a field writer whose write can trip that trigger takes the
 * sheet version row explicitly, after its advisory fence and before its first field-row lock. Each path is driven
 * through its PRODUCTION entry (the route on a pinned server, or the provisioning function inside a pool
 * transaction); interleavings are forced with `holdAfter` (the #6792 harness: pause right after one production
 * statement) and observed through `pg_blocking_pids`, never timed.
 *
 *   FO-T1  parity: `fieldVisibilityTriggerWouldFire` answers what the installed trigger does, pair by pair;
 *   FO-C1  config revert (generic branch): when the snapshot's field-row lock is taken, the version row is ALREADY
 *          held by the writer (a NOWAIT probe on it fails 55P03);
 *   FO-C2  … against an admission holder: the revert parks on the bump statement holding NO field-row lock; the holder
 *          reads the field still visible and commits (serialized: the revert has not committed); the revert then
 *          lands and the next holder reads it hidden — never a false ALLOW;
 *   FO-L1  config revert (lossy-retype branch): the version row is held when the FOR UPDATE field read runs;
 *   FO-L2  … the holder cycle the trigger-only order had (field row → every cell FOR UPDATE → version row, against a
 *          holder's version row FOR SHARE → bound record FOR SHARE): the holder now waits at the version row, no
 *          40P01 on either side, and reads the revert's result;
 *   FO-P1  plugin property port: the version row is held at the locked read; FO-P2 … against a holder (as FO-C2);
 *   FO-P3  ensureFields in 'overwrite' mode: the version row is held at the first field upsert;
 *   FO-F1  PATCH /fields hiding a field: the version row is held at the sibling order shift AND at the late re-read;
 *   FO-F2  … against a holder (as FO-C2);
 *   FO-F3  a PATCH that cannot trip the trigger (the shared column drag, a rename) never touches the version row: it
 *          finishes while a holder holds that row FOR SHARE;
 *   FO-W1  two canonical writers on one field (PATCH held after its bump, then a config revert of the same field): the
 *          revert parks on the VERSION ROW, not on the field row; both end typed (200 / 409), no 40P01;
 *   FO-F4  PATCH /fields hiding a field WITHOUT a reorder: the version row is held at the late re-read, the first
 *          field-row lock of such a PATCH (FO-F1 always reorders: verifier r1 F7);
 *   FO-X1  writer vs writer (verifier r1 F1): an ensureFields overwrite that ADDS a field vs PUT field-permissions held
 *          after its `meta_sheets … FOR UPDATE` — the overwrite parks on the sheet row's KEY SHARE BEFORE its bump (the
 *          version row stays free), the grant commits, the overwrite follows; no 40P01 (writer fence off and on);
 *   FO-X2  … the same for a PATCH that hides a field and converts it to autoNumber (its sequence row is an FK child);
 *   FO-R1  the field retype convert of a legacy jsonb-STRING `{hidden:true}` column (verifier r1 F2) vs a holder that
 *          binds a live record: the convert holds the version row before its row locks, so the holder waits at the
 *          version row instead of closing a 40P01 cycle on the bound record; FO-R2 … the same for the undo.
 *
 * Witnessed reds (PR body): moving each path's bump after its field-row lock reds its order witness (the probe finds the
 * version row free) and its holder barrier (the parked writer holds the field row); removing the lossy bump (the
 * trigger-only order) reds FO-L2 with a 40P01 on the holder; making the PATCH bump unconditional reds FO-F3; a plain
 * bump (no sheet-row KEY SHARE) in ensureFields / PATCH reds FO-X1 / FO-X2; removing the convert's / undo's bump reds
 * FO-R1 / FO-R2.
 *
 * A CASES MODULE, registered from the already-wired real-DB file tests/integration/authz-version-protocol.db.test.ts
 * (excluded from the no-DB runner, run whole-file in the approval real-DB step) — do NOT list a standalone file. The
 * writer fence is pinned OFF (its advisory lock is outside the holder's set and serializes the writers by itself),
 * except where a case turns it on for its own run: FO-X1's second variant (the grant route takes no fence, so the fence
 * cannot break that cycle) and FO-R1 / FO-R2 (the retype convert refuses to run without it).
 * Values-free: every id is synthetic and per-run.
 */
import express from 'express'
import type { PoolClient } from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import {
  SHEET_PERMISSION_VERSIONS_BUMP_SQL,
  SHEET_PERMISSION_VERSIONS_TABLE,
  SHEET_ROW_KEY_SHARE_SQL,
  SUBJECT_AUTHORIZATION_VERSIONS_TABLE,
  bumpSheetPermissionVersions,
  fieldVisibilityTriggerWouldFire,
  lockAuthorizationVersionsForAdmission,
} from '../../src/multitable/authz-version-protocol'
import { isWriterFenceEnabled } from '../../src/multitable/canonical-sheet-fence'
import { FIELD_CONFIG_SNAPSHOT_LOCKED_SQL } from '../../src/multitable/config-restore'
import { normalizeJson } from '../../src/multitable/field-codecs'
import { FIELD_RETYPE_CONVERT_CONFIRM } from '../../src/multitable/field-retype-convert'
import { FIELD_RETYPE_UNDO_CONFIRM, __resetFieldRetypeConversionsTableProbe } from '../../src/multitable/field-retype-convert-execute'
import { FIELD_RETYPE_CONVERT_CELL_COLUMNS } from '../../src/multitable/field-retype-convert-preview'
import { PATCH_FIELD_LOCKED_REREAD_SQL } from '../../src/multitable/field-row-write-guard'
import { isFieldPermissionHidden } from '../../src/multitable/permission-derivation'
import {
  PATCH_OBJECT_FIELD_PROPERTY_READ_SQL,
  ensureFields,
  getObjectFieldId,
  getObjectSheetId,
  patchObjectFieldProperty,
} from '../../src/multitable/provisioning'
import { SHEET_ROW_LOCK_LIVENESS_SQL } from '../../src/multitable/sheet-liveness'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { holdAfter, raceParkedOrSettled, rawClient, tracked, useWriterFencePinnedOff, withWriterFenceOn } from '../utils/field-row-race-harness'
import { usePinnedServer } from '../utils/pinned-server'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const RETYPE_REVERT_FLAG = 'MULTITABLE_ENABLE_FIELD_RETYPE_REVERT'
const LOSSY_REVERT_FLAG = 'MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY'
// Production texts of the lossy-retype branch (routes/univer-meta.ts loadLossyRetypeFieldRow / loadLossyRetypeCells with
// forUpdate = true). A drift there leaves the hold unreached, which reds the case ("hold point never reached").
const LOSSY_FIELD_ROW_LOCKED_SQL = 'SELECT id, sheet_id, type FROM meta_fields WHERE id = $1 FOR UPDATE'
const LOSSY_CELLS_LOCKED_SQL = 'SELECT id, data FROM meta_records WHERE sheet_id = $1 AND data ? $2 ORDER BY id FOR UPDATE'
// PATCH /fields' sibling shift when the field moves right (routes/univer-meta.ts), the first field-row lock of a reorder.
const PATCH_SHIFT_LEFT_SQL = 'UPDATE meta_fields SET "order" = "order" - 1 WHERE sheet_id = $1 AND "order" > $2 AND "order" <= $3 AND id <> $4 RETURNING id, "order"'
// The retype convert's and undo's lock of every live row (field-retype-convert-execute.ts lockLiveRows), taken after the
// field row: the hold point of FO-R1 / FO-R2. Built from the exported cell columns, so a drift leaves the hold unreached.
const CONVERT_LIVE_ROWS_LOCKED_SQL = `SELECT id, version, data, ${FIELD_RETYPE_CONVERT_CELL_COLUMNS} FROM meta_records WHERE sheet_id = $1 FOR UPDATE`
const CONVERT_FLAG = 'MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT'

type Response = { status: number; body: { ok?: boolean; error?: { code?: string }; data?: Record<string, unknown> } }

export function defineAuthzVersionFieldRowOrderRealDbCases(): void {
  test('field-row writer rule real-DB sentinel: the real-DB step must have DATABASE_URL (fail-not-skip)', () => {
    if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
      throw new Error('METASHEET_REAL_DB_TEST_STEP=1 but DATABASE_URL is unset — the field-row writer rule real-DB cases would skip-green')
    }
  })

  describeIfDatabase.sequential('D21 field-row writer rule: the sheet version row before the field-row lock (real PostgreSQL)', () => {
    const TOKEN = `${process.pid}_${Date.now().toString(36)}`
    const BASE = `base_fro_${TOKEN}`
    const SHEET = `sheet_fro_${TOKEN}`
    const LOSSY_SHEET = `sheet_fro_lossy_${TOKEN}`
    const PROJECT = `tenant_fro_${TOKEN}:project`
    const OBJECT = 'fro_object'
    const OBJECT_SHEET = getObjectSheetId(PROJECT, OBJECT)
    const HOLDER_ACTOR = `u_fro_holder_${TOKEN}`
    const TENANT = `t_fro_${TOKEN}`
    const ADMIN = { id: `u_fro_admin_${TOKEN}`, roles: ['admin'], perms: [] as string[] }
    // A real database user: the subject of the field-permission grant (FO-X*) and the actor of the retype convert /
    // undo (FO-R*), which re-read their caller's authority from the database inside the transaction.
    const DB_ACTOR = `u_fro_actor_${TOKEN}`
    const DB_ACTOR_PERMS = ['multitable:read', 'multitable:write', 'multitable:manage-schema']
    const fld = (tag: string) => `fld_fro_${tag}_${TOKEN}`
    const ALL_SHEETS = [SHEET, LOSSY_SHEET, OBJECT_SHEET]
    /** Sheets a case creates for itself (the retype convert needs a fresh column per case). */
    const EXTRA_SHEETS: string[] = []
    useWriterFencePinnedOff()
    const pinned = usePinnedServer()
    const http = () => request(pinned.url())
    const flags: Record<string, string | undefined> = {}
    let currentUser: Record<string, unknown> = ADMIN

    const seedField = (sheetId: string, id: string, type: string, property: unknown, order: number) =>
      q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [id, sheetId, `F ${id.slice(4, 16)}`, type, JSON.stringify(property), order])
    const propertyOf = async (id: string): Promise<unknown> => (await q('SELECT property FROM meta_fields WHERE id = $1', [id])).rows[0]?.property
    const sheetVersion = async (sheetId: string): Promise<number> => {
      const { rows } = await q(`SELECT version::text AS version FROM ${SHEET_PERMISSION_VERSIONS_TABLE} WHERE sheet_id = $1`, [sheetId])
      return rows[0] ? Number(rows[0].version) : 0
    }
    const insertRev = async (sheetId: string, entityId: string, before: unknown, after: unknown, changedKeys: string[]) =>
      String(((await q(
        `INSERT INTO meta_config_revisions (sheet_id, entity_type, entity_id, action, before, after, changed_keys, actor_id)
         VALUES ($1,'field',$2,'update',$3::jsonb,$4::jsonb,$5::text[],$6) RETURNING id`,
        [sheetId, entityId, JSON.stringify(before), JSON.stringify(after), changedKeys, ADMIN.id],
      )).rows[0] as { id: string }).id)
    const preview = (sheetId: string, revisionId: string) =>
      http().post(`/api/multitable/sheets/${sheetId}/config-restore-preview`).send({ revisionId })
    const execute = (sheetId: string, revisionId: string, previewToken: string, confirm?: string) =>
      http().post(`/api/multitable/sheets/${sheetId}/config-restore-execute`).send({ revisionId, previewToken, ...(confirm ? { confirm } : {}) })
    const patchField = (id: string, body: Record<string, unknown>) => http().patch(`/api/multitable/fields/${id}`).send(body)
    /** The plugin port's own shape (index.ts patchObjectFieldProperty): one pool transaction around the function. */
    const portPatch = (fieldId: string, propertyPatch: Record<string, unknown>) =>
      poolManager.get().transaction(async ({ query }) => patchObjectFieldProperty({
        query: async (sql, params) => {
          const res = await query(sql, params) as { rows?: unknown[]; rowCount?: number | null }
          return { rows: Array.isArray(res.rows) ? res.rows : [], rowCount: typeof res.rowCount === 'number' ? res.rowCount : undefined }
        },
        projectId: PROJECT,
        objectId: OBJECT,
        fieldId,
        propertyPatch,
      }))

    /**
     * NOWAIT probe on a row from a fresh connection: 'held' (55P03 — another transaction holds it), 'free' (locked it
     * — exactly one row, so an absent row can never read as free), 'absent'. Always rolled back.
     */
    async function probe(sql: string, params: unknown[]): Promise<'held' | 'free' | 'absent'> {
      const client = await rawClient()
      try {
        await client.query('BEGIN')
        const res = await client.query(sql, params)
        return res.rows.length === 1 ? 'free' : 'absent'
      } catch (error) {
        if ((error as { code?: unknown }).code === '55P03') return 'held'
        throw error
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    }
    const versionRowProbe = (sheetId: string) => probe(`SELECT 1 FROM ${SHEET_PERMISSION_VERSIONS_TABLE} WHERE sheet_id = $1 FOR UPDATE NOWAIT`, [sheetId])
    const fieldRowProbe = (fieldId: string) => probe('SELECT 1 FROM meta_fields WHERE id = $1 FOR NO KEY UPDATE NOWAIT', [fieldId])

    /** An admission holder on its own connection: READ COMMITTED transaction + the D21 helper's locks. */
    async function openHolder(sheetId: string, recordId?: string) {
      const client: PoolClient = await rawClient()
      await client.query("SET statement_timeout = '30s'")
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      return {
        client,
        pid,
        lock: () => lockAuthorizationVersionsForAdmission(client, { sheetIds: [sheetId], actorId: HOLDER_ACTOR, tenantId: TENANT, recordId: recordId ?? null }),
        /**
         * The field-level decision input, read in the holder's transaction AFTER its locks, the way the readers derive
         * it (serializeFieldRow: normalizeJson, so a legacy jsonb-STRING property is parsed, not read as no flags).
         */
        async seesHidden(fieldId: string): Promise<boolean> {
          const { rows } = await client.query('SELECT property FROM meta_fields WHERE id = $1', [fieldId])
          return isFieldPermissionHidden({ property: normalizeJson(rows[0]?.property) })
        },
        async end(how: 'COMMIT' | 'ROLLBACK') {
          try { await client.query(how) } finally { client.release() }
        },
      }
    }

    /**
     * Holder first, then the writer: the writer parks on the BUMP statement behind the holder and holds no field-row lock
     * while it waits; the holder still reads the field visible (the writer has not committed) and commits; the writer
     * then lands, and a fresh holder reads the version moved on and the field hidden. Shared by FO-C2 / FO-P2 / FO-F2.
     */
    async function holderBarrier(opts: { sheetId: string; fieldId: string; write: () => PromiseLike<unknown>; expectWrite: (result: unknown) => void }) {
      const holder = await openHolder(opts.sheetId)
      let ended = false
      try {
        const locked = await holder.lock()
        const writing = tracked(opts.write)
        const outcome = await raceParkedOrSettled({ blockerPid: holder.pid, queryText: SHEET_PERMISSION_VERSIONS_BUMP_SQL, settled: writing.settled })
        expect(outcome, 'the writer parks on the sheet version row (the bump statement) behind the holder').toBe('parked')
        expect(await fieldRowProbe(opts.fieldId), 'while it waits on the version row the writer holds NO field-row lock').toBe('free')
        expect(await holder.seesHidden(opts.fieldId), 'the holder decides on the field as committed: still visible').toBe(false)
        await holder.end('COMMIT')
        ended = true
        opts.expectWrite(await writing.promise)
        expect(await propertyOf(opts.fieldId).then((p) => isFieldPermissionHidden({ property: (p ?? {}) as Record<string, unknown> }))).toBe(true)
        const next = await openHolder(opts.sheetId)
        try {
          const relocked = await next.lock()
          expect(relocked.sheetVersions[0]!.version, 'the version the next holder locks moved on').toBeGreaterThan(locked.sheetVersions[0]!.version)
          expect(await next.seesHidden(opts.fieldId), 'the next holder reads the field hidden: never a false ALLOW').toBe(true)
        } finally {
          await next.end('COMMIT')
        }
      } finally {
        if (!ended) await holder.end('ROLLBACK').catch(() => undefined)
      }
    }

    const expectOk = (result: unknown) => {
      const res = result as Response
      expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200)
    }

    beforeAll(async () => {
      for (const flag of [RETYPE_REVERT_FLAG, LOSSY_REVERT_FLAG, CONVERT_FLAG]) flags[flag] = process.env[flag]
      __resetFieldRetypeConversionsTableProbe()
      const app = express()
      app.use(express.json())
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      app.use((req, _res, next) => { ;(req as any).user = currentUser; next() })
      app.use('/api/multitable', univerMetaRouter())
      pinned.setApp(app)
      await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'FRO Base'])
      for (const sheetId of ALL_SHEETS) {
        await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [sheetId, BASE, 'FRO Sheet'])
        // A committed version row, so a NOWAIT probe can never read an uncommitted insert as "free".
        await bumpSheetPermissionVersions((sql, params) => q(sql, params), [sheetId])
      }
      for (const code of DB_ACTOR_PERMS) {
        await q(`INSERT INTO permissions (code, name, description) VALUES ($1, $1, 'FRO test') ON CONFLICT (code) DO NOTHING`, [code])
      }
      await q(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
         VALUES ($1, $2, $1, 'x', 'user', '[]'::jsonb, TRUE, FALSE)`,
        [DB_ACTOR, `${DB_ACTOR}@example.test`],
      )
      for (const code of DB_ACTOR_PERMS) await q('INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, $2)', [DB_ACTOR, code])
    })

    afterAll(async () => {
      for (const [flag, value] of Object.entries(flags)) {
        if (value === undefined) delete process.env[flag]
        else process.env[flag] = value
      }
      for (const sheetId of [...ALL_SHEETS, ...EXTRA_SHEETS]) {
        await q('DELETE FROM field_permissions WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_field_retype_conversions WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_field_value_tombstones WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_sheets WHERE id = $1', [sheetId]).catch(() => {})
        await q(`DELETE FROM ${SHEET_PERMISSION_VERSIONS_TABLE} WHERE sheet_id = $1`, [sheetId]).catch(() => {})
      }
      await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
      await q('DELETE FROM user_permissions WHERE user_id = $1', [DB_ACTOR]).catch(() => {})
      await q('DELETE FROM users WHERE id = $1', [DB_ACTOR]).catch(() => {})
      await q(`DELETE FROM ${SUBJECT_AUTHORIZATION_VERSIONS_TABLE} WHERE subject_id = ANY($1::text[])`, [[DB_ACTOR, HOLDER_ACTOR]]).catch(() => {})
    })

    test('FO-T1 parity: fieldVisibilityTriggerWouldFire answers exactly what the installed trigger does', async () => {
      const id = fld('t1')
      await seedField(SHEET, id, 'string', {}, 90)
      // Raw jsonb texts, so non-object values (array, string, null) are stored exactly.
      const pairs: Array<[string, string]> = [
        ['{}', '{"options":["a"]}'],
        ['{}', '{"hidden":false}'],
        ['{"hidden":false}', '{"hidden":true}'],
        ['{"hidden":true}', '{"hidden":true,"visible":false}'],
        ['{"hidden":true,"visible":false}', '{"visible":false}'],
        ['{"visible":false}', '{"visible":true}'],
        ['{"hidden":"true"}', '{}'],
        ['{"hidden":1,"visible":0}', '{}'],
        ['[]', '{"hidden":true}'],
        ['"{\\"hidden\\":true}"', '{}'],
        ['null', '{"visible":false}'],
        ['{"hidden":true}', '[]'],
      ]
      const mismatches: string[] = []
      for (const [before, after] of pairs) {
        await q('UPDATE meta_fields SET property = $2::jsonb WHERE id = $1', [id, before])
        const start = await sheetVersion(SHEET)
        await q('UPDATE meta_fields SET property = $2::jsonb WHERE id = $1', [id, after])
        const fired = (await sheetVersion(SHEET)) > start
        const predicted = fieldVisibilityTriggerWouldFire(JSON.parse(before), JSON.parse(after))
        if (fired !== predicted) mismatches.push(`${before} -> ${after}: trigger ${fired}, helper ${predicted}`)
      }
      expect(mismatches).toEqual([])
    })

    describe('config revert (POST /sheets/:sheetId/config-restore-execute)', () => {
      // Tier-2 scalar retype revert (type + property): the live field is a visible string; the revert restores a
      // HIDDEN number. The lossy flag is off, so this is the generic branch.
      const seedGenericRevert = async (id: string, order: number) => {
        process.env[RETYPE_REVERT_FLAG] = 'true'
        delete process.env[LOSSY_REVERT_FLAG]
        await seedField(SHEET, id, 'string', {}, order)
        const rev = await insertRev(SHEET, id, { type: 'number', property: { hidden: true } }, { type: 'string', property: {} }, ['type', 'property'])
        const pv = await preview(SHEET, rev)
        expect(pv.status, JSON.stringify(pv.body).slice(0, 300)).toBe(200)
        expect(pv.body?.data?.preview?.driftConflict).toBe(false)
        return { rev, token: String(pv.body.data.previewToken) }
      }

      test('FO-C1 generic branch: the writer already holds the sheet version row when its snapshot locks the field row', async () => {
        expect(isWriterFenceEnabled()).toBe(false)
        const id = fld('c1')
        const { rev, token } = await seedGenericRevert(id, 10)
        const hold = holdAfter(FIELD_CONFIG_SNAPSHOT_LOCKED_SQL)
        let executing: ReturnType<typeof tracked> | null = null
        try {
          executing = tracked(() => execute(SHEET, rev, token))
          await hold.reached()
          expect(await fieldRowProbe(id), 'the snapshot holds the field row').toBe('held')
          expect(await versionRowProbe(SHEET), 'FO-C1: the version row was taken BEFORE the field-row lock').toBe('held')
          hold.release()
          expectOk(await executing.promise)
          expect(await propertyOf(id)).toEqual({ hidden: true })
        } finally {
          hold.restore()
          if (executing) await executing.promise.catch(() => {})
        }
      })

      test('FO-C2 generic branch vs an admission holder: serialized on the version row, no field-row lock while parked, never a false ALLOW', async () => {
        expect(isWriterFenceEnabled()).toBe(false)
        const id = fld('c2')
        const { rev, token } = await seedGenericRevert(id, 11)
        await holderBarrier({ sheetId: SHEET, fieldId: id, write: () => execute(SHEET, rev, token), expectWrite: expectOk })
      })

      // Property-only revert of a Batch-1 field (currency): the lossy branch. The revert restores a HIDDEN property and
      // rewrites the coerced / dropped cells, which it locks FOR UPDATE first.
      const seedLossyRevert = async (tag: string) => {
        process.env[RETYPE_REVERT_FLAG] = 'true'
        process.env[LOSSY_REVERT_FLAG] = 'true'
        const id = fld(tag)
        for (const table of ['meta_field_value_tombstones', 'meta_record_revisions', 'meta_records', 'meta_fields']) {
          await q(`DELETE FROM ${table} WHERE sheet_id = $1`, [LOSSY_SHEET])
        }
        await seedField(LOSSY_SHEET, id, 'currency', { precision: 0 }, 1)
        const recordIds = [`rec_fro_${tag}_1_${TOKEN}`, `rec_fro_${tag}_2_${TOKEN}`]
        await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [recordIds[0], LOSSY_SHEET, JSON.stringify({ [id]: 9 })])
        await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [recordIds[1], LOSSY_SHEET, JSON.stringify({ [id]: '12.5' })])
        const rev = await insertRev(LOSSY_SHEET, id, { property: { precision: 2, hidden: true } }, { property: { precision: 0 } }, ['property'])
        const pv = await preview(LOSSY_SHEET, rev)
        expect(pv.status, JSON.stringify(pv.body).slice(0, 300)).toBe(200)
        expect(pv.body?.data).toHaveProperty('lossSummary')
        return { id, rev, token: String(pv.body.data.previewToken), boundRecord: recordIds[1]! }
      }

      test('FO-L1 lossy-retype branch: the writer already holds the sheet version row when it reads the field FOR UPDATE', async () => {
        expect(isWriterFenceEnabled()).toBe(false)
        const { id, rev, token } = await seedLossyRevert('l1')
        const hold = holdAfter(LOSSY_FIELD_ROW_LOCKED_SQL)
        let executing: ReturnType<typeof tracked> | null = null
        try {
          executing = tracked(() => execute(LOSSY_SHEET, rev, token, 'revert-retype-lossy'))
          await hold.reached()
          expect(await fieldRowProbe(id), 'the lossy branch holds the field row').toBe('held')
          expect(await versionRowProbe(LOSSY_SHEET), 'FO-L1: the version row was taken BEFORE the field-row lock').toBe('held')
          hold.release()
          expectOk(await executing.promise)
          expect(await propertyOf(id)).toMatchObject({ precision: 2, hidden: true })
        } finally {
          hold.restore()
          if (executing) await executing.promise.catch(() => {})
        }
      })

      test('FO-L2 lossy-retype branch vs a holder that binds a rewritten record: the holder waits at the version row — no 40P01, and it reads the revert', async () => {
        expect(isWriterFenceEnabled()).toBe(false)
        const { id, rev, token, boundRecord } = await seedLossyRevert('l2')
        // Hold the revert AFTER it locked every cell of the field (the bound record included).
        const hold = holdAfter(LOSSY_CELLS_LOCKED_SQL)
        let executing: ReturnType<typeof tracked> | null = null
        const holder = await openHolder(LOSSY_SHEET, boundRecord)
        let ended = false
        try {
          executing = tracked(() => execute(LOSSY_SHEET, rev, token, 'revert-retype-lossy'))
          const writerPid = await hold.reached()
          const locking = tracked(() => holder.lock())
          const parked = await raceParkedOrSettled({ blockerPid: writerPid, settled: locking.settled })
          expect(parked, 'the holder waits on the revert').toBe('parked')
          // Where it waits: with the canonical order the revert holds the version row, so the holder has not reached
          // the bound record yet (its first lock is that row). A record FOR SHARE wait is the cycle's first half: on
          // release the revert's UPDATE then wants the version row the holder shares, and PostgreSQL aborts one side.
          const waiting = String((await q('SELECT query FROM pg_stat_activity WHERE pid = $1', [holder.pid])).rows[0]?.query ?? '')
          hold.release()
          const reverted = (await executing.promise) as Response
          const holderOutcome = await locking.promise.then(
            () => 'locked',
            (error: unknown) => `${String((error as { code?: unknown }).code)}/${String((error as { sqlState?: unknown }).sqlState)}`,
          )
          // Observed together, so a red shows the whole interleaving (a deadlock answers CONFLICT/40P01 on the holder).
          expect({
            waitsAt: waiting.includes(SHEET_PERMISSION_VERSIONS_TABLE) ? 'the sheet version row' : 'the bound record',
            revert: reverted.status,
            holder: holderOutcome,
          }, 'FO-L2: the holder waits at the version row, the revert commits, the holder then locks — no 40P01').toEqual({
            waitsAt: 'the sheet version row', revert: 200, holder: 'locked',
          })
          const locked = await holder.lock()
          expect(locked.record?.recordId).toBe(boundRecord)
          expect(await holder.seesHidden(id), 'the holder reads the committed revert: the field is hidden').toBe(true)
          await holder.end('COMMIT')
          ended = true
        } finally {
          hold.restore()
          if (executing) await executing.promise.catch(() => {})
          if (!ended) await holder.end('ROLLBACK').catch(() => undefined)
        }
      })
    })

    describe('plugin property port and ensureFields (provisioning)', () => {
      test('FO-P1 patchObjectFieldProperty: the writer already holds the sheet version row at its locked read', async () => {
        expect(isWriterFenceEnabled()).toBe(false)
        const id = getObjectFieldId(PROJECT, OBJECT, 'p1')
        await seedField(OBJECT_SHEET, id, 'string', {}, 1)
        const hold = holdAfter(PATCH_OBJECT_FIELD_PROPERTY_READ_SQL)
        let patching: ReturnType<typeof tracked> | null = null
        try {
          patching = tracked(() => portPatch('p1', { hidden: true }))
          await hold.reached()
          expect(await fieldRowProbe(id), 'the port holds the field row').toBe('held')
          expect(await versionRowProbe(OBJECT_SHEET), 'FO-P1: the version row was taken BEFORE the field-row lock').toBe('held')
          hold.release()
          await patching.promise
          expect(await propertyOf(id)).toMatchObject({ hidden: true })
        } finally {
          hold.restore()
          if (patching) await patching.promise.catch(() => {})
        }
      })

      test('FO-P2 patchObjectFieldProperty vs an admission holder: serialized on the version row, never a false ALLOW', async () => {
        expect(isWriterFenceEnabled()).toBe(false)
        const id = getObjectFieldId(PROJECT, OBJECT, 'p2')
        await seedField(OBJECT_SHEET, id, 'string', {}, 2)
        await holderBarrier({
          sheetId: OBJECT_SHEET,
          fieldId: id,
          write: () => portPatch('p2', { hidden: true }),
          expectWrite: (result) => expect((result as { property?: unknown }).property).toMatchObject({ hidden: true }),
        })
      })

      test('FO-P3 ensureFields in overwrite mode: the version row is held once the FIRST field row is locked, before a later field trips the trigger', async () => {
        expect(isWriterFenceEnabled()).toBe(false)
        // Two existing fields, upserted in order: the first keeps its visibility (its upsert locks the row and fires no
        // bump), the second is hidden and the descriptor unhides it (the trigger fires there). Held right after the
        // FIRST upsert, the writer holds a field row and nothing the trigger did yet: only the explicit bump can have
        // taken the version row. (A hold after a visibility-changing upsert would see the trigger's own bump.)
        const first = fld('p3a')
        const id = fld('p3')
        await seedField(SHEET, first, 'string', {}, 39)
        await seedField(SHEET, id, 'string', { hidden: true }, 40)
        const client = await rawClient()
        let released!: () => void
        const gate = new Promise<void>((resolve) => { released = resolve })
        let reachedUpsert!: () => void
        const upsertReached = new Promise<void>((resolve) => { reachedUpsert = resolve })
        let held = false
        try {
          await client.query('BEGIN')
          const running = ensureFields({
            query: async (sql, params) => {
              const res = await client.query(sql, params as unknown[])
              if (!held && sql.trim().startsWith('INSERT INTO meta_fields')) {
                held = true
                reachedUpsert()
                await gate
              }
              return { rows: res.rows, rowCount: res.rowCount ?? undefined }
            },
            sheetId: SHEET,
            overwriteMode: 'overwrite',
            // The descriptors carry no `hidden`: the second overwrite UNHIDES the stored field (a trigger-relevant rewrite).
            fields: [{ id: first, name: 'F p3a', type: 'string', order: 39 }, { id, name: 'F p3', type: 'string', order: 40 }],
          })
          running.catch(() => {})
          await upsertReached
          expect(await fieldRowProbe(first), 'the first upsert holds its existing field row').toBe('held')
          expect(await fieldRowProbe(id), 'the second field is not locked yet').toBe('free')
          expect(await versionRowProbe(SHEET), 'FO-P3: the version row was taken BEFORE the first field row').toBe('held')
          released()
          await running
          await client.query('COMMIT')
          expect(isFieldPermissionHidden({ property: ((await propertyOf(id)) ?? {}) as Record<string, unknown> })).toBe(false)
        } finally {
          released?.()
          await client.query('ROLLBACK').catch(() => undefined)
          client.release()
        }
      })
    })

    describe('PATCH /fields/:fieldId', () => {
      test('FO-F1 hiding a field with a reorder: the version row is held at the sibling shift AND at the late re-read', async () => {
        expect(isWriterFenceEnabled()).toBe(false)
        const id = fld('f1')
        const sibling = fld('f1s')
        await seedField(SHEET, id, 'string', {}, 50)
        await seedField(SHEET, sibling, 'string', {}, 51)
        for (const [text, what] of [[PATCH_SHIFT_LEFT_SQL, 'the sibling shift'], [PATCH_FIELD_LOCKED_REREAD_SQL, 'the late re-read']] as const) {
          await q('UPDATE meta_fields SET property = $2::jsonb, "order" = $3 WHERE id = $1', [id, '{}', 50])
          await q('UPDATE meta_fields SET "order" = 51 WHERE id = $1', [sibling])
          const hold = holdAfter(text)
          let patching: ReturnType<typeof tracked> | null = null
          try {
            patching = tracked(() => patchField(id, { property: { hidden: true }, order: 51 }))
            await hold.reached()
            expect(await versionRowProbe(SHEET), `FO-F1: the version row is held at ${what}`).toBe('held')
            hold.release()
            expectOk(await patching.promise)
            expect(await propertyOf(id)).toMatchObject({ hidden: true })
          } finally {
            hold.restore()
            if (patching) await patching.promise.catch(() => {})
          }
        }
      })

      test('FO-F4 hiding a field WITHOUT a reorder: the version row is already held at the late re-read, the first field-row lock of such a PATCH', async () => {
        // FO-F1 checks the late re-read only after its sibling-shift check, and every PATCH there reorders (verifier r1
        // F7): here the locked re-read is the first field-row lock, so a bump that waited for a reorder reds this case.
        expect(isWriterFenceEnabled()).toBe(false)
        const id = fld('f4')
        await seedField(SHEET, id, 'string', {}, 53)
        const hold = holdAfter(PATCH_FIELD_LOCKED_REREAD_SQL)
        let patching: ReturnType<typeof tracked> | null = null
        try {
          patching = tracked(() => patchField(id, { property: { hidden: true } }))
          await hold.reached()
          expect(await fieldRowProbe(id), 'FO-F4: the late re-read holds the field row').toBe('held')
          expect(await versionRowProbe(SHEET), 'FO-F4: the version row is held at the late re-read').toBe('held')
          hold.release()
          expectOk(await patching.promise)
          expect(await propertyOf(id)).toMatchObject({ hidden: true })
        } finally {
          hold.restore()
          if (patching) await patching.promise.catch(() => {})
        }
      })

      test('FO-F2 hiding a field vs an admission holder: serialized on the version row, never a false ALLOW', async () => {
        expect(isWriterFenceEnabled()).toBe(false)
        const id = fld('f2')
        await seedField(SHEET, id, 'string', {}, 60)
        await holderBarrier({ sheetId: SHEET, fieldId: id, write: () => patchField(id, { property: { hidden: true } }), expectWrite: expectOk })
      })

      test('FO-F3 the shared column drag and a rename never touch the version row: they finish while a holder holds it FOR SHARE', async () => {
        expect(isWriterFenceEnabled()).toBe(false)
        const a = fld('f3a')
        const b = fld('f3b')
        await seedField(SHEET, a, 'string', { hidden: true }, 70)
        await seedField(SHEET, b, 'string', {}, 71)
        const holder = await openHolder(SHEET)
        try {
          const locked = await holder.lock()
          for (const [what, run] of [
            ['a drag (order only)', () => patchField(a, { order: 71 })],
            ['a rename of a hidden field', () => patchField(a, { name: 'F3 renamed' })],
            ['an options-like property edit that keeps hidden', () => patchField(a, { property: { hidden: true, note: 'x' } })],
          ] as const) {
            const writing = tracked(run)
            const outcome = await raceParkedOrSettled({ blockerPid: holder.pid, settled: writing.settled })
            expect(outcome, `FO-F3: ${what} finished without waiting on the holder`).toBe('settled')
            expectOk(await writing.promise)
          }
          expect(await sheetVersion(SHEET), 'none of them bumped the sheet version').toBe(locked.sheetVersions[0]!.version)
        } finally {
          await holder.end('COMMIT')
        }
      })

      test('FO-W1 two canonical writers of one field: a config revert parks on the VERSION ROW behind a PATCH that bumped first; both end typed, no 40P01', async () => {
        expect(isWriterFenceEnabled()).toBe(false)
        process.env[RETYPE_REVERT_FLAG] = 'true'
        delete process.env[LOSSY_REVERT_FLAG]
        const id = fld('w1')
        await seedField(SHEET, id, 'string', {}, 80)
        const rev = await insertRev(SHEET, id, { type: 'number', property: { hidden: true } }, { type: 'string', property: {} }, ['type', 'property'])
        const pv = await preview(SHEET, rev)
        expect(pv.status, JSON.stringify(pv.body).slice(0, 300)).toBe(200)
        const hold = holdAfter(SHEET_PERMISSION_VERSIONS_BUMP_SQL)
        let patching: ReturnType<typeof tracked> | null = null
        let reverting: ReturnType<typeof tracked> | null = null
        try {
          patching = tracked(() => patchField(id, { property: { hidden: true } }))
          const patchPid = await hold.reached()
          reverting = tracked(() => execute(SHEET, rev, String(pv.body.data.previewToken)))
          const outcome = await raceParkedOrSettled({ blockerPid: patchPid, queryText: SHEET_PERMISSION_VERSIONS_BUMP_SQL, settled: reverting.settled })
          expect(outcome, 'FO-W1: the revert waits on the version row the PATCH took first').toBe('parked')
          expect(await fieldRowProbe(id), 'FO-W1: neither writer holds the field row yet').toBe('free')
          hold.release()
          const patched = (await patching.promise) as Response
          const reverted = (await reverting.promise) as Response
          expect(patched.status, JSON.stringify(patched.body).slice(0, 300)).toBe(200)
          // The PATCH changed the property after the preview: the revert answers a typed 409, never a 500 (40P01).
          expect(reverted.status, JSON.stringify(reverted.body).slice(0, 300)).toBe(409)
          expect(['PREVIEW_STALE', 'CONFIG_DRIFT']).toContain(reverted.body?.error?.code)
        } finally {
          hold.restore()
          if (patching) await patching.promise.catch(() => {})
          if (reverting) await reverting.promise.catch(() => {})
        }
      })
    })

    const waitingQueryOf = async (pid: number): Promise<string> =>
      String(((await q('SELECT query FROM pg_stat_activity WHERE pid = $1', [pid])).rows[0] as { query?: string } | undefined)?.query ?? '')
    const errorTag = (error: unknown): string =>
      `${String((error as { code?: unknown } | null)?.code)}/${String((error as { sqlState?: unknown } | null)?.sqlState)}`

    describe('writer vs writer: the sheet row before the version row (verifier r1 F1)', () => {
      /** An `ensureFields` overwrite in the plugin port's shape: one pool transaction around the function. */
      const ensureOverwrite = (sheetId: string, fields: Array<{ id: string; name: string; type: string; order: number }>) =>
        poolManager.get().transaction(async ({ query }) => ensureFields({
          query: async (sql, params) => {
            const res = await query(sql, params) as { rows?: unknown[]; rowCount?: number | null }
            return { rows: Array.isArray(res.rows) ? res.rows : [], rowCount: typeof res.rowCount === 'number' ? res.rowCount : undefined }
          },
          sheetId,
          overwriteMode: 'overwrite',
          fields: fields as never,
        }))

      /**
       * The field-permission grant route (PUT …/field-permissions/:fieldId/user/:subjectId) is held right after its
       * `meta_sheets … FOR UPDATE`, with the sheet version row next on its list; then `write` starts — a field-row writer
       * that bumps and then inserts an FK child of meta_sheets (that insert takes FOR KEY SHARE on the sheet row by
       * itself). The writer must park on the sheet row's KEY SHARE BEFORE its bump: the version row stays free while it
       * waits, the grant takes it and commits, the writer follows — no 40P01. With the bump first, the writer held the
       * version row, parked on the FK's KEY SHARE behind the grant, and the grant then waited on the version row (a cycle).
       */
      async function grantVsSheetRowWriter(grantField: string, write: () => PromiseLike<string>) {
        const hold = holdAfter(SHEET_ROW_LOCK_LIVENESS_SQL)
        let granting: ReturnType<typeof tracked> | null = null
        let writing: { promise: Promise<string>; settled: () => boolean } | null = null
        try {
          granting = tracked(() => http().put(`/api/multitable/sheets/${SHEET}/field-permissions/${grantField}/user/${DB_ACTOR}`).send({ visible: false }))
          const grantPid = await hold.reached()
          writing = tracked(write)
          const parked = await raceParkedOrSettled({ blockerPid: grantPid, queryText: SHEET_ROW_KEY_SHARE_SQL, settled: writing.settled, timeoutMs: 5000 })
          const versionRowWhileParked = await versionRowProbe(SHEET)
          hold.release()
          const granted = (await granting.promise) as Response
          const written = await writing.promise.catch((error: unknown) => errorTag(error))
          return { parkedOnSheetRowKeyShare: parked, versionRowWhileParked, grant: granted.status, writer: written }
        } finally {
          hold.restore()
          if (granting) await granting.promise.catch(() => {})
          if (writing) await writing.promise.catch(() => {})
          await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET]).catch(() => {})
        }
      }

      for (const fence of ['off', 'on'] as const) {
        test(`FO-X1 an ensureFields overwrite that ADDS a field vs PUT field-permissions on the same sheet (fence ${fence}): the overwrite waits on the sheet row, never a 40P01`, async () => {
          const existing = fld(`x1${fence}a`)
          const added = fld(`x1${fence}b`)
          await seedField(SHEET, existing, 'string', {}, fence === 'off' ? 90 : 92)
          const name = String(((await q('SELECT name FROM meta_fields WHERE id = $1', [existing])).rows[0] as { name: string }).name)
          const run = () => grantVsSheetRowWriter(existing, () => ensureOverwrite(SHEET, [
            { id: existing, name, type: 'string', order: fence === 'off' ? 90 : 92 },
            { id: added, name: 'F x1 added', type: 'string', order: fence === 'off' ? 91 : 93 },
          ]).then(() => 'ok'))
          const outcome = fence === 'on' ? await withWriterFenceOn(run) : await run()
          const addedExists = (await q('SELECT 1 FROM meta_fields WHERE id = $1', [added])).rows.length === 1
          expect({ ...outcome, addedExists }, `FO-X1 (fence ${fence}): the overwrite parks on the sheet row before its bump; both writers finish`).toEqual({
            parkedOnSheetRowKeyShare: 'parked', versionRowWhileParked: 'free', grant: 200, writer: 'ok', addedExists: true,
          })
        })
      }

      test('FO-X2 a PATCH /fields that hides a field AND converts it to autoNumber vs PUT field-permissions (the twin: the auto-number sequence row is an FK child of meta_sheets)', async () => {
        expect(isWriterFenceEnabled()).toBe(false)
        const grantField = fld('x2g')
        const id = fld('x2')
        await seedField(SHEET, grantField, 'string', {}, 95)
        await seedField(SHEET, id, 'string', {}, 96)
        const outcome = await grantVsSheetRowWriter(grantField, () => patchField(id, { type: 'autoNumber', property: { hidden: true } })
          .then((res: Response) => (res.status === 200 ? 'ok' : `${res.status}/${String(res.body?.error?.code)}`)))
        const stored = (await q('SELECT type, property FROM meta_fields WHERE id = $1', [id])).rows[0] as { type: string; property: Record<string, unknown> }
        const sequence = (await q('SELECT 1 FROM meta_field_auto_number_sequences WHERE field_id = $1', [id])).rows.length
        expect({ ...outcome, type: stored.type, hidden: stored.property?.hidden === true, sequence }, 'FO-X2: the PATCH parks on the sheet row before its bump; both writers finish').toEqual({
          parkedOnSheetRowKeyShare: 'parked', versionRowWhileParked: 'free', grant: 200, writer: 'ok', type: 'autoNumber', hidden: true, sequence: 1,
        })
      })
    })

    describe('field retype convert and its undo vs an admission holder (verifier r1 F2)', () => {
      /** A fresh, unmanaged sheet whose one text column stores the LEGACY jsonb-STRING encoding of `{ hidden: true }`. */
      async function legacyStringColumn(tag: string) {
        const sheetId = `sheet_fro_${tag}_${TOKEN}`
        EXTRA_SHEETS.push(sheetId)
        await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [sheetId, BASE, 'FRO Convert'])
        await bumpSheetPermissionVersions((sql, params) => q(sql, params), [sheetId])
        const id = fld(tag)
        // seedField JSON-encodes once more: the column stores a jsonb STRING (record-duplicate-guard.ts:66 still reads it)
        await seedField(sheetId, id, 'string', JSON.stringify({ hidden: true }), 1)
        const records = [`rec_fro_${tag}_1_${TOKEN}`, `rec_fro_${tag}_2_${TOKEN}`]
        await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [records[0], sheetId, JSON.stringify({ [id]: 'ALPHA' }), DB_ACTOR])
        await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [records[1], sheetId, JSON.stringify({ [id]: 'BETA' }), DB_ACTOR])
        expect((await q('SELECT jsonb_typeof(property) AS t FROM meta_fields WHERE id = $1', [id])).rows[0].t).toBe('string')
        return { sheetId, id, records }
      }
      /** The conversion's preconditions: its flag, the writer fence it refuses to run without, a real database actor. */
      async function asConverter<T>(run: () => Promise<T>): Promise<T> {
        process.env[CONVERT_FLAG] = 'true'
        currentUser = { id: DB_ACTOR, roles: ['member'], perms: DB_ACTOR_PERMS, permissions: DB_ACTOR_PERMS }
        try {
          return await withWriterFenceOn(run)
        } finally {
          currentUser = ADMIN
          if (flags[CONVERT_FLAG] === undefined) delete process.env[CONVERT_FLAG]
          else process.env[CONVERT_FLAG] = flags[CONVERT_FLAG]
        }
      }
      const retypePreview = (fieldId: string) => http().post(`/api/multitable/fields/${fieldId}/retype-preview`).send({ targetType: 'select' })
      const retypeExecute = (fieldId: string, previewToken: string) =>
        http().post(`/api/multitable/fields/${fieldId}/retype-execute`).send({ previewToken, confirm: FIELD_RETYPE_CONVERT_CONFIRM })
      const retypeUndo = (fieldId: string, convertRevisionId: string) =>
        http().post(`/api/multitable/fields/${fieldId}/retype-undo`).send({ convertRevisionId, confirm: FIELD_RETYPE_UNDO_CONFIRM })
      async function previewToken(fieldId: string): Promise<string> {
        const pv = await retypePreview(fieldId) as Response
        expect(pv.status, JSON.stringify(pv.body).slice(0, 300)).toBe(200)
        expect(pv.body.data?.verdict).toBe('ok')
        return String(pv.body.data?.previewToken)
      }

      /**
       * A whole-column writer (`write`: the convert or the undo) is held right after it locked every live row FOR UPDATE —
       * it already holds the field row — and an admission holder that binds one of those records starts. The writer
       * must already hold the sheet version row (bumped before its first row lock), so the holder waits at the version
       * row, its FIRST lock. With the trigger-only order the holder took the version row FOR SHARE, waited on the bound
       * record the writer holds, and the writer's field UPDATE (a legacy string property flips the trigger's flags)
       * then waited on the version row: 40P01.
       */
      async function wholeColumnWriterVsHolder(sheetId: string, fieldId: string, recordId: string, write: () => PromiseLike<unknown>) {
        const startVersion = await sheetVersion(sheetId)
        const hold = holdAfter(CONVERT_LIVE_ROWS_LOCKED_SQL)
        let writing: ReturnType<typeof tracked> | null = null
        let holder: Awaited<ReturnType<typeof openHolder>> | null = null
        let ended = false
        try {
          writing = tracked(write)
          const writerPid = await hold.reached()
          const atHold = { fieldRow: await fieldRowProbe(fieldId), versionRow: await versionRowProbe(sheetId) }
          holder = await openHolder(sheetId, recordId)
          const opened = holder
          const locking = tracked(() => opened.lock())
          const parked = await raceParkedOrSettled({ blockerPid: writerPid, settled: locking.settled, timeoutMs: 5000 })
          const waitsAt = await waitingQueryOf(holder.pid)
          hold.release()
          const written = (await writing.promise) as Response
          const lockOutcome = await locking.promise.then(() => 'locked', errorTag)
          const holderSeesHidden = lockOutcome === 'locked' ? await holder.seesHidden(fieldId) : 'n/a'
          await holder.end(lockOutcome === 'locked' ? 'COMMIT' : 'ROLLBACK')
          ended = true
          return {
            atHold,
            holderParkedBehindWriter: parked,
            holderWaitsAt: waitsAt.includes(SHEET_PERMISSION_VERSIONS_TABLE) ? 'version row' : waitsAt.includes('meta_records') ? 'bound record' : waitsAt.slice(0, 60),
            writer: written.status === 200 ? 'ok' : `${written.status}/${String(written.body?.error?.code)}`,
            lockOutcome,
            holderSeesHidden,
            versionMoved: (await sheetVersion(sheetId)) > startVersion,
          }
        } finally {
          hold.restore()
          if (writing) await writing.promise.catch(() => {})
          if (!ended && holder) await holder.end('ROLLBACK').catch(() => undefined)
        }
      }
      const SERIALIZED = {
        atHold: { fieldRow: 'held', versionRow: 'held' },
        holderParkedBehindWriter: 'parked',
        holderWaitsAt: 'version row',
        writer: 'ok',
        lockOutcome: 'locked',
        holderSeesHidden: true,
        versionMoved: true,
      }

      test('FO-R1 the retype convert of a legacy jsonb-STRING {hidden:true} column vs a holder binding a live record: the holder waits at the version row, no 40P01', async () => {
        const { sheetId, id, records } = await legacyStringColumn('r1')
        const outcome = await asConverter(async () => {
          const token = await previewToken(id)
          return wholeColumnWriterVsHolder(sheetId, id, records[1]!, () => retypeExecute(id, token))
        })
        expect(outcome, 'FO-R1: the convert holds the version row before its row locks; the holder serializes behind it').toEqual(SERIALIZED)
        const stored = (await q('SELECT type, jsonb_typeof(property) AS kind, property FROM meta_fields WHERE id = $1', [id])).rows[0] as { type: string; kind: string; property: Record<string, unknown> }
        expect([stored.type, stored.kind, stored.property.hidden], 'the conversion parsed the string and kept hidden').toEqual(['select', 'object', true])
      })

      test('FO-R2 the undo, which writes the stored jsonb STRING back over the converted object, vs a holder binding a live record: the holder waits at the version row, no 40P01', async () => {
        const { sheetId, id, records } = await legacyStringColumn('r2')
        const outcome = await asConverter(async () => {
          const executed = await retypeExecute(id, await previewToken(id)) as Response
          expect(executed.status, JSON.stringify(executed.body).slice(0, 300)).toBe(200)
          const convertRevisionId = String(executed.body.data?.convertRevisionId)
          return wholeColumnWriterVsHolder(sheetId, id, records[0]!, () => retypeUndo(id, convertRevisionId))
        })
        expect(outcome, 'FO-R2: the undo holds the version row before its row locks; the holder serializes behind it').toEqual(SERIALIZED)
        const stored = (await q('SELECT type, jsonb_typeof(property) AS kind FROM meta_fields WHERE id = $1', [id])).rows[0] as { type: string; kind: string }
        expect([stored.type, stored.kind], 'the undo restored the stored string as it was').toEqual(['string', 'string'])
      })
    })
  })
}
