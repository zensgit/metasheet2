/**
 * #4196 Class-B outbound two-phase intent/outcome — real-DB goldens (design-lock
 * `approval-automation-retry-action-classification-designlock-20260712.md` §3 + §8 Q-B + §9 V3/V7).
 *
 * Proves against a REAL Postgres schema:
 *   - the §3 table shape: named CHECKs (kind closed set, non-blank root/action_key, status closed set,
 *     attempts non-negative) reject by constraint name; the UNIQUE (kind, root, action_key) identity index;
 *   - the two-phase HAPPY path (proceed → sent; retry consults `sent` → skip_sent, NO resend);
 *   - the CRASH-MID-SEND hazard: intent committed `pending`, NO outcome recorded, a retry sees `pending`
 *     and FAILS CLOSED — flips it to `outcome_unknown` and returns `skip_unknown` (never a second send);
 *   - `outcome_unknown` is TERMINAL: a further retry stays `skip_unknown`;
 *   - DEFINITE pre-dispatch non-delivery (`failed`) is re-attemptable (`retry_failed`) and can then succeed;
 *   - the `status='pending'` single-writer guard: a late terminal write does NOT clobber a terminalized row;
 *   - §6.1 STRUCTURAL disjointness: execution vs test_run under identical root+action_key are independent.
 *
 * Two-point wired (plugin-tests.yml + vitest.config.ts exclude) so it cannot skip-green.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import {
  claimOutboundIntent,
  recordOutboundOutcome,
  type OutboundIntentIdentity,
  type OutboundQueryFn,
} from '../../src/multitable/automation-outbound-intent'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q: OutboundQueryFn = (sql, params) => poolManager.get().query(sql, params)
const RUN = randomUUID()
const ROOT = `exec_${RUN}`

const id = (suffix: string, kind: 'execution' | 'test_run' = 'execution'): OutboundIntentIdentity => ({
  kind,
  rootExecutionId: ROOT,
  actionKey: `ak_${RUN}_${suffix}`,
})
const statusOf = async (i: OutboundIntentIdentity): Promise<string | undefined> => {
  const { rows } = await q(
    `SELECT status FROM meta_automation_outbound_intent WHERE kind=$1 AND root_execution_id=$2 AND action_key=$3`,
    [i.kind, i.rootExecutionId, i.actionKey],
  )
  return (rows[0] as { status?: string } | undefined)?.status
}
const rawInsert = (kind: string, root: string, key: string, status = 'pending') =>
  q(`INSERT INTO meta_automation_outbound_intent (kind, root_execution_id, action_key, status) VALUES ($1,$2,$3,$4)`, [kind, root, key, status])

describeIfDatabase('#4196 Class-B outbound two-phase intent/outcome (real DB)', () => {
  afterAll(async () => {
    await q(`DELETE FROM meta_automation_outbound_intent WHERE root_execution_id LIKE $1`, [`%${RUN}%`]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('schema: named CHECKs reject bad kind / blank identity / bad status / negative attempts by constraint name', async () => {
    await expect(rawInsert('bogus', ROOT, `ak_${RUN}_c1`)).rejects.toThrow(/outbound_intent_kind_valid/)
    await expect(rawInsert('execution', '  ', `ak_${RUN}_c2`)).rejects.toThrow(/outbound_intent_root_nonblank/)
    await expect(rawInsert('execution', ROOT, '\t')).rejects.toThrow(/outbound_intent_action_key_nonblank/)
    await expect(rawInsert('execution', ROOT, `ak_${RUN}_c3`, 'delivered')).rejects.toThrow(/outbound_intent_status_valid/)
    await expect(
      q(`INSERT INTO meta_automation_outbound_intent (kind, root_execution_id, action_key, attempts) VALUES ($1,$2,$3,$4)`, ['execution', ROOT, `ak_${RUN}_c4`, -1]),
    ).rejects.toThrow(/outbound_intent_attempts_nonneg/)
  })

  test('schema: the UNIQUE (kind, root, action_key) identity collides a duplicate by index name', async () => {
    await rawInsert('execution', ROOT, `ak_${RUN}_uq`)
    await expect(rawInsert('execution', ROOT, `ak_${RUN}_uq`)).rejects.toThrow(/uq_outbound_intent_identity/)
  })

  test('§6.1 disjointness: execution vs test_run under identical root+action_key are independent identities', async () => {
    const key = `ak_${RUN}_kinds`
    await expect(rawInsert('execution', ROOT, key)).resolves.toBeTruthy()
    await expect(rawInsert('test_run', ROOT, key)).resolves.toBeTruthy()
  })

  test('two-phase HAPPY: proceed → record sent → retry consults sent → skip_sent (no resend)', async () => {
    const i = id('happy')
    expect(await claimOutboundIntent(q, i)).toBe('proceed')
    await recordOutboundOutcome(q, i, 'sent', 'sent_2xx')
    expect(await statusOf(i)).toBe('sent')
    expect(await claimOutboundIntent(q, i)).toBe('skip_sent') // a retry never re-sends a delivered intent
  })

  test('CRASH-MID-SEND: pending intent, NO outcome, retry → flips pending→outcome_unknown → skip_unknown (never a 2nd send)', async () => {
    const i = id('crash')
    expect(await claimOutboundIntent(q, i)).toBe('proceed') // intent committed pending; then "crash" (no outcome)
    expect(await statusOf(i)).toBe('pending')
    expect(await claimOutboundIntent(q, i)).toBe('skip_unknown') // the retry fails closed
    expect(await statusOf(i)).toBe('outcome_unknown') // flipped — the send may have happened, never resend
  })

  test('outcome_unknown is TERMINAL: a further retry stays skip_unknown', async () => {
    const i = id('terminal')
    await claimOutboundIntent(q, i)
    await recordOutboundOutcome(q, i, 'outcome_unknown', 'timeout')
    expect(await statusOf(i)).toBe('outcome_unknown')
    expect(await claimOutboundIntent(q, i)).toBe('skip_unknown')
    expect(await claimOutboundIntent(q, i)).toBe('skip_unknown')
  })

  test('DEFINITE non-delivery (failed) → retry_failed permitted → can then succeed', async () => {
    const i = id('failed')
    await claimOutboundIntent(q, i)
    await recordOutboundOutcome(q, i, 'failed', 'dns_failure') // nothing ever left the client
    expect(await statusOf(i)).toBe('failed')
    expect(await claimOutboundIntent(q, i)).toBe('retry_failed') // eligible to re-attempt
    expect(await statusOf(i)).toBe('pending')
    const { rows } = await q(`SELECT attempts FROM meta_automation_outbound_intent WHERE kind=$1 AND root_execution_id=$2 AND action_key=$3`, [i.kind, i.rootExecutionId, i.actionKey])
    expect(Number((rows[0] as { attempts: number }).attempts)).toBe(1) // attempt bumped
    await recordOutboundOutcome(q, i, 'sent', 'sent_2xx')
    expect(await claimOutboundIntent(q, i)).toBe('skip_sent')
  })

  test('status=pending single-writer guard: a late terminal write does NOT clobber a terminalized row', async () => {
    const i = id('guard')
    await claimOutboundIntent(q, i)
    await recordOutboundOutcome(q, i, 'outcome_unknown', 'timeout') // terminalized
    await recordOutboundOutcome(q, i, 'sent', 'sent_2xx') // a zombie's late write — must be a 0-row no-op
    expect(await statusOf(i)).toBe('outcome_unknown') // stays terminal
  })

  test('constructed race: two concurrent first-claims of the same identity → exactly one proceed', async () => {
    const i = id('race')
    const [a, b] = await Promise.all([claimOutboundIntent(q, i), claimOutboundIntent(q, i)])
    // Exactly one wins the fresh INSERT ('proceed'); the loser sees the row. Its status is 'pending' (the
    // winner has not recorded an outcome yet) so it fails closed to skip_unknown, never a duplicate send.
    expect([a, b].filter((r) => r === 'proceed')).toHaveLength(1)
    expect([a, b].filter((r) => r === 'skip_unknown')).toHaveLength(1)
  })
})
