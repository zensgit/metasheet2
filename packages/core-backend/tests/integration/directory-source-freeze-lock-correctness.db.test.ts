import { randomUUID } from 'crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// T2 lock-correctness (owner order step 3) — canonical UUID lock key + explicit READ COMMITTED.
//
// [P1] The manual sync route passes RAW `req.params.integrationId` (admin-directory.ts) into
// `syncDirectoryIntegration`. `directory_integrations.id` is a uuid COLUMN, so an uppercase
// id still resolves the same row via uuid casting — but the shared source freeze advisory
// lock hashes the RAW TEXT key (`hashtext('directory:source-sync-freeze:' || id)`), so an
// uppercase caller hashed a DIFFERENT lock key than the transfer side's DB-canonical
// `source.id` ⇒ sync and transfer lost mutual exclusion ⇒ a freeze committing after the
// entry check could race sync's local apply. Fix: canonicalize to the DB-read-back
// `integration.id` immediately after `getIntegrationRow` and use it for everything downstream.
//
// [P2] All generic pool transactions run a bare BEGIN (connection-pool.ts `transaction()`).
// On a deployment where `default_transaction_isolation = 'repeatable read'`, the transaction
// snapshot is taken by the `pg_advisory_xact_lock` SELECT itself — BEFORE the lock is granted
// — so the post-lock freeze recheck reads a pre-freeze snapshot and misses a freeze that
// committed while the sync waited on the lock. Fix (PB4-3 idiom, local-directory-org.ts):
// `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` as the first statement of the sync
// local-apply transaction and of both transfer-side freeze-taking transactions.
//
// HARNESS: this file runs the ENTIRE service pool with the RR default (the P2 deployment
// posture) by amending DATABASE_URL with `options=-c default_transaction_isolation=
// repeatable\ read` inside vi.hoisted — which executes BEFORE the static imports below, i.e.
// before the PoolManager (constructed at first import of the db module) reads DATABASE_URL.
// vitest.integration.config.ts runs files in isolated forks with fileParallelism:false, so
// the RR default cannot leak into any other suite. A sentinel test asserts the posture is
// actually active (a silently-RC harness would make the pin tests vacuous).
//
// Mutation proofs (each independently reds this suite; exact signatures in PR body):
//   (i) revert the P1 canonicalization (pass the raw route id to the freeze-lock/apply path)
//       → the uppercase-caller test's waitUntilBlockedOnHolder times out (the sync never
//       parks on the canonical key) and the absence sweep commits against a frozen source;
//   (ii) drop the `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` line from the sync
//       local-apply transaction → the RR-barrier test's post-lock recheck misses the freeze
//       committed while waiting: sync completes and sweeps the seeded account.
//
// DATABASE_URL-gated (describeIfDatabase): excluded from the no-DB vitest job so it cannot
// skip-green, and wired as a WHOLE FILE into the directory real-DB step in plugin-tests.yml
// (both points asserted by t2-source-freeze-ci-wiring.test.mjs).
vi.hoisted(() => {
  const base = process.env.DATABASE_URL
  if (base) {
    const sep = base.includes('?') ? '&' : '?'
    // libpq `options`: spaces separate arguments unless backslash-escaped, hence the
    // escaped space inside `repeatable\ read`.
    process.env.DATABASE_URL = `${base}${sep}options=${encodeURIComponent(
      '-c default_transaction_isolation=repeatable\\ read',
    )}`
  }
})

const clientMocks = vi.hoisted(() => ({
  fetchDingTalkAppAccessToken: vi.fn(),
  listDingTalkDepartments: vi.fn(),
  getDingTalkDepartmentDetail: vi.fn(),
  listDingTalkDepartmentUsers: vi.fn(),
  getDingTalkUserDetail: vi.fn(),
}))

