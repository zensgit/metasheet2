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
import {
  deleteRecord as pluginDeleteRecord,
  MultitableRecordDeleteCapExceededError,
  MultitableSideDoorDeleteNonTransactionalError,
} from '../../src/multitable/records'
import { AutomationService } from '../../src/multitable/automation-service'
// OD-6 (G19): imported the way a PLUGIN AUTHOR would — from the package root, not from the module that
// happens to define them. This import IS the contract under test; if index.ts stops exporting them these
// bindings become undefined and G19 reds.
import {
  MetaSheetServer,
  MultitableRecordDeleteCapExceededError as RootCapExceededError,
  MultitableSideDoorDeleteNonTransactionalError as RootNonTransactionalError,
} from '../../src/index'

/** The slice of the real core API this golden drives (index.ts builds it; we do not re-declare it). */
type CoreApiShape = {
  multitable: {
    records: {
      deleteRecord: (input: { sheetId: string; recordId: string }) => Promise<unknown>
    }
  }
}
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
// G5 gets its OWN sheet: revert-execute is sheet-scoped and would otherwise try to resurrect every other
// golden's deleted record on SHEET_A.
const SHEET_G5 = `sheet_d2_g5_${TS}`
const G5_NAME = `fld_d2_g5name_${TS}`

const SIDE_DOOR_FLAG = 'MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED'
const CAPTURE_FLAG = 'MULTITABLE_TOMBSTONE_CAPTURE_ENABLED'
const CAP_ROWS = 'MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS'
const INBOUND_FLAG = 'MULTITABLE_ENABLE_RECORD_UNDELETE_INBOUND'
const PIT_UNDELETE_FLAG = 'MULTITABLE_ENABLE_PIT_UNDELETE'

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

/**
 * NOTE (trap): `AutomationExecutor.execute` builds its ExecutionContext with `sheetId: rule.sheetId` —
 * it OVERRIDES whatever `sheetId` the caller puts in the context object. So a same-base delete on a
 * non-default sheet must set the sheet on the RULE, not just in the context, or the executor looks for
 * the record in the wrong sheet, finds nothing, and returns the lenient 0-row `success` with no revision.
 */
