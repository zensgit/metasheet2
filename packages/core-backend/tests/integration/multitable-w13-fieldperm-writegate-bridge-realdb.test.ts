/**
 * W1-3 GW1/GW2/GW3 — Layer-3 per-subject field-WRITE gate on the Yjs collaborative-edit BRIDGE (real DB).
 * Design-lock: docs/development/multitable-per-subject-field-write-gate-w13-designlock-20260705.md
 * (RATIFIED, merged 470250e1a). §4 golden matrix, GW1 (headline) / GW2 / GW3.
 *
 * The gap this closes: the bridge's write-input builder (index.ts, inside the Yjs setup block) filters
 * `visibleFields` on `hidden` only and resolves capabilities via `resolveSheetCapabilitiesForUser`, but
 * previously returned the write input straight to `patchRecords` with NO `fieldPermissions` derive and NO
 * layer-3 gate — so a field marked read-only for a SPECIFIC actor via `field_permissions` was blocked on
 * the everyday grid `/patch` but silently writable by that same actor through the collab channel.
 *
 * `makeGetWriteInput` below is NOT a reimplementation of the gate's DECISION logic — it imports and calls
 * the REAL `isFieldWriteForbidden` / `deriveFieldPermissions` / `loadFieldPermissionScopeMap` from the
 * actual production modules (`permission-derivation.ts` / `permission-service.ts`), the same functions the
 * fixed `index.ts` write-input builder now calls. Only the SQL-fetch PLUMBING (load fields, build the
 * static guard map) is mirrored — it cannot be imported directly since the real builder is an inline
 * closure inside the app's Yjs bootstrap block, not an exported function. This avoids the classic
 * wire-vs-fixture drift trap: the boolean DECISION under test is the real shared code, not a hand-rolled
 * copy that could silently diverge from production.
 *
 * "Zero side effects" = stored `data`/`version` unchanged AND no new `meta_record_revisions` row. The
 * bridge's own flushNow swallows write errors (fire-and-forget); `getMetrics()` flushSuccessCount /
 * flushFailureCount is the only "outcome vocabulary" on this entry point (no HTTP status code here) —
 * asserted alongside DB state, per F4's throw-not-null requirement (a null-return would land in neither
 * counter — see the design-lock's F4 rationale and the non-vacuousness proof run alongside this file).
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
import { loadFieldPermissionScopeMap } from '../../src/multitable/permission-service'
import {
  isFieldAlwaysReadOnly,
  deriveFieldPermissions,
  isFieldWriteForbidden,
  FieldWritePermissionDeniedError,
} from '../../src/multitable/permission-derivation'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const TS = Date.now()
const BASE_ID = `base_w13gw_${TS}`
const SHEET_ID = `sheet_w13gw_${TS}`
const F_OPEN = `fld_w13gw_open_${TS}` // normal, writable by everyone
const F_LOCKED = `fld_w13gw_locked_${TS}` // per-subject read_only for RESTRICTED_ID only

const RESTRICTED_ID = `u_w13gw_restricted_${TS}` // global multitable:write; F_LOCKED read_only=true FOR THIS SUBJECT
const UNRESTRICTED_ID = `u_w13gw_unrestricted_${TS}` // global multitable:write; no field_permissions row at all

const REC_GW1 = `rec_w13gw_gw1_${TS}`
const REC_GW2 = `rec_w13gw_gw2_${TS}`
const REC_GW3 = `rec_w13gw_gw3_${TS}`
const REC_REGRESSION = `rec_w13gw_regress_${TS}`

/**
 * Mirrors the FIXED production write-input builder (index.ts, Yjs bridge registration) exactly for the
 * decision logic: loads fields, builds the static guard map via the canonical `isFieldAlwaysReadOnly`
 * (same as production), resolves REAL capabilities via `resolveSheetCapabilitiesForUser`, then derives
 * `fieldPermissions` via the REAL `deriveFieldPermissions` + a REAL `loadFieldPermissionScopeMap` read, and
 * — the crux of this batch — filters the CHANGED field ids through the REAL `isFieldWriteForbidden`. A
 * forbidden write THROWS `FieldWritePermissionDeniedError` (not null) so `executePatch`'s `.catch` counts
 * it as a failed flush, exactly mirroring the production fix.
 */
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

    const { capabilities, sheetScope, isAdminRole, permissions } = await resolveSheetCapabilitiesForUser(
      poolManager.get().query.bind(poolManager.get()),
      sheetId,
      actorId,
    )

    // THE crux of this batch (W1-3 F1/F3/F4): the layer-3 per-subject gate, via the REAL shared helpers.
    const fieldScopeMap = await loadFieldPermissionScopeMap(poolManager.get().query.bind(poolManager.get()), sheetId, actorId)
    const fieldPermissions = deriveFieldPermissions(visibleFields as never, capabilities, { fieldScopeMap })
    const forbiddenWriteFieldIds = Object.keys(patch).filter((fid) => isFieldWriteForbidden(fieldPermissions[fid]))
    if (forbiddenWriteFieldIds.length > 0) {
      throw new FieldWritePermissionDeniedError()
    }

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
 * getMetrics() success/failure counts. */
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

