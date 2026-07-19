/**
 * P2 durable-delivery P1 #2b — producer family 4 SITE-WIRING goldens (real DB).
 *
 * Family 4 = the record CRUD emit sites: `record-service.ts` createRecord / patchRecord / deleteRecord /
 * restoreRecord + `record-write-service.ts` patchRecords (bulk). The REPLACE seam ITSELF
 * (`enqueueRecordEventIfDurable` commit/rollback/off atomicity) is already golden-covered by the family-3
 * suite (`multitable-automation-producer-emit-realdb.test.ts`); what THIS suite proves is the SITE wiring —
 * driving the REAL services end to end:
 *   - flag ON  → each CRUD write leaves exactly one outbox row (right event_type, payload = the legacy
 *                payload shape, event_id = the payload's `_eventId`) fanned out to exactly
 *                [automation-record-trigger, webhook-event-bridge] (pending), AND the legacy bus is
 *                SUPPRESSED at the real site (REPLACE, not keep-both — the webhook sink is not idempotent).
 *   - flag ON + a failing write (version conflict) → zero outbox rows AND zero emits (success-path only).
 *   - flag OFF → the legacy bus fires with the byte-identical payload shape and ZERO outbox rows.
 *
 * Rows are asserted by THIS suite's own unique record/sheet ids and cleaned up — never drained/claimed — so
 * it never touches a sibling suite's rows on the shared CI DB. Runs only with DATABASE_URL (sentinel
 * fails-not-skips inside the real-DB allowlist step). Two-point wiring: vitest.config.ts exclude +
 * plugin-tests.yml real-DB run list.
 */
import type { Request } from 'express'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import type { EventBus } from '../../src/integration/events/event-bus'
import { RecordService, VersionConflictError } from '../../src/multitable/record-service'
import { RecordWriteService, type RecordPatchInput as WriteRecordPatchInput } from '../../src/multitable/record-write-service'
import { createRecordWriteHelpers } from '../../src/routes/univer-meta'
import { deriveCapabilities, type AccessInfo } from '../../src/multitable/sheet-capabilities'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const FLAG = 'AUTOMATION_DURABLE_DELIVERY_ENABLED'
const TS = Date.now()
const BASE = `base_f4_${TS}`
const SHEET = `sheet_f4_${TS}`
const F_STR = `fld_f4_str_${TS}`
const ACTOR = `u_f4_actor_${TS}`
const MANIFEST_FANOUT = ['automation-record-trigger', 'webhook-event-bridge']

let seq = 0
const mkRecord = (tag: string) => `rec_f4_${tag}_${TS}_${seq++}`

// The suppression probe: the REAL services are constructed over this spy bus, so "flag ON ⇒ not called"
// is asserted at the actual production emit site, not at the seam helper.
const busEmit = vi.fn()
const eventBus = { emit: busEmit } as unknown as EventBus

const access: AccessInfo = { userId: ACTOR, permissions: ['multitable:read', 'multitable:write'], isAdminRole: false }
const capabilities = deriveCapabilities(['multitable:read', 'multitable:write'], false)
const resolveSheetAccess = async () => ({ capabilities })

const mkRecordService = () =>
  new RecordService(poolManager.get() as unknown as ConstructorParameters<typeof RecordService>[0], eventBus)
const mkWriteService = () => {
  const fakeReq = { user: { id: ACTOR, roles: [], perms: ['multitable:read', 'multitable:write'] } } as unknown as Request
  const helpers = createRecordWriteHelpers(
    fakeReq,
    poolManager.get() as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }> },
  )
  return new RecordWriteService(
    poolManager.get() as unknown as ConstructorParameters<typeof RecordWriteService>[0],
    eventBus,
    helpers,
  )
}

const seedRecord = async (id: string, data: Record<string, unknown> = { [F_STR]: 'orig' }): Promise<void> => {
  await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [id, SHEET, JSON.stringify(data), ACTOR])
}

const mkBulkInput = (changesByRecord: Map<string, Array<{ fieldId: string; value: unknown; expectedVersion?: number }>>): WriteRecordPatchInput => ({
  sheetId: SHEET,
  changesByRecord,
  actorId: ACTOR,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fields: [{ id: F_STR, name: 'Note', type: 'string', property: {}, order: 1 }] as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  visiblePropertyFields: [{ id: F_STR, name: 'Note', type: 'string', property: {}, order: 1 }] as any,
  visiblePropertyFieldIds: new Set([F_STR]),
  attachmentFields: [],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fieldById: new Map([[F_STR, { type: 'string', readOnly: false, hidden: false } as Record<string, unknown>]]) as any,
  capabilities,
  access,
})

