/**
 * B1-G1 — permission golden matrix: Yjs bridge scalar FLUSH × actor tiers + write modifiers (real DB).
 * Spec: W1-2 permission-matrix (docs/development/multitable-w1-2-permission-matrix-spec-20260705.md)
 * §3 gap G-1 / §2 axes A(3-6)×S11×M(2,3,4). Sibling: #3646 (W1-1 formula-freshness design-lock) locks
 * the FRESHNESS angle of this same Yjs-bridge side-door; this batch locks the PERMISSION angle.
 *
 * IMPORTANT CALIBRATION (owner-corrected — this is the point of the batch): the bridge's write input
 * is built via the REAL `resolveSheetCapabilitiesForUser` ("Resolve real user capabilities — same path
 * as REST", index.ts:2471-2473) and flushed through `RecordWriteService.patchRecords`
 * (yjs-record-bridge.ts:222-226) — authorization machinery IS already in place on this path. This is a
 * **test blind spot, not a runtime hole**: the existing yjs-scalar-{flush,seed}-realdb.test.ts suites
 * isolate VALUE FIDELITY (their own `makeGetWriteInput` grants `multitable:write` unconditionally,
 * "since this test isolates value fidelity, not permissions" — see their file comments). Nobody had yet
 * pinned that a non-writer's flush is actually rejected, with zero side effects, via a REAL DB-backed
 * capability resolution instead of a hardcoded grant. These goldens PIN that it stays effective — they
 * do not change it, and they do not claim to close a bypass.
 *
 * Harness is grounded in yjs-scalar-flush-realdb.test.ts / yjs-scalar-seed-realdb.test.ts (bridge +
 * YjsSyncService + RecordWriteService wiring, debounce-then-assert style). The ONE substantive change:
 * `makeGetWriteInput` below calls the REAL `resolveSheetCapabilitiesForUser` (DB-backed RBAC + sheet
 * scope + admin-role), exactly mirroring the production resolver at index.ts:2416-2498, instead of a
 * hardcoded `deriveCapabilities(['multitable:write'])` grant.
 *
 * Actor tiers exercised (permission-service.ts / sheet-capabilities.ts code tables; derive at
 * sheet-capabilities.ts:75-100, sheet-scope override composition at :139-158 (schema grant, which itself
 * composes the record-write grant at :122-137), write-own condition at :291-309 `ensureRecordWriteAllowed`
 * + :280-285 `requiresOwnWriteRowPolicy`):
 *  - A3 global multitable:read only (no write)              → flush DENIED
 *  - A4 sheet-scoped FULL write (`spreadsheet:write` row), no global write → flush ALLOWED (positive
 *    control: proves the bridge honors a REAL per-sheet grant, not just global permissions — a bridge
 *    that only checked global perms would wrongly deny this actor)
 *  - A5 sheet-scoped write-OWN only — own record ALLOWED, not-own record DENIED
 *  - A6 no permissions at all                                → flush DENIED
 *
 * Write modifiers exercised:
 *  - M3 record lock (`locked`/`locked_by`, unconditional `ensureRecordNotLocked` — record-write-
 *    service.ts:806, called inside the SAME `SELECT ... FOR UPDATE` transaction as the write at :776):
 *    a TRUE independent gate — a globally write-capable actor is STILL denied when the record is locked
 *    by someone else. Mirrors LR-T1 (multitable-record-lock.test.ts) via the bridge instead of REST.
 *  - M2 row-level read-deny (`record_permissions` 'none') and M4 conditional rule-deny (`effect:
 *    'deny_read'`) are, by exhaustive grep of every write-path file (record-write-service.ts,
 *    record-service.ts, permission-rule-evaluator.ts's `RuleEffect` type is LITERALLY `'deny_read'` only
 *    — there is no write variant to even express), READ-ONLY constructs — neither is ever consulted to
 *    DENY a write, anywhere in the codebase. So each gets TWO goldens: (a) a NON-WRITER actor's flush
 *    against the annotated target is still denied with zero side effects (defense-in-depth — the
 *    annotation creates no capability-check bypass), and (b) a globally write-capable actor's flush
 *    against the SAME annotated target SUCCEEDS — a documented non-gate, parity with the interactive
 *    REST route, in the same spirit as the permission-matrix ledger's existing non-gate documentation
 *    (docs/development/permission-matrix-golden-20260525.md §2) rather than a claim that M2/M4
 *    independently gate write.
 *  - Property-level (schema) field mask — the "masked-target" case: `RecordWriteService.validateChanges`
 *    (record-write-service.ts:471-512, called at Step 0 of `patchRecords` BEFORE any transaction opens)
 *    throws `RecordFieldForbiddenError` for any field that is `hidden`, `readOnly === true`, or of type
 *    `formula`/`lookup`/`rollup`/`button` — atomically, for the WHOLE flush, not a silent per-field drop.
 *    This is the SAME guard every `patchRecords` caller hits (REST bulk `/patch`, and — independently,
 *    via its own `buildFieldMutationGuardMap` — the REST single-record `PATCH /records/:recordId`, which
 *    throws `RecordPatchFieldValidationError` for the identical field classes). A writer whose flush
 *    touches a masked field alongside a normal field gets BOTH fields rejected — proving the bridge
 *    respects this field-mask exactly the way REST does, not merely "the capability gate happens to be
 *    on."
 *
 * Adjacent finding (OUT OF SCOPE for this batch, not golden-locked here, flagged in the PR body): unlike
 * the property-level guard above, the PER-SUBJECT `field_permissions.read_only` gate (layer-2/3
 * depending on which doc's numbering) is enforced ONLY by three route-level call sites — the bulk
 * `/patch` route's own pre-check (univer-meta.ts ~15723-15739, whose own comment says
 * "RecordWriteService.patchRecords enforces only PROPERTY-level guards ... it does NOT enforce
 * per-subject field_permissions.read_only"), record-copy, and revision-restore. Neither
 * `RecordWriteService.patchRecords` nor `RecordService.patchRecord` (the single-record REST handler)
 * consults `field_permissions` for a write decision at all (verified by reading both). So the bridge is
 * at PARITY with the single-record REST route here (both bypass a per-subject field lock), but that
 * parity is with a route that itself looks like an incomplete rollout rather than M2/M4's confirmed
 * intentional non-gate — this is why it is reported as an adjacent finding rather than asserted as a
 * "documented non-gate" golden the way M2/M4 are.
 *
 * "Zero side effects" = stored `data`/`version` unchanged AND no new `meta_record_revisions` row
 * (patchRecords writes the revision in the SAME transaction as the UPDATE — a thrown
 * RecordValidationError/RecordFieldForbiddenError aborts the whole transaction, and `validateChanges`
 * runs BEFORE the transaction even opens, so a denied write can never partially land). The bridge's own
 * flushNow swallows write errors (fire-and-forget), so `getMetrics()` flushSuccessCount/flushFailureCount
 * is the direct "outcome vocabulary" signal on this entry point (there is no HTTP status code on the
 * bridge path) — asserted alongside the DB state.
 *
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI per the suite convention).
 */
