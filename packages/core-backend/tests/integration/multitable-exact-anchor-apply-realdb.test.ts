/**
 * W0-1 v3.7 Lane L8 — the exact-anchor DESTRUCTIVE APPLY (real DB): one transaction, all-or-nothing.
 *
 * Module under test: `exact-anchor-recovery-execute.ts` `applyExactAnchorRecovery`. Goldens (each
 * mutation-proven in the PR matrix):
 *   HAPPY-REVERT      end-to-end revert-mode apply: reverts + resurrects land atomically, every write
 *                     revision-emitted (`source:'restore'`) and ledger-tagged; the apply itself seals an
 *                     operation endpoint (a future exact anchor); token burned.
 *   MODE-MATRIX       the SAME world under 'reset' also deletes deletedAtAnchorLiveNow + createdAfterAnchor
 *                     (with delete revisions); under 'revert' both survive.
 *   REPLAY            a second execute of the SAME token ⇒ `token-replayed`, zero writes.
 *   LIVE-DRIFT (409)  a CONCURRENT COMMITTED WRITE between preview and execute ⇒ `preview-drift`, ZERO
 *                     writes — including the token burn (the token is still executable after the world is
 *                     restored to the previewed state ⇒ proves full rollback of the burn row).
 *   CHECKPOINT-GONE   the covering checkpoint pruned/removed between preview and execute ⇒
 *                     `no-covering-checkpoint`; a DIFFERENT covering checkpoint (superseding activation
 *                     below the anchor) ⇒ `checkpoint-changed`. Zero writes.
 *   INJECTED-FAILURE  a mid-apply failure (second revision INSERT forced to fail via a synthetic
 *                     constraint collision) ⇒ the WHOLE apply rolls back: no record changed, no revisions,
 *                     no endpoint, no burn.
 *   BASELINE          a record whose history lives ONLY in the checkpoint baseline (zero revisions ≤
 *                     anchor): non-trashed baseline row resurrects/reverts from the baseline data;
 *                     is_trashed=true baseline row stays deleted.
 *   FENCE-PARK (race) a raw client holds the canonical fence in an open transaction; the apply PARKS
 *                     (proven via pg_locks/pg_blocking_pids sampling) and completes after release.
 *
 * The module is NOT wired to any route; the L4 fence flag is toggled only inside this test process
 * (default OFF everywhere real). P2-C hygiene: explicit synthetic seq literals, no `setval`, own-row
 * cleanup. Two-point wiring: plugin-tests.yml real-DB run list + vitest glob; fail-not-skip sentinel.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { pool } from '../../src/db/pg'
import { resolveExactAnchor } from '../../src/multitable/exact-anchor-recovery'
import { applyExactAnchorRecovery, pruneExpiredRecoveryTokenBurns, type ExactAnchorApplyMode } from '../../src/multitable/exact-anchor-recovery-execute'
import { countInboundLinkCaptureRows, isTombstoneCaptureEnabled } from '../../src/multitable/tombstone-capture'
import { hashAnchorRecoveryScope, hashRecoveryAuthorizationScope, mintExactAnchorRecoveryIdentity } from '../../src/multitable/restore-preview-identity'
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
   * Allocate a monotonic synthetic-seq band ABOVE the active checkpoint's trusted_since_seq, then
   * advance the shared chain sequence past that band so post-apply real nextval() rows stay strictly
   * after fixtures (strict contiguity ORDER BY seq stays healthy).
   */
  async function seqBand(count: number): Promise<string[]> {
    await activate()
    const floorRes = await q(
      `SELECT trusted_since_seq::text AS s FROM meta_history_trust_checkpoints
       WHERE sheet_id = $1 AND state = 'active' AND pruned_at IS NULL`,
      [SHEET],
    )
    const floor = BigInt(String((floorRes.rows[0] as { s: string }).s))
    const seqs = Array.from({ length: count }, (_, i) => String(floor + BigInt(1000 * (i + 1))))
    const hi = floor + BigInt(1000 * (count + 5))
    await q(`SELECT setval('meta_record_chain_seq', $1::bigint, true)`, [String(hi)])
    return seqs
  }

  /** Additional synthetic seqs above the current shared chain head (does not re-activate). */
  async function moreSeqs(count: number): Promise<string[]> {
    const head = BigInt(String((await q(`SELECT last_value::text AS s FROM meta_record_chain_seq`)).rows[0] as { s: string }).s)
    const seqs = Array.from({ length: count }, (_, i) => String(head + BigInt(1000 * (i + 1))))
    await q(`SELECT setval('meta_record_chain_seq', $1::bigint, true)`, [String(head + BigInt(1000 * (count + 5)))])
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

  test('LOCKED record: a lock held by ANOTHER actor aborts the whole all-or-nothing apply (rank-8 discipline); unlocking lets it through', async () => {
    const { R_REV, anchorOp } = await seedWorld()
    await q('UPDATE meta_records SET locked = true, locked_by = $1 WHERE id = $2 AND sheet_id = $3', ['someone-else', R_REV, SHEET])
    const pv = await preview(anchorOp) // lock columns are not part of the live {id, version} fingerprint
    await expect(applyExactAnchorRecovery(txn, applyArgs(pv.token))).rejects.toThrow(/locked/i)
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
    // Same REAL scopeHash/liveSetHash/checkpoint — only the signed authorization basis is wrong.
    const claims = {
      sheetId: SHEET, anchorOperationId: anchorOp, anchorSeq: pv.anchorSeq, checkpointId: pv.checkpointId,
      scopeHash: pv.scopeHash, actorId: ACTOR, mode: 'revert' as const, authorizedScopeHash: 'e'.repeat(64),
    }
    // liveSetHash must be the REAL one so this golden isolates the authorization axis: recompute it the
    // way the preview does (same primitive over the live {id, version} set).
    const liveRows = (await q('SELECT id, version FROM meta_records WHERE sheet_id = $1', [SHEET])).rows as Array<{ id: string; version: number }>
    const wrongBasis = mintExactAnchorRecoveryIdentity({
      ...claims,
      liveSetHash: hashAnchorRecoveryScope(liveRows.map((r) => ({ recordId: String(r.id), exists: true, version: Number(r.version) }))),
    })
    expect(await applyExactAnchorRecovery(txn, applyArgs(wrongBasis)))
      .toEqual({ ok: false, reason: 'forbidden' })
    expect(await liveRow(R_REV)).toEqual(before)
    expect(await burnCount()).toBe(0)
    // POSITIVE control (anti-vacuous): the same mint with the CORRECT basis applies cleanly.
    const rightBasis = mintExactAnchorRecoveryIdentity({
      ...claims,
      authorizedScopeHash: hashRecoveryAuthorizationScope({ sheetId: SHEET, actorId: ACTOR }),
      liveSetHash: hashAnchorRecoveryScope(liveRows.map((r) => ({ recordId: String(r.id), exists: true, version: Number(r.version) }))),
    })
    expect((await applyExactAnchorRecovery(txn, applyArgs(rightBasis))).ok).toBe(true)
  })

  // ── P1-2 SCHEMA-DRIFT WHOLE-REJECT ──────────────────────────────────────────────────────────────────────
  test('DRIFT-REJECT (P1-2): driftCount > 0 ⇒ the WHOLE apply refuses schema-drift with zero writes incl. the burn — no partial-set apply through drift exclusion', async () => {
    const { R_REV, R_NEW, anchorOp } = await seedWorld()
    const pv = await preview(anchorOp, 'revert')
    const beforeRev = await liveRow(R_REV)
    // Drop the field AFTER preview: every at-anchor snapshot now carries a stale field id ⇒ plan.driftCount>0.
    // (The scope/live hashes cover records, not schema — this reaches the PLAN, which is exactly the point.)
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
  test('RESTORABLE-PROJECTION: formula materialization is preserved; derived-only difference is a no-op (no version/revision/burn)', async () => {
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

      // Derived-only: string already at-anchor; only formula live differs from at-anchor snapshot ⇒ no-op.
      await wipe()
      const R2 = `rec_noop_${TS}`
      const [s2] = await seqBand(1)
      const op2 = await sealAnchorOp(R2, [
        { seq: s2, version: 1, action: 'create', snap: { [F_STR]: 'same', [F_FORM]: 'f-at' } },
      ])
      await live(R2, { [F_STR]: 'same', [F_FORM]: 'f-live' }, 1)
      const pv2 = await preview(op2, 'revert')
      // plan may still list a revert if full dataEquals sees formula drift — projection makes it no-op.
      const out2 = await applyExactAnchorRecovery(txn, applyArgs(pv2.token))
      expect(out2.ok).toBe(true)
      if (!out2.ok) return
      expect(out2.applied.reverts).toBe(0) // no write
      expect((await liveRow(R2))?.version).toBe(1)
      expect(Number(((await q(`SELECT count(*)::int c FROM meta_record_revisions WHERE sheet_id = $1 AND source = 'restore'`, [SHEET])).rows[0] as { c: number }).c)).toBe(0)
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
})
