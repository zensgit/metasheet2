import { randomUUID } from 'crypto'
import express from 'express'
import { Client } from 'pg'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// Transfer MVP — T2 (§12.2 source freeze), real DB + the REAL syncDirectoryIntegration with a
// mocked DingTalk client (the R1-L4 orchestration-harness pattern): nothing between this suite
// and the sync orchestration except the network client. The mocked tenant is EMPTY, so any sync
// that is allowed to run performs the destructive absence sweep — which is exactly the write the
// freeze exists to stop. That makes the positive control honest: with the freeze bypassed via the
// supported platform-admin PATCH .../source-sync-freeze API (freezeSourceSync=false), the very
// same sync deactivates the seeded account, proving test A's frozen sync was blocked from a REAL
// destructive outcome, not from a no-op. The override path also proves one values-free audit row.
//
// Also hosts the composed T1+T2 proof: an unavailable-adapter scan failure must leave the
// transfer non-terminal and the source freeze intact (no sync run, no absence sweep). And the
// freeze-API contract surface (auth, allowlist, terminal/missing, refreeze, no audit on reject).
//
// P1 race closeout: two-connection barrier tests for create-vs-sync-apply and refreeze-vs-
// sync-apply in both linearizations. A shared `pg_advisory_xact_lock` keyed by source
// integration serializes freeze writers with the sync local-apply transaction; apply re-checks
// active freeze under that lock before ANY local directory mutation. Barriers use
// pg_blocking_pids / pg_stat_activity (no fixed race sleeps).
//
// Mutation proofs (independently red the race suite):
//   - remove acquireSourceSyncFreezeLock from sync apply / create / refreeze → waiter never
//     parks on the holder's advisory lock → waitUntilBlockedOnHolder times out
//   - remove the apply-time assertDirectorySyncNotFrozenByTransfer recheck → freeze-wins
//     races commit the absence sweep and deactivate the seeded live account
//
// B1 (audit follow-up, deliberate freeze ≠ integration failure) mutation proofs:
//   - revert the discrimination in the sync catch (route DirectorySyncFrozenByTransferError
//     back through markSyncFailure) → the create-wins race's abort assertions go red
//   - suppress markSyncFailure for ALL errors → the genuine-failure positive control goes red
//
// DATABASE_URL-gated (describeIfDatabase): excluded from the no-DB vitest job so it cannot
// skip-green, and wired as a WHOLE FILE into the approval real-DB step in plugin-tests.yml
// (both points asserted by t2-source-freeze-ci-wiring.test.mjs).
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

import { query } from '../../src/db/pg'
import { countConsecutiveFailedRuns } from '../../src/directory/directory-sync-alert-delivery'
import {
  createDirectoryIntegration,
  DirectorySyncFrozenByTransferError,
  syncDirectoryIntegration,
} from '../../src/directory/directory-sync'
import {
  createOrgTransfer,
  setOrgTransferSourceSyncFreeze,
  unregisterOrgTransferAdapter,
} from '../../src/directory/org-transfer-service'
import { sourceSyncFreezeLockKey } from '../../src/directory/source-sync-freeze-lock'
import { adminDirectoryRouter } from '../../src/routes/admin-directory'
import { adminDirectoryOrgTransfersRouter } from '../../src/routes/admin-directory-org-transfers'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()

const FREEZE_ADMIN_ID = `t2-freeze-admin-${TS}`

const adminApp = express()
adminApp.use(express.json())
adminApp.use((req, _res, next) => {
  ;(req as express.Request & { user?: unknown }).user = { id: FREEZE_ADMIN_ID, role: 'admin' }
  next()
})
adminApp.use('/api/admin/directory', adminDirectoryRouter())
adminApp.use('/api/admin/directory/org-transfers', adminDirectoryOrgTransfersRouter())

const nonAdminApp = express()
nonAdminApp.use(express.json())
nonAdminApp.use((req, _res, next) => {
  ;(req as express.Request & { user?: unknown }).user = { id: `t2-freeze-nonadmin-${TS}` }
  next()
})
nonAdminApp.use('/api/admin/directory/org-transfers', adminDirectoryOrgTransfersRouter())

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