vi.mock('../../src/integrations/dingtalk/client', () => ({
  fetchDingTalkAppAccessToken: clientMocks.fetchDingTalkAppAccessToken,
  listDingTalkDepartments: clientMocks.listDingTalkDepartments,
  getDingTalkDepartmentDetail: clientMocks.getDingTalkDepartmentDetail,
  listDingTalkDepartmentUsers: clientMocks.listDingTalkDepartmentUsers,
  getDingTalkUserDetail: clientMocks.getDingTalkUserDetail,
}))

import { query, transaction } from '../../src/db/pg'
import {
  createDirectoryIntegration,
  DirectorySyncFrozenByTransferError,
  syncDirectoryIntegration,
} from '../../src/directory/directory-sync'
import { createOrgTransfer } from '../../src/directory/org-transfer-service'
import { sourceSyncFreezeLockKey } from '../../src/directory/source-sync-freeze-lock'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()

/** Dedicated raw connection for barrier lock-holders — never from the service pool. */
async function withHolder(fn: (holder: Client, holderPid: number) => Promise<void>): Promise<void> {
  const holder = new Client({ connectionString: process.env.DATABASE_URL })
  await holder.connect()
  try {
    const pidRow = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    await fn(holder, pidRow.rows[0].pid)
  } finally {
    try {
      await holder.query('ROLLBACK')
    } catch {
      /* already closed / idle */
    }
    await holder.end()
  }
}

/**
 * Deterministic barrier: poll until at least one backend is blocked by the holder's pid
 * (pg_blocking_pids). Proves the waiter is parked on the holder's lock — not a fixed sleep.
 */
async function waitUntilBlockedOnHolder(holderPid: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE state = 'active'
          AND wait_event_type = 'Lock'
          AND $1 = ANY(pg_blocking_pids(pid))`,
      [holderPid],
    )
    if ((r.rows[0]?.n ?? 0) >= 1) return
    await new Promise((res) => setTimeout(res, 20))
  }
  throw new Error(
    `timed out waiting for a backend blocked by holder pid ${holderPid} (source freeze lock never engaged)`,
  )
}

/**
 * SAME-KEY proof: while blocked, the waiter's ungranted advisory lock must carry the exact
 * (classid, objid, objsubid) tuple of an advisory lock the holder has granted. This is the
 * direct pg_locks witness that both sides contend on ONE advisory key.
 */
async function countWaitersOnHolderAdvisoryKey(holderPid: number): Promise<number> {
  const r = await query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM pg_locks waiter
       JOIN pg_locks held
         ON held.locktype = 'advisory'
        AND held.granted
        AND held.pid = $1
        AND waiter.locktype = 'advisory'
        AND NOT waiter.granted
        AND waiter.classid = held.classid
        AND waiter.objid = held.objid
        AND waiter.objsubid = held.objsubid`,
    [holderPid],
  )
  return r.rows[0]?.n ?? 0
}

function settled<T>(p: Promise<T>): Promise<T | unknown> {
  return p.then(
    (v) => v,
    (e) => e,
  )
}

