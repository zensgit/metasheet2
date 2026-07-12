/**
 * D-2 — side-door delete RECOVERABILITY (design-lock #4004, owner-ratified 2026-07-09). Real DB.
 *
 * The two side-door record hard-delete paths — plugin-SDK `records.deleteRecord` (path 3) and the
 * automation executor's `delete_record` step (path 4) — got a delete revision from D-1 but NO trash row
 * and NO inbound-edge tombstones: the record was invisible to trash-restore and outside 4c-3's
 * inbound-replay reach, i.e. IRRECOVERABLE, while the same record deleted through the UI was fully
 * recoverable. D-2 closes that, behind `MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED` (default OFF).
 *
 * ## §1.11 dual-flag × schema truth table — every row is pinned here, for BOTH lanes
 *
 * | SIDE_DOOR | CAPTURE | trash schema | expected behavior on paths 3+4        | golden      |
 * |-----------|---------|--------------|---------------------------------------|-------------|
 * | off       | off     | any          | byte-identical D-1 (revision-only)    | G6a-1       |
 * | off       | ON      | any          | byte-identical D-1, ZERO tombstones   | G6a-2       |
 * | ON        | off     | present      | trash + anchor, zero tombstones       | G6b / G1    |
 * | ON        | ON      | present      | full UI parity (trash+anchor+capture) | G1/G2/G4    |
 * | ON        | any     | MISSING      | FAIL-CLOSED: delete refused           | G11         |
 *
 * G6a-2 is the load-bearing NESTING golden (§1.5): capture on paths 3+4 is nested under the D-2 flag, so
 * an operator running with capture already on sees ZERO behavior change until they opt into D-2. Copying
 * the UI path's CAPTURE-only gating would break that — hence the dedicated row.
 *
 * ## Transaction boundary (§1.1 / OD-7) — G3
 *
 * Both lanes run in real transactions in production (plugin: `poolManager.get().transaction`,
 * index.ts:634-653; automation: `withTransaction` with the `transaction` dep supplied at
 * automation-service.ts:840). This suite MIRRORS that wiring — note `makeExecutor()` supplies
 * `deps.transaction` (the D-1 suite does NOT, so its executor silently ran without a txn). G3 injects a
 * failure at the record DELETE (D1-5b BEFORE-DELETE-trigger technique — fail the destructive statement
 * itself, never a revision-INSERT injection, which #3992 proved fake-green for atomicity) and separately
 * at the trash INSERT, and asserts the WHOLE unit rolls back. The discriminating assertion is not "the
 * record still exists" (a swallowed error would also leave it alive) but: seeded inbound link intact +
 * ZERO delete revisions + ZERO tombstones + ZERO trash rows.
 *
 * Trigger injections are SCOPED BY RECORD-ID PREFIX so they cannot affect other suites sharing this
 * database (plugin-tests.yml runs many describeIfDatabase files against ONE Postgres).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { MemoryRateLimitStore } from '../../src/middleware/rate-limiter'
import { poolManager } from '../../src/integration/db/connection-pool'
import { EventBus } from '../../src/integration/events/event-bus'
import {
  AutomationExecutor,
  type AutomationDeps,
  type AutomationRule,
} from '../../src/multitable/automation-executor'
import { deleteRecord as pluginDeleteRecord, MultitableRecordDeleteCapExceededError } from '../../src/multitable/records'
import { RecordService } from '../../src/multitable/record-service'
import { recordRecordRevision } from '../../src/multitable/record-history-service'
import { reconstructRecordsAtT } from '../../src/multitable/record-reconstructor'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import {
  sweepLinkTombstoneRetention,
  type MetaRevisionRetentionConfig,
} from '../../src/multitable/meta-revision-retention'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const OWNER = `u_d2_owner_${TS}`
const BASE = `base_d2_${TS}`
const BASE_X = `base_d2_x_${TS}` // OD-8: cross-base delete target
const SHEET_A = `sheet_d2_a_${TS}` // victims live here
const SHEET_B = `sheet_d2_b_${TS}` // neighbours + the link field
const SHEET_X = `sheet_d2_x_${TS}` // cross-base target sheet (in BASE_X)

const SIDE_DOOR_FLAG = 'MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED'
const CAPTURE_FLAG = 'MULTITABLE_TOMBSTONE_CAPTURE_ENABLED'
const CAP_ROWS = 'MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS'
const INBOUND_FLAG = 'MULTITABLE_ENABLE_RECORD_UNDELETE_INBOUND'

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let seq = 0
const mkField = (tag: string) => `fld_d2_${tag}_${TS}_${seq++}`
/** Record ids carry a per-golden tag — the scoped failure-injection triggers match on that prefix. */
const mkRecord = (tag: string) => `rec_d2_${tag}_${TS}_${seq++}`

