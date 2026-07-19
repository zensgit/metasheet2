import { randomUUID } from 'crypto'
import express from 'express'
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
import {
  createDirectoryIntegration,
  DirectorySyncFrozenByTransferError,
  syncDirectoryIntegration,
} from '../../src/directory/directory-sync'
import { unregisterOrgTransferAdapter } from '../../src/directory/org-transfer-service'
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
})