function settled<T>(p: Promise<T>): Promise<T | unknown> {
  return p.then(
    (v) => v,
    (e) => e,
  )
}

describeIfDatabase('Transfer MVP T2 — §12.2 source freeze during an active org transfer (real sync, mocked pull)', () => {
  const cleanupTransferIds: string[] = []
  const cleanupIntegrationIds: string[] = []

  beforeAll(() => {
    clientMocks.fetchDingTalkAppAccessToken.mockResolvedValue('t2-frz-token')
    // EMPTY tenant: every sync that runs walks nothing and absence-sweeps everything.
    clientMocks.listDingTalkDepartments.mockResolvedValue([])
    clientMocks.getDingTalkDepartmentDetail.mockResolvedValue({ deptManagerUserIdList: [] })
    clientMocks.listDingTalkDepartmentUsers.mockResolvedValue({ users: [], nextCursor: null, hasMore: false })
    clientMocks.getDingTalkUserDetail.mockRejectedValue(new Error('empty tenant — no user details expected'))
  })

  afterEach(() => {
    // Composed T1+T2 case must not leave a leaked adapter registration for other suites.
    unregisterOrgTransferAdapter('dingtalk')
  })

  afterAll(async () => {
    unregisterOrgTransferAdapter('dingtalk')
    for (const id of cleanupTransferIds.splice(0)) await query(`DELETE FROM provider_org_transfers WHERE id = $1`, [id])
    // integration delete cascades its departments/accounts/runs
    for (const id of cleanupIntegrationIds.splice(0)) await query(`DELETE FROM directory_integrations WHERE id = $1`, [id])
  })

  async function freezeAuditCount(transferId: string): Promise<number> {
    const result = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_logs
        WHERE action = 'directory.org_transfer.source_sync_freeze' AND resource_id = $1`,
      [transferId]
    )
    return Number(result.rows[0].n)
  }

  async function orgTransferFreezeAuditTotal(): Promise<number> {
    const result = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_logs WHERE action = 'directory.org_transfer.source_sync_freeze'`
    )
    return Number(result.rows[0].n)
  }

  async function seedIntegrationWithLiveAccount(tag: string): Promise<{ integrationId: string; accountId: string }> {
    const integration = await createDirectoryIntegration({
      name: `t2-frz-${tag}-${TS}`,
      corpId: `t2-frz-corp-${tag}-${TS}`,
      appKey: `t2-frz-appkey-${tag}-${TS}`,
      appSecret: 't2-frz-secret',
      admissionMode: 'manual_only',
    })
    cleanupIntegrationIds.push(integration.id)
    // A previously-synced account: present in the DB, ABSENT from the (empty) mocked tenant —
    // precisely what an allowed sync's absence sweep would mark inactive.
    const account = await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, provider, external_user_id, external_key, name, is_active, raw)
       VALUES ($1, 'dingtalk', $2, $3, $4, true, '{}'::jsonb) RETURNING id`,
      [integration.id, `t2-frz-${tag}-user-${TS}`, `dingtalk:t2-frz-${tag}-user-${TS}`, `T2 Freeze ${tag}`]
    )
    return { integrationId: integration.id, accountId: account.rows[0].id }
  }

  async function createTransferRow(sourceId: string, targetId: string, status = 'draft'): Promise<string> {
    const row = await query<{ id: string }>(
      `INSERT INTO provider_org_transfers (org_id, provider, source_integration_id, target_integration_id, status)
       SELECT org_id, provider, $1, $2, $3 FROM directory_integrations WHERE id = $1
       RETURNING id`,
      [sourceId, targetId, status]
    )
    const id = row.rows[0].id
    cleanupTransferIds.push(id)
    return id
  }

  async function accountActive(accountId: string): Promise<boolean> {
    const row = await query<{ is_active: boolean }>(`SELECT is_active FROM directory_accounts WHERE id = $1`, [accountId])
    return row.rows[0].is_active
  }

  async function runCount(integrationId: string): Promise<number> {
    const row = await query<{ n: string }>(`SELECT count(*)::text AS n FROM directory_sync_runs WHERE integration_id = $1`, [
      integrationId,
    ])
    return Number(row.rows[0].n)
  }

  type AbortRunRow = {
    id: string
    status: string
    finished_at: string | null
    error_message: string | null
    meta: { abortReason?: string; transferId?: string } | null
  }

  /** All run rows for ONE fixture integration (shared dev DB — never scan the table). */
  async function runRows(integrationId: string): Promise<AbortRunRow[]> {
    const rows = await query<AbortRunRow>(
      `SELECT id, status, finished_at, error_message, meta
         FROM directory_sync_runs WHERE integration_id = $1 ORDER BY started_at ASC`,
      [integrationId],
    )
    return rows.rows
  }

  async function integrationLastError(integrationId: string): Promise<string | null> {
    const row = await query<{ last_error: string | null }>(
      `SELECT last_error FROM directory_integrations WHERE id = $1`,
      [integrationId],
    )
    return row.rows[0]?.last_error ?? null
  }

  async function syncFailedAlertCount(integrationId: string): Promise<number> {
    const row = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM directory_sync_alerts
        WHERE integration_id = $1 AND code = 'sync_failed'`,
      [integrationId],
    )
    return Number(row.rows[0].n)
  }

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('A. HEADLINE: an active transfer freezes the source — typed 409 error, NO run row, the absence sweep never fires', async () => {
    const source = await seedIntegrationWithLiveAccount('a-src')
    const target = await seedIntegrationWithLiveAccount('a-dst')
    const transferId = await createTransferRow(source.integrationId, target.integrationId)

    let caught: unknown = null
    try {
      await syncDirectoryIntegration(source.integrationId, `t2-admin-${TS}`)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DirectorySyncFrozenByTransferError)
    expect((caught as DirectorySyncFrozenByTransferError).transferId).toBe(transferId)
    expect((caught as DirectorySyncFrozenByTransferError).statusCode).toBe(409)

    // Frozen BEFORE the lease claim: no run row exists at all — nothing dangling to reclaim.
    expect(await runCount(source.integrationId)).toBe(0)
    // And the destructive outcome never happened: the account the empty pull would sweep is live.
    expect(await accountActive(source.accountId)).toBe(true)
  })

  it('B. admin override via PATCH source-sync-freeze=false: SAME sync runs, absence sweep is destructive, one freeze audit', async () => {
    const source = await seedIntegrationWithLiveAccount('b-src')
    const target = await seedIntegrationWithLiveAccount('b-dst')
    const transferId = await createTransferRow(source.integrationId, target.integrationId)

    const unfreeze = await request(adminApp)
      .patch(`/api/admin/directory/org-transfers/${transferId}/source-sync-freeze`)
      .send({ freezeSourceSync: false })
    expect(unfreeze.status).toBe(200)
    expect(unfreeze.body.data.transfer.freezeSourceSync).toBe(false)
    expect(await freezeAuditCount(transferId)).toBe(1)

    const result = await syncDirectoryIntegration(source.integrationId, `t2-admin-${TS}`)
    expect(result.run.status).toBe('completed')
    // The empty tenant swept the seeded account inactive — the very write test A blocked.
    expect(await accountActive(source.accountId)).toBe(false)
  })

  it('C. a TERMINAL transfer does not freeze: cancelled → sync proceeds', async () => {
    const source = await seedIntegrationWithLiveAccount('c-src')
    const target = await seedIntegrationWithLiveAccount('c-dst')
    await createTransferRow(source.integrationId, target.integrationId, 'cancelled')

    const result = await syncDirectoryIntegration(source.integrationId, `t2-admin-${TS}`)
    expect(result.run.status).toBe('completed')
  })

  it('D. only the SOURCE is frozen: the target integration syncs while the transfer is active', async () => {
    const source = await seedIntegrationWithLiveAccount('d-src')
    const target = await seedIntegrationWithLiveAccount('d-dst')
    await createTransferRow(source.integrationId, target.integrationId)

    const result = await syncDirectoryIntegration(target.integrationId, `t2-admin-${TS}`)
    expect(result.run.status).toBe('completed')
    // and the source remains frozen (typed error, run-free)
    await expect(syncDirectoryIntegration(source.integrationId, `t2-admin-${TS}`)).rejects.toBeInstanceOf(
      DirectorySyncFrozenByTransferError
    )
    expect(await runCount(source.integrationId)).toBe(0)
  })

  it('E. route mapping: manual sync trigger answers 409 DIRECTORY_SYNC_FROZEN_BY_TRANSFER with the transferId', async () => {
    const source = await seedIntegrationWithLiveAccount('e-src')
    const target = await seedIntegrationWithLiveAccount('e-dst')
    const transferId = await createTransferRow(source.integrationId, target.integrationId)

    const res = await request(adminApp).post(`/api/admin/directory/integrations/${source.integrationId}/sync`).send({})
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('DIRECTORY_SYNC_FROZEN_BY_TRANSFER')
    expect(res.body.error.details?.transferId ?? res.body.error.transferId).toBe(transferId)

    // async opt-in branch maps identically
    const asyncRes = await request(adminApp)
      .post(`/api/admin/directory/integrations/${source.integrationId}/sync`)
      .send({ async: true })
    expect(asyncRes.status).toBe(409)
    expect(asyncRes.body.error.code).toBe('DIRECTORY_SYNC_FROZEN_BY_TRANSFER')
    expect(asyncRes.body.error.details?.transferId ?? asyncRes.body.error.transferId).toBe(transferId)
  })

  it('F. preview stays available during a freeze (the read-only evidence tool writes nothing)', async () => {
    const source = await seedIntegrationWithLiveAccount('f-src')
    const target = await seedIntegrationWithLiveAccount('f-dst')
    await createTransferRow(source.integrationId, target.integrationId)

    const res = await request(adminApp).post(`/api/admin/directory/integrations/${source.integrationId}/sync/preview`).send({})
    expect(res.status).toBe(200)
    // preview reported the would-be sweep without performing it
    expect(await accountActive(source.accountId)).toBe(true)
    expect(await runCount(source.integrationId)).toBe(0)
  })

  it('does not confuse an unrelated integration id with a frozen one (freeze is source-scoped by id)', async () => {
    const bystander = await seedIntegrationWithLiveAccount('bystander')
    // No transfer references it at all — a sweep of the OTHER fixtures' transfers must not leak.
    const result = await syncDirectoryIntegration(bystander.integrationId, `t2-admin-${TS}`)
    expect(result.run.status).toBe('completed')
  })

  it('composed T1+T2: unavailable-adapter scan leaves source frozen — no sync run, absence sweep never executes', async () => {
    // Deliberately NO adapter registration: production default for unregistered providers.
    // After the typed scan failure the transfer stays non-terminal, so T2 freeze must still hold.
    const source = await seedIntegrationWithLiveAccount('t1t2-src')
    const target = await seedIntegrationWithLiveAccount('t1t2-dst')
    const create = await request(adminApp)
      .post('/api/admin/directory/org-transfers')
      .send({
        provider: 'dingtalk',
        sourceIntegrationId: source.integrationId,
        targetIntegrationId: target.integrationId,
      })
    expect(create.status).toBe(200)
    const transferId = create.body.data.transfer.id as string
    cleanupTransferIds.push(transferId)

    const scan = await request(adminApp).post(`/api/admin/directory/org-transfers/${transferId}/scan`)
    expect(scan.status).toBe(409)
    expect(scan.body.error.code).toBe('ORG_TRANSFER_ADAPTER_UNAVAILABLE')

    const row = await query<{ status: string; freeze_source_sync: boolean }>(
      `SELECT status, freeze_source_sync FROM provider_org_transfers WHERE id = $1`,
      [transferId]
    )
    expect(row.rows[0].status).toBe('draft') // still non-terminal
    expect(row.rows[0].freeze_source_sync).toBe(true)

    await expect(syncDirectoryIntegration(source.integrationId, `t2-admin-${TS}`)).rejects.toBeInstanceOf(
      DirectorySyncFrozenByTransferError
    )
    expect(await runCount(source.integrationId)).toBe(0)
    expect(await accountActive(source.accountId)).toBe(true)
  })

  it('source-sync-freeze API: platform-admin only; unknown fields / non-boolean type reject with no audit', async () => {
    const source = await seedIntegrationWithLiveAccount('api-auth-src')
    const target = await seedIntegrationWithLiveAccount('api-auth-dst')
    const transferId = await createTransferRow(source.integrationId, target.integrationId)
    const auditBefore = await orgTransferFreezeAuditTotal()

    const denied = await request(nonAdminApp)
      .patch(`/api/admin/directory/org-transfers/${transferId}/source-sync-freeze`)
      .send({ freezeSourceSync: false })
    expect(denied.status).toBeGreaterThanOrEqual(401)
    expect(denied.status).toBeLessThanOrEqual(403)

    const unknown = await request(adminApp)
      .patch(`/api/admin/directory/org-transfers/${transferId}/source-sync-freeze`)
      .send({ freezeSourceSync: false, orgId: 'evil' })
    expect(unknown.status).toBe(400)
    expect(unknown.body.error.code).toBe('ORG_TRANSFER_UNKNOWN_FIELDS')

    for (const bad of [null, 'true', 1, { nested: true }, undefined]) {
      const body =
        bad === undefined ? {} : ({ freezeSourceSync: bad } as Record<string, unknown>)
      const res = await request(adminApp)
        .patch(`/api/admin/directory/org-transfers/${transferId}/source-sync-freeze`)
        .send(body)
      expect(res.status, String(bad)).toBe(400)
      expect(res.body.error.code).toBe('ORG_TRANSFER_INVALID_INPUT')
    }

    // Flag untouched; no freeze audit written for any rejected mutation.
    const row = await query<{ freeze_source_sync: boolean }>(
      `SELECT freeze_source_sync FROM provider_org_transfers WHERE id = $1`,
      [transferId]
    )
    expect(row.rows[0].freeze_source_sync).toBe(true)
    expect(await orgTransferFreezeAuditTotal()).toBe(auditBefore)
    expect(await freezeAuditCount(transferId)).toBe(0)
  })

  it('source-sync-freeze API: missing 404, terminal 409, no audit; unfreeze + refreeze works with audits', async () => {
    const auditBefore = await orgTransferFreezeAuditTotal()

    const missing = await request(adminApp)
      .patch(`/api/admin/directory/org-transfers/${randomUUID()}/source-sync-freeze`)
      .send({ freezeSourceSync: false })
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('ORG_TRANSFER_NOT_FOUND')

    const source = await seedIntegrationWithLiveAccount('api-term-src')
    const target = await seedIntegrationWithLiveAccount('api-term-dst')
    const terminalId = await createTransferRow(source.integrationId, target.integrationId, 'cancelled')
    const terminal = await request(adminApp)
      .patch(`/api/admin/directory/org-transfers/${terminalId}/source-sync-freeze`)
      .send({ freezeSourceSync: false })
    expect(terminal.status).toBe(409)
    expect(terminal.body.error.code).toBe('ORG_TRANSFER_INVALID_STATE')

    expect(await orgTransferFreezeAuditTotal()).toBe(auditBefore)

    // Happy path + refreeze (idempotent true after false).
    const liveSource = await seedIntegrationWithLiveAccount('api-refreeze-src')
    const liveTarget = await seedIntegrationWithLiveAccount('api-refreeze-dst')
    const liveId = await createTransferRow(liveSource.integrationId, liveTarget.integrationId)

    const unfreeze = await request(adminApp)
      .patch(`/api/admin/directory/org-transfers/${liveId}/source-sync-freeze`)
      .send({ freezeSourceSync: false })
    expect(unfreeze.status).toBe(200)
    expect(unfreeze.body.data.transfer.freezeSourceSync).toBe(false)
    expect(await freezeAuditCount(liveId)).toBe(1)

    // While unfrozen, sync is allowed (positive control for the flag).
    const mid = await syncDirectoryIntegration(liveSource.integrationId, `t2-admin-${TS}`)
    expect(mid.run.status).toBe('completed')

    const refreeze = await request(adminApp)
      .patch(`/api/admin/directory/org-transfers/${liveId}/source-sync-freeze`)
      .send({ freezeSourceSync: true })
    expect(refreeze.status).toBe(200)
    expect(refreeze.body.data.transfer.freezeSourceSync).toBe(true)
    expect(await freezeAuditCount(liveId)).toBe(2)

    // After refreeze the source is frozen again.
    await expect(syncDirectoryIntegration(liveSource.integrationId, `t2-admin-${TS}`)).rejects.toBeInstanceOf(
      DirectorySyncFrozenByTransferError
    )
  })

  // -------------------------------------------------------------------------------------------
  // P1 race closeout — shared source freeze lock + apply-time recheck, both linearizations.
  // -------------------------------------------------------------------------------------------

  it('RACE create-wins: freeze INSERT holds source lock uncommitted → real sync parks → after commit apply rolls back (account stays live)', async () => {
    const source = await seedIntegrationWithLiveAccount('race-cwin-src')
    const target = await seedIntegrationWithLiveAccount('race-cwin-dst')

    let transferId = ''
    await withHolder(async (holder, holderPid) => {
      // SQL STAND-IN for createOrgTransfer mid-flight: same advisory key + freeze-active INSERT,
      // held open so the real sync's apply-time lock acquisition parks (entry check still sees
      // no freeze under READ COMMITTED — the late-race window the lock closes).
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

      const syncOutcome = settled(syncDirectoryIntegration(source.integrationId, `t2-admin-${TS}`))
      await waitUntilBlockedOnHolder(holderPid)

      await holder.query('COMMIT')

      const outcome = await syncOutcome
      expect(outcome).toBeInstanceOf(DirectorySyncFrozenByTransferError)
      expect((outcome as DirectorySyncFrozenByTransferError).transferId).toBe(transferId)
    })

    // Local directory mutation must not commit after freeze linearized first.
    expect(await accountActive(source.accountId)).toBe(true)

    // B1 (audit follow-up): the lease WAS claimed after the entry check, so this late race does
    // leave a run row behind — but a deliberate freeze must not be recorded as an integration
    // FAILURE. Before this ticket the unconditional catch called markSyncFailure and left
    // status='failed' + integrations.last_error + an 'error'/'sync_failed' alert standing for the
    // ENTIRE (multi-day) transfer, because last_error is only cleared by a SUCCESSFUL apply —
    // which the freeze is precisely what prevents. Assert the deliberate-abort aftermath instead.
    const runs = await runRows(source.integrationId)
    expect(runs.find((r) => r.status === 'completed')).toBeUndefined()
    expect(runs.find((r) => r.status === 'failed')).toBeUndefined()
    expect(runs.filter((r) => r.status === 'aborted')).toHaveLength(1)
    const aborted = runs.find((r) => r.status === 'aborted')!
    // Terminal (lease free) and NOT styled as an error on the admin run panel.
    expect(aborted.finished_at).not.toBeNull()
    expect(aborted.error_message).toBeNull()
    // Reason is still recorded — in meta, which no run-summary/toast surface reads.
    expect(aborted.meta?.abortReason).toBe('frozen_by_org_transfer')
    expect(aborted.meta?.transferId).toBe(transferId)
    // The integration itself must not read "errored" for the duration of the transfer.
    expect(await integrationLastError(source.integrationId)).toBeNull()
    // No failure alert row → nothing for the (owner-pending) alert webhook to page on.
    expect(await syncFailedAlertCount(source.integrationId)).toBe(0)

    // Escalation exclusion, pinned directly: a deliberate abort is not a consecutive failure.
    expect(await countConsecutiveFailedRuns(source.integrationId)).toBe(0)

    // LEASE IS FREE, end-to-end: with the freeze lifted the very next sync claims and completes.
    // (Also the destructive positive control — the empty tenant sweeps the seeded account.)
    await query(`UPDATE provider_org_transfers SET freeze_source_sync = false WHERE id = $1`, [transferId])
    const followUp = await syncDirectoryIntegration(source.integrationId, `t2-admin-${TS}`)
    expect(followUp.run.status).toBe('completed')
    expect(await accountActive(source.accountId)).toBe(false)
    expect(await integrationLastError(source.integrationId)).toBeNull()
  })

  it('B1 POSITIVE CONTROL: a GENUINE sync failure still marks failed + last_error + a sync_failed alert', async () => {
    // Proves the catch was NARROWED, not gutted: same catch, non-freeze error, full failure path.
    const source = await seedIntegrationWithLiveAccount('b1-genuine-fail')
    clientMocks.listDingTalkDepartments.mockRejectedValueOnce(new Error('b1 provider pull exploded'))

    await expect(syncDirectoryIntegration(source.integrationId, `t2-admin-${TS}`)).rejects.toThrow(
      /b1 provider pull exploded/,
    )

    const runs = await runRows(source.integrationId)
    expect(runs).toHaveLength(1)
    expect(runs[0].status).toBe('failed')
    expect(runs[0].error_message).toContain('b1 provider pull exploded')
    expect(await integrationLastError(source.integrationId)).toContain('b1 provider pull exploded')
    expect(await syncFailedAlertCount(source.integrationId)).toBe(1)
    // …and THIS one does drive escalation.
    expect(await countConsecutiveFailedRuns(source.integrationId)).toBe(1)
  })

  it('B1 escalation exclusion: an aborted run neither counts nor breaks a failure streak', async () => {
    // Direct pin on the escalation input (`countConsecutiveFailedRuns` filters
    // status IN ('completed','failed')): a genuine failure, then a deliberate abort, then
    // another genuine failure = a streak of 2 — the abort is invisible to escalation, and it
    // must not silently reset the streak either.
    const source = await seedIntegrationWithLiveAccount('b1-escalation')

    clientMocks.listDingTalkDepartments.mockRejectedValueOnce(new Error('b1 escalation failure one'))
    await expect(syncDirectoryIntegration(source.integrationId, `t2-admin-${TS}`)).rejects.toThrow(/failure one/)
    expect(await countConsecutiveFailedRuns(source.integrationId)).toBe(1)

    // Insert the deliberate-abort row exactly as the abort path writes it, in between.
    await query(
      `INSERT INTO directory_sync_runs (integration_id, status, started_at, finished_at, stats, meta, triggered_by, trigger_source)
       VALUES ($1, 'aborted', NOW(), NOW(), '{}'::jsonb,
               jsonb_build_object('abortReason', 'frozen_by_org_transfer'), $2, 'manual')`,
      [source.integrationId, `t2-admin-${TS}`],
    )
    expect(await countConsecutiveFailedRuns(source.integrationId)).toBe(1)

    clientMocks.listDingTalkDepartments.mockRejectedValueOnce(new Error('b1 escalation failure two'))
    await expect(syncDirectoryIntegration(source.integrationId, `t2-admin-${TS}`)).rejects.toThrow(/failure two/)
    expect(await countConsecutiveFailedRuns(source.integrationId)).toBe(2)
  })

  it('RACE sync-wins vs create: apply stand-in holds source lock → real create parks → after release create freezes', async () => {
    const source = await seedIntegrationWithLiveAccount('race-swin-c-src')
    const target = await seedIntegrationWithLiveAccount('race-swin-c-dst')

    await withHolder(async (holder, holderPid) => {
      // SQL STAND-IN for sync local-apply mid-flight after lock acquisition (no freeze yet).
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
          createdBy: FREEZE_ADMIN_ID,
        }),
      )
      await waitUntilBlockedOnHolder(holderPid)

      await holder.query('COMMIT')

      const created = await createOutcome
      expect(created).not.toBeInstanceOf(Error)
      const transfer = created as Awaited<ReturnType<typeof createOrgTransfer>>
      cleanupTransferIds.push(transfer.id)
      expect(transfer.freezeSourceSync).toBe(true)
      expect(transfer.sourceIntegrationId).toBe(source.integrationId)
    })

    // After create commits, the source is frozen for subsequent syncs.
    await expect(syncDirectoryIntegration(source.integrationId, `t2-admin-${TS}`)).rejects.toBeInstanceOf(
      DirectorySyncFrozenByTransferError,
    )
    expect(await accountActive(source.accountId)).toBe(true)
  })

  it('RACE refreeze-wins: freeze=true UPDATE holds source lock uncommitted → real sync parks → after commit apply rolls back', async () => {
    const source = await seedIntegrationWithLiveAccount('race-rwin-src')
    const target = await seedIntegrationWithLiveAccount('race-rwin-dst')
    // Unfrozen active transfer: entry check passes; apply-time recheck must catch the refreeze.
    const transferId = await createTransferRow(source.integrationId, target.integrationId)
    await query(`UPDATE provider_org_transfers SET freeze_source_sync = false WHERE id = $1`, [transferId])

    await withHolder(async (holder, holderPid) => {
      await holder.query('BEGIN')
      await holder.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        sourceSyncFreezeLockKey(source.integrationId),
      ])
      await holder.query(
        `UPDATE provider_org_transfers SET freeze_source_sync = true, updated_at = now() WHERE id = $1`,
        [transferId],
      )

      const syncOutcome = settled(syncDirectoryIntegration(source.integrationId, `t2-admin-${TS}`))
      await waitUntilBlockedOnHolder(holderPid)

      await holder.query('COMMIT')

      const outcome = await syncOutcome
      expect(outcome).toBeInstanceOf(DirectorySyncFrozenByTransferError)
      expect((outcome as DirectorySyncFrozenByTransferError).transferId).toBe(transferId)
    })

    expect(await accountActive(source.accountId)).toBe(true)
    const flag = await query<{ freeze_source_sync: boolean }>(
      `SELECT freeze_source_sync FROM provider_org_transfers WHERE id = $1`,
      [transferId],
    )
    expect(flag.rows[0].freeze_source_sync).toBe(true)
  })

  it('RACE sync-wins vs refreeze: apply stand-in holds source lock → real refreeze parks → after release freeze is set', async () => {
    const source = await seedIntegrationWithLiveAccount('race-swin-r-src')
    const target = await seedIntegrationWithLiveAccount('race-swin-r-dst')
    const transferId = await createTransferRow(source.integrationId, target.integrationId)
    await query(`UPDATE provider_org_transfers SET freeze_source_sync = false WHERE id = $1`, [transferId])

    await withHolder(async (holder, holderPid) => {
      await holder.query('BEGIN')
      await holder.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        sourceSyncFreezeLockKey(source.integrationId),
      ])

      const refreezeOutcome = settled(setOrgTransferSourceSyncFreeze(transferId, true))
      await waitUntilBlockedOnHolder(holderPid)

      await holder.query('COMMIT')

      const updated = await refreezeOutcome
      expect(updated).not.toBeInstanceOf(Error)
      expect((updated as Awaited<ReturnType<typeof setOrgTransferSourceSyncFreeze>>).freezeSourceSync).toBe(
        true,
      )
    })

    await expect(syncDirectoryIntegration(source.integrationId, `t2-admin-${TS}`)).rejects.toBeInstanceOf(
      DirectorySyncFrozenByTransferError,
    )
    expect(await accountActive(source.accountId)).toBe(true)
  })

  it('positive control (unfrozen empty tenant): absence sweep deactivates a seeded live account when freeze is off', async () => {
    // Standalone positive control for the race suite: empty mocked pull + unfrozen source must
    // actually be destructive. Independent of the admin PATCH path covered in test B.
    const source = await seedIntegrationWithLiveAccount('race-pos-src')
    const target = await seedIntegrationWithLiveAccount('race-pos-dst')
    const transferId = await createTransferRow(source.integrationId, target.integrationId)
    await query(`UPDATE provider_org_transfers SET freeze_source_sync = false WHERE id = $1`, [transferId])

    const result = await syncDirectoryIntegration(source.integrationId, `t2-admin-${TS}`)
    expect(result.run.status).toBe('completed')
    expect(await accountActive(source.accountId)).toBe(false)
  })
})
