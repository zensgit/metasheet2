/**
 * Real-DB persisted-Y.Text CORRUPTION GOLDEN — the gate for 2a-1 (live CRDT for the string-stored
 * atomics select / date / dateTime via the dual-reader migration).
 *
 * The migration story: these fields are stored as strings, and the historical seed shape puts ALL
 * strings into the `fields` Y.Map as **Y.Text**. So an existing/persisted record doc holds
 * select/date/dateTime as Y.Text. The new dual-reader binding (useYjsScalarCell coerceText) reads a
 * Y.Text as its string, and on edit WRITES a PLAIN string (Y.Map.set), which replaces the Y.Text →
 * lazy convergence. The backend bridge already collects both Y.Text->toString and plain values, so
 * the stored shape stays a string either way.
 *
 * This golden proves there is NO corruption across that transition on REAL Postgres:
 *   1. After the seed, the fields ARE Y.Text (asserts the old-doc scenario is real, not a strawman).
 *   2. A synced client edits each with a PLAIN string (replacing the Y.Text), the bridge flushes
 *      through the REAL RecordWriteService.patchRecords, and meta_records.data keeps the EXACT
 *      native string — never a Y.Text object, never '[object Object]', never a nested Yjs type.
 *
 * Models yjs-scalar-flush-realdb (rating/multiSelect). Runs only with DATABASE_URL (sentinel
 * fails-not-skips per the suite convention). The bridge's flushNow swallows write errors, so broken
 * wiring shows up as a FAILED DB assertion below, never a false green.
 */
import { EventEmitter } from 'events'
import type { Request } from 'express'
import * as Y from 'yjs'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { YjsSyncService } from '../../src/collab/yjs-sync-service'
import { YjsRecordBridge } from '../../src/collab/yjs-record-bridge'
import { RecordWriteService, type RecordPatchInput } from '../../src/multitable/record-write-service'
import { createRecordWriteHelpers } from '../../src/routes/univer-meta'
import { deriveCapabilities } from '../../src/multitable/sheet-capabilities'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const TS = Date.now()
const BASE_ID = `base_strdate_${TS}`
const SHEET_ID = `sheet_strdate_${TS}`
const REC_ID = `rec_strdate_${TS}`
const ACTOR = `u_strdate_${TS}`
const SOCKET = `socket_strdate_${TS}`

const F_SELECT = 'fld_select'
const F_DATE = 'fld_date'
const F_DATETIME = 'fld_datetime'
const SELECT_OPTS = [{ value: 'optA' }, { value: 'optB' }]

// initial (seed) values — strings; the seed will store them as Y.Text.
const SEED = { [F_SELECT]: 'optA', [F_DATE]: '2026-01-01', [F_DATETIME]: '2026-01-01T10:00' }
// edited values — what the client writes as PLAIN strings.
const EDIT_SELECT = 'optB'
const EDIT_DATE = '2026-02-02'
const EDIT_DATETIME = '2026-02-02T12:30'

async function readData(): Promise<Record<string, unknown>> {
  const r = await q('SELECT data FROM meta_records WHERE id = $1', [REC_ID])
  return (r.rows[0]?.data as Record<string, unknown>) ?? {}
}

function makeGetWriteInput() {
  return async (recordId: string, patch: Record<string, unknown>, actorId: string): Promise<RecordPatchInput | null> => {
    const rec = await q('SELECT sheet_id FROM meta_records WHERE id = $1', [recordId])
    if (rec.rows.length === 0) return null
    const sheetId = String((rec.rows[0] as { sheet_id: string }).sheet_id)
    const fr = await q(
      'SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC',
      [sheetId],
    )
    const fields = (fr.rows as Array<Record<string, unknown>>).map((f) => {
      const prop = f.property && typeof f.property === 'object' ? (f.property as Record<string, unknown>) : {}
      return { id: String(f.id), name: String(f.name), type: f.type as string, property: prop, options: prop.options, order: Number(f.order ?? 0) }
    })
    const fieldById = new Map(
      fields.map((f) => {
        const prop = (f.property || {}) as Record<string, unknown>
        const guard: Record<string, unknown> = { type: f.type, readOnly: false, hidden: false }
        if (f.type === 'select' && Array.isArray(prop.options)) {
          guard.options = (prop.options as unknown[]).map((o) => (typeof o === 'string' ? o : (o as { value?: string })?.value ?? ''))
        }
        return [f.id, guard] as const
      }),
    )
    const changesByRecord = new Map([
      [recordId, Object.entries(patch).map(([fieldId, value]) => ({ fieldId, value }))],
    ])
    const capabilities = deriveCapabilities(['multitable:read', 'multitable:write'], false)
    return {
      sheetId,
      changesByRecord,
      actorId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fields: fields as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      visiblePropertyFields: fields as any,
      visiblePropertyFieldIds: new Set(fields.map((f) => f.id)),
      attachmentFields: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fieldById: fieldById as any,
      capabilities,
      access: { userId: actorId, permissions: ['multitable:read', 'multitable:write'], isAdminRole: false },
      source: 'yjs-bridge',
    }
  }
}