import { EventEmitter } from 'events'
import type { Request } from 'express'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { YjsSyncService } from '../../src/collab/yjs-sync-service'
import { YjsRecordBridge } from '../../src/collab/yjs-record-bridge'
import { RecordWriteService, type RecordPatchInput } from '../../src/multitable/record-write-service'
import { createRecordWriteHelpers } from '../../src/routes/univer-meta'
import { resolveSheetCapabilitiesForUser } from '../../src/multitable/sheet-capabilities'
import { isFieldAlwaysReadOnly } from '../../src/multitable/permission-derivation'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const TS = Date.now()
const BASE_ID = `base_b1g1_${TS}`
const SHEET_ID = `sheet_b1g1_${TS}`
const F_NAME = `fld_b1g1_name_${TS}`
const F_FORMULA = `fld_b1g1_formula_${TS}`

// Actor tiers (each globally unique — never reused with a different permission shape, so the
// in-process RBAC cache in rbac/service.ts never serves a stale result across tests).
const A3_ID = `u_b1g1_a3_${TS}` // global multitable:read only
const A4_ID = `u_b1g1_a4_${TS}` // sheet-scoped spreadsheet:write only (no global write)
const A5_ID = `u_b1g1_a5_${TS}` // sheet-scoped spreadsheet:write-own only
const A6_ID = `u_b1g1_a6_${TS}` // no permissions at all (no users row, no grants)
const WRITER_ID = `u_b1g1_writer_${TS}` // global multitable:write (the "capable actor" control)
const OTHER_ID = `u_b1g1_other_${TS}` // bystander id for created_by/locked_by — never authenticates

