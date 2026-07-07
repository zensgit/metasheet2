/**
 * W3-5 — real-DB golden pinning the batchId===null DEFAULT behavior (prerequisite: AI-fields S1 #3584,
 * merged commit 4640f3662, design-lock docs/development/multitable-ai-write-provenance-batch-grouping-s1-designlock-20260705.md).
 *
 * Discovery (read from the actual code, not assumed):
 *   - Migration `zzzz20260619120000_add_meta_record_revisions_batch_id.ts` adds `meta_record_revisions.batch_id
 *     text NULL` and documents: "a single-record action defaults batch_id to the revision's own id (one
 *     revision = one batch); a bulk action passes one shared batch_id across its rows."
 *   - The ONE write chokepoint, `recordRecordRevision` (record-history-service.ts), inserts
 *     `input.batchId ?? id` — so batch_id is NEVER SQL NULL for a freshly-written revision. A caller that
 *     omits `batchId` gets a NON-NULL default, but the SHAPE of that default differs by call site:
 *       (a) `RecordService.patchRecord` / `createRecord` / `deleteRecord` (record-service.ts) never pass
 *           `batchId` at all → the fallback fires → batch_id === the revision's OWN `id` (self-referential).
 *       (b) `RecordWriteService.patchRecords` (record-write-service.ts, the bulk/grid `/patch` chokepoint)
 *           computes its OWN `bulkBatchId = batchId ?? randomUUID()` and passes it explicitly → batch_id is a
 *           FRESH id, distinct from the revision's own `id`.
 *   - The existing S1 golden (`multitable-ai-write-provenance-batch-grouping-realdb.test.ts`, G6) already pins
 *     shape (b) via the `/api/multitable/patch` HTTP route (truthy + distinct-per-call). It does NOT drive
 *     shape (a) — the single-record `PATCH /records/:recordId` route (`RecordService.patchRecord`), which is
 *     the ONLY caller path where a fresh revision's batch_id literally equals its own row id. THIS is the
 *     uncovered vector this golden narrows to.
 *
 * Assertions:
 *   G-A1: a single-record `RecordService.patchRecord` commit with no `batchId` → batch_id is NOT NULL and
 *         equals the revision's own `id` (self-referential singleton batch).
 *   G-A2: a second, independent `patchRecord` commit on a different record gets its OWN self-referential
 *         batch_id, distinct from G-A1's (not some shared/fixed sentinel).
 *   G-A3 (read-side): `loadHistoryBatchDetail` grouped by that self-referential batch_id returns EXACTLY one
 *         change, for that one record (grouping-by-batch behaves correctly for the self-referential case).
 *   CONTROL: `RecordWriteService.patchRecords` (shape (b)) with no `batchId` on a third record gets a batch_id
 *         that is NOT NULL but DIFFERENT from its own revision id (fresh randomUUID) — proving this test
 *         actually discriminates between the two default mechanisms rather than being vacuously true either
 *         way (a test that only asserted "truthy" could not tell shape (a) and (b) apart).
 *
 * Test-only: no runtime behavior is changed by this file.
 * Real-DB only (sentinel fails-not-skips, matching this repo's real-DB suites); registered in plugin-tests.yml.
 */
import type { Request } from 'express'
import { EventEmitter } from 'events'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { RecordService } from '../../src/multitable/record-service'
import { RecordWriteService, type RecordPatchInput as WriteRecordPatchInput } from '../../src/multitable/record-write-service'
import { createRecordWriteHelpers } from '../../src/routes/univer-meta'
import { deriveCapabilities } from '../../src/multitable/sheet-capabilities'
import { loadHistoryBatchDetail } from '../../src/multitable/history-projection'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const TS = Date.now()
const BASE_ID = `base_w35_${TS}`
const SHEET_ID = `sheet_w35_${TS}`
const F_STR = `fld_w35_str_${TS}`
const ACTOR = `u_w35_actor_${TS}`

const REC_A1 = `rec_w35_a1_${TS}` // record-service.ts patchRecord, commit 1
const REC_A2 = `rec_w35_a2_${TS}` // record-service.ts patchRecord, commit 2 (distinctness check)
const REC_CTRL = `rec_w35_ctrl_${TS}` // RecordWriteService.patchRecords, control

type RevisionRow = { id: string; batch_id: string | null; record_id: string }

async function latestRevisionFor(recordId: string): Promise<RevisionRow> {
  const res = await q(
    'SELECT id, batch_id, record_id FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2 ORDER BY created_at DESC, version DESC LIMIT 1',
    [SHEET_ID, recordId],
  )
  const row = (res.rows as RevisionRow[])[0]
  expect(row).toBeTruthy()
  return row
}

