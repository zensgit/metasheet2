/**
 * Real-DB no-corruption proof — the FLUSH side of non-string CRDT for the field types wired in
 * this slice: rating (number) and multiSelect (string[]). A synced client edits the record
 * `fields` Y.Map; the YjsRecordBridge flushes the change through the REAL
 * RecordWriteService.patchRecords (real injected helpers + real Postgres). We then re-read
 * meta_records.data and assert the values round-trip with native types:
 *   - rating stays a JS number (not '4', not coerced)
 *   - multiSelect stays a PLAIN JSON array (not a Y.Array, not a JSON-stringified blob)
 *
 * Companion to yjs-scalar-seed-realdb (the SEED side: data -> Y.Map) and
 * yjs-bridge-scalar-fields (the COLLECTION side: Y.Map -> patch, mocked). This closes the loop
 * on real Postgres. Capabilities come from deriveCapabilities(['multitable:write']) — the same
 * MultitableCapabilities derivation the REST write path uses — so the only thing isolated here is
 * value fidelity, not permission gating (covered elsewhere). The bridge's own flushNow swallows
 * write errors, so a broken wiring shows up as a FAILED DB assertion below, never a false green.
 *
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI per the suite convention).
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
const BASE_ID = `base_scalarflush_${TS}`
const SHEET_ID = `sheet_scalarflush_${TS}`
const REC_ID = `rec_scalarflush_${TS}`
const ACTOR = `u_scalarflush_${TS}`
const SOCKET = `socket_scalarflush_${TS}`

const F_RATING = 'fld_rating'
const F_TAGS = 'fld_tags'
const TAG_OPTS = [{ value: 'x' }, { value: 'y' }, { value: 'z' }]

async function readData(): Promise<Record<string, unknown>> {
  const r = await q('SELECT data FROM meta_records WHERE id = $1', [REC_ID])
  return (r.rows[0]?.data as Record<string, unknown>) ?? {}
}

// Faithful resolver: builds RecordPatchInput from the REAL fields + REAL capability derivation,
// mirroring the production wiring in src/index.ts. (No DB-backed RBAC lookup — we grant the
// actor multitable:write directly, since this test isolates value fidelity, not permissions.)
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
        if ((f.type === 'select' || f.type === 'multiSelect') && Array.isArray(prop.options)) {
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

describeIfDatabase('Yjs scalar FLUSH (real DB) — rating/multiSelect round-trip through the bridge, no corruption', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'ScalarFlush Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'ScalarFlush Sheet'])
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [F_RATING, SHEET_ID, 'Score', 'rating', JSON.stringify({ max: 5 }), 1],
    )
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [F_TAGS, SHEET_ID, 'Tags', 'multiSelect', JSON.stringify({ options: TAG_OPTS }), 2],
    )
  })
  beforeEach(async () => {
    // Fresh starting state each run: rating=1, tags=['x'].
    await q(
      'INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1) ' +
        'ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, version = 1',
      [REC_ID, SHEET_ID, JSON.stringify({ [F_RATING]: 1, [F_TAGS]: ['x'] })],
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

  test('Y.Map edit (rating=4, multiSelect=[x,y,z]) flushes via REAL patchRecords → DB keeps native number + plain array', async () => {
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

      // A synced client edit: a non-rest/persistence transaction origin (the socket id) so the
      // bridge attributes + flushes it through patchRecords, exactly like a real collaborator.
      doc.transact(() => {
        fields.set(F_RATING, 4)
        fields.set(F_TAGS, ['x', 'y', 'z'])
      }, SOCKET)

      // Wait out the debounce + the async patchRecords landing in Postgres.
      await new Promise((r) => setTimeout(r, 500))

      const data = await readData()
      expect(data[F_RATING]).toBe(4)
      expect(typeof data[F_RATING]).toBe('number') // native number, not '4'
      expect(data[F_TAGS]).toEqual(['x', 'y', 'z']) // plain JSON array, not a Y.Array, not stringified
      expect(Array.isArray(data[F_TAGS])).toBe(true)
    } finally {
      bridge.unobserve(REC_ID)
      await svc.destroy()
    }
  })
})
