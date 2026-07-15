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

  test('same-transaction guarantee: claim inside a rolled-back txn leaves NO ledger row', async () => {
    const raw = poolManager.get().getInternalPool()
    const c = await raw.connect()
    const action = `ak_${RUN}_txn`
    try {
      await c.query('BEGIN')
      await c.query(
        `INSERT INTO meta_automation_action_applied (id, instance_id, rule_id, action_key) VALUES ($1,$2,$3,$4)`,
        [`aa_${randomUUID()}`, INST, `rule_${RUN}_txn`, action],
      )
      await c.query('ROLLBACK') // the record write failed → claim must vanish with it
    } finally {
      c.release()
    }
    const { rows } = await q('SELECT count(*)::int AS c FROM meta_automation_action_applied WHERE action_key=$1', [action])
    expect(Number(rows[0].c)).toBe(0)
  })
})