/** Mirrors the production plugin wiring (index.ts:634-653): every SDK call inside a real transaction. */
async function pluginDelete(recordId: string, sheetId: string = SHEET_A): Promise<unknown> {
  return poolManager.get().transaction(async ({ query }) =>
    pluginDeleteRecord({ query: query as never, sheetId, recordId } as never),
  )
}

/** Mirrors the production automation wiring (automation-service.ts:840) — `transaction` dep SUPPLIED. */
function makeExecutor(): AutomationExecutor {
  const deps: AutomationDeps = {
    eventBus: new EventBus(),
    queryFn: (sql: string, params?: unknown[]) => q(sql, params),
    transaction: async (handler) => poolManager.get().transaction(async ({ query }) => handler({ query } as never)),
    crossBaseWriteQuota: { limit: 1000, windowMs: 60_000, store: new MemoryRateLimitStore() },
  } as unknown as AutomationDeps
  return new AutomationExecutor(deps)
}

function deleteRule(config: Record<string, unknown> = {}): AutomationRule {
  return {
    id: `axr_d2_${TS}_${Math.random().toString(36).slice(2, 8)}`,
    name: 'D2 delete rule',
    sheetId: SHEET_A,
    trigger: { type: 'record.created', config: {} },
    actions: [{ type: 'delete_record', config } as never],
    enabled: true,
    createdBy: OWNER,
    createdAt: new Date().toISOString(),
  } as unknown as AutomationRule
}

async function automationDelete(
  recordId: string,
  opts: { sheetId?: string; config?: Record<string, unknown> } = {},
): Promise<{ status?: string; error?: string }> {
  const exec = await makeExecutor().execute(deleteRule(opts.config ?? {}), {
    recordId,
    sheetId: opts.sheetId ?? SHEET_A,
    actorId: OWNER,
    data: {},
  })
  return (exec.steps[0] ?? {}) as { status?: string; error?: string }
}

type Lane = 'plugin' | 'automation'
const LANES: Lane[] = ['plugin', 'automation']
/** The two side doors, driven through ONE seam so every truth-table row is asserted for BOTH. */
async function sideDoorDelete(lane: Lane, recordId: string): Promise<void> {
  if (lane === 'plugin') await pluginDelete(recordId)
  else {
    const step = await automationDelete(recordId)
    expect(step.status).toBe('success')
  }
}

async function insertRecord(sheetId: string, recordId: string, data: Record<string, unknown>, createdBy: string | null = null): Promise<void> {
  await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,3,$4)', [
    recordId, sheetId, JSON.stringify(data), createdBy,
  ])
  // Seed the create revision the real write path emits, so the revision stream has production's shape
  // (create → [delete]). reconstructRecordsAtT derives existence PURELY from revisions — without this,
  // a record would read as non-existent at every T and G12 could not tell flag-off from flag-on.
  await recordRecordRevision(q, {
    sheetId,
    recordId,
    version: 3,
    action: 'create',
    source: 'rest',
    actorId: OWNER,
    changedFieldIds: [],
    patch: {},
    snapshot: data,
  })
}

/** Fixture: neighbour N (on SHEET_B) points at victim R (on SHEET_A) through link field F — one INBOUND edge. */
async function fixture(tag: string, opts: { createdBy?: string | null; sheetId?: string } = {}): Promise<{ F: string; R: string; N: string }> {
  const F = mkField(tag)
  await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
    F, SHEET_B, F, 'link', '{}', seq,
  ])
  const R = mkRecord(tag)
  await insertRecord(opts.sheetId ?? SHEET_A, R, { title: `victim ${tag}` }, opts.createdBy ?? null)
  const N = mkRecord(`${tag}n`)
  await insertRecord(SHEET_B, N, { [F]: [R] })
  await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [F, N, R])
  return { F, R, N }
}

