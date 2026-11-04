/**
 * #4196 Class-B outbound two-phase intent/outcome — real-DB goldens (design-lock
 * `approval-automation-retry-action-classification-designlock-20260712.md` §3 + §8 Q-B + §9 V3/V7, plus the
 * S0-c ledger-correctness slice: attempt token, lease, single winner, per-target keys of #4450 §2.1).
 *
 * Proves against a REAL Postgres schema (two INDEPENDENT connections where interleaving matters — fake-PG
 * cannot model READ COMMITTED compare-and-set semantics):
 *   - the §3 table shape: named CHECKs reject by constraint name (incl. the #4450 target_key shape); the
 *     UNIQUE (kind, root, action_key, target_key) identity index; the three additive columns; a legacy-shaped
 *     INSERT (no target_key / token / lease) lands as the '' whole-action sentinel;
 *   - the two-phase HAPPY path: proceed mints a token + lease; the SAME token confirms `sent`; a replay skips;
 *   - a LIVE `pending` (lease not expired) is skip_inflight: the replay neither sends nor flips, and the
 *     in-flight attempt still confirms afterwards;
 *   - CRASH-MID-SEND: only an EXPIRED lease is flipped to `outcome_unknown` (token-guarded, last_error
 *     lease_expired); the dead attempt's late terminal write is refused AND told so (confirmed:false);
 *   - a lease-less legacy `pending` row is never live (the pre-lease crash-flip is preserved for it);
 *   - `outcome_unknown` is TERMINAL; `failed` re-arms with a new token and EXACTLY ONE winner across two
 *     connections (forced interleaving: both consult `failed` before either compare-and-set commits);
 *   - the key-format upgrade: history written under the whole-action key blocks per-target sends (sent /
 *     unknown), a sentinel `failed` does not; per-target keys: two records → two rows, same record → same row;
 *   - executor-level interleaving (AutomationExecutor on connection A vs B): A claims and waits on the remote,
 *     B replays → sends nothing, fails naming in flight; A gets 2xx → success only after its token-matched
 *     terminal write; and the lease-expiry variant where A must NOT report success;
 *   - the migration's down() collapses fan-out rows fail-closed and up() re-widens (rolled-back transaction).
 *
 * Two-point wired (plugin-tests.yml + vitest.config.ts exclude) so it cannot skip-green.
 */
import { randomUUID } from 'node:crypto'

import { Client } from 'pg'
import { sql, type Kysely } from 'kysely'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { db } from '../../src/db/db'
import { EventBus } from '../../src/integration/events/event-bus'
import { down as leaseDown, up as leaseUp } from '../../src/db/migrations/zzzz20261103120000_outbound_intent_attempt_lease_target_key'
import {
  AutomationExecutor,
  type AutomationDeps,
  type AutomationRule,
} from '../../src/multitable/automation-executor'
import {
  claimOutboundIntent,
  deriveOutboundTargetKey,
  recordOutboundOutcome,
  type OutboundIntentIdentity,
  type OutboundQueryFn,
} from '../../src/multitable/automation-outbound-intent'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q: OutboundQueryFn = (sql, params) => poolManager.get().query(sql, params)
const RUN = randomUUID()
const ROOT = `exec_${RUN}`
const FLAG = 'AUTOMATION_CLASSB_OUTBOUND_ENABLED'

const id = (suffix: string, kind: 'execution' | 'test_run' = 'execution', targetKey?: string): OutboundIntentIdentity => ({
  kind,
  rootExecutionId: ROOT,
  actionKey: `ak_${RUN}_${suffix}`,
  ...(targetKey ? { targetKey } : {}),
})
interface LedgerRow {
  status: string
  attempts: number
  last_error: string | null
  attempt_token: string | null
  lease_expires_at: Date | null
  target_key: string
}
const rowOf = async (i: OutboundIntentIdentity, query: OutboundQueryFn = q): Promise<LedgerRow | undefined> => {
  const { rows } = await query(
    `SELECT status, attempts, last_error, attempt_token, lease_expires_at, target_key
       FROM meta_automation_outbound_intent
      WHERE kind=$1 AND root_execution_id=$2 AND action_key=$3 AND target_key=$4`,
    [i.kind, i.rootExecutionId, i.actionKey, i.targetKey ?? ''],
  )
  return rows[0] as LedgerRow | undefined
}
const statusOf = async (i: OutboundIntentIdentity): Promise<string | undefined> => (await rowOf(i))?.status
/** The pre-S0-c row shape: no target_key, no token, no lease (what every row written before this slice looks like). */
const rawInsert = (kind: string, root: string, key: string, status = 'pending') =>
  q(`INSERT INTO meta_automation_outbound_intent (kind, root_execution_id, action_key, status) VALUES ($1,$2,$3,$4)`, [kind, root, key, status])
