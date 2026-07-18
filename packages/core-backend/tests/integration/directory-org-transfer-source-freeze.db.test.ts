import { randomUUID } from 'crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Transfer MVP — T2 (§12.2 source freeze), real DB + the REAL syncDirectoryIntegration with a
// mocked DingTalk client (the R1-L4 orchestration-harness pattern): nothing between this suite
// and the sync orchestration except the network client. The mocked tenant is EMPTY, so any sync
// that is allowed to run performs the destructive absence sweep — which is exactly the write the
// freeze exists to stop. That makes the positive control honest: with the freeze bypassed (the
// transfer row's freeze_source_sync=false admin override), the very same sync deactivates the
// seeded account, proving test A's frozen sync was blocked from a REAL destructive outcome, not
// from a no-op.
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
import { adminDirectoryRouter } from '../../src/routes/admin-directory'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()

const adminApp = express()
adminApp.use(express.json())
adminApp.use((req, _res, next) => {
  ;(req as express.Request & { user?: unknown }).user = { id: `t2-freeze-admin-${TS}`, role: 'admin' }
  next()
})
adminApp.use('/api/admin/directory', adminDirectoryRouter())

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

  afterAll(async () => {
    for (const id of cleanupTransferIds.splice(0)) await query(`DELETE FROM provider_org_transfers WHERE id = $1`, [id])
    // integration delete cascades its departments/accounts/runs
    for (const id of cleanupIntegrationIds.splice(0)) await query(`DELETE FROM directory_integrations WHERE id = $1`, [id])
  })

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

  it('B. admin override (freeze_source_sync=false): the SAME sync runs and the absence sweep proves it was destructive', async () => {
    const source = await seedIntegrationWithLiveAccount('b-src')
    const target = await seedIntegrationWithLiveAccount('b-dst')
    const transferId = await createTransferRow(source.integrationId, target.integrationId)

    await query(`UPDATE provider_org_transfers SET freeze_source_sync = false WHERE id = $1`, [transferId])

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
})
