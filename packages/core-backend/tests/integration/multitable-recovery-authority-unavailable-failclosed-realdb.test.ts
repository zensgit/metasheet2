/**
 * P21 slice — the exact-anchor DESTRUCTIVE APPLY's `authorityLease === 'unavailable'` branch
 * (`exact-anchor-recovery-execute.ts` ~L925-928) had ZERO test coverage before this file: deleting the
 * whole guard left the suite 105/105 green, and stubbing `stabilizeAuthorization` to always return
 * `'unavailable'` flipped 41 tests red only once the guard was reinstated — nobody pins the branch itself.
 *
 * This is the LAST execute-layer enforcement point for the owner ruling "authority substrate incomplete
 * (nine recovery-authority writer triggers not all ENABLED with the exact expected function/argument
 * fingerprints) ⇒ recovery is UNAVAILABLE, not degraded-but-allowed." The migration
 * (`zzzz20260721121000_add_recovery_authority_locks`) ships with all nine writer triggers DISABLED —
 * that is the out-of-the-box production posture, not a contrived edge case.
 *
 * Mechanism used to reach `'unavailable'`: the REAL `acquireRecoveryAuthorityLease` (no stub) is wired in
 * as `stabilizeAuthorization`, and the nine triggers are left (or forced back) at the factory-default
 * DISABLED state. `hasCanonicalAuthoritySubstrate` then observes an incomplete trigger posture and
 * `acquireRecoveryAuthorityLease` returns `'unavailable'` through its own production code path — nothing
 * about the authority-lease acquisition itself is mocked.
 *
 * A positive control (triggers genuinely ENABLED, same scenario) proves the scenario is authentically
 * destructive — it is not vacuously refused for some unrelated reason.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { resolveExactAnchor } from '../../src/multitable/exact-anchor-recovery'
import {
  applyExactAnchorRecovery,
  type ExactAnchorApplyMode,
  type ExactAnchorPlanAuthContext,
} from '../../src/multitable/exact-anchor-recovery-execute'
import { activateCheckpoint, type QueryFn } from '../../src/multitable/history-trust-checkpoint'
import { acquireRecoveryAuthorityLease } from '../../src/multitable/recovery-authorization-stability'
import { RECOVERY_AUTHORITY_TRIGGERS } from '../../src/db/migrations/zzzz20260721121000_add_recovery_authority_locks'
import { __resetRecoveryWriterStateColumnProbe } from '../../src/multitable/canonical-sheet-fence'
import { __resetOperationLedgerColumnProbe } from '../../src/multitable/operation-ledger'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const FLAG = 'MULTITABLE_ENABLE_WRITER_FENCE'
const STRICT = 'MULTITABLE_HISTORY_CONTIGUITY_STRICT'
const TS = Date.now()
const BASE = `base_p21_${TS}`
const SHEET = `sheet_p21_${TS}`
const F_STR = `fld_p21_note_${TS}`
const F_LINK = `fld_p21_link_${TS}`
const ACTOR = `user_p21_${TS}`
const rand = () => Math.random().toString(36).slice(2, 8)

const q = (sql: string, params: unknown[] = []) => poolManager.get().query(sql, params)
const txn = <T>(fn: (query: QueryFn) => Promise<T>): Promise<T> =>
  poolManager.get().transaction(async ({ query }) => fn(query as unknown as QueryFn)) as Promise<T>

// Kernel adjudication stubs — this suite is about the authority-lease branch specifically; every other
// gate (full-read, plan-authorization) is left wide open so the ONLY thing that can refuse is the lease.
const ALLOW_FULL_READ = async () => true
const ALLOW_PLAN = async () => true

/** REAL mechanism (no stub): the production authority-lease acquirer, over whatever trigger posture
 * the database currently has. `'unavailable'` here means the runtime genuinely could not verify the
 * canonical trigger/function substrate — never a hardcoded test double. */
