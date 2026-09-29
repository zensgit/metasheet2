/**
 * Field retype slice 3a — real-Postgres race cases for the post-fence field-schema re-check (design lock
 * docs/development/multitable-field-retype-first-batch-adr-20260926.md §3.11, acceptance ⑦ / ⑫ shape).
 *
 * This is a CASES MODULE, not a test file: `defineFieldSchemaFenceRecheckRealDbCases()` registers one `describe`
 * block and is called from an already-wired real-DB host (tests/integration/multitable-l4-canonical-fence-realdb.test.ts,
 * listed in the "Run multitable real-DB integration" step of .github/workflows/plugin-tests.yml), so the cases run in
 * CI without a new lane file. Do NOT also list this module in that step.
 *
 * THE RACE, constructed (two dedicated connections + pg_blocking_pids, never a timer — same technique as the host's R1):
 *   B (standing in for a field type conversion) BEGINs, takes the canonical sheet fence, and UPDATEs the field's type to
 *     `select` — uncommitted.
 *   A is the PRODUCTION writer under test. It takes its field snapshot (committed state: `string`), validates the value
 *     `'B '` against it (valid for a string field), and parks on the fence. `waitUntilParkedOnFence` THROWS if A never
 *     parks, so the race cannot degrade into the sequential case.
 *   B commits. A acquires the fence and continues.
 * With MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT='true' every wired writer refuses (409 FIELD_SCHEMA_CHANGED / step
 * failed / derived merge skipped) and `meta_records` is untouched. With the flag OFF the same race lands `'B '` in what
 * is now a select column — the bug this slice closes, and the proof that the change is inert until the flag is on.
 * Rows covered: 1 (RecordWriteService.patchRecords), 2 / 3 (plugin SDK patch / create through a warmed request-scoped
 * metadata cache — the only way their snapshot predates the fence), 4 (RecordService.patchRecord), 5 (form submit over
 * the real router), 6 (automation update_record through AutomationService's own executor wiring), 7 (approval
 * resultWriteback), 13 (non-scoped derived merge, formula → string).
 *
 * Fail-not-skip: in the real-DB step (METASHEET_REAL_DB_TEST_STEP=1) a missing DATABASE_URL throws from a top-level
 * test OUTSIDE the DB-gated describe.
 */
import { EventEmitter } from 'events'

import express, { type Express, type Request } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { EventBus } from '../../src/integration/events/event-bus'
import { AutomationService } from '../../src/multitable/automation-service'
import { __resetRecoveryWriterStateColumnProbe, canonicalSheetFenceKey } from '../../src/multitable/canonical-sheet-fence'
import { applyFencedDerivedDataMerge } from '../../src/multitable/derived-write-fence'
import {
  DerivedMergeTargetRetypedError,
  FIELD_SCHEMA_FENCE_RECHECK_SQL,
  FieldSchemaChangedError,
} from '../../src/multitable/field-schema-fence-recheck'
import { loadFieldsForSheet } from '../../src/multitable/loaders'
import { RecordService } from '../../src/multitable/record-service'
import { RecordWriteService, type RecordPatchInput } from '../../src/multitable/record-write-service'
import { createRecord as pluginCreateRecord, patchRecord as pluginPatchRecord } from '../../src/multitable/records'
import {
  getMultitableRequestMetadataCache,
  runWithMultitableRequestMetadataCache,
} from '../../src/multitable/request-metadata-cache'
import { deriveCapabilities, type AccessInfo } from '../../src/multitable/sheet-capabilities'
import { createRecordWriteHelpers, univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const CONVERT_FLAG = 'MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT'
const FENCE_FLAG = 'MULTITABLE_ENABLE_WRITER_FENCE'
const CACHE_FLAG = 'MULTITABLE_ENABLE_REQUEST_METADATA_CACHE'
const FLAGS = [CONVERT_FLAG, FENCE_FLAG, CACHE_FLAG]

const TS = Date.now()
const BASE = `base_fsr_${TS}`
const SHEET = `sheet_fsr_${TS}`
const VIEW = `view_fsr_${TS}`
const F_STR = `fld_fsr_str_${TS}`
const F_FORMULA = `fld_fsr_fx_${TS}`
const ACTOR = `u_fsr_actor_${TS}`
const STALE = 'B ' // valid for `string`, not an option of the `select` B commits
const SELECT_PROPERTY = { options: [{ value: 'X' }] }

let seq = 0
const mkRecord = (tag: string) => `rec_fsr_${tag}_${TS}_${seq++}`

const access: AccessInfo = { userId: ACTOR, permissions: ['multitable:read', 'multitable:write'], isAdminRole: false }
const capabilities = deriveCapabilities(['multitable:read', 'multitable:write'], false)
const emitter = new EventEmitter() as unknown as ConstructorParameters<typeof RecordService>[1]

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown }

async function recordData(id: string): Promise<Record<string, unknown> | undefined> {
  return ((await q('SELECT data FROM meta_records WHERE id = $1', [id])).rows[0] as { data: Record<string, unknown> } | undefined)?.data
}
async function recordCount(): Promise<number> {
  return ((await q('SELECT count(*)::int AS n FROM meta_records WHERE sheet_id = $1', [SHEET])).rows[0] as { n: number }).n
}
async function seedRecord(id: string, data: Record<string, unknown> = { [F_STR]: 'orig' }): Promise<void> {
  await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [id, SHEET, JSON.stringify(data), ACTOR])
}
async function resetFields(): Promise<void> {
  await q("UPDATE meta_fields SET type = 'string', property = '{}'::jsonb WHERE id = $1", [F_STR])
  await q("UPDATE meta_fields SET type = 'formula', property = $2::jsonb WHERE id = $1", [F_FORMULA, JSON.stringify({ expression: '=1+1' })])
}

/** A is parked on the canonical fence B holds — proven via pg_blocking_pids; throws if it never happens. */
async function waitUntilParkedOnFence(blockerPid: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await q(
      `SELECT COUNT(*)::int AS c FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND $1 = ANY(pg_blocking_pids(pid))
          AND query ILIKE '%pg_advisory_xact_lock%'`,
      [blockerPid],
    )
    if ((r.rows[0] as { c: number }).c >= 1) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('the writer never parked on the canonical fence held by the retyping session — the race did not occur')
}

/**
 * B: fence + retype `fieldId` (uncommitted); start A; prove A parked on the fence; commit B; return A's outcome.
 * A's own snapshot therefore predates the retype, and its post-fence statements see it.
 */
async function raceRetype(fieldId: string, toType: string, toProperty: Record<string, unknown>, writer: () => Promise<unknown>): Promise<Outcome> {
  const b = await poolManager.get().getInternalPool().connect()
  let aRun: Promise<Outcome> | null = null
  try {
    await b.query('BEGIN')
    const bPid = Number((await b.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid)
    await b.query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(SHEET)])
    await b.query('UPDATE meta_fields SET type = $2, property = $3::jsonb WHERE id = $1', [fieldId, toType, JSON.stringify(toProperty)])
    aRun = writer().then((value): Outcome => ({ ok: true, value }), (error): Outcome => ({ ok: false, error }))
    await waitUntilParkedOnFence(bPid)
    await b.query('COMMIT')
    return await aRun
  } catch (e) {
    await b.query('ROLLBACK').catch(() => {})
    if (aRun) await aRun
    throw e
  } finally {
    b.release()
  }
}

// ── the writers, each through production code ─────────────────────────────────────────────────────────────

const writeService = () => {
  const fakeReq = { user: { id: ACTOR, roles: [], perms: ['multitable:read', 'multitable:write'] } } as unknown as Request
  const pool = poolManager.get() as unknown as ConstructorParameters<typeof RecordWriteService>[0]
  return new RecordWriteService(pool, emitter as never, createRecordWriteHelpers(fakeReq, pool as never))
}

const stringField = { id: F_STR, name: 'Note', type: 'string', property: {}, order: 1 }

const row1 = (recordId: string) => () => writeService().patchRecords({
  sheetId: SHEET,
  changesByRecord: new Map([[recordId, [{ fieldId: F_STR, value: STALE }]]]),
  actorId: ACTOR,
  fields: [stringField],
  visiblePropertyFields: [stringField],
  visiblePropertyFieldIds: new Set([F_STR]),
  attachmentFields: [],
  fieldById: new Map([[F_STR, { type: 'string', readOnly: false, hidden: false }]]),
  capabilities,
  access,
} as unknown as RecordPatchInput)

/** Plugin SDK inside a request-scoped metadata scope whose field cache is warmed BEFORE the fence (the row 2 / 3 hazard). */
const inWarmCache = (write: (query: never) => Promise<unknown>) => () =>
  runWithMultitableRequestMetadataCache(async () => {
    await loadFieldsForSheet(q as never, SHEET, getMultitableRequestMetadataCache()!.fields)
    return poolManager.get().transaction(async ({ query }) => write(query as never))
  })