// Records (one shared sheet + field; each record is used by exactly one actor-tier test, except
// REC_ROWDENY/REC_RULEDENY which are each used by both the non-writer and control sub-tests).
const REC_A3 = `rec_b1g1_a3_${TS}`
const REC_A4 = `rec_b1g1_a4_${TS}`
const REC_A5_OWN = `rec_b1g1_a5own_${TS}`
const REC_A5_OTHER = `rec_b1g1_a5other_${TS}`
const REC_A6 = `rec_b1g1_a6_${TS}`
const REC_LOCK = `rec_b1g1_lock_${TS}`
const REC_ROWDENY = `rec_b1g1_rowdeny_${TS}`
const REC_RULEDENY = `rec_b1g1_ruledeny_${TS}`
const REC_MASKED = `rec_b1g1_masked_${TS}`

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
      return { id: String(f.id), name: String(f.name), type: f.type as string, property: prop, options: (prop as { options?: unknown }).options, order: Number(f.order ?? 0) }
    })
    // Real field mutation guards via the CANONICAL isFieldAlwaysReadOnly — same as production
    // (index.ts:2438-2460), not a hand-rolled readOnly check.
    const fieldById = new Map(
      fields.map((f) => {
        const prop = (f.property || {}) as Record<string, unknown>
        const isReadOnly = isFieldAlwaysReadOnly(f as never)
        const isHidden = prop.hidden === true || prop.permissionHidden === true
        return [f.id, { type: f.type, readOnly: isReadOnly, hidden: isHidden }] as const
      }),
    )
    const visibleFields = fields.filter((f) => !fieldById.get(f.id)?.hidden)
    const changesByRecord = new Map([
      [recordId, Object.entries(patch).map(([fieldId, value]) => ({ fieldId, value }))],
    ])

    // THE crux of this batch: resolve REAL user capabilities via DB-backed RBAC + sheet scope +
    // admin-role — "same path as REST" (index.ts:2471-2473) — instead of a hardcoded grant.
    const { capabilities, sheetScope, isAdminRole, permissions } = await resolveSheetCapabilitiesForUser(
      poolManager.get().query.bind(poolManager.get()),
      sheetId,
      actorId,
    )

    return {
      sheetId,
      changesByRecord,
      actorId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fields: fields as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      visiblePropertyFields: visibleFields as any,
      visiblePropertyFieldIds: new Set(visibleFields.map((f) => f.id)),
      attachmentFields: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fieldById: fieldById as any,
      capabilities,
      sheetScope,
      access: { userId: actorId, permissions, isAdminRole },
      source: 'yjs-bridge',
    }
  }
}

async function readRecord(recordId: string): Promise<{ data: Record<string, unknown>; version: number }> {
  const r = await q('SELECT data, version FROM meta_records WHERE id = $1', [recordId])
  return r.rows[0] as { data: Record<string, unknown>; version: number }
}

async function revisionCount(recordId: string): Promise<number> {
  const r = await q('SELECT COUNT(*)::int AS n FROM meta_record_revisions WHERE record_id = $1', [recordId])
  return (r.rows[0] as { n: number }).n
}

/** Drive one Y.Doc field edit through the REAL bridge → RecordWriteService.patchRecords spine, as
 * `actorId`, and settle past the debounce window. Returns the bridge so callers can assert
 * getMetrics() success/failure counts (the bridge's only "outcome vocabulary" on this entry point). */