const recordExists = async (id: string): Promise<boolean> =>
  (await q('SELECT 1 FROM meta_records WHERE id = $1', [id])).rows.length > 0
const trashRow = async (id: string): Promise<Record<string, unknown> | undefined> =>
  (await q('SELECT * FROM meta_records_trash WHERE record_id = $1', [id])).rows[0] as Record<string, unknown> | undefined
const tombstones = async (id: string): Promise<Array<Record<string, unknown>>> =>
  (await q('SELECT * FROM meta_link_tombstones WHERE foreign_record_id = $1', [id])).rows as Array<Record<string, unknown>>
const deleteRevisions = async (id: string): Promise<Array<{ id: string; source: string; snapshot: unknown }>> =>
  (await q(`SELECT id, source, snapshot FROM meta_record_revisions WHERE record_id = $1 AND action = 'delete'`, [id]))
    .rows as never[]
const edgeAlive = async (F: string, N: string, R: string): Promise<boolean> =>
  (await q('SELECT 1 FROM meta_links WHERE field_id=$1 AND record_id=$2 AND foreign_record_id=$3', [F, N, R])).rows.length > 0

/**
 * D1-5b failure injection, SCOPED to one golden's record-id prefix so concurrent suites on this shared DB
 * are untouched. Fails the destructive statement ITSELF (not a revision INSERT — #3992 proved that
 * variant fake-green for atomicity).
 */
async function injectTrigger(
  name: string,
  spec: { table: string; timing: string; column: string; prefix: string; errcode: string; message: string },
): Promise<void> {
  await q(`CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger AS $fn$
           BEGIN
             RAISE EXCEPTION '${spec.message}' USING ERRCODE = '${spec.errcode}';
           END $fn$ LANGUAGE plpgsql`)
  await q(`CREATE TRIGGER ${name}_trg BEFORE ${spec.timing} ON ${spec.table}
           FOR EACH ROW WHEN (${spec.column} LIKE '${spec.prefix}%') EXECUTE FUNCTION ${name}()`)
}
async function dropTrigger(name: string, table: string): Promise<void> {
  await q(`DROP TRIGGER IF EXISTS ${name}_trg ON ${table}`).catch(() => {})
  await q(`DROP FUNCTION IF EXISTS ${name}()`).catch(() => {})
}

const RETENTION: MetaRevisionRetentionConfig = {
  enabled: true, policy: 'keep-days', keepN: 5, retentionDays: 30, batchSize: 100,
}