const REAL_STABILIZE = async (query: QueryFn, ctx: ExactAnchorPlanAuthContext) =>
  acquireRecoveryAuthorityLease(query as never, [ctx.actorId])

const applyArgs = (token: string) => ({
  token,
  sheetId: SHEET,
  actorId: ACTOR,
  evaluateFullReadAccess: ALLOW_FULL_READ,
  stabilizeAuthorization: REAL_STABILIZE,
  evaluatePlanAuthorization: ALLOW_PLAN,
})

const revSeq = (
  recordId: string,
  version: number,
  action: 'create' | 'update' | 'delete',
  snap: Record<string, unknown> | null,
  seq: string,
  opId?: string | null,
) =>
  q(
    `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, seq, operation_id)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,'rest',ARRAY[]::text[],'{}'::jsonb,$5::jsonb,$6::bigint,$7::uuid)`,
    [SHEET, recordId, version, action, snap === null ? null : JSON.stringify(snap), seq, opId ?? null],
  )
const live = (id: string, data: Record<string, unknown>, version = 1) =>
  q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,$4)', [id, SHEET, JSON.stringify(data), version])
const liveRow = async (id: string) =>
  (await q('SELECT data, version FROM meta_records WHERE id = $1 AND sheet_id = $2', [id, SHEET])).rows[0] as
    | { data: Record<string, unknown>; version: number }
    | undefined
const burnCount = async () =>
  Number(((await q('SELECT count(*)::int c FROM meta_recovery_token_burns WHERE sheet_id = $1', [SHEET])).rows[0] as { c: number }).c)
const trashCount = async (recordId: string) =>
  Number(
    ((await q('SELECT count(*)::int c FROM meta_records_trash WHERE record_id = $1 AND sheet_id = $2', [recordId, SHEET])).rows[0] as {
      c: number
    }).c,
  )
const restoreRevisionCount = async () =>
  Number(
    ((await q(`SELECT count(*)::int c FROM meta_record_revisions WHERE sheet_id = $1 AND source = 'restore'`, [SHEET])).rows[0] as {
      c: number
    }).c,
  )
const linkTargets = async (fieldId: string, recordId: string) =>
  ((await q('SELECT foreign_record_id FROM meta_links WHERE field_id = $1 AND record_id = $2 ORDER BY foreign_record_id', [fieldId, recordId])).rows as Array<{
    foreign_record_id: string
  }>).map((r) => r.foreign_record_id)
const insertLink = (fieldId: string, recordId: string, foreignId: string) =>
  q(`INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)`, [
    `lnk_${fieldId}_${recordId}_${foreignId}`.slice(0, 50),
    fieldId,
    recordId,
    foreignId,
  ])
const linkTableCount = async () =>
  Number(
    (
      (await q(
        `SELECT count(*)::int c FROM meta_links
         WHERE record_id IN (SELECT id FROM meta_records WHERE sheet_id = $1)
            OR foreign_record_id IN (SELECT id FROM meta_records WHERE sheet_id = $1)`,
        [SHEET],
      )).rows[0] as { c: number }
    ).c,
  )

async function sealAnchorOp(
  recordId: string,
  eventSeqs: Array<{ seq: string; version: number; action?: 'create' | 'update' | 'delete'; snap?: Record<string, unknown> }>,
): Promise<string> {
  const { randomUUID } = await import('node:crypto')
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
    await query(`INSERT INTO meta_record_history_operations (sheet_id, operation_id, endpoint_seq, event_count) VALUES ($1,$2::uuid,$3::bigint,$4::int)`, [
      SHEET,
      opId,
      maxSeq,
      eventSeqs.length,
    ])
  })
  return opId
}
const activate = () => txn((query) => activateCheckpoint(query, { sheetId: SHEET }))

