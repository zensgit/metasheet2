/**
 * O2-S3 — exclusive-authority-lease starvation backoff (real DB).
 *
 * Module under test: `exact-anchor-recovery-execute.ts` bounded lease backoff around
 * `applyExactAnchorRecovery`, driven by the REAL `acquireRecoveryAuthorityLease` (the shared-writer /
 * exclusive-recovery NOWAIT lease) with the nine authority triggers ENABLED — writers in these goldens
 * hold the shared lease through the PRODUCTION trigger path (INSERT on user_permissions /
 * role_permissions), never a synthetic lock call.
 *
 * Goldens:
 *   CONTROL          no writer ⇒ the real lease acquires on the FIRST attempt and the apply lands
 *                    (the busy goldens below are proven load-bearing, not vacuously green).
 *   BASELINE (a)     writer holds the shared lease continuously; `maxAttempts: 1` (the old
 *                    single-attempt semantics) ⇒ immediate named busy outcome (`preview-drift`),
 *                    exactly one lease attempt, zero sleeps, zero writes.
 *   GAP (b) + (e)    writer holds, then releases DURING the first backoff sleep ⇒ the next fresh
 *                    NOWAIT attempt acquires the lease within the default budget. Two-connection
 *                    evidence inside the sleep: an EXCLUSIVE probe on the actor key fails while the
 *                    writer still holds (positive control: the probe detects held leases), succeeds
 *                    after release (recovery holds NOTHING between attempts), and a brand-new writer
 *                    transaction commits during the sleep (writers proceed during backoff).
 *   PARTIAL (e')     writer holds only the ROLE key ⇒ recovery takes the USER key then loses the role
 *                    NOWAIT try (a PARTIALLY-taken lease). The exclusive USER-key probe succeeds during
 *                    the sleep ⇒ the partial acquisition was released by the attempt's rollback.
 *   EXHAUSTION (c)   writer never pauses ⇒ default RECOVERY_LEASE_BACKOFF_MAX_ATTEMPTS fresh attempts
 *                    separated by the exported increasing delays, then the SAME named busy outcome,
 *                    fail-closed with zero writes (no burn, live row untouched).
 *
 * No-deadlock model preserved: every attempt is NOWAIT end-to-end and nothing is held between attempts
 * (proven by the probes) — the backoff adds timer sleeps, never blocking lock waits.
 *
 * Two-point wiring: plugin-tests.yml multitable real-DB run list + vitest.config.ts no-DB exclusion;
 * fail-not-skip sentinel below.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { RECOVERY_AUTHORITY_TRIGGERS } from '../../src/db/migrations/zzzz20260721121000_add_recovery_authority_locks'
import { acquireRecoveryAuthorityLease } from '../../src/multitable/recovery-authorization-stability'
import { resolveExactAnchor } from '../../src/multitable/exact-anchor-recovery'
import {
  applyExactAnchorRecovery,
  RECOVERY_LEASE_BACKOFF_DELAYS_MS,
  RECOVERY_LEASE_BACKOFF_MAX_ATTEMPTS,
  recoveryLeaseBackoffDelayMs,
} from '../../src/multitable/exact-anchor-recovery-execute'
import { activateCheckpoint, type QueryFn } from '../../src/multitable/history-trust-checkpoint'
import { __resetRecoveryWriterStateColumnProbe } from '../../src/multitable/canonical-sheet-fence'
import { __resetOperationLedgerColumnProbe } from '../../src/multitable/operation-ledger'

import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const FLAG = 'MULTITABLE_ENABLE_WRITER_FENCE'
const STRICT = 'MULTITABLE_HISTORY_CONTIGUITY_STRICT'
const TS = Date.now()
const BASE = `base_o2s3_${TS}`
const SHEET = `sheet_o2s3_${TS}`
const F_STR = `fld_o2s3_note_${TS}`
const ACTOR = `user_o2s3_${TS}`
const ROLE = `role_o2s3_${TS}`

const q = (sql: string, params: unknown[] = []) => poolManager.get().query(sql, params)
const txn = <T>(fn: (query: QueryFn) => Promise<T>): Promise<T> =>
  poolManager.get().transaction(async ({ query }) => fn(query as unknown as QueryFn)) as Promise<T>
const internal = () => {
  const pool = poolManager.get().getInternalPool()
  if (!pool) throw new Error('internal pool unavailable')
  return pool
}

// Kernel adjudication stubs (route injects real evaluators; this suite isolates the LEASE seam).
const ALLOW = async () => true

/** REAL lease acquisition over the actor key, with an attempt counter (the discriminator every golden pins). */
const makeStabilizer = () => {
  let calls = 0
  const stabilize = async (query: QueryFn): Promise<'ready' | 'busy' | 'unavailable'> => {
    calls += 1
    return acquireRecoveryAuthorityLease(query, [ACTOR])
  }
  return { stabilize, attempts: () => calls }
}