describeIfDatabase('D-2 — side-door delete recoverability (plugin + automation, real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = { id: OWNER, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1,$2,$3)', [BASE, 'D2 Base', OWNER])
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1,$2,$3)', [BASE_X, 'D2 Base X', OWNER])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_A, BASE, 'D2 A'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_B, BASE, 'D2 B'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_X, BASE_X, 'D2 X'])
    // loadSheetAndFields (plugin lane) requires >= 1 field on the victim's sheet.
    for (const sheet of [SHEET_A, SHEET_X]) {
      await q(`INSERT INTO meta_fields (id, sheet_id, name, type, "order") VALUES ($1,$2,'Title','text',0)`, [
        mkField('title'), sheet,
      ])
    }
  })

  afterEach(() => {
    delete process.env[SIDE_DOOR_FLAG]
    delete process.env[CAPTURE_FLAG]
    delete process.env[CAP_ROWS]
    delete process.env[INBOUND_FLAG]
  })

  afterAll(async () => {
    for (const flag of [SIDE_DOOR_FLAG, CAPTURE_FLAG, CAP_ROWS, INBOUND_FLAG]) delete process.env[flag]
    for (const sheet of [SHEET_A, SHEET_B, SHEET_X]) {
      await q('DELETE FROM meta_link_tombstones WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_links WHERE field_id IN (SELECT id FROM meta_fields WHERE sheet_id = $1)', [sheet]).catch(() => {})
      await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = $1', [sheet]).catch(() => {})
    }
    for (const base of [BASE, BASE_X]) await q('DELETE FROM meta_bases WHERE id = $1', [base]).catch(() => {})
  })

  test('sentinel: DATABASE_URL is set (this suite must RUN, never skip-green)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // ── §1.11 row 1 + row 2 — SIDE_DOOR off ⇒ byte-identical D-1 ───────────────────────────────────────
  for (const lane of LANES) {
    test(`G6a-1 [${lane}] truth-table row 1 (SIDE_DOOR off, CAPTURE off): revision only — no trash, no tombstones`, async () => {
      const { R } = await fixture(`g6a1${lane}`)
      await sideDoorDelete(lane, R)

      expect(await recordExists(R)).toBe(false)
      expect(await deleteRevisions(R)).toHaveLength(1) // D-1 still holds
      expect(await trashRow(R)).toBeUndefined()
      expect(await tombstones(R)).toHaveLength(0)
    })

    test(`G6a-2 [${lane}] truth-table row 2 — THE NESTING GOLDEN (§1.5): CAPTURE on + SIDE_DOOR off ⇒ ZERO side-door tombstones`, async () => {
      process.env[CAPTURE_FLAG] = 'true' // capture on, D-2 NOT opted into
      const { R } = await fixture(`g6a2${lane}`)
      await sideDoorDelete(lane, R)

      // If capture were gated on CAPTURE alone (a copy of the UI path's gating, record-service.ts:828),
      // this would silently start writing tombstones the moment D-2 deploys — breaking §1.9 byte-identity
      // for every operator already running with capture on. It must not.
      expect(await tombstones(R)).toHaveLength(0)
      expect(await trashRow(R)).toBeUndefined()
      expect(await deleteRevisions(R)).toHaveLength(1)
      expect(await recordExists(R)).toBe(false)
    })
  }

  // ── §1.11 row 3 — SIDE_DOOR on, CAPTURE off ───────────────────────────────────────────────────────
  for (const lane of LANES) {
    test(`G6b/G1 [${lane}] truth-table row 3 (SIDE_DOOR on, CAPTURE off): trash row + anchor, ZERO tombstones`, async () => {
      process.env[SIDE_DOOR_FLAG] = 'true'
      const { R } = await fixture(`g6b${lane}`)
      await sideDoorDelete(lane, R)

      const trash = await trashRow(R)
      expect(trash).toBeDefined()
      const revs = await deleteRevisions(R)
      expect(revs).toHaveLength(1)
      // §1.2 anchor: trash.delete_revision_id === the delete revision's id.
      expect(trash!.delete_revision_id).toBe(revs[0]!.id)
      expect(await tombstones(R)).toHaveLength(0) // capture off ⇒ no tombstones, but the anchor is there
    })
  }

  // ── §1.11 row 4 — both flags on ⇒ full UI parity ──────────────────────────────────────────────────
  for (const lane of LANES) {
    test(`G1/G2 [${lane}] truth-table row 4 (both ON): full trash-row parity + anchored inbound tombstones`, async () => {
      process.env[SIDE_DOOR_FLAG] = 'true'
      process.env[CAPTURE_FLAG] = 'true'
      const { F, R, N } = await fixture(`g1${lane}`, { createdBy: `u_author_${TS}` })
      await sideDoorDelete(lane, R)

      // G1 — every trash column carries the pre-delete truth.
      const trash = await trashRow(R)
      expect(trash).toBeDefined()
      expect(trash!.sheet_id).toBe(SHEET_A)
      expect(trash!.base_id).toBe(BASE)
      expect(trash!.data).toMatchObject({ title: `victim g1${lane}` })
      expect(Number(trash!.original_version)).toBe(3)
      expect(trash!.created_by).toBe(`u_author_${TS}`)
      // OD-5 attribution: plugin lane is actor-less (null); automation lane carries context.actorId.
      expect(trash!.deleted_by).toBe(lane === 'plugin' ? null : OWNER)
      expect(trash!.original_created_at).toBeTruthy()
      expect(trash!.original_updated_at).toBeTruthy()

      // G2 — ONE anchor shared by revision, trash row and tombstone (this is what restore replays on).
      const revs = await deleteRevisions(R)
      expect(revs).toHaveLength(1)
      expect(revs[0]!.source).toBe(lane)
      const anchor = revs[0]!.id
      expect(trash!.delete_revision_id).toBe(anchor)

      const tombs = await tombstones(R)
      expect(tombs).toHaveLength(1)
      expect(tombs[0]!.source_revision_id).toBe(anchor)
      expect(tombs[0]!.reason).toBe('record_delete')
      expect(tombs[0]!.field_id).toBe(F)
      expect(tombs[0]!.record_id).toBe(N) // the NEIGHBOUR's id — the inbound edge's owner
      expect(await edgeAlive(F, N, R)).toBe(false) // the edge itself is destroyed; the tombstone shadows it
    })

    test(`G4 [${lane}] restore round-trip: side-door-deleted record is listed as recoverable, restores, inbound edge replays`, async () => {
      process.env[SIDE_DOOR_FLAG] = 'true'
      process.env[CAPTURE_FLAG] = 'true'
      process.env[INBOUND_FLAG] = 'true'
      const { F, R, N } = await fixture(`g4${lane}`)
      await sideDoorDelete(lane, R)
      expect(await edgeAlive(F, N, R)).toBe(false)

      // The recycle bin now SEES a machine-deleted record — the whole point of D-2.
      const trash = await request(app).get(`/api/multitable/sheets/${SHEET_A}/trash`)
      expect(trash.status).toBe(200)
      const row = (trash.body?.data?.records ?? trash.body?.records ?? []).find((r: { recordId: string }) => r.recordId === R)
      expect(row).toBeDefined()
      expect(row.inboundEdgesRecoverable).toBe(true)

      const res = await request(app).post(`/api/multitable/records/${R}/restore`)
      expect(res.status).toBe(200)
      expect(res.body?.data?.inbound).toMatchObject({ replayed: 1, recoverable: true })
      expect(await recordExists(R)).toBe(true)
      expect(await edgeAlive(F, N, R)).toBe(true) // the neighbour's cell renders R again
    })

    test(`G6b-restore [${lane}] SIDE_DOOR on + CAPTURE off: restore honestly reports recoverable=false and fabricates NO edge`, async () => {
      process.env[SIDE_DOOR_FLAG] = 'true'
      process.env[INBOUND_FLAG] = 'true' // capture stays OFF ⇒ nothing was captured to replay
      const { F, R, N } = await fixture(`g6br${lane}`)
      await sideDoorDelete(lane, R)

      const res = await request(app).post(`/api/multitable/records/${R}/restore`)
      expect(res.status).toBe(200)
      expect(res.body?.data?.inbound).toMatchObject({ replayed: 0, recoverable: false })
      expect(await recordExists(R)).toBe(true) // the record comes back
      expect(await edgeAlive(F, N, R)).toBe(false) // …but its inbound edge does NOT, and we say so
    })
  }

  // ── G3 — transaction boundary (§1.1 / OD-7) ───────────────────────────────────────────────────────
  for (const lane of LANES) {
    test(`G3a [${lane}] txn contract: a failing record DELETE rolls back trash + revision + tombstones + the links DELETE`, async () => {
      process.env[SIDE_DOOR_FLAG] = 'true'
      process.env[CAPTURE_FLAG] = 'true'
      const tag = `g3a${lane}`
      const { F, R, N } = await fixture(tag)
      const trg = `d2_g3a_${lane}_${TS}`
      await injectTrigger(trg, {
        table: 'meta_records', timing: 'DELETE', column: 'OLD.id',
        prefix: `rec_d2_${tag}`, errcode: 'P0001', message: 'D2 G3a injected record-DELETE failure',
      })
      try {
        if (lane === 'plugin') {
          await expect(pluginDelete(R)).rejects.toThrow(/injected record-DELETE failure/)
        } else {
          const step = await automationDelete(R)
          expect(step.status).toBe('failed')
          expect(step.error).toMatch(/injected record-DELETE failure/)
        }
      } finally {
        await dropTrigger(trg, 'meta_records')
      }

      // The whole unit rolled back. "Record still exists" ALONE would also pass if the error had merely
      // been swallowed — so assert every other write is gone too, and that the links DELETE (which runs
      // BEFORE the failing statement) was undone.
      expect(await recordExists(R)).toBe(true)
      expect(await trashRow(R)).toBeUndefined()
      expect(await deleteRevisions(R)).toHaveLength(0)
      expect(await tombstones(R)).toHaveLength(0)
      expect(await edgeAlive(F, N, R)).toBe(true) // ← the inbound edge survived: the links DELETE rolled back
    })

    test(`G3b [${lane}] txn contract: a failing trash INSERT refuses the delete — record alive, no revision, no tombstones, edge intact`, async () => {
      process.env[SIDE_DOOR_FLAG] = 'true'
      process.env[CAPTURE_FLAG] = 'true'
      const tag = `g3b${lane}`
      const { F, R, N } = await fixture(tag)
      const trg = `d2_g3b_${lane}_${TS}`
      await injectTrigger(trg, {
        table: 'meta_records_trash', timing: 'INSERT', column: 'NEW.record_id',
        prefix: `rec_d2_${tag}`, errcode: 'P0001', message: 'D2 G3b injected trash-INSERT failure',
      })
      try {
        if (lane === 'plugin') {
          await expect(pluginDelete(R)).rejects.toThrow(/injected trash-INSERT failure/)
        } else {
          const step = await automationDelete(R)
          expect(step.status).toBe('failed')
        }
      } finally {
        await dropTrigger(trg, 'meta_records_trash')
      }

      expect(await recordExists(R)).toBe(true)
      expect(await deleteRevisions(R)).toHaveLength(0)
      expect(await tombstones(R)).toHaveLength(0)
      expect(await edgeAlive(F, N, R)).toBe(true)
    })
  }

  // ── §1.11 row 5 — G11 fail-closed on a missing trash schema (§1.8) ────────────────────────────────
  for (const lane of LANES) {
    for (const [label, errcode, message] of [
      ['42P01 (meta_records_trash table missing)', '42P01', 'relation "meta_records_trash" does not exist'],
      ['42703 (delete_revision_id column missing)', '42703', 'column "delete_revision_id" does not exist'],
    ] as const) {
      test(`G11 [${lane}] SIDE_DOOR on + ${label} ⇒ FAIL-CLOSED: the delete is REFUSED, nothing destroyed`, async () => {
        process.env[SIDE_DOOR_FLAG] = 'true'
        const tag = `g11${lane}${errcode}`
        const { F, R, N } = await fixture(tag)
        const trg = `d2_g11_${lane}_${errcode}_${TS}`
        await injectTrigger(trg, {
          table: 'meta_records_trash', timing: 'INSERT', column: 'NEW.record_id',
          prefix: `rec_d2_${tag}`, errcode, message,
        })
        try {
          if (lane === 'plugin') {
            await expect(pluginDelete(R)).rejects.toThrow(/does not exist/)
          } else {
            const step = await automationDelete(R)
            expect(step.status).toBe('failed')
            expect(step.error).toMatch(/does not exist/)
          }
        } finally {
          await dropTrigger(trg, 'meta_records_trash')
        }

        // The asymmetry with paths 1/2 is DELIBERATE (§1.8): the UI path swallows 42P01/42703 and deletes
        // anyway; an operator who opted INTO recoverability must never get a silently-unrecoverable delete.
        expect(await recordExists(R)).toBe(true)
        expect(await deleteRevisions(R)).toHaveLength(0)
        expect(await edgeAlive(F, N, R)).toBe(true)
      })
    }

    test(`G11-inert [${lane}] SIDE_DOOR OFF + the same schema hole ⇒ never touched: delete succeeds, revision-only`, async () => {
      const tag = `g11off${lane}`
      const { R } = await fixture(tag)
      const trg = `d2_g11off_${lane}_${TS}`
      await injectTrigger(trg, {
        table: 'meta_records_trash', timing: 'INSERT', column: 'NEW.record_id',
        prefix: `rec_d2_${tag}`, errcode: '42P01', message: 'relation "meta_records_trash" does not exist',
      })
      try {
        // §1.9: flag-off attempts NO trash write at all, so the pre-migration deploy window is inert BY
        // CONSTRUCTION — the trigger never fires.
        await sideDoorDelete(lane, R)
      } finally {
        await dropTrigger(trg, 'meta_records_trash')
      }
      expect(await recordExists(R)).toBe(false)
      expect(await deleteRevisions(R)).toHaveLength(1)
      expect(await trashRow(R)).toBeUndefined()
    })
  }

  // ── G7 — cap breach fail-closed (§1.4) ────────────────────────────────────────────────────────────
  for (const lane of LANES) {
    test(`G7 [${lane}] cap breach (both flags on): the delete is REFUSED — never a half-captured destruction`, async () => {
      process.env[SIDE_DOOR_FLAG] = 'true'
      process.env[CAPTURE_FLAG] = 'true'
      process.env[CAP_ROWS] = '1'
      const { F, R, N } = await fixture(`g7${lane}`)
      // A second inbound edge → 2 rows to capture, over the cap of 1.
      const N2 = mkRecord(`g7${lane}n2`)
      await insertRecord(SHEET_B, N2, { [F]: [R] })
      await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [F, N2, R])

      if (lane === 'plugin') {
        // OD-6: a TYPED SDK error, not a bare throw.
        await expect(pluginDelete(R)).rejects.toBeInstanceOf(MultitableRecordDeleteCapExceededError)
      } else {
        const step = await automationDelete(R)
        expect(step.status).toBe('failed')
        expect(step.error).toMatch(/capture ceiling|tombstone row/i)
      }

      expect(await recordExists(R)).toBe(true)
      expect(await trashRow(R)).toBeUndefined()
      expect(await deleteRevisions(R)).toHaveLength(0)
      expect(await tombstones(R)).toHaveLength(0)
      expect(await edgeAlive(F, N, R)).toBe(true)
    })
  }

  // ── G8 — retention floor extends to side-door anchors ─────────────────────────────────────────────
  test('G8 retention floor: a live side-door trash row pins its tombstone group against an aging sweep', async () => {
    process.env[SIDE_DOOR_FLAG] = 'true'
    process.env[CAPTURE_FLAG] = 'true'
    process.env[INBOUND_FLAG] = 'true'

    // Group 1: plugin-deleted, trash row STAYS live → floor must protect its tombstones even when aged.
    const fx1 = await fixture('g8keep')
    await pluginDelete(fx1.R)
    const anchor1 = (await trashRow(fx1.R))!.delete_revision_id as string
    expect(anchor1).toBeTruthy()

    // Group 2: automation-deleted then RESTORED (trash row gone) → prunable once aged.
    const fx2 = await fixture('g8prune')
    expect((await automationDelete(fx2.R)).status).toBe('success')
    const anchor2 = (await trashRow(fx2.R))!.delete_revision_id as string
    expect((await request(app).post(`/api/multitable/records/${fx2.R}/restore`)).status).toBe(200)

    await q(
      `UPDATE meta_link_tombstones SET created_at = now() - interval '400 days' WHERE source_revision_id IN ($1::uuid, $2::uuid)`,
      [anchor1, anchor2],
    )
    await sweepLinkTombstoneRetention(q as never, RETENTION)

    // Floor holds for a SIDE-DOOR anchor (the floor predicate joins meta_records_trash.delete_revision_id,
    // which D-2 is the first machine-rate writer of).
    expect((await q('SELECT 1 FROM meta_link_tombstones WHERE source_revision_id = $1::uuid', [anchor1])).rows).toHaveLength(1)
    expect((await q('SELECT 1 FROM meta_link_tombstones WHERE source_revision_id = $1::uuid', [anchor2])).rows).toHaveLength(0)

    // …and the protected record is still fully restorable WITH its inbound edge.
    const res = await request(app).post(`/api/multitable/records/${fx1.R}/restore`)
    expect(res.status).toBe(200)
    expect(res.body?.data?.inbound).toMatchObject({ replayed: 1 })
    expect(await edgeAlive(fx1.F, fx1.N, fx1.R)).toBe(true)
  })

  // ── G12 — PIT read-path invariance (§1.7) ─────────────────────────────────────────────────────────
  test('G12 PIT invariance: flag-off vs flag-on produce IDENTICAL reconstructRecordsAtT output (D-2 adds recoverability, never changes history reads)', async () => {
    // Cutoffs are read back from the revisions THEMSELVES (+1µs), never from `new Date()`: Postgres
    // timestamps are microsecond-precision while JS toISOString() truncates to milliseconds, so a
    // wall-clock cutoff can silently fall BEFORE the revision it was meant to follow.
    const cutoffAfter = async (recordId: string, action: 'create' | 'delete'): Promise<string> => {
      const res = await q(
        `SELECT (created_at + interval '1 microsecond')::text AS as_of FROM meta_record_revisions
          WHERE record_id = $1 AND action = $2 ORDER BY created_at DESC, version DESC, id DESC LIMIT 1`,
        [recordId, action],
      )
      expect(res.rows).toHaveLength(1)
      return String((res.rows[0] as { as_of: string }).as_of)
    }

    const probe = async (tag: string, sideDoor: boolean) => {
      if (sideDoor) { process.env[SIDE_DOOR_FLAG] = 'true'; process.env[CAPTURE_FLAG] = 'true' }
      const { R } = await fixture(tag)
      const before = await cutoffAfter(R, 'create')
      await pluginDelete(R)
      const after = await cutoffAfter(R, 'delete')
      const alive = (await reconstructRecordsAtT(q as never, SHEET_A, before, [R])).get(R)
      const dead = (await reconstructRecordsAtT(q as never, SHEET_A, after, [R])).get(R)
      delete process.env[SIDE_DOOR_FLAG]
      delete process.env[CAPTURE_FLAG]
      return {
        aliveExists: alive?.exists, aliveSnapshot: alive?.data,
        deadExists: dead?.exists, deadSnapshot: dead?.data,
      }
    }
    const off = await probe('g12off', false)
    const on = await probe('g12on', true)

    expect(off.aliveExists).toBe(true)
    expect(off.deadExists).toBe(false)
    // Same PIT verdicts either way — the flag moves recoverability, not history.
    expect(on.aliveExists).toBe(off.aliveExists)
    expect(on.deadExists).toBe(off.deadExists)
    expect(on.aliveSnapshot).toEqual({ ...off.aliveSnapshot, title: 'victim g12on' })
  })

  // ── OD-8 — cross-base target semantics ────────────────────────────────────────────────────────────
  test('OD-8 cross-base automation delete: the trash row lands in the TARGET base, not the trigger base', async () => {
    process.env[SIDE_DOOR_FLAG] = 'true'
    const R = mkRecord('od8')
    await insertRecord(SHEET_X, R, { title: 'cross-base victim' }) // lives in BASE_X / SHEET_X
    // Trigger fires on SHEET_A (BASE) but targets SHEET_X (BASE_X) — the full explicit triple.
    const step = await automationDelete(R, {
      config: { targetBaseId: BASE_X, targetSheetId: SHEET_X, targetRecordId: R },
    })
    expect(step.status).toBe('success')

    const trash = await trashRow(R)
    expect(trash).toBeDefined()
    expect(trash!.sheet_id).toBe(SHEET_X)
    expect(trash!.base_id).toBe(BASE_X) // ← target base, where the record actually lived (NOT BASE)
  })

  // ── G10 — the honest write-own consequence (recorded, not fixed) ──────────────────────────────────
  test('G10 own-only visibility: a machine-deleted record with created_by NULL is invisible in trash to a write-own actor, visible to full-write', async () => {
    process.env[SIDE_DOOR_FLAG] = 'true'
    const { R } = await fixture('g10') // created_by NULL (machine-created records carry no author)
    await pluginDelete(R)
    expect(await trashRow(R)).toBeDefined()

    const svc = new RecordService(poolManager.get(), new EventBus())
    const listAs = async (scope: Record<string, unknown>) =>
      svc.listDeletedRecords({
        sheetId: SHEET_A,
        access: { userId: OWNER, permissions: ['multitable:read', 'multitable:write'], isAdminRole: false },
        resolveSheetAccess: (async () => ({
          capabilities: { canDeleteRecord: true },
          sheetScope: scope,
        })) as never,
      } as never)

    // write-own (hasAssignments + canWriteOwn + !canWrite) ⇒ SQL filters `created_by = actor` ⇒ NULL never matches.
    const ownOnly = await listAs({ hasAssignments: true, canWriteOwn: true, canWrite: false })
    expect(ownOnly.records.find((r) => r.recordId === R)).toBeUndefined()
    // Full-write sees it. This asymmetry is DOCUMENTED, not fixed, in D-2 (lock §5).
    const fullWrite = await listAs({ hasAssignments: true, canWriteOwn: true, canWrite: true })
    expect(fullWrite.records.find((r) => r.recordId === R)).toBeDefined()
  })
})