describeIfDatabase('W3-5 — batchId===null default behavior (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'W3-5 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'W3-5 Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
      F_STR, SHEET_ID, 'Note', 'string', '{}', 1,
    ])
    for (const recordId of [REC_A1, REC_A2, REC_CTRL]) {
      await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [
        recordId, SHEET_ID, JSON.stringify({ [F_STR]: 'orig' }), ACTOR,
      ])
    }
  })

  afterAll(async () => {
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('G-A1: RecordService.patchRecord with no batchId → batch_id defaults to the revision\'s OWN id', async () => {
    const pool = poolManager.get()
    const eventBus = new EventEmitter() as unknown as import('../../src/integration/events/event-bus').EventBus
    const recordService = new RecordService(pool as unknown as ConstructorParameters<typeof RecordService>[0], eventBus)
    const capabilities = deriveCapabilities(['multitable:read', 'multitable:write'], false)
    const access = { userId: ACTOR, permissions: ['multitable:read', 'multitable:write'], isAdminRole: false }

    await recordService.patchRecord({
      recordId: REC_A1,
      sheetId: SHEET_ID,
      data: { [F_STR]: 'v1' },
      actorId: ACTOR,
      access,
      capabilities,
    })

    const rev = await latestRevisionFor(REC_A1)
    expect(rev.batch_id).toBeTruthy()
    expect(rev.batch_id).toBe(rev.id) // self-referential default: batch_id === the revision's own id
  })

  test('G-A2: a second independent patchRecord commit gets its OWN self-referential batch_id (distinct from G-A1)', async () => {
    const pool = poolManager.get()
    const eventBus = new EventEmitter() as unknown as import('../../src/integration/events/event-bus').EventBus
    const recordService = new RecordService(pool as unknown as ConstructorParameters<typeof RecordService>[0], eventBus)
    const capabilities = deriveCapabilities(['multitable:read', 'multitable:write'], false)
    const access = { userId: ACTOR, permissions: ['multitable:read', 'multitable:write'], isAdminRole: false }

    await recordService.patchRecord({
      recordId: REC_A2,
      sheetId: SHEET_ID,
      data: { [F_STR]: 'v2' },
      actorId: ACTOR,
      access,
      capabilities,
    })

    const revA1 = await latestRevisionFor(REC_A1)
    const revA2 = await latestRevisionFor(REC_A2)
    expect(revA2.batch_id).toBe(revA2.id)
    expect(revA2.batch_id).not.toBe(revA1.batch_id) // not a shared/fixed sentinel — genuinely per-revision
  })

  test('G-A3 (read-side): loadHistoryBatchDetail grouped by the self-referential batch_id returns exactly one change for that record', async () => {
    const rev = await latestRevisionFor(REC_A1)
    const detail = await loadHistoryBatchDetail(
      (sql, params) => q(sql, params),
      [SHEET_ID],
      rev.batch_id as string,
      { userId: ACTOR, isAdminRole: true },
      new Map([[SHEET_ID, new Set([F_STR])]]),
    )
    expect(detail).toBeTruthy()
    expect(detail?.changes).toHaveLength(1)
    expect(detail?.changes[0]?.recordId).toBe(REC_A1)
  })

  test('CONTROL: RecordWriteService.patchRecords with no batchId → a FRESH id, distinct from its own revision id (proves the assertion discriminates the two default mechanisms)', async () => {
    const pool = poolManager.get()
    const eventBus = new EventEmitter() as unknown as import('../../src/integration/events/event-bus').EventBus
    const fakeReq = { user: { id: ACTOR, roles: [], perms: ['multitable:read', 'multitable:write'] } } as unknown as Request
    const helpers = createRecordWriteHelpers(fakeReq, pool as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }> })
    const writeService = new RecordWriteService(pool as unknown as ConstructorParameters<typeof RecordWriteService>[0], eventBus, helpers)
    const capabilities = deriveCapabilities(['multitable:read', 'multitable:write'], false)
    const access = { userId: ACTOR, permissions: ['multitable:read', 'multitable:write'], isAdminRole: false }

    const fields = [{ id: F_STR, name: 'Note', type: 'string', property: {}, order: 1 }]
    const fieldById = new Map([[F_STR, { type: 'string', readOnly: false, hidden: false } as Record<string, unknown>]])
    const input: WriteRecordPatchInput = {
      sheetId: SHEET_ID,
      changesByRecord: new Map([[REC_CTRL, [{ fieldId: F_STR, value: 'ctrl-v1' }]]]),
      actorId: ACTOR,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fields: fields as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      visiblePropertyFields: fields as any,
      visiblePropertyFieldIds: new Set([F_STR]),
      attachmentFields: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fieldById: fieldById as any,
      capabilities,
      access,
    }
    await writeService.patchRecords(input)

    const rev = await latestRevisionFor(REC_CTRL)
    expect(rev.batch_id).toBeTruthy()
    expect(rev.batch_id).not.toBe(rev.id) // fresh randomUUID, NOT self-referential — the opposite of G-A1/G-A2
  })
})