const applyArgs = (
  token: string,
  stabilize: ReturnType<typeof makeStabilizer>['stabilize'],
  leaseBackoff?: {
    maxAttempts?: number
    delaysMs?: readonly number[]
    sleep?: (ms: number, attemptJustFailed: number) => Promise<void>
  },
) => ({
  token,
  sheetId: SHEET,
  actorId: ACTOR,
  preliminaryFullRead: ALLOW,
  stabilizeAuthorization: stabilize,
  finalLockedFullRead: ALLOW,
  evaluatePlanAuthorization: ALLOW,
  ...(leaseBackoff ? { leaseBackoff } : {}),
})

/** Open writer transaction holding the SHARED lease on the ACTOR user key via the PRODUCTION trigger path. */
async function startSharedUserWriter(permissionCode: string): Promise<PoolClient> {
  const client = await internal().connect()
  await client.query('BEGIN')
  await client.query(
    'INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,$2)',
    [ACTOR, permissionCode],
  )
  return client
}

/** Open writer transaction holding the SHARED lease on the ROLE key only (role_permissions trigger). */
async function startSharedRoleWriter(permissionCode: string): Promise<PoolClient> {
  const client = await internal().connect()
  await client.query('BEGIN')
  await client.query(
    'INSERT INTO role_permissions (role_id, permission_code) VALUES ($1,$2)',
    [ROLE, permissionCode],
  )
  return client
}

