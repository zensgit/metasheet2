/**
 * Action-idempotency ledger L1 — meta_automation_action_applied schema golden (real DB).
 *
 * Proves the #4203 §2.3 business-claim contract at the DB layer:
 *   - the composite UNIQUE key (instance_id, rule_id, action_key, node_key, entry_epoch, application_mode)
 *     blocks a duplicate apply (the Class-A zombie-fencing collision) with the named index;
 *   - a SECOND rule / SECOND action on the same instance is NOT blocked (the exact bare-instance_id trap the
 *     lock ruled out);
 *   - FWB-3 node-scoping: same action, new entry_epoch (退回/跳转 re-entry) claims independently;
 *   - test_run isolation: a test_run claim never blocks a real apply (and vice versa);
 *   - non-blank CHECKs on instance/rule/action_key reject ''/whitespace by constraint name;
 *   - the same-transaction guarantee: claim + "record write" in one txn → ROLLBACK removes the claim.
 *
 * Two-point wired (plugin-tests.yml + vitest.config.ts exclude) so it cannot skip-green.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import {
  canonicalizeConfig,
  claimActionApplied,
  classifyOutboundOutcome,
  deriveActionKey,
  deriveOutboundIdempotencyKey,
} from '../../src/multitable/automation-action-idempotency'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const RUN = randomUUID()
const INST = `apr_${RUN}`

const claim = (over: Partial<Record<'id'|'instance'|'rule'|'action'|'node'|'mode', string>> & { epoch?: number } = {}) =>
  q(
    `INSERT INTO meta_automation_action_applied (id, instance_id, rule_id, action_key, node_key, entry_epoch, application_mode, result_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'rec_id_only')`,
    [
      over.id ?? `aa_${randomUUID()}`,
      over.instance ?? INST,
      over.rule ?? `rule_${RUN}_1`,
      over.action ?? `ak_${RUN}_1`,
      over.node ?? '',
      over.epoch ?? 0,
      over.mode ?? 'apply',
    ],
  )

describeIfDatabase('action-idempotency ledger L1 — schema golden (real DB)', () => {
  afterAll(async () => {
    await q('DELETE FROM meta_automation_action_applied WHERE instance_id = $1', [INST]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('duplicate apply of the SAME (instance, rule, action) collides on the named UNIQUE index', async () => {
    await claim()
    await expect(claim()).rejects.toThrow(/uq_action_applied_business_claim/)
  })

  test('a SECOND rule and a SECOND action on the same instance are NOT blocked (no bare-instance UNIQUE)', async () => {
    await expect(claim({ rule: `rule_${RUN}_2` })).resolves.toBeTruthy()
    await expect(claim({ action: `ak_${RUN}_2` })).resolves.toBeTruthy()
  })

  test('FWB-3 node scoping: same action re-entered with a NEW entry_epoch claims independently', async () => {
    await claim({ action: `ak_${RUN}_n`, node: 'node_A', epoch: 1 })
    await expect(claim({ action: `ak_${RUN}_n`, node: 'node_A', epoch: 1 })).rejects.toThrow(/uq_action_applied_business_claim/)
    await expect(claim({ action: `ak_${RUN}_n`, node: 'node_A', epoch: 2 })).resolves.toBeTruthy() // 退回→新 epoch
  })

  test('node_key/entry_epoch are PAIRED: only the empty-node sentinel or a real node with epoch>=1; mixed pairs rejected', async () => {
    // valid pairs
    await expect(claim({ action: `ak_${RUN}_p0`, node: '', epoch: 0 })).resolves.toBeTruthy() // non-node sentinel
    await expect(claim({ action: `ak_${RUN}_p1`, node: 'node_B', epoch: 1 })).resolves.toBeTruthy() // real FWB-3 scope
    // mixed pairs split one idempotency identity — rejected by the paired CHECK, named
    await expect(claim({ action: `ak_${RUN}_bad_a`, node: '', epoch: 7 })).rejects.toThrow(/action_applied_node_epoch_paired/)
    await expect(claim({ action: `ak_${RUN}_bad_b`, node: 'node_C', epoch: 0 })).rejects.toThrow(/action_applied_node_epoch_paired/)
  })

  test('test_run isolation: a test_run claim does not block (or get blocked by) a real apply', async () => {
    await claim({ action: `ak_${RUN}_t`, mode: 'test_run' })
    await expect(claim({ action: `ak_${RUN}_t`, mode: 'apply' })).resolves.toBeTruthy()
    await expect(claim({ action: `ak_${RUN}_t`, mode: 'test_run' })).rejects.toThrow(/uq_action_applied_business_claim/)
    await expect(claim({ action: `ak_${RUN}_bogusmode`, mode: 'bogus' })).rejects.toThrow(/action_applied_mode_valid/)
  })

  test('non-blank CHECKs reject blank identity parts by constraint name', async () => {
    await expect(claim({ action: '  ' })).rejects.toThrow(/action_applied_action_key_nonblank/)
    await expect(claim({ instance: '' })).rejects.toThrow(/action_applied_instance_nonblank/)
    await expect(claim({ rule: '\t' })).rejects.toThrow(/action_applied_rule_nonblank/)
  })

  test('same-transaction guarantee: the REAL claimActionApplied inside a rolled-back txn leaves NO ledger row', async () => {
    const raw = poolManager.get().getInternalPool()
    const c = await raw.connect()
    const action = `ak_${RUN}_txn`
    // exercise the REAL helper on the checked-out connection (not a hand-written INSERT) so the test proves
    // claimActionApplied's own write is bound to the caller's txn (#4340 review P3).
    const trx: Queryable = { query: (sql, params) => c.query(sql, params) }
    try {
      await c.query('BEGIN')
      const r = await claimActionApplied(trx, { id: `aa_${randomUUID()}`, instanceId: INST, ruleId: `rule_${RUN}_txn`, actionKey: action })
      expect(r).toBe('claimed') // the real helper claimed inside the txn...
      await c.query('ROLLBACK') // ...but the record write failed → the claim must vanish with it
    } finally {
      c.release()
    }
    const { rows } = await q('SELECT count(*)::int AS c FROM meta_automation_action_applied WHERE action_key=$1', [action])
    expect(Number(rows[0].c)).toBe(0)
  })

  // ---- L2: derivation + Class-A claim helper + Class-B semantics ----

  test('L2 deriveActionKey: deterministic triple identity — key-order insensitive, value-sensitive, fence-free', () => {
    const a = deriveActionKey({ structuralPath: 'steps[2].actions[0]', actionType: 'create_record', canonicalConfig: { b: 2, a: 1 } })
    const b = deriveActionKey({ structuralPath: 'steps[2].actions[0]', actionType: 'create_record', canonicalConfig: { a: 1, b: 2 } })
    expect(a).toBe(b) // property order does not change identity
    const c = deriveActionKey({ structuralPath: 'steps[2].actions[0]', actionType: 'create_record', canonicalConfig: { a: 1, b: 3 } })
    expect(c).not.toBe(a) // config change = new identity
    expect(canonicalizeConfig({ x: [2, 1] })).toBe('{"x":[2,1]}') // array order preserved (it is meaning)
    expect(() => deriveActionKey({ structuralPath: ' ', actionType: 'x', canonicalConfig: {} })).toThrow(/non-blank/)
    // INJECTIVE encoding (#4340 review P2): a delimiter inside a component must not merge two distinct
    // identities. Under a bare `#` join, ("a","b#c") and ("a#b","c") would both be "a#b#c#…" — they must differ.
    expect(deriveActionKey({ structuralPath: 'a', actionType: 'b#c', canonicalConfig: {} })).not.toBe(
      deriveActionKey({ structuralPath: 'a#b', actionType: 'c', canonicalConfig: {} }),
    )
  })

  test('L2 claimActionApplied: first=claimed, repeat=duplicate; CONCURRENT double-claim → exactly one claimed', async () => {
    const key = deriveActionKey({ structuralPath: 's[0]', actionType: 'create_record', canonicalConfig: { t: RUN } })
    const base = { instanceId: INST, ruleId: `rule_${RUN}_l2`, actionKey: key }
    expect(await claimActionApplied(poolManager.get(), { ...base, id: `aa_${randomUUID()}` })).toBe('claimed')
    expect(await claimActionApplied(poolManager.get(), { ...base, id: `aa_${randomUUID()}` })).toBe('duplicate')
    // constructed race on a FRESH key: two connections claim simultaneously
    const key2 = deriveActionKey({ structuralPath: 's[1]', actionType: 'create_record', canonicalConfig: { t: RUN } })
    const raw = poolManager.get().getInternalPool()
    const [ca, cb] = await Promise.all([raw.connect(), raw.connect()])
    try {
      const [ra, rb] = await Promise.all([
        claimActionApplied(ca, { ...base, actionKey: key2, id: `aa_${randomUUID()}` }),
        claimActionApplied(cb, { ...base, actionKey: key2, id: `aa_${randomUUID()}` }),
      ])
      expect([ra, rb].filter((r) => r === 'claimed')).toHaveLength(1) // net-once under the race
      expect([ra, rb].filter((r) => r === 'duplicate')).toHaveLength(1)
    } finally {
      ca.release()
      cb.release()
    }
  })

  test('L2 Class-B: outbound key = stable event+action identity; ambiguity w/o endpoint idempotency = outcome_unknown', () => {
    const k1 = deriveOutboundIdempotencyKey('evt_1', 'ak_1')
    expect(k1).toBe('["evt_1","ak_1"]') // injective JSON-array encoding — no fence, no attempt
    // a component containing the old `::` delimiter must not collide (#4340 review P2)
    expect(deriveOutboundIdempotencyKey('a', 'b::c')).not.toBe(deriveOutboundIdempotencyKey('a::b', 'c'))
    expect(classifyOutboundOutcome('delivered', false)).toBe('success')
    expect(classifyOutboundOutcome('rejected', true)).toBe('permanent_failure')
    expect(classifyOutboundOutcome('ambiguous', true)).toBe('retryable_failure') // endpoint dedups → safe retry
    expect(classifyOutboundOutcome('ambiguous', false)).toBe('outcome_unknown') // recorded, NEVER auto-resent
  })
})