const row2 = (recordId: string) => inWarmCache((query) => pluginPatchRecord({ query, sheetId: SHEET, recordId, changes: { [F_STR]: STALE } }))
const row3 = () => inWarmCache((query) => pluginCreateRecord({ query, sheetId: SHEET, data: { [F_STR]: STALE } }))

const row4 = (recordId: string) => () =>
  new RecordService(poolManager.get() as unknown as ConstructorParameters<typeof RecordService>[0], emitter)
    .patchRecord({ recordId, sheetId: SHEET, data: { [F_STR]: STALE }, actorId: ACTOR, access, capabilities })

let app: Express
const MEMBER = { id: ACTOR, roles: ['member'], perms: ['multitable:read', 'multitable:write', 'multitable:share', 'multitable:manage-schema'] }
const row5 = () => () => new Promise<request.Response>((resolve, reject) => {
  request(app).post(`/api/multitable/views/${VIEW}/submit`).send({ data: { [F_STR]: STALE } })
    .end((err, res) => (err ? reject(err) : resolve(res)))
})

type ServiceInternals = {
  executor: { execute(rule: unknown, trigger: unknown): Promise<{ steps: Array<{ status: string; error?: string }> }> }
  writeApprovalResultBack(bridge: unknown, config: Record<string, unknown>, event: unknown): Promise<unknown>
}
const automationService = () => new AutomationService(new EventBus(), {} as never, q as never) as unknown as ServiceInternals

const row6 = (recordId: string) => () => automationService().executor.execute(
  {
    id: `rule_fsr_${TS}`, name: 'fsr', sheetId: SHEET, trigger: { type: 'record.created', config: {} },
    actions: [{ type: 'update_record', config: { fields: { [F_STR]: STALE } } }],
    enabled: true, createdBy: ACTOR, createdAt: '2026-09-28T00:00:00Z',
  },
  { recordId, sheetId: SHEET, actorId: ACTOR, data: {} },
)

const row7 = (recordId: string) => () => automationService().writeApprovalResultBack(
  { id: `aab_fsr_${TS}`, sheetId: SHEET, recordId, triggerEvent: { actorId: ACTOR, recordId, _automationDepth: 0 } },
  { templateId: 'tpl_fsr', resultWriteback: { statusField: F_STR } },
  {
    version: 1, source: 'approval-product', eventType: 'approval.approved', eventId: `evt_fsr_${TS}`,
    occurredAt: '2026-09-28T00:00:00.000Z',
    approval: { instanceId: 'ai_fsr', requestNo: 'R-1', templateId: 'tpl_fsr', publishedDefinitionId: 'pd_fsr' },
    transition: { toStatus: 'approved' }, actor: { id: ACTOR }, requester: { id: ACTOR },
  },
)

const row13 = (recordId: string) => () => applyFencedDerivedDataMerge(q as never, SHEET, recordId, { [F_FORMULA]: 2 })