/** Two-connection probe: can a FRESH connection take the EXCLUSIVE user-key lease right now? */
async function probeExclusiveUserKey(): Promise<boolean> {
  const client = await internal().connect()
  try {
    await client.query('BEGIN')
    const res = await client.query(
      'SELECT metasheet_try_recovery_authority_user($1, TRUE) AS acquired',
      [ACTOR],
    )
    return (res.rows[0] as { acquired?: unknown } | undefined)?.acquired === true
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

const releaseWriter = async (client: PoolClient | null, verb: 'COMMIT' | 'ROLLBACK' = 'ROLLBACK') => {
  if (!client) return
  await client.query(verb).catch(() => {})
  client.release()
}

const revSeq = (recordId: string, version: number, action: 'create' | 'update' | 'delete', snap: Record<string, unknown>, seq: string, opId?: string | null) =>
  q(
    `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, seq, operation_id)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,'rest',ARRAY[]::text[],'{}'::jsonb,$5::jsonb,$6::bigint,$7::uuid)`,
    [SHEET, recordId, version, action, JSON.stringify(snap), seq, opId ?? null],
  )
const live = (id: string, data: Record<string, unknown>, version = 1) =>
  q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,$4)', [id, SHEET, JSON.stringify(data), version])
const liveRow = async (id: string) =>
  (await q('SELECT data, version FROM meta_records WHERE id = $1 AND sheet_id = $2', [id, SHEET])).rows[0] as { data: Record<string, unknown>; version: number } | undefined
const burnCount = async () => Number(((await q('SELECT count(*)::int c FROM meta_recovery_token_burns WHERE sheet_id = $1', [SHEET])).rows[0] as { c: number }).c)

async function sealAnchorOp(recordId: string, seq: string, snap: Record<string, unknown>): Promise<string> {
  const opId = randomUUID()
  await txn(async (query) => {
    await query(
      `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, seq, operation_id)
       VALUES (gen_random_uuid(),$1,$2,1,'create','rest',ARRAY[]::text[],'{}'::jsonb,$3::jsonb,$4::bigint,$5::uuid)`,
      [SHEET, recordId, JSON.stringify(snap), seq, opId],
    )
    await query(
      `INSERT INTO meta_record_history_operations (sheet_id, operation_id, endpoint_seq, event_count) VALUES ($1,$2::uuid,$3::bigint,1)`,
      [SHEET, opId, seq],
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

/** Reserve `count` REAL chain-seq values strictly ABOVE the freshly-activated checkpoint (nextval only). */
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

/** Minimal revert world: R live version 2 differs from the sealed at-anchor snapshot (version 1). */
async function seedWorld() {
  const R = `rec_o2s3_${TS}_${Math.random().toString(36).slice(2, 6)}`
  const [sCreate, sUpdate] = await seqBand(2)
  const anchorOp = await sealAnchorOp(R, sCreate, { [F_STR]: 'at-anchor' })
  await revSeq(R, 2, 'update', { [F_STR]: 'live-now' }, sUpdate)
  await live(R, { [F_STR]: 'live-now' }, 2)
  return { R, anchorOp }
}

const preview = async (anchorOp: string) => {
  const res = await resolveExactAnchor(q as unknown as QueryFn, {
    sheetId: SHEET,
    request: { kind: 'exact-anchor', anchorOperationId: anchorOp },
    actorId: ACTOR,
    mode: 'revert',
    evaluateFullReadAccess: ALLOW,
  })
  expect(res.ok).toBe(true)
  if (!res.ok) throw new Error('preview failed')
  return res
}

test('sentinel: the real-DB allowlist step must have DATABASE_URL (fail-not-skip, scoped to that step)', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('lease-backoff real-DB step is missing DATABASE_URL — the harness is broken, not legitimately skippable')
  }
  expect(true).toBe(true)
})

describe('O2-S3 — backoff constants (pure)', () => {
  test('the ladder is bounded and strictly increasing; the delay helper clamps to the last rung', () => {
    expect(RECOVERY_LEASE_BACKOFF_MAX_ATTEMPTS).toBeGreaterThan(1)
    expect(RECOVERY_LEASE_BACKOFF_DELAYS_MS.length).toBe(RECOVERY_LEASE_BACKOFF_MAX_ATTEMPTS - 1)
    for (let i = 1; i < RECOVERY_LEASE_BACKOFF_DELAYS_MS.length; i++) {
      expect(RECOVERY_LEASE_BACKOFF_DELAYS_MS[i]).toBeGreaterThan(RECOVERY_LEASE_BACKOFF_DELAYS_MS[i - 1])
    }
    expect(recoveryLeaseBackoffDelayMs(1)).toBe(RECOVERY_LEASE_BACKOFF_DELAYS_MS[0])
    expect(recoveryLeaseBackoffDelayMs(RECOVERY_LEASE_BACKOFF_DELAYS_MS.length)).toBe(
      RECOVERY_LEASE_BACKOFF_DELAYS_MS[RECOVERY_LEASE_BACKOFF_DELAYS_MS.length - 1],
    )
    // Past-the-end attempts clamp to the LAST rung (never 0, never out-of-bounds undefined).
    expect(recoveryLeaseBackoffDelayMs(99)).toBe(
      RECOVERY_LEASE_BACKOFF_DELAYS_MS[RECOVERY_LEASE_BACKOFF_DELAYS_MS.length - 1],
    )
    expect(recoveryLeaseBackoffDelayMs(1, [])).toBe(0)
  })
})

describeIfDatabase.sequential('O2-S3 — exclusive-authority-lease starvation backoff (real DB)', () => {
  let initialTriggerStates: string[] = []

  beforeAll(async () => {
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
    await q('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [ACTOR, ROLE])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'O2S3 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'O2S3'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_STR, SHEET, 'Note', 'string', '{}', 1])
    initialTriggerStates = (
      await q(
        `SELECT tgenabled FROM pg_trigger WHERE NOT tgisinternal AND tgname = ANY($1::text[]) ORDER BY tgname`,
        [[...RECOVERY_AUTHORITY_TRIGGERS].map(([, trigger]) => trigger)],
      )
    ).rows.map((row) => String((row as { tgenabled: unknown }).tgenabled))
    for (const [table, trigger] of RECOVERY_AUTHORITY_TRIGGERS) {
      await q(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`)
    }
  })

  beforeEach(async () => {
    await wipe()
    process.env[FLAG] = 'true'
    process.env[STRICT] = 'true'
    __resetRecoveryWriterStateColumnProbe()
    __resetOperationLedgerColumnProbe()
  })

  afterEach(async () => {
    delete process.env[FLAG]
    delete process.env[STRICT]
    await q('DELETE FROM user_permissions WHERE user_id = $1', [ACTOR]).catch(() => {})
    await q('DELETE FROM role_permissions WHERE role_id = $1', [ROLE]).catch(() => {})
  })

  afterAll(async () => {
    for (const [table, trigger] of RECOVERY_AUTHORITY_TRIGGERS) {
      await q(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`).catch(() => {})
    }
    await wipe()
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM user_permissions WHERE user_id = $1', [ACTOR]).catch(() => {})
    await q('DELETE FROM user_roles WHERE user_id = $1', [ACTOR]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
  })

  test('sentinel: DATABASE_URL is set (this suite must RUN, never skip-green)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('CONTROL: with no writer, the REAL lease acquires on the first attempt and the apply lands', async () => {
    const { R, anchorOp } = await seedWorld()
    const pv = await preview(anchorOp)
    const stab = makeStabilizer()
    const sleeps: Array<[number, number]> = []
    const out = await applyExactAnchorRecovery(txn, applyArgs(pv.token, stab.stabilize, {
      sleep: async (ms, attempt) => { sleeps.push([ms, attempt]) },
    }))
    expect(out).toMatchObject({ ok: true, mode: 'revert', applied: { reverts: 1, resurrects: 0, deletes: 0 } })
    expect(stab.attempts()).toBe(1)
    expect(sleeps).toEqual([])
    expect((await liveRow(R))?.data).toEqual({ [F_STR]: 'at-anchor' })
    expect(await burnCount()).toBe(1)
  })

  test('BASELINE (a): continuous shared writer + single attempt (old semantics) ⇒ immediate named busy outcome, zero writes', async () => {
    const { R, anchorOp } = await seedWorld()
    const pv = await preview(anchorOp)
    const writer = await startSharedUserWriter('demo:read')
    try {
      const stab = makeStabilizer()
      const sleeps: Array<[number, number]> = []
      const out = await applyExactAnchorRecovery(txn, applyArgs(pv.token, stab.stabilize, {
        maxAttempts: 1,
        sleep: async (ms, attempt) => { sleeps.push([ms, attempt]) },
      }))
      expect(out).toEqual({ ok: false, reason: 'preview-drift' }) // the existing named busy outcome
      expect(stab.attempts()).toBe(1) // exactly ONE NOWAIT try — busy immediately, no waiting
      expect(sleeps).toEqual([]) // single-attempt semantics never sleeps
      expect((await liveRow(R))?.data).toEqual({ [F_STR]: 'live-now' }) // zero writes
      expect((await liveRow(R))?.version).toBe(2)
      expect(await burnCount()).toBe(0) // burn rolled back with the refused attempt
    } finally {
      await releaseWriter(writer)
    }
  })

  test('GAP (b) + two-connection (e): writer releases during the first backoff sleep ⇒ next fresh NOWAIT attempt acquires; nothing is held between attempts', async () => {
    const { R, anchorOp } = await seedWorld()
    const pv = await preview(anchorOp)
    let writer: PoolClient | null = await startSharedUserWriter('demo:read')
    const evidence: Array<[string, unknown]> = []
    const sleeps: Array<[number, number]> = []
    try {
      const stab = makeStabilizer()
      const out = await applyExactAnchorRecovery(txn, applyArgs(pv.token, stab.stabilize, {
        // Default maxAttempts/delays — proves the exported constants flow through unmodified.
        sleep: async (ms, attempt) => {
          sleeps.push([ms, attempt])
          if (attempt !== 1) return
          // Positive control: while the writer still holds the shared lease, the exclusive probe FAILS —
          // the probe genuinely detects held leases (its later `true` is not vacuous).
          evidence.push(['exclusive-while-writer-holds', await probeExclusiveUserKey()])
          // The writer stream pauses (gap): release the shared lease.
          await releaseWriter(writer)
          writer = null
          // (e) Between attempts recovery holds NOTHING: a fresh connection can take the EXCLUSIVE key.
          evidence.push(['exclusive-during-backoff', await probeExclusiveUserKey()])
          // (e) A brand-new writer PROCEEDS during the backoff sleep (trigger shared lease + commit).
          const during = await startSharedUserWriter('demo:write')
          await releaseWriter(during, 'COMMIT')
          evidence.push(['writer-committed-during-backoff', Number(
            ((await q('SELECT count(*)::int c FROM user_permissions WHERE user_id = $1 AND permission_code = $2', [ACTOR, 'demo:write'])).rows[0] as { c: number }).c,
          )])
        },
      }))
      expect(out).toMatchObject({ ok: true, mode: 'revert', applied: { reverts: 1, resurrects: 0, deletes: 0 } })
      expect(stab.attempts()).toBe(2) // busy once, acquired on the SECOND fresh NOWAIT try — within budget
      expect(sleeps).toEqual([[RECOVERY_LEASE_BACKOFF_DELAYS_MS[0], 1]]) // default first rung, once
      expect(evidence).toEqual([
        ['exclusive-while-writer-holds', false],
        ['exclusive-during-backoff', true],
        ['writer-committed-during-backoff', 1],
      ])
      expect((await liveRow(R))?.data).toEqual({ [F_STR]: 'at-anchor' }) // settled post-commit truth
      expect((await liveRow(R))?.version).toBe(3)
      expect(await burnCount()).toBe(1)
    } finally {
      await releaseWriter(writer)
    }
  })

  test("PARTIAL (e'): role-key writer makes the lease PARTIALLY taken (user key acquired, role key busy) — the partial is released between attempts", async () => {
    const { R, anchorOp } = await seedWorld()
    const pv = await preview(anchorOp)
    let writer: PoolClient | null = await startSharedRoleWriter('demo:read')
    const evidence: Array<[string, unknown]> = []
    try {
      let calls = 0
      const stabilize = async (query: QueryFn): Promise<'ready' | 'busy' | 'unavailable'> => {
        calls += 1
        const r = await acquireRecoveryAuthorityLease(query, [ACTOR])
        if (r === 'busy') {
          // POSITIVE CONTROL, in-attempt: the busy attempt is still open here, so its PARTIAL
          // acquisition (the exclusive USER key, taken before the ROLE key NOWAIT try lost) must make a
          // fresh-connection exclusive probe FAIL. Without this, the during-backoff `true` below could
          // be vacuous (a lease that was never taken is trivially "released").
          evidence.push(['user-key-held-inside-busy-attempt', await probeExclusiveUserKey()])
        }
        return r
      }
      const out = await applyExactAnchorRecovery(txn, applyArgs(pv.token, stabilize, {
        sleep: async (_ms, attempt) => {
          if (attempt !== 1) return
          // If the partial acquisition survived the attempt, this fresh-connection probe would fail.
          evidence.push(['user-key-free-during-backoff', await probeExclusiveUserKey()])
          await releaseWriter(writer)
          writer = null
        },
      }))
      expect(out).toMatchObject({ ok: true, applied: { reverts: 1 } })
      expect(calls).toBe(2)
      expect(evidence).toEqual([
        ['user-key-held-inside-busy-attempt', false],
        ['user-key-free-during-backoff', true],
      ])
      expect((await liveRow(R))?.data).toEqual({ [F_STR]: 'at-anchor' })
    } finally {
      await releaseWriter(writer)
    }
  })

  test('EXHAUSTION (c): writer never pauses ⇒ default attempts with increasing spacing, then the SAME named busy outcome, zero writes', async () => {
    const { R, anchorOp } = await seedWorld()
    const pv = await preview(anchorOp)
    const writer = await startSharedUserWriter('demo:read')
    try {
      const stab = makeStabilizer()
      const sleeps: Array<[number, number]> = []
      const out = await applyExactAnchorRecovery(txn, applyArgs(pv.token, stab.stabilize, {
        sleep: async (ms, attempt) => { sleeps.push([ms, attempt]) }, // writer NEVER releases
      }))
      expect(out).toEqual({ ok: false, reason: 'preview-drift' }) // fail-closed named busy outcome unchanged
      expect(stab.attempts()).toBe(RECOVERY_LEASE_BACKOFF_MAX_ATTEMPTS) // bounded — never spins forever
      expect(sleeps).toEqual(
        RECOVERY_LEASE_BACKOFF_DELAYS_MS.map((ms, i) => [ms, i + 1]), // increasing exported ladder
      )
      expect((await liveRow(R))?.data).toEqual({ [F_STR]: 'live-now' }) // zero writes after exhaustion
      expect((await liveRow(R))?.version).toBe(2)
      expect(await burnCount()).toBe(0)
    } finally {
      await releaseWriter(writer)
    }
  })

  test('REAL-TIMER: default sleep (no injection) still acquires in a writer gap — the ladder is wall-clock real, not only hook-driven', async () => {
    const { R, anchorOp } = await seedWorld()
    const pv = await preview(anchorOp)
    let writer: PoolClient | null = await startSharedUserWriter('demo:read')
    let calls = 0
    // No `sleep` injection: the DEFAULT timer ladder runs. The writer releases as soon as the FIRST
    // NOWAIT try has verifiably lost (never earlier — releasing on a wall-clock timer could beat the
    // first attempt and make this test pass without ever exercising the backoff).
    const stabilize = async (query: QueryFn): Promise<'ready' | 'busy' | 'unavailable'> => {
      calls += 1
      const r = await acquireRecoveryAuthorityLease(query, [ACTOR])
      if (r === 'busy' && writer) {
        const held = writer
        writer = null
        void releaseWriter(held) // concurrent release; completes well inside the 50ms default sleep
      }
      return r
    }
    try {
      const out = await applyExactAnchorRecovery(txn, applyArgs(pv.token, stabilize))
      expect(out).toMatchObject({ ok: true, applied: { reverts: 1 } })
      expect(calls).toBe(2) // busy once, then the REAL 50ms default backoff, then acquired
      expect((await liveRow(R))?.data).toEqual({ [F_STR]: 'at-anchor' })
      expect(await burnCount()).toBe(1)
    } finally {
      await releaseWriter(writer)
    }
  })

  test('posture restore probe: the nine triggers were all disabled before this suite enabled them', () => {
    expect(initialTriggerStates).toHaveLength(RECOVERY_AUTHORITY_TRIGGERS.length)
    expect(new Set(initialTriggerStates)).toEqual(new Set(['D']))
  })
})
