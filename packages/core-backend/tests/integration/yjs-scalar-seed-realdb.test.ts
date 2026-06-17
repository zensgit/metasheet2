/**
 * Real-DB proof for non-string CRDT seeding: when the Yjs sync service seeds a fresh
 * record doc from meta_records.data, ATOMIC (non-string) fields must land in the `fields`
 * Y.Map as PLAIN, NATIVE-TYPED values (number→number, boolean→boolean, multiSelect→array) —
 * NOT Y.Text and NOT type-coerced (char-merge is meaningless for atomic values; LWW via the
 * Y.Map is correct). String fields stay Y.Text (char-level merge).
 *
 * This is the no-corruption gate on real Postgres: the bridge persists whatever's in the Y.Map
 * back through the validated patchRecords path, so a wrong-typed seed would corrupt the record.
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI per the suite convention).
 */
import { randomUUID } from 'crypto'
import * as Y from 'yjs'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { YjsSyncService } from '../../src/collab/yjs-sync-service'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const TS = Date.now()
const BASE_ID = `base_scalarseed_${TS}`
const SHEET_ID = `sheet_scalarseed_${TS}`
const REC_ID = `rec_scalarseed_${TS}`

// Native scalar data as it lives in meta_records.data (JSONB preserves these types).
const DATA = {
  fld_title: 'hello world', // string → Y.Text
  fld_num: 42, // number → plain LWW
  fld_done: true, // boolean → plain LWW
  fld_tags: ['a', 'b'], // multiSelect array → plain LWW
}

describeIfDatabase('Yjs scalar seed (real DB) — atomic fields seed as native plain values, no corruption', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'ScalarSeed Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'ScalarSeed Sheet'])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_ID, SHEET_ID, JSON.stringify(DATA)])
  })

  afterAll(async () => {
    await q('DELETE FROM meta_records WHERE id = $1', [REC_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('seeds atomic fields as native-typed plain Y.Map values from real meta_records.data', async () => {
    // recordSeed reads the record's data straight from Postgres (the real seed path).
    const recordSeed = async (recordId: string): Promise<Record<string, unknown> | null> => {
      const res = await q('SELECT data FROM meta_records WHERE id = $1', [recordId])
      return (res.rows[0]?.data as Record<string, unknown>) ?? null
    }
    // No persisted Yjs state → fresh seed. (loadDoc returns null for an unseen record.)
    const persistence = { loadDoc: async () => null, storeUpdate: async () => {}, storeSnapshot: async () => {}, destroy: async () => {} }
    const svc = new YjsSyncService(persistence as never, recordSeed)
    try {
      const doc = await svc.getOrCreateDoc(REC_ID)
      const fields = doc.getMap('fields')

      // String → Y.Text (char-level merge).
      expect(fields.get('fld_title')).toBeInstanceOf(Y.Text)
      expect((fields.get('fld_title') as Y.Text).toString()).toBe('hello world')

      // Atomic → PLAIN native value, NOT Y.Text, NOT coerced. This is the no-corruption proof.
      expect(fields.get('fld_num')).toBe(42)
      expect(typeof fields.get('fld_num')).toBe('number')
      expect(fields.get('fld_num')).not.toBeInstanceOf(Y.Text)
      expect(fields.get('fld_done')).toBe(true)
      expect(typeof fields.get('fld_done')).toBe('boolean')
      expect(fields.get('fld_tags')).toEqual(['a', 'b'])
      expect(Array.isArray(fields.get('fld_tags'))).toBe(true)
    } finally {
      await svc.destroy()
    }
  })
})