/** Time-travel: move an attempt's lease into the past (the DB clock decides liveness). */
const expireLease = (i: OutboundIntentIdentity) =>
  q(`UPDATE meta_automation_outbound_intent SET lease_expires_at = now() - interval '1 second' WHERE kind=$1 AND root_execution_id=$2 AND action_key=$3 AND target_key=$4`, [i.kind, i.rootExecutionId, i.actionKey, i.targetKey ?? ''])

const token = (claim: Awaited<ReturnType<typeof claimOutboundIntent>>): string => {
  if (claim.attemptToken === null) throw new Error(`claim ${claim.decision} carries no token`)
  return claim.attemptToken
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

// ── executor seam: the ledger goes to a REAL dedicated connection, everything else is the zero-DB stub the
//    unit harness uses, so the executor's flow runs while only the intent ledger touches Postgres.
const resp = (status: number) => ({ ok: status >= 200 && status < 300, status }) as unknown as Response
const TRIGGER = { recordId: 'rec_1', sheetId: 'sheet_1', actorId: 'user_1', data: {} }
function webhookRule(suffix: string): AutomationRule {
  return {
    id: `rule_${RUN}_${suffix}`, name: 'Class-B real-DB rule', sheetId: 'sheet_1',
    trigger: { type: 'record.created', config: {} },
    actions: [{ type: 'send_webhook', config: { url: `https://example.test/hook/${RUN}/${suffix}`, body: { x: 1 } } }] as never,
    enabled: true, createdBy: 'user_1', createdAt: '2026-01-01T00:00:00Z',
  } as AutomationRule
}
function executorOn(client: Client, fetchImpl: () => Promise<Response> | Response) {
  const fetchSpy = vi.fn(async () => await fetchImpl())
  const queryFn: AutomationDeps['queryFn'] = async (sqlText, params = []) => {
    if (/meta_automation_outbound_intent/i.test(String(sqlText))) return client.query(String(sqlText), params)
    return { rows: [], rowCount: 1 }
  }
  // #5619 checks the target before every send; resolve the synthetic host to a public documentation
  // address so the check passes and the flow reaches the injected fetch (the ledger is what is under test).
  const ssrfLookupFn: AutomationDeps['ssrfLookupFn'] = async () => [{ address: '203.0.113.10', family: 4 }]
  return { exec: new AutomationExecutor({ eventBus: new EventBus(), queryFn, fetchFn: fetchSpy as unknown as typeof fetch, ssrfLookupFn }), fetch: fetchSpy }
}
async function untilCalled(spy: ReturnType<typeof vi.fn>, n: number): Promise<void> {
  for (let i = 0; i < 400 && spy.mock.calls.length < n; i++) await tick()
  expect(spy.mock.calls.length).toBeGreaterThanOrEqual(n)
}

describeIfDatabase('#4196 Class-B outbound two-phase intent/outcome (real DB)', () => {
  let a: Client
  let b: Client
  let qa: OutboundQueryFn
  let qb: OutboundQueryFn
  const savedFlag = process.env[FLAG]

  beforeAll(async () => {
    a = new Client({ connectionString: process.env.DATABASE_URL })
    b = new Client({ connectionString: process.env.DATABASE_URL })
    await a.connect()
    await b.connect()
    qa = (s, p) => a.query(s, p)
    qb = (s, p) => b.query(s, p)
  })
  afterEach(() => {
    if (savedFlag === undefined) delete process.env[FLAG]
    else process.env[FLAG] = savedFlag
  })
  afterAll(async () => {
    await q(`DELETE FROM meta_automation_outbound_intent WHERE root_execution_id LIKE $1`, [`%${RUN}%`]).catch(() => {})
    await a?.end().catch(() => {})
    await b?.end().catch(() => {})
  })

  test('sentinel: DATABASE_URL set, two independent connections', async () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
    const [pa, pb] = await Promise.all([qa('SELECT pg_backend_pid() AS pid'), qb('SELECT pg_backend_pid() AS pid')])
    expect((pa.rows[0] as { pid: number }).pid).not.toBe((pb.rows[0] as { pid: number }).pid)
  })

  test('schema: named CHECKs reject bad kind / blank identity / bad status / negative attempts / malformed target_key by constraint name', async () => {
    await expect(rawInsert('bogus', ROOT, `ak_${RUN}_c1`)).rejects.toThrow(/outbound_intent_kind_valid/)
    await expect(rawInsert('execution', '  ', `ak_${RUN}_c2`)).rejects.toThrow(/outbound_intent_root_nonblank/)
    await expect(rawInsert('execution', ROOT, '\t')).rejects.toThrow(/outbound_intent_action_key_nonblank/)
    await expect(rawInsert('execution', ROOT, `ak_${RUN}_c3`, 'delivered')).rejects.toThrow(/outbound_intent_status_valid/)
    await expect(
      q(`INSERT INTO meta_automation_outbound_intent (kind, root_execution_id, action_key, attempts) VALUES ($1,$2,$3,$4)`, ['execution', ROOT, `ak_${RUN}_c4`, -1]),
    ).rejects.toThrow(/outbound_intent_attempts_nonneg/)
    await expect(
      q(`INSERT INTO meta_automation_outbound_intent (kind, root_execution_id, action_key, target_key) VALUES ($1,$2,$3,$4)`, ['execution', ROOT, `ak_${RUN}_c5`, 'rec_a']),
    ).rejects.toThrow(/outbound_intent_target_key_shape/)
  })

  test('schema: the UNIQUE (kind, root, action_key, target_key) identity — sentinel rows collide as before, two targets of one action coexist, the same target collides', async () => {
    await rawInsert('execution', ROOT, `ak_${RUN}_uq`)
    await expect(rawInsert('execution', ROOT, `ak_${RUN}_uq`)).rejects.toThrow(/uq_outbound_intent_identity/)
    const t1 = deriveOutboundTargetKey(['rec', '1'])
    const t2 = deriveOutboundTargetKey(['rec', '2'])
    const ins = (t: string) => q(`INSERT INTO meta_automation_outbound_intent (kind, root_execution_id, action_key, target_key) VALUES ($1,$2,$3,$4)`, ['execution', ROOT, `ak_${RUN}_uq2`, t])
    await expect(ins(t1)).resolves.toBeTruthy()
    await expect(ins(t2)).resolves.toBeTruthy()
    await expect(ins(t1)).rejects.toThrow(/uq_outbound_intent_identity/)
  })

  test('schema: a legacy-shaped INSERT (no target_key / token / lease) lands as the whole-action sentinel with no lease', async () => {
    const i = id('legacy_shape')
    await rawInsert('execution', ROOT, i.actionKey, 'sent')
    expect(await rowOf(i)).toMatchObject({ status: 'sent', target_key: '', attempt_token: null, lease_expires_at: null })
  })

  test('§6.1 disjointness: execution vs test_run under identical root+action_key are independent identities', async () => {
    const key = `ak_${RUN}_kinds`
    await expect(rawInsert('execution', ROOT, key)).resolves.toBeTruthy()
    await expect(rawInsert('test_run', ROOT, key)).resolves.toBeTruthy()
  })

  test('two-phase HAPPY: proceed mints a token + future lease → the SAME token records sent (confirmed) → replay consults sent → skip_sent (no resend)', async () => {
    const i = id('happy')
    const claim = await claimOutboundIntent(q, i, { leaseMs: 60_000 })
    expect(claim.decision).toBe('proceed')
    const row = await rowOf(i)
    expect(row).toMatchObject({ status: 'pending', attempt_token: token(claim), target_key: '' })
    expect(row?.lease_expires_at && row.lease_expires_at.getTime() > Date.now() + 30_000).toBe(true)
    expect(await recordOutboundOutcome(q, i, 'sent', 'sent_2xx', token(claim))).toEqual({ confirmed: true })
    expect(await statusOf(i)).toBe('sent')
    expect(await claimOutboundIntent(q, i)).toEqual({ decision: 'skip_sent', attemptToken: null })
  })

  test('LIVE pending on connection A, replay on connection B → skip_inflight: no send, no flip; A still confirms its own result', async () => {
    const i = id('inflight')
    const claimA = await claimOutboundIntent(qa, i) // default lease, in flight on A
    expect(claimA.decision).toBe('proceed')
    expect(await claimOutboundIntent(qb, i)).toEqual({ decision: 'skip_inflight', attemptToken: null })
    expect(await rowOf(i)).toMatchObject({ status: 'pending', attempt_token: token(claimA) }) // not declared dead
    expect(await recordOutboundOutcome(qa, i, 'sent', 'sent_2xx', token(claimA))).toEqual({ confirmed: true })
    expect((await claimOutboundIntent(qb, i)).decision).toBe('skip_sent')
  })

  test('CRASH-MID-SEND: pending with an EXPIRED lease, NO outcome → replay flips pending→outcome_unknown (lease_expired) → skip_unknown; the dead attempt is refused and told so', async () => {
    const i = id('crash')
    const claim = await claimOutboundIntent(qa, i, { leaseMs: 1_000 })
    expect(claim.decision).toBe('proceed')
    await expireLease(i) // the attempt ran past its lease (or died)
    expect(await claimOutboundIntent(qb, i)).toEqual({ decision: 'skip_unknown', attemptToken: null }) // fails closed
    expect(await rowOf(i)).toMatchObject({ status: 'outcome_unknown', last_error: 'lease_expired', attempt_token: token(claim) })
    // The slow attempt finally gets its 2xx: its token-fenced write hits 0 rows and it is TOLD.
    expect(await recordOutboundOutcome(qa, i, 'sent', 'sent_2xx', token(claim))).toEqual({ confirmed: false })
    expect(await statusOf(i)).toBe('outcome_unknown') // never clobbered back to sent
  })

  test('a lease-less legacy pending row (written before leases existed) is never live: a replay flips it (pre-lease behaviour kept)', async () => {
    const i = id('legacy_pending')
    await rawInsert('execution', ROOT, i.actionKey) // pending, token NULL, lease NULL
    expect((await claimOutboundIntent(q, i)).decision).toBe('skip_unknown')
    expect(await rowOf(i)).toMatchObject({ status: 'outcome_unknown', last_error: 'lease_expired' })
  })

  test('outcome_unknown is TERMINAL: a further retry stays skip_unknown', async () => {
    const i = id('terminal')
    const claim = await claimOutboundIntent(q, i)
    await recordOutboundOutcome(q, i, 'outcome_unknown', 'timeout', token(claim))
    expect(await statusOf(i)).toBe('outcome_unknown')
    expect((await claimOutboundIntent(q, i)).decision).toBe('skip_unknown')
    expect((await claimOutboundIntent(q, i)).decision).toBe('skip_unknown')
  })

  test('DEFINITE non-delivery (failed) → retry_failed re-arms with a NEW token (attempts+1); the old token can no longer write; the new one succeeds', async () => {
    const i = id('failed')
    const first = await claimOutboundIntent(q, i)
    await recordOutboundOutcome(q, i, 'failed', 'dns_failure', token(first)) // nothing ever left the client
    expect(await statusOf(i)).toBe('failed')
    const retry = await claimOutboundIntent(q, i, { leaseMs: 60_000 })
    expect(retry.decision).toBe('retry_failed') // eligible to re-attempt
    expect(token(retry)).not.toBe(token(first))
    expect(await rowOf(i)).toMatchObject({ status: 'pending', attempts: 1, attempt_token: token(retry) })
    expect(await recordOutboundOutcome(q, i, 'sent', 'sent_2xx', token(first))).toEqual({ confirmed: false }) // stale attempt fenced out
    expect(await recordOutboundOutcome(q, i, 'sent', 'sent_2xx', token(retry))).toEqual({ confirmed: true })
    expect((await claimOutboundIntent(q, i)).decision).toBe('skip_sent')
  })

  test('EXACTLY ONE winner: concurrent failed→pending on two connections (both consult failed before either CAS commits) → one retry_failed, the loser skip_inflight, no second send', async () => {
    const i = id('double_rearm')
    const first = await claimOutboundIntent(q, i)
    await recordOutboundOutcome(q, i, 'failed', 'dns_failure', token(first))
    // Force the interleaving: A's compare-and-set waits until B has consulted `failed`.
    const bConsulted = deferred<void>()
    const gatedA: OutboundQueryFn = async (s, p) => {
      if (/^\s*UPDATE/i.test(s)) await bConsulted.promise
      return qa(s, p)
    }
    const observedB: OutboundQueryFn = async (s, p) => {
      const r = await qb(s, p)
      if (/^\s*SELECT status/i.test(s)) bConsulted.resolve()
      return r
    }
    const [ra, rb] = await Promise.all([claimOutboundIntent(gatedA, i), claimOutboundIntent(observedB, i)])
    const decisions = [ra.decision, rb.decision]
    expect(decisions.filter((d) => d === 'retry_failed')).toHaveLength(1)
    expect(decisions.filter((d) => d === 'skip_inflight')).toHaveLength(1)
    const winner = ra.decision === 'retry_failed' ? ra : rb
    expect(await rowOf(i)).toMatchObject({ status: 'pending', attempts: 1, attempt_token: token(winner) })
  })

  test('constructed race: two concurrent FIRST claims of the same identity on two connections → exactly one proceed; the other sees a live pending → skip_inflight', async () => {
    const i = id('race')
    const [ra, rb] = await Promise.all([claimOutboundIntent(qa, i), claimOutboundIntent(qb, i)])
    expect([ra.decision, rb.decision].filter((d) => d === 'proceed')).toHaveLength(1)
    expect([ra.decision, rb.decision].filter((d) => d === 'skip_inflight')).toHaveLength(1) // never a duplicate send, never a false flip
    expect(await statusOf(i)).toBe('pending')
  })

  test('single-writer fence: a late terminal write after terminalization writes 0 rows and reports confirmed:false', async () => {
    const i = id('guard')
    const claim = await claimOutboundIntent(q, i)
    expect(await recordOutboundOutcome(q, i, 'outcome_unknown', 'timeout', token(claim))).toEqual({ confirmed: true })
    expect(await recordOutboundOutcome(q, i, 'sent', 'sent_2xx', token(claim))).toEqual({ confirmed: false }) // zombie
    expect(await statusOf(i)).toBe('outcome_unknown') // stays terminal
  })

  test('key-format upgrade: history under the whole-action key is recognized by whole-action AND per-target claims (sent / unknown block; failed does not)', async () => {
    const sent = id('upgrade_sent')
    await rawInsert('execution', ROOT, sent.actionKey, 'sent') // written by the pre-S0-c code
    expect((await claimOutboundIntent(q, sent)).decision).toBe('skip_sent')
    const sentTarget = { ...sent, targetKey: deriveOutboundTargetKey(['rec', 'a']) }
    expect((await claimOutboundIntent(q, sentTarget)).decision).toBe('skip_sent') // per-target claim honours the old row
    expect(await rowOf(sentTarget)).toBeUndefined() // and wrote no per-target intent

    const unknown = id('upgrade_unknown')
    await rawInsert('execution', ROOT, unknown.actionKey, 'outcome_unknown')
    expect((await claimOutboundIntent(q, unknown)).decision).toBe('skip_unknown')
    expect((await claimOutboundIntent(q, { ...unknown, targetKey: deriveOutboundTargetKey(['rec', 'a']) })).decision).toBe('skip_unknown')

    const failed = id('upgrade_failed')
    await rawInsert('execution', ROOT, failed.actionKey, 'failed')
    const perTarget = { ...failed, targetKey: deriveOutboundTargetKey(['rec', 'a']) }
    expect((await claimOutboundIntent(q, perTarget)).decision).toBe('proceed') // definite non-delivery blocks nothing
    expect(await rowOf(perTarget)).toMatchObject({ status: 'pending' })
    expect((await claimOutboundIntent(q, failed)).decision).toBe('retry_failed') // and the whole-action identity still re-arms
  })

  test('per-target keys: two records → two independent rows; the same record replays onto ITS row; resolution order is irrelevant', async () => {
    const base = id('fanout')
    const keys = ['rec_1', 'rec_2'].map((r) => deriveOutboundTargetKey(['yida_form_record', 'form_1', r]))
    const reversed = ['rec_2', 'rec_1'].map((r) => deriveOutboundTargetKey(['yida_form_record', 'form_1', r]))
    expect(new Set(keys)).toEqual(new Set(reversed))
    const r1 = { ...base, targetKey: keys[0] }
    const r2 = { ...base, targetKey: keys[1] }
    const c1 = await claimOutboundIntent(q, r1, { leaseMs: 1_000 })
    const c2 = await claimOutboundIntent(q, r2)
    expect(c1.decision).toBe('proceed')
    expect(c2.decision).toBe('proceed')
    expect(token(c1)).not.toBe(token(c2))
    await recordOutboundOutcome(q, r2, 'sent', 'sent_2xx', token(c2))
    await expireLease(r1) // crash before r1's outcome
    expect((await claimOutboundIntent(q, r2)).decision).toBe('skip_sent') // delivered record: no resend
    expect((await claimOutboundIntent(q, r1)).decision).toBe('skip_unknown') // crashed record: fail closed on ITS row
    expect(await statusOf(r1)).toBe('outcome_unknown')
    expect(await statusOf(r2)).toBe('sent')
  })

  test('executor interleaving (flag ON): A claims and waits on the remote; B replays → sends nothing, fails naming in flight; A gets 2xx → success only after its token-matched terminal write', async () => {
    process.env[FLAG] = 'true'
    const rule = webhookRule('exec_inflight')
    const root = `${ROOT}_exec_inflight`
    const remote = deferred<Response>()
    const A = executorOn(a, () => remote.promise)
    const B = executorOn(b, () => resp(200))
    const runA = A.exec.execute(rule, TRIGGER, undefined, root)
    await untilCalled(A.fetch, 1) // A owns a live pending and is waiting on the remote
    const runB = await B.exec.execute(rule, TRIGGER, undefined, root)
    expect(runB.steps[0]?.status).toBe('failed')
    expect(runB.steps[0]?.alreadyApplied).toBeUndefined()
    expect(runB.steps[0]?.error).toMatch(/in flight/)
    expect(B.fetch).toHaveBeenCalledTimes(0) // B sent nothing
    const { rows } = await q(`SELECT status, attempt_token FROM meta_automation_outbound_intent WHERE root_execution_id = $1`, [root])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'pending' }) // A not declared dead
    remote.resolve(resp(200))
    const doneA = await runA
    expect(doneA.steps[0]?.status).toBe('success')
    expect(doneA.steps[0]?.output).toMatchObject({ outcome: 'sent', httpStatus: 200 })
    const after = await q(`SELECT status, last_error, attempt_token FROM meta_automation_outbound_intent WHERE root_execution_id = $1`, [root])
    expect(after.rows[0]).toMatchObject({ status: 'sent', last_error: 'sent_2xx', attempt_token: (rows[0] as { attempt_token: string }).attempt_token })
    expect(A.fetch).toHaveBeenCalledTimes(1)
  })

  test('executor lease expiry (flag ON): A outlives its lease, B flips the row → A later gets 2xx but must NOT report success (terminal write unconfirmed)', async () => {
    process.env[FLAG] = 'true'
    const rule = webhookRule('exec_expired')
    const root = `${ROOT}_exec_expired`
    const remote = deferred<Response>()
    const A = executorOn(a, () => remote.promise)
    const B = executorOn(b, () => resp(200))
    const runA = A.exec.execute(rule, TRIGGER, undefined, root)
    await untilCalled(A.fetch, 1)
    await q(`UPDATE meta_automation_outbound_intent SET lease_expires_at = now() - interval '1 second' WHERE root_execution_id = $1`, [root])
    const runB = await B.exec.execute(rule, TRIGGER, undefined, root)
    expect(runB.steps[0]?.status).toBe('failed')
    expect(runB.steps[0]?.error).toMatch(/outcome_unknown/)
    expect(B.fetch).toHaveBeenCalledTimes(0) // never resent
    remote.resolve(resp(200))
    const doneA = await runA
    expect(doneA.steps[0]?.status).toBe('failed')
    expect(doneA.steps[0]?.alreadyApplied).toBeUndefined()
    expect(doneA.steps[0]?.error).toMatch(/terminal write not confirmed/)
    expect(doneA.steps[0]?.output).toMatchObject({ outcome: 'outcome_unknown', reason: 'terminal_write_unconfirmed', httpStatus: 200 })
    const { rows } = await q(`SELECT status, last_error FROM meta_automation_outbound_intent WHERE root_execution_id = $1`, [root])
    expect(rows).toEqual([{ status: 'outcome_unknown', last_error: 'lease_expired' }])
  })

  test('migration round trip (rolled back): down() collapses fan-out rows fail-closed into sentinel rows and restores the narrow index; up() re-widens', async () => {
    const rollback = new Error('synthetic migration rollback')
    const rootM = `${ROOT}_mig`
    const colCount = (client: Kysely<unknown>) => sql<{ count: number }>`SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'meta_automation_outbound_intent' AND column_name IN ('attempt_token', 'lease_expires_at', 'target_key')`.execute(client)
    const indexDef = (client: Kysely<unknown>) => sql<{ indexdef: string }>`SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'uq_outbound_intent_identity'`.execute(client)
    await expect(db.transaction().execute(async (client) => {
      const t = (n: string) => deriveOutboundTargetKey(['rec', n])
      const seed = (key: string, target: string, status: string) =>
        sql`INSERT INTO meta_automation_outbound_intent (kind, root_execution_id, action_key, target_key, status) VALUES ('execution', ${rootM}, ${key}, ${target}, ${status})`.execute(client)
      await seed('x', t('1'), 'sent')
      await seed('x', t('2'), 'failed')
      await seed('y', t('1'), 'failed')
      await seed('y', t('2'), 'failed')
      await seed('z', '', 'failed') // a legacy whole-action row alongside a crashed per-target attempt
      await seed('z', t('1'), 'pending')
      await seed('w', '', 'sent') // a plain single-send row: untouched

      await leaseDown(client as Kysely<unknown>)
      expect((await colCount(client as Kysely<unknown>)).rows).toEqual([{ count: 0 }])
      expect((await indexDef(client as Kysely<unknown>)).rows[0]?.indexdef).toMatch(/\(kind, root_execution_id, action_key\)$/)
      const collapsed = await sql<{ action_key: string; status: string; last_error: string | null; n: number }>`
        SELECT action_key, status, last_error, count(*)::int AS n
          FROM meta_automation_outbound_intent WHERE root_execution_id = ${rootM}
         GROUP BY action_key, status, last_error ORDER BY action_key`.execute(client)
      expect(collapsed.rows).toEqual([
        { action_key: 'w', status: 'sent', last_error: null, n: 1 },
        { action_key: 'x', status: 'outcome_unknown', last_error: 'rollback_collapsed_fanout', n: 1 }, // a sent target ⇒ never resend the action
        { action_key: 'y', status: 'failed', last_error: 'rollback_collapsed_fanout', n: 1 }, // every target definite ⇒ retryable
        { action_key: 'z', status: 'outcome_unknown', last_error: 'rollback_collapsed_fanout', n: 1 }, // a pending target ⇒ fail closed over the failed sentinel
      ])

      await leaseUp(client as Kysely<unknown>)
      expect((await colCount(client as Kysely<unknown>)).rows).toEqual([{ count: 3 }])
      expect((await indexDef(client as Kysely<unknown>)).rows[0]?.indexdef).toMatch(/\(kind, root_execution_id, action_key, target_key\)$/)
      const targets = await sql<{ target_key: string }>`SELECT DISTINCT target_key FROM meta_automation_outbound_intent WHERE root_execution_id = ${rootM}`.execute(client)
      expect(targets.rows).toEqual([{ target_key: '' }])
      throw rollback
    })).rejects.toBe(rollback)
    // Nothing of the round trip persisted.
    const { rows } = await q(`SELECT count(*)::int AS n FROM meta_automation_outbound_intent WHERE root_execution_id = $1`, [rootM])
    expect(rows).toEqual([{ n: 0 }])
    expect(await rowOf(id('happy'))).toMatchObject({ status: 'sent', target_key: '' })
  })
})
