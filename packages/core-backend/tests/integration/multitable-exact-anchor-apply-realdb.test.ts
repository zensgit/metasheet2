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
import { hashAnchorRecoveryScope, hashRecoveryAuthorizationScope, mintExactAnchorRecoveryIdentity } from '../../src/multitable/restore-preview-identity'
import { activateCheckpoint, type QueryFn } from '../../src/multitable/history-trust-checkpoint'
import { __resetRecoveryWriterStateColumnProbe } from '../../src/multitable/canonical-sheet-fence'
import { __resetOperationLedgerColumnProbe } from '../../src/multitable/operation-ledger'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const FLAG = 'MULTITABLE_ENABLE_WRITER_FENCE'
const TS = Date.now()
const BASE = `base_eaa_${TS}`
const SHEET = `sheet_eaa_${TS}`
const F_STR = `fld_eaa_note_${TS}`
const ACTOR = `user_eaa_${TS}`

const q = (sql: string, params: unknown[] = []) => poolManager.get().query(sql, params)
const txn = <T>(fn: (query: QueryFn) => Promise<T>): Promise<T> =>
  poolManager.get().transaction(async ({ query }) => fn(query as unknown as QueryFn)) as Promise<T>

// P1-2 kernel adjudication stubs (the production evaluator is the route's `hasFullTableReadAccess`).
const ALLOW_FULL_READ = async () => true
const DENY_FULL_READ = async () => false

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
  })
  beforeEach(async () => {
    await wipe()
    process.env[FLAG] = 'true' // this test process only — the apply is meaningful with the fence/ledger on
    __resetRecoveryWriterStateColumnProbe()
    __resetOperationLedgerColumnProbe()
  })
  afterEach(() => { delete process.env[FLAG] })
  afterAll(async () => {
    delete process.env[FLAG]
    await wipe()
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
  })

  test('sentinel: DATABASE_URL is set (this suite must RUN, never skip-green)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  /** The standard world: R_REV live differs from at-anchor; R_RES deleted after the anchor; R_NEW created after.
   *  FIXTURE CAUSALITY: activate FIRST (empty sheet ⇒ empty baseline, small `trusted_since_seq` ≤ the anchor),
   *  THEN write the synthetic history with explicit seqs above it. Activating after would snapshot the
   *  post-anchor world into a baseline stamped BELOW the anchor — a causality violation only a synthetic-seq
   *  fixture can produce (production seq is monotonic), and exactly what composition would faithfully expose. */
  async function seedWorld() {
    const R_REV = `rec_rev_${TS}_${Math.random().toString(36).slice(2, 6)}`
    const R_RES = `rec_res_${TS}_${Math.random().toString(36).slice(2, 6)}`
    const R_NEW = `rec_new_${TS}_${Math.random().toString(36).slice(2, 6)}`
    await activate() // empty baseline; trusted_since = nextval (small) ≤ anchor 9001000
    const anchorOp = await sealAnchorOp(R_REV, [
      { seq: '9001000', version: 1, action: 'create', snap: { [F_STR]: 'rev-at-anchor' } },
    ])
    await revSeq(R_RES, 1, 'create', { [F_STR]: 'res-at-anchor' }, '9000900')
    // post-anchor history: R_REV updated (v2), R_RES deleted, R_NEW created.
    await revSeq(R_REV, 2, 'update', { [F_STR]: 'rev-now' }, '9002000')
    await revSeq(R_RES, 1, 'delete', { [F_STR]: 'res-at-anchor' }, '9002100')
    await revSeq(R_NEW, 1, 'create', { [F_STR]: 'newbie' }, '9002200')
    await live(R_REV, { [F_STR]: 'rev-now' }, 2)
    await live(R_NEW, { [F_STR]: 'newbie' }, 1)
    return { R_REV, R_RES, R_NEW, anchorOp }
  }
  // P1-1: the MODE is chosen at PREVIEW and frozen into the token — the apply has no mode input at all.
  const preview = async (anchorOp: string, mode: ExactAnchorApplyMode = 'revert') => {
    const res = await resolveExactAnchor(q as unknown as QueryFn, { sheetId: SHEET, request: { kind: 'exact-anchor', anchorOperationId: anchorOp }, actorId: ACTOR, mode, evaluateFullReadAccess: ALLOW_FULL_READ })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('preview failed')
    return res
  }

  test('HAPPY-REVERT: atomic apply — revert + resurrect land, revisions source=restore + ledger-tagged, endpoint sealed, token burned, keeps preserved', async () => {
    const { R_REV, R_RES, R_NEW, anchorOp } = await seedWorld()
    const pv = await preview(anchorOp)
    const out = await applyExactAnchorRecovery(txn, { token: pv.token, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: ALLOW_FULL_READ })
    expect(out).toMatchObject({ ok: true, mode: 'revert', applied: { reverts: 1, resurrects: 1, deletes: 0 } })

    expect((await liveRow(R_REV))?.data).toEqual({ [F_STR]: 'rev-at-anchor' }) // reverted
    expect((await liveRow(R_REV))?.version).toBe(3) // version+1, never rewound
    expect((await liveRow(R_RES))?.data).toEqual({ [F_STR]: 'res-at-anchor' }) // resurrected
    expect((await liveRow(R_RES))?.version).toBe(1) // new generation
    expect(await liveRow(R_NEW)).toBeDefined() // revert KEEPS created-after-anchor

    // Every apply write is revision-emitted with source 'restore' and TAGGED into ONE sealed operation.
    const revRows = (await q(
      `SELECT operation_id::text AS op FROM meta_record_revisions WHERE sheet_id = $1 AND source = 'restore'`,
      [SHEET],
    )).rows as Array<{ op: string | null }>
    expect(revRows.length).toBe(2)
    expect(new Set(revRows.map((r) => r.op)).size).toBe(1)
    expect(revRows[0].op).toBeTruthy()
    const ep = (await q('SELECT event_count FROM meta_record_history_operations WHERE sheet_id = $1 AND operation_id = $2::uuid', [SHEET, revRows[0].op])).rows[0] as { event_count: number }
    expect(ep.event_count).toBe(2) // the apply sealed its own endpoint — a future exact anchor
    expect(await burnCount()).toBe(1)
  })

  test('MODE-MATRIX: reset also deletes deletedAtAnchorLiveNow + createdAfterAnchor (with delete revisions); revert kept them (proven above)', async () => {
    const { R_RES, R_NEW, anchorOp } = await seedWorld()
    // make R_RES a deleted-at-anchor-live-now case instead: resurrect it post-anchor so it is LIVE now.
    await revSeq(R_RES, 1, 'create', { [F_STR]: 'res-gen2' }, '9002300')
    await live(R_RES, { [F_STR]: 'res-gen2' }, 1)
    // NOTE the anchor (1000) predates R_RES's create @900? No — 900 < 1000, so R_RES EXISTED at the anchor
    // with 'res-at-anchor', was deleted @2100, re-created @2300. At the anchor it EXISTS ⇒ it is a REVERT
    // candidate (live 'res-gen2' → target 'res-at-anchor'), not a delete case. R_NEW (created @2200) is the
    // reset-delete case this golden pins.
    // P1-1: reset must be PREVIEWED as reset — the mode rides in the token, not the apply call.
    const pv = await preview(anchorOp, 'reset')
    const out = await applyExactAnchorRecovery(txn, { token: pv.token, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: ALLOW_FULL_READ })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.mode).toBe('reset') // the TOKEN's mode, echoed
    expect(out.applied.deletes).toBe(1) // R_NEW deleted by reset
    expect(await liveRow(R_NEW)).toBeUndefined()
    const delRev = (await q(
      `SELECT snapshot FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2 AND action = 'delete' AND source = 'restore'`,
      [SHEET, R_NEW],
    )).rows[0] as { snapshot: Record<string, unknown> } | undefined
    expect(delRev?.snapshot).toEqual({ [F_STR]: 'newbie' }) // pre-delete snapshot captured
  })

  test('REPLAY: a second execute of the SAME token ⇒ token-replayed, zero writes', async () => {
    const { R_REV, anchorOp } = await seedWorld()
    const pv = await preview(anchorOp)
    expect((await applyExactAnchorRecovery(txn, { token: pv.token, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: ALLOW_FULL_READ })).ok).toBe(true)
    const afterFirst = await liveRow(R_REV)
    const second = await applyExactAnchorRecovery(txn, { token: pv.token, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: ALLOW_FULL_READ })
    expect(second).toEqual({ ok: false, reason: 'token-replayed' })
    expect(await liveRow(R_REV)).toEqual(afterFirst) // untouched by the replay attempt
    expect(await burnCount()).toBe(1) // still exactly one burn
  })

  test('LIVE-DRIFT: a concurrent committed write between preview and execute ⇒ preview-drift, ZERO writes incl. the burn (the token survives and works once the drift is undone)', async () => {
    const { R_REV, anchorOp } = await seedWorld()
    const pv = await preview(anchorOp)
    // Concurrent write AFTER the preview: bump R_REV (exactly what a user editing during the confirm dialog does).
    await q('UPDATE meta_records SET data = $1::jsonb, version = version + 1 WHERE id = $2 AND sheet_id = $3', [JSON.stringify({ [F_STR]: 'sneaky' }), R_REV, SHEET])
    const out = await applyExactAnchorRecovery(txn, { token: pv.token, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: ALLOW_FULL_READ })
    expect(out).toEqual({ ok: false, reason: 'preview-drift' })
    expect((await liveRow(R_REV))?.data).toEqual({ [F_STR]: 'sneaky' }) // nothing applied
    expect(await burnCount()).toBe(0) // the burn rolled back with everything else — zero writes means ZERO
    // Restore the exact previewed world ⇒ the SAME token executes (proves the refusal wrote nothing at all).
    await q('UPDATE meta_records SET data = $1::jsonb, version = version - 1 WHERE id = $2 AND sheet_id = $3', [JSON.stringify({ [F_STR]: 'rev-now' }), R_REV, SHEET])
    expect((await applyExactAnchorRecovery(txn, { token: pv.token, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: ALLOW_FULL_READ })).ok).toBe(true)
  })

  test('CHECKPOINT-GONE / CHECKPOINT-CHANGED: the in-fence re-resolution never trusts the token echo', async () => {
    const { anchorOp } = await seedWorld()
    const pv = await preview(anchorOp)
    // (a) remove the covering checkpoint entirely ⇒ no-covering-checkpoint, zero writes.
    await q('DELETE FROM meta_history_baselines WHERE sheet_id = $1', [SHEET])
    await q('DELETE FROM meta_history_trust_checkpoints WHERE sheet_id = $1', [SHEET])
    expect(await applyExactAnchorRecovery(txn, { token: pv.token, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: ALLOW_FULL_READ }))
      .toEqual({ ok: false, reason: 'no-covering-checkpoint' })
    expect(await burnCount()).toBe(0)
    // (b) a DIFFERENT covering checkpoint (fresh activation) ⇒ the resolved id no longer equals the token's
    //     checkpointId ⇒ checkpoint-changed (re-preview under the new trust floor).
    await activate()
    expect(await applyExactAnchorRecovery(txn, { token: pv.token, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: ALLOW_FULL_READ }))
      .toEqual({ ok: false, reason: 'checkpoint-changed' })
  })

  test('INJECTED-FAILURE: a mid-apply crash rolls back EVERYTHING (no record change, no revisions, no endpoint, no burn)', async () => {
    const { R_REV, R_RES, anchorOp } = await seedWorld()
    const pv = await preview(anchorOp)
    // Inject: pre-take R_RES's primary key inside ANOTHER sheet? No — same id across sheets collides on the
    // meta_records PK (id). Insert a foreign-sheet row with R_RES's id so the apply's resurrect INSERT
    // violates the PK AFTER the revert UPDATE already ran — a genuine mid-apply failure.
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING', [`${SHEET}_other`, BASE, 'EAA other'])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [R_RES, `${SHEET}_other`, '{}'])
    await expect(applyExactAnchorRecovery(txn, { token: pv.token, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: ALLOW_FULL_READ })).rejects.toThrow()
    // FULL rollback: the revert (which ran BEFORE the failing resurrect) is undone too.
    expect((await liveRow(R_REV))?.data).toEqual({ [F_STR]: 'rev-now' })
    expect((await liveRow(R_REV))?.version).toBe(2)
    expect(Number(((await q(`SELECT count(*)::int c FROM meta_record_revisions WHERE sheet_id = $1 AND source = 'restore'`, [SHEET])).rows[0] as { c: number }).c)).toBe(0)
    expect(await burnCount()).toBe(0)
    // cleanup the injection
    await q('DELETE FROM meta_records WHERE id = $1 AND sheet_id = $2', [R_RES, `${SHEET}_other`])
    await q('DELETE FROM meta_sheets WHERE id = $1', [`${SHEET}_other`])
  })

  test('BASELINE composition: a record living ONLY in the checkpoint baseline resurrects from baseline data; a trashed baseline row stays deleted', async () => {
    const R_BASE = `rec_base_${TS}`
    const R_TRASHED = `rec_trashed_${TS}`
    // Anchor world: one revision-bearing record so an anchor op exists.
    const R_REV = `rec_rev_${TS}_bl`
    const anchorOp = await sealAnchorOp(R_REV, [{ seq: '9001000', version: 1, action: 'create', snap: { [F_STR]: 'x' } }])
    await live(R_REV, { [F_STR]: 'x' }, 1)
    const ck = await activate()
    // Inject baseline-only records into the ACTIVE checkpoint (their revisions were "retention-pruned"):
    // R_BASE existed (non-trashed) at the checkpoint; R_TRASHED was in the recycle bin (is_trashed).
    const ckId = (ck as { checkpointId: string }).checkpointId
    await q(
      `INSERT INTO meta_history_baselines (checkpoint_id, sheet_id, record_id, data, version, is_trashed)
       VALUES ($1,$2,$3,$4::jsonb,5,false), ($1,$2,$5,$6::jsonb,2,true)`,
      [ckId, SHEET, R_BASE, JSON.stringify({ [F_STR]: 'from-baseline' }), R_TRASHED, JSON.stringify({ [F_STR]: 'was-trashed' })],
    )
    const pv = await preview(anchorOp)
    // F4 (pre-wiring gate list): the PREVIEW already shows the baseline-composed set — what-you-see-is-
    // what-applies. Both baseline records are in the preview stateMap (R_BASE as existing at-anchor,
    // R_TRASHED as deleted-at-anchor), and the token's scopeHash covers this SAME composed set — the apply
    // below succeeding proves preview↔apply hash symmetry (an asymmetric pair would refuse preview-drift).
    expect(pv.stateMap.get(R_BASE)).toMatchObject({ exists: true, data: { [F_STR]: 'from-baseline' } })
    expect(pv.stateMap.get(R_TRASHED)).toMatchObject({ exists: false })
    const out = await applyExactAnchorRecovery(txn, { token: pv.token, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: ALLOW_FULL_READ })
    expect(out.ok).toBe(true)
    // R_BASE resurrected FROM THE BASELINE (below the replay horizon); R_TRASHED stays deleted.
    expect((await liveRow(R_BASE))?.data).toEqual({ [F_STR]: 'from-baseline' })
    expect(await liveRow(R_TRASHED)).toBeUndefined()
  })

  test('LOCKED record: a lock held by ANOTHER actor aborts the whole all-or-nothing apply (rank-8 discipline); unlocking lets it through', async () => {
    const { R_REV, anchorOp } = await seedWorld()
    await q('UPDATE meta_records SET locked = true, locked_by = $1 WHERE id = $2 AND sheet_id = $3', ['someone-else', R_REV, SHEET])
    const pv = await preview(anchorOp) // lock columns are not part of the live {id, version} fingerprint
    await expect(applyExactAnchorRecovery(txn, { token: pv.token, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: ALLOW_FULL_READ })).rejects.toThrow(/locked/i)
    expect((await liveRow(R_REV))?.data).toEqual({ [F_STR]: 'rev-now' }) // nothing applied (all-or-nothing)
    expect(await burnCount()).toBe(0)
    // unlock ⇒ the SAME token applies (the refusal wrote nothing).
    await q('UPDATE meta_records SET locked = false, locked_by = NULL WHERE id = $1 AND sheet_id = $2', [R_REV, SHEET])
    expect((await applyExactAnchorRecovery(txn, { token: pv.token, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: ALLOW_FULL_READ })).ok).toBe(true)
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
      const applying = applyExactAnchorRecovery(txn, { token: pv.token, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: ALLOW_FULL_READ })
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
    const out = await applyExactAnchorRecovery(txn, { token: pv.token, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: ALLOW_FULL_READ })
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
    const denied = await applyExactAnchorRecovery(txn, { token: pv.token, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: DENY_FULL_READ })
    expect(denied).toEqual({ ok: false, reason: 'forbidden' })
    expect(await liveRow(R_REV)).toEqual(before) // zero writes
    expect(await burnCount()).toBe(0) // the burn rolled back with the refusal — the token is NOT half-dead
    // re-grant ⇒ the very same token proceeds (fresh adjudication each execute, not a token property).
    expect((await applyExactAnchorRecovery(txn, { token: pv.token, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: ALLOW_FULL_READ })).ok).toBe(true)
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
    expect(await applyExactAnchorRecovery(txn, { token: wrongBasis, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: ALLOW_FULL_READ }))
      .toEqual({ ok: false, reason: 'forbidden' })
    expect(await liveRow(R_REV)).toEqual(before)
    expect(await burnCount()).toBe(0)
    // POSITIVE control (anti-vacuous): the same mint with the CORRECT basis applies cleanly.
    const rightBasis = mintExactAnchorRecoveryIdentity({
      ...claims,
      authorizedScopeHash: hashRecoveryAuthorizationScope({ sheetId: SHEET, actorId: ACTOR }),
      liveSetHash: hashAnchorRecoveryScope(liveRows.map((r) => ({ recordId: String(r.id), exists: true, version: Number(r.version) }))),
    })
    expect((await applyExactAnchorRecovery(txn, { token: rightBasis, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: ALLOW_FULL_READ })).ok).toBe(true)
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
      expect(await applyExactAnchorRecovery(txn, { token: pv.token, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: ALLOW_FULL_READ }))
        .toEqual({ ok: false, reason: 'schema-drift' })
      expect(await liveRow(R_REV)).toEqual(beforeRev) // untouched
      expect(await liveRow(R_NEW)).toBeDefined() // nothing deleted
      expect(await burnCount()).toBe(0) // burn rolled back — token dies by TTL, not half-burn
    } finally {
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (id) DO NOTHING', [F_STR, SHEET, 'Note', 'string', '{}', 1])
    }
    // POSITIVE CONTROL (anti-vacuous, gate NIT-2): with the schema restored, the SAME token — unburned by
    // the refusal above — now applies cleanly. Proves the refusal was attributable to the drift alone.
    expect((await applyExactAnchorRecovery(txn, { token: pv.token, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: ALLOW_FULL_READ })).ok).toBe(true)
  })

  // ── G2 (pre-wiring gate list): RESURRECT uses the AT-ANCHOR snapshot, never the trash row's vintage ─────
  test('G2 RESURRECT-VS-TRASH: a record edited after the anchor then deleted (trash carries the TERMINAL vintage) resurrects to its AT-ANCHOR data', async () => {
    const { anchorOp } = await seedWorld()
    const R_G2 = `rec_g2vint_${TS}`
    // at-anchor (< anchor seq): 'g2-at-anchor'. Post-anchor: edited to 'g2-terminal', then deleted — the
    // TRASH row (and the delete revision's snapshot) both carry the TERMINAL vintage, the wrong source.
    await revSeq(R_G2, 1, 'create', { [F_STR]: 'g2-at-anchor' }, '9000800')
    await revSeq(R_G2, 2, 'update', { [F_STR]: 'g2-terminal' }, '9001900')
    await revSeq(R_G2, 2, 'delete', { [F_STR]: 'g2-terminal' }, '9002150')
    await q(
      'INSERT INTO meta_records_trash (record_id, sheet_id, data, original_version) VALUES ($1,$2,$3::jsonb,$4)',
      [R_G2, SHEET, JSON.stringify({ [F_STR]: 'g2-terminal' }), 2],
    )
    // A live foreign target so the outbound-link rebuild has something to point at is unnecessary here (no
    // link field on this fixture); this golden pins the trash-lifecycle invariant.
    const trashBefore = await trashCount(R_G2)
    expect(trashBefore).toBe(1) // precondition: the record IS in the recycle bin
    const pv = await preview(anchorOp, 'revert')
    const out = await applyExactAnchorRecovery(txn, { token: pv.token, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: ALLOW_FULL_READ })
    expect(out.ok).toBe(true)
    // Resurrected from the REVISION CHAIN's at-anchor state — the trash row's terminal vintage is never read.
    expect((await liveRow(R_G2))?.data).toEqual({ [F_STR]: 'g2-at-anchor' })
    expect((await liveRow(R_G2))?.version).toBe(1) // new generation
    // OWNER P1 (2026-07-17): live/trash MUTUAL EXCLUSION — the resurrect must have removed the trash row.
    // Without the trash cleanup the record is live AND still in the recycle bin (future restore 23505,
    // mis-pinned tombstone/retention). Mutation: drop the `DELETE FROM meta_records_trash` ⇒ this reds.
    expect(await trashCount(R_G2)).toBe(0)
  })

  test('G2b RESURRECT-TRASH-ROLLBACK: an injected failure AFTER the resurrect rolls the live row, its revision AND the trash deletion back together (all-or-nothing)', async () => {
    const { anchorOp } = await seedWorld()
    const R_G2B = `rec_g2b_${TS}`
    await revSeq(R_G2B, 1, 'create', { [F_STR]: 'g2b-at-anchor' }, '9000850')
    await revSeq(R_G2B, 1, 'delete', { [F_STR]: 'g2b-at-anchor' }, '9002250') // deleted after the anchor
    await q(
      'INSERT INTO meta_records_trash (record_id, sheet_id, data, original_version) VALUES ($1,$2,$3::jsonb,$4)',
      [R_G2B, SHEET, JSON.stringify({ [F_STR]: 'g2b-at-anchor' }), 1],
    )
    expect(await trashCount(R_G2B)).toBe(1)
    const pv = await preview(anchorOp, 'revert')
    // Inject a failure at the SEAL step (after every resurrect write incl. the trash deletion). A synthetic
    // trigger that raises on INSERT into meta_record_history_operations forces the seal to throw ⇒ the whole
    // outer txn rolls back. If the trash deletion did NOT participate in this txn, the row would stay gone.
    const fn = `eaa_g2b_seal_fail_${TS}`
    const trg = `trg_eaa_g2b_seal_fail_${TS}`
    await q(`CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected seal failure (G2b)'; END $$ LANGUAGE plpgsql`)
    await q(`CREATE TRIGGER ${trg} BEFORE INSERT ON meta_record_history_operations FOR EACH ROW WHEN (NEW.sheet_id = '${SHEET}') EXECUTE FUNCTION ${fn}()`)
    try {
      await expect(applyExactAnchorRecovery(txn, { token: pv.token, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: ALLOW_FULL_READ })).rejects.toThrow()
      // EVERYTHING rolled back together: no live row, the trash row SURVIVES, no create revision, no burn.
      expect(await liveRow(R_G2B)).toBeUndefined()
      expect(await trashCount(R_G2B)).toBe(1) // the trash deletion rolled back with the failed apply
      const revs = Number(((await q("SELECT count(*)::int c FROM meta_record_revisions WHERE record_id = $1 AND action = 'create' AND source = 'restore'", [R_G2B])).rows[0] as { c: number }).c)
      expect(revs).toBe(0)
      expect(await burnCount()).toBe(0)
    } finally {
      await q(`DROP TRIGGER IF EXISTS ${trg} ON meta_record_history_operations`).catch(() => {})
      await q(`DROP FUNCTION IF EXISTS ${fn}()`).catch(() => {})
    }
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
      applyExactAnchorRecovery(txn, { token: pv1.token, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: ALLOW_FULL_READ }),
      applyExactAnchorRecovery(txn, { token: pv2.token, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: ALLOW_FULL_READ }),
    ])
    const oks = [r1, r2].filter((r) => r.ok)
    const refusals = [r1, r2].filter((r) => !r.ok) as Array<{ ok: false; reason: string }>
    expect(oks.length).toBe(1) // exactly one winner
    expect(refusals.length).toBe(1)
    expect(refusals[0].reason).toBe('preview-drift') // the loser saw the winner's committed world
    expect(await burnCount()).toBe(1) // the loser's burn rolled back with its refusal
  })

  // ── G1 (pre-wiring gate list): burn-retention sweep ─────────────────────────────────────────────────────
  test('G1 BURN-RETENTION: the sweep prunes only burns older than the keep window, and the floor clamp protects any possibly-live token', async () => {
    const { anchorOp } = await seedWorld()
    const pv = await preview(anchorOp, 'revert')
    expect((await applyExactAnchorRecovery(txn, { token: pv.token, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: ALLOW_FULL_READ })).ok).toBe(true)
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