function deleteRule(config: Record<string, unknown> = {}, sheetId: string = SHEET_A): AutomationRule {
  return {
    id: `axr_d2_${TS}_${Math.random().toString(36).slice(2, 8)}`,
    name: 'D2 delete rule',
    sheetId,
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
  const exec = await makeExecutor().execute(deleteRule(opts.config ?? {}, opts.sheetId ?? SHEET_A), {
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
 * Cutoffs are read back from the revisions THEMSELVES (+1µs), never from `new Date()`: Postgres
 * timestamps are microsecond-precision while JS toISOString() truncates to milliseconds, so a wall-clock
 * cutoff can silently fall BEFORE the revision it was meant to follow.
 */
async function cutoffAfter(recordId: string, action: 'create' | 'delete'): Promise<string> {
  const res = await q(
    `SELECT (created_at + interval '1 microsecond')::text AS as_of FROM meta_record_revisions
      WHERE record_id = $1 AND action = $2 ORDER BY created_at DESC, version DESC, id DESC LIMIT 1`,
    [recordId, action],
  )
  expect(res.rows).toHaveLength(1)
  return String((res.rows[0] as { as_of: string }).as_of)
}

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
    process.env.MULTITABLE_ENABLE_PIT_REVERT = 'true' // W0 step-1: this file drives revert-execute; the gate is default-OFF, set per-file here and restored in afterAll — NEVER enabled globally.
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = { id: OWNER, roles: ['member'], perms: ['multitable:read', 'multitable:write', 'multitable:share'] }
      next()
    })
    process.env.MULTITABLE_SHEET_REVERT_MAX_RECORDS = '50' // G5 drives the PIT revert route
    app.use('/api/multitable', univerMetaRouter())

    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [OWNER])
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1,$2,$3)', [BASE, 'D2 Base', OWNER])
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1,$2,$3)', [BASE_X, 'D2 Base X', OWNER])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_A, BASE, 'D2 A'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_B, BASE, 'D2 B'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_X, BASE_X, 'D2 X'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_G5, BASE, 'D2 G5'])
    // loadSheetAndFields (plugin lane) requires >= 1 field on the victim's sheet.
    for (const sheet of [SHEET_A, SHEET_X]) {
      await q(`INSERT INTO meta_fields (id, sheet_id, name, type, "order") VALUES ($1,$2,'Title','text',0)`, [
        mkField('title'), sheet,
      ])
    }
    // G5's victim needs its data keyed by a REAL field id: the resurrect path refuses to re-insert a
    // schema-drifted snapshot (any snapshot key that is not a live field id ⇒ the record is excluded from
    // the resurrect set), so a `{ title: … }`-shaped fixture would be silently skipped and G5 would prove
    // nothing.
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
      G5_NAME, SHEET_G5, 'Name', 'string', '{}', 0,
    ])
  })

  afterEach(() => {
    delete process.env[SIDE_DOOR_FLAG]
    delete process.env[CAPTURE_FLAG]
    delete process.env[CAP_ROWS]
    delete process.env[INBOUND_FLAG]
    delete process.env[PIT_UNDELETE_FLAG]
  })

  afterAll(async () => {
    delete process.env.MULTITABLE_ENABLE_PIT_REVERT // W0 step-1: restore — never leak the revert gate into sibling files' negative controls.
    for (const flag of [SIDE_DOOR_FLAG, CAPTURE_FLAG, CAP_ROWS, INBOUND_FLAG, PIT_UNDELETE_FLAG]) delete process.env[flag]
    delete process.env.MULTITABLE_SHEET_REVERT_MAX_RECORDS
    await q('DELETE FROM users WHERE id = $1', [OWNER]).catch(() => {})
    for (const sheet of [SHEET_A, SHEET_B, SHEET_X, SHEET_G5]) {
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

  // ── G19 — OD-6: the PUBLIC typed-error contract, imported from the PACKAGE ROOT ───────────────────
  /**
   * OD-6 ratifies a *typed SDK error* — a contract a plugin author can `instanceof`, not a string they
   * must match on `err.code`. That contract lives or dies on the **package-root export**, and it had ZERO
   * coverage: deleting both exports from `src/index.ts` left `tsc` clean and all 47 tests green
   * (re-review P2-2), because every test imported the classes from their defining module instead.
   *
   * So this golden imports them the way a plugin does — from the package root — and throws them for real
   * (a real cap breach; a real non-transactional call). Mutation: remove either export from `index.ts` ⇒
   * the imported binding is `undefined` ⇒ `toBeInstanceOf(undefined)` throws ⇒ RED.
   */
  test('G19 OD-6 public contract: both typed errors are catchable by `instanceof` from the PACKAGE ROOT', async () => {
    process.env[SIDE_DOOR_FLAG] = 'true'
    process.env[CAPTURE_FLAG] = 'true'

    // The two classes must BE classes on the public surface (not undefined, not a re-declared shape).
    expect(typeof RootCapExceededError).toBe('function')
    expect(typeof RootNonTransactionalError).toBe('function')

    // (1) A REAL cap breach: 2 inbound edges against a cap of 1, both flags on.
    process.env[CAP_ROWS] = '1'
    const capFx = await fixture('g19cap')
    const N2 = mkRecord('g19capn2')
    await insertRecord(SHEET_B, N2, { [capFx.F]: [capFx.R] })
    await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [capFx.F, N2, capFx.R])

    await expect(pluginDelete(capFx.R)).rejects.toBeInstanceOf(RootCapExceededError)
    expect(await recordExists(capFx.R)).toBe(true) // fail-closed: refused, not half-captured
    delete process.env[CAP_ROWS]

    // (2) A REAL non-transactional call (the bare pool — no transaction wrapper).
    const txFx = await fixture('g19tx')
    await expect(
      pluginDeleteRecord({ query: q as never, sheetId: SHEET_A, recordId: txFx.R } as never),
    ).rejects.toBeInstanceOf(RootNonTransactionalError)
    expect(await recordExists(txFx.R)).toBe(true)
  })

  // ── G18 — PLUGIN PRODUCTION WIRING, driven for real (OD-7 layer 2 / PROBE-1) ──────────────────────
  /**
   * Drives the ACTUAL plugin-SDK factory in `src/index.ts` — `MetaSheetServer.createCoreAPI()` — not a
   * test re-implementation of it. This is what OD-7 layer 2 demands, and it replaces the structural
   * source-regex guard that used to stand in for it.
   *
   * Why the regex guard had to go (re-review P2-1): it sliced a fixed 1200-char window after the
   * `deleteRecord` key and asserted `poolManager.get().transaction(` appeared somewhere inside. That
   * passed only by POSITIONAL ACCIDENT — `deleteRecord` is currently the last key in the `records`
   * object, so the window spilled into `auth:`, which happens to contain no `transaction(`. Add any
   * transactional sibling after it (e.g. `restoreRecord` — exactly what THIS recoverability line would
   * add next) and the guard goes green with the destructive SDK path in NO transaction at all
   * (reviewer's DEFEAT-1). A behavioral golden cannot be fooled that way: it either commits
   * transactionally or it does not.
   *
   * `pluginDirs: []` is load-bearing — without it the server scans the real plugin dirs and hangs. (My
   * earlier claim that "constructing the server hangs in-process" was simply wrong: three existing unit
   * tests construct it exactly like this and pass in CI.)
   *
   * Acceptance: REDs under PROBE-1 (unwrap the SDK's transaction) AND under DEFEAT-1 (unwrap + add a
   * transactional sibling key after `deleteRecord`).
   */
  test('G18 [plugin] REAL production wiring: index.ts createCoreAPI() SDK deleteRecord is transactional and recoverable', async () => {
    process.env[SIDE_DOOR_FLAG] = 'true'
    process.env[CAPTURE_FLAG] = 'true'
    const { F, R, N } = await fixture('g18')

    // The REAL server → the REAL core API → the REAL SDK surface a plugin is handed.
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    const coreApi = (server as unknown as { createCoreAPI: () => CoreApiShape }).createCoreAPI()
    const sdk = coreApi.multitable.records
    expect(typeof sdk.deleteRecord).toBe('function')

    const deleted = await sdk.deleteRecord({ sheetId: SHEET_A, recordId: R })
    expect(deleted).toBeTruthy()

    // If index.ts's `poolManager.get().transaction(...)` wrapper were gone, the SDK would hand
    // `deleteRecordWithRecoverability` a bare pool query — the OD-7 layer-3 guard would refuse, and this
    // delete would throw instead of completing.
    expect(await recordExists(R)).toBe(false)

    const trash = await trashRow(R)
    expect(trash).toBeDefined()
    const revs = await deleteRevisions(R)
    expect(revs).toHaveLength(1)
    expect(revs[0]!.source).toBe('plugin')
    expect(trash!.delete_revision_id).toBe(revs[0]!.id) // §1.2 anchor, end-to-end through production
    const tombs = await tombstones(R)
    expect(tombs).toHaveLength(1)
    expect(tombs[0]!.source_revision_id).toBe(revs[0]!.id)
    expect(await edgeAlive(F, N, R)).toBe(false)
  })

  // ── G16 — OD-7 LAYER 3: the reordered path REFUSES to run outside a transaction ───────────────────
  /**
   * Layer 3 of the OD-7 contract (owner ruling): G3 proves the sequence is atomic GIVEN a transaction;
   * the production-wiring guard proves the real entry points supply one; THIS pins the runtime refusal
   * that covers everything else — a caller that does not exist yet, or one whose transaction a refactor
   * dropped far away from this file.
   *
   * Non-transactional here is REAL, not simulated: the query fn is the bare pool (`poolManager.query`),
   * so every statement is its own implicit transaction — exactly what a caller gets if the
   * `poolManager.get().transaction` wrapper in `index.ts` (or `deps.transaction` in automation-service)
   * is dropped. Mutation: delete the `assertTransactionalQuery` call in either lane ⇒ the matching case
   * below reds, and reds LOUDLY — the record is destroyed and its links are gone, non-transactionally.
   */
  test('G16 [plugin] OD-7 layer 3: a NON-transactional query is REFUSED (typed) and nothing is written', async () => {
    process.env[SIDE_DOOR_FLAG] = 'true'
    process.env[CAPTURE_FLAG] = 'true'
    const { F, R, N } = await fixture('g16p')

    // The bare pool: each statement its own implicit transaction. NO poolManager.transaction wrapper.
    await expect(
      pluginDeleteRecord({ query: q as never, sheetId: SHEET_A, recordId: R } as never),
    ).rejects.toBeInstanceOf(MultitableSideDoorDeleteNonTransactionalError)

    // Refused BEFORE any write — this is the whole point: without the guard, the links DELETE and the
    // delete revision would COMMIT (no txn to roll them back) and the trash INSERT could then fail,
    // leaving the record alive with both edge directions permanently destroyed.
    expect(await recordExists(R)).toBe(true)
    expect(await trashRow(R)).toBeUndefined()
    expect(await deleteRevisions(R)).toHaveLength(0)
    expect(await tombstones(R)).toHaveLength(0)
    expect(await edgeAlive(F, N, R)).toBe(true)
  })

  test('G16 [automation] OD-7 layer 3: an executor with NO transaction dep is REFUSED — step failed, nothing written', async () => {
    process.env[SIDE_DOOR_FLAG] = 'true'
    process.env[CAPTURE_FLAG] = 'true'
    const { F, R, N } = await fixture('g16a')

    // `withTransaction` SILENTLY falls back to the bare queryFn when `deps.transaction` is absent — the
    // exact shape PROBE-2 produces in production. The guard must catch it.
    const noTxnExecutor = new AutomationExecutor({
      eventBus: new EventBus(),
      queryFn: (sql: string, params?: unknown[]) => q(sql, params),
      crossBaseWriteQuota: { limit: 1000, windowMs: 60_000, store: new MemoryRateLimitStore() },
    } as unknown as AutomationDeps)

    const exec = await noTxnExecutor.execute(deleteRule({}, SHEET_A), {
      recordId: R,
      sheetId: SHEET_A,
      actorId: OWNER,
      data: {},
    } as never)

    expect(exec.steps[0]?.status).toBe('failed')
    expect(exec.steps[0]?.error).toMatch(/TRANSACTIONAL|transaction/i)
    expect(await recordExists(R)).toBe(true)
    expect(await trashRow(R)).toBeUndefined()
    expect(await deleteRevisions(R)).toHaveLength(0)
    expect(await tombstones(R)).toHaveLength(0)
    expect(await edgeAlive(F, N, R)).toBe(true)
  })

  /**
   * Block until a backend is genuinely WAITING on the `meta_records` row lock held by THIS test's
   * holder connection — the deterministic proof that the automation executor's own `FOR UPDATE`
   * (automation-executor.ts:2292-2296) is parked behind ours, NOT a timer. Correlated to the holder's
   * OWN backend pid via `pg_blocking_pids(pid)` — the same technique as
   * `approval-card-delivery-wrapper.db.test.ts`'s `waitUntilBlockedOnInstanceLock` — so an unrelated
   * lock-waiter elsewhere in this shared integration database (many `describeIfDatabase` files share ONE
   * Postgres) can never satisfy the probe. Throws (never silently returns) if it never blocks, so the
   * interleaving golden can never degrade into the sequential case (a vacuous green).
   */
  async function waitUntilBlockedOnRecordLock(blockerPid: number, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const r = await q(
        `SELECT COUNT(*)::int AS c FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND $1 = ANY(pg_blocking_pids(pid))
            AND query ILIKE '%meta_records%'
            AND query ILIKE '%for update%'`,
        [blockerPid],
      )
      if ((r.rows[0] as { c: number }).c >= 1) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error('automation delete_record never blocked on the meta_records row lock HELD BY THIS TEST — interleaving did not occur')
  }

  // ── G17 — automation lock under REAL concurrency (source unchanged; pin the property) ─────────────
  /**
   * The automation lane's lock handling is ALREADY correct — its `FOR UPDATE` selects `locked`/`locked_by`
   * and re-verifies via `ensureRecordNotLocked` on that same result, so it has no TOCTOU window (this is
   * exactly the shape the plugin lane was missing, per the owner's P1). No source change was made here.
   * But "correct today" is not "pinned", so this golden pins it under REAL concurrency — with EXPLICIT
   * barriers instead of fixed sleeps, so the race is deterministic (no false-green on slow CI, no flake):
   *
   * barrier (a) "the lock is actually held": Connection A is a DEDICATED client (not the opaque
   * `poolManager.get().transaction()` wrapper), so every step below is a real awaited round-trip on THIS
   * one connection — by the time the UPDATE resolves, the row lock is PROVABLY held (still uncommitted).
   * No timer needed for this half; sequential await on one connection already IS the barrier.
   *
   * barrier (b) "the deleter has entered its FOR UPDATE": `waitUntilBlockedOnRecordLock` polls
   * `pg_stat_activity`, correlated to A's own backend pid via `pg_blocking_pids`, until Connection B (the
   * executor) is genuinely parked behind A's lock.
   *
   * Only once BOTH barriers are proven does A commit — B then unblocks and must re-read the FRESHLY
   * COMMITTED lock state and refuse. Non-vacuity / positive control: deleting the automation lane's own
   * `ensureRecordNotLocked` re-check (automation-executor.ts:2321-2323) makes this go RED (the locked
   * record is destroyed) — see the task report for both runs.
   */
  test('G17 [automation] lock under real concurrency: a lock committed WHILE the executor blocks on the row still refuses the delete', async () => {
    process.env[SIDE_DOOR_FLAG] = 'true'
    process.env[CAPTURE_FLAG] = 'true'
    const { F, R, N } = await fixture('g17')
    const locker = `u_locker_a_${TS}`

    const hold = await poolManager.get().getInternalPool().connect()
    let step: { status?: string; error?: string } = {}
    try {
      // Connection A: grab the row lock, mark it locked, and HOLD the transaction open.
      await hold.query('BEGIN')
      await hold.query('SELECT id FROM meta_records WHERE id = $1 FOR UPDATE', [R])
      await hold.query('UPDATE meta_records SET locked = true, locked_by = $2 WHERE id = $1', [R, locker])
      // Barrier (a) satisfied here — see comment above.
      const holdPid = Number((await hold.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid)

      // Connection B (the executor): its own `FOR UPDATE` now BLOCKS on A's row lock.
      const running = automationDelete(R)

      // Barrier (b): block until B is deterministically confirmed parked behind A's lock.
      await waitUntilBlockedOnRecordLock(holdPid)

      await hold.query('COMMIT') // A commits ⇒ B unblocks and re-reads the row: locked = true
      step = await running
    } catch (err) {
      await hold.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      hold.release()
    }

    expect(step.status).toBe('failed')
    expect(step.error).toMatch(/locked/i)
    expect(await recordExists(R)).toBe(true)
    expect(await trashRow(R)).toBeUndefined()
    expect(await deleteRevisions(R)).toHaveLength(0)
    expect(await tombstones(R)).toHaveLength(0)
    expect(await edgeAlive(F, N, R)).toBe(true)

    await q('UPDATE meta_records SET locked = false, locked_by = NULL WHERE id = $1', [R])
  })

  // ── G15 — PRODUCTION WIRING, driven for real (owner review item 2 / PROBE-2) ──────────────────────
  /**
   * Every other golden in this file constructs its OWN executor and supplies its OWN `transaction` dep —
   * so they pin the FIXTURE's transactionality, not production's. That is exactly why the reviewer's
   * PROBE-2 (delete `deps.transaction` from `automation-service.ts:840`) left all 39 goldens green.
   *
   * This golden drives the REAL production seam: `new AutomationService(...)` builds its own
   * `AutomationDeps` (automation-service.ts:840 supplies `transaction`) and `.exec` is that executor.
   * Nothing here re-implements the wiring. Combined with the runtime `assertTransactionalQuery`
   * precondition, dropping `deps.transaction` in production source now makes the executor run
   * non-transactionally ⇒ the guard throws ⇒ step `failed` ⇒ THIS TEST REDS.
   *
   * (The plugin lane's production seam — `index.ts`'s SDK factory — cannot be driven the same way: it
   * lives inside `MetaSheetServer.createCoreAPI()`, and constructing the server boots the whole
   * container/plugin stack — it hangs in-process. That lane is covered instead by the structural guard
   * `tests/unit/multitable-d2-sidedoor-txn-wiring.guard.test.ts`, which asserts the transaction wrapper
   * is present in `index.ts` itself, and reds under PROBE-1.)
   */
  test('G15 [automation] REAL production wiring: AutomationService supplies the txn dep — a side-door delete through it is transactional and recoverable', async () => {
    process.env[SIDE_DOOR_FLAG] = 'true'
    process.env[CAPTURE_FLAG] = 'true'
    const { F, R, N } = await fixture('g15')

    // The REAL service — its AutomationDeps (incl. `transaction`) are built by automation-service.ts,
    // not by this test.
    const svc = new AutomationService(new EventBus() as never, {} as never, q as never)
    const exec = await svc.exec.execute(deleteRule({}, SHEET_A), {
      recordId: R,
      sheetId: SHEET_A,
      actorId: OWNER,
      data: {},
    } as never)

    // If the production `transaction` dep were missing, `withTransaction` would silently fall back to a
    // bare queryFn, `assertTransactionalQuery` would refuse, and this step would be `failed`.
    expect(exec.steps[0]?.status).toBe('success')
    expect(await recordExists(R)).toBe(false)

    const trash = await trashRow(R)
    expect(trash).toBeDefined()
    const revs = await deleteRevisions(R)
    expect(revs).toHaveLength(1)
    expect(trash!.delete_revision_id).toBe(revs[0]!.id)
    const tombs = await tombstones(R)
    expect(tombs).toHaveLength(1)
    expect(tombs[0]!.source_revision_id).toBe(revs[0]!.id)
    expect(await edgeAlive(F, N, R)).toBe(false)
  })

  // ── G14 — record-lock TOCTOU under real concurrency (owner review P1) ─────────────────────────────
  /**
   * The plugin lane's lock pre-check (`guardRecordNotLockedForPlugin`, records.ts) is a plain
   * `SELECT locked, locked_by, created_by` with NO `FOR UPDATE` — it holds no row lock. So between the
   * pre-check and the flag-on path's `FOR UPDATE`, a CONCURRENT COMMITTED transaction can lock the
   * record. If the `FOR UPDATE` read does not re-fetch the lock columns and re-verify under the row
   * lock, a LOCKED record gets destroyed (rank-8 violation).
   *
   * This golden reproduces exactly that interleaving: a second connection commits
   * `locked = true` in the window AFTER the pre-check SELECT returns and BEFORE the FOR UPDATE runs.
   * Under READ COMMITTED, the `FOR UPDATE` re-reads the newest committed row version, so the re-check
   * sees the lock — and must refuse. Mutation: delete the `ensureRecordNotLocked` re-check in
   * `deleteRecordWithRecoverability` ⇒ this test goes red (the locked record is deleted).
   */
  test('G14 [plugin] lock TOCTOU: a lock COMMITTED between the pre-check and the FOR UPDATE still refuses the delete', async () => {
    process.env[SIDE_DOOR_FLAG] = 'true'
    process.env[CAPTURE_FLAG] = 'true'
    const { F, R, N } = await fixture('g14')
    const locker = `u_locker_${TS}`

    let injected = false
    const raced = poolManager.get().transaction(async ({ query }) => {
      const racingQuery = (async (sql: string, params?: unknown[]) => {
        const res = await query(sql, params)
        // The pre-check just ran on an UNLOCKED snapshot. Now a DIFFERENT session (a separate pooled
        // connection ⇒ its own transaction, auto-committed) takes the lock — the classic TOCTOU window.
        if (!injected && /SELECT\s+locked,\s*locked_by,\s*created_by\s+FROM\s+meta_records/i.test(sql)) {
          injected = true
          await poolManager
            .get()
            .query('UPDATE meta_records SET locked = true, locked_by = $2 WHERE id = $1', [R, locker])
        }
        return res
      }) as never
      return pluginDeleteRecord({ query: racingQuery, sheetId: SHEET_A, recordId: R } as never)
    })

    await expect(raced).rejects.toThrow(/locked/i)
    expect(injected).toBe(true) // the race really was interleaved (not a vacuous pass)

    // Nothing destroyed: the whole flag-on unit refused before its first write.
    expect(await recordExists(R)).toBe(true)
    expect(await trashRow(R)).toBeUndefined()
    expect(await deleteRevisions(R)).toHaveLength(0)
    expect(await tombstones(R)).toHaveLength(0)
    expect(await edgeAlive(F, N, R)).toBe(true)

    await q('UPDATE meta_records SET locked = false, locked_by = NULL WHERE id = $1', [R])
  })

  // ── G5 — PIT-resurrect equivalence (the SECOND resurrection surface) ──────────────────────────────
  /**
   * G4 covers `restoreRecord` (the recycle-bin surface, anchored on `meta_records_trash.delete_revision_id`).
   * The PIT revert route is a SECOND, INDEPENDENT resurrection surface: it has no trash row to read, so it
   * DERIVES the anchor from the revert's `asOf` T — "the removing deletion is the first `action='delete'`
   * revision strictly AFTER T" (univer-meta.ts:10196-10201, R11 A′). The lock demanded this be PROVEN, not
   * assumed, and the reason is now concrete: that anchor query selects on `action='delete' AND created_at > T`
   * and does NOT filter on `source` — so a side-door (`source:'automation'`/`'plugin'`) delete revision is
   * eligible as an anchor, and because D-2 PRE-GENERATES that revision's id, the tombstones it captured hang
   * off exactly that id. If either half were untrue (a `source` filter, or a self-generated revision id) the
   * resurrect surface would silently replay NOTHING for machine-deleted records while reporting success.
   *
   * NOTE: the D-2 lock §3 describes this as "the :10183 latest-delete-revision heuristic". That description
   * is STALE — the heuristic was replaced by the T-derived anchor (R11 A′, ratified 2026-07-11) after the
   * lock was drafted. The obligation is unchanged and is discharged against the anchor as it ACTUALLY is.
   */
  test('G5 PIT-resurrect equivalence [automation]: the revert surface anchors to the SIDE-DOOR delete revision and replays ITS captured inbound vintage', async () => {
    process.env[SIDE_DOOR_FLAG] = 'true'
    process.env[CAPTURE_FLAG] = 'true'
    process.env[PIT_UNDELETE_FLAG] = 'true'
    process.env[INBOUND_FLAG] = 'true'

    const F = mkField('g5') // link field lives on the NEIGHBOUR's sheet (cross-sheet by construction)
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
      F, SHEET_B, F, 'link', '{}', seq,
    ])
    const R = mkRecord('g5r')
    await insertRecord(SHEET_G5, R, { [G5_NAME]: 'g5 victim' }) // data keyed by a REAL field id (see beforeAll)
    const N = mkRecord('g5n')
    await insertRecord(SHEET_B, N, { [F]: [R] })
    await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [F, N, R])

    // T must be a CLEAN millisecond boundary: the revert route round-trips `asOf` through
    // `new Date(asOf).toISOString()`, which TRUNCATES to milliseconds — a microsecond-precision cutoff
    // (the `cutoffAfter` trick the PIT goldens use) would be silently rounded DOWN, dropping the create
    // revision out of `created_at <= T` and leaving the record "absent at T" ⇒ not a resurrect candidate
    // ⇒ empty preview. So backdate the create revision and pick T strictly between it and the delete.
    const T_CREATE = '2026-01-01T00:00:00.000Z'
    const T_ASOF = '2026-01-02T00:00:00.000Z' // R is ALIVE at T; the side-door delete lands at now() > T
    await q(`UPDATE meta_record_revisions SET created_at = $1 WHERE record_id = $2 AND action = 'create'`, [T_CREATE, R])
    const asOf = T_ASOF

    // …then the SIDE DOOR destroys it: D-1 revision (source:'automation') + D-2 trash + D-2 tombstone.
    expect((await automationDelete(R, { sheetId: SHEET_G5 })).status).toBe('success')
    const revs = await deleteRevisions(R)
    expect(revs).toHaveLength(1)
    expect(revs[0]!.source).toBe('automation')
    const anchor = revs[0]!.id
    const tombs = await tombstones(R)
    expect(tombs).toHaveLength(1)
    expect(tombs[0]!.source_revision_id).toBe(anchor) // the captured vintage hangs off the side-door revision
    expect(await edgeAlive(F, N, R)).toBe(false)

    // Resurrect through the PIT revert route (NOT restoreRecord — the other surface entirely).
    const prev = await request(app).post(`/api/multitable/sheets/${SHEET_G5}/revert-preview`).send({ asOf })
    expect(prev.status).toBe(200)
    const identity = prev.body?.data?.previewIdentity ?? prev.body?.previewIdentity
    expect(identity).toBeTruthy()

    const exec = await request(app)
      .post(`/api/multitable/sheets/${SHEET_G5}/revert-execute`)
      .send({ asOf, previewIdentity: identity, confirm: 'undelete' })
    expect(exec.status).toBe(200)

    // The payoff: the record is back AND its inbound edge was replayed from tombstones captured by a
    // MACHINE delete — the D-2 anchor is what made the second resurrection surface reach them.
    const inbound = exec.body?.data?.undeleteInbound ?? exec.body?.undeleteInbound
    expect(inbound).toMatchObject({ replayed: 1 })
    expect(await recordExists(R)).toBe(true)
    expect(await edgeAlive(F, N, R)).toBe(true)
  })

  // ── flag-on missing-record contract ───────────────────────────────────────────────────────────────
  test('flag-ON plugin delete of a missing record still throws NotFound and writes NOTHING (no trash, no revision)', async () => {
    process.env[SIDE_DOOR_FLAG] = 'true'
    const ghost = mkRecord('ghost')
    await expect(pluginDelete(ghost)).rejects.toThrow(/not found/i)
    expect(await trashRow(ghost)).toBeUndefined()
    expect(await deleteRevisions(ghost)).toHaveLength(0)
  })

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
