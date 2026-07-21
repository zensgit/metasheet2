/**
 * W0 L8 route wiring — the four legacy surfaces (revert/reset × preview/execute) onto exact-anchor
 * authority + applyExactAnchorRecovery. Behavior-level goldens (mutation-oriented where practical):
 *   - default-off refusal/parity
 *   - history-batch and direct operation anchor preview
 *   - wall-clock uniform refusal (EXACT_ANCHOR_REQUIRED)
 *   - token-bound mode (revert token cannot drive reset)
 *   - preview + in-fence full-read auth
 *   - size ceiling
 *   - revert vs reset semantics
 *   - resurrection removes trash
 *   - route tests prove the real L8 apply is invoked (token burn + sealed operation)
 *
 * Requires DATABASE_URL. Flags toggled only inside this process (default OFF everywhere real).
 */
import { randomUUID } from 'node:crypto'
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { setYjsInvalidatorForRoutes, univerMetaRouter } from '../../src/routes/univer-meta'
import { activateCheckpoint, type QueryFn } from '../../src/multitable/history-trust-checkpoint'
import * as exactApply from '../../src/multitable/exact-anchor-recovery-execute'
import * as realtimeMod from '../../src/multitable/realtime-publish'
import { eventBus } from '../../src/integration/events/event-bus'
import { canonicalSheetFenceKey } from '../../src/multitable/canonical-sheet-fence'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_earw_${TS}`
const SHEET = `sheet_earw_${TS}`
const REL_SHEET = `sheet_earw_rel_${TS}`
const F_STR = `fld_earw_note_${TS}`
const F_NUM = `fld_earw_num_${TS}`
const F_FORMULA = `fld_earw_formula_${TS}`
const F_NOISE = `fld_earw_noise_${TS}`
/** Source-sheet FOL golden: link → target sheet, lookup of target num, formula-over-lookup. */
const F_SRC_LINK = `fld_earw_src_link_${TS}`
const F_SRC_LOOKUP = `fld_earw_src_lu_${TS}`
const F_FOL = `fld_earw_fol_${TS}`
const F_TGT_NUM = `fld_earw_tgt_num_${TS}`
const F_REL_LINK = `fld_earw_rel_link_${TS}`
const F_REL_LOOKUP = `fld_earw_rel_lu_${TS}`
const TGT_SHEET = `sheet_earw_tgt_${TS}`
const ACTOR = `user_earw_${TS}`
const REC_A = `rec_earw_a_${TS}`
const REC_B = `rec_earw_b_${TS}`
const REC_C = `rec_earw_c_${TS}`
const REC_REL = `rec_earw_rel_${TS}`
const REC_REL_UNRELATED = `rec_earw_rel_unrel_${TS}`
const REC_TGT_ANCHOR = `rec_earw_tgt_a_${TS}` // target num = 10 (anchor link target)
const REC_TGT_LIVE = `rec_earw_tgt_l_${TS}` // target num = 99 (live link target)

const q = (sql: string, params: unknown[] = []) => poolManager.get().query(sql, params)
const txn = <T>(fn: (query: QueryFn) => Promise<T>): Promise<T> =>
  poolManager.get().transaction(async ({ query }) => fn(query as unknown as QueryFn)) as Promise<T>

let app: Express
let curPerms = ['multitable:read', 'multitable:write', 'multitable:share']
let curRoles = ['member']

const revertPreview = (body: Record<string, unknown>) =>
  request(app).post(`/api/multitable/sheets/${SHEET}/revert-preview`).send(body)
const revertExecute = (body: Record<string, unknown>) =>
  request(app).post(`/api/multitable/sheets/${SHEET}/revert-execute`).send(body)
const resetPreview = (body: Record<string, unknown>) =>
  request(app).post(`/api/multitable/sheets/${SHEET}/reset-preview`).send(body)
const resetExecute = (body: Record<string, unknown>) =>
  request(app).post(`/api/multitable/sheets/${SHEET}/reset-execute`).send(body)

async function sealOp(
  recordId: string,
  events: Array<{ seq: string; version: number; action?: 'create' | 'update' | 'delete'; snap?: Record<string, unknown>; batchId?: string }>,
): Promise<{ opId: string; batchId: string }> {
  const opId = randomUUID()
  const batchId = events[0]?.batchId ?? `batch_${TS}_${recordId}`
  const maxSeq = events.map((e) => e.seq).reduce((a, b) => (BigInt(a) >= BigInt(b) ? a : b))
  await txn(async (query) => {
    for (const e of events) {
      await query(
        `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, seq, operation_id, batch_id)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,'rest',ARRAY[]::text[],'{}'::jsonb,$5::jsonb,$6::bigint,$7::uuid,$8)`,
        [SHEET, recordId, e.version, e.action ?? 'update', JSON.stringify(e.snap ?? { [F_STR]: `v${e.version}` }), e.seq, opId, e.batchId ?? batchId],
      )
    }
    await query(
      `INSERT INTO meta_record_history_operations (sheet_id, operation_id, endpoint_seq, event_count)
       VALUES ($1,$2::uuid,$3::bigint,$4::int)`,
      [SHEET, opId, maxSeq, events.length],
    )
  })
  return { opId, batchId }
}

async function wipe(): Promise<void> {
  // Deterministic cleanup: wipe by sheet AND by known field/record ids so orphaned
  // meta_links / notifications from a prior failed case cannot leak into the next golden.
  for (const sheetId of [SHEET, REL_SHEET, TGT_SHEET]) {
    for (const t of [
      'meta_history_baselines',
      'meta_history_trust_checkpoints',
      'meta_recovery_token_burns',
      'meta_record_version_markers',
      'meta_records_trash',
      'meta_record_revisions',
      'meta_records',
      'meta_links',
    ])
      await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [sheetId]).catch(() => {})
    await q('DELETE FROM meta_record_history_operations WHERE sheet_id = $1', [sheetId]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [sheetId]).catch(() => {})
    await q('DELETE FROM formula_dependencies WHERE sheet_id = $1', [sheetId]).catch(() => {})
    await q('DELETE FROM meta_record_subscriptions WHERE sheet_id = $1', [sheetId]).catch(() => {})
    await q('DELETE FROM meta_record_subscription_notifications WHERE sheet_id = $1', [sheetId]).catch(() => {})
  }
  await q('DELETE FROM meta_links WHERE field_id = ANY($1::text[])', [[F_REL_LINK, F_SRC_LINK]]).catch(() => {})
  await q(
    `DELETE FROM meta_links WHERE record_id = ANY($1::text[]) OR foreign_record_id = ANY($1::text[])`,
    [[REC_A, REC_B, REC_REL, REC_REL_UNRELATED, REC_TGT_ANCHOR, REC_TGT_LIVE]],
  ).catch(() => {})
}

/**
 * Seed: A live at anchor (v1), edited after (v2); B created after anchor; C existed at anchor then deleted.
 * Pattern matches L8 apply suite: activate first (trusted_since = small nextval), then seal the anchor
 * at a HIGH synthetic seq so trusted_since ≤ anchorSeq always holds.
 *
 * Optional side-effect world when `withSideEffects` is true:
 *   - simple formula F_FORMULA = {F_NUM}+1 (DB materialization golden)
 *   - source FOL: F_SRC_LINK + F_SRC_LOOKUP + F_FOL (hydration-before-formula golden)
 *   - REL_SHEET linked lookup of F_NUM for FOL-1 fan-out + production-read golden
 */
async function seedWorld(opts?: { withSideEffects?: boolean }): Promise<{ anchorOp: string; batchId: string; postOp: string; seqBase: bigint }> {
  await wipe()
  const ck = await txn((query) => activateCheckpoint(query, { sheetId: SHEET }))
  const base = BigInt(ck.trustedSinceSeq) + 1000n
  const s1 = String(base)
  const s2 = String(base + 1000n)
  const s3 = String(base + 1200n)

  const anchorSnap: Record<string, unknown> = { [F_STR]: 'A-at-anchor', [F_NOISE]: 'noise-stable' }
  const liveSnap: Record<string, unknown> = { [F_STR]: 'A-live-now', [F_NOISE]: 'noise-stable' }
  if (opts?.withSideEffects) {
    anchorSnap[F_NUM] = 10
    anchorSnap[F_FORMULA] = 999 // deliberately STALE at-anchor formula value (recompute must fix to 11)
    // FOL: at-anchor links to REC_TGT_ANCHOR (num=10); formula-over-lookup must materialize 11 after hydrate.
    // Stale F_FOL=999 at anchor so recompute (not the snapshot) is the source of truth.
    anchorSnap[F_SRC_LINK] = [REC_TGT_ANCHOR]
    anchorSnap[F_FOL] = 999
    liveSnap[F_NUM] = 99
    liveSnap[F_FORMULA] = 100 // live formula matched live num; after revert must become 11
    // Live: link points at REC_TGT_LIVE (num=99); FOL stale-matched to 100. After restore → 11 via hydration.
    liveSnap[F_SRC_LINK] = [REC_TGT_LIVE]
    liveSnap[F_FOL] = 100
  }

  const { opId: anchorOp, batchId } = await sealOp(REC_A, [
    { seq: s1, version: 1, action: 'create', snap: anchorSnap },
  ])
  const { opId: postOp } = await sealOp(REC_A, [
    { seq: s2, version: 2, action: 'update', snap: liveSnap, batchId: `batch_post_${TS}` },
  ])
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,2)', [
    REC_A, SHEET, JSON.stringify(liveSnap),
  ])
  await sealOp(REC_B, [
    { seq: s3, version: 1, action: 'create', snap: { [F_STR]: 'B-after' }, batchId: `batch_b_${TS}` },
  ])
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
    REC_B, SHEET, JSON.stringify({ [F_STR]: 'B-after' }),
  ])

  if (opts?.withSideEffects) {
    // Target sheet rows for source FOL (stable numbers; never recovered themselves).
    await q(
      `INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, version = EXCLUDED.version`,
      [REC_TGT_ANCHOR, TGT_SHEET, JSON.stringify({ [F_TGT_NUM]: 10 })],
    )
    await q(
      `INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, version = EXCLUDED.version`,
      [REC_TGT_LIVE, TGT_SHEET, JSON.stringify({ [F_TGT_NUM]: 99 })],
    )
    // Outbound source link is LIVE-state (to REC_TGT_LIVE); recovery rebuilds to anchor target.
    await q('DELETE FROM meta_links WHERE field_id = $1', [F_SRC_LINK]).catch(() => {})
    await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [
      F_SRC_LINK, REC_A, REC_TGT_LIVE,
    ])

    // Related sheet: REC_REL links → REC_A (lookup of F_NUM is affected on revert); REC_REL_UNRELATED has no link.
    await q(
      `INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, version = EXCLUDED.version`,
      [REC_REL, REL_SHEET, JSON.stringify({ note: 'related-row' })],
    )
    await q(
      `INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, version = EXCLUDED.version`,
      [REC_REL_UNRELATED, REL_SHEET, JSON.stringify({ note: 'unrelated-golden' })],
    )
    await q('DELETE FROM meta_links WHERE field_id = $1', [F_REL_LINK]).catch(() => {})
    await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [
      F_REL_LINK, REC_REL, REC_A,
    ])
  }

  await q(
    `SELECT setval('meta_record_chain_seq', GREATEST((SELECT last_value FROM meta_record_chain_seq), $1::bigint), true)`,
    [String(base + 2000n)],
  ).catch(() => {})
  return { anchorOp, batchId, postOp, seqBase: base }
}

describeIfDatabase('multitable L8 exact-anchor route wiring (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as { user?: unknown }).user = { id: ACTOR, roles: curRoles, perms: curPerms }
      next()
    })
    process.env.MULTITABLE_SHEET_REVERT_MAX_RECORDS = '50'
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING', [BASE, 'EARW Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [SHEET, BASE, 'EARW Sheet'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [REL_SHEET, BASE, 'EARW Related'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [TGT_SHEET, BASE, 'EARW Target'])
    await q(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)
       ON CONFLICT DO NOTHING`,
      [F_STR, SHEET, 'Note', 'string', '{}', 1],
    )
    await q(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)
       ON CONFLICT DO NOTHING`,
      [F_NUM, SHEET, 'Num', 'number', '{}', 2],
    )
    await q(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)
       ON CONFLICT DO NOTHING`,
      [F_FORMULA, SHEET, 'Derived', 'formula', JSON.stringify({ expression: `={${F_NUM}}+1` }), 3],
    )
    await q(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)
       ON CONFLICT DO NOTHING`,
      [F_NOISE, SHEET, 'Noise', 'string', '{}', 4],
    )
    // Source FOL chain: link → target sheet, lookup of F_TGT_NUM, formula = {lookup}+1
    await q(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)
       ON CONFLICT DO NOTHING`,
      [F_SRC_LINK, SHEET, 'SrcLink', 'link', JSON.stringify({ foreignSheetId: TGT_SHEET }), 5],
    )
    await q(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)
       ON CONFLICT DO NOTHING`,
      [F_SRC_LOOKUP, SHEET, 'SrcLookup', 'lookup', JSON.stringify({ linkFieldId: F_SRC_LINK, targetFieldId: F_TGT_NUM, foreignSheetId: TGT_SHEET }), 6],
    )
    await q(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)
       ON CONFLICT DO NOTHING`,
      [F_FOL, SHEET, 'Fol', 'formula', JSON.stringify({ expression: `={${F_SRC_LOOKUP}}+1` }), 7],
    )
    await q(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)
       ON CONFLICT DO NOTHING`,
      [F_TGT_NUM, TGT_SHEET, 'TgtNum', 'number', '{}', 1],
    )
    await q('DELETE FROM formula_dependencies WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q(
      `INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id)
       VALUES ($1,$2,$3,$4)`,
      [SHEET, F_FORMULA, F_NUM, SHEET],
    )
    // FOL depends on the lookup intermediary (link expansion also feeds this via recalculateFormulaFields).
    await q(
      `INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id)
       VALUES ($1,$2,$3,$4)`,
      [SHEET, F_FOL, F_SRC_LOOKUP, SHEET],
    )
    await q(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)
       ON CONFLICT DO NOTHING`,
      [F_REL_LINK, REL_SHEET, 'Link', 'link', JSON.stringify({ foreignSheetId: SHEET }), 1],
    )
    await q(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)
       ON CONFLICT DO NOTHING`,
      [F_REL_LOOKUP, REL_SHEET, 'Lookup', 'lookup', JSON.stringify({ linkFieldId: F_REL_LINK, targetFieldId: F_NUM, foreignSheetId: SHEET }), 2],
    )
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
  })

  afterAll(async () => {
    delete process.env.MULTITABLE_ENABLE_SHEET_REVERT
    delete process.env.MULTITABLE_ENABLE_PIT_RESET
    delete process.env.MULTITABLE_ENABLE_PIT_UNDELETE
    delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
    delete process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT
    delete process.env.MULTITABLE_SHEET_REVERT_MAX_RECORDS
    delete process.env.MULTITABLE_META_REVISION_RETENTION_ENABLED
    setYjsInvalidatorForRoutes(null)
    await wipe()
    await q('DELETE FROM formula_dependencies WHERE sheet_id = ANY($1::text[])', [[SHEET, REL_SHEET, TGT_SHEET]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[SHEET, REL_SHEET, TGT_SHEET]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SHEET, REL_SHEET, TGT_SHEET]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
    await q(`SELECT setval('meta_record_chain_seq', 1000, true)`).catch(() => {})
  })

  beforeEach(async () => {
    curPerms = ['multitable:read', 'multitable:write', 'multitable:share']
    curRoles = ['member']
    delete process.env.MULTITABLE_ENABLE_SHEET_REVERT
    delete process.env.MULTITABLE_ENABLE_PIT_RESET
    delete process.env.MULTITABLE_ENABLE_PIT_UNDELETE
    delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
    delete process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT
    delete process.env.MULTITABLE_META_REVISION_RETENTION_ENABLED
    setYjsInvalidatorForRoutes(null)
    await wipe()
  })

  /** Success-path requires trust pair: fence + CONTIGUITY_STRICT (RECOVERY_TRUST_REQUIRED otherwise). */
  const enableRecoveryExecute = () => {
    process.env.MULTITABLE_ENABLE_SHEET_REVERT = 'true'
    process.env.MULTITABLE_ENABLE_PIT_RESET = 'true'
    process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
    process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT = 'true'
  }

  test('default-off: revert-execute and reset-preview/execute refuse; wall-clock always EXACT_ANCHOR_REQUIRED', async () => {
    const wall = await revertPreview({ asOf: '2026-01-02T00:00:00.000Z' })
    expect(wall.status).toBe(400)
    expect(wall.body?.error?.code).toBe('EXACT_ANCHOR_REQUIRED')

    const execOff = await revertExecute({ previewIdentity: 'x', confirm: 'undelete' })
    expect(execOff.status).toBe(403)
    expect(execOff.body?.error?.code).toBe('REVERT_DISABLED')

    const resetOff = await resetPreview({ historyBatchId: 'batch_x' })
    expect(resetOff.status).toBe(403)
    expect(resetOff.body?.error?.code).toBe('RESET_DISABLED')
  })

  test('history-batch and direct operation anchor preview; wall-clock refused even when flag on', async () => {
    enableRecoveryExecute()
    process.env.MULTITABLE_ENABLE_PIT_UNDELETE = 'true'
    const { anchorOp, batchId } = await seedWorld()

    const wall = await revertPreview({ asOf: '2026-01-02T00:00:00.000Z' })
    expect(wall.status).toBe(400)
    expect(wall.body?.error?.code).toBe('EXACT_ANCHOR_REQUIRED')

    const byOp = await revertPreview({ anchorOperationId: anchorOp })
    expect(byOp.status).toBe(200)
    expect(byOp.body?.data?.anchorOperationId).toBe(anchorOp)
    expect(byOp.body?.data?.previewIdentity).toBeTruthy()
    expect(byOp.body?.data?.summary?.visibleRevertCount).toBeGreaterThanOrEqual(1)
    expect(byOp.body?.data?.summary?.resurrectCount).toBe(0)
    expect(byOp.body?.data?.summary?.driftCount).toBe(0)
    expect(byOp.body?.data?.summary?.effectiveWriteCount).toBeGreaterThanOrEqual(1)

    const byBatch = await revertPreview({ historyBatchId: batchId })
    expect(byBatch.status).toBe(200)
    expect(byBatch.body?.data?.anchorOperationId).toBe(anchorOp)
    expect(byBatch.body?.data?.historyBatchId).toBe(batchId)
  })

  test('token-bound mode: revert preview identity cannot drive reset-execute', async () => {
    enableRecoveryExecute()
    process.env.MULTITABLE_ENABLE_PIT_UNDELETE = 'true'
    const { anchorOp } = await seedWorld()
    const pv = await revertPreview({ anchorOperationId: anchorOp })
    expect(pv.status).toBe(200)
    const token = pv.body?.data?.previewIdentity as string
    expect(token).toBeTruthy()
    const ex = await resetExecute({ previewIdentity: token, confirm: 'reset' })
    expect(ex.status).toBe(409)
    expect(ex.body?.error?.code).toBe('PREVIEW_IDENTITY_INVALID')
  })

  test('execute is token-only: caller anchor/mode authority is rejected with zero writes and does not burn the token', async () => {
    enableRecoveryExecute()
    const { anchorOp } = await seedWorld()
    const pv = await revertPreview({ anchorOperationId: anchorOp })
    expect(pv.status).toBe(200)
    const token = pv.body?.data?.previewIdentity as string
    expect(token).toBeTruthy()

    const rejected = await revertExecute({
      previewIdentity: token,
      historyBatchId: `stale_batch_${TS}`,
      mode: 'reset',
    })
    expect(rejected.status).toBe(400)
    expect(rejected.body?.error?.code).toBe('VALIDATION_ERROR')
    expect((await q('SELECT data FROM meta_records WHERE id = $1', [REC_A])).rows[0]?.data?.[F_STR]).toBe('A-live-now')
    expect((await q('SELECT count(*)::int AS c FROM meta_recovery_token_burns WHERE sheet_id = $1', [SHEET])).rows[0]?.c).toBe(0)

    const accepted = await revertExecute({ previewIdentity: token })
    expect(accepted.status).toBe(200)
    expect((await q('SELECT data FROM meta_records WHERE id = $1', [REC_A])).rows[0]?.data?.[F_STR]).toBe('A-at-anchor')
  })

  test('size ceiling: live sheet over max → 413 before expensive work', async () => {
    enableRecoveryExecute()
    const { anchorOp } = await seedWorld()
    // force tiny ceiling via env (route resolves at router construction — use effective write path by
    // temporarily setting env; the route uses SHEET_REVERT_MAX_RECORDS captured at construction = 50).
    // Insert enough live rows to exceed 50.
    for (let i = 0; i < 55; i++) {
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1) ON CONFLICT DO NOTHING', [
        `rec_earw_pad_${TS}_${i}`, SHEET, JSON.stringify({ [F_STR]: 'pad' }),
      ])
    }
    const pv = await revertPreview({ anchorOperationId: anchorOp })
    expect(pv.status).toBe(413)
    expect(pv.body?.error?.code).toBe('SHEET_TOO_LARGE')
  })

  test('revert vs reset semantics + soft-delete trash + L8 apply invoked (burn) + field-level records payload', async () => {
    enableRecoveryExecute()
    const spy = vi.spyOn(exactApply, 'applyExactAnchorRecovery')
    const { anchorOp } = await seedWorld()

    // REVERT: keeps B (created after), reverts A; undeleteSupported false (inbound fail-closed)
    const rpv = await revertPreview({ anchorOperationId: anchorOp })
    expect(rpv.status).toBe(200)
    expect(rpv.body?.data?.undeleteSupported).toBe(false)
    const rToken = rpv.body?.data?.previewIdentity as string
    expect(rToken).toBeTruthy()
    const rex = await revertExecute({ previewIdentity: rToken })
    expect(rex.status).toBe(200)
    expect(spy).toHaveBeenCalled()
    expect(rex.body?.data?.revertedCount).toBeGreaterThanOrEqual(1)
    // Field-level payload for automation/Yjs (not empty changes)
    const recs = rex.body?.data?.records as Array<{ recordId: string; fieldIds: string[] }> | undefined
    expect(Array.isArray(recs) && recs.length >= 1).toBe(true)
    expect(recs![0].fieldIds).toContain(F_STR)
    const aLive = (await q('SELECT data FROM meta_records WHERE id = $1', [REC_A])).rows[0] as { data: Record<string, unknown> }
    expect(aLive.data[F_STR]).toBe('A-at-anchor')
    expect((await q('SELECT 1 FROM meta_records WHERE id = $1', [REC_B])).rows.length).toBe(1) // kept
    expect(Number(((await q('SELECT count(*)::int c FROM meta_recovery_token_burns WHERE sheet_id = $1', [SHEET])).rows[0] as { c: number }).c)).toBeGreaterThanOrEqual(1)

    // re-seed for reset — soft-delete B into trash
    const { anchorOp: op2 } = await seedWorld()
    const spv = await resetPreview({ anchorOperationId: op2 })
    expect(spv.status).toBe(200)
    const sToken = spv.body?.data?.previewIdentity as string
    expect(sToken).toBeTruthy()
    const sex = await resetExecute({ previewIdentity: sToken, confirm: 'reset' })
    expect(sex.status).toBe(200)
    expect(sex.body?.data?.deletedCount).toBeGreaterThanOrEqual(1)
    expect((await q('SELECT 1 FROM meta_records WHERE id = $1', [REC_B])).rows.length).toBe(0)
    expect((await q('SELECT 1 FROM meta_records_trash WHERE record_id = $1', [REC_B])).rows.length).toBe(1)
    spy.mockRestore()
  })

  test('POST-COMMIT BEHAVIOR: subscriber + eventBus true-delta + Yjs source/related + formula DB recompute + related lookup fan-out (negative goldens)', async () => {
    enableRecoveryExecute()
    const rtSpy = vi.spyOn(realtimeMod, 'publishMultitableSheetRealtime')
    const busSpy = vi.spyOn(eventBus, 'emit')
    const yjsSpy = vi.fn(async (_ids: string[]) => {})
    setYjsInvalidatorForRoutes(yjsSpy)
    try {
      const { anchorOp } = await seedWorld({ withSideEffects: true })

      // Arrange: subscribe a watcher (behavior-level post-commit subscriber notification)
      await q(
        `INSERT INTO meta_record_subscriptions (id, sheet_id, record_id, user_id, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, now(), now())`,
        [SHEET, REC_A, 'watcher-user-1'],
      )
      // Unrelated golden baseline (must stay green)
      const unrelBefore = (await q('SELECT data FROM meta_records WHERE id = $1', [REC_REL_UNRELATED])).rows[0] as {
        data: Record<string, unknown>
      }

      const pv = await revertPreview({ anchorOperationId: anchorOp })
      expect(pv.status).toBe(200)
      const token = pv.body?.data?.previewIdentity as string
      expect(token).toBeTruthy()

      const ex = await revertExecute({ previewIdentity: token })
      expect(ex.status).toBe(200)
      const recs = (ex.body?.data?.records ?? []) as Array<{ recordId: string; fieldIds: string[]; revisionId?: string }>
      expect(recs.length).toBeGreaterThanOrEqual(1)
      const revId = recs[0].revisionId
      expect(revId).toBeTruthy()
      expect(recs[0].fieldIds).toContain(F_STR)
      expect(recs[0].fieldIds).toContain(F_NUM)
      expect(recs[0].fieldIds).toContain(F_SRC_LINK) // outbound link restored (FOL hydration trigger)
      // Noise is unchanged across anchor/live → not in true-delta fieldIds
      expect(recs[0].fieldIds).not.toContain(F_NOISE)

      // DB-derived simple formula recompute: F_NUM restored to 10 ⇒ formula = 11 (was stale 100/999)
      const aLive = (await q('SELECT data FROM meta_records WHERE id = $1', [REC_A])).rows[0] as {
        data: Record<string, unknown>
      }
      expect(aLive.data[F_STR]).toBe('A-at-anchor')
      expect(aLive.data[F_NUM]).toBe(10)
      expect(aLive.data[F_FORMULA]).toBe(11)
      expect(aLive.data[F_NOISE]).toBe('noise-stable')
      // Source FOL: restored link → REC_TGT_ANCHOR (num=10); hydration-before-formula must materialize 11.
      // Goes red (typically 1 = absent-lookup→0 + 1) if hydration is removed or reordered after formula.
      expect(aLive.data[F_SRC_LINK]).toEqual([REC_TGT_ANCHOR])
      expect(aLive.data[F_FOL]).toBe(11)
      // Outbound meta_links rebuilt to the anchor target (not the live target).
      const srcLinks = (await q(
        'SELECT foreign_record_id FROM meta_links WHERE field_id = $1 AND record_id = $2',
        [F_SRC_LINK, REC_A],
      )).rows as Array<{ foreign_record_id: string }>
      expect(srcLinks.map((r) => r.foreign_record_id)).toEqual([REC_TGT_ANCHOR])

      // Related lookup VALUE via production read route (GET /view hydrates lookup/rollup) — not a private helper.
      // F_NUM restored to 10 on REC_A ⇒ REC_REL's F_REL_LOOKUP resolves to [10]; REC_REL_UNRELATED unaffected.
      const relView = await request(app).get('/api/multitable/view').query({ sheetId: REL_SHEET })
      expect(relView.status).toBe(200)
      const relRows = (relView.body?.data?.rows ?? relView.body?.data?.records ?? []) as Array<{
        id: string
        data: Record<string, unknown>
      }>
      const relRow = relRows.find((r) => r.id === REC_REL)
      const unrelRow = relRows.find((r) => r.id === REC_REL_UNRELATED)
      expect(relRow).toBeTruthy()
      expect(unrelRow).toBeTruthy()
      expect(relRow!.data[F_REL_LOOKUP]).toEqual([10])
      // Unrelated row has no link → lookup is empty array (or absent), never the restored source value.
      const unrelLookup = unrelRow!.data[F_REL_LOOKUP]
      expect(unrelLookup === undefined || unrelLookup === null || (Array.isArray(unrelLookup) && unrelLookup.length === 0)).toBe(true)

      // Source-sheet realtime: true-delta patch (not full snapshot) + formula fieldId merge
      const rtCalls = rtSpy.mock.calls.map((c) => c[0] as Record<string, unknown>)
      const sourceUpdated = rtCalls.find(
        (c) => c && c.kind === 'record-updated' && c.spreadsheetId === SHEET && Array.isArray(c.recordPatches),
      ) as {
        recordIds: string[]
        fieldIds: string[]
        recordPatches: Array<{ patch: Record<string, unknown> }>
      } | undefined
      expect(sourceUpdated).toBeTruthy()
      expect(sourceUpdated!.recordIds).toContain(REC_A)
      expect(sourceUpdated!.fieldIds).toContain(F_STR)
      expect(sourceUpdated!.fieldIds).toContain(F_NUM)
      expect(sourceUpdated!.fieldIds).toContain(F_FORMULA) // simple formula keys merged into fieldIds
      expect(sourceUpdated!.fieldIds).toContain(F_FOL) // FOL formula keys merged after hydrated recompute
      expect(sourceUpdated!.fieldIds).not.toContain(F_NOISE)
      const patchKeys = Object.keys(sourceUpdated!.recordPatches[0].patch)
      expect(patchKeys).toContain(F_STR)
      expect(patchKeys).toContain(F_NUM)
      expect(patchKeys).toContain(F_FORMULA)
      expect(patchKeys).toContain(F_FOL)
      // Not a full snapshot of every field only-as-authority: noise may be absent from true-delta patch
      expect(sourceUpdated!.recordPatches[0].patch[F_STR]).toBe('A-at-anchor')
      expect(sourceUpdated!.recordPatches[0].patch[F_FOL]).toBe(11)

      // Related-sheet pure invalidation fan-out (no recordPatches)
      const relatedUpdated = rtCalls.find(
        (c) => c && c.kind === 'record-updated' && c.spreadsheetId === REL_SHEET,
      ) as { recordIds: string[]; fieldIds: string[]; recordPatches?: unknown } | undefined
      expect(relatedUpdated).toBeTruthy()
      expect(relatedUpdated!.recordIds).toContain(REC_REL)
      expect(relatedUpdated!.recordIds).not.toContain(REC_REL_UNRELATED)
      expect(relatedUpdated!.fieldIds).toContain(F_REL_LOOKUP)
      expect(relatedUpdated!.recordPatches).toBeUndefined()

      // eventBus true-delta only (user-facing recovery patch — not a second formula-only revision event)
      const updatedEvents = busSpy.mock.calls.filter((c) => c[0] === 'multitable.record.updated')
      expect(updatedEvents.length).toBe(1)
      const payload = updatedEvents[0][1] as { changes: Record<string, unknown>; recordId: string }
      expect(payload.recordId).toBe(REC_A)
      expect(payload.changes[F_STR]).toBe('A-at-anchor')
      expect(payload.changes[F_NUM]).toBe(10)
      // Formula is materialization, not a user-facing revision change payload
      expect(payload.changes[F_FORMULA]).toBeUndefined()
      expect(payload.changes[F_FOL]).toBeUndefined()

      // Subscriber notification behavior-level (revision-carrying)
      const notifRows = await q(
        `SELECT revision_id, event_type FROM meta_record_subscription_notifications
         WHERE sheet_id = $1 AND record_id = $2 AND user_id = $3`,
        [SHEET, REC_A, 'watcher-user-1'],
      )
      expect(notifRows.rows.length).toBeGreaterThanOrEqual(1)
      expect(String((notifRows.rows[0] as { revision_id: unknown }).revision_id)).toBe(String(revId))
      expect((notifRows.rows[0] as { event_type: string }).event_type).toBe('record.updated')

      // Yjs invalidation: exact affected source + related record ids (not unrelated)
      expect(yjsSpy).toHaveBeenCalled()
      const yjsIds = new Set((yjsSpy.mock.calls as Array<[string[]]>).flatMap((c) => c[0] ?? []))
      expect(yjsIds.has(REC_A)).toBe(true)
      expect(yjsIds.has(REC_REL)).toBe(true)
      expect(yjsIds.has(REC_REL_UNRELATED)).toBe(false)
      expect(yjsIds.has(REC_B)).toBe(false)

      // Negative golden: unrelated related-sheet row untouched
      const unrelAfter = (await q('SELECT data FROM meta_records WHERE id = $1', [REC_REL_UNRELATED])).rows[0] as {
        data: Record<string, unknown>
      }
      expect(unrelAfter.data).toEqual(unrelBefore.data)
      // B (created after, kept by revert) untouched
      const bLive = (await q('SELECT data FROM meta_records WHERE id = $1', [REC_B])).rows[0] as {
        data: Record<string, unknown>
      }
      expect(bLive.data[F_STR]).toBe('B-after')
    } finally {
      setYjsInvalidatorForRoutes(null)
      rtSpy.mockRestore()
      busSpy.mockRestore()
    }
  })

  test('AUTH-RACE (Express + production makePlanAuthorization): fence-parked field_perm revoke ⇒ exact 403 FORBIDDEN, zero writes; regrant allows same token', async () => {
    enableRecoveryExecute()
    const { anchorOp } = await seedWorld()
    const pv = await revertPreview({ anchorOperationId: anchorOp })
    expect(pv.status).toBe(200)
    const token = pv.body?.data?.previewIdentity as string
    expect(typeof token).toBe('string')
    expect(token.length).toBeGreaterThan(10)

    const liveBefore = (await q('SELECT data, version FROM meta_records WHERE id = $1 AND sheet_id = $2', [REC_A, SHEET]))
      .rows[0] as { data: Record<string, unknown>; version: number }
    expect(liveBefore.data[F_STR]).toBe('A-live-now')
    const burnsBefore = Number(
      ((await q('SELECT count(*)::int c FROM meta_recovery_token_burns WHERE sheet_id = $1', [SHEET])).rows[0] as { c: number }).c,
    )
    const revsBefore = Number(
      ((await q(
        `SELECT count(*)::int c FROM meta_record_revisions WHERE sheet_id = $1 AND source = 'restore'`,
        [SHEET],
      )).rows[0] as { c: number }).c,
    )

    // Use the live internal pool (not a module-load snapshot) so the fence holder and the route
    // share the same pg Pool as poolManager.transaction.
    const livePool = poolManager.get().getInternalPool()
    expect(livePool).toBeTruthy()
    const holder = await livePool!.connect()
    try {
      await holder.query('BEGIN')
      // Capture holder backend pid + acquire the EXACT canonical fence key production uses.
      const holderPid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid)
      expect(Number.isFinite(holderPid) && holderPid > 0).toBe(true)
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(SHEET)])
      // Snapshot the granted advisory lock identity held by THIS holder (database/classid/objid/objsubid).
      const holderLockRes = await holder.query(
        `SELECT database, classid, objid, objsubid
           FROM pg_locks
          WHERE locktype = 'advisory' AND granted = true AND pid = $1`,
        [holderPid],
      )
      expect(holderLockRes.rows.length).toBeGreaterThanOrEqual(1)

      // Start execute via the real Express route (production makePlanAuthorization — no boolean stub).
      // Force-start the SuperAgent thenable immediately (assignment alone does not fire the request).
      const applying = Promise.resolve(revertExecute({ previewIdentity: token }))

      // Prove the apply is PARKED on the EXACT advisory lock identity held by this holder.
      // Join waiter → holder on (database, classid, objid, objsubid); require waiter.pid != holder
      // and waiter.granted = false. An unrelated advisory waiter must NOT satisfy this test.
      let sawExactWaiter = false
      for (let i = 0; i < 100; i++) {
        const waiters = await holder.query(
          `SELECT count(*)::int AS c
             FROM pg_locks waiter
             JOIN pg_locks holder
               ON holder.locktype = 'advisory'
              AND holder.granted = true
              AND holder.pid = $1
              AND waiter.locktype = 'advisory'
              AND waiter.granted = false
              AND waiter.pid <> holder.pid
              AND waiter.database IS NOT DISTINCT FROM holder.database
              AND waiter.classid = holder.classid
              AND waiter.objid = holder.objid
              AND waiter.objsubid = holder.objsubid`,
          [holderPid],
        )
        if (Number((waiters.rows[0] as { c: number }).c) > 0) {
          sawExactWaiter = true
          break
        }
        // Bail early if the request already settled without parking (would make the race vacuous).
        const settled = await Promise.race([
          applying.then(() => true),
          new Promise<boolean>((r) => setTimeout(() => r(false), 0)),
        ])
        if (settled) break
        await new Promise((r) => setTimeout(r, 50))
      }
      expect(sawExactWaiter).toBe(true)

      // While parked: mutate a real DB-backed field permission to read_only on a SEPARATE connection.
      await q('DELETE FROM field_permissions WHERE sheet_id = $1 AND field_id = $2 AND subject_id = $3', [
        SHEET, F_STR, ACTOR,
      ]).catch(() => {})
      await q(
        `INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only)
         VALUES ($1,$2,'user',$3,true,true)`,
        [SHEET, F_STR, ACTOR],
      )

      // Release fence → in-fence plan auth re-adjudicates against the revoked write permission.
      await holder.query('COMMIT')
      const ex = await applying
      expect(ex.status).toBe(403)
      expect(ex.body?.error?.code).toBe('FORBIDDEN')

      // Zero record / revision / burn writes (burn rolled back with the refusal).
      const liveAfter = (await q('SELECT data, version FROM meta_records WHERE id = $1 AND sheet_id = $2', [REC_A, SHEET]))
        .rows[0] as { data: Record<string, unknown>; version: number }
      expect(liveAfter).toEqual(liveBefore)
      expect(Number(
        ((await q('SELECT count(*)::int c FROM meta_recovery_token_burns WHERE sheet_id = $1', [SHEET])).rows[0] as { c: number }).c,
      )).toBe(burnsBefore)
      expect(Number(
        ((await q(
          `SELECT count(*)::int c FROM meta_record_revisions WHERE sheet_id = $1 AND source = 'restore'`,
          [SHEET],
        )).rows[0] as { c: number }).c,
      )).toBe(revsBefore)

      // Regrant permission: burn rolled back ⇒ the SAME token can execute successfully (retry contract).
      await q('DELETE FROM field_permissions WHERE sheet_id = $1 AND field_id = $2 AND subject_id = $3', [
        SHEET, F_STR, ACTOR,
      ])
      const retry = await revertExecute({ previewIdentity: token })
      expect(retry.status).toBe(200)
      expect(retry.body?.data?.revertedCount).toBeGreaterThanOrEqual(1)
      const liveOk = (await q('SELECT data FROM meta_records WHERE id = $1', [REC_A])).rows[0] as {
        data: Record<string, unknown>
      }
      expect(liveOk.data[F_STR]).toBe('A-at-anchor')
      expect(Number(
        ((await q('SELECT count(*)::int c FROM meta_recovery_token_burns WHERE sheet_id = $1', [SHEET])).rows[0] as { c: number }).c,
      )).toBe(burnsBefore + 1)
    } finally {
      try { await holder.query('ROLLBACK') } catch { /* already committed/released */ }
      holder.release()
      await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    }
  })

  test('trust OFF (strict missing): preview/execute refuse RECOVERY_TRUST_REQUIRED — no token / zero writes', async () => {
    process.env.MULTITABLE_ENABLE_SHEET_REVERT = 'true'
    process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
    // CONTIGUITY_STRICT intentionally unset
    const { anchorOp } = await seedWorld()
    const pv = await revertPreview({ anchorOperationId: anchorOp })
    expect(pv.status).toBe(409)
    expect(pv.body?.error?.code).toBe('RECOVERY_TRUST_REQUIRED')
    expect(pv.body?.data?.previewIdentity).toBeUndefined()
    const before = (await q('SELECT data FROM meta_records WHERE id = $1', [REC_A])).rows[0]
    // Mint a token under full trust then drop strict to prove execute refuses
    enableRecoveryExecute()
    const pv2 = await revertPreview({ anchorOperationId: anchorOp })
    const token = pv2.body?.data?.previewIdentity as string
    delete process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT
    process.env.MULTITABLE_ENABLE_SHEET_REVERT = 'true'
    process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
    const ex = await revertExecute({ previewIdentity: token })
    expect(ex.status).toBe(409)
    expect(ex.body?.error?.code).toBe('RECOVERY_TRUST_REQUIRED')
    expect((await q('SELECT data FROM meta_records WHERE id = $1', [REC_A])).rows[0]).toEqual(before)
    expect(Number(((await q('SELECT count(*)::int c FROM meta_recovery_token_burns WHERE sheet_id = $1', [SHEET])).rows[0] as { c: number }).c)).toBe(0)
  })

  test('RECORD_LOCKED: locked target → 409 RECORD_LOCKED values-free, zero writes', async () => {
    enableRecoveryExecute()
    const { anchorOp } = await seedWorld()
    await q('UPDATE meta_records SET locked = true, locked_by = $1 WHERE id = $2 AND sheet_id = $3', ['someone-else', REC_A, SHEET])
    const pv = await revertPreview({ anchorOperationId: anchorOp })
    expect(pv.status).toBe(200)
    const token = pv.body?.data?.previewIdentity as string
    const ex = await revertExecute({ previewIdentity: token })
    expect(ex.status).toBe(409)
    expect(ex.body?.error?.code).toBe('RECORD_LOCKED')
    expect(JSON.stringify(ex.body)).not.toMatch(/rev-now|A-live-now|A-at-anchor/) // values-free
    expect(Number(((await q('SELECT count(*)::int c FROM meta_recovery_token_burns WHERE sheet_id = $1', [SHEET])).rows[0] as { c: number }).c)).toBe(0)
  })

  test('doomed resurrect preview: discloses undelete set but mints NO executable token', async () => {
    enableRecoveryExecute()
    process.env.MULTITABLE_ENABLE_PIT_UNDELETE = 'true'
    const { anchorOp, seqBase } = await seedWorld()
    // Record present at anchor, deleted after → resurrect candidate (inbound-unprovable)
    const REC_DEL = `rec_earw_del_${TS}`
    await sealOp(REC_DEL, [
      { seq: String(seqBase - 50n), version: 1, action: 'create', snap: { [F_STR]: 'was-at-anchor' }, batchId: `batch_del_pre_${TS}` },
    ])
    await sealOp(REC_DEL, [
      { seq: String(seqBase + 1400n), version: 1, action: 'delete', snap: { [F_STR]: 'was-at-anchor' }, batchId: `batch_del_post_${TS}` },
    ])
    await q(
      'INSERT INTO meta_records_trash (record_id, sheet_id, data, original_version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_DEL, SHEET, JSON.stringify({ [F_STR]: 'was-at-anchor' })],
    )
    await q(
      `SELECT setval('meta_record_chain_seq', GREATEST((SELECT last_value FROM meta_record_chain_seq), $1::bigint), true)`,
      [String(seqBase + 2000n)],
    ).catch(() => {})
    const pv = await revertPreview({ anchorOperationId: anchorOp })
    expect(pv.status).toBe(200)
    expect(pv.body?.data?.undeleteSupported).toBe(false)
    expect(pv.body?.data?.undeleteBlockedReason).toBe('INBOUND_UNPROVABLE')
    expect((pv.body?.data?.undeleteRecordIds as string[] | undefined)?.length ?? 0).toBeGreaterThanOrEqual(1)
    // Doomed: no executable token (even if reverts are also present)
    expect(pv.body?.data?.previewIdentity).toBeNull()
  })

  test('healed-gap trust failure is collapsed to RECOVERY_TRUST_REQUIRED before minting a token', async () => {
    enableRecoveryExecute()
    const { anchorOp, seqBase } = await seedWorld()
    // Healed gap: live at version 3 with only v1+v3 revisions (delete v2) on REC_A
    await sealOp(REC_A, [
      { seq: String(seqBase + 1500n), version: 3, action: 'update', snap: { [F_STR]: 'healed-v3' }, batchId: `batch_healed_${TS}` },
    ])
    await q('UPDATE meta_records SET version = 3, data = $1::jsonb WHERE id = $2 AND sheet_id = $3', [
      JSON.stringify({ [F_STR]: 'healed-v3' }), REC_A, SHEET,
    ])
    await q('DELETE FROM meta_record_revisions WHERE record_id = $1 AND version = 2 AND sheet_id = $2', [REC_A, SHEET])
    const pv = await revertPreview({ anchorOperationId: anchorOp })
    expect(pv.status).toBe(409)
    expect(pv.body?.error?.code).toBe('RECOVERY_TRUST_REQUIRED')
    expect(pv.body?.data?.previewIdentity).toBeUndefined()
    expect(JSON.stringify(pv.body)).not.toMatch(/healed-v3|A-live-now/) // values-free
  })

  test('retention stop: reset refuses while meta revision retention is enabled', async () => {
    process.env.MULTITABLE_ENABLE_PIT_RESET = 'true'
    process.env.MULTITABLE_META_REVISION_RETENTION_ENABLED = '1'
    const { anchorOp } = await seedWorld()
    const pv = await resetPreview({ anchorOperationId: anchorOp })
    expect(pv.status).toBe(409)
    expect(pv.body?.error?.code).toBe('RESET_RETENTION_CONFLICT')
  })

  test('non-admin cannot preview; wall-clock and exact-anchor both fail closed without data oracle for denied actors', async () => {
    enableRecoveryExecute()
    curPerms = ['multitable:read', 'multitable:write'] // no share → no canManageSheetAccess
    const { anchorOp } = await seedWorld()
    // Wall-clock is uniformly EXACT_ANCHOR_REQUIRED (400) before auth — no integrity/anchor oracle.
    const wall = await revertPreview({ asOf: '2026-01-01T00:00:00.000Z' })
    expect(wall.status).toBe(400)
    expect(wall.body?.error?.code).toBe('EXACT_ANCHOR_REQUIRED')
    // Exact-anchor reaches the D2 admin gate and refuses 403 without disclosing plan/state.
    const exact = await revertPreview({ anchorOperationId: anchorOp })
    expect(exact.status).toBe(403)
    expect(JSON.stringify(exact.body)).not.toMatch(/A-live-now|A-at-anchor|previewIdentity/)
  })

  test('NO-ORACLE: canManage + field visible=false full-read fail ⇒ 403 FORBIDDEN, never HISTORY_INCOMPLETE/token', async () => {
    enableRecoveryExecute()
    try {
      const { anchorOp, seqBase } = await seedWorld()
      // Healed gap would be HISTORY_INCOMPLETE if integrity ran before full-read
      await sealOp(REC_A, [
        { seq: String(seqBase + 1500n), version: 3, action: 'update', snap: { [F_STR]: 'healed-v3' }, batchId: `batch_oracle_${TS}` },
      ])
      await q('UPDATE meta_records SET version = 3, data = $1::jsonb WHERE id = $2 AND sheet_id = $3', [
        JSON.stringify({ [F_STR]: 'healed-v3' }), REC_A, SHEET,
      ])
      await q('DELETE FROM meta_record_revisions WHERE record_id = $1 AND version = 2 AND sheet_id = $2', [REC_A, SHEET])
      // Field permission that fails full-table-read (visible=false for actor).
      await q('DELETE FROM field_permissions WHERE sheet_id = $1 AND field_id = $2 AND subject_id = $3', [SHEET, F_STR, ACTOR]).catch(() => {})
      await q(
        `INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only)
         VALUES ($1,$2,'user',$3,false,false)`,
        [SHEET, F_STR, ACTOR],
      )
      const pv = await revertPreview({ anchorOperationId: anchorOp })
      expect(pv.status).toBe(403)
      expect(pv.body?.error?.code).toBe('FORBIDDEN')
      expect(pv.body?.error?.code).not.toBe('HISTORY_INCOMPLETE')
      expect(pv.body?.error?.code).not.toBe('SHEET_TOO_LARGE')
      expect(pv.body?.data?.previewIdentity).toBeUndefined()
      expect(JSON.stringify(pv.body)).not.toMatch(/healed-v3|A-live-now|A-at-anchor/)
    } finally {
      await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    }
  })
})

// Fail-not-skip when this file is selected under the real-DB allowlist without DATABASE_URL.
test('sentinel: the real-DB allowlist step must have DATABASE_URL (fail-not-skip, scoped to that step)', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('real-DB allowlist step is missing DATABASE_URL — the harness is broken, not legitimately skippable')
  }
  expect(true).toBe(true)
})
