/**
 * W0-1 v3.7 Lane L6-b — EXACT-ANCHOR recovery resolution/execute + causal reconstructor (real DB).
 *
 * Design authority: docs/development/multitable-w0-1-v37-exact-anchor-trust-design-lock-20260715.md (#4331)
 * §1.3 (exact recovery-anchor resolution), §0/P2-B (why wall-clock `T` / a mutable `MAX(seq)` is NOT a
 * trustworthy anchor), §9 item 6 (sealed operation ledger). Modules under test:
 *   • `record-reconstructor.ts`  `reconstructRecordsAtSeq` — the CAUSAL (seq-anchored) recovery-authority read.
 *   • `exact-anchor-recovery.ts`  `resolveExactAnchor` / `executeExactAnchorRecovery` — resolve an opaque sealed
 *     operation endpoint to an exact `anchorSeq`, freeze it into a signed identity, and execute against the
 *     TOKEN-BOUND anchor (never a recomputed `MAX(seq)`).
 *
 * Goldens (each is mutation-proven — see the PR's mutation matrix):
 *   C2 COUNTEREXAMPLE          a record whose `created_at` order DISAGREES with its `seq` (commit) order —
 *       the seq path reconstructs the true as-of-anchor (commit-latest) state; a `created_at`-ordered
 *       reconstruction would pick the un-happened write. Mutation: order by created_at ⇒ reds.
 *   DELETE-CHAIN (LOCK-9)      the latest `seq <= anchor` revision is a delete ⇒ record does NOT exist at the
 *       anchor (never resurrected from its pre-delete snapshot).
 *   EXACT BIGINT > 2^53        seq neighbours that Number() collapses are ordered exactly by `<= $::bigint`.
 *   ANCHOR RESOLUTION          a sealed endpoint resolves to its exact `endpoint_seq` under a covering trust
 *       checkpoint; an unknown anchor / a checkpoint-less anchor / a wall-clock request / a non-uuid all refuse.
 *   EXECUTE / NO-MAX-RECOMPUTE a later write advances `MAX(seq)`; execute STILL reconstructs at the TOKEN-BOUND
 *       anchor (the later record stays absent) ⇒ ok. Mutation: recompute anchor as MAX(seq) ⇒ scope-drift reds.
 *   SCOPE-DRIFT positive       a token carrying a deliberately-wrong scopeHash ⇒ execute refuses scope-drift.
 *
 * Two-point wiring: plugin-tests.yml real-DB run list + vitest.integration.config.ts. Runs only with
 * DATABASE_URL (a top-level sentinel FAILS — not skips — in the real-DB allowlist step). Fixture hygiene (P2-C):
 * every seq is an EXPLICIT literal on an isolated fixture row; this file NEVER calls `setval` on the shared
 * `meta_record_chain_seq`, and cleans up only its own sheet/base/user rows.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { reconstructRecordsAtSeq, reconstructRecordsAtT } from '../../src/multitable/record-reconstructor'
import { resolveExactAnchor, executeExactAnchorRecovery } from '../../src/multitable/exact-anchor-recovery'
import { activateCheckpoint, type QueryFn } from '../../src/multitable/history-trust-checkpoint'
import { hashRecoveryAuthorizationScope, mintExactAnchorRecoveryIdentity } from '../../src/multitable/restore-preview-identity'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_ear_${TS}`
const SHEET = `sheet_ear_${TS}`
const F_STR = `fld_ear_note_${TS}`
const ACTOR = `user_ear_${TS}`

const q = (sql: string, params: unknown[] = []) => poolManager.get().query(sql, params)
type Run = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>
const inTxn = <T>(fn: (run: Run) => Promise<T>): Promise<T> =>
  poolManager.get().transaction(async ({ query }) => fn(query as unknown as Run)) as Promise<T>

// P1-2 kernel adjudication: the tests inject the full-read verdict (the production evaluator is the route's
// `hasFullTableReadAccess`, which closes over req/capabilities the kernel can't reach). ALLOW is the default
// harness posture; DENY exercises the kernel's fail-closed `forbidden` branches.
const ALLOW_FULL_READ = async () => true
const DENY_FULL_READ = async () => false

// A revision at an EXPLICIT seq + created_at (never nextval/setval) — the C2 counterexample needs seq order and
// created_at order to disagree, so both are controlled per row.
const revSeq = (
  recordId: string,
  version: number,
  action: 'create' | 'update' | 'delete',
  snap: Record<string, unknown> | null,
  seq: string,
  createdAtIso?: string,
  run: Run = q,
) =>
  run(
    `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, seq, created_at)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,'rest',ARRAY[]::text[],'{}'::jsonb,$5::jsonb,$6::bigint,COALESCE($7::timestamptz, now()))`,
    [SHEET, recordId, version, action, snap === null ? null : JSON.stringify(snap), seq, createdAtIso ?? null],
  )

// A revision tagged with an operation_id, inside a sealing txn (the DEFERRABLE-INITIALLY-DEFERRED FK is checked
// at COMMIT, so the endpoint must land in the SAME txn).
const revSeqOp = (run: Run, recordId: string, version: number, seq: string, opId: string, snap: Record<string, unknown> = { [F_STR]: `v${version}` }, batchId: string | null = null) =>
  run(
    `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, seq, operation_id, batch_id)
     VALUES (gen_random_uuid(),$1,$2,$3,'create','rest',ARRAY[]::text[],'{}'::jsonb,$4::jsonb,$5::bigint,$6::uuid,$7)`,
    [SHEET, recordId, version, JSON.stringify(snap), seq, opId, batchId],
  )
const insertEndpoint = (run: Run, opId: string, endpointSeq: string, eventCount: number) =>
  run(
    `INSERT INTO meta_record_history_operations (sheet_id, operation_id, endpoint_seq, event_count)
     VALUES ($1,$2::uuid,$3::bigint,$4::int)`,
    [SHEET, opId, endpointSeq, eventCount],
  )

/** Seal one operation: `eventSeqs` synthetic revisions for a record, endpoint_seq = exact MAX (validate trigger).
 *  `batchId` (optional) stamps the S1 user-action grouping onto the revisions — the ruling-⑤ resolver's key. */