describeIfDatabase('T2 lock-correctness — canonical UUID lock key + READ COMMITTED pin (RR-default pool harness)', () => {
  const cleanupTransferIds: string[] = []
  const cleanupIntegrationIds: string[] = []

  beforeAll(() => {
    clientMocks.fetchDingTalkAppAccessToken.mockResolvedValue('t2-lkc-token')
    // EMPTY tenant: every sync that is allowed to apply absence-sweeps everything — the
    // destructive write whose (non-)occurrence is this suite's observable.
    clientMocks.listDingTalkDepartments.mockResolvedValue([])
    clientMocks.getDingTalkDepartmentDetail.mockResolvedValue({ deptManagerUserIdList: [] })
    clientMocks.listDingTalkDepartmentUsers.mockResolvedValue({ users: [], nextCursor: null, hasMore: false })
    clientMocks.getDingTalkUserDetail.mockRejectedValue(new Error('empty tenant — no user details expected'))
  })

  afterAll(async () => {
    for (const id of cleanupTransferIds.splice(0)) await query(`DELETE FROM provider_org_transfers WHERE id = $1`, [id])
    // integration delete cascades its departments/accounts/runs
    for (const id of cleanupIntegrationIds.splice(0)) await query(`DELETE FROM directory_integrations WHERE id = $1`, [id])
  })

  async function seedIntegrationWithLiveAccount(tag: string): Promise<{ integrationId: string; accountId: string }> {
    const integration = await createDirectoryIntegration({
      name: `t2-lkc-${tag}-${TS}`,
      corpId: `t2-lkc-corp-${tag}-${TS}`,
      appKey: `t2-lkc-appkey-${tag}-${TS}`,
      appSecret: 't2-lkc-secret',
      admissionMode: 'manual_only',
    })
    cleanupIntegrationIds.push(integration.id)
    // A previously-synced account: present in the DB, ABSENT from the (empty) mocked tenant —
    // precisely what an allowed sync's absence sweep would mark inactive.
    const account = await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, provider, external_user_id, external_key, name, is_active, raw)
       VALUES ($1, 'dingtalk', $2, $3, $4, true, '{}'::jsonb) RETURNING id`,
      [integration.id, `t2-lkc-${tag}-user-${TS}`, `dingtalk:t2-lkc-${tag}-user-${TS}`, `T2 LKC ${tag}`],
    )
    return { integrationId: integration.id, accountId: account.rows[0].id }
  }

  async function createTransferRow(sourceId: string, targetId: string, freeze: boolean): Promise<string> {
    const row = await query<{ id: string }>(
      `INSERT INTO provider_org_transfers (org_id, provider, source_integration_id, target_integration_id, status, freeze_source_sync)
       SELECT org_id, provider, $1, $2, 'draft', $3 FROM directory_integrations WHERE id = $1
       RETURNING id`,
      [sourceId, targetId, freeze],
    )
    const id = row.rows[0].id
    cleanupTransferIds.push(id)
    return id
  }

  async function accountActive(accountId: string): Promise<boolean> {
    const row = await query<{ is_active: boolean }>(`SELECT is_active FROM directory_accounts WHERE id = $1`, [accountId])
    return row.rows[0].is_active
  }

  async function completedRunCount(integrationId: string): Promise<number> {
    const row = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM directory_sync_runs WHERE integration_id = $1 AND status = 'completed'`,
      [integrationId],
    )
    return Number(row.rows[0].n)
  }

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('sentinel: the service pool REALLY runs repeatable-read default — a bare-BEGIN generic transaction is RR', async () => {
    // Positive control for the whole harness: if the options plumbing ever silently broke,
    // the pin tests below would be vacuously green under an RC default. This reds instead.
    const def = await query<{ iso: string }>(`SELECT current_setting('default_transaction_isolation') AS iso`)
    expect(def.rows[0].iso).toBe('repeatable read')
    const inTxn = await transaction(async (client) => {
      const r = (await client.query(`SELECT current_setting('transaction_isolation') AS iso`)) as {
        rows: Array<{ iso: string }>
      }
      return r.rows[0].iso
    })
    expect(inTxn).toBe('repeatable read')
  })

  it('unit guard (P1 key contract): fix-path canonicalization maps an uppercase route id onto the SAME lock key as the DB-canonical id', async () => {
    // Deterministic case-variant id: force hex letters into the first group, keep the rest random.
    const canonical = `facade00-${randomUUID().slice(9)}`.toLowerCase()
    const upper = canonical.toUpperCase()
    expect(upper).not.toBe(canonical)
    await query(
      `INSERT INTO directory_integrations (id, name, corp_id, config) VALUES ($1::uuid, $2, $3, '{}'::jsonb)`,
      [canonical, `t2-lkc-keyguard-${TS}`, `t2-lkc-keyguard-corp-${TS}`],
    )
    cleanupIntegrationIds.push(canonical)

    // The very read-back shape getIntegrationRow uses (WHERE id = $1 on the uuid column):
    // an uppercase text param resolves the row and reads back the canonical lowercase id.
    const readBack = await query<{ id: string }>(
      `SELECT id FROM directory_integrations WHERE id = $1 AND provider = $2`,
      [upper, 'dingtalk'],
    )
    expect(readBack.rows[0]?.id).toBe(canonical)

    // key(raw uppercase) after fix-path canonicalization === key(canonical lowercase).
    expect(sourceSyncFreezeLockKey(readBack.rows[0].id)).toBe(sourceSyncFreezeLockKey(canonical))
    // Why canonicalization is load-bearing: the raw uppercase key is a DIFFERENT string…
    expect(sourceSyncFreezeLockKey(upper)).not.toBe(sourceSyncFreezeLockKey(canonical))
    // …and hashes a DIFFERENT advisory-lock key at the PostgreSQL level (the P1 mechanism).
    const hashes = await query<{ same: boolean }>(`SELECT hashtext($1) = hashtext($2) AS same`, [
      sourceSyncFreezeLockKey(upper),
      sourceSyncFreezeLockKey(canonical),
    ])
    expect(hashes.rows[0].same).toBe(false)
  })

  it('P1 RACE: an UPPERCASE manual-sync id parks on the canonical transfer freeze key (same pg_locks tuple) and rolls back after the freeze commits', async () => {
    const source = await seedIntegrationWithLiveAccount('p1-up-src')
    const target = await seedIntegrationWithLiveAccount('p1-up-dst')
    const upper = source.integrationId.toUpperCase()
    // Loud precondition (gen_random_uuid contains hex letters with overwhelming probability;
    // fail loudly rather than pass vacuously in the astronomically unlikely all-digit case).
    expect(upper).not.toBe(source.integrationId)

    let transferId = ''
    await withHolder(async (holder, holderPid) => {
      // SQL STAND-IN for createOrgTransfer mid-flight, exactly as production now runs it:
      // pinned READ COMMITTED + canonical-key advisory lock + freeze-active INSERT, held open.
      await holder.query('BEGIN')
      await holder.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        sourceSyncFreezeLockKey(source.integrationId),
      ])
      const ins = await holder.query<{ id: string }>(
        `INSERT INTO provider_org_transfers
           (org_id, provider, source_integration_id, target_integration_id, status, freeze_source_sync)
         SELECT org_id, provider, $1, $2, 'draft', true
           FROM directory_integrations WHERE id = $1
         RETURNING id`,
        [source.integrationId, target.integrationId],
      )
      transferId = ins.rows[0].id
      cleanupTransferIds.push(transferId)

      // REAL sync through the fixed path, with the route-shaped RAW uppercase id. Entry check
      // sees no committed freeze; mutual exclusion is entirely on the apply-txn lock key.
      const syncOutcome = settled(syncDirectoryIntegration(upper, `t2-lkc-admin-${TS}`))

      // Pre-fix RED signature (and mutation (i)'s): the uppercase caller hashes its own key,
      // never parks on the holder, and this barrier TIMES OUT while the sweep commits.
      await waitUntilBlockedOnHolder(holderPid)
      // SAME-KEY witness: the parked waiter's ungranted advisory tuple equals the holder's.
      expect(await countWaitersOnHolderAdvisoryKey(holderPid)).toBeGreaterThanOrEqual(1)

      await holder.query('COMMIT')

      const outcome = await syncOutcome
      expect(outcome).toBeInstanceOf(DirectorySyncFrozenByTransferError)
      expect((outcome as DirectorySyncFrozenByTransferError).transferId).toBe(transferId)
    })

    // The freeze linearized first ⇒ no local directory mutation may commit.
    expect(await accountActive(source.accountId)).toBe(true)
    expect(await completedRunCount(source.integrationId)).toBe(0)
  })

  it('P2 RACE (RR-default barrier): a freeze committed WHILE the apply waits on the lock is seen by the post-lock recheck', async () => {
    const source = await seedIntegrationWithLiveAccount('p2-rr-src')
    const target = await seedIntegrationWithLiveAccount('p2-rr-dst')
    // Active but UNFROZEN transfer: the entry check passes; only the under-lock recheck can
    // catch the refreeze that commits while the apply is parked on the advisory lock.
    const transferId = await createTransferRow(source.integrationId, target.integrationId, false)

    await withHolder(async (holder, holderPid) => {
      // Refreeze-writer stand-in mid-flight: canonical key held, freeze=true NOT yet committed.
      await holder.query('BEGIN')
      await holder.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        sourceSyncFreezeLockKey(source.integrationId),
      ])
      await holder.query(
        `UPDATE provider_org_transfers SET freeze_source_sync = true, updated_at = now() WHERE id = $1`,
        [transferId],
      )

      // Constructed interleaving on an RR-default pool: (1) sync apply txn opens and issues its
      // first statements — without the RC pin, the advisory-lock SELECT itself would fix the
      // transaction snapshot NOW, pre-freeze; (2) it parks on the held lock; (3) holder commits
      // the freeze; (4) sync acquires the lock and re-checks.
      const syncOutcome = settled(syncDirectoryIntegration(source.integrationId, `t2-lkc-admin-${TS}`))
      await waitUntilBlockedOnHolder(holderPid)

      await holder.query('COMMIT')

      // With the pin, the recheck's fresh per-statement snapshot sees the freeze. Without it
      // (mutation (ii)) the recheck reads the pre-freeze RR snapshot: the sync COMPLETES and
      // sweeps the seeded account — that is the mutation's red signature.
      const outcome = await syncOutcome
      expect(outcome).toBeInstanceOf(DirectorySyncFrozenByTransferError)
      expect((outcome as DirectorySyncFrozenByTransferError).transferId).toBe(transferId)
    })

    expect(await accountActive(source.accountId)).toBe(true)
    expect(await completedRunCount(source.integrationId)).toBe(0)
    const flag = await query<{ freeze_source_sync: boolean }>(
      `SELECT freeze_source_sync FROM provider_org_transfers WHERE id = $1`,
      [transferId],
    )
    expect(flag.rows[0].freeze_source_sync).toBe(true)
  })

  it('P2 posture: the REAL createOrgTransfer (pinned RC) still parks on the shared key and activates the freeze under an RR-default pool', async () => {
    const source = await seedIntegrationWithLiveAccount('p2-create-src')
    const target = await seedIntegrationWithLiveAccount('p2-create-dst')

    await withHolder(async (holder, holderPid) => {
      // Sync-apply stand-in holding the canonical key (no freeze yet).
      await holder.query('BEGIN')
      await holder.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        sourceSyncFreezeLockKey(source.integrationId),
      ])

      const createOutcome = settled(
        createOrgTransfer({
          provider: 'dingtalk',
          sourceIntegrationId: source.integrationId,
          targetIntegrationId: target.integrationId,
          createdBy: `t2-lkc-admin-${TS}`,
        }),
      )
      await waitUntilBlockedOnHolder(holderPid)

      await holder.query('COMMIT')

      const created = await createOutcome
      expect(created).not.toBeInstanceOf(Error)
      const summary = created as Awaited<ReturnType<typeof createOrgTransfer>>
      cleanupTransferIds.push(summary.id)
      expect(summary.freezeSourceSync).toBe(true)
      expect(summary.sourceIntegrationId).toBe(source.integrationId)
    })

    // And the activated freeze governs a subsequent canonical-id sync.
    await expect(syncDirectoryIntegration(source.integrationId, `t2-lkc-admin-${TS}`)).rejects.toBeInstanceOf(
      DirectorySyncFrozenByTransferError,
    )
    expect(await accountActive(source.accountId)).toBe(true)
  })
})