async function seqBand(count: number): Promise<string[]> {
  await activate()
  const floorRes = await q(
    `SELECT trusted_since_seq::text AS s FROM meta_history_trust_checkpoints
     WHERE sheet_id = $1 AND state = 'active' AND pruned_at IS NULL`,
    [SHEET],
  )
  const floor = BigInt(String((floorRes.rows[0] as { s: string }).s))
  const seqs: string[] = []
  while (seqs.length < count) {
    const r = await q(`SELECT nextval('meta_record_chain_seq')::text AS s`)
    const s = BigInt(String((r.rows[0] as { s: string }).s))
    if (s > floor) seqs.push(String(s))
  }
  return seqs
}

async function wipe(): Promise<void> {
  await q(
    `DELETE FROM meta_links WHERE record_id IN (SELECT id FROM meta_records WHERE sheet_id = $1)
       OR foreign_record_id IN (SELECT id FROM meta_records WHERE sheet_id = $1)`,
    [SHEET],
  ).catch(() => {})
  await q('DELETE FROM meta_link_tombstones WHERE sheet_id = $1', [SHEET]).catch(() => {})
  for (const t of [
    'meta_history_baselines',
    'meta_history_trust_checkpoints',
    'meta_recovery_token_burns',
    'meta_record_version_markers',
    'meta_records_trash',
    'meta_record_revisions',
    'meta_records',
  ])
    await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET]).catch(() => {})
  await q('DELETE FROM meta_record_history_operations WHERE sheet_id = $1', [SHEET]).catch(() => {})
}

/**
 * Destructive RESET world: R_REV's data AND link field both differ between anchor and live (revert
 * would rewrite meta_records.data AND meta_links); R_NEW was created strictly after the anchor (reset
 * would delete it — meta_records row gone, meta_records_trash row created, delete revision minted).
 * A successful apply over this world touches all four tables named in the golden's invariant list.
 */
async function seedDestructiveResetWorld() {
  const R_A = `rec_p21_a_${TS}_${rand()}`
  const R_B = `rec_p21_b_${TS}_${rand()}`
  const R_REV = `rec_p21_rev_${TS}_${rand()}`
  const R_NEW = `rec_p21_new_${TS}_${rand()}`
  const [sA, sB, sCreate, sUpdate, sNew] = await seqBand(5)
  await revSeq(R_A, 1, 'create', { [F_STR]: 'A' }, sA)
  await revSeq(R_B, 1, 'create', { [F_STR]: 'B' }, sB)
  const anchorOp = await sealAnchorOp(R_REV, [{ seq: sCreate, version: 1, action: 'create', snap: { [F_STR]: 'rev-at-anchor', [F_LINK]: [R_A] } }])
  await revSeq(R_REV, 2, 'update', { [F_STR]: 'rev-now', [F_LINK]: [R_B] }, sUpdate)
  await revSeq(R_NEW, 1, 'create', { [F_STR]: 'newbie' }, sNew)
  await live(R_A, { [F_STR]: 'A' }, 1)
  await live(R_B, { [F_STR]: 'B' }, 1)
  await live(R_REV, { [F_STR]: 'rev-now', [F_LINK]: [R_B] }, 2)
  await live(R_NEW, { [F_STR]: 'newbie' }, 1)
  await insertLink(F_LINK, R_REV, R_B)
  return { R_A, R_B, R_REV, R_NEW, anchorOp }
}

/**
 * A deliberately DIFFERENT-SHAPED, smaller plan: one record, scalar-only, revert-only (no link change,
 * no delete). Used to prove the refusal shape does not encode plan magnitude/shape — a values-free check
 * needs two differently-sized destructive plans landing on the identical refusal, not one plan reprobed.
 */
async function seedMinimalRevertWorld() {
  const R = `rec_p21_min_${TS}_${rand()}`
  const [sCreate, sUpdate] = await seqBand(2)
  const anchorOp = await sealAnchorOp(R, [{ seq: sCreate, version: 1, action: 'create', snap: { [F_STR]: 'min-at-anchor' } }])
  await revSeq(R, 2, 'update', { [F_STR]: 'min-now' }, sUpdate)
  await live(R, { [F_STR]: 'min-now' }, 2)
  return { R, anchorOp }
}