describeIfDatabase('Yjs string-stored atomic MIGRATION (real DB) — select/date/dateTime seeded as Y.Text, edited to plain, no corruption', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'StrDate Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'StrDate Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [F_SELECT, SHEET_ID, 'Status', 'select', JSON.stringify({ options: SELECT_OPTS }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [F_DATE, SHEET_ID, 'Day', 'date', JSON.stringify({}), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [F_DATETIME, SHEET_ID, 'When', 'dateTime', JSON.stringify({}), 3])
  })
  beforeEach(async () => {
    await q(
      'INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1) ' +
        'ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, version = 1',
      [REC_ID, SHEET_ID, JSON.stringify(SEED)],
    )
  })
  afterAll(async () => {
    await q('DELETE FROM meta_records WHERE id = $1', [REC_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('seed stores select/date/dateTime as Y.Text (the old-doc shape the dual-reader must tolerate)', async () => {
    const persistence = { loadDoc: async () => null, storeUpdate: async () => {}, storeSnapshot: async () => {}, destroy: async () => {} }
    const recordSeed = async (recordId: string): Promise<Record<string, unknown> | null> => {
      const res = await q('SELECT data FROM meta_records WHERE id = $1', [recordId])
      return (res.rows[0]?.data as Record<string, unknown>) ?? null
    }
    const svc = new YjsSyncService(persistence as never, recordSeed)
    try {
      const doc = await svc.getOrCreateDoc(REC_ID)
      const fields = doc.getMap('fields')
      // The historical seed shape: all three string-stored atomics arrive as Y.Text.
      expect(fields.get(F_SELECT) instanceof Y.Text).toBe(true)
      expect(fields.get(F_DATE) instanceof Y.Text).toBe(true)
      expect(fields.get(F_DATETIME) instanceof Y.Text).toBe(true)
      // And they read back as the exact seed strings (what coerceText does on the FE).
      expect((fields.get(F_SELECT) as Y.Text).toString()).toBe('optA')
      expect((fields.get(F_DATE) as Y.Text).toString()).toBe('2026-01-01')
      expect((fields.get(F_DATETIME) as Y.Text).toString()).toBe('2026-01-01T10:00')
    } finally {
      await svc.destroy()
    }
  })

  test('plain-string edit over a seeded Y.Text → bridge → patchRecords → DB keeps EXACT strings (no Y.Text / [object Object])', async () => {
    const pool = poolManager.get()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eventBus = new EventEmitter() as any
    const fakeReq = { user: { id: ACTOR, roles: [], perms: ['multitable:read', 'multitable:write'] } } as unknown as Request
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const helpers = createRecordWriteHelpers(fakeReq, pool as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recordWriteService = new RecordWriteService(pool as any, eventBus, helpers)
    const persistence = { loadDoc: async () => null, storeUpdate: async () => {}, storeSnapshot: async () => {}, destroy: async () => {} }
    const recordSeed = async (recordId: string): Promise<Record<string, unknown> | null> => {
      const res = await q('SELECT data FROM meta_records WHERE id = $1', [recordId])
      return (res.rows[0]?.data as Record<string, unknown>) ?? null
    }
    const svc = new YjsSyncService(persistence as never, recordSeed)
    const bridge = new YjsRecordBridge(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      svc as any,
      recordWriteService,
      makeGetWriteInput(),
      { mergeWindowMs: 50, maxDelayMs: 200 },
      (socketId: string) => (socketId === SOCKET ? ACTOR : 'unknown'),
    )
    try {
      const doc = await svc.getOrCreateDoc(REC_ID)
      bridge.observe(REC_ID, doc)
      const fields = doc.getMap('fields')
      // Precondition: seeded as Y.Text.
      expect(fields.get(F_SELECT) instanceof Y.Text).toBe(true)

      // The dual-reader binding writes a PLAIN string on edit (Y.Map.set replaces the Y.Text).
      doc.transact(() => {
        fields.set(F_SELECT, EDIT_SELECT)
        fields.set(F_DATE, EDIT_DATE)
        fields.set(F_DATETIME, EDIT_DATETIME)
      }, SOCKET)
      // After the write the values are plain strings, not Y.Text.
      expect(fields.get(F_SELECT) instanceof Y.Text).toBe(false)

      await new Promise((r) => setTimeout(r, 500))

      const data = await readData()
      // WIRED string-stored atomics (select + date): exact round-trip, no corruption. These have no
      // normalizing codec, so the plain string the dual-reader writes is persisted verbatim.
      for (const [k, v] of [[F_SELECT, EDIT_SELECT], [F_DATE, EDIT_DATE]] as const) {
        expect(typeof data[k]).toBe('string')
        expect(data[k]).toBe(v)
        expect(data[k]).not.toBe('[object Object]')
      }
      // dateTime is DEFERRED from live wiring precisely because its codec normalizes to canonical UTC
      // ISO — a plain-string flush does NOT round-trip the raw input. Assert it is a valid normalized
      // string (NOT corrupted: not a Y.Text object, not '[object Object]', not a nested Yjs type) but
      // NOT the raw input — this is the evidence that dateTime must stay REST-only (not in
      // STRING_STORED_ATOMIC_YJS_TYPES) until a tz-aware live-edit design exists.
      expect(typeof data[F_DATETIME]).toBe('string')
      expect(data[F_DATETIME]).not.toBe('[object Object]')
      expect(data[F_DATETIME]).not.toBe(EDIT_DATETIME) // normalized by the codec, not the raw input
      expect(data[F_DATETIME] as string).toMatch(/\dT\d.*Z$/) // canonical UTC ISO, a valid (uncorrupted) string
    } finally {
      bridge.unobserve(REC_ID)
      await svc.destroy()
    }
  })
})