type OutboxRow = { id: string; event_id: string; automation_depth: number; manifest_version: number; payload: Record<string, unknown> }
/** This suite's own rows ONLY: keyed by our unique per-run record id + event type. Never drains anything. */
const outboxRowsFor = async (recordId: string, eventType: string): Promise<OutboxRow[]> => {
  const { rows } = await q(
    `SELECT id, event_id, automation_depth, manifest_version, payload FROM meta_automation_outbox
      WHERE event_type = $1 AND payload->>'recordId' = $2 ORDER BY created_at`,
    [eventType, recordId],
  )
  return rows as OutboxRow[]
}
const consumersOf = async (outboxId: string): Promise<Array<{ consumer_key: string; status: string }>> => {
  const { rows } = await q(
    'SELECT consumer_key, status FROM meta_automation_outbox_consumer WHERE outbox_id = $1 ORDER BY consumer_key',
    [outboxId],
  )
  return rows as Array<{ consumer_key: string; status: string }>
}
/** Full site golden for one flag-ON write: exactly one outbox row, legacy-shaped payload, manifest fan-out. */
const expectDurableRow = async (recordId: string, eventType: string, payloadShape: Record<string, unknown>): Promise<void> => {
  const rows = await outboxRowsFor(recordId, eventType)
  expect(rows).toHaveLength(1)
  const row = rows[0]!
  expect(row.payload).toEqual({ ...payloadShape, _eventId: expect.any(String) })
  expect(row.event_id).toBe(row.payload._eventId) // stable identity shared by both phases
  expect(row.automation_depth).toBe(0)
  expect(row.manifest_version).toBe(1)
  expect(await consumersOf(row.id)).toEqual(MANIFEST_FANOUT.map((consumer_key) => ({ consumer_key, status: 'pending' })))
}