const preview = async (anchorOp: string, mode: ExactAnchorApplyMode = 'reset') => {
  const res = await resolveExactAnchor(q as unknown as QueryFn, {
    sheetId: SHEET,
    request: { kind: 'exact-anchor', anchorOperationId: anchorOp },
    actorId: ACTOR,
    mode,
    evaluateFullReadAccess: ALLOW_FULL_READ,
  })
  expect(res.ok).toBe(true)
  if (!res.ok) throw new Error('preview failed')
  return res
}

async function disableAllAuthorityTriggers(): Promise<void> {
  for (const [table, trigger] of RECOVERY_AUTHORITY_TRIGGERS) {
    await q(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`)
  }
}
async function enableAllAuthorityTriggers(): Promise<void> {
  for (const [table, trigger] of RECOVERY_AUTHORITY_TRIGGERS) {
    await q(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`)
  }
}
async function currentTriggerStates(): Promise<string[]> {
  return (
    await q(
      `SELECT tgenabled FROM pg_trigger WHERE NOT tgisinternal AND tgname = ANY($1::text[]) ORDER BY tgname`,
      [[...RECOVERY_AUTHORITY_TRIGGERS].map(([, trigger]) => trigger)],
    )
  ).rows.map((row) => String((row as { tgenabled: unknown }).tgenabled))
}

test('sentinel: the real-DB allowlist step must have DATABASE_URL (fail-not-skip, scoped to that step)', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('P21 authority-unavailable real-DB step is missing DATABASE_URL — the harness is broken, not legitimately skippable')
  }
  expect(true).toBe(true)
})

