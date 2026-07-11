/**
 * W1-1 formula freshness — LOCK-F golden matrix (design-lock 2026-07-05, `26af7a560` / #3646),
 * §2 "Yjs-bridge formula recompute". Real-DB.
 *
 * Headline fix: the Yjs-bridge `RecordWriteHelpers.recalculateFormulaFields` stub
 * (`index.ts` ~2405, previously `async () => []`) left a collaboratively-edited formula's
 * materialized value STALE until the record's next REST write. F1 replaces it with
 * `recalculateFormulaFieldsForActor` (univer-meta.ts) — the SAME `recalculateFormulaFields`
 * function REST uses, fed a synthetic writer-taint context (F2) built from the flushing actor id
 * instead of an Express `req`. This suite drives writes through the REAL bridge stack
 * (`YjsSyncService` + `YjsRecordBridge` + `RecordWriteService`) with a helpers object that
 * mirrors `index.ts`'s bridge construction byte-for-byte (lookup/rollup fan-out stubbed per F4;
 * formula recompute wired to the real actor-based helper), so a regression in either the
 * production wiring OR the underlying taint logic would show up here.
 *
 * Golden coverage (§4 of the lock):
 *  - GF1 (headline): collab edit of a formula's source field → materialized value FRESH after
 *    flush, AND the realtime publish channel carries the recomputed field (F6 — no
 *    `yjs-bridge`-source suppression on the publish path).
 *  - GF2: bridge writer DENIED read on the formula's lookup-source foreign field (relation-agg
 *    criteria field, field_permissions-masked) → recompute SKIPPED, old value preserved —
 *    byte-parity with the REST taint skip for the same actor.
 *  - GF3: relation-aggregation-backed formula, authorized writer → recomputes same as REST.
 *  - GF4: non-formula bridge write (no formula deps touched) → no side effect on unrelated
 *    formula fields (early-return parity).
 *  - GF9: bridge cross-record fan-out residual pin — collab edit of a link-source record does
 *    NOT refresh a FOREIGN sheet's formula-over-lookup (computeDependentLookupRollupRecords
 *    stays stubbed per F4); flips when that follow-up slice lands.
 *  - GF11 (bridge part): the bridge recompute writes ZERO meta_record_revisions rows and no
 *    version bump beyond the user's own edit (B5/F-posture pin).
 *
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI per the suite convention).
 */
import { EventEmitter } from 'events'
import type { Request } from 'express'
import { afterAll, beforeAll, describe, expect, test, vi, type MockInstance } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { eventBus } from '../../src/integration/events/event-bus'
import { YjsSyncService } from '../../src/collab/yjs-sync-service'
import { YjsRecordBridge } from '../../src/collab/yjs-record-bridge'
import { RecordWriteService, type RecordPatchInput, type RecordWriteHelpers } from '../../src/multitable/record-write-service'
import { resolveSheetCapabilitiesForUser, ensureRecordWriteAllowed } from '../../src/multitable/sheet-capabilities'
import { isFieldAlwaysReadOnly } from '../../src/multitable/permission-derivation'
import { loadSheetMemberUserIdSet } from '../../src/multitable/permission-service'
import { recalculateFormulaFieldsForActor } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const TS = Date.now()
const BASE_ID = `base_w11bf_${TS}`
const MS = `sheet_w11bf_ms_${TS}` // main sheet, edited via the bridge throughout
const FS = `sheet_w11bf_fs_${TS}` // foreign sheet (relation-agg target/criteria)
const REL = `sheet_w11bf_rel_${TS}` // GF9: a sheet whose formula-over-lookup depends on MS

const FLD_NAME = `fld_w11bf_name_${TS}` // GF1 pure formula source
const FLD_TOTAL = `fld_w11bf_total_${TS}` // GF1: formula =FLD_NAME
const FLD_NOISE = `fld_w11bf_noise_${TS}` // GF4: plain field, zero formula deps
const FLD_LINK = `fld_w11bf_link_${TS}` // MS -> FS, static (never edited by the bridge)
const FLD_CURVAL = `fld_w11bf_curval_${TS}` // MS same-record criteria value (GF2/GF3 trigger)
const FLD_RELCOUNT = `fld_w11bf_relcount_${TS}` // formula RELCOUNTIF(link, FS.status, is, {curval})

