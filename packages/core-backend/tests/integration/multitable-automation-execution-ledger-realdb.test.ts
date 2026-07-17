/**
 * #4196 execution-scoped applied ledger — foundation slice (real DB).
 *
 * Proves the §2.2 LOCKED row shape at the DB layer and the §2 Class-A claim protocol:
 *   - named CHECKs (kind closed set, non-blank root/action_key) reject by constraint name;
 *   - the UNIQUE (kind, root_execution_id, action_key) claim key collides duplicates;
 *   - kind gives STRUCTURAL disjointness (§6.1): identical root+action_key strings under 'execution' vs
 *     'test_run' are two independent claims;
 *   - claimExecutionAction: claimed → duplicate; crash-safety (rollback → the retry claims again — §2's
 *     "no window where one is durable and the other is not"); a constructed two-transaction race yields
 *     exactly one 'claimed'; the pg-transaction-guard probe rejects pool / forged marker / bare autocommit;
 *   - deriveTestRunScopedRoot (§6.1): deterministic in (actor, rule, opId); each tuple component changes
 *     the root; the derived root never equals the raw caller value; opId charset/length is enforced;
 *   - coexists with the FWB ledger `meta_fwb_action_applied` (both real tables now) — one transaction can
 *     claim in BOTH, and the rows land in disjoint tables.
 *
 * Two-point wired (plugin-tests.yml + vitest.config.ts exclude) so it cannot skip-green.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import {
  claimExecutionAction,
  deriveTestRunScopedRoot,
} from '../../src/multitable/automation-execution-ledger'
import { claimActionApplied, deriveActionKey } from '../../src/multitable/automation-action-idempotency'
import type { TransactionalQueryable } from '../../src/multitable/pg-transaction-guard'
import type { PoolClient } from 'pg'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const RUN = randomUUID()
const ROOT = `exec_${RUN}`

const txn = (client: PoolClient): TransactionalQueryable => ({ isTransaction: true, query: (sql, params) => client.query(sql, params) })
async function inTxn<T>(fn: (trx: TransactionalQueryable, client: PoolClient) => Promise<T>): Promise<T> {
  const client = await poolManager.get().getInternalPool().connect()
  try {
    await client.query('BEGIN')
    const r = await fn(txn(client), client)
    await client.query('COMMIT')
    return r
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

const rawInsert = (kind: string, root: string, key: string) =>
  q(`INSERT INTO meta_automation_action_applied (kind, root_execution_id, action_key) VALUES ($1,$2,$3)`, [kind, root, key])

describeIfDatabase('#4196 execution-scoped applied ledger — foundation (real DB)', () => {
  afterAll(async () => {
    await q(`DELETE FROM meta_automation_action_applied WHERE root_execution_id LIKE $1`, [`%${RUN}%`]).catch(() => {})
    await q(`DELETE FROM meta_fwb_action_applied WHERE instance_id LIKE $1`, [`%${RUN}%`]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('schema: named CHECKs reject a bad kind and blank identity parts by constraint name', async () => {
    await expect(rawInsert('bogus', ROOT, `ak_${RUN}`)).rejects.toThrow(/automation_action_applied_kind_valid/)
    await expect(rawInsert('execution', '  ', `ak_${RUN}`)).rejects.toThrow(/automation_action_applied_root_nonblank/)
    await expect(rawInsert('execution', ROOT, '\t')).rejects.toThrow(/automation_action_applied_action_key_nonblank/)
  })

  test('schema: the UNIQUE claim key collides a duplicate by index name; §2 INSERT with only the 3 key columns is valid', async () => {
    // §2's exact INSERT shape (3 key columns only — action_type nullable, applied_at defaulted)
    await rawInsert('execution', ROOT, `ak_${RUN}_uq`)
    await expect(rawInsert('execution', ROOT, `ak_${RUN}_uq`)).rejects.toThrow(/uq_automation_action_applied_claim/)
  })

  test('§6.1 STRUCTURAL disjointness: identical root+action_key strings under execution vs test_run are two independent claims', async () => {
    const key = `ak_${RUN}_kinds`
    await expect(rawInsert('execution', ROOT, key)).resolves.toBeTruthy()
    await expect(rawInsert('test_run', ROOT, key)).resolves.toBeTruthy() // kind is part of the claim key
  })

  test('§2 claim protocol: first=claimed, repeat=duplicate (across committed transactions)', async () => {
    const key = deriveActionKey({ structuralPath: 's[0]', actionType: 'create_record', canonicalConfig: { t: RUN } })
    const claim = { kind: 'execution' as const, rootExecutionId: ROOT, actionKey: key, actionType: 'create_record' }
    expect(await inTxn((t) => claimExecutionAction(t, claim))).toBe('claimed')
    expect(await inTxn((t) => claimExecutionAction(t, claim))).toBe('duplicate')
  })

  test('§2 crash-safety: a rolled-back transaction leaves NO claim — the retry claims again (never a permanent skip)', async () => {
    const key = deriveActionKey({ structuralPath: 's[1]', actionType: 'update_record', canonicalConfig: { t: RUN } })
    const claim = { kind: 'execution' as const, rootExecutionId: ROOT, actionKey: key }
    const client = await poolManager.get().getInternalPool().connect()
    try {
      await client.query('BEGIN')
      expect(await claimExecutionAction(txn(client), claim)).toBe('claimed')
      await client.query('ROLLBACK') // "crash before COMMIT": neither the claim nor the mutation is durable
    } finally {
      client.release()
    }
    const { rows } = await q(`SELECT count(*)::int AS c FROM meta_automation_action_applied WHERE action_key=$1`, [key])
    expect(Number(rows[0].c)).toBe(0)
    expect(await inTxn((t) => claimExecutionAction(t, claim))).toBe('claimed') // the retry re-attempts correctly
  })

  test('§2 constructed race: two concurrent transactions claim the same key → exactly one claimed', async () => {
    const key = deriveActionKey({ structuralPath: 's[2]', actionType: 'delete_record', canonicalConfig: { t: RUN } })
    const claim = { kind: 'execution' as const, rootExecutionId: ROOT, actionKey: key }
    const [ra, rb] = await Promise.all([
      inTxn((t) => claimExecutionAction(t, claim)),
      inTxn((t) => claimExecutionAction(t, claim)),
    ])
    expect([ra, rb].filter((r) => r === 'claimed')).toHaveLength(1)
    expect([ra, rb].filter((r) => r === 'duplicate')).toHaveLength(1)
  })

  test('P1 guard: pool / forged marker / bare autocommit client are rejected by the xid probe before the claim', async () => {
    const key = `ak_${RUN}_probe`
    const claim = { kind: 'execution' as const, rootExecutionId: ROOT, actionKey: key }
    await expect(claimExecutionAction(poolManager.get() as unknown as TransactionalQueryable, claim)).rejects.toThrow(/real database TRANSACTION/)
    const forged: TransactionalQueryable = { isTransaction: true, query: (s, p) => poolManager.get().query(s, p) }
    await expect(claimExecutionAction(forged, claim)).rejects.toThrow(/real database TRANSACTION/)
    const bare = await poolManager.get().getInternalPool().connect()
    try {
      await expect(claimExecutionAction(txn(bare), claim)).rejects.toThrow(/real database TRANSACTION/)
    } finally {
      bare.release()
    }
    const { rows } = await q(`SELECT count(*)::int AS c FROM meta_automation_action_applied WHERE action_key=$1`, [key])
    expect(Number(rows[0].c)).toBe(0)
  })

  test('input validation: bad kind / blank root / blank key throw before any SQL', async () => {
    const stub: TransactionalQueryable = { isTransaction: true, query: async () => { throw new Error('must not be queried') } }
    await expect(claimExecutionAction(stub, { kind: 'bogus' as never, rootExecutionId: ROOT, actionKey: 'k' })).rejects.toThrow(/kind must be/)
    await expect(claimExecutionAction(stub, { kind: 'execution', rootExecutionId: ' ', actionKey: 'k' })).rejects.toThrow(/rootExecutionId/)
    await expect(claimExecutionAction(stub, { kind: 'test_run', rootExecutionId: ROOT, actionKey: '' })).rejects.toThrow(/actionKey/)
  })

  test('§6.1 deriveTestRunScopedRoot: deterministic; every tuple component matters; never the raw caller value; bounded opaque token', () => {
    const base = { actorId: `u_${RUN}`, ruleId: `rule_${RUN}`, testRunOperationId: 'op-123_ABC' }
    const r1 = deriveTestRunScopedRoot(base)
    expect(deriveTestRunScopedRoot({ ...base })).toBe(r1) // deterministic → same claim on retry (dedup)
    expect(deriveTestRunScopedRoot({ ...base, actorId: `u2_${RUN}` })).not.toBe(r1) // actor scopes
    expect(deriveTestRunScopedRoot({ ...base, ruleId: `rule2_${RUN}` })).not.toBe(r1) // rule scopes
    expect(deriveTestRunScopedRoot({ ...base, testRunOperationId: 'op-124' })).not.toBe(r1) // opId scopes
    expect(r1).not.toBe(base.testRunOperationId) // the caller value NEVER becomes the root directly
    expect(r1).toMatch(/^trroot_[0-9a-f]{32}$/) // recognizable server-derived format
    // bounded opaque token: bad charset / overlength rejected
    expect(() => deriveTestRunScopedRoot({ ...base, testRunOperationId: 'has space' })).toThrow(/opaque token/)
    expect(() => deriveTestRunScopedRoot({ ...base, testRunOperationId: 'x'.repeat(129) })).toThrow(/opaque token/)
    expect(() => deriveTestRunScopedRoot({ ...base, testRunOperationId: '' })).toThrow(/opaque token/)
  })

  test('§6.1 end-to-end: a test_run claim under a derived root can never collide with an execution claim — and dedups on the same tuple', async () => {
    const key = deriveActionKey({ structuralPath: 's[3]', actionType: 'create_record', canonicalConfig: { t: RUN } })
    const derived = deriveTestRunScopedRoot({ actorId: `u_${RUN}`, ruleId: `rule_${RUN}`, testRunOperationId: 'click-1' })
    // even a real-execution claim under the SAME derived-root string is independent (kind disjointness)
    expect(await inTxn((t) => claimExecutionAction(t, { kind: 'execution', rootExecutionId: derived, actionKey: key }))).toBe('claimed')
    expect(await inTxn((t) => claimExecutionAction(t, { kind: 'test_run', rootExecutionId: derived, actionKey: key }))).toBe('claimed')
    // a second real_fire click with the SAME testRunOperationId derives the SAME root → dedup
    const derivedAgain = deriveTestRunScopedRoot({ actorId: `u_${RUN}`, ruleId: `rule_${RUN}`, testRunOperationId: 'click-1' })
    expect(await inTxn((t) => claimExecutionAction(t, { kind: 'test_run', rootExecutionId: derivedAgain, actionKey: key }))).toBe('duplicate')
  })

  test('coexists with the FWB ledger: one transaction claims in BOTH tables; rows land disjointly', async () => {
    const key = deriveActionKey({ structuralPath: 's[coexist]', actionType: 'create_record', canonicalConfig: { t: RUN } })
    await inTxn(async (t) => {
      expect(await claimExecutionAction(t, { kind: 'execution', rootExecutionId: ROOT, actionKey: key })).toBe('claimed')
      expect(await claimActionApplied(t, { id: `aa_${randomUUID()}`, instanceId: `apr_${RUN}`, ruleId: `rule_${RUN}`, actionKey: key })).toBe('claimed')
    })
    const exec = await q(`SELECT count(*)::int AS c FROM meta_automation_action_applied WHERE root_execution_id=$1 AND action_key=$2`, [ROOT, key])
    const fwb = await q(`SELECT count(*)::int AS c FROM meta_fwb_action_applied WHERE instance_id=$1 AND action_key=$2`, [`apr_${RUN}`, key])
    expect(Number(exec.rows[0].c)).toBe(1)
    expect(Number(fwb.rows[0].c)).toBe(1)
  })
})