describeIfDatabase.sequential('exact-anchor apply — authorityLease "unavailable" fail-closed (real DB, real authority substrate)', () => {
  beforeAll(async () => {
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'P21 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'P21'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_STR, SHEET, 'Note', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
      F_LINK,
      SHEET,
      'Rel',
      'link',
      JSON.stringify({ foreignSheetId: SHEET }),
      2,
    ])
    // Defensive: force the factory-default posture regardless of what an earlier suite in this sequential
    // run left behind. This is NOT a mock — it is genuinely (dis)arming the same trigger/function substrate
    // acquireRecoveryAuthorityLease inspects at runtime.
    await disableAllAuthorityTriggers()
  })
  beforeEach(async () => {
    await wipe()
    process.env[FLAG] = 'true'
    process.env[STRICT] = 'true'
    __resetRecoveryWriterStateColumnProbe()
    __resetOperationLedgerColumnProbe()
  })
  afterEach(() => {
    delete process.env[FLAG]
    delete process.env[STRICT]
  })
  afterAll(async () => {
    delete process.env[FLAG]
    delete process.env[STRICT]
    await wipe()
    await disableAllAuthorityTriggers().catch(() => {}) // leave factory posture behind for later suites
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
  })

  test('sentinel: DATABASE_URL is set (this suite must RUN, never skip-green)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('SUITE PRECONDITION: authority triggers are disarmed (this suite\'s own beforeAll forces it) before the golden below — the migration itself ships this way; see multitable-recovery-authority-stability-realdb.test.ts for the from-migration factory-default assertion', async () => {
    const states = await currentTriggerStates()
    expect(states).toHaveLength(RECOVERY_AUTHORITY_TRIGGERS.length)
    expect(new Set(states)).toEqual(new Set(['D']))
  })

  test('GOLDEN: factory-posture authority substrate ⇒ recovery-trust-required, zero persisted writes, values-free refusal', async () => {
    const { R_A, R_B, R_REV, R_NEW, anchorOp } = await seedDestructiveResetWorld()
    const pv = await preview(anchorOp, 'reset')

    const before = {
      rev: await liveRow(R_REV),
      a: await liveRow(R_A),
      b: await liveRow(R_B),
      new: await liveRow(R_NEW),
      revLinks: await linkTargets(F_LINK, R_REV),
      linkRows: await linkTableCount(),
      trash: await trashCount(R_NEW),
      restoreRevs: await restoreRevisionCount(),
      burns: await burnCount(),
    }
    // Sanity: the world really is pre-apply (nothing already matches the would-be-reverted target).
    expect(before.rev?.data).toEqual({ [F_STR]: 'rev-now', [F_LINK]: [R_B] })
    expect(before.revLinks).toEqual([R_B])
    expect(before.new).toBeDefined()
    expect(before.trash).toBe(0)

    const out = await applyExactAnchorRecovery(txn, applyArgs(pv.token))

    // 1. Exact refusal shape — toEqual (not toMatchObject) also proves no extra leaked fields.
    expect(out).toEqual({ ok: false, reason: 'recovery-trust-required' })

    // 2. Zero persisted writes anywhere the reset would have touched — full rollback, not partial.
    expect(await liveRow(R_REV)).toEqual(before.rev)
    expect(await liveRow(R_A)).toEqual(before.a)
    expect(await liveRow(R_B)).toEqual(before.b)
    expect(await liveRow(R_NEW)).toEqual(before.new) // NOT deleted
    expect(await linkTargets(F_LINK, R_REV)).toEqual(before.revLinks) // link edge NOT reverted
    expect(await linkTableCount()).toBe(before.linkRows)
    expect(await trashCount(R_NEW)).toBe(before.trash) // NOT trashed
    expect(await restoreRevisionCount()).toBe(before.restoreRevs) // no restore revision minted
    expect(await burnCount()).toBe(before.burns) // token burn rolled back with everything else

    // 3. Values-free: a DIFFERENTLY-SIZED, differently-shaped plan (single record, scalar-only,
    //    revert-only — no link component, no delete component) under the SAME authority posture refuses
    //    with the BYTE-IDENTICAL shape as the four-table destructive reset above. The refusal does not
    //    encode plan magnitude, record count, or which sub-checks (link/delete) would have applied.
    const { R: rMin, anchorOp: anchorMin } = await seedMinimalRevertWorld()
    const pvMin = await preview(anchorMin, 'revert')
    const outMin = await applyExactAnchorRecovery(txn, applyArgs(pvMin.token))
    expect(outMin).toEqual({ ok: false, reason: 'recovery-trust-required' })
    expect(outMin).toEqual(out) // identical shape regardless of plan size/shape
    expect(await liveRow(rMin)).toEqual({ data: { [F_STR]: 'min-now' }, version: 2 }) // untouched
    expect(await burnCount()).toBe(before.burns) // still zero across both worlds
  })

  test('POSITIVE CONTROL: the identical scenario applies successfully once the nine authority triggers are genuinely ENABLED — the refusal above is not vacuous', async () => {
    const { R_A, R_REV, R_NEW, anchorOp } = await seedDestructiveResetWorld()
    const pv = await preview(anchorOp, 'reset')
    await enableAllAuthorityTriggers()
    try {
      const states = await currentTriggerStates()
      expect(new Set(states)).toEqual(new Set(['O']))

      const out = await applyExactAnchorRecovery(txn, applyArgs(pv.token))
      expect(out.ok).toBe(true)

      expect((await liveRow(R_REV))?.data).toEqual({ [F_STR]: 'rev-at-anchor', [F_LINK]: [R_A] })
      expect(await linkTargets(F_LINK, R_REV)).toEqual([R_A])
      expect(await liveRow(R_NEW)).toBeUndefined()
      expect(await trashCount(R_NEW)).toBe(1)
      expect(await restoreRevisionCount()).toBeGreaterThan(0)
      expect(await burnCount()).toBe(1)
    } finally {
      await disableAllAuthorityTriggers()
    }
  })
})