async function driveFlush(recordId: string, actorId: string, patch: Record<string, unknown>): Promise<YjsRecordBridge> {
  const pool = poolManager.get()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const eventBus = new EventEmitter() as any
  const fakeReq = { user: { id: actorId, roles: [], perms: [] } } as unknown as Request
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const helpers = createRecordWriteHelpers(fakeReq, pool as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recordWriteService = new RecordWriteService(pool as any, eventBus, helpers)
  const persistence = { loadDoc: async () => null, storeUpdate: async () => {}, storeSnapshot: async () => {}, destroy: async () => {} }
  const recordSeed = async (rid: string): Promise<Record<string, unknown> | null> => {
    const res = await q('SELECT data FROM meta_records WHERE id = $1', [rid])
    return (res.rows[0]?.data as Record<string, unknown>) ?? null
  }
  const svc = new YjsSyncService(persistence as never, recordSeed)
  const socketId = `socket_${recordId}`
  const bridge = new YjsRecordBridge(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    svc as any,
    recordWriteService,
    makeGetWriteInput(),
    { mergeWindowMs: 30, maxDelayMs: 100 },
    (sid: string) => (sid === socketId ? actorId : 'unknown'),
  )
  try {
    const doc = await svc.getOrCreateDoc(recordId)
    bridge.observe(recordId, doc)
    const fields = doc.getMap('fields')
    doc.transact(() => {
      for (const [key, value] of Object.entries(patch)) fields.set(key, value)
    }, socketId)
    // Wait out the debounce (mergeWindowMs=30) + the async patchRecords settling in Postgres.
    await new Promise((r) => setTimeout(r, 400))
  } finally {
    bridge.unobserve(recordId)
    await svc.destroy()
  }
  return bridge
}

describeIfDatabase('B1-G1 permission golden — Yjs bridge flush × actor tiers + write modifiers (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'B1-G1 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'B1-G1 Sheet'])
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [F_NAME, SHEET_ID, 'Name', 'string', '{}', 1],
    )
    // A formula field is `isFieldAlwaysReadOnly` by TYPE alone (permission-derivation.ts:59) — the
    // universal static-axis guard every patchRecords caller enforces (record-write-service.ts:510
    // rejects type==='formula' unconditionally, regardless of the readOnly flag).
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [F_FORMULA, SHEET_ID, 'Formula', 'formula', JSON.stringify({ expression: '=1+1' }), 2],
    )

    // A3 — global read-only (legacy users.permissions JSONB path, same as multitable-oapi2a-token-
    // write-realdb.test.ts's WRITER/RO fixtures; no FK, no permissions-table pre-seed needed).
    await q(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1,$2,$1,'x','member',$3::jsonb, TRUE, FALSE) ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`,
      [A3_ID, `${A3_ID}@t.local`, JSON.stringify(['multitable:read'])],
    )
    // WRITER — global write-capable control actor for the M3/M2/M4/masked-field modifier goldens.
    await q(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1,$2,$1,'x','member',$3::jsonb, TRUE, FALSE) ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`,
      [WRITER_ID, `${WRITER_ID}@t.local`, JSON.stringify(['multitable:write'])],
    )
    // A4 / A5 — SHEET-SCOPED grants only (no global permission, no users row needed:
    // spreadsheet_permissions.subject_id carries no FK, mirroring multitable-permission-golden-
    // d3d2.test.ts's write-intersection / write-own fixtures).
    await q('INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,$2,$3,$4)', [SHEET_ID, 'user', A4_ID, 'spreadsheet:write'])
    await q('INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,$2,$3,$4)', [SHEET_ID, 'user', A5_ID, 'spreadsheet:write-own'])
    // A6 — deliberately NO users row and NO grant of any kind (zero permissions is the natural
    // fallback of listUserPermissions/isAdmin against a completely unknown actor id).

    const seed = (recordId: string, createdBy: string, value: string) =>
      q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [recordId, SHEET_ID, JSON.stringify({ [F_NAME]: value }), createdBy])

    await seed(REC_A3, OTHER_ID, 'before-a3')
    await seed(REC_A4, OTHER_ID, 'before-a4')
    await seed(REC_A5_OWN, A5_ID, 'before-a5own')
    await seed(REC_A5_OTHER, OTHER_ID, 'before-a5other')
    await seed(REC_A6, OTHER_ID, 'before-a6')
    await seed(REC_LOCK, OTHER_ID, 'before-lock')
    await q('UPDATE meta_records SET locked = true, locked_by = $2, locked_at = now() WHERE id = $1', [REC_LOCK, OTHER_ID]) // NOT WRITER_ID — WRITER is neither locker nor owner

    await seed(REC_ROWDENY, OTHER_ID, 'before-rowdeny')
    await seed(REC_RULEDENY, OTHER_ID, 'secret') // matches the deny_read rule below on F_NAME='secret'
    await seed(REC_MASKED, OTHER_ID, 'before-masked')

    // M2 fixture — row-level read-deny 'none', scoped to BOTH A6 (non-writer sub-test) and WRITER
    // (documented-non-gate control sub-test). Flag ON so the deny is genuinely "live" for reads.
    await q('UPDATE meta_sheets SET row_level_read_permissions_enabled = TRUE WHERE id = $1', [SHEET_ID])
    await q('INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level) VALUES ($1,$2,$3,$4,$5)', [SHEET_ID, REC_ROWDENY, 'user', A6_ID, 'none'])
    await q('INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level) VALUES ($1,$2,$3,$4,$5)', [SHEET_ID, REC_ROWDENY, 'user', WRITER_ID, 'none'])

    // M4 fixture — sheet-level conditional deny_read rule matching REC_RULEDENY's F_NAME='secret'.
    // Same sheet flag as M2 (already flipped ON above) is what the rule evaluator also gates on.
    await q(
      'UPDATE meta_sheets SET conditional_read_rules = $2::jsonb WHERE id = $1',
      [SHEET_ID, JSON.stringify([{ id: 'r1', fieldId: F_NAME, operator: 'eq', value: 'secret', effect: 'deny_read' }])],
    )
  })

  afterAll(async () => {
    await q('DELETE FROM record_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[A3_ID, WRITER_ID]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set (real DB run, not skipped)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('A3 (global multitable:read only, no write): flush is denied, zero side effects', async () => {
    const bridge = await driveFlush(REC_A3, A3_ID, { [F_NAME]: 'a3-attempt' })
    expect(bridge.getMetrics().flushFailureCount).toBeGreaterThanOrEqual(1)
    const stored = await readRecord(REC_A3)
    expect(stored.data[F_NAME]).toBe('before-a3')
    expect(stored.version).toBe(1)
    expect(await revisionCount(REC_A3)).toBe(0)
  })

  test('A4 (sheet-scoped spreadsheet:write grant only, no global write): flush is ALLOWED — the bridge resolves a REAL per-sheet grant, not just global permissions', async () => {
    const bridge = await driveFlush(REC_A4, A4_ID, { [F_NAME]: 'a4-write' })
    expect(bridge.getMetrics().flushSuccessCount).toBeGreaterThanOrEqual(1)
    const stored = await readRecord(REC_A4)
    expect(stored.data[F_NAME]).toBe('a4-write')
    expect(stored.version).toBe(2)
  })

  test('A5 (sheet-scoped spreadsheet:write-own only) — OWN record: flush is ALLOWED', async () => {
    const bridge = await driveFlush(REC_A5_OWN, A5_ID, { [F_NAME]: 'a5-own-write' })
    expect(bridge.getMetrics().flushSuccessCount).toBeGreaterThanOrEqual(1)
    const stored = await readRecord(REC_A5_OWN)
    expect(stored.data[F_NAME]).toBe('a5-own-write')
    expect(stored.version).toBe(2)
  })

  test('A5 (sheet-scoped spreadsheet:write-own only) — NOT-OWN record: flush is denied, zero side effects', async () => {
    const bridge = await driveFlush(REC_A5_OTHER, A5_ID, { [F_NAME]: 'a5-notown-attempt' })
    expect(bridge.getMetrics().flushFailureCount).toBeGreaterThanOrEqual(1)
    const stored = await readRecord(REC_A5_OTHER)
    expect(stored.data[F_NAME]).toBe('before-a5other')
    expect(stored.version).toBe(1)
    expect(await revisionCount(REC_A5_OTHER)).toBe(0)
  })

  test('A6 (no permissions at all): flush is denied, zero side effects', async () => {
    const bridge = await driveFlush(REC_A6, A6_ID, { [F_NAME]: 'a6-attempt' })
    expect(bridge.getMetrics().flushFailureCount).toBeGreaterThanOrEqual(1)
    const stored = await readRecord(REC_A6)
    expect(stored.data[F_NAME]).toBe('before-a6')
    expect(stored.version).toBe(1)
    expect(await revisionCount(REC_A6)).toBe(0)
  })

  test('M3 (record lock): a globally write-capable actor flushing a LOCKED record (locked by someone else) is denied, zero side effects — the lock gate applies on the bridge path too', async () => {
    const bridge = await driveFlush(REC_LOCK, WRITER_ID, { [F_NAME]: 'writer-sneaky-edit' })
    expect(bridge.getMetrics().flushFailureCount).toBeGreaterThanOrEqual(1)
    const stored = await readRecord(REC_LOCK)
    expect(stored.data[F_NAME]).toBe('before-lock')
    expect(stored.version).toBe(1)
    expect(await revisionCount(REC_LOCK)).toBe(0)
  })

  test('M2 (row-level read-deny target) + non-writer actor: flush is denied, zero side effects (defense-in-depth — the row-deny annotation opens no bypass of the capability gate)', async () => {
    const bridge = await driveFlush(REC_ROWDENY, A6_ID, { [F_NAME]: 'a6-rowdeny-attempt' })
    expect(bridge.getMetrics().flushFailureCount).toBeGreaterThanOrEqual(1)
    const stored = await readRecord(REC_ROWDENY)
    expect(stored.data[F_NAME]).toBe('before-rowdeny')
    expect(stored.version).toBe(1)
  })

  test('M2 (row-level read-deny target) + globally write-capable actor: flush SUCCEEDS — documented non-gate (row-level read-deny is READ-only; RecordWriteService never consults record_permissions)', async () => {
    const bridge = await driveFlush(REC_ROWDENY, WRITER_ID, { [F_NAME]: 'writer-rowdeny-write' })
    expect(bridge.getMetrics().flushSuccessCount).toBeGreaterThanOrEqual(1)
    const stored = await readRecord(REC_ROWDENY)
    expect(stored.data[F_NAME]).toBe('writer-rowdeny-write')
    expect(stored.version).toBe(2)
  })

  test('M4 (conditional-rule-denied target) + non-writer actor: flush is denied, zero side effects (defense-in-depth)', async () => {
    const bridge = await driveFlush(REC_RULEDENY, A6_ID, { [F_NAME]: 'a6-ruledeny-attempt' })
    expect(bridge.getMetrics().flushFailureCount).toBeGreaterThanOrEqual(1)
    const stored = await readRecord(REC_RULEDENY)
    expect(stored.data[F_NAME]).toBe('secret')
    expect(stored.version).toBe(1)
  })

  test('M4 (conditional-rule-denied target) + globally write-capable actor: flush SUCCEEDS — documented non-gate (conditional rules are deny_read-only by type; RuleEffect has no write variant)', async () => {
    const bridge = await driveFlush(REC_RULEDENY, WRITER_ID, { [F_NAME]: 'writer-ruledeny-write' })
    expect(bridge.getMetrics().flushSuccessCount).toBeGreaterThanOrEqual(1)
    const stored = await readRecord(REC_RULEDENY)
    expect(stored.data[F_NAME]).toBe('writer-ruledeny-write')
    expect(stored.version).toBe(2)
  })

  test('masked-target (property-level field mask) + globally write-capable actor: a flush touching a formula (isFieldAlwaysReadOnly) field alongside a normal field is REJECTED ATOMICALLY — zero side effects on EITHER field, matching REST (both the bulk /patch route\'s RecordWriteService.patchRecords and the single-record PATCH route\'s RecordService.patchRecord throw for the identical field classes)', async () => {
    const bridge = await driveFlush(REC_MASKED, WRITER_ID, { [F_NAME]: 'writer-masked-attempt', [F_FORMULA]: 'malicious-formula-write' })
    expect(bridge.getMetrics().flushFailureCount).toBeGreaterThanOrEqual(1)
    const stored = await readRecord(REC_MASKED)
    expect(stored.data[F_NAME]).toBe('before-masked') // the NORMAL field did NOT sneak through
    expect(stored.data[F_FORMULA]).toBeUndefined()
    expect(stored.version).toBe(1)
    expect(await revisionCount(REC_MASKED)).toBe(0)
  })
})
