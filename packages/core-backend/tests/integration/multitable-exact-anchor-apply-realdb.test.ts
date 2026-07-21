/**
 * W0-1 v3.7 Lane L8 — the exact-anchor DESTRUCTIVE APPLY (real DB): one transaction, all-or-nothing.
 *
 * Module under test: `exact-anchor-recovery-execute.ts` `applyExactAnchorRecovery`. Goldens include:
 *   HAPPY-REVERT      restorable revert lands; revision source=restore + ledger-tagged; endpoint sealed;
 *                     token burned. Resurrect is fail-closed (inbound-unprovable) — success paths do not
 *                     depend on resurrection.
 *   MODE-MATRIX       reset deletes createdAfterAnchor (trash + delete revision); revert keeps them.
 *   REPLAY / LIVE-DRIFT / AUTH / PLAN-AUTH (+ no-oracle over value-invalid/missing-target) /
 *                     DRIFT-REJECT / link+reset parity / trust substrate.
 *   RESTORABLE-PROJECTION  formula preserved; derived-only ⇒ no revision/version/link/endpoint BUT token burns.
 *   SCHEMA-HASH-DRIFT      post-preview retype / property-only change ⇒ schema-drift; missing field still covered.
 *   VALUE-INVALID     unsafe rich longText / select-option drift refuse with zero writes.
 *   LINK-INTEGRITY    missing target, wrong sheet, alias ambiguity, same-op delete target, hierarchy cycle.
 *   RESET two-phase   cross-linked delete candidates both get inbound tombstones.
 *
 * W2 wires the module to the legacy revert/reset routes; production flags remain default OFF. This suite
 * still exercises the kernel directly and toggles flags only inside the test process.
 * P2-C hygiene: seqs reserved via nextval() only (never setval on the shared chain sequence); own-row
 * cleanup. Two-point wiring: plugin-tests.yml real-DB run list + vitest glob; fail-not-skip sentinel.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { pool } from '../../src/db/pg'
import { resolveExactAnchor } from '../../src/multitable/exact-anchor-recovery'
import { applyExactAnchorRecovery, pruneExpiredRecoveryTokenBurns, type ExactAnchorApplyMode } from '../../src/multitable/exact-anchor-recovery-execute'
import { countInboundLinkCaptureRows, isTombstoneCaptureEnabled } from '../../src/multitable/tombstone-capture'
import {
  hashAnchorRecoveryScope,
  hashExactAnchorSchema,
  hashRecoveryAuthorizationScope,
  mintExactAnchorRecoveryIdentity,
} from '../../src/multitable/restore-preview-identity'
import { activateCheckpoint, type QueryFn } from '../../src/multitable/history-trust-checkpoint'
import { __resetRecoveryWriterStateColumnProbe } from '../../src/multitable/canonical-sheet-fence'
import { __resetOperationLedgerColumnProbe } from '../../src/multitable/operation-ledger'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const FLAG = 'MULTITABLE_ENABLE_WRITER_FENCE'
const STRICT = 'MULTITABLE_HISTORY_CONTIGUITY_STRICT'
const CAPTURE_FLAG = 'MULTITABLE_TOMBSTONE_CAPTURE_ENABLED'
const TS = Date.now()
const BASE = `base_eaa_${TS}`
const SHEET = `sheet_eaa_${TS}`
const F_STR = `fld_eaa_note_${TS}`
const F_LINK = `fld_eaa_link_${TS}`
const ACTOR = `user_eaa_${TS}`

const q = (sql: string, params: unknown[] = []) => poolManager.get().query(sql, params)
const txn = <T>(fn: (query: QueryFn) => Promise<T>): Promise<T> =>
  poolManager.get().transaction(async ({ query }) => fn(query as unknown as QueryFn)) as Promise<T>

// Kernel adjudication stubs (route injects real evaluators).
const ALLOW_FULL_READ = async () => true
const DENY_FULL_READ = async () => false
const ALLOW_PLAN = async () => true
const DENY_PLAN = async () => false

const applyArgs = (token: string, opts?: { fullRead?: typeof ALLOW_FULL_READ; planAuth?: typeof ALLOW_PLAN }) => ({
  token,
  sheetId: SHEET,
  actorId: ACTOR,
  evaluateFullReadAccess: opts?.fullRead ?? ALLOW_FULL_READ,
  evaluatePlanAuthorization: opts?.planAuth ?? ALLOW_PLAN,
})

const revSeq = (recordId: string, version: number, action: 'create' | 'update' | 'delete', snap: Record<string, unknown> | null, seq: string, opId?: string | null) =>
  q(
    `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, seq, operation_id)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,'rest',ARRAY[]::text[],'{}'::jsonb,$5::jsonb,$6::bigint,$7::uuid)`,
    [SHEET, recordId, version, action, snap === null ? null : JSON.stringify(snap), seq, opId ?? null],
  )
const live = (id: string, data: Record<string, unknown>, version = 1) =>
  q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,$4)', [id, SHEET, JSON.stringify(data), version])
const liveRow = async (id: string) =>
  (await q('SELECT data, version FROM meta_records WHERE id = $1 AND sheet_id = $2', [id, SHEET])).rows[0] as { data: Record<string, unknown>; version: number } | undefined
const modifiedBy = async (id: string) =>
  ((await q('SELECT modified_by FROM meta_records WHERE id = $1 AND sheet_id = $2', [id, SHEET])).rows[0] as { modified_by: string | null } | undefined)?.modified_by
const burnCount = async () => Number(((await q('SELECT count(*)::int c FROM meta_recovery_token_burns WHERE sheet_id = $1', [SHEET])).rows[0] as { c: number }).c)
const trashCount = async (recordId: string) => Number(((await q('SELECT count(*)::int c FROM meta_records_trash WHERE record_id = $1 AND sheet_id = $2', [recordId, SHEET])).rows[0] as { c: number }).c)
const linkTargets = async (fieldId: string, recordId: string) =>
  ((await q('SELECT foreign_record_id FROM meta_links WHERE field_id = $1 AND record_id = $2 ORDER BY foreign_record_id', [fieldId, recordId])).rows as Array<{ foreign_record_id: string }>)
    .map((r) => r.foreign_record_id)
const linkEdgeCount = async (recordId: string) =>
  Number(((await q('SELECT count(*)::int c FROM meta_links WHERE record_id = $1 OR foreign_record_id = $1', [recordId])).rows[0] as { c: number }).c)
const insertLink = (fieldId: string, recordId: string, foreignId: string) =>
  q(
    `INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)`,
    [`lnk_${fieldId}_${recordId}_${foreignId}`.slice(0, 50), fieldId, recordId, foreignId],
  )

/** Seal one synthetic operation (endpoint = exact MAX of its tagged event seqs) to serve as the anchor. */
async function sealAnchorOp(recordId: string, eventSeqs: Array<{ seq: string; version: number; action?: 'create' | 'update' | 'delete'; snap?: Record<string, unknown> }>): Promise<string> {
  const opId = randomUUID()
  const maxSeq = eventSeqs.map((e) => e.seq).reduce((a, b) => (BigInt(a) >= BigInt(b) ? a : b))
  await txn(async (query) => {
    for (const e of eventSeqs) {
      await query(
        `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, seq, operation_id)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,'rest',ARRAY[]::text[],'{}'::jsonb,$5::jsonb,$6::bigint,$7::uuid)`,
        [SHEET, recordId, e.version, e.action ?? 'update', JSON.stringify(e.snap ?? { [F_STR]: `v${e.version}` }), e.seq, opId],
      )
    }
    await query(
      `INSERT INTO meta_record_history_operations (sheet_id, operation_id, endpoint_seq, event_count) VALUES ($1,$2::uuid,$3::bigint,$4::int)`,
      [SHEET, opId, maxSeq, eventSeqs.length],
    )
  })
  return opId
}
const activate = () => txn((query) => activateCheckpoint(query, { sheetId: SHEET }))

async function wipe(): Promise<void> {
  // meta_links has no sheet_id — clear via record ownership on this sheet; tombstones are sheet-scoped.
  await q(
    `DELETE FROM meta_links WHERE record_id IN (SELECT id FROM meta_records WHERE sheet_id = $1)
       OR foreign_record_id IN (SELECT id FROM meta_records WHERE sheet_id = $1)`,
    [SHEET],
  ).catch(() => {})
  await q('DELETE FROM meta_link_tombstones WHERE sheet_id = $1', [SHEET]).catch(() => {})
  await q('DELETE FROM meta_views WHERE sheet_id = $1', [SHEET]).catch(() => {})
  for (const t of ['meta_history_baselines', 'meta_history_trust_checkpoints', 'meta_recovery_token_burns', 'meta_record_version_markers', 'meta_records_trash', 'meta_record_revisions', 'meta_records'])
    await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET]).catch(() => {})
  await q('DELETE FROM meta_record_history_operations WHERE sheet_id = $1', [SHEET]).catch(() => {})
}

test('sentinel: the real-DB allowlist step must have DATABASE_URL (fail-not-skip, scoped to that step)', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('real-DB allowlist step is missing DATABASE_URL — the harness is broken, not legitimately skippable')
  }
  expect(true).toBe(true)
})