export function defineFieldSchemaFenceRecheckRealDbCases(): void {
  test('field-schema fence re-check real-DB sentinel: the real-DB step must have DATABASE_URL (fail-not-skip)', () => {
    if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
      throw new Error('METASHEET_REAL_DB_TEST_STEP=1 but DATABASE_URL is unset — the field-schema re-check real-DB cases would skip-green')
    }
    expect(FIELD_SCHEMA_FENCE_RECHECK_SQL).toMatch(/FOR SHARE$/)
  })

  describeIfDatabase('field retype slice 3a — fenced writers re-check the field schema after the fence (real DB)', () => {
    beforeAll(async () => {
      app = express()
      app.use(express.json())
      app.use((req, _res, next) => { ;(req as { user?: typeof MEMBER }).user = MEMBER; next() })
      app.use('/api/multitable', univerMetaRouter())
      await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
      await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'FSR Base'])
      await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'FSR Sheet'])
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_STR, SHEET, 'Note', 'string', '{}', 1])
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_FORMULA, SHEET, 'Fx', 'formula', JSON.stringify({ expression: '=1+1' }), 2])
      await q(
        `INSERT INTO meta_views (id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config)
         VALUES ($1,$2,$3,'grid','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'[]'::jsonb,'{}'::jsonb)`,
        [VIEW, SHEET, 'FSR View'],
      )
    })

    beforeEach(async () => {
      __resetRecoveryWriterStateColumnProbe()
      for (const f of FLAGS) delete process.env[f]
      process.env[FENCE_FLAG] = 'true' // execute / undo require the writer fence (ADR §3 gate 2); the race needs it
      await resetFields()
    })

    afterEach(async () => {
      for (const f of FLAGS) delete process.env[f]
      await resetFields().catch(() => {})
    })

    afterAll(async () => {
      for (const f of FLAGS) delete process.env[f]
      await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {})
      await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET]).catch(() => {})
      await q('DELETE FROM meta_views WHERE sheet_id = $1', [SHEET]).catch(() => {})
      await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
      await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
      await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
    })

    // ── patch-shaped writers: the record exists, only its F_STR cell may change ──
    const PATCHERS: Array<[string, (recordId: string) => () => Promise<unknown>, boolean]> = [
      ['row 1 RecordWriteService.patchRecords', row1, false],
      ['row 2 plugin SDK patchRecord (warm request cache)', row2, true],
      ['row 4 RecordService.patchRecord', row4, false],
      ['row 6 automation update_record', row6, false],
      ['row 7 approval resultWriteback', row7, false],
    ]

    for (const [name, writer, needsCache] of PATCHERS) {
      test(`${name}: a retype committed while the writer waited on the fence ⇒ refused, the cell is untouched`, async () => {
        const R = mkRecord('p')
        await seedRecord(R)
        process.env[CONVERT_FLAG] = 'true'
        if (needsCache) process.env[CACHE_FLAG] = 'true'
        const outcome = await raceRetype(F_STR, 'select', SELECT_PROPERTY, writer(R))
        if (name.startsWith('row 6')) {
          expect(outcome.ok).toBe(true)
          const steps = (outcome as { value: { steps: Array<{ status: string; error?: string }> } }).value.steps
          expect(steps[0]?.status).toBe('failed')
          expect(steps[0]?.error).toBe(new FieldSchemaChangedError().message)
        } else {
          expect(outcome.ok).toBe(false)
          expect((outcome as { error: unknown }).error).toBeInstanceOf(FieldSchemaChangedError)
        }
        expect(await recordData(R)).toEqual({ [F_STR]: 'orig' })
      })

      test(`${name}: CONTROL, convert flag OFF ⇒ the same race lands the stale value in the select column (inert, and the bug)`, async () => {
        const R = mkRecord('c')
        await seedRecord(R)
        if (needsCache) process.env[CACHE_FLAG] = 'true'
        const outcome = await raceRetype(F_STR, 'select', SELECT_PROPERTY, writer(R))
        expect(outcome.ok, String((outcome as { error?: unknown }).error ?? '')).toBe(true)
        const expected = name.startsWith('row 7') ? 'approved' : STALE
        expect((await recordData(R))?.[F_STR]).toBe(expected)
      })
    }

    // ── create-shaped writers ──
    test('row 3 plugin SDK createRecord (warm request cache): retype during the wait ⇒ refused, no record inserted', async () => {
      process.env[CONVERT_FLAG] = 'true'
      process.env[CACHE_FLAG] = 'true'
      const before = await recordCount()
      const outcome = await raceRetype(F_STR, 'select', SELECT_PROPERTY, row3())
      expect(outcome.ok).toBe(false)
      expect((outcome as { error: unknown }).error).toBeInstanceOf(FieldSchemaChangedError)
      expect(await recordCount()).toBe(before)
    })

    test('row 3 CONTROL, convert flag OFF ⇒ the record is inserted with the stale value', async () => {
      process.env[CACHE_FLAG] = 'true'
      const before = await recordCount()
      const outcome = await raceRetype(F_STR, 'select', SELECT_PROPERTY, row3())
      expect(outcome.ok, String((outcome as { error?: unknown }).error ?? '')).toBe(true)
      expect(await recordCount()).toBe(before + 1)
    })

    test('row 5 form submit CREATE over the real router: retype during the wait ⇒ 409 FIELD_SCHEMA_CHANGED, no record', async () => {
      process.env[CONVERT_FLAG] = 'true'
      const before = await recordCount()
      const outcome = await raceRetype(F_STR, 'select', SELECT_PROPERTY, row5())
      expect(outcome.ok).toBe(true)
      const res = (outcome as { value: request.Response }).value
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('FIELD_SCHEMA_CHANGED')
      expect(await recordCount()).toBe(before)
    })

    test('row 5 CONTROL, convert flag OFF ⇒ 200 and the record is inserted', async () => {
      const before = await recordCount()
      const outcome = await raceRetype(F_STR, 'select', SELECT_PROPERTY, row5())
      const res = (outcome as { value: request.Response }).value
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(await recordCount()).toBe(before + 1)
    })

    // ── row 13: the derived merge (formula → string while the merge waited) ──
    test('row 13 non-scoped derived merge: the formula target retyped during the wait ⇒ skipped (SheetWriterBlockedError subclass), no write', async () => {
      const R = mkRecord('d')
      await seedRecord(R, { [F_STR]: 'orig' })
      process.env[CONVERT_FLAG] = 'true'
      const outcome = await raceRetype(F_FORMULA, 'string', {}, row13(R))
      expect(outcome.ok).toBe(false)
      expect((outcome as { error: unknown }).error).toBeInstanceOf(DerivedMergeTargetRetypedError)
      expect(await recordData(R)).toEqual({ [F_STR]: 'orig' })
    })

    test('row 13 CONTROL, convert flag OFF ⇒ the merge writes the formula value into what is now a string column', async () => {
      const R = mkRecord('dc')
      await seedRecord(R, { [F_STR]: 'orig' })
      const outcome = await raceRetype(F_FORMULA, 'string', {}, row13(R))
      expect(outcome.ok, String((outcome as { error?: unknown }).error ?? '')).toBe(true)
      expect((await recordData(R))?.[F_FORMULA]).toBe(2)
    })

    // ── R-F2 (fix round): the realtime (Yjs) bridge's snapshot is built from RAW rows ──
    // Fields stored with raw alias types and plain-string options exist in practice (provisioning stores descriptor
    // types verbatim; the approval projection writes 'text'). With both flags on and NOTHING changing, a write through
    // a realtime-shaped guard must land — before the fix every such write was refused FIELD_SCHEMA_CHANGED.
    test('R-F2 realtime-shaped guard: raw text / longtext / checkbox / plain-string select, both flags on, no change ⇒ the write lands', async () => {
      process.env[CONVERT_FLAG] = 'true'
      const extra = [
        { id: `fld_fsr_rawtext_${TS}`, type: 'text', property: {}, value: 'hello' },
        { id: `fld_fsr_rawlong_${TS}`, type: 'longtext', property: {}, value: 'hi' },
        { id: `fld_fsr_rawbool_${TS}`, type: 'checkbox', property: {}, value: true },
        { id: `fld_fsr_rawsel_${TS}`, type: 'select', property: { options: ['A', 'B'] }, value: 'A' },
      ]
      const R = mkRecord('rt')
      try {
        for (const [i, f] of extra.entries()) {
          await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [f.id, SHEET, `Raw ${i}`, f.type, JSON.stringify(f.property), 10 + i])
        }
        await seedRecord(R)
        // The guard exactly as src/index.ts's realtime bridge builds it (raw type, raw property, lenient options);
        // the unit file carries a tripwire on that source shape.
        const rows = (await q('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC', [SHEET])).rows as Array<{ id: string; type: string; property: unknown }>
        const fieldById = new Map(rows.map((f) => {
          const prop = (f.property && typeof f.property === 'object' ? f.property : {}) as Record<string, unknown>
          const guard: Record<string, unknown> = { type: f.type, readOnly: false, hidden: false, property: prop }
          if ((f.type === 'select' || f.type === 'multiSelect') && Array.isArray(prop.options)) {
            guard.options = (prop.options as unknown[]).map((o) => (typeof o === 'string' ? o : (o as { value?: unknown })?.value ?? ''))
          }
          return [f.id, guard] as const
        }))
        const fields = rows.map((f) => ({ id: f.id, name: f.id, type: f.type, property: f.property, order: 0 }))
        await writeService().patchRecords({
          sheetId: SHEET,
          changesByRecord: new Map([[R, extra.map((f) => ({ fieldId: f.id, value: f.value }))]]),
          actorId: ACTOR,
          fields,
          visiblePropertyFields: fields,
          visiblePropertyFieldIds: new Set(rows.map((f) => f.id)),
          attachmentFields: [],
          fieldById,
          capabilities,
          access,
        } as unknown as RecordPatchInput)
        const data = await recordData(R)
        for (const f of extra) expect(data?.[f.id], f.type).toEqual(f.value)
      } finally {
        await q('DELETE FROM meta_fields WHERE id = ANY($1::text[])', [extra.map((f) => f.id)]).catch(() => {})
      }
    })

    // ── R-F1 (fix round): convert ON + writer fence OFF must not close a lock cycle with a schema edit ──
    //
    // The cycle the verifier reproduced three times (DL-A shape): writer W holds the canonical fence (plugin create
    // takes it unconditionally), schema edit P locks the `meta_fields` row (PATCH /fields updates it first) and then
    // asks for the fence (its auto-number backfill takes it unconditionally). If W then asks for `FOR SHARE` on that
    // field row, each waits for the other: PostgreSQL answers 40P01 on one side. With the writer fence off no
    // conversion can run (execute refuses), so the re-check must not run — the gate is both flags.
    // Short lock_timeout on both sessions: a regression fails in seconds instead of hanging the step.
    async function schemaEditParkedOnFence(): Promise<{ p: import('pg').PoolClient; pDone: Promise<Outcome> }> {
      const p = await poolManager.get().getInternalPool().connect()
      await p.query('BEGIN')
      await p.query("SET LOCAL lock_timeout = '6s'")
      await p.query('UPDATE meta_fields SET property = property WHERE id = $1', [F_STR]) // PATCH /fields: field row first
      const pDone = p.query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(SHEET)]) // then the fence
        .then((value): Outcome => ({ ok: true, value }), (error): Outcome => ({ ok: false, error }))
      return { p, pDone }
    }
    const sqlState = (o: Outcome) => (o.ok ? null : String(((o as { error: unknown }).error as { code?: unknown }).code ?? 'unknown'))

    test('R-F1 CONTROL (the cycle exists): the re-check statement issued after the fence, with the fence flag off, deadlocks with a schema edit', async () => {
      const w = await poolManager.get().getInternalPool().connect()
      let p: import('pg').PoolClient | null = null
      try {
        await w.query('BEGIN')
        await w.query("SET LOCAL lock_timeout = '6s'")
        const wPid = Number((await w.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid)
        await w.query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(SHEET)]) // W holds the fence
        const parked = await schemaEditParkedOnFence()
        p = parked.p
        await waitUntilParkedOnFence(wPid)
        const wDone = w.query(FIELD_SCHEMA_FENCE_RECHECK_SQL, [SHEET, [F_STR]]) // what an ungated helper would issue
          .then((value): Outcome => ({ ok: true, value }), (error): Outcome => ({ ok: false, error }))
        const [wOut, pOut] = await Promise.all([wDone, parked.pDone])
        expect([sqlState(wOut), sqlState(pOut)]).toContain('40P01')
      } finally {
        await w.query('ROLLBACK').catch(() => {})
        w.release()
        if (p) {
          await p.query('ROLLBACK').catch(() => {})
          p.release()
        }
      }
    })

    test('R-F1: convert ON + writer fence OFF — the real plugin createRecord holding the fence does NOT deadlock with a schema edit', async () => {
      delete process.env[FENCE_FLAG]
      process.env[CONVERT_FLAG] = 'true'
      const before = await recordCount()
      const w = await poolManager.get().getInternalPool().connect()
      let p: import('pg').PoolClient | null = null
      let release!: () => void
      const gateOpen = new Promise<void>((resolve) => { release = resolve })
      let pausedOnce = false
      try {
        await w.query('BEGIN')
        await w.query("SET LOCAL lock_timeout = '6s'")
        const wPid = Number((await w.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid)
        // Pause the production writer right after it acquired the fence, so the schema edit can park behind it.
        const wQuery = async (sql: string, params?: unknown[]) => {
          const result = await w.query(sql, params)
          if (!pausedOnce && /pg_advisory_xact_lock/i.test(sql)) {
            pausedOnce = true
            await gateOpen
          }
          return result
        }
        const wDone = pluginCreateRecord({ query: wQuery as never, sheetId: SHEET, data: { [F_STR]: 'x' } })
          .then(async (value): Promise<Outcome> => { await w.query('COMMIT'); return { ok: true, value } }, (error): Outcome => ({ ok: false, error }))
        while (!pausedOnce) await new Promise((resolve) => setTimeout(resolve, 10))
        const parked = await schemaEditParkedOnFence()
        p = parked.p
        await waitUntilParkedOnFence(wPid)
        release()
        const [wOut, pOut] = await Promise.all([wDone, parked.pDone])
        expect(sqlState(wOut), String((wOut as { error?: unknown }).error ?? '')).toBeNull()
        expect(sqlState(pOut), String((pOut as { error?: unknown }).error ?? '')).toBeNull()
        await p.query('ROLLBACK')
        expect(await recordCount()).toBe(before + 1)
      } finally {
        release()
        await w.query('ROLLBACK').catch(() => {})
        w.release()
        if (p) {
          await p.query('ROLLBACK').catch(() => {})
          p.release()
        }
      }
    })
  })
}
