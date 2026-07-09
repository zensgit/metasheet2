/**
 * D-1 (destruction-path coverage gap audit, owner-ratified 2026-07-09) — delete-revision parity
 * for the two record hard-delete paths that emitted NO delete revision:
 *
 *   path 3: plugin-SDK `records.deleteRecord`        → now emits action:'delete' source:'plugin'
 *   path 4: automation executor `delete_record`      → now emits action:'delete' source:'automation'
 *
 * Why this is a correctness bug and not a feature: `reconstructRecordsAtT` derives record existence
 * PURELY from meta_record_revisions. Without a delete revision, a deleted record's last revision
 * stays create/update, so Global History and every PIT consumer (PIT view / Reset preview / Reset
 * execute / record reconstruction) treat it as ALIVE FOREVER and feed its stale snapshot onward.
 *
 * Scope is D-1 MINIMAL by owner order: PIT correctness only. Deliberately NOT asserted here (and
 * NOT implemented): trash rows, tombstone capture, recoverability — that is the owner-gated D-2.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { MemoryRateLimitStore } from '../../src/middleware/rate-limiter'
import { poolManager } from '../../src/integration/db/connection-pool'
import { EventBus } from '../../src/integration/events/event-bus'
import {
  AutomationExecutor,
  type AutomationDeps,
  type AutomationRule,
} from '../../src/multitable/automation-executor'
import { deleteRecord as pluginDeleteRecord } from '../../src/multitable/records'
import { reconstructRecordsAtT } from '../../src/multitable/record-reconstructor'
import { recordRecordRevision } from '../../src/multitable/record-history-service'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const OWNER = `u_d1_owner_${TS}`
const BASE = `base_d1_${TS}`
const SHEET = `sheet_d1_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

function makeExecutor(): AutomationExecutor {
  const deps: AutomationDeps = {
    eventBus: new EventBus(),
    queryFn: (sql: string, params?: unknown[]) => q(sql, params),
    crossBaseWriteQuota: { limit: 1000, windowMs: 60_000, store: new MemoryRateLimitStore() },
  }
  return new AutomationExecutor(deps)
}

function deleteRuleFor(recordId: string): AutomationRule {
  return {
    id: `axr_d1_${TS}_${Math.random().toString(36).slice(2, 8)}`,
    name: 'D1 delete rule',
    sheetId: SHEET,
    trigger: { type: 'record.created', config: {} },
    actions: [{ type: 'delete_record', config: {} } as never],
    enabled: true,
    createdBy: OWNER,
    createdAt: new Date().toISOString(),
  } as unknown as AutomationRule
}

async function insertRecord(recordId: string, data: Record<string, unknown>): Promise<void> {
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,3)', [
    recordId,
    SHEET,
    JSON.stringify(data),
  ])
  // Seed the create revision the same way the real write path does, so the PIT goldens below start
  // from the exact revision stream shape production has (create → [delete]).
  await recordRecordRevision(q, {
    sheetId: SHEET,
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

async function deleteRevisionsOf(recordId: string): Promise<Array<{ source: string; snapshot: Record<string, unknown> | null; version: number }>> {
  const res = await q(
    `SELECT source, snapshot, version FROM meta_record_revisions
      WHERE sheet_id = $1 AND record_id = $2 AND action = 'delete'
      ORDER BY created_at DESC`,
    [SHEET, recordId],
  )
  return res.rows as never[]
}

async function revisionCutoffAfter(recordId: string, action: 'create' | 'delete'): Promise<string> {
  const res = await q(
    `SELECT (created_at + interval '1 microsecond')::text AS as_of
       FROM meta_record_revisions
      WHERE sheet_id = $1 AND record_id = $2 AND action = $3
      ORDER BY created_at DESC, version DESC, id DESC
      LIMIT 1`,
    [SHEET, recordId, action],
  )
  expect(res.rows).toHaveLength(1)
  return String((res.rows[0] as { as_of: string }).as_of)
}

async function pitAlive(recordId: string, asOfIso: string): Promise<boolean> {
  const state = await reconstructRecordsAtT(q, SHEET, asOfIso, [recordId])
  return state.get(recordId)?.exists === true
}

describeIfDatabase('D-1 — delete-revision parity for plugin-SDK + automation hard deletes (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1, $2, $3)', [BASE, 'D1 Base', OWNER])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET, BASE, 'D1 Sheet'])
    // loadSheetAndFields (plugin path) requires at least one field on the sheet.
    await q(
      `INSERT INTO meta_fields (id, sheet_id, name, type, "order") VALUES ($1, $2, 'Title', 'text', 0)`,
      [`fld_d1_${TS}`, SHEET],
    )
  })

  afterAll(async () => {
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
  })

  test('sentinel: DATABASE_URL is set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('PLUGIN path: delete emits action=delete source=plugin with the final snapshot — and PIT stops lying', async () => {
    const recId = `rec_d1_plugin_${TS}`
    await insertRecord(recId, { title: 'plugin victim' })
    const beforeDelete = await revisionCutoffAfter(recId, 'create')

    await pluginDeleteRecord({ query: q as never, sheetId: SHEET, recordId: recId } as never)

    // The revision is the whole point of D-1.
    const revs = await deleteRevisionsOf(recId)
    expect(revs).toHaveLength(1)
    expect(revs[0]!.source).toBe('plugin')
    expect(revs[0]!.version).toBe(3)
    expect(revs[0]!.snapshot).toMatchObject({ title: 'plugin victim' })

    const afterDelete = await revisionCutoffAfter(recId, 'delete')

    // PIT GOLDEN both directions: alive before the delete, dead after it. Before D-1 the second
    // assertion failed forever — the record's last revision was the create.
    expect(await pitAlive(recId, beforeDelete)).toBe(true)
    expect(await pitAlive(recId, afterDelete)).toBe(false)
  })

  test('AUTOMATION path: delete_record emits action=delete source=automation with actor + snapshot — and PIT stops lying', async () => {
    const recId = `rec_d1_auto_${TS}`
    await insertRecord(recId, { title: 'automation victim' })
    const beforeDelete = await revisionCutoffAfter(recId, 'create')

    const exec = await makeExecutor().execute(deleteRuleFor(recId), {
      recordId: recId,
      sheetId: SHEET,
      actorId: OWNER,
      data: {},
    })
    expect(exec.steps[0]?.status).toBe('success')
    expect((await q('SELECT 1 FROM meta_records WHERE id = $1', [recId])).rows).toHaveLength(0)

    const revs = await deleteRevisionsOf(recId)
    expect(revs).toHaveLength(1)
    expect(revs[0]!.source).toBe('automation')
    expect(revs[0]!.snapshot).toMatchObject({ title: 'automation victim' })

    const afterDelete = await revisionCutoffAfter(recId, 'delete')
    expect(await pitAlive(recId, beforeDelete)).toBe(true)
    expect(await pitAlive(recId, afterDelete)).toBe(false)
  })

  test('BEHAVIOR PRESERVED: plugin delete of a missing record still throws NotFound and emits NO revision', async () => {
    const ghost = `rec_d1_ghost_${TS}`
    await expect(
      pluginDeleteRecord({ query: q as never, sheetId: SHEET, recordId: ghost } as never),
    ).rejects.toThrow(/not found/i)
    expect(await deleteRevisionsOf(ghost)).toHaveLength(0)
  })

  test('BEHAVIOR PRESERVED: same-base automation delete of a missing record keeps its 0-row success — and fabricates NO revision', async () => {
    const ghost = `rec_d1_ghost2_${TS}`
    const exec = await makeExecutor().execute(deleteRuleFor(ghost), {
      recordId: ghost,
      sheetId: SHEET,
      actorId: OWNER,
      data: {},
    })
    // Pre-existing same-base leniency: a missing trigger record yields a 0-row DELETE reported as
    // success. D-1 must not change that — and must NOT invent a delete revision for a record that
    // never existed.
    expect(exec.steps[0]?.status).toBe('success')
    expect(await deleteRevisionsOf(ghost)).toHaveLength(0)
  })

  test('D-1 MINIMAL scope: neither path writes trash or tombstones (recoverability stays D-2)', async () => {
    const recId = `rec_d1_scope_${TS}`
    await insertRecord(recId, { title: 'scope check' })
    await pluginDeleteRecord({ query: q as never, sheetId: SHEET, recordId: recId } as never)
    const trash = await q('SELECT 1 FROM meta_records_trash WHERE record_id = $1', [recId]).catch(() => ({ rows: [] }))
    expect(trash.rows).toHaveLength(0)
    const tomb = await q(
      "SELECT 1 FROM meta_link_tombstones WHERE record_id = $1 OR foreign_record_id = $1",
      [recId],
    ).catch(() => ({ rows: [] }))
    expect(tomb.rows).toHaveLength(0)
  })
})