describeIfDatabase('W0-1 v3.7 L8 — exact-anchor destructive apply (real DB)', () => {
  beforeAll(async () => {
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'EAA Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'EAA'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_STR, SHEET, 'Note', 'string', '{}', 1])
    // Same-sheet forward link field (writable; not a mirror) for REVERT/RESET link-parity goldens.
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [F_LINK, SHEET, 'Rel', 'link', JSON.stringify({ foreignSheetId: SHEET }), 2],
    )
  })
  beforeEach(async () => {
    await wipe()
    process.env[FLAG] = 'true' // trusted substrate — both required by the kernel
    process.env[STRICT] = 'true'
    delete process.env[CAPTURE_FLAG] // default OFF; individual goldens enable when proving capture
    __resetRecoveryWriterStateColumnProbe()
    __resetOperationLedgerColumnProbe()
  })
  afterEach(() => {
    delete process.env[FLAG]
    delete process.env[STRICT]
    delete process.env[CAPTURE_FLAG]
  })
  afterAll(async () => {
    delete process.env[FLAG]
    delete process.env[STRICT]
    delete process.env[CAPTURE_FLAG]
    await wipe()
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
  })

  test('sentinel: DATABASE_URL is set (this suite must RUN, never skip-green)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  /**
   * Reserve `count` REAL sequence values strictly ABOVE the active checkpoint's trusted_since_seq
   * using nextval() only — NEVER setval (no cross-suite sequence coupling).
   */
  async function seqBand(count: number): Promise<string[]> {
    await activate()
    const floorRes = await q(
      `SELECT trusted_since_seq::text AS s FROM meta_history_trust_checkpoints
       WHERE sheet_id = $1 AND state = 'active' AND pruned_at IS NULL`,
      [SHEET],
    )
    const floor = BigInt(String((floorRes.rows[0] as { s: string }).s))
    const seqs: string[] = []
    // Drain nextval until we sit above the floor, then take `count` consecutive values.
    while (seqs.length < count) {
      const r = await q(`SELECT nextval('meta_record_chain_seq')::text AS s`)
      const s = BigInt(String((r.rows[0] as { s: string }).s))
      if (s > floor) seqs.push(String(s))
    }
    return seqs
  }

  /** Additional real nextval() seqs (does not re-activate). */
  async function moreSeqs(count: number): Promise<string[]> {
    const seqs: string[] = []
    for (let i = 0; i < count; i++) {
      const r = await q(`SELECT nextval('meta_record_chain_seq')::text AS s`)
      seqs.push(String((r.rows[0] as { s: string }).s))
    }
    return seqs
  }

  /**
   * Standard SUCCESS world (no resurrection): R_REV live differs from at-anchor; R_NEW created after.
   * Resurrection is fail-closed (`inbound-unprovable`); success goldens must not depend on it.
   */
  async function seedWorld() {
    const R_REV = `rec_rev_${TS}_${Math.random().toString(36).slice(2, 6)}`
    const R_NEW = `rec_new_${TS}_${Math.random().toString(36).slice(2, 6)}`
    const [sCreate, sUpdate, sNew] = await seqBand(3)
    const anchorOp = await sealAnchorOp(R_REV, [
      { seq: sCreate, version: 1, action: 'create', snap: { [F_STR]: 'rev-at-anchor' } },
    ])
    await revSeq(R_REV, 2, 'update', { [F_STR]: 'rev-now' }, sUpdate)
    await revSeq(R_NEW, 1, 'create', { [F_STR]: 'newbie' }, sNew)
    await live(R_REV, { [F_STR]: 'rev-now' }, 2)
    await live(R_NEW, { [F_STR]: 'newbie' }, 1)
    return { R_REV, R_NEW, anchorOp, seqs: { sCreate, sUpdate, sNew } }
  }

  /** World that produces a genuine RESURRECT plan entry (deleted AFTER the anchor, no live row). */
  async function seedWorldWithResurrect() {
    const R_REV = `rec_rev_${TS}_${Math.random().toString(36).slice(2, 6)}`
    const R_NEW = `rec_new_${TS}_${Math.random().toString(36).slice(2, 6)}`
    const R_RES = `rec_res_${TS}_${Math.random().toString(36).slice(2, 6)}`
    const [sResCreate, sCreate, sUpdate, sResDel, sNew] = await seqBand(5)
    const anchorOp = await sealAnchorOp(R_REV, [
      { seq: sCreate, version: 1, action: 'create', snap: { [F_STR]: 'rev-at-anchor' } },
    ])
    await revSeq(R_RES, 1, 'create', { [F_STR]: 'res-at-anchor' }, sResCreate)
    await revSeq(R_REV, 2, 'update', { [F_STR]: 'rev-now' }, sUpdate)
    await revSeq(R_RES, 1, 'delete', { [F_STR]: 'res-at-anchor' }, sResDel)
    await revSeq(R_NEW, 1, 'create', { [F_STR]: 'newbie' }, sNew)
    await live(R_REV, { [F_STR]: 'rev-now' }, 2)
    await live(R_NEW, { [F_STR]: 'newbie' }, 1)
    await q(
      'INSERT INTO meta_records_trash (record_id, sheet_id, data, original_version) VALUES ($1,$2,$3::jsonb,$4)',
      [R_RES, SHEET, JSON.stringify({ [F_STR]: 'res-at-anchor' }), 1],
    )
    return { R_REV, R_NEW, R_RES, anchorOp }
  }
  // P1-1: the MODE is chosen at PREVIEW and frozen into the token — the apply has no mode input at all.
  const preview = async (anchorOp: string, mode: ExactAnchorApplyMode = 'revert') => {
    const res = await resolveExactAnchor(q as unknown as QueryFn, { sheetId: SHEET, request: { kind: 'exact-anchor', anchorOperationId: anchorOp }, actorId: ACTOR, mode, evaluateFullReadAccess: ALLOW_FULL_READ })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('preview failed')
    return res
  }

  test('HAPPY-REVERT: atomic apply — restorable revert lands, revision source=restore + ledger-tagged, endpoint sealed, token burned, created-after kept', async () => {
    const { R_REV, R_NEW, anchorOp } = await seedWorld()
    const pv = await preview(anchorOp)
    const out = await applyExactAnchorRecovery(txn, applyArgs(pv.token))
    expect(out).toMatchObject({ ok: true, mode: 'revert', applied: { reverts: 1, resurrects: 0, deletes: 0 } })

    expect((await liveRow(R_REV))?.data).toEqual({ [F_STR]: 'rev-at-anchor' }) // reverted
    expect((await liveRow(R_REV))?.version).toBe(3) // version+1, never rewound
    expect(await modifiedBy(R_REV)).toBe(ACTOR) // restore is the visible modifying action
    expect(await liveRow(R_NEW)).toBeDefined() // revert KEEPS created-after-anchor

    const revRows = (await q(
      `SELECT operation_id::text AS op, changed_field_ids FROM meta_record_revisions WHERE sheet_id = $1 AND source = 'restore'`,
      [SHEET],
    )).rows as Array<{ op: string | null; changed_field_ids: string[] }>
    expect(revRows.length).toBe(1)
    expect(revRows[0].op).toBeTruthy()
    expect(revRows[0].changed_field_ids).toEqual([F_STR]) // true restorable delta only
    const ep = (await q('SELECT event_count FROM meta_record_history_operations WHERE sheet_id = $1 AND operation_id = $2::uuid', [SHEET, revRows[0].op])).rows[0] as { event_count: number }
    expect(ep.event_count).toBe(1)
    expect(await burnCount()).toBe(1)
  })

  test('MODE-MATRIX: reset deletes createdAfterAnchor (with delete revision + trash); revert keeps it', async () => {
    const { R_NEW, anchorOp } = await seedWorld()
    const pv = await preview(anchorOp, 'reset')
    const out = await applyExactAnchorRecovery(txn, applyArgs(pv.token))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.mode).toBe('reset')
    expect(out.applied.deletes).toBe(1) // R_NEW deleted by reset
    expect(await liveRow(R_NEW)).toBeUndefined()
    const delRev = (await q(
      `SELECT snapshot FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2 AND action = 'delete' AND source = 'restore'`,
      [SHEET, R_NEW],
    )).rows[0] as { snapshot: Record<string, unknown> } | undefined
    expect(delRev?.snapshot).toEqual({ [F_STR]: 'newbie' })
    expect(await trashCount(R_NEW)).toBe(1)
  })

  test('REPLAY: a second execute of the SAME token ⇒ token-replayed, zero writes', async () => {
    const { R_REV, anchorOp } = await seedWorld()
    const pv = await preview(anchorOp)
    expect((await applyExactAnchorRecovery(txn, applyArgs(pv.token))).ok).toBe(true)
    const afterFirst = await liveRow(R_REV)
    const second = await applyExactAnchorRecovery(txn, applyArgs(pv.token))
    expect(second).toEqual({ ok: false, reason: 'token-replayed' })
    expect(await liveRow(R_REV)).toEqual(afterFirst) // untouched by the replay attempt
    expect(await burnCount()).toBe(1) // still exactly one burn
  })

  test('LIVE-DRIFT: a concurrent committed write between preview and execute ⇒ preview-drift, ZERO writes incl. the burn (token survives once restored)', async () => {
    const { R_REV, anchorOp, seqs } = await seedWorld()
    const pv = await preview(anchorOp)
    // Proper revision + version bump (strict contiguity stays green) but liveSetHash diverges from the token.
    const sBump = String(BigInt(seqs.sNew) + 1000n)
    await revSeq(R_REV, 3, 'update', { [F_STR]: 'rev-now' }, sBump)
    await q('UPDATE meta_records SET version = 3 WHERE id = $1 AND sheet_id = $2', [R_REV, SHEET])
    const out = await applyExactAnchorRecovery(txn, applyArgs(pv.token))
    expect(out).toEqual({ ok: false, reason: 'preview-drift' })
    expect((await liveRow(R_REV))?.version).toBe(3)
    expect(await burnCount()).toBe(0)
    // Undo concurrent write (delete the post-preview rev + rewind version) so the same token applies.
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2 AND version = 3', [SHEET, R_REV])
    await q('UPDATE meta_records SET version = 2 WHERE id = $1 AND sheet_id = $2', [R_REV, SHEET])
    expect((await applyExactAnchorRecovery(txn, applyArgs(pv.token))).ok).toBe(true)
  })

  test('CHECKPOINT-GONE / CHECKPOINT-CHANGED: the in-fence re-resolution never trusts the token echo', async () => {
    const { anchorOp } = await seedWorld()
    const pv = await preview(anchorOp)
    // (a) remove the covering checkpoint entirely ⇒ no-covering-checkpoint, zero writes.
    await q('DELETE FROM meta_history_baselines WHERE sheet_id = $1', [SHEET])
    await q('DELETE FROM meta_history_trust_checkpoints WHERE sheet_id = $1', [SHEET])
    expect(await applyExactAnchorRecovery(txn, applyArgs(pv.token)))
      .toEqual({ ok: false, reason: 'no-covering-checkpoint' })
    expect(await burnCount()).toBe(0)
    // (b) restore a covering checkpoint with a DIFFERENT id than the token bound ⇒ checkpoint-changed.
    await activate()
    const liveRows = (await q('SELECT id, version FROM meta_records WHERE sheet_id = $1', [SHEET])).rows as Array<{ id: string; version: number }>
    const floor = (await q(
      `SELECT trusted_since_seq::text AS s, id FROM meta_history_trust_checkpoints
       WHERE sheet_id = $1 AND state = 'active'`,
      [SHEET],
    )).rows[0] as { s: string; id: string }
    // Token still binds the deleted original checkpointId; re-resolution finds a different covering id.
    // If the new floor is above the anchor, select returns null (no-covering); if below, different id (changed).
    const out = await applyExactAnchorRecovery(txn, applyArgs(pv.token))
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(['checkpoint-changed', 'no-covering-checkpoint']).toContain(out.reason)
    }
    expect(await burnCount()).toBe(0)
  })

  test('INJECTED-FAILURE: a mid-apply seal crash rolls back EVERYTHING (no record change, no revisions, no endpoint, no burn)', async () => {
    const { R_REV, anchorOp } = await seedWorld()
    const pv = await preview(anchorOp)
    const fn = `eaa_inj_seal_fail_${TS}`
    const trg = `trg_eaa_inj_seal_fail_${TS}`
    await q(`CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected seal failure'; END $$ LANGUAGE plpgsql`)
    await q(`CREATE TRIGGER ${trg} BEFORE INSERT ON meta_record_history_operations FOR EACH ROW WHEN (NEW.sheet_id = '${SHEET}') EXECUTE FUNCTION ${fn}()`)
    try {
      await expect(applyExactAnchorRecovery(txn, applyArgs(pv.token))).rejects.toThrow()
      expect((await liveRow(R_REV))?.data).toEqual({ [F_STR]: 'rev-now' })
      expect((await liveRow(R_REV))?.version).toBe(2)
      expect(Number(((await q(`SELECT count(*)::int c FROM meta_record_revisions WHERE sheet_id = $1 AND source = 'restore'`, [SHEET])).rows[0] as { c: number }).c)).toBe(0)
      expect(await burnCount()).toBe(0)
    } finally {
      await q(`DROP TRIGGER IF EXISTS ${trg} ON meta_record_history_operations`).catch(() => {})
      await q(`DROP FUNCTION IF EXISTS ${fn}()`).catch(() => {})
    }
  })

  test('BASELINE composition: preview shows baseline-composed set; apply refuses inbound-unprovable when a baseline-only exists-at-anchor row needs resurrection', async () => {
    const R_BASE = `rec_base_${TS}`
    const R_TRASHED = `rec_trashed_${TS}`
    const R_REV = `rec_rev_${TS}_bl`
    const [sCreate] = await seqBand(1)
    const anchorOp = await sealAnchorOp(R_REV, [{ seq: sCreate, version: 1, action: 'create', snap: { [F_STR]: 'x' } }])
    await live(R_REV, { [F_STR]: 'x' }, 1)
    const ck = await q(
      `SELECT id AS "checkpointId" FROM meta_history_trust_checkpoints WHERE sheet_id = $1 AND state = 'active'`,
      [SHEET],
    ).then((r) => r.rows[0])
    const ckId = (ck as { checkpointId: string }).checkpointId
    await q(
      `INSERT INTO meta_history_baselines (checkpoint_id, sheet_id, record_id, data, version, is_trashed)
       VALUES ($1,$2,$3,$4::jsonb,5,false), ($1,$2,$5,$6::jsonb,2,true)`,
      [ckId, SHEET, R_BASE, JSON.stringify({ [F_STR]: 'from-baseline' }), R_TRASHED, JSON.stringify({ [F_STR]: 'was-trashed' })],
    )
    const pv = await preview(anchorOp)
    expect(pv.stateMap.get(R_BASE)).toMatchObject({ exists: true, data: { [F_STR]: 'from-baseline' } })
    expect(pv.stateMap.get(R_TRASHED)).toMatchObject({ exists: false })
    // R_BASE is a resurrect candidate (exists at-anchor, no live row) ⇒ whole-apply inbound-unprovable.
    const out = await applyExactAnchorRecovery(txn, applyArgs(pv.token))
    expect(out).toEqual({ ok: false, reason: 'inbound-unprovable' })
    expect(await liveRow(R_BASE)).toBeUndefined()
    expect(await burnCount()).toBe(0)
  })

  test('BASELINE corruption after preview: apply refuses history-incomplete and rolls back the burn before any recovery write', async () => {
    const { R_REV, anchorOp } = await seedWorld()
    const pv = await preview(anchorOp)
    const before = await liveRow(R_REV)
    await q(
      `INSERT INTO meta_history_baselines (checkpoint_id, sheet_id, record_id, data, version, is_trashed)
       VALUES ($1,$2,$3,$4::jsonb,1,false)`,
      [pv.checkpointId, SHEET, `rec_corrupt_apply_${TS}`, JSON.stringify('not-an-object')],
    )

    expect(await applyExactAnchorRecovery(txn, applyArgs(pv.token)))
      .toEqual({ ok: false, reason: 'history-incomplete' })
    expect(await liveRow(R_REV)).toEqual(before)
    expect(await burnCount()).toBe(0)
    expect(Number(((await q(
      `SELECT count(*)::int c FROM meta_record_revisions WHERE sheet_id = $1 AND source = 'restore'`,
      [SHEET],
    )).rows[0] as { c: number }).c)).toBe(0)
  })

  test('LOCKED record: a lock held by ANOTHER actor ⇒ record-locked (values-free), zero writes; unlocking lets it through', async () => {
    const { R_REV, anchorOp } = await seedWorld()
    await q('UPDATE meta_records SET locked = true, locked_by = $1 WHERE id = $2 AND sheet_id = $3', ['someone-else', R_REV, SHEET])
    const pv = await preview(anchorOp) // lock columns are not part of the live {id, version} fingerprint
    expect(await applyExactAnchorRecovery(txn, applyArgs(pv.token))).toEqual({ ok: false, reason: 'record-locked' })
    expect((await liveRow(R_REV))?.data).toEqual({ [F_STR]: 'rev-now' }) // nothing applied (all-or-nothing)
    expect(await burnCount()).toBe(0)
    // unlock ⇒ the SAME token applies (the refusal wrote nothing).
    await q('UPDATE meta_records SET locked = false, locked_by = NULL WHERE id = $1 AND sheet_id = $2', [R_REV, SHEET])
    expect((await applyExactAnchorRecovery(txn, applyArgs(pv.token))).ok).toBe(true)
  })

  test('FENCE-PARK (constructed race): a raw client holding the canonical fence parks the apply until release', async () => {
    const { anchorOp } = await seedWorld()
    const pv = await preview(anchorOp)
    expect(pool).toBeTruthy()
    const holder = await pool!.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`meta:auto-number:sheet:${SHEET}`])
      // Launch the apply concurrently — it must PARK on the fence (not proceed, not fail).
      const applying = applyExactAnchorRecovery(txn, applyArgs(pv.token))
      // Sample pg_locks until the apply's advisory-lock wait is visible (bounded loop, no sleeps beyond polling).
      let sawWaiter = false
      for (let i = 0; i < 100; i++) {
        const waiters = await holder.query(
          `SELECT count(*)::int AS c FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
        )
        if (Number((waiters.rows[0] as { c: number }).c) > 0) { sawWaiter = true; break }
        await new Promise((r) => setTimeout(r, 50))
      }
      expect(sawWaiter).toBe(true) // the apply is genuinely parked behind the fence
      await holder.query('COMMIT') // release ⇒ the apply proceeds to completion
      const out = await applying
      expect(out.ok).toBe(true)
    } finally {
      holder.release()
    }
  })

  test('ROW-LOCK-RACE (constructed): external FOR UPDATE on affected row parks L8; unfenced concurrent version bump ⇒ preview-drift, zero burn/writes; undo ⇒ same token applies', async () => {
    // v3.7 §5 step 7: sheet advisory fence alone is not enough — an unfenced writer can still UPDATE the
    // target row between liveSetHash and apply. The FULL live-set SELECT … FOR UPDATE + hash-from-locked-rows
    // must catch it.
    //
    // Construction: hold the target row FOR UPDATE (no sheet fence) → launch L8 → prove L8 is still in-flight
    // after a budget that is long enough for an unblocked apply to finish (so missing FOR UPDATE fails here)
    // → concurrent version bump + COMMIT → L8 wakes and refuses preview-drift.
    const { R_REV, anchorOp, seqs } = await seedWorld()
    const pv = await preview(anchorOp, 'revert')
    expect(pool).toBeTruthy()
    const holder = await pool!.connect()
    try {
      await holder.query('BEGIN')
      await holder.query(
        'SELECT id, version FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE',
        [R_REV, SHEET],
      )
      let applySettled = false
      const applying = applyExactAnchorRecovery(txn, applyArgs(pv.token)).finally(() => {
        applySettled = true
      })
      // Budget >> unblocked L8 latency in this suite (~1–2s worst) so a missing row lock fails this assert
      // (apply would finish ok:true). With FOR UPDATE, L8 must still be in-flight behind our row hold.
      await new Promise((r) => setTimeout(r, 2500))
      expect(applySettled).toBe(false)
      // Concurrent unfenced write while L8 is parked on the old lock.
      const sBump = String(BigInt(seqs.sNew) + 2000n)
      await holder.query(
        `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, seq)
         VALUES (gen_random_uuid(), $1, $2, 3, 'update', 'rest', ARRAY[]::text[], '{}'::jsonb, $3::jsonb, $4::bigint)`,
        [SHEET, R_REV, JSON.stringify({ [F_STR]: 'concurrent' }), sBump],
      )
      await holder.query(
        `UPDATE meta_records SET data = $1::jsonb, version = 3 WHERE id = $2 AND sheet_id = $3`,
        [JSON.stringify({ [F_STR]: 'concurrent' }), R_REV, SHEET],
      )
      await holder.query('COMMIT') // release ⇒ L8 wakes, rechecks version, refuses preview-drift
      const out = await applying
      expect(out).toEqual({ ok: false, reason: 'preview-drift' })
      expect((await liveRow(R_REV))?.version).toBe(3)
      expect((await liveRow(R_REV))?.data).toEqual({ [F_STR]: 'concurrent' })
      expect(await burnCount()).toBe(0)
      expect(Number(((await q(
        `SELECT count(*)::int c FROM meta_record_revisions WHERE sheet_id = $1 AND source = 'restore'`,
        [SHEET],
      )).rows[0] as { c: number }).c)).toBe(0)
    } finally {
      try { await holder.query('ROLLBACK') } catch { /* may already be committed */ }
      holder.release()
    }
    // POSITIVE control: undo concurrent bump so token liveSetHash matches again; same unburned token applies.
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2 AND version = 3', [SHEET, R_REV])
    await q(
      `UPDATE meta_records SET data = $1::jsonb, version = 2 WHERE id = $2 AND sheet_id = $3`,
      [JSON.stringify({ [F_STR]: 'rev-now' }), R_REV, SHEET],
    )
    expect((await applyExactAnchorRecovery(txn, applyArgs(pv.token))).ok).toBe(true)
    expect((await liveRow(R_REV))?.data).toEqual({ [F_STR]: 'rev-at-anchor' })
    expect(await burnCount()).toBe(1)
  })

  // ── P1-1 MODE-BIND: a revert-preview token can NEVER drive a reset ───────────────────────────────────────
  test('MODE-BIND (P1-1): a token minted at revert-preview performs ZERO deletes even with a live reset-delete candidate — the mode rides in the token, the apply has no mode input', async () => {
    const { R_NEW, anchorOp } = await seedWorld() // R_NEW = created-after-anchor ⇒ the reset-delete candidate
    const pv = await preview(anchorOp, 'revert')
    // The pre-fix attack: same unburned token + `mode:'reset'` at the apply call ⇒ R_NEW destroyed. The
    // input no longer HAS a mode — the only thing a caller could vary is gone. The behavioral pin:
    const out = await applyExactAnchorRecovery(txn, applyArgs(pv.token))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.mode).toBe('revert') // the TOKEN's mode
    expect(out.applied.deletes).toBe(0)
    expect(await liveRow(R_NEW)).toBeDefined() // the reset-delete candidate SURVIVES a revert-token apply
  })

  // ── P1-2 IN-FENCE AUTHORIZATION ─────────────────────────────────────────────────────────────────────────
  test('AUTH-INFENCE (P1-2): permission revoked between preview and execute ⇒ forbidden, ZERO writes incl. the burn; re-granted ⇒ the SAME token applies', async () => {
    const { R_REV, anchorOp } = await seedWorld()
    const pv = await preview(anchorOp, 'revert')
    const before = await liveRow(R_REV)
    const denied = await applyExactAnchorRecovery(txn, applyArgs(pv.token, { fullRead: DENY_FULL_READ }))
    expect(denied).toEqual({ ok: false, reason: 'forbidden' })
    expect(await liveRow(R_REV)).toEqual(before) // zero writes
    expect(await burnCount()).toBe(0) // the burn rolled back with the refusal — the token is NOT half-dead
    // re-grant ⇒ the very same token proceeds (fresh adjudication each execute, not a token property).
    expect((await applyExactAnchorRecovery(txn, applyArgs(pv.token))).ok).toBe(true)
  })

  test('AUTH-BASIS (P1-2): a validly-signed token whose authorizedScopeHash mismatches the recomputed basis ⇒ forbidden, zero writes (the token echo is never the authority)', async () => {
    const { R_REV, anchorOp } = await seedWorld()
    const pv = await preview(anchorOp, 'revert')
    const before = await liveRow(R_REV)
    // Same REAL scopeHash/liveSetHash/schemaHash/checkpoint — only the signed authorization basis is wrong.
    const liveRows = (await q('SELECT id, version FROM meta_records WHERE sheet_id = $1', [SHEET])).rows as Array<{ id: string; version: number }>
    const fieldRows = (await q('SELECT id, type, property FROM meta_fields WHERE sheet_id = $1', [SHEET])).rows as Array<{ id: string; type: string; property: unknown }>
    const schemaHash = hashExactAnchorSchema(fieldRows.map((r) => ({ id: String(r.id), type: String(r.type), property: r.property })))
    const liveSetHash = hashAnchorRecoveryScope(liveRows.map((r) => ({ recordId: String(r.id), exists: true, version: Number(r.version) })))
    const claims = {
      sheetId: SHEET, anchorOperationId: anchorOp, anchorSeq: pv.anchorSeq, checkpointId: pv.checkpointId,
      scopeHash: pv.scopeHash, liveSetHash, schemaHash, actorId: ACTOR, mode: 'revert' as const,
      authorizedScopeHash: 'e'.repeat(64),
    }
    const wrongBasis = mintExactAnchorRecoveryIdentity(claims)
    expect(await applyExactAnchorRecovery(txn, applyArgs(wrongBasis)))
      .toEqual({ ok: false, reason: 'forbidden' })
    expect(await liveRow(R_REV)).toEqual(before)
    expect(await burnCount()).toBe(0)
    // POSITIVE control (anti-vacuous): the same mint with the CORRECT basis applies cleanly.
    const rightBasis = mintExactAnchorRecoveryIdentity({
      ...claims,
      authorizedScopeHash: hashRecoveryAuthorizationScope({ sheetId: SHEET, actorId: ACTOR }),
    })
    expect((await applyExactAnchorRecovery(txn, applyArgs(rightBasis))).ok).toBe(true)
  })

  // ── P1-2 / G-SCHEMA SCHEMA-DRIFT WHOLE-REJECT ───────────────────────────────────────────────────────────
  test('DRIFT-REJECT (P1-2): driftCount > 0 / missing field after preview ⇒ the WHOLE apply refuses schema-drift with zero writes incl. the burn — no partial-set apply through drift exclusion', async () => {
    const { R_REV, R_NEW, anchorOp } = await seedWorld()
    const pv = await preview(anchorOp, 'revert')
    const beforeRev = await liveRow(R_REV)
    // Drop the field AFTER preview: schemaHash diverges (G-SCHEMA) AND at-anchor snapshots carry a stale
    // field id (plan.driftCount>0). Either path is schema-drift; both roll the burn back.
    await q('DELETE FROM meta_fields WHERE id = $1 AND sheet_id = $2', [F_STR, SHEET])
    try {
      expect(await applyExactAnchorRecovery(txn, applyArgs(pv.token)))
        .toEqual({ ok: false, reason: 'schema-drift' })
      expect(await liveRow(R_REV)).toEqual(beforeRev) // untouched
      expect(await liveRow(R_NEW)).toBeDefined() // nothing deleted
      expect(await burnCount()).toBe(0) // burn rolled back — token dies by TTL, not half-burn
    } finally {
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (id) DO NOTHING', [F_STR, SHEET, 'Note', 'string', '{}', 1])
    }
    // POSITIVE CONTROL (anti-vacuous, gate NIT-2): with the schema restored, the SAME token — unburned by
    // the refusal above — now applies cleanly. Proves the refusal was attributable to the drift alone.
    expect((await applyExactAnchorRecovery(txn, applyArgs(pv.token))).ok).toBe(true)
  })

  test('SCHEMA-HASH-DRIFT retype: string→longText after preview (value still valid) ⇒ schema-drift, zero writes/burn; restoring type lets the same unburned token apply', async () => {
    const { R_REV, anchorOp } = await seedWorld()
    const pv = await preview(anchorOp, 'revert')
    const before = await liveRow(R_REV)
    // Compatible retype: historical string values remain valid as longText — scalar/live hashes cannot see it.
    await q('UPDATE meta_fields SET type = $1 WHERE id = $2 AND sheet_id = $3', ['longText', F_STR, SHEET])
    try {
      expect(await applyExactAnchorRecovery(txn, applyArgs(pv.token)))
        .toEqual({ ok: false, reason: 'schema-drift' })
      expect(await liveRow(R_REV)).toEqual(before)
      expect(await burnCount()).toBe(0)
    } finally {
      await q('UPDATE meta_fields SET type = $1 WHERE id = $2 AND sheet_id = $3', ['string', F_STR, SHEET])
    }
    expect((await applyExactAnchorRecovery(txn, applyArgs(pv.token))).ok).toBe(true)
  })

  test('SCHEMA-HASH-DRIFT property-only: property.validation change after preview ⇒ schema-drift, zero writes/burn; restoring property lets the same unburned token apply', async () => {
    const { R_REV, anchorOp } = await seedWorld()
    const pv = await preview(anchorOp, 'revert')
    const before = await liveRow(R_REV)
    const originalProp = ((await q('SELECT property FROM meta_fields WHERE id = $1', [F_STR])).rows[0] as { property: unknown }).property
    await q(
      'UPDATE meta_fields SET property = $1::jsonb WHERE id = $2 AND sheet_id = $3',
      [JSON.stringify({ validation: [{ type: 'required' }] }), F_STR, SHEET],
    )
    try {
      expect(await applyExactAnchorRecovery(txn, applyArgs(pv.token)))
        .toEqual({ ok: false, reason: 'schema-drift' })
      expect(await liveRow(R_REV)).toEqual(before)
      expect(await burnCount()).toBe(0)
    } finally {
      await q('UPDATE meta_fields SET property = $1::jsonb WHERE id = $2 AND sheet_id = $3', [
        JSON.stringify(originalProp ?? {}),
        F_STR,
        SHEET,
      ])
    }
    expect((await applyExactAnchorRecovery(txn, applyArgs(pv.token))).ok).toBe(true)
  })

  // ── C: RESURRECT fail-closed (D1c inbound unprovable) ───────────────────────────────────────────────────
  test('INBOUND-UNPROVABLE: a genuine resurrect plan refuses whole-apply with zero writes (all tables byte-identical)', async () => {
    const { R_REV, R_RES, anchorOp } = await seedWorldWithResurrect()
    const beforeRev = await liveRow(R_REV)
    const trashBefore = await trashCount(R_RES)
    expect(trashBefore).toBe(1)
    const revsBefore = Number(((await q('SELECT count(*)::int c FROM meta_record_revisions WHERE sheet_id = $1', [SHEET])).rows[0] as { c: number }).c)
    const pv = await preview(anchorOp, 'revert')
    const out = await applyExactAnchorRecovery(txn, applyArgs(pv.token))
    expect(out).toEqual({ ok: false, reason: 'inbound-unprovable' })
    expect(await liveRow(R_REV)).toEqual(beforeRev)
    expect(await liveRow(R_RES)).toBeUndefined()
    expect(await trashCount(R_RES)).toBe(trashBefore)
    expect(Number(((await q('SELECT count(*)::int c FROM meta_record_revisions WHERE sheet_id = $1', [SHEET])).rows[0] as { c: number }).c)).toBe(revsBefore)
    expect(await burnCount()).toBe(0)
    expect(Number(((await q('SELECT count(*)::int c FROM meta_record_history_operations WHERE sheet_id = $1 AND event_count > 0', [SHEET])).rows[0] as { c: number }).c)).toBeGreaterThanOrEqual(1) // only the seed anchor op
  })

  // ── G3 (pre-wiring gate list): DOUBLE-TOKEN constructed race ─────────────────────────────────────────────
  test('G3 DOUBLE-TOKEN (constructed race): two previews, two concurrent applies — exactly ONE succeeds; the loser refuses preview-drift; exactly one burn', async () => {
    const { anchorOp } = await seedWorld()
    const pv1 = await preview(anchorOp, 'revert')
    await new Promise((r) => setTimeout(r, 1100)) // distinct JWT iat second ⇒ distinct token ⇒ distinct burn PK
    const pv2 = await preview(anchorOp, 'revert')
    expect(pv2.token).not.toBe(pv1.token)

    // Both applies race on the canonical fence (each in its own real transaction/connection). The fence
    // serializes them: the winner commits its reverts/resurrects (bumping live versions); the loser's
    // in-fence live-set re-hash then diverges from ITS token's liveSetHash ⇒ preview-drift, full rollback.
    const [r1, r2] = await Promise.all([
      applyExactAnchorRecovery(txn, applyArgs(pv1.token)),
      applyExactAnchorRecovery(txn, applyArgs(pv2.token)),
    ])
    const oks = [r1, r2].filter((r) => r.ok)
    const refusals = [r1, r2].filter((r) => !r.ok) as Array<{ ok: false; reason: string }>
    expect(oks.length).toBe(1) // exactly one winner
    expect(refusals.length).toBe(1)
    expect(refusals[0].reason).toBe('preview-drift') // the loser saw the winner's committed world
    expect(await burnCount()).toBe(1) // the loser's burn rolled back with its refusal
  })

  // ── LINK / TRASH / TOMBSTONE parity (Codex review P1 — kernel data-integrity, same txn) ──────────────────
  test('REVERT-LINK-SYNC: at-anchor A ← live B — both meta_records.data and meta_links end at A (writable forward only)', async () => {
    const R_A = `rec_lnk_a_${TS}`
    const R_B = `rec_lnk_b_${TS}`
    const R_REV = `rec_lnk_rev_${TS}`
    const [sA, sB, sCreate, sUpdate] = await seqBand(4)
    // Foreign targets exist at/before the anchor so reconstruction is well-formed; R_REV at-anchor points to A.
    await revSeq(R_A, 1, 'create', { [F_STR]: 'A' }, sA)
    await revSeq(R_B, 1, 'create', { [F_STR]: 'B' }, sB)
    const anchorOp = await sealAnchorOp(R_REV, [
      { seq: sCreate, version: 1, action: 'create', snap: { [F_STR]: 'rev-at-anchor', [F_LINK]: [R_A] } },
    ])
    await revSeq(R_REV, 2, 'update', { [F_STR]: 'rev-now', [F_LINK]: [R_B] }, sUpdate)
    await live(R_A, { [F_STR]: 'A' }, 1)
    await live(R_B, { [F_STR]: 'B' }, 1)
    await live(R_REV, { [F_STR]: 'rev-now', [F_LINK]: [R_B] }, 2)
    await insertLink(F_LINK, R_REV, R_B) // live relation projection = B (authoritative meta_links)
    expect(await linkTargets(F_LINK, R_REV)).toEqual([R_B])

    const pv = await preview(anchorOp, 'revert')
    const out = await applyExactAnchorRecovery(txn, applyArgs(pv.token))
    expect(out.ok).toBe(true)
    // POSITIVE: both stores land on A — data alone is not enough (link reads use meta_links).
    expect((await liveRow(R_REV))?.data).toEqual({ [F_STR]: 'rev-at-anchor', [F_LINK]: [R_A] })
    expect(await linkTargets(F_LINK, R_REV)).toEqual([R_A])
  })

  test('RESET-DELETE-PARITY: both-direction meta_links gone, trash + delete_revision_id anchored, inbound tombstone when capture ON', async () => {
    process.env[CAPTURE_FLAG] = 'true'
    // Custom world: R_PEER exists at-anchor (kept by reset); R_NEW created after (deleted by reset) with links.
    const R_REV = `rec_rev_${TS}_${Math.random().toString(36).slice(2, 6)}`
    const R_NEW = `rec_new_${TS}_${Math.random().toString(36).slice(2, 6)}`
    const R_PEER = `rec_peer_${TS}`
    const [sPeer, sCreate, sUpdate, sNew, sNew2] = await seqBand(5)
    const anchorOp = await sealAnchorOp(R_REV, [
      { seq: sCreate, version: 1, action: 'create', snap: { [F_STR]: 'rev-at-anchor' } },
    ])
    await revSeq(R_PEER, 1, 'create', { [F_STR]: 'peer' }, sPeer)
    await revSeq(R_REV, 2, 'update', { [F_STR]: 'rev-now' }, sUpdate)
    await revSeq(R_NEW, 1, 'create', { [F_STR]: 'newbie' }, sNew)
    await revSeq(R_NEW, 2, 'update', { [F_STR]: 'newbie', [F_LINK]: [R_PEER] }, sNew2)
    // R_PEER stays at-anchor-equal (no restorable delta) so a later REVERT cannot clear the
    // inbound meta_links edge before RESET capture — edge lives only in meta_links.
    await live(R_REV, { [F_STR]: 'rev-now' }, 2)
    await live(R_PEER, { [F_STR]: 'peer' }, 1)
    await live(R_NEW, { [F_STR]: 'newbie', [F_LINK]: [R_PEER] }, 2)
    await insertLink(F_LINK, R_NEW, R_PEER)
    await insertLink(F_LINK, R_PEER, R_NEW)
    expect(await linkEdgeCount(R_NEW)).toBe(2)
    process.env.MULTITABLE_TOMBSTONE_CAPTURE_ENABLED = 'true'
    expect(isTombstoneCaptureEnabled()).toBe(true)
    expect(await countInboundLinkCaptureRows(q as unknown as QueryFn, R_NEW)).toBe(1)

    const pv = await preview(anchorOp, 'reset')
    const out = await applyExactAnchorRecovery(txn, applyArgs(pv.token))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.applied.deletes).toBeGreaterThanOrEqual(1)
    expect(await liveRow(R_NEW)).toBeUndefined()
    // Both directions gone — outbound would CASCADE with the row, but inbound would dangle without explicit delete.
    expect(await linkEdgeCount(R_NEW)).toBe(0)
    expect(await linkTargets(F_LINK, R_PEER)).toEqual([]) // inbound edge removed

    const trash = (await q(
      `SELECT data, original_version, delete_revision_id, base_id FROM meta_records_trash
       WHERE record_id = $1 AND sheet_id = $2`,
      [R_NEW, SHEET],
    )).rows[0] as { data: Record<string, unknown>; original_version: number; delete_revision_id: string | null; base_id: string | null } | undefined
    expect(trash).toBeDefined()
    expect(trash!.data).toEqual({ [F_STR]: 'newbie', [F_LINK]: [R_PEER] })
    expect(trash!.original_version).toBe(2)
    expect(trash!.base_id).toBe(BASE)
    expect(typeof trash!.delete_revision_id).toBe('string')
    expect(trash!.delete_revision_id).toBeTruthy()

    // The delete revision shares the pre-generated id anchored on trash + tombstones.
    const delRev = (await q(
      `SELECT id::text AS id FROM meta_record_revisions
       WHERE sheet_id = $1 AND record_id = $2 AND action = 'delete' AND source = 'restore'`,
      [SHEET, R_NEW],
    )).rows[0] as { id: string } | undefined
    expect(delRev?.id).toBe(trash!.delete_revision_id)

    // Capture ON: inbound edge R_PEER→R_NEW was tombstoned under that revision before the links DELETE.
    expect(process.env.MULTITABLE_TOMBSTONE_CAPTURE_ENABLED).toBe('true')
    const tombs = (await q(
      `SELECT record_id, foreign_record_id, reason, source_revision_id::text AS source_revision_id
       FROM meta_link_tombstones
       WHERE foreign_record_id = $1 AND reason = 'record_delete'`,
      [R_NEW],
    )).rows as Array<{ record_id: string; foreign_record_id: string; reason: string; source_revision_id: string }>
    expect(tombs.length).toBeGreaterThanOrEqual(1)
    expect(tombs.some((t) => t.record_id === R_PEER && t.source_revision_id === trash!.delete_revision_id)).toBe(true)
  })

  test('LINK-TRASH-TOMBSTONE-ROLLBACK: injected seal failure rolls back link sync, both-direction link delete, trash, tombstones, revisions, burn together', async () => {
    process.env[CAPTURE_FLAG] = 'true'
    const R_A = `rec_roll_a_${TS}`
    const R_B = `rec_roll_b_${TS}`
    const R_REV = `rec_roll_rev_${TS}`
    const R_NEW = `rec_roll_new_${TS}`
    const R_PEER = `rec_roll_peer_${TS}`
    const [sA, sB, sPeer, sCreate, sUpdate, sNew] = await seqBand(6)
    await revSeq(R_A, 1, 'create', { [F_STR]: 'A' }, sA)
    await revSeq(R_B, 1, 'create', { [F_STR]: 'B' }, sB)
    const anchorOp = await sealAnchorOp(R_REV, [
      { seq: sCreate, version: 1, action: 'create', snap: { [F_STR]: 'rev-at-anchor', [F_LINK]: [R_A] } },
    ])
    await revSeq(R_PEER, 1, 'create', { [F_STR]: 'peer' }, sPeer)
    await revSeq(R_REV, 2, 'update', { [F_STR]: 'rev-now', [F_LINK]: [R_B] }, sUpdate)
    await revSeq(R_NEW, 1, 'create', { [F_STR]: 'newbie', [F_LINK]: [R_PEER] }, sNew)
    await live(R_A, { [F_STR]: 'A' }, 1)
    await live(R_B, { [F_STR]: 'B' }, 1)
    await live(R_PEER, { [F_STR]: 'peer' }, 1)
    await live(R_REV, { [F_STR]: 'rev-now', [F_LINK]: [R_B] }, 2)
    await live(R_NEW, { [F_STR]: 'newbie', [F_LINK]: [R_PEER] }, 1)
    await insertLink(F_LINK, R_REV, R_B)
    await insertLink(F_LINK, R_NEW, R_PEER)
    await insertLink(F_LINK, R_PEER, R_NEW)

    const pv = await preview(anchorOp, 'reset') // reset drives REVERT of R_REV + DELETE of R_NEW
    const fn = `eaa_link_seal_fail_${TS}`
    const trg = `trg_eaa_link_seal_fail_${TS}`
    await q(`CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected seal failure (link/trash rollback)'; END $$ LANGUAGE plpgsql`)
    await q(`CREATE TRIGGER ${trg} BEFORE INSERT ON meta_record_history_operations FOR EACH ROW WHEN (NEW.sheet_id = '${SHEET}') EXECUTE FUNCTION ${fn}()`)
    try {
      await expect(
        applyExactAnchorRecovery(txn, applyArgs(pv.token)),
      ).rejects.toThrow()
      // REVERT link sync rolled back — still B in both stores.
      expect((await liveRow(R_REV))?.data).toEqual({ [F_STR]: 'rev-now', [F_LINK]: [R_B] })
      expect(await linkTargets(F_LINK, R_REV)).toEqual([R_B])
      // RESET delete side effects rolled back — live row, both edge directions, no trash, no tombstone, no burn.
      expect(await liveRow(R_NEW)).toBeDefined()
      expect(await linkEdgeCount(R_NEW)).toBe(2)
      expect(await trashCount(R_NEW)).toBe(0)
      expect(Number(((await q('SELECT count(*)::int c FROM meta_link_tombstones WHERE sheet_id = $1', [SHEET])).rows[0] as { c: number }).c)).toBe(0)
      expect(Number(((await q(`SELECT count(*)::int c FROM meta_record_revisions WHERE sheet_id = $1 AND source = 'restore'`, [SHEET])).rows[0] as { c: number }).c)).toBe(0)
      expect(await burnCount()).toBe(0)
    } finally {
      await q(`DROP TRIGGER IF EXISTS ${trg} ON meta_record_history_operations`).catch(() => {})
      await q(`DROP FUNCTION IF EXISTS ${fn}()`).catch(() => {})
    }
  })

  // ── A: restorable projection (derived preservation / no-op) ────────────────────────────────────────────
  test('RESTORABLE-PROJECTION: formula materialization is preserved; derived-only difference is a no-op (no version/revision/link/endpoint BUT token burns)', async () => {
    const F_FORM = `fld_eaa_formula_${TS}`
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (id) DO NOTHING',
      [F_FORM, SHEET, 'F', 'formula', '{}', 3],
    )
    try {
      const R_REV = `rec_proj_${TS}`
      const [sCreate, sUpdate] = await seqBand(2)
      // At-anchor: string S + formula F. Post-anchor: string changes AND formula materialization drifts.
      const anchorOp = await sealAnchorOp(R_REV, [
        { seq: sCreate, version: 1, action: 'create', snap: { [F_STR]: 'at-anchor', [F_FORM]: 'formula-at' } },
      ])
      await revSeq(R_REV, 2, 'update', { [F_STR]: 'live-now', [F_FORM]: 'formula-at' }, sUpdate)
      // Live formula materialization differs from both snapshots (engine recompute) — non-restorable.
      await live(R_REV, { [F_STR]: 'live-now', [F_FORM]: 'formula-live' }, 2)
      const pv = await preview(anchorOp, 'revert')
      const out = await applyExactAnchorRecovery(txn, applyArgs(pv.token))
      expect(out.ok).toBe(true)
      if (!out.ok) return
      expect(out.applied.reverts).toBe(1)
      const row = await liveRow(R_REV)
      expect(row?.data[F_STR]).toBe('at-anchor') // restorable projected
      expect(row?.data[F_FORM]).toBe('formula-live') // non-restorable PRESERVED
      const rev = (await q(
        `SELECT changed_field_ids, patch, snapshot FROM meta_record_revisions
         WHERE sheet_id = $1 AND record_id = $2 AND source = 'restore'`,
        [SHEET, R_REV],
      )).rows[0] as { changed_field_ids: string[]; patch: Record<string, unknown>; snapshot: Record<string, unknown> }
      expect(rev.changed_field_ids).toEqual([F_STR])
      expect(rev.patch).toEqual({ [F_STR]: 'at-anchor' })
      expect(rev.snapshot[F_FORM]).toBe('formula-live')

      // Derived-only: string already at-anchor; only formula live differs from at-anchor snapshot ⇒ no-op writes.
      await wipe()
      const R2 = `rec_noop_${TS}`
      const [s2] = await seqBand(1)
      const op2 = await sealAnchorOp(R2, [
        { seq: s2, version: 1, action: 'create', snap: { [F_STR]: 'same', [F_FORM]: 'f-at' } },
      ])
      await live(R2, { [F_STR]: 'same', [F_FORM]: 'f-live' }, 1)
      const opsBefore = Number(((await q('SELECT count(*)::int c FROM meta_record_history_operations WHERE sheet_id = $1', [SHEET])).rows[0] as { c: number }).c)
      const linksBefore = Number(((await q(
        `SELECT count(*)::int c FROM meta_links WHERE record_id IN (SELECT id FROM meta_records WHERE sheet_id = $1)`,
        [SHEET],
      )).rows[0] as { c: number }).c)
      const pv2 = await preview(op2, 'revert')
      const out2 = await applyExactAnchorRecovery(txn, applyArgs(pv2.token))
      expect(out2.ok).toBe(true)
      if (!out2.ok) return
      expect(out2.applied.reverts).toBe(0) // no restorable write
      expect((await liveRow(R2))?.version).toBe(1) // no version bump
      expect(Number(((await q(`SELECT count(*)::int c FROM meta_record_revisions WHERE sheet_id = $1 AND source = 'restore'`, [SHEET])).rows[0] as { c: number }).c)).toBe(0)
      // No restore-sourced revision, no version bump, no link mutation, and NO new sealed operation endpoint
      // (sealOperation skips eventCount===0). Successful token consume still burns (anti-replay).
      expect(Number(((await q('SELECT count(*)::int c FROM meta_record_history_operations WHERE sheet_id = $1', [SHEET])).rows[0] as { c: number }).c)).toBe(opsBefore)
      expect(Number(((await q(
        `SELECT count(*)::int c FROM meta_links WHERE record_id IN (SELECT id FROM meta_records WHERE sheet_id = $1)`,
        [SHEET],
      )).rows[0] as { c: number }).c)).toBe(linksBefore)
      expect(await burnCount()).toBe(1)
    } finally {
      await q('DELETE FROM meta_fields WHERE id = $1', [F_FORM]).catch(() => {})
    }
  })

  // ── B: in-fence plan authorization ─────────────────────────────────────────────────────────────────────
  test('PLAN-AUTH: evaluatePlanAuthorization deny ⇒ forbidden, zero burn/revision/data writes', async () => {
    const { R_REV, anchorOp } = await seedWorld()
    const before = await liveRow(R_REV)
    const pv = await preview(anchorOp)
    const denied = await applyExactAnchorRecovery(txn, applyArgs(pv.token, { planAuth: DENY_PLAN }))
    expect(denied).toEqual({ ok: false, reason: 'forbidden' })
    expect(await liveRow(R_REV)).toEqual(before)
    expect(await burnCount()).toBe(0)
  })

  test('PLAN-AUTH-PARK: fence park then revoke plan auth ⇒ forbidden, zero writes (constructed race)', async () => {
    const { R_REV, anchorOp } = await seedWorld()
    const before = await liveRow(R_REV)
    const pv = await preview(anchorOp)
    expect(pool).toBeTruthy()
    let allowPlan = true
    const planAuth = async () => allowPlan
    const holder = await pool!.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`meta:auto-number:sheet:${SHEET}`])
      const applying = applyExactAnchorRecovery(txn, applyArgs(pv.token, { planAuth }))
      let sawWaiter = false
      for (let i = 0; i < 100; i++) {
        const waiters = await holder.query(`SELECT count(*)::int AS c FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)
        if (Number((waiters.rows[0] as { c: number }).c) > 0) { sawWaiter = true; break }
        await new Promise((r) => setTimeout(r, 50))
      }
      expect(sawWaiter).toBe(true)
      allowPlan = false // revoke while parked
      await holder.query('COMMIT')
      const out = await applying
      expect(out).toEqual({ ok: false, reason: 'forbidden' })
      expect(await liveRow(R_REV)).toEqual(before)
      expect(await burnCount()).toBe(0)
      expect(Number(((await q(`SELECT count(*)::int c FROM meta_record_revisions WHERE sheet_id = $1 AND source = 'restore'`, [SHEET])).rows[0] as { c: number }).c)).toBe(0)
    } finally {
      holder.release()
    }
  })

  test('PLAN-AUTH-NO-ORACLE scalar: planAuth=false dominates CURRENT-schema value-invalid (uniform forbidden; validator must not decide)', async () => {
    // Historical XSS HTML would be value-invalid for an authorized writer — a denied writer must NOT see that.
    const F_LT = `fld_eaa_noor_lt_${TS}`
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (id) DO NOTHING',
      [F_LT, SHEET, 'Body', 'longText', JSON.stringify({ rich: true }), 20],
    )
    try {
      const R = `rec_noor_scalar_${TS}`
      const unsafe = '<script>alert(1)</script><p>safe</p>'
      const [sCreate, sUpdate] = await seqBand(2)
      const op = await sealAnchorOp(R, [
        { seq: sCreate, version: 1, action: 'create', snap: { [F_STR]: 'same', [F_LT]: unsafe } },
      ])
      await revSeq(R, 2, 'update', { [F_STR]: 'same', [F_LT]: '<p>clean</p>' }, sUpdate)
      await live(R, { [F_STR]: 'same', [F_LT]: '<p>clean</p>' }, 2)
      const before = await liveRow(R)
      const pv = await preview(op, 'revert')
      // Positive control: authorized path is value-invalid (proves the invalid scalar is real, not vacuous).
      expect(await applyExactAnchorRecovery(txn, applyArgs(pv.token))).toEqual({ ok: false, reason: 'value-invalid' })
      expect(await burnCount()).toBe(0)
      // Denied planAuth: MUST be uniform forbidden — not value-invalid (no validator oracle).
      expect(await applyExactAnchorRecovery(txn, applyArgs(pv.token, { planAuth: DENY_PLAN })))
        .toEqual({ ok: false, reason: 'forbidden' })
      expect(await liveRow(R)).toEqual(before)
      expect(await burnCount()).toBe(0)
    } finally {
      await q('DELETE FROM meta_fields WHERE id = $1', [F_LT]).catch(() => {})
    }
  })

  test('PLAN-AUTH-NO-ORACLE missing-target: planAuth=false dominates link-integrity missing foreign target (uniform forbidden)', async () => {
    const R_A = `rec_noor_a_${TS}`
    const R_REV = `rec_noor_link_${TS}`
    const MISSING = `rec_noor_missing_${TS}`
    const [sA, sCreate, sUpdate] = await seqBand(3)
    await revSeq(R_A, 1, 'create', { [F_STR]: 'A' }, sA)
    const op = await sealAnchorOp(R_REV, [
      { seq: sCreate, version: 1, action: 'create', snap: { [F_STR]: 'x', [F_LINK]: [MISSING] } },
    ])
    await revSeq(R_REV, 2, 'update', { [F_STR]: 'x', [F_LINK]: [R_A] }, sUpdate)
    await live(R_A, { [F_STR]: 'A' }, 1)
    await live(R_REV, { [F_STR]: 'x', [F_LINK]: [R_A] }, 2)
    await insertLink(F_LINK, R_REV, R_A)
    const before = await liveRow(R_REV)
    const pv = await preview(op, 'revert')
    // Positive control: authorized path is link-integrity (missing target exists as a real check).
    expect(await applyExactAnchorRecovery(txn, applyArgs(pv.token))).toEqual({ ok: false, reason: 'link-integrity' })
    expect(await burnCount()).toBe(0)
    // Denied planAuth: MUST be uniform forbidden — not link-integrity (no existence-oracle).
    expect(await applyExactAnchorRecovery(txn, applyArgs(pv.token, { planAuth: DENY_PLAN })))
      .toEqual({ ok: false, reason: 'forbidden' })
    expect(await liveRow(R_REV)).toEqual(before)
    expect(await linkTargets(F_LINK, R_REV)).toEqual([R_A])
    expect(await burnCount()).toBe(0)
  })

  // ── D: foreign-link integrity ──────────────────────────────────────────────────────────────────────────
  test('LINK-INTEGRITY: missing foreign target refuses whole-apply with zero writes', async () => {
    const R_A = `rec_li_a_${TS}`
    const R_REV = `rec_li_rev_${TS}`
    const MISSING = `rec_li_missing_${TS}`
    const [sA, sCreate, sUpdate] = await seqBand(3)
    await revSeq(R_A, 1, 'create', { [F_STR]: 'A' }, sA)
    // At-anchor link points at MISSING; live has R_A — projection would write MISSING ⇒ refuse.
    const op2 = await sealAnchorOp(R_REV, [
      { seq: sCreate, version: 1, action: 'create', snap: { [F_STR]: 'x', [F_LINK]: [MISSING] } },
    ])
    await revSeq(R_REV, 2, 'update', { [F_STR]: 'x', [F_LINK]: [R_A] }, sUpdate)
    await live(R_A, { [F_STR]: 'A' }, 1)
    await live(R_REV, { [F_STR]: 'x', [F_LINK]: [R_A] }, 2)
    await insertLink(F_LINK, R_REV, R_A)
    const pv = await preview(op2, 'revert')
    const out = await applyExactAnchorRecovery(txn, applyArgs(pv.token))
    expect(out).toEqual({ ok: false, reason: 'link-integrity' })
    expect(await linkTargets(F_LINK, R_REV)).toEqual([R_A])
    expect(await burnCount()).toBe(0)
  })

  test('LINK-INTEGRITY wrong-sheet: target exists but on another sheet ⇒ refuse', async () => {
    const OTHER = `${SHEET}_foreign`
    const R_OTHER = `rec_other_sheet_${TS}`
    const R_REV = `rec_ws_rev_${TS}`
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING', [OTHER, BASE, 'other'])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1) ON CONFLICT (id) DO NOTHING', [R_OTHER, OTHER, '{}'])
    try {
      const [sCreate, sUpdate] = await seqBand(2)
      const op = await sealAnchorOp(R_REV, [
        { seq: sCreate, version: 1, action: 'create', snap: { [F_STR]: 'x', [F_LINK]: [R_OTHER] } },
      ])
      await revSeq(R_REV, 2, 'update', { [F_STR]: 'x', [F_LINK]: [] }, sUpdate)
      await live(R_REV, { [F_STR]: 'x', [F_LINK]: [] }, 2)
      const pv = await preview(op, 'revert')
      // F_LINK foreignSheetId = SHEET, but R_OTHER lives on OTHER ⇒ link-integrity.
      expect(await applyExactAnchorRecovery(txn, applyArgs(pv.token))).toEqual({ ok: false, reason: 'link-integrity' })
      expect(await burnCount()).toBe(0)
    } finally {
      await q('DELETE FROM meta_records WHERE id = $1', [R_OTHER]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = $1', [OTHER]).catch(() => {})
    }
  })

  // ── F: trusted substrate ───────────────────────────────────────────────────────────────────────────────
  test('TRUST-SUBSTRATE: fence or strict flag off ⇒ recovery-trust-required, zero writes', async () => {
    const { R_REV, anchorOp } = await seedWorld()
    const before = await liveRow(R_REV)
    const pv = await preview(anchorOp)
    delete process.env[STRICT]
    expect(await applyExactAnchorRecovery(txn, applyArgs(pv.token))).toEqual({ ok: false, reason: 'recovery-trust-required' })
    process.env[STRICT] = 'true'
    delete process.env[FLAG]
    expect(await applyExactAnchorRecovery(txn, applyArgs(pv.token))).toEqual({ ok: false, reason: 'recovery-trust-required' })
    process.env[FLAG] = 'true'
    expect(await liveRow(R_REV)).toEqual(before)
    expect(await burnCount()).toBe(0)
  })

  // ── VALUE-INVALID: current-schema exact validation ────────────────────────────────────────────────────
  test('VALUE-INVALID rich longText: historical XSS HTML that would be sanitized ⇒ value-invalid, zero writes', async () => {
    const F_LT = `fld_eaa_lt_${TS}`
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (id) DO NOTHING',
      [F_LT, SHEET, 'Body', 'longText', JSON.stringify({ rich: true }), 9],
    )
    try {
      const R = `rec_rich_${TS}`
      const unsafe = '<script>alert(1)</script><p>safe</p>'
      const [sCreate, sUpdate] = await seqBand(2)
      // At-anchor carries UNSAFE rich HTML; live is clean — restore would re-introduce it.
      const op = await sealAnchorOp(R, [
        { seq: sCreate, version: 1, action: 'create', snap: { [F_STR]: 'same', [F_LT]: unsafe } },
      ])
      await revSeq(R, 2, 'update', { [F_STR]: 'same', [F_LT]: '<p>clean</p>' }, sUpdate)
      await live(R, { [F_STR]: 'same', [F_LT]: '<p>clean</p>' }, 2)
      const before = await liveRow(R)
      const pv = await preview(op, 'revert')
      const out = await applyExactAnchorRecovery(txn, applyArgs(pv.token))
      expect(out).toEqual({ ok: false, reason: 'value-invalid' })
      expect(await liveRow(R)).toEqual(before)
      expect(await burnCount()).toBe(0)
    } finally {
      await q('DELETE FROM meta_fields WHERE id = $1', [F_LT]).catch(() => {})
    }
  })

  test('VALUE-INVALID required: historical snapshot omits a field that is NOW required ⇒ value-invalid, zero writes', async () => {
    const F_REQ = `fld_eaa_req_${TS}`
    // CURRENT schema: F_REQ is required. Historical at-anchor data only has F_STR (F_REQ omitted).
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (id) DO NOTHING',
      [F_REQ, SHEET, 'Required', 'string', JSON.stringify({ validation: [{ type: 'required' }] }), 12],
    )
    try {
      const R = `rec_req_${TS}`
      const [sCreate, sUpdate] = await seqBand(2)
      const op = await sealAnchorOp(R, [
        { seq: sCreate, version: 1, action: 'create', snap: { [F_STR]: 'at-anchor' } },
      ])
      await revSeq(R, 2, 'update', { [F_STR]: 'live-now', [F_REQ]: 'filled' }, sUpdate)
      await live(R, { [F_STR]: 'live-now', [F_REQ]: 'filled' }, 2)
      const before = await liveRow(R)
      const pv = await preview(op, 'revert')
      // Projection restores at-anchor data without F_REQ (unset/omit) while CURRENT requires it.
      expect(await applyExactAnchorRecovery(txn, applyArgs(pv.token))).toEqual({ ok: false, reason: 'value-invalid' })
      expect(await liveRow(R)).toEqual(before)
      expect(await burnCount()).toBe(0)
    } finally {
      await q('DELETE FROM meta_fields WHERE id = $1', [F_REQ]).catch(() => {})
    }
  })

  test('VALUE-INVALID maxLength: historical value exceeds CURRENT property.validation maxLength ⇒ value-invalid', async () => {
    const F_MAX = `fld_eaa_max_${TS}`
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (id) DO NOTHING',
      [F_MAX, SHEET, 'Short', 'string', JSON.stringify({ validation: [{ type: 'maxLength', params: { value: 3 } }] }), 13],
    )
    try {
      const R = `rec_max_${TS}`
      const [sCreate, sUpdate] = await seqBand(2)
      const op = await sealAnchorOp(R, [
        { seq: sCreate, version: 1, action: 'create', snap: { [F_STR]: 'x', [F_MAX]: 'toolong' } },
      ])
      await revSeq(R, 2, 'update', { [F_STR]: 'x', [F_MAX]: 'ok' }, sUpdate)
      await live(R, { [F_STR]: 'x', [F_MAX]: 'ok' }, 2)
      const before = await liveRow(R)
      const pv = await preview(op, 'revert')
      expect(await applyExactAnchorRecovery(txn, applyArgs(pv.token))).toEqual({ ok: false, reason: 'value-invalid' })
      expect(await liveRow(R)).toEqual(before)
      expect(await burnCount()).toBe(0)
    } finally {
      await q('DELETE FROM meta_fields WHERE id = $1', [F_MAX]).catch(() => {})
    }
  })

  test('VALUE-INVALID pattern: historical value fails CURRENT property.validation pattern ⇒ value-invalid', async () => {
    const F_PAT = `fld_eaa_pat_${TS}`
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (id) DO NOTHING',
      [
        F_PAT,
        SHEET,
        'Code',
        'string',
        JSON.stringify({ validation: [{ type: 'pattern', params: { regex: '^[A-Z]+$' } }] }),
        14,
      ],
    )
    try {
      const R = `rec_pat_${TS}`
      const [sCreate, sUpdate] = await seqBand(2)
      const op = await sealAnchorOp(R, [
        { seq: sCreate, version: 1, action: 'create', snap: { [F_STR]: 'x', [F_PAT]: 'not-upper' } },
      ])
      await revSeq(R, 2, 'update', { [F_STR]: 'x', [F_PAT]: 'ABC' }, sUpdate)
      await live(R, { [F_STR]: 'x', [F_PAT]: 'ABC' }, 2)
      const before = await liveRow(R)
      const pv = await preview(op, 'revert')
      expect(await applyExactAnchorRecovery(txn, applyArgs(pv.token))).toEqual({ ok: false, reason: 'value-invalid' })
      expect(await liveRow(R)).toEqual(before)
      expect(await burnCount()).toBe(0)
    } finally {
      await q('DELETE FROM meta_fields WHERE id = $1', [F_PAT]).catch(() => {})
    }
  })

  test('VALUE-INVALID select: historical option removed from CURRENT property/options ⇒ value-invalid', async () => {
    const F_SEL = `fld_eaa_sel_${TS}`
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (id) DO NOTHING',
      [F_SEL, SHEET, 'Choice', 'select', JSON.stringify({ options: [{ value: 'a' }, { value: 'b' }] }), 10],
    )
    try {
      const R = `rec_sel_${TS}`
      const [sCreate, sUpdate] = await seqBand(2)
      const op = await sealAnchorOp(R, [
        { seq: sCreate, version: 1, action: 'create', snap: { [F_STR]: 'x', [F_SEL]: 'legacy' } },
      ])
      await revSeq(R, 2, 'update', { [F_STR]: 'y', [F_SEL]: 'a' }, sUpdate)
      await live(R, { [F_STR]: 'y', [F_SEL]: 'a' }, 2)
      // Current schema only allows a|b — historical 'legacy' fails exact validation.
      const pv = await preview(op, 'revert')
      expect(await applyExactAnchorRecovery(txn, applyArgs(pv.token))).toEqual({ ok: false, reason: 'value-invalid' })
      expect(await burnCount()).toBe(0)
    } finally {
      await q('DELETE FROM meta_fields WHERE id = $1', [F_SEL]).catch(() => {})
    }
  })

  // ── LINK alias ambiguity + same-op delete target ──────────────────────────────────────────────────────
  test('LINK-INTEGRITY alias conflict: foreignSheetId ≠ foreignDatasheetId ⇒ link-integrity', async () => {
    const F_AMB = `fld_eaa_amb_${TS}`
    const OTHER = `${SHEET}_amb`
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING', [OTHER, BASE, 'amb'])
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (id) DO NOTHING',
      [F_AMB, SHEET, 'Amb', 'link', JSON.stringify({ foreignSheetId: SHEET, foreignDatasheetId: OTHER }), 11],
    )
    try {
      const R_T = `rec_amb_t_${TS}`
      const R = `rec_amb_${TS}`
      const [sT, sCreate, sUpdate] = await seqBand(3)
      await revSeq(R_T, 1, 'create', { [F_STR]: 't' }, sT)
      await live(R_T, { [F_STR]: 't' }, 1)
      const op = await sealAnchorOp(R, [
        { seq: sCreate, version: 1, action: 'create', snap: { [F_STR]: 'x', [F_AMB]: [R_T] } },
      ])
      await revSeq(R, 2, 'update', { [F_STR]: 'x', [F_AMB]: [] }, sUpdate)
      await live(R, { [F_STR]: 'x', [F_AMB]: [] }, 2)
      const pv = await preview(op, 'revert')
      expect(await applyExactAnchorRecovery(txn, applyArgs(pv.token))).toEqual({ ok: false, reason: 'link-integrity' })
      expect(await burnCount()).toBe(0)
    } finally {
      await q('DELETE FROM meta_fields WHERE id = $1', [F_AMB]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = $1', [OTHER]).catch(() => {})
    }
  })

  test('LINK-INTEGRITY hierarchy cycle: restoring old parent link would cycle against live graph ⇒ whole refuse, zero burn/revision/data/link; acyclic sibling world applies', async () => {
    // Live tree is valid (A ← B ← C). At-anchor A pointed at C. Restoring A→C while live B→A, C→B cycles A→C→B→A.
    // Hierarchy view marks F_LINK as the parent field so RecordWriteService's cycle primitives engage.
    const VIEW = `view_hier_${TS}`
    await q(
      `INSERT INTO meta_views (id, sheet_id, name, type, config) VALUES ($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [VIEW, SHEET, 'Tree', 'hierarchy', JSON.stringify({ parentFieldId: F_LINK })],
    )
    try {
      const R_A = `rec_hier_a_${TS}`
      const R_B = `rec_hier_b_${TS}`
      const R_C = `rec_hier_c_${TS}`
      // Order: B,C exist before A's at-anchor parent=[C] event; post-anchor clears A.parent so only A reverts.
      const [sB, sC, sA1, sA2, sPost] = await seqBand(5)
      await revSeq(R_B, 1, 'create', { [F_STR]: 'B', [F_LINK]: [R_A] }, sB)
      await revSeq(R_C, 1, 'create', { [F_STR]: 'C', [F_LINK]: [R_B] }, sC)
      const op = await sealAnchorOp(R_A, [
        { seq: sA1, version: 1, action: 'create', snap: { [F_STR]: 'A', [F_LINK]: [] } },
        { seq: sA2, version: 2, action: 'update', snap: { [F_STR]: 'A', [F_LINK]: [R_C] } },
      ])
      await revSeq(R_A, 3, 'update', { [F_STR]: 'A', [F_LINK]: [] }, sPost)
      // Live: valid tree A ← B ← C (A has no parent).
      await live(R_A, { [F_STR]: 'A', [F_LINK]: [] }, 3)
      await live(R_B, { [F_STR]: 'B', [F_LINK]: [R_A] }, 1)
      await live(R_C, { [F_STR]: 'C', [F_LINK]: [R_B] }, 1)
      await insertLink(F_LINK, R_B, R_A)
      await insertLink(F_LINK, R_C, R_B)

      const beforeA = await liveRow(R_A)
      const beforeB = await liveRow(R_B)
      const beforeC = await liveRow(R_C)
      const linkCountBefore = Number(((await q(
        `SELECT count(*)::int c FROM meta_links
         WHERE record_id IN (SELECT id FROM meta_records WHERE sheet_id = $1)`,
        [SHEET],
      )).rows[0] as { c: number }).c)
      const revsBefore = Number(((await q(
        `SELECT count(*)::int c FROM meta_record_revisions WHERE sheet_id = $1`,
        [SHEET],
      )).rows[0] as { c: number }).c)

      const pv = await preview(op, 'revert')
      expect(pv.ok).toBe(true)
      const refused = await applyExactAnchorRecovery(txn, applyArgs(pv.token))
      expect(refused).toEqual({ ok: false, reason: 'link-integrity' })
      expect(await liveRow(R_A)).toEqual(beforeA)
      expect(await liveRow(R_B)).toEqual(beforeB)
      expect(await liveRow(R_C)).toEqual(beforeC)
      expect(Number(((await q(
        `SELECT count(*)::int c FROM meta_links
         WHERE record_id IN (SELECT id FROM meta_records WHERE sheet_id = $1)`,
        [SHEET],
      )).rows[0] as { c: number }).c)).toBe(linkCountBefore)
      expect(Number(((await q(
        `SELECT count(*)::int c FROM meta_record_revisions WHERE sheet_id = $1`,
        [SHEET],
      )).rows[0] as { c: number }).c)).toBe(revsBefore)
      expect(await burnCount()).toBe(0)

      // POSITIVE control (acyclic sibling world): restore parent to a leaf that has no path back.
      // Hierarchy view still armed — proves the guard does not over-refuse legitimate parent restores.
      await wipe()
      const R_ROOT = `rec_hier_root_${TS}`
      const R_LEAF = `rec_hier_leaf_${TS}`
      const [sLeaf, sRoot1, sRoot2, sRootPost] = await seqBand(4)
      await revSeq(R_LEAF, 1, 'create', { [F_STR]: 'leaf', [F_LINK]: [] }, sLeaf)
      const opOk = await sealAnchorOp(R_ROOT, [
        { seq: sRoot1, version: 1, action: 'create', snap: { [F_STR]: 'root', [F_LINK]: [] } },
        { seq: sRoot2, version: 2, action: 'update', snap: { [F_STR]: 'root', [F_LINK]: [R_LEAF] } },
      ])
      await revSeq(R_ROOT, 3, 'update', { [F_STR]: 'root', [F_LINK]: [] }, sRootPost)
      await live(R_ROOT, { [F_STR]: 'root', [F_LINK]: [] }, 3)
      await live(R_LEAF, { [F_STR]: 'leaf', [F_LINK]: [] }, 1)
      // re-create hierarchy view (wipe removes views)
      await q(
        `INSERT INTO meta_views (id, sheet_id, name, type, config) VALUES ($1,$2,$3,$4,$5::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [VIEW, SHEET, 'Tree', 'hierarchy', JSON.stringify({ parentFieldId: F_LINK })],
      )
      const pvOk = await preview(opOk, 'revert')
      const applied = await applyExactAnchorRecovery(txn, applyArgs(pvOk.token))
      expect(applied.ok).toBe(true)
      if (!applied.ok) return
      expect(applied.applied.reverts).toBe(1)
      expect((await liveRow(R_ROOT))?.data[F_LINK]).toEqual([R_LEAF])
      expect(await linkTargets(F_LINK, R_ROOT)).toEqual([R_LEAF])
      expect(await burnCount()).toBe(1)
    } finally {
      await q('DELETE FROM meta_views WHERE id = $1', [VIEW]).catch(() => {})
    }
  })

  test('LINK-INTEGRITY same-op delete: projected link target is itself a RESET delete candidate ⇒ refuse', async () => {
    const R_KEEP = `rec_sod_keep_${TS}`
    const R_NEW = `rec_sod_new_${TS}`
    const R_REV = `rec_sod_rev_${TS}`
    const [sKeep, sCreate, sUpdate, sNew] = await seqBand(4)
    await revSeq(R_KEEP, 1, 'create', { [F_STR]: 'keep' }, sKeep)
    const op = await sealAnchorOp(R_REV, [
      { seq: sCreate, version: 1, action: 'create', snap: { [F_STR]: 'x', [F_LINK]: [R_NEW] } },
    ])
    // At-anchor R_REV points at R_NEW, but R_NEW is only created AFTER the anchor ⇒ reset deletes R_NEW,
    // while revert would re-link R_REV→R_NEW — same-op dangling target.
    await revSeq(R_REV, 2, 'update', { [F_STR]: 'x', [F_LINK]: [R_KEEP] }, sUpdate)
    await revSeq(R_NEW, 1, 'create', { [F_STR]: 'newbie' }, sNew)
    await live(R_KEEP, { [F_STR]: 'keep' }, 1)
    await live(R_REV, { [F_STR]: 'x', [F_LINK]: [R_KEEP] }, 2)
    await live(R_NEW, { [F_STR]: 'newbie' }, 1)
    await insertLink(F_LINK, R_REV, R_KEEP)
    const pv = await preview(op, 'reset')
    expect(await applyExactAnchorRecovery(txn, applyArgs(pv.token))).toEqual({ ok: false, reason: 'link-integrity' })
    expect(await liveRow(R_NEW)).toBeDefined()
    expect(await burnCount()).toBe(0)
  })

  test('RESET two-phase cross-link: two delete candidates linked both ways both get inbound tombstones', async () => {
    process.env.MULTITABLE_TOMBSTONE_CAPTURE_ENABLED = 'true'
    const R_A = `rec_xdel_a_${TS}`
    const R_B = `rec_xdel_b_${TS}`
    const R_REV = `rec_xdel_rev_${TS}`
    const [sCreate, sUpdate, sA, sB] = await seqBand(4)
    const op = await sealAnchorOp(R_REV, [
      { seq: sCreate, version: 1, action: 'create', snap: { [F_STR]: 'anchor' } },
    ])
    await revSeq(R_REV, 2, 'update', { [F_STR]: 'now' }, sUpdate)
    await revSeq(R_A, 1, 'create', { [F_STR]: 'A', [F_LINK]: [R_B] }, sA)
    await revSeq(R_B, 1, 'create', { [F_STR]: 'B', [F_LINK]: [R_A] }, sB)
    await live(R_REV, { [F_STR]: 'now' }, 2)
    await live(R_A, { [F_STR]: 'A', [F_LINK]: [R_B] }, 1)
    await live(R_B, { [F_STR]: 'B', [F_LINK]: [R_A] }, 1)
    await insertLink(F_LINK, R_A, R_B)
    await insertLink(F_LINK, R_B, R_A)
    expect(await countInboundLinkCaptureRows(q as unknown as QueryFn, R_A)).toBe(1)
    expect(await countInboundLinkCaptureRows(q as unknown as QueryFn, R_B)).toBe(1)
    const pv = await preview(op, 'reset')
    const out = await applyExactAnchorRecovery(txn, applyArgs(pv.token))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.applied.deletes).toBeGreaterThanOrEqual(2)
    const trashA = (await q(
      `SELECT delete_revision_id FROM meta_records_trash WHERE record_id = $1 AND sheet_id = $2`,
      [R_A, SHEET],
    )).rows[0] as { delete_revision_id: string }
    const trashB = (await q(
      `SELECT delete_revision_id FROM meta_records_trash WHERE record_id = $1 AND sheet_id = $2`,
      [R_B, SHEET],
    )).rows[0] as { delete_revision_id: string }
    expect(trashA?.delete_revision_id).toBeTruthy()
    expect(trashB?.delete_revision_id).toBeTruthy()
    expect(trashA.delete_revision_id).not.toBe(trashB.delete_revision_id)
    const tombsA = (await q(
      `SELECT record_id, foreign_record_id FROM meta_link_tombstones
       WHERE foreign_record_id = $1 AND source_revision_id = $2::uuid AND reason = 'record_delete'`,
      [R_A, trashA.delete_revision_id],
    )).rows as Array<{ record_id: string; foreign_record_id: string }>
    const tombsB = (await q(
      `SELECT record_id, foreign_record_id FROM meta_link_tombstones
       WHERE foreign_record_id = $1 AND source_revision_id = $2::uuid AND reason = 'record_delete'`,
      [R_B, trashB.delete_revision_id],
    )).rows as Array<{ record_id: string; foreign_record_id: string }>
    expect(tombsA).toEqual([{ record_id: R_B, foreign_record_id: R_A }])
    expect(tombsB).toEqual([{ record_id: R_A, foreign_record_id: R_B }])
  })

  // ── W1-C hardening: txn proof, malformed live truth fail-closed, full-set lock races, write-time CAS ───
  test('TXN-PROOF: a fake `transaction` wrapper running autocommit statements ⇒ recovery-trust-required, zero burn/writes; the SAME token over a real txn applies', async () => {
    const { R_REV, anchorOp } = await seedWorld()
    const pv = await preview(anchorOp)
    const before = await liveRow(R_REV)
    // Forged wrapper: no BEGIN — every statement autocommits on the pool. The pg_current_xact_id probe
    // must refuse BEFORE the fence/burn: an autocommitted burn row would survive its own "rollback".
    const fakeTxn = <T>(fn: (query: QueryFn) => Promise<T>): Promise<T> => fn(q as unknown as QueryFn)
    expect(await applyExactAnchorRecovery(fakeTxn, applyArgs(pv.token)))
      .toEqual({ ok: false, reason: 'recovery-trust-required' })
    expect(await liveRow(R_REV)).toEqual(before)
    expect(await burnCount()).toBe(0) // nothing ran before the probe — no autocommitted burn
    expect(Number(((await q(`SELECT count(*)::int c FROM meta_record_revisions WHERE sheet_id = $1 AND source = 'restore'`, [SHEET])).rows[0] as { c: number }).c)).toBe(0)
    // POSITIVE control (anti-vacuous): the same unburned token over a REAL transaction applies.
    expect((await applyExactAnchorRecovery(txn, applyArgs(pv.token))).ok).toBe(true)
  })

  test('MALFORMED-LIVE data: a scalar-data live row the strict precheck cannot see (all user fields absent from the latest snapshot) ⇒ recovery-trust-required — the old asRec coercion would have destructively applied over it', async () => {
    // World: at-anchor {F_STR:'at'}; the LATEST snapshot is {} (user field removed), so the precheck's
    // content layer compares undefined===undefined and PASSES even over a corrupt scalar-data row. Only
    // the apply's fail-closed shape validation stands between this row and a destructive revert.
    const R = `rec_maldata_${TS}`
    const [sCreate, sUpdate] = await seqBand(2)
    const anchorOp = await sealAnchorOp(R, [
      { seq: sCreate, version: 1, action: 'create', snap: { [F_STR]: 'at' } },
    ])
    await revSeq(R, 2, 'update', {}, sUpdate)
    await live(R, {}, 2)
    const pv = await preview(anchorOp)
    // Corrupt AFTER preview: the id/version fingerprint is unchanged, so no hash can refuse this.
    await q(`UPDATE meta_records SET data = '"corrupt"'::jsonb WHERE id = $1 AND sheet_id = $2`, [R, SHEET])
    expect(await applyExactAnchorRecovery(txn, applyArgs(pv.token)))
      .toEqual({ ok: false, reason: 'recovery-trust-required' })
    expect(await burnCount()).toBe(0)
    // Repair ⇒ the same unburned token applies and the revert lands.
    await q(`UPDATE meta_records SET data = '{}'::jsonb WHERE id = $1 AND sheet_id = $2`, [R, SHEET])
    expect((await applyExactAnchorRecovery(txn, applyArgs(pv.token))).ok).toBe(true)
    expect((await liveRow(R))?.data).toEqual({ [F_STR]: 'at' })
  })

  test('MALFORMED-LIVE version (injected past the precheck): version corrupted to -1 AFTER the strict precheck ⇒ recovery-trust-required — the old Number()||0 path would have misclassified it as preview-drift', async () => {
    const { R_REV, anchorOp } = await seedWorld()
    const pv = await preview(anchorOp)
    // The burn INSERT runs after the strict precheck and before the live-set lock: an AFTER INSERT trigger
    // there corrupts the version in the SAME txn, past every upstream integrity layer.
    const fn = `eaa_neg_ver_${TS}`
    const trg = `trg_eaa_neg_ver_${TS}`
    await q(`CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger AS $$ BEGIN
      UPDATE meta_records SET version = -1 WHERE id = '${R_REV}' AND sheet_id = NEW.sheet_id;
      RETURN NEW; END $$ LANGUAGE plpgsql`)
    await q(`CREATE TRIGGER ${trg} AFTER INSERT ON meta_recovery_token_burns FOR EACH ROW
      WHEN (NEW.sheet_id = '${SHEET}') EXECUTE FUNCTION ${fn}()`)
    try {
      // Fail-closed SHAPE classification, not drift: a negative version is corrupt substrate.
      expect(await applyExactAnchorRecovery(txn, applyArgs(pv.token)))
        .toEqual({ ok: false, reason: 'recovery-trust-required' })
      expect((await liveRow(R_REV))?.version).toBe(2) // the injected corruption rolled back too
      expect(await burnCount()).toBe(0)
    } finally {
      await q(`DROP TRIGGER IF EXISTS ${trg} ON meta_recovery_token_burns`).catch(() => {})
      await q(`DROP FUNCTION IF EXISTS ${fn}()`).catch(() => {})
    }
    // POSITIVE control: trigger removed ⇒ the same unburned token applies.
    expect((await applyExactAnchorRecovery(txn, applyArgs(pv.token))).ok).toBe(true)
  })

  test('MALFORMED-ANCHOR snapshot: an at-anchor snapshot that is a jsonb array ⇒ ExactAnchorPlanDataError maps to recovery-trust-required, zero burn/writes', async () => {
    const R = `rec_mal_${TS}`
    const [sCreate] = await seqBand(1)
    const anchorOp = await sealAnchorOp(R, [
      { seq: sCreate, version: 1, action: 'create', snap: ['not-an-object'] as unknown as Record<string, unknown> },
    ])
    // Live data {} content-matches the precheck's coerced view of the array snapshot (no user field on
    // either side), so the strict precheck PASSES — only the plan classifier sees the malformed target.
    await live(R, {}, 1)
    const pv = await preview(anchorOp)
    expect(await applyExactAnchorRecovery(txn, applyArgs(pv.token)))
      .toEqual({ ok: false, reason: 'recovery-trust-required' })
    expect((await liveRow(R))?.data).toEqual({})
    expect(await burnCount()).toBe(0)
  })

  test('PARKED-CREATE (constructed race): an unfenced INSERT committed while the apply is PARKED on the full live-set lock ⇒ preview-drift, zero burn/writes — a stale RESET delete set never commits around a new record', async () => {
    const { R_REV, R_NEW, anchorOp } = await seedWorld()
    const pv = await preview(anchorOp, 'reset')
    expect(pool).toBeTruthy()
    const R_X = `rec_parked_new_${TS}`
    const holder = await pool!.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE', [R_REV, SHEET])
      let applySettled = false
      const applying = applyExactAnchorRecovery(txn, applyArgs(pv.token)).finally(() => { applySettled = true })
      await new Promise((r) => setTimeout(r, 2500))
      expect(applySettled).toBe(false) // parked on the full-set lock behind our row hold
      // Unfenced CREATE commits while the lock statement is parked. FOR UPDATE cannot lock a phantom and
      // the lock statement's snapshot predates this commit — ONLY the fresh post-lock re-hash can see it.
      const sX = String((await holder.query(`SELECT nextval('meta_record_chain_seq')::text AS s`)).rows[0].s)
      await holder.query(
        `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, seq)
         VALUES (gen_random_uuid(), $1, $2, 1, 'create', 'rest', ARRAY[]::text[], '{}'::jsonb, $3::jsonb, $4::bigint)`,
        [SHEET, R_X, JSON.stringify({ [F_STR]: 'parked-newbie' }), sX],
      )
      await holder.query(
        'INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
        [R_X, SHEET, JSON.stringify({ [F_STR]: 'parked-newbie' })],
      )
      await holder.query('COMMIT')
      const out = await applying
      expect(out).toEqual({ ok: false, reason: 'preview-drift' })
      expect(await liveRow(R_X)).toBeDefined() // the concurrent create SURVIVED untouched
      expect(await liveRow(R_NEW)).toBeDefined() // the reset delete set did NOT partially apply
      expect(await burnCount()).toBe(0)
      expect(Number(((await q(`SELECT count(*)::int c FROM meta_record_revisions WHERE sheet_id = $1 AND source = 'restore'`, [SHEET])).rows[0] as { c: number }).c)).toBe(0)
    } finally {
      try { await holder.query('ROLLBACK') } catch { /* committed above */ }
      holder.release()
    }
    // POSITIVE control: remove the concurrent create ⇒ the same unburned token applies (reset deletes R_NEW).
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2', [SHEET, R_X])
    await q('DELETE FROM meta_records WHERE id = $1 AND sheet_id = $2', [R_X, SHEET])
    expect((await applyExactAnchorRecovery(txn, applyArgs(pv.token))).ok).toBe(true)
    expect(await liveRow(R_NEW)).toBeUndefined()
  })

  test('PARKED-BUMP non-affected (constructed race): a version bump on a row OUTSIDE the write delta committed while the apply is PARKED ⇒ preview-drift, zero burn/writes — a delta-only lock would sail past it', async () => {
    const { R_REV, R_NEW, anchorOp, seqs } = await seedWorld()
    const pv = await preview(anchorOp, 'revert') // R_NEW is created-after: revert KEEPS it — no write intent
    expect(pool).toBeTruthy()
    const holder = await pool!.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE', [R_NEW, SHEET])
      let applySettled = false
      const applying = applyExactAnchorRecovery(txn, applyArgs(pv.token)).finally(() => { applySettled = true })
      await new Promise((r) => setTimeout(r, 2500))
      // A write-delta-only lock never waits on R_NEW (it is not written), and the old plain-read hash ran
      // before this bump committed — only the FULL live-set lock parks here and re-reads the bumped truth.
      expect(applySettled).toBe(false)
      const sBump = String(BigInt(seqs.sNew) + 3000n)
      await holder.query(
        `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, seq)
         VALUES (gen_random_uuid(), $1, $2, 2, 'update', 'rest', ARRAY[]::text[], '{}'::jsonb, $3::jsonb, $4::bigint)`,
        [SHEET, R_NEW, JSON.stringify({ [F_STR]: 'newbie-bumped' }), sBump],
      )
      await holder.query('UPDATE meta_records SET version = 2 WHERE id = $1 AND sheet_id = $2', [R_NEW, SHEET])
      await holder.query('COMMIT')
      const out = await applying
      expect(out).toEqual({ ok: false, reason: 'preview-drift' })
      expect((await liveRow(R_REV))?.data).toEqual({ [F_STR]: 'rev-now' }) // the revert did NOT land
      expect(await burnCount()).toBe(0)
    } finally {
      try { await holder.query('ROLLBACK') } catch { /* committed above */ }
      holder.release()
    }
    // POSITIVE control: rewind the bump ⇒ the same unburned token applies.
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2 AND version = 2', [SHEET, R_NEW])
    await q('UPDATE meta_records SET version = 1 WHERE id = $1 AND sheet_id = $2', [R_NEW, SHEET])
    expect((await applyExactAnchorRecovery(txn, applyArgs(pv.token))).ok).toBe(true)
    expect((await liveRow(R_REV))?.data).toEqual({ [F_STR]: 'rev-at-anchor' })
  })

  test('RESET-DELETE-CAS (injected same-txn drift): version bumped after the delete revision but before the CAS delete ⇒ preview-drift (never a bare Error), full rollback incl. the injected bump', async () => {
    const { R_REV, R_NEW, anchorOp } = await seedWorld()
    const pv = await preview(anchorOp, 'reset')
    const fn = `eaa_del_cas_bump_${TS}`
    const trg = `trg_eaa_del_cas_bump_${TS}`
    await q(`CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger AS $$ BEGIN
      UPDATE meta_records SET version = version + 1 WHERE id = NEW.record_id AND sheet_id = NEW.sheet_id;
      RETURN NEW; END $$ LANGUAGE plpgsql`)
    await q(`CREATE TRIGGER ${trg} AFTER INSERT ON meta_record_revisions FOR EACH ROW
      WHEN (NEW.sheet_id = '${SHEET}' AND NEW.action = 'delete' AND NEW.source = 'restore') EXECUTE FUNCTION ${fn}()`)
    try {
      expect(await applyExactAnchorRecovery(txn, applyArgs(pv.token))).toEqual({ ok: false, reason: 'preview-drift' })
      expect(await liveRow(R_NEW)).toBeDefined()
      expect((await liveRow(R_NEW))?.version).toBe(1) // the injected bump rolled back with the refusal
      expect((await liveRow(R_REV))?.data).toEqual({ [F_STR]: 'rev-now' })
      expect(await trashCount(R_NEW)).toBe(0)
      expect(await burnCount()).toBe(0)
    } finally {
      await q(`DROP TRIGGER IF EXISTS ${trg} ON meta_record_revisions`).catch(() => {})
      await q(`DROP FUNCTION IF EXISTS ${fn}()`).catch(() => {})
    }
    // POSITIVE control: trigger removed ⇒ the same unburned token applies and the reset delete lands.
    expect((await applyExactAnchorRecovery(txn, applyArgs(pv.token))).ok).toBe(true)
    expect(await liveRow(R_NEW)).toBeUndefined()
  })

  test('REVERT-CAS (injected same-txn drift): sibling version bumped between the full-set lock and its CAS UPDATE ⇒ preview-drift (never a bare Error), full rollback', async () => {
    const R1 = `rec_cas_a_${TS}`
    const R2 = `rec_cas_b_${TS}`
    const [s1, s2, s3, s4] = await seqBand(4)
    await revSeq(R2, 1, 'create', { [F_STR]: 'r2-at-anchor' }, s1)
    const anchorOp = await sealAnchorOp(R1, [
      { seq: s2, version: 1, action: 'create', snap: { [F_STR]: 'r1-at-anchor' } },
    ])
    await revSeq(R1, 2, 'update', { [F_STR]: 'r1-now' }, s3)
    await revSeq(R2, 2, 'update', { [F_STR]: 'r2-now' }, s4)
    await live(R1, { [F_STR]: 'r1-now' }, 2)
    await live(R2, { [F_STR]: 'r2-now' }, 2)
    const pv = await preview(anchorOp, 'revert')
    // R1 sorts before R2: R1's restore revision insert bumps R2 inside the SAME txn, so R2's later CAS
    // UPDATE (WHERE version = locked expected) misses — the refusal must be preview-drift, not a throw.
    const fn = `eaa_rev_cas_bump_${TS}`
    const trg = `trg_eaa_rev_cas_bump_${TS}`
    await q(`CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger AS $$ BEGIN
      UPDATE meta_records SET version = version + 1 WHERE id = '${R2}' AND sheet_id = NEW.sheet_id;
      RETURN NEW; END $$ LANGUAGE plpgsql`)
    await q(`CREATE TRIGGER ${trg} AFTER INSERT ON meta_record_revisions FOR EACH ROW
      WHEN (NEW.sheet_id = '${SHEET}' AND NEW.action = 'update' AND NEW.source = 'restore' AND NEW.record_id = '${R1}') EXECUTE FUNCTION ${fn}()`)
    try {
      expect(await applyExactAnchorRecovery(txn, applyArgs(pv.token))).toEqual({ ok: false, reason: 'preview-drift' })
      expect((await liveRow(R1))?.data).toEqual({ [F_STR]: 'r1-now' }) // R1's landed revert rolled back too
      expect((await liveRow(R2))?.data).toEqual({ [F_STR]: 'r2-now' })
      expect((await liveRow(R2))?.version).toBe(2) // the injected bump rolled back
      expect(await burnCount()).toBe(0)
      expect(Number(((await q(`SELECT count(*)::int c FROM meta_record_revisions WHERE sheet_id = $1 AND source = 'restore'`, [SHEET])).rows[0] as { c: number }).c)).toBe(0)
    } finally {
      await q(`DROP TRIGGER IF EXISTS ${trg} ON meta_record_revisions`).catch(() => {})
      await q(`DROP FUNCTION IF EXISTS ${fn}()`).catch(() => {})
    }
    // POSITIVE control: trigger removed ⇒ the same unburned token applies; both reverts land.
    const ok = await applyExactAnchorRecovery(txn, applyArgs(pv.token))
    expect(ok.ok).toBe(true)
    expect((await liveRow(R1))?.data).toEqual({ [F_STR]: 'r1-at-anchor' })
    expect((await liveRow(R2))?.data).toEqual({ [F_STR]: 'r2-at-anchor' })
  })

  // ── G1 (pre-wiring gate list): burn-retention sweep ─────────────────────────────────────────────────────
  test('G1 BURN-RETENTION: the sweep prunes only burns older than the keep window, and the floor clamp protects any possibly-live token', async () => {
    const { anchorOp } = await seedWorld()
    const pv = await preview(anchorOp, 'revert')
    expect((await applyExactAnchorRecovery(txn, applyArgs(pv.token))).ok).toBe(true)
    expect(await burnCount()).toBe(1) // the fresh burn from the successful apply

    // A synthetic OLD burn (2 hours ago) — prunable at the default 60m keep.
    await q(
      `INSERT INTO meta_recovery_token_burns (token_sha256, sheet_id, actor_id, burned_at) VALUES ($1,$2,$3, now() - interval '120 minutes')`,
      [`deadold${TS}`.padEnd(64, '0'), SHEET, ACTOR],
    )
    // A synthetic 20-minute-old burn: older than a live token's 10m TTL but INSIDE an aggressive 1-minute
    // keep request — the 15m FLOOR clamp must protect... no: 20m > 15m floor ⇒ prunable under floor. Use a
    // 12-minute-old burn instead: younger than the 15m floor ⇒ MUST survive even a keepMinutes=1 request
    // (pruning it could resurrect a replayed token whose JWT is still within clock-skew of its exp).
    await q(
      `INSERT INTO meta_recovery_token_burns (token_sha256, sheet_id, actor_id, burned_at) VALUES ($1,$2,$3, now() - interval '12 minutes')`,
      [`deadmid${TS}`.padEnd(64, '1'), SHEET, ACTOR],
    )

    const pruned = await pruneExpiredRecoveryTokenBurns(q as unknown as QueryFn, 1) // aggressive request
    expect(pruned).toBe(1) // ONLY the 2h-old row — the 12m row is inside the 15m floor, the fresh row is new
    const remaining = (await q('SELECT token_sha256 FROM meta_recovery_token_burns WHERE sheet_id = $1', [SHEET])).rows as Array<{ token_sha256: string }>
    const shas = new Set(remaining.map((r) => r.token_sha256))
    expect(shas.has(`deadold${TS}`.padEnd(64, '0'))).toBe(false) // pruned
    expect(shas.has(`deadmid${TS}`.padEnd(64, '1'))).toBe(true) // floor-protected
    expect(remaining.length).toBe(2) // 12m row + the real fresh burn
  })

  test('G1 BURN-INDEX: pg_indexes pins a burned_at-leading index usable by pruneExpiredRecoveryTokenBurns', async () => {
    const idxs = (await q(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE tablename = 'meta_recovery_token_burns' AND schemaname = current_schema()`,
    )).rows as Array<{ indexname: string; indexdef: string }>
    expect(idxs.length).toBeGreaterThan(0)
    // Usable for `WHERE burned_at < …`: leading key of the btree index expression is burned_at
    // (not merely present as a trailing column of (sheet_id, burned_at)).
    const burnedAtLeading = idxs.filter((r) =>
      /\(.*burned_at/i.test(r.indexdef) && !/\([^)]*sheet_id[^)]*burned_at/i.test(r.indexdef),
    )
    expect(
      burnedAtLeading.map((r) => r.indexname),
      `expected a burned_at-leading index on meta_recovery_token_burns; got:\n${idxs.map((r) => `  ${r.indexname}: ${r.indexdef}`).join('\n')}`,
    ).not.toEqual([])
  })
})