async function sealOp(recordId: string, eventSeqs: string[], batchId: string | null = null): Promise<string> {
  const opId = randomUUID()
  const maxSeq = eventSeqs.reduce((a, b) => (BigInt(a) >= BigInt(b) ? a : b))
  await inTxn(async (run) => {
    let v = 1
    for (const s of eventSeqs) await revSeqOp(run, recordId, v++, s, opId, undefined, batchId)
    await insertEndpoint(run, opId, maxSeq, eventSeqs.length)
  })
  return opId
}
const activate = () => poolManager.get().transaction(async ({ query }) => activateCheckpoint(query as unknown as QueryFn, { sheetId: SHEET }))

async function wipeSheetHistory(): Promise<void> {
  for (const t of ['meta_history_baselines', 'meta_history_trust_checkpoints', 'meta_record_version_markers', 'meta_records_trash', 'meta_record_revisions', 'meta_records'])
    await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET]).catch(() => {})
  // history-operations has no sheet_id-only cascade concerns; clear tagged endpoints last (revisions gone above).
  await q('DELETE FROM meta_record_history_operations WHERE sheet_id = $1', [SHEET]).catch(() => {})
}

// Top-level (NOT inside describeIfDatabase) so the real-DB allowlist step FAILS — not silently skips — if it runs
// this file without a DB. Scoped to that step via METASHEET_REAL_DB_TEST_STEP so the normal (no-DB) core-backend
// job's collection of this file stays green (the describeIfDatabase goldens skip there).
test('sentinel: the real-DB allowlist step must have DATABASE_URL (fail-not-skip, scoped to that step)', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('real-DB allowlist step is missing DATABASE_URL — the harness is broken, not legitimately skippable')
  }
  expect(true).toBe(true)
})