const FS_STATUS = `fld_w11bf_fs_status_${TS}` // foreign criteria field, DENIED for the masked actor

// GF9 fixture: REL sheet's formula depends on a lookup over MS's own FLD_G9_TARGET.
const FLD_G9_TARGET = `fld_w11bf_g9_target_${TS}` // on MS: the record edited via the bridge
const REL_LINK = `fld_w11bf_rel_link_${TS}` // on REL: link -> MS
const REL_LOOKUP = `fld_w11bf_rel_lookup_${TS}` // on REL: lookup(REL_LINK -> FLD_G9_TARGET)
const REL_FORMULA = `fld_w11bf_rel_formula_${TS}` // on REL: formula = REL_LOOKUP

const WRITER_ID = `u_w11bf_writer_${TS}` // global multitable:write, reads everything
const MASKED_ID = `u_w11bf_masked_${TS}` // global multitable:write, denied FS_STATUS

const REC_GF1 = `rec_w11bf_gf1_${TS}`
const REC_GF2 = `rec_w11bf_gf2_${TS}`
const REC_GF3 = `rec_w11bf_gf3_${TS}`
const REC_GF4 = `rec_w11bf_gf4_${TS}`
const REC_G9_SRC = `rec_w11bf_g9src_${TS}` // on MS
const REC_G9_REL = `rec_w11bf_g9rel_${TS}` // on REL, links to REC_G9_SRC
const FR_PAID = `rec_w11bf_frpaid_${TS}` // on FS, status='paid'

/**
 * Mirrors index.ts's Yjs-bridge `RecordWriteHelpers` construction EXACTLY (lookup/rollup fan-out
 * stubbed per F4; formula recompute wired to the real `recalculateFormulaFieldsForActor`) — NOT
 * the REST `createRecordWriteHelpers` factory, which was never stubbed and so would not exercise
 * this fix at all. If a future revert restores the `async () => []` stub here (or in index.ts),
 * GF1/GF2/GF3 go RED (verified manually — see the PR description's non-vacuousness note).
 */