describeIfDatabase('W1-3 GW1/GW2/GW3 — layer-3 per-subject field-write gate on the Yjs bridge (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'W1-3 GW Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'W1-3 GW Sheet'])
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [F_OPEN, SHEET_ID, 'Open', 'string', '{}', 1],
    )
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [F_LOCKED, SHEET_ID, 'Locked', 'string', '{}', 2],
    )

    // Both actors globally write-capable — isolates the PER-SUBJECT axis (the point of GW2: proves the
    // gate is per-subject, not a blanket bridge block).
    await q(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1,$2,$1,'x','member',$3::jsonb, TRUE, FALSE) ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`,
      [RESTRICTED_ID, `${RESTRICTED_ID}@t.local`, JSON.stringify(['multitable:write'])],
    )
    await q(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1,$2,$1,'x','member',$3::jsonb, TRUE, FALSE) ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`,
      [UNRESTRICTED_ID, `${UNRESTRICTED_ID}@t.local`, JSON.stringify(['multitable:write'])],
    )
    // F_LOCKED is read-only for RESTRICTED_ID specifically (visible, but not writable) — NO row for
    // UNRESTRICTED_ID at all.
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, F_LOCKED, 'user', RESTRICTED_ID, true, true])

    const seed = (recordId: string, value: string) =>
      q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [recordId, SHEET_ID, JSON.stringify({ [F_OPEN]: 'orig-open', [F_LOCKED]: value })])
    await seed(REC_GW1, 'before-gw1')
    await seed(REC_GW2, 'before-gw2')
    await seed(REC_GW3, 'before-gw3')
    await seed(REC_REGRESSION, 'before-regress')
  })

  afterAll(async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[RESTRICTED_ID, UNRESTRICTED_ID]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set (real DB run, not skipped)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('GW1 (headline): per-subject read-only field written via the Yjs bridge → flush REJECTED, zero side effects', async () => {
    const bridge = await driveFlush(REC_GW1, RESTRICTED_ID, { [F_LOCKED]: 'gw1-attempt' })
    expect(bridge.getMetrics().flushFailureCount).toBeGreaterThanOrEqual(1)
    const stored = await readRecord(REC_GW1)
    expect(stored.data[F_LOCKED]).toBe('before-gw1') // unchanged
    expect(stored.version).toBe(1) // no version bump
    expect(await revisionCount(REC_GW1)).toBe(0) // no revision row
  })

  test('GW2: the SAME field written via the bridge by an UNRESTRICTED actor → lands (proves per-subject, not blanket)', async () => {
    const bridge = await driveFlush(REC_GW2, UNRESTRICTED_ID, { [F_LOCKED]: 'gw2-write' })
    expect(bridge.getMetrics().flushSuccessCount).toBeGreaterThanOrEqual(1)
    const stored = await readRecord(REC_GW2)
    expect(stored.data[F_LOCKED]).toBe('gw2-write')
    expect(stored.version).toBe(2)
  })

  test('GW3: mixed bridge flush (forbidden F_LOCKED + allowed F_OPEN on one record) → BOTH rejected atomically', async () => {
    const bridge = await driveFlush(REC_GW3, RESTRICTED_ID, { [F_OPEN]: 'should-not-persist', [F_LOCKED]: 'gw3-attempt' })
    expect(bridge.getMetrics().flushFailureCount).toBeGreaterThanOrEqual(1)
    const stored = await readRecord(REC_GW3)
    expect(stored.data[F_OPEN]).toBe('orig-open') // the NORMAL field did NOT sneak through
    expect(stored.data[F_LOCKED]).toBe('before-gw3')
    expect(stored.version).toBe(1)
    expect(await revisionCount(REC_GW3)).toBe(0)
  })

  test('regression guard: the SAME restricted actor writing ONLY the normal field (F_OPEN) via the bridge still lands (not a block-all)', async () => {
    const bridge = await driveFlush(REC_REGRESSION, RESTRICTED_ID, { [F_OPEN]: 'regress-write' })
    expect(bridge.getMetrics().flushSuccessCount).toBeGreaterThanOrEqual(1)
    const stored = await readRecord(REC_REGRESSION)
    expect(stored.data[F_OPEN]).toBe('regress-write')
    expect(stored.version).toBe(2)
  })
})