describeIfDatabase('W0-1 v3.7 L6-b — exact-anchor recovery + causal reconstructor (real DB)', () => {
  beforeAll(async () => {
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'EAR Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'EAR Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_STR, SHEET, 'Note', 'string', '{}', 1])
  })
  beforeEach(wipeSheetHistory)
  afterAll(async () => {
    await wipeSheetHistory()
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
  })

  test('sentinel: DATABASE_URL is set (this suite must RUN, never skip-green)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // ── C2 COUNTEREXAMPLE ────────────────────────────────────────────────────────────────────────────────────
  test('C2: created_at order DISAGREES with seq order — the causal path reconstructs the commit-latest state', async () => {
    const R = `rec_c2_${TS}`
    // X committed FIRST (seq 100) but has the LATER created_at (Jun 10); Y committed SECOND (seq 200) with the
    // EARLIER created_at (Jun 01). A created_at-ordered reconstruction would call X the latest — the un-happened
    // state. The seq (commit) order is the truth.
    await revSeq(R, 1, 'create', { [F_STR]: 'x' }, '100', '2026-06-10T00:00:00.000Z')
    await revSeq(R, 2, 'update', { [F_STR]: 'y' }, '200', '2026-06-01T00:00:00.000Z')

    // anchor 250: both events have happened; the true as-of state is Y (the last commit, seq 200).
    const at250 = await reconstructRecordsAtSeq(q, SHEET, '250')
    expect(at250.get(R)).toMatchObject({ exists: true, data: { [F_STR]: 'y' }, version: 2 })

    // anchor 150: only X (seq 100) has happened — the anchor precisely controls the as-of state.
    const at150 = await reconstructRecordsAtSeq(q, SHEET, '150')
    expect(at150.get(R)).toMatchObject({ exists: true, data: { [F_STR]: 'x' }, version: 1 })

    // Contrast (the C2 bug being fixed): the created_at path over the same two committed events picks X (the
    // LATER-created, seq-EARLIER write) — the un-happened "latest" — where the seq path at anchor 250 picks Y.
    // The two orders genuinely disagree on this fixture, so a mutation swapping the recovery read to created_at
    // ordering is a real defect the seq assertion above catches.
    const tPath = await reconstructRecordsAtT(q, SHEET, '2026-06-15T00:00:00.000Z')
    expect(tPath.get(R)).toMatchObject({ exists: true, data: { [F_STR]: 'x' }, version: 1 })
  })

  // ── DELETE-CHAIN (LOCK-9) ────────────────────────────────────────────────────────────────────────────────
  test('DELETE-CHAIN: the latest seq<=anchor revision is a delete ⇒ record does NOT exist at the anchor', async () => {
    const R = `rec_del_${TS}`
    await revSeq(R, 1, 'create', { [F_STR]: 'a' }, '100')
    await revSeq(R, 1, 'delete', { [F_STR]: 'a' }, '200') // delete stores the PRE-delete snapshot
    expect((await reconstructRecordsAtSeq(q, SHEET, '150')).get(R)).toMatchObject({ exists: true, data: { [F_STR]: 'a' }, version: 1 })
    expect((await reconstructRecordsAtSeq(q, SHEET, '250')).get(R)).toMatchObject({ exists: false, data: null })
  })

  // ── MULTI-GENERATION delete→recreate (version reset) — seq order, NOT version order ──────────────────────
  test('MULTI-GEN: a delete→recreate resets version to 1; the seq path picks the RECREATED generation, never the higher-version deleted one', async () => {
    const R = `rec_gen_${TS}`
    // gen1: create v1 @10, update v2 @20, delete v2 @30 (pre-delete snapshot). gen2: create v1 @40 (version
    // RESET to 1), update v2 @50. The recreated generation's rows have LOWER versions but HIGHER seq — so a
    // version-based tiebreak would wrongly resurrect gen1's v2 (its delete) at an anchor past the recreate.
    await revSeq(R, 1, 'create', { [F_STR]: 'g1v1' }, '10')
    await revSeq(R, 2, 'update', { [F_STR]: 'g1v2' }, '20')
    await revSeq(R, 2, 'delete', { [F_STR]: 'g1v2' }, '30')
    await revSeq(R, 1, 'create', { [F_STR]: 'g2v1' }, '40')
    await revSeq(R, 2, 'update', { [F_STR]: 'g2v2' }, '50')

    // anchor 25 (inside gen1): the mid-generation update.
    expect((await reconstructRecordsAtSeq(q, SHEET, '25')).get(R)).toMatchObject({ exists: true, data: { [F_STR]: 'g1v2' }, version: 2 })
    // anchor 35 (gen1 deleted, before recreate): absent (LOCK-9).
    expect((await reconstructRecordsAtSeq(q, SHEET, '35')).get(R)).toMatchObject({ exists: false, data: null })
    // anchor 45 (just after the recreate): the RECREATED gen2 v1 — NOT gen1's v2 delete. This is the assertion a
    // `version DESC` tiebreak on the seq ORDER BY reds (it would pick the v2 delete row → exists:false).
    expect((await reconstructRecordsAtSeq(q, SHEET, '45')).get(R)).toMatchObject({ exists: true, data: { [F_STR]: 'g2v1' }, version: 1 })
    // anchor 99 (gen2 terminal).
    expect((await reconstructRecordsAtSeq(q, SHEET, '99')).get(R)).toMatchObject({ exists: true, data: { [F_STR]: 'g2v2' }, version: 2 })
  })

  // ── EXACT BIGINT > 2^53 ──────────────────────────────────────────────────────────────────────────────────
  test('EXACT-BIGINT: seq neighbours Number() collapses are ordered exactly by <= $::bigint', async () => {
    const R = `rec_big_${TS}`
    const LO = '9007199254740992' // 2^53
    const HI = '9007199254740993' // 2^53 + 1 — Number() rounds this DOWN to 2^53, colliding with LO
    expect(Number(LO) === Number(HI)).toBe(true) // the float64 trap: the two distinct seqs collapse to one float
    await revSeq(R, 1, 'create', { [F_STR]: 'lo' }, LO)
    await revSeq(R, 2, 'update', { [F_STR]: 'hi' }, HI)
    // anchor = LO exactly: seq<=LO includes LO, EXCLUDES HI (HI > LO as a bigint). A Number()-based comparison
    // would see Number(HI) <= Number(anchor) as true and wrongly include HI (then seq DESC would pick it) — so
    // the exact ::bigint path is what keeps the as-of-anchor state at LO.
    expect((await reconstructRecordsAtSeq(q, SHEET, LO)).get(R)).toMatchObject({ exists: true, data: { [F_STR]: 'lo' }, version: 1 })
  })

  // ── ANCHOR RESOLUTION ────────────────────────────────────────────────────────────────────────────────────
  test('RESOLVE: a sealed endpoint under a covering checkpoint → exact anchorSeq + a verifiable token', async () => {
    const R = `rec_res_${TS}`
    const opId = await sealOp(R, ['7001', '7002', '7003'])
    await activate() // trusted_since = a small nextval ≤ 7003 ⇒ covers the anchor
    const res = await resolveExactAnchor(q, { sheetId: SHEET, request: { kind: 'exact-anchor', anchorOperationId: opId }, actorId: ACTOR, mode: 'revert', evaluateFullReadAccess: ALLOW_FULL_READ })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.anchorSeq).toBe('7003') // the sealed endpoint_seq, exact — NOT a live MAX(seq)
    expect(res.anchorOperationId).toBe(opId)
    expect(res.mode).toBe('revert') // the mode the token authorizes — frozen at preview (P1-1)
    // the minted token executes end-to-end for the same sheet+actor.
    const ex = await executeExactAnchorRecovery(q, { token: res.token, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: ALLOW_FULL_READ })
    expect(ex.ok).toBe(true)
    if (ex.ok) expect(ex.anchorSeq).toBe('7003')
  })

  test('RESOLVE refusals: unknown anchor, checkpoint-less anchor, wall-clock, non-uuid', async () => {
    // wall-clock request → exact-anchor-required, with NO DB access (a throwing query proves it never reads).
    const throwQ = (() => { throw new Error('resolveExactAnchor touched the DB on a wall-clock request') }) as unknown as QueryFn
    expect(await resolveExactAnchor(throwQ, { sheetId: SHEET, request: { kind: 'wall-clock', asOf: '2026-06-01T00:00:00Z' }, actorId: ACTOR, mode: 'revert', evaluateFullReadAccess: ALLOW_FULL_READ }))
      .toEqual({ ok: false, reason: 'exact-anchor-required' })
    // non-uuid anchorOperationId → invalid-anchor. (P1-2 adjudication runs first and MAY read config
    // tables in production; here the ALLOW stub keeps the throwing query untouched, so this still proves
    // the anchor lookup itself never fires for a malformed id.)
    expect(await resolveExactAnchor(throwQ, { sheetId: SHEET, request: { kind: 'exact-anchor', anchorOperationId: 'not-a-uuid' }, actorId: ACTOR, mode: 'revert', evaluateFullReadAccess: ALLOW_FULL_READ }))
      .toEqual({ ok: false, reason: 'invalid-anchor' })
    // a well-formed but UNKNOWN uuid → unknown-anchor (no sealed endpoint).
    expect(await resolveExactAnchor(q, { sheetId: SHEET, request: { kind: 'exact-anchor', anchorOperationId: randomUUID() }, actorId: ACTOR, mode: 'revert', evaluateFullReadAccess: ALLOW_FULL_READ }))
      .toEqual({ ok: false, reason: 'unknown-anchor' })
    // a sealed endpoint but NO active checkpoint covering it → no-covering-checkpoint (fail-closed).
    const opId = await sealOp(`rec_nock_${TS}`, ['8001', '8002'])
    expect(await resolveExactAnchor(q, { sheetId: SHEET, request: { kind: 'exact-anchor', anchorOperationId: opId }, actorId: ACTOR, mode: 'revert', evaluateFullReadAccess: ALLOW_FULL_READ }))
      .toEqual({ ok: false, reason: 'no-covering-checkpoint' })
  })

  // ── EXECUTE — TOKEN-BOUND ANCHOR, NEVER MAX(seq) ─────────────────────────────────────────────────────────
  test('EXECUTE never recomputes MAX(seq): a later write advances MAX yet execute stays on the token-bound anchor', async () => {
    const R = `rec_max_${TS}`
    const opId = await sealOp(R, ['7001', '7002', '7003'])
    await activate()
    const res = await resolveExactAnchor(q, { sheetId: SHEET, request: { kind: 'exact-anchor', anchorOperationId: opId }, actorId: ACTOR, mode: 'revert', evaluateFullReadAccess: ALLOW_FULL_READ })
    expect(res.ok).toBe(true)
    if (!res.ok) return

    // A NEW record is created AFTER the anchor (seq 9000 > 7003, legacy NULL operation_id — no endpoint needed).
    // It is absent from the reconstruction AT the token anchor (7003), so the token's scopeHash still matches and
    // execute succeeds. If execute recomputed the anchor as MAX(seq)=9000, this new record would appear ⇒ the
    // reconstructed set diverges from the frozen scopeHash ⇒ scope-drift. (That is the mutation this golden reds.)
    await revSeq(`rec_late_${TS}`, 1, 'create', { [F_STR]: 'late' }, '9000')
    const ex = await executeExactAnchorRecovery(q, { token: res.token, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: ALLOW_FULL_READ })
    expect(ex.ok).toBe(true)
    if (ex.ok) {
      expect(ex.anchorSeq).toBe('7003')
      expect(ex.stateMap.has(`rec_late_${TS}`)).toBe(false) // the post-anchor record is NOT in the plan
    }
  })

  test('EXECUTE replay/tamper: cross-sheet, cross-actor, and a wrong scopeHash all refuse (identity-invalid / scope-drift)', async () => {
    const R = `rec_tamper_${TS}`
    const opId = await sealOp(R, ['7001', '7002', '7003'])
    await activate()
    const res = await resolveExactAnchor(q, { sheetId: SHEET, request: { kind: 'exact-anchor', anchorOperationId: opId }, actorId: ACTOR, mode: 'revert', evaluateFullReadAccess: ALLOW_FULL_READ })
    expect(res.ok).toBe(true)
    if (!res.ok) return

    // cross-sheet replay: the token is bound to SHEET; another sheet re-binds sheetId fresh ⇒ identity-invalid.
    expect(await executeExactAnchorRecovery(q, {
      token: res.token,
      sheetId: `${SHEET}_other`,
      actorId: ACTOR,
      evaluateFullReadAccess: ALLOW_FULL_READ,
    }))
      .toEqual({ ok: false, reason: 'identity-invalid' })
    // cross-actor replay: a preview minted for ACTOR is unusable by another actor ⇒ identity-invalid.
    expect(await executeExactAnchorRecovery(q, { token: res.token, sheetId: SHEET, actorId: `${ACTOR}_other`, evaluateFullReadAccess: ALLOW_FULL_READ }))
      .toEqual({ ok: false, reason: 'identity-invalid' })
    // a signature-tampered token ⇒ identity-invalid (mutate the last char of the JWT signature segment).
    const bad = res.token.slice(0, -1) + (res.token.slice(-1) === 'A' ? 'B' : 'A')
    expect(await executeExactAnchorRecovery(q, { token: bad, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: ALLOW_FULL_READ }))
      .toEqual({ ok: false, reason: 'identity-invalid' })

    // SCOPE-DRIFT positive control: a VALIDLY-signed token whose scopeHash is deliberately wrong ⇒ the live
    // reconstruction at the (correct) token anchor re-hashes and diverges ⇒ scope-drift (this exercises the
    // drift branch for real, complementing the MAX-recompute mutation which triggers the same branch).
    // authorizedScopeHash is the MATCHING one so this golden isolates the scopeHash axis (P1-2's own axis
    // has its own goldens below).
    const forged = mintExactAnchorRecoveryIdentity({
      sheetId: SHEET, anchorOperationId: opId, anchorSeq: '7003', checkpointId: (res as { checkpointId: string }).checkpointId,
      scopeHash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      liveSetHash: 'c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffee0000', // shape-valid; the read-half checks scopeHash only
      actorId: ACTOR,
      mode: 'revert', authorizedScopeHash: hashRecoveryAuthorizationScope({ sheetId: SHEET, actorId: ACTOR }),
    })
    expect(await executeExactAnchorRecovery(q, { token: forged, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: ALLOW_FULL_READ }))
      .toEqual({ ok: false, reason: 'scope-drift' })
  })

  // ── P1-2 KERNEL ADJUDICATION (full-read gate + signed authorization basis) ───────────────────────────────
  test('AUTH: a non-full-read actor is refused at PREVIEW (forbidden, no token, no stateMap) — before any anchor oracle', async () => {
    const R = `rec_auth_${TS}`
    const opId = await sealOp(R, ['7001', '7002'])
    await activate()
    // DENY ⇒ forbidden. The anchor EXISTS and is covered — the refusal must reveal none of that.
    expect(await resolveExactAnchor(q, { sheetId: SHEET, request: { kind: 'exact-anchor', anchorOperationId: opId }, actorId: ACTOR, mode: 'revert', evaluateFullReadAccess: DENY_FULL_READ }))
      .toEqual({ ok: false, reason: 'forbidden' })
    // an UNKNOWN anchor refuses IDENTICALLY under DENY (no existence oracle for the unauthorized).
    expect(await resolveExactAnchor(q, { sheetId: SHEET, request: { kind: 'exact-anchor', anchorOperationId: randomUUID() }, actorId: ACTOR, mode: 'revert', evaluateFullReadAccess: DENY_FULL_READ }))
      .toEqual({ ok: false, reason: 'forbidden' })
  })

  test('AUTH: permission revoked BETWEEN preview and execute ⇒ forbidden (fresh adjudication, not the token echo)', async () => {
    const R = `rec_authrev_${TS}`
    const opId = await sealOp(R, ['7001', '7002', '7003'])
    await activate()
    const res = await resolveExactAnchor(q, { sheetId: SHEET, request: { kind: 'exact-anchor', anchorOperationId: opId }, actorId: ACTOR, mode: 'revert', evaluateFullReadAccess: ALLOW_FULL_READ })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // the SAME (valid, unexpired) token — only the live adjudication changed ⇒ forbidden.
    expect(await executeExactAnchorRecovery(q, { token: res.token, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: DENY_FULL_READ }))
      .toEqual({ ok: false, reason: 'forbidden' })
    // re-grant ⇒ the same token proceeds (nothing was burned by the read-half refusal).
    const ok = await executeExactAnchorRecovery(q, { token: res.token, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: ALLOW_FULL_READ })
    expect(ok.ok).toBe(true)
  })

  test('AUTH: a validly-signed token whose authorizedScopeHash does not match the recomputed v1 basis ⇒ forbidden', async () => {
    const R = `rec_authhash_${TS}`
    const opId = await sealOp(R, ['7001', '7002', '7003'])
    await activate()
    const res = await resolveExactAnchor(q, { sheetId: SHEET, request: { kind: 'exact-anchor', anchorOperationId: opId }, actorId: ACTOR, mode: 'revert', evaluateFullReadAccess: ALLOW_FULL_READ })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // Mint with the REAL scopeHash but a WRONG authorization basis — signature valid, adjudication live-ALLOW:
    // only the signed authorization contract diverges ⇒ forbidden (the token's echo is never the authority).
    const wrongAuth = mintExactAnchorRecoveryIdentity({
      sheetId: SHEET, anchorOperationId: opId, anchorSeq: res.anchorSeq, checkpointId: res.checkpointId,
      scopeHash: res.scopeHash, liveSetHash: 'f'.repeat(64), // shape-valid; the read-half checks scopeHash only
      actorId: ACTOR, mode: 'revert', authorizedScopeHash: 'e'.repeat(64),
    })
    expect(await executeExactAnchorRecovery(q, { token: wrongAuth, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: ALLOW_FULL_READ }))
      .toEqual({ ok: false, reason: 'forbidden' })
  })

  // ── RULING-⑤ RESOLVER: History-Center batch → sealed terminal operation ─────────────────────────────────
  test('RESOLVER (d): a batch spanning N sealed operations on this sheet anchors on the MAX endpoint_seq terminal op', async () => {
    const R = `rec_batch_${TS}`
    const batchId = `batch_hb_${TS}`
    // TWO sealed operations whose revisions share ONE user-action batch_id (the S1 multi-txn commit shape).
    const op1 = await sealOp(R, ['7001', '7002'], batchId)
    const op2 = await sealOp(`${R}_2`, ['7005', '7006'], batchId)
    await activate()
    const res = await resolveExactAnchor(q, { sheetId: SHEET, request: { kind: 'history-batch', historyBatchId: batchId }, actorId: ACTOR, mode: 'revert', evaluateFullReadAccess: ALLOW_FULL_READ })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.anchorOperationId).toBe(op2) // the TERMINAL sealed op — MAX endpoint_seq (7006 > 7002)
    expect(res.anchorSeq).toBe('7006')
    expect(op1).not.toBe(op2)
    // and the minted token executes end-to-end (same trust chain as a direct exact-anchor).
    const ex = await executeExactAnchorRecovery(q, { token: res.token, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: ALLOW_FULL_READ })
    expect(ex.ok).toBe(true)
    if (ex.ok) expect(ex.anchorSeq).toBe('7006')
  })

  test('RESOLVER (e): a legacy/unsealed batch (no sealed operation) refuses exact-anchor-required — never a wall-clock fallback, no unknown-vs-unsealed oracle', async () => {
    const R = `rec_legacy_${TS}`
    const batchId = `batch_legacy_${TS}`
    // Legacy shape: revisions carry the batch_id but NULL operation_id (pre-ledger writer) — unsealed.
    await revSeq(R, 1, 'create', { [F_STR]: 'l1' }, '7001')
    await q('UPDATE meta_record_revisions SET batch_id = $1 WHERE sheet_id = $2 AND record_id = $3', [batchId, SHEET, R])
    await activate()
    expect(await resolveExactAnchor(q, { sheetId: SHEET, request: { kind: 'history-batch', historyBatchId: batchId }, actorId: ACTOR, mode: 'revert', evaluateFullReadAccess: ALLOW_FULL_READ }))
      .toEqual({ ok: false, reason: 'exact-anchor-required' })
    // an entirely UNKNOWN batch refuses IDENTICALLY (ruling ⑧ uniform refusal).
    expect(await resolveExactAnchor(q, { sheetId: SHEET, request: { kind: 'history-batch', historyBatchId: `batch_unknown_${TS}` }, actorId: ACTOR, mode: 'revert', evaluateFullReadAccess: ALLOW_FULL_READ }))
      .toEqual({ ok: false, reason: 'exact-anchor-required' })
  })
})