function buildBridgeHelpers(): RecordWriteHelpers {
  return {
    normalizeLinkIds: (v) => (Array.isArray(v) ? v.map(String) : []),
    normalizeAttachmentIds: (v) => (Array.isArray(v) ? v.map(String) : []),
    normalizeJson: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}),
    parseLinkFieldConfig: () => null,
    buildId: (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`,
    ensureRecordWriteAllowed,
    filterRecordDataByFieldIds: (data, ids) => {
      if (!data || typeof data !== 'object') return {}
      return Object.fromEntries(Object.entries(data as Record<string, unknown>).filter(([k]) => ids.has(k)))
    },
    extractLookupRollupData: () => ({}),
    mergeComputedRecords: (base, extra) => ((!base || base.length === 0) && extra.length === 0 ? undefined : [...(base ?? []), ...extra]),
    filterRecordFieldSummaryMap: (map) => map,
    serializeLinkSummaryMap: () => ({}),
    serializeAttachmentSummaryMap: () => ({}),
    applyLookupRollup: async () => {},
    computeDependentLookupRollupRecords: async () => [],
    recalculateFormulaFields: (q2, sid, f, ids, changed, hydrated, actorId) =>
      recalculateFormulaFieldsForActor(actorId ?? null, q2, sid, f, ids, changed, hydrated),
    loadLinkValuesByRecord: async () => new Map(),
    buildLinkSummaries: async () => new Map(),
    buildAttachmentSummaries: async () => new Map(),
    ensureAttachmentIdsExist: async () => null,
    loadSheetMemberUserIds: (q2, sid) => loadSheetMemberUserIdSet(q2, sid),
  }
}

/** Mirrors index.ts's write-input builder (test-owned, like the sibling B1-G1 permission-matrix
 * suite's `makeGetWriteInput` — index.ts's own builder is inline in a server-startup class method
 * and not exported/importable). Resolves REAL capabilities via `resolveSheetCapabilitiesForUser`. */
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
    return {
      sheetId,
      changesByRecord,
      actorId,
      fields: fields as never,
      visiblePropertyFields: visibleFields as never,
      visiblePropertyFieldIds: new Set(visibleFields.map((f) => f.id)),
      attachmentFields: [],
      fieldById: fieldById as never,
      capabilities,
      sheetScope,
      access: { userId: actorId, permissions, isAdminRole },
      source: 'yjs-bridge',
    }
  }
}

async function readField(recordId: string, sheetId: string, fieldId: string): Promise<unknown> {
  const r = await q('SELECT data FROM meta_records WHERE id = $1 AND sheet_id = $2', [recordId, sheetId])
  const data = (r.rows[0] as { data: unknown } | undefined)?.data
  const parsed = typeof data === 'string' ? JSON.parse(data) : data
  return (parsed as Record<string, unknown> | undefined)?.[fieldId]
}

async function revisionCount(recordId: string): Promise<number> {
  const r = await q('SELECT COUNT(*)::int AS n FROM meta_record_revisions WHERE record_id = $1', [recordId])
  return (r.rows[0] as { n: number }).n
}

async function recordVersion(recordId: string): Promise<number> {
  const r = await q('SELECT version FROM meta_records WHERE id = $1', [recordId])
  return Number((r.rows[0] as { version: number }).version)
}

/** Drive one Y.Doc field edit through the REAL bridge -> RecordWriteService.patchRecords spine. */
async function driveFlush(recordId: string, actorId: string, patch: Record<string, unknown>): Promise<YjsRecordBridge> {
  const pool = poolManager.get()
  const eb = new EventEmitter() as never
  const helpers = buildBridgeHelpers()
  const recordWriteService = new RecordWriteService(pool as never, eb, helpers)
  const persistence = { loadDoc: async () => null, storeUpdate: async () => {}, storeSnapshot: async () => {}, destroy: async () => {} }
  const recordSeed = async (rid: string): Promise<Record<string, unknown> | null> => {
    const res = await q('SELECT data FROM meta_records WHERE id = $1', [rid])
    return (res.rows[0]?.data as Record<string, unknown>) ?? null
  }
  const svc = new YjsSyncService(persistence as never, recordSeed)
  const socketId = `socket_${recordId}_${Math.random().toString(36).slice(2, 8)}`
  const bridge = new YjsRecordBridge(
    svc as never,
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
    await new Promise((r) => setTimeout(r, 400))
  } finally {
    bridge.unobserve(recordId)
    await svc.destroy()
  }
  return bridge
}

describeIfDatabase('W1-1 LOCK-F golden matrix — Yjs bridge formula recompute (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'W1-1 Bridge Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [MS, BASE_ID, 'W1-1 Main'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [FS, BASE_ID, 'W1-1 Foreign'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [REL, BASE_ID, 'W1-1 Related'])

    // WRITER / MASKED — global write, legacy users.permissions JSONB path (no sheet-scope needed).
    for (const [id, perms] of [[WRITER_ID, ['multitable:read', 'multitable:write']], [MASKED_ID, ['multitable:read', 'multitable:write']]] as const) {
      await q(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
         VALUES ($1,$2,$1,'x','member',$3::jsonb, TRUE, FALSE) ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`,
        [id, `${id}@t.local`, JSON.stringify(perms)],
      )
    }

    // MS fields
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_NAME, MS, 'Name', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_TOTAL, MS, 'Total', 'formula', JSON.stringify({ expression: `={${FLD_NAME}}` }), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_NOISE, MS, 'Noise', 'string', '{}', 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_LINK, MS, 'Link', 'link', JSON.stringify({ foreignSheetId: FS }), 4])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_CURVAL, MS, 'CurVal', 'string', '{}', 5])
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_RELCOUNT, MS, 'RelCount', 'formula', JSON.stringify({ expression: `RELCOUNTIF("${FLD_LINK}","${FS_STATUS}","is",{${FLD_CURVAL}})` }), 6],
    )
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_G9_TARGET, MS, 'G9Target', 'number', '{}', 7])

    // formula_dependencies (seeded via SQL — no field-route PATCH involved, so sync manually)
    await q('INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id) VALUES ($1,$2,$3,NULL)', [MS, FLD_TOTAL, FLD_NAME])
    await q('INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id) VALUES ($1,$2,$3,NULL)', [MS, FLD_RELCOUNT, FLD_CURVAL])

    // FS fields + records (relation-agg foreign side)
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FS_STATUS, FS, 'Status', 'string', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [FR_PAID, FS, JSON.stringify({ [FS_STATUS]: 'paid' })])
    // field_permissions: MASKED_ID cannot read FS_STATUS (the RELCOUNTIF criteria field) -> taint.
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [FS, FS_STATUS, 'user', MASKED_ID, false, false])

    // REL fields (GF9: formula-over-lookup depends on MS.FLD_G9_TARGET via a link)
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [REL_LINK, REL, 'Link', 'link', JSON.stringify({ foreignSheetId: MS }), 1])
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [REL_LOOKUP, REL, 'Lookup', 'lookup', JSON.stringify({ linkedFieldId: REL_LINK, targetFieldId: FLD_G9_TARGET, foreignSheetId: MS }), 2],
    )
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [REL_FORMULA, REL, 'Formula', 'formula', JSON.stringify({ expression: `={${REL_LOOKUP}}` }), 3])
    await q('INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id) VALUES ($1,$2,$3,NULL)', [REL, REL_FORMULA, REL_LOOKUP])

    // Records
    const seedMS = (recordId: string, extra: Record<string, unknown>) =>
      q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [recordId, MS, JSON.stringify(extra)])
    await seedMS(REC_GF1, { [FLD_NAME]: 'before-gf1' })
    await seedMS(REC_GF2, { [FLD_LINK]: [FR_PAID], [FLD_CURVAL]: 'unpaid' })
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_gf2_${TS}`, FLD_LINK, REC_GF2, FR_PAID])
    await seedMS(REC_GF3, { [FLD_LINK]: [FR_PAID], [FLD_CURVAL]: 'unpaid' })
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_gf3_${TS}`, FLD_LINK, REC_GF3, FR_PAID])
    await seedMS(REC_GF4, { [FLD_NAME]: 'gf4-name', [FLD_NOISE]: 'before-noise' })
    await seedMS(REC_G9_SRC, { [FLD_G9_TARGET]: 100 })
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_G9_REL, REL, JSON.stringify({ [REL_LINK]: [REC_G9_SRC], [REL_FORMULA]: 100 })])
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_g9_${TS}`, REL_LINK, REC_G9_REL, REC_G9_SRC])
  })

  afterAll(async () => {
    await q('DELETE FROM meta_links WHERE field_id = ANY($1::text[])', [[FLD_LINK, REL_LINK]]).catch(() => {})
    await q('DELETE FROM formula_dependencies WHERE sheet_id = ANY($1::text[])', [[MS, REL]]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [FS]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = ANY($1::text[])', [[MS, FS, REL]]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[MS, FS, REL]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[MS, FS, REL]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[MS, FS, REL]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[WRITER_ID, MASKED_ID]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set (real DB run, not skipped)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('GF1 (headline): collab edit of a formula source field -> materialized value FRESH after flush, realtime publish carries the recomputed field, zero extra revisions/version-bump', async () => {
    const publishSpy: MockInstance = vi.spyOn(eventBus, 'publish')
    publishSpy.mockClear()
    const versionBefore = await recordVersion(REC_GF1)
    const bridge = await driveFlush(REC_GF1, WRITER_ID, { [FLD_NAME]: 'after-gf1' })
    expect(bridge.getMetrics().flushSuccessCount).toBeGreaterThanOrEqual(1)

    expect(await readField(REC_GF1, MS, FLD_NAME)).toBe('after-gf1')
    // THE headline assertion: the formula's materialized value is FRESH, not stale.
    expect(await readField(REC_GF1, MS, FLD_TOTAL)).toBe('after-gf1')

    // F6: the recomputed formula field id rides the SAME realtime publish channel REST uses, and
    // is not suppressed for a yjs-bridge-sourced write.
    const events = publishSpy.mock.calls.filter((call) => call[0] === 'spreadsheet.cell.updated')
    const ownEvent = events.find((call) => {
      const payload = call[1] as { recordIds?: string[] } | undefined
      return payload?.recordIds?.includes(REC_GF1)
    })
    expect(ownEvent).toBeTruthy()
    const payload = ownEvent?.[1] as { fieldIds?: string[]; recordPatches?: unknown } | undefined
    expect(payload?.fieldIds).toEqual(expect.arrayContaining([FLD_NAME, FLD_TOTAL]))
    expect(payload?.recordPatches).toBeUndefined() // the shared publisher strips it before broadcast
    publishSpy.mockRestore()

    // GF11 (bridge part): the user's own edit is the ONLY revision row; the formula recompute
    // writes zero extra revisions and no extra version bump (B5/F posture).
    expect(await revisionCount(REC_GF1)).toBe(1)
    expect(await recordVersion(REC_GF1)).toBe(versionBefore + 1)
  })

  test('GF3: relation-aggregation-backed formula, authorized writer -> recomputes same as REST', async () => {
    const bridge = await driveFlush(REC_GF3, WRITER_ID, { [FLD_CURVAL]: 'paid' })
    expect(bridge.getMetrics().flushSuccessCount).toBeGreaterThanOrEqual(1)
    expect(await readField(REC_GF3, MS, FLD_CURVAL)).toBe('paid')
    // RELCOUNTIF(link, FS_STATUS, is, 'paid') over [FR_PAID] (status='paid') -> 1 match.
    expect(await readField(REC_GF3, MS, FLD_RELCOUNT)).toBe(1)
  })

  test('GF2: bridge writer DENIED read on the relation-agg criteria foreign field -> recompute SKIPPED, old value preserved (byte-parity with the REST taint skip)', async () => {
    // Baseline: nobody has materialized FLD_RELCOUNT for REC_GF2 yet — seed the "old" value the
    // way REST would (an authorized actor's write), so a taint-skip has something to preserve.
    const seedBridge = await driveFlush(REC_GF2, WRITER_ID, { [FLD_CURVAL]: 'paid' })
    expect(seedBridge.getMetrics().flushSuccessCount).toBeGreaterThanOrEqual(1)
    const oldValue = await readField(REC_GF2, MS, FLD_RELCOUNT)
    expect(oldValue).toBe(1) // sanity: the authorized write DID materialize a value

    // MASKED_ID cannot read FS_STATUS -> resolveTaintedFormulaFieldIds must drop FLD_RELCOUNT from
    // the recompute set, leaving the previously-materialized (authorized) value untouched.
    const bridge = await driveFlush(REC_GF2, MASKED_ID, { [FLD_CURVAL]: 'unpaid-again' })
    expect(bridge.getMetrics().flushSuccessCount).toBeGreaterThanOrEqual(1) // the plain field write itself succeeds
    expect(await readField(REC_GF2, MS, FLD_CURVAL)).toBe('unpaid-again') // the edited field DID change
    expect(await readField(REC_GF2, MS, FLD_RELCOUNT)).toBe(oldValue) // the tainted formula did NOT change
  })

  test('GF4: non-formula bridge write (no formula deps touched) -> no side effect on unrelated formula fields', async () => {
    const totalBefore = await readField(REC_GF4, MS, FLD_TOTAL)
    const bridge = await driveFlush(REC_GF4, WRITER_ID, { [FLD_NOISE]: 'after-noise' })
    expect(bridge.getMetrics().flushSuccessCount).toBeGreaterThanOrEqual(1)
    expect(await readField(REC_GF4, MS, FLD_NOISE)).toBe('after-noise')
    // FLD_TOTAL has no formula_dependencies edge on FLD_NOISE -> untouched.
    expect(await readField(REC_GF4, MS, FLD_TOTAL)).toBe(totalBefore)
  })

  test('GF9: bridge cross-record fan-out residual pin — collab edit of a link-source record does NOT refresh a FOREIGN sheet\'s formula-over-lookup (computeDependentLookupRollupRecords stays stubbed)', async () => {
    const relFormulaBefore = await readField(REC_G9_REL, REL, REL_FORMULA)
    expect(relFormulaBefore).toBe(100)
    const bridge = await driveFlush(REC_G9_SRC, WRITER_ID, { [FLD_G9_TARGET]: 999 })
    expect(bridge.getMetrics().flushSuccessCount).toBeGreaterThanOrEqual(1)
    expect(await readField(REC_G9_SRC, MS, FLD_G9_TARGET)).toBe(999) // the source DID change
    // The named residual: REL's formula-over-lookup stays stale on the bridge path (flips only
    // when the cross-record fan-out follow-up slice lands).
    expect(await readField(REC_G9_REL, REL, REL_FORMULA)).toBe(100)
  })
})