describeIfDatabase('P1#2b producer family 4 — record CRUD site wiring (real DB)', () => {
  beforeAll(async () => {
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'F4 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'F4 Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_STR, SHEET, 'Note', 'string', '{}', 1])
  })

  afterEach(() => {
    delete process.env[FLAG]
    busEmit.mockClear()
  })

  afterAll(async () => {
    delete process.env[FLAG]
    // ONLY this suite's rows: every outbox row we produced carries our unique sheet id in its payload
    // (consumer rows cascade), and every fixture id is TS-suffixed.
    await q("DELETE FROM meta_automation_outbox WHERE payload->>'sheetId' = $1", [SHEET]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
  })

  test('sentinel: DATABASE_URL is set (this suite must RUN, never skip-green)', () => {
    if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
      throw new Error('real-DB allowlist step is missing DATABASE_URL')
    }
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // ── flag ON: durable outbox row + manifest fan-out, legacy bus SUPPRESSED at the real site ──────────

  test('ON create: createRecord → one record.created outbox row (legacy payload shape) + fan-out; bus suppressed', async () => {
    process.env[FLAG] = 'true'
    const res = await mkRecordService().createRecord({ sheetId: SHEET, data: { [F_STR]: 'created' }, actorId: ACTOR, capabilities })
    await expectDurableRow(res.recordId, 'multitable.record.created', {
      sheetId: SHEET,
      recordId: res.recordId,
      data: { [F_STR]: 'created' },
      actorId: ACTOR,
    })
    expect(busEmit).not.toHaveBeenCalled() // REPLACE: the same-txn enqueue IS the delivery path
  })

  test('ON update (single): patchRecord → one record.updated outbox row + fan-out; bus suppressed', async () => {
    const R = mkRecord('patch')
    await seedRecord(R)
    process.env[FLAG] = 'true'
    await mkRecordService().patchRecord({ recordId: R, sheetId: SHEET, data: { [F_STR]: 'patched' }, actorId: ACTOR, access, capabilities })
    await expectDurableRow(R, 'multitable.record.updated', {
      sheetId: SHEET,
      recordId: R,
      data: { [F_STR]: 'patched' },
      actorId: ACTOR, // patchRecord's legacy emit used access.userId ?? 'system'
    })
    expect(busEmit).not.toHaveBeenCalled()
  })

  test('ON delete: deleteRecord → one record.deleted outbox row + fan-out; bus suppressed', async () => {
    const R = mkRecord('del')
    await seedRecord(R)
    process.env[FLAG] = 'true'
    await mkRecordService().deleteRecord({ recordId: R, actorId: ACTOR, access, resolveSheetAccess })
    await expectDurableRow(R, 'multitable.record.deleted', { sheetId: SHEET, recordId: R, actorId: ACTOR })
    expect(busEmit).not.toHaveBeenCalled()
  })

  test('ON restore: restoreRecord → one record.created outbox row (restore payload has NO data key); bus suppressed', async () => {
    const R = mkRecord('restore')
    await seedRecord(R)
    process.env[FLAG] = 'true'
    await mkRecordService().deleteRecord({ recordId: R, actorId: ACTOR, access, resolveSheetAccess })
    await mkRecordService().restoreRecord({ recordId: R, actorId: ACTOR, access, resolveSheetAccess })
    // the restore site's legacy payload was { sheetId, recordId, actorId } — no `data` key (unlike create)
    await expectDurableRow(R, 'multitable.record.created', { sheetId: SHEET, recordId: R, actorId: ACTOR })
    expect(busEmit).not.toHaveBeenCalled()
  })

  test('ON bulk: patchRecords (record-write-service) → one record.updated outbox row PER written record; bus suppressed', async () => {
    const R1 = mkRecord('bulk1')
    const R2 = mkRecord('bulk2')
    await seedRecord(R1)
    await seedRecord(R2)
    process.env[FLAG] = 'true'
    await mkWriteService().patchRecords(mkBulkInput(new Map([
      [R1, [{ fieldId: F_STR, value: 'bulk-one' }]],
      [R2, [{ fieldId: F_STR, value: 'bulk-two' }]],
    ])))
    await expectDurableRow(R1, 'multitable.record.updated', { sheetId: SHEET, recordId: R1, changes: { [F_STR]: 'bulk-one' }, actorId: ACTOR })
    await expectDurableRow(R2, 'multitable.record.updated', { sheetId: SHEET, recordId: R2, changes: { [F_STR]: 'bulk-two' }, actorId: ACTOR })
    expect(busEmit).not.toHaveBeenCalled()
  })

  test('ON + failing write: a version-conflict patch rolls back → ZERO outbox rows AND zero emits (success-path only)', async () => {
    const R = mkRecord('conflict')
    await seedRecord(R) // version 1
    process.env[FLAG] = 'true'
    await expect(
      mkRecordService().patchRecord({ recordId: R, sheetId: SHEET, data: { [F_STR]: 'nope' }, expectedVersion: 99, actorId: ACTOR, access, capabilities }),
    ).rejects.toBeInstanceOf(VersionConflictError)
    expect(await outboxRowsFor(R, 'multitable.record.updated')).toHaveLength(0)
    expect(busEmit).not.toHaveBeenCalled()
  })

  // ── flag OFF: legacy bus fires byte-identically, ZERO outbox rows ───────────────────────────────────

  test('OFF create: legacy bus fires with the byte-identical payload shape; zero outbox rows', async () => {
    const res = await mkRecordService().createRecord({ sheetId: SHEET, data: { [F_STR]: 'off-created' }, actorId: ACTOR, capabilities })
    expect(busEmit).toHaveBeenCalledTimes(1)
    expect(busEmit).toHaveBeenCalledWith('multitable.record.created', {
      sheetId: SHEET,
      recordId: res.recordId,
      data: { [F_STR]: 'off-created' },
      actorId: ACTOR,
      _eventId: expect.any(String),
    })
    expect(await outboxRowsFor(res.recordId, 'multitable.record.created')).toHaveLength(0)
  })

  test('OFF delete: legacy bus fires with the byte-identical payload shape; zero outbox rows', async () => {
    const R = mkRecord('offdel')
    await seedRecord(R)
    await mkRecordService().deleteRecord({ recordId: R, actorId: ACTOR, access, resolveSheetAccess })
    expect(busEmit).toHaveBeenCalledTimes(1)
    expect(busEmit).toHaveBeenCalledWith('multitable.record.deleted', {
      sheetId: SHEET,
      recordId: R,
      actorId: ACTOR,
      _eventId: expect.any(String),
    })
    expect(await outboxRowsFor(R, 'multitable.record.deleted')).toHaveLength(0)
  })

  test('OFF bulk: legacy bus fires per written record with the byte-identical changes payload; zero outbox rows', async () => {
    const R = mkRecord('offbulk')
    await seedRecord(R)
    await mkWriteService().patchRecords(mkBulkInput(new Map([[R, [{ fieldId: F_STR, value: 'off-bulk' }]]])))
    expect(busEmit).toHaveBeenCalledTimes(1)
    expect(busEmit).toHaveBeenCalledWith('multitable.record.updated', {
      sheetId: SHEET,
      recordId: R,
      changes: { [F_STR]: 'off-bulk' },
      actorId: ACTOR,
      _eventId: expect.any(String),
    })
    expect(await outboxRowsFor(R, 'multitable.record.updated')).toHaveLength(0)
  })
})
