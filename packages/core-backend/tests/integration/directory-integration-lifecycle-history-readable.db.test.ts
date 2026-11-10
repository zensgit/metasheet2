import express from 'express'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const oauthMocks = vi.hoisted(() => ({
  readDingTalkOauthConfig: vi.fn(),
}))

vi.mock('../../src/integrations/dingtalk/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/dingtalk/client')>()),
  readDingTalkOauthConfig: oauthMocks.readDingTalkOauthConfig,
}))

import { activatePendingUser } from '../../src/auth/user-activate'
import { bindDingTalkIdentityToUser } from '../../src/auth/dingtalk-oauth'
import { scrubPurgedUserIdentity, USER_TOMBSTONE_NAME } from '../../src/admin/user-recycle'
import { query, transaction } from '../../src/db/pg'
import { restoreDeprovisionEvent, listDeprovisionEffects, listDeprovisionEvents } from '../../src/directory/deprovision-evidence-api'
import { planDirectoryDeprovisionCandidate } from '../../src/directory/deprovision-ledger'
import {
  deactivateUserOrgMembershipIfNoOtherActiveBinding,
  listDirectoryIntegrations,
} from '../../src/directory/directory-sync'
import { getOrgTransfer } from '../../src/directory/org-transfer-service'
import { executeDingTalkApprovalCardCallback } from '../../src/integrations/dingtalk/interactive-card-callback'
import { resolveApprovalCardLinkSecret } from '../../src/integrations/dingtalk/approval-card-config'
import { insertDingTalkApprovalCardDelivery } from '../../src/integrations/dingtalk/approval-card-deliveries'
import { resolveDingTalkTodoOperatorUnionId } from '../../src/integrations/dingtalk/todo-operator-config'
import { getDingTalkWorkNotificationRuntimeStatusFromStore } from '../../src/integrations/dingtalk/work-notification-settings'
import {
  DINGTALK_PERSON_RECIPIENT_STATUS_SQL,
  readDingTalkPersonRecipientStatuses,
  resolveDingTalkPersonRecipientRows,
} from '../../src/multitable/dingtalk-person-recipient-status'
import { listAutomationDingTalkPersonDeliveries } from '../../src/multitable/dingtalk-person-delivery-service'
import { enrichFormShareCandidatesWithDingTalkStatus } from '../../src/multitable/permission-service'
import { authenticate } from '../../src/middleware/auth'
import { adminDirectoryRouter } from '../../src/routes/admin-directory'
import { adminUsersRouter } from '../../src/routes/admin-users'
import { authRouter } from '../../src/routes/auth'
import { readOrgDirectoryReadiness } from '../../src/routes/attendance-admin'
import { resolveApprovalRequesterOrgRelations } from '../../src/services/ApprovalDirectoryOrg'
import { DingTalkAttendanceDeliveryChannel } from '../../src/services/AttendanceNotificationDeliveryWorker'
import { readAttendanceSetupReadinessOrgRecipientBinding } from '../../src/services/AttendanceSetupReadinessAggregate'
import { prepareElearningDingTalkNotification } from '../../src/services/elearning-notification-dingtalk'
import { getElearningDepartmentStatsDaily } from '../../src/services/elearning-stats-daily-read'
import {
  STOCK_PREP_MEMBERS_SCOPED_USERS_SQL,
  STOCK_PREP_MEMBERS_SCOPE_CONFIGURED_SQL,
} from '../../src/services/stock-preparation-members'
import { DingTalkTaskDeliveryChannel } from '../../src/services/task-notification-dingtalk'
import { resolveTaskDeliveryChannelsForOrg } from '../../src/services/task-notification-producer'
import { usePinnedServer } from '../utils/pinned-server'
import {
  FIXTURE_SEEN_AT,
  FIXTURE_UPDATED_AT,
  applyRetiredShape,
  attachFixtureAccountToDepartment,
  insertFixtureAccount,
  insertFixtureDepartment,
  insertFixtureIntegration,
  insertFixtureMembership,
  insertFixtureUser,
  linkFixtureAccount,
  readFixtureShape,
  type FixtureAccount,
  type FixtureDepartment,
  type FixtureIntegration,
} from '../helpers/directory-lifecycle-retired-shape-fixture'

/**
 * History readability of a retired directory integration (real PostgreSQL).
 *
 * Invariant: when an integration row is kept with `status = 'retired'` and its accounts and
 * departments are inactive, every reader that serves history returns what it returned before,
 * through its own read function or route and without error, and every reader that selects live
 * sources no longer counts the retired one. Each case name carries its consumer number.
 * Expected values are written by hand from the reader's code.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const EXPECT_DB = process.env.EXPECT_DB === '1'
const itIfExpectDb = EXPECT_DB ? it : it.skip

itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const TAG = `lc0${Date.now().toString(36)}`
const ORG_MAIN = `${TAG}-main`
const ORG_SOLO = `${TAG}-solo`
const ORG_POL = `${TAG}-pol`
const NAMESPACE = `${TAG}ns`
const ADMIN_ROLE = `${NAMESPACE}_admin`
const q = (sql: string, params?: unknown[]) => query(sql, params)

type Ctx = {
  r: FixtureIntegration
  s: FixtureIntegration
  q: FixtureIntegration
  rp: FixtureIntegration
  sp: FixtureIntegration
  dR1: FixtureDepartment
  dR2: FixtureDepartment
  dS1: FixtureDepartment
  dSP1: FixtureDepartment
  aR1: FixtureAccount
  aR2: FixtureAccount
  aR3: FixtureAccount
  aR4: FixtureAccount
  aR5: FixtureAccount
  aRp: FixtureAccount
  aS2: FixtureAccount
  aSdep: FixtureAccount
  aQ1: FixtureAccount
  aQ2: FixtureAccount
  aSP1: FixtureAccount
  eventId: string
  transferId: string
  deliveryId: string
  templateId: string
  runId: string
  ruleId: string
}

const U = {
  admin: `${TAG}-admin`,
  delegate: `${TAG}-delegate`,
  only: `${TAG}-u-only`,
  both: `${TAG}-u-both`,
  pending: `${TAG}-u-pending`,
  sib: `${TAG}-u-sib`,
  deprov: `${TAG}-u-deprov`,
  solo: `${TAG}-u-solo`,
  purge: `${TAG}-u-purge`,
  target: `${TAG}-u-target`,
  pol: `${TAG}-u-pol`,
}
const ALL_USER_IDS = Object.values(U)

describeIfDatabase('directory integration lifecycle: history readable in the retired shape', () => {
  const pinned = usePinnedServer()
  const ctx = {} as Ctx
  const tokens: Record<string, string> = {}
  const integrationIds: string[] = []

  async function api(method: string, path: string, token: string, body?: Record<string, unknown>) {
    const res = await fetch(`${pinned.url()}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, json: (await res.json().catch(() => null)) as any }
  }

  async function expectRetiredShape(...integrations: FixtureIntegration[]): Promise<void> {
    for (const integration of integrations) {
      expect(await readFixtureShape(q, integration.id)).toEqual({
        status: 'retired',
        syncEnabled: false,
        activeAccounts: 0,
        activeDepartments: 0,
      })
    }
  }

  async function seed(): Promise<void> {
    for (const [key, id] of Object.entries(U)) {
      await insertFixtureUser(q, {
        id,
        email: `${id}@example.test`,
        name: `User ${key}`,
        isActive: key !== 'pending' && key !== 'deprov',
        activationStatus: key === 'pending' ? 'pending_activation' : 'activated',
        role: key === 'admin' ? 'admin' : 'user',
      })
    }

    ctx.r = await insertFixtureIntegration(q, {
      orgId: ORG_MAIN,
      name: `${TAG} source r`,
      corpId: `${TAG}-corp-r`,
      updatedAt: '2031-01-01T00:00:00.000Z',
      config: {
        appKey: `${TAG}-key-r`,
        appSecret: `${TAG}-secret-r`,
        approvalCardLinkSecret: `${TAG}-link-r`,
        todoOperatorUnionId: `${TAG}-operator-r`,
      },
    })
    ctx.s = await insertFixtureIntegration(q, {
      orgId: ORG_MAIN,
      name: `${TAG} source s`,
      corpId: `${TAG}-corp-s`,
      updatedAt: FIXTURE_UPDATED_AT,
      config: { appKey: `${TAG}-key-s`, appSecret: `${TAG}-secret-s`, approvalCardLinkSecret: `${TAG}-link-s` },
    })
    ctx.q = await insertFixtureIntegration(q, { orgId: ORG_SOLO, name: `${TAG} source q`, corpId: `${TAG}-corp-q` })
    ctx.rp = await insertFixtureIntegration(q, { orgId: ORG_POL, name: `${TAG} source rp`, corpId: `${TAG}-corp-rp` })
    ctx.sp = await insertFixtureIntegration(q, { orgId: ORG_POL, name: `${TAG} source sp`, corpId: `${TAG}-corp-sp` })
    integrationIds.push(ctx.r.id, ctx.s.id, ctx.q.id, ctx.rp.id, ctx.sp.id)

    ctx.dR1 = await insertFixtureDepartment(q, ctx.r, { externalDepartmentId: 'dr1', name: 'R Dept 1' })
    ctx.dR2 = await insertFixtureDepartment(q, ctx.r, { externalDepartmentId: 'dr2', name: 'R Dept 2', parentExternalId: 'dr1' })
    ctx.dS1 = await insertFixtureDepartment(q, ctx.s, { externalDepartmentId: 'ds1', name: 'S Dept' })
    ctx.dSP1 = await insertFixtureDepartment(q, ctx.sp, { externalDepartmentId: 'dsp1', name: 'SP Dept' })

    ctx.aR1 = await insertFixtureAccount(q, ctx.r, { externalUserId: 'r1', name: 'R Account 1' })
    ctx.aR2 = await insertFixtureAccount(q, ctx.r, { externalUserId: 'r2', name: 'R Account 2' })
    ctx.aR3 = await insertFixtureAccount(q, ctx.r, { externalUserId: 'r3', name: 'R Account 3' })
    ctx.aR4 = await insertFixtureAccount(q, ctx.r, { externalUserId: 'r4', name: 'R Account 4' })
    ctx.aR5 = await insertFixtureAccount(q, ctx.r, { externalUserId: 'r5', name: 'R Account 5' })
    ctx.aRp = await insertFixtureAccount(q, ctx.r, { externalUserId: 'rp', name: 'R Account P' })
    ctx.aS2 = await insertFixtureAccount(q, ctx.s, { externalUserId: 's2', name: 'S Account 2' })
    ctx.aSdep = await insertFixtureAccount(q, ctx.s, { externalUserId: 'sdep', name: 'S Departed' })
    ctx.aQ1 = await insertFixtureAccount(q, ctx.q, { externalUserId: 'q1', name: 'Q Account 1' })
    ctx.aQ2 = await insertFixtureAccount(q, ctx.q, { externalUserId: 'q2', name: 'Q Account 2' })
    ctx.aSP1 = await insertFixtureAccount(q, ctx.sp, { externalUserId: 'sp1', name: 'SP Account 1' })
    const aRP1 = await insertFixtureAccount(q, ctx.rp, { externalUserId: 'rp1', name: 'RP Account 1' })

    await attachFixtureAccountToDepartment(q, ctx.aR1.id, ctx.dR1.id)
    await attachFixtureAccountToDepartment(q, ctx.aR2.id, ctx.dR1.id)
    await attachFixtureAccountToDepartment(q, ctx.aR4.id, ctx.dR2.id)
    await attachFixtureAccountToDepartment(q, ctx.aS2.id, ctx.dS1.id)
    await attachFixtureAccountToDepartment(q, ctx.aSP1.id, ctx.dSP1.id)

    await linkFixtureAccount(q, ctx.aR1.id, U.only)
    await linkFixtureAccount(q, ctx.aR2.id, U.both)
    await linkFixtureAccount(q, ctx.aR3.id, U.pending)
    await linkFixtureAccount(q, ctx.aR4.id, U.sib)
    await linkFixtureAccount(q, ctx.aR5.id, U.deprov)
    await linkFixtureAccount(q, ctx.aRp.id, null, 'pending')
    await linkFixtureAccount(q, ctx.aS2.id, U.both)
    await linkFixtureAccount(q, ctx.aSdep.id, U.sib)
    await linkFixtureAccount(q, ctx.aQ1.id, U.solo)
    await linkFixtureAccount(q, ctx.aQ2.id, U.purge)
    await linkFixtureAccount(q, ctx.aSP1.id, U.pol)
    await linkFixtureAccount(q, aRP1.id, U.pol)
    await q(`UPDATE directory_accounts SET is_active = false WHERE id = $1::uuid`, [ctx.aSdep.id])

    await insertFixtureMembership(q, U.only, ORG_MAIN)
    await insertFixtureMembership(q, U.sib, ORG_MAIN)

    const run = await q(
      `INSERT INTO directory_sync_runs (integration_id, status, started_at, finished_at, stats, trigger_source, created_at, updated_at)
       VALUES ($1::uuid, 'success', $2::timestamptz, $2::timestamptz, '{"accounts":6}'::jsonb, 'manual', $2::timestamptz, $2::timestamptz)
       RETURNING id::text AS id`,
      [ctx.r.id, FIXTURE_SEEN_AT],
    )
    ctx.runId = run.rows[0].id
    await q(
      `INSERT INTO directory_sync_alerts (integration_id, run_id, level, code, message, details)
       VALUES ($1::uuid, $2::uuid, 'warn', 'LC0_FIXTURE', 'fixture alert', '{}'::jsonb)`,
      [ctx.r.id, ctx.runId],
    )

    const event = await q(
      `INSERT INTO directory_deprovision_events (
         org_id, integration_id, directory_account_id, local_user_id, triggered_by, event_origin,
         link_witness_account_id, link_witness_local_user_id, policy, globally_clear, access_generation_at_apply, status
       ) VALUES ($1, $2::uuid, $3::uuid, $4, 'lc0-fixture', 'admin_manual', $3::uuid, $4, 'mark_inactive', TRUE, 0, 'applied')
       RETURNING id::text AS id`,
      [ORG_MAIN, ctx.r.id, ctx.aR5.id, U.deprov],
    )
    ctx.eventId = event.rows[0].id
    await q(
      `INSERT INTO directory_deprovision_effects (event_id, local_user_id, effect_type, before_active, after_active, access_generation_at_apply, status)
       VALUES ($1::uuid, $2, 'user_changed', TRUE, FALSE, 0, 'applied')`,
      [ctx.eventId, U.deprov],
    )

    const transfer = await q(
      `INSERT INTO provider_org_transfers (org_id, provider, source_integration_id, target_integration_id,
                                           source_tenant_key, target_tenant_key, status, applied_at, created_by)
       VALUES ($1, 'dingtalk', $2::uuid, $3::uuid, $4, $5, 'applied', $6::timestamptz, $7)
       RETURNING id::text AS id`,
      [ORG_MAIN, ctx.r.id, ctx.s.id, ctx.r.corpId, ctx.s.corpId, FIXTURE_SEEN_AT, U.admin],
    )
    ctx.transferId = transfer.rows[0].id

    await q(
      `INSERT INTO org_directory_routing_policy (org_id, purpose, canonical_integration_id)
       VALUES ($1, 'approval_routing', $2::uuid)`,
      [ORG_POL, ctx.sp.id],
    )

    await q(
      `INSERT INTO elearning_stats_daily (
         org_id, directory_integration_id, directory_provider, department_id, dataset, stats_date,
         period_start, period_end, source_version, payload_digest, suppressed, min_group_size
       ) VALUES ($1, $2::uuid, 'dingtalk', $3::uuid, 'department_overview', DATE '2026-05-01',
                 TIMESTAMPTZ '2026-05-01T00:00:00Z', TIMESTAMPTZ '2026-05-02T00:00:00Z', 'lc0-fixture',
                 repeat('a', 64), TRUE, 5)`,
      [ORG_MAIN, ctx.r.id, ctx.dR1.id],
    )

    await q(`INSERT INTO approval_instances (id, status) VALUES ($1, 'pending')`, [`${TAG}-instance`])
    const delivery = await insertDingTalkApprovalCardDelivery(q as never, {
      instanceId: `${TAG}-instance`,
      nodeKey: 'approval_1',
      recipientUserId: U.only,
      recipientDingTalkUserId: ctx.aR1.externalUserId,
      deliveryKind: 'interactive_card',
      integrationId: ctx.r.id,
      entryEpoch: null,
    } as never)
    ctx.deliveryId = delivery.id

    ctx.ruleId = `${TAG}-rule`
    for (const [index, userId] of [U.only, U.both].entries()) {
      await q(
        `INSERT INTO dingtalk_person_deliveries (id, local_user_id, source_type, subject, content, success, status, automation_rule_id, created_at)
         VALUES ($1, $2, 'automation', 'subject', 'content', TRUE, 'success', $3, $4::timestamptz)`,
        [`${TAG}-delivery-${index}`, userId, ctx.ruleId, `2026-02-0${index + 1}T00:00:00.000Z`],
      )
    }

    await q(`INSERT INTO roles (id, name) VALUES ($1, $1)`, [ADMIN_ROLE])
    await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [U.delegate, ADMIN_ROLE])
    await q(
      `INSERT INTO delegated_role_admin_scopes (admin_user_id, namespace, directory_department_id, created_by)
       VALUES ($1, $2, $3::uuid, $4), ($1, 'stock-prep', $3::uuid, $4)`,
      [U.delegate, NAMESPACE, ctx.dR1.id, U.admin],
    )
    const template = await q(
      `INSERT INTO delegated_role_scope_templates (name, description) VALUES ($1, 'fixture') RETURNING id::text AS id`,
      [`${TAG} template`],
    )
    ctx.templateId = template.rows[0].id
    await q(
      `INSERT INTO delegated_role_scope_template_departments (template_id, directory_department_id) VALUES ($1::uuid, $2::uuid)`,
      [ctx.templateId, ctx.dR1.id],
    )

    await applyRetiredShape(q, ctx.r.id)
    await applyRetiredShape(q, ctx.q.id)
    await applyRetiredShape(q, ctx.rp.id)
  }

  async function removeRows(): Promise<void> {
    await q(`DELETE FROM elearning_stats_daily WHERE org_id = ANY($1::text[])`, [[ORG_MAIN, ORG_SOLO, ORG_POL]])
    await q(`DELETE FROM dingtalk_person_deliveries WHERE automation_rule_id = $1`, [ctx.ruleId ?? ''])
    await q(`DELETE FROM dingtalk_approval_card_deliveries WHERE instance_id = $1`, [`${TAG}-instance`])
    await q(`DELETE FROM approval_instances WHERE id = $1`, [`${TAG}-instance`])
    if (integrationIds.length > 0) {
      await q(`DELETE FROM directory_deprovision_events WHERE integration_id = ANY($1::uuid[])`, [integrationIds])
      await q(
        `DELETE FROM provider_org_transfers WHERE source_integration_id = ANY($1::uuid[]) OR target_integration_id = ANY($1::uuid[])`,
        [integrationIds],
      )
    }
    await q(`DELETE FROM org_directory_routing_policy WHERE org_id = ANY($1::text[])`, [[ORG_MAIN, ORG_SOLO, ORG_POL]])
    await q(`DELETE FROM delegated_role_scope_templates WHERE name = $1`, [`${TAG} template`])
    await q(`DELETE FROM delegated_role_admin_scopes WHERE admin_user_id = ANY($1::text[])`, [ALL_USER_IDS])
    await q(`DELETE FROM user_roles WHERE user_id = ANY($1::text[])`, [ALL_USER_IDS])
    await q(`DELETE FROM roles WHERE id = $1`, [ADMIN_ROLE])
    await q(`DELETE FROM user_orgs WHERE user_id = ANY($1::text[])`, [ALL_USER_IDS])
    const sessions = await q(`SELECT to_regclass('user_sessions')::text AS reg`)
    if (sessions.rows[0]?.reg) await q(`DELETE FROM user_sessions WHERE user_id = ANY($1::text[])`, [ALL_USER_IDS])
    if (integrationIds.length > 0) {
      await q(`DELETE FROM directory_integrations WHERE id = ANY($1::uuid[])`, [integrationIds])
    }
    await q(`DELETE FROM users WHERE id = ANY($1::text[])`, [ALL_USER_IDS])
  }

  beforeAll(async () => {
    oauthMocks.readDingTalkOauthConfig.mockReturnValue({
      clientId: 'lc0-client',
      clientSecret: 'lc0-secret',
      redirectUri: 'https://example.test/callback',
      corpId: `${TAG}-corp-s`,
    })
    await seed()
    const app = express()
    app.use(express.json())
    app.use('/api/auth', authRouter)
    app.use(adminUsersRouter())
    app.use('/api/admin/directory', authenticate, adminDirectoryRouter())
    pinned.setApp(app)
    const mint = async (userId: string, roles: string, perms: string) => {
      const res = await fetch(
        `${pinned.url()}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${roles}&perms=${encodeURIComponent(perms)}`,
      )
      const json = (await res.json()) as { token?: string }
      if (!json.token) throw new Error('token issuance failed')
      return json.token
    }
    tokens.admin = await mint(U.admin, 'admin', '*:*')
    tokens.delegate = await mint(U.delegate, 'user', 'attendance:read')
  })

  afterAll(async () => {
    await removeRows()
  })

  it('fixture: the integrations are in the retired shape and the sibling stays active', async () => {
    expect(await readFixtureShape(q, ctx.r.id)).toEqual({ status: 'retired', syncEnabled: false, activeAccounts: 0, activeDepartments: 0 })
    expect(await readFixtureShape(q, ctx.q.id)).toEqual({ status: 'retired', syncEnabled: false, activeAccounts: 0, activeDepartments: 0 })
    expect(await readFixtureShape(q, ctx.s.id)).toEqual({ status: 'active', syncEnabled: false, activeAccounts: 1, activeDepartments: 1 })
  })

  it('C-01 listDirectoryIntegrations lists the retired row with status retired and unchanged link counts', async () => {
    const rows = await listDirectoryIntegrations(ORG_MAIN)
    const byId = new Map(rows.map((row) => [row.id, row]))
    expect([...byId.keys()].sort()).toEqual([ctx.r.id, ctx.s.id].sort())
    const retired = byId.get(ctx.r.id)!
    expect([retired.status, retired.syncEnabled]).toEqual(['retired', false])
    expect(retired.stats).toEqual({
      departmentCount: 0,
      accountCount: 0,
      pendingLinkCount: 1,
      linkedCount: 5,
      lastRunStatus: 'success',
    })
    expect(byId.get(ctx.s.id)!.status).toBe('active')
  })

  it('C-02 account, department and review reads return the retired rows as inactive', async () => {
    const accounts = await api('GET', `/api/admin/directory/integrations/${ctx.r.id}/accounts?pageSize=100`, tokens.admin)
    expect(accounts.status).toBe(200)
    expect(accounts.json.data.total).toBe(6)
    expect(
      accounts.json.data.items
        .map((item: any) => [item.externalUserId, item.isActive, item.linkStatus, item.localUser?.id ?? null])
        .sort((a: any[], b: any[]) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ['r1', false, 'linked', U.only],
      ['r2', false, 'linked', U.both],
      ['r3', false, 'linked', U.pending],
      ['r4', false, 'linked', U.sib],
      ['r5', false, 'linked', U.deprov],
      ['rp', false, 'pending', null],
    ])

    const departments = await api('GET', `/api/admin/directory/integrations/${ctx.r.id}/departments`, tokens.admin)
    expect(departments.status).toBe(200)
    expect(departments.json.data.total).toBe(2)
    expect(
      departments.json.data.items
        .map((item: any) => [item.externalDepartmentId, item.isActive, item.accountCount, item.linkedAccountCount, item.childCount])
        .sort((a: any[], b: any[]) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ['dr1', false, 0, 0, 0],
      ['dr2', false, 0, 0, 0],
    ])

    const inactiveLinked = await api(
      'GET',
      `/api/admin/directory/integrations/${ctx.r.id}/review-items?queue=inactive_linked&pageSize=100`,
      tokens.admin,
    )
    expect(inactiveLinked.status).toBe(200)
    expect(inactiveLinked.json.data.total).toBe(5)
    expect(inactiveLinked.json.data.items.every((item: any) => item.kind === 'inactive_linked')).toBe(true)
    expect(
      inactiveLinked.json.data.items.map((item: any) => item.account.externalUserId).sort(),
    ).toEqual(['r1', 'r2', 'r3', 'r4', 'r5'])

    const single = await api('GET', `/api/admin/directory/accounts/${ctx.aR1.id}`, tokens.admin)
    expect(single.status).toBe(200)
    expect(single.json.data.account).toMatchObject({ id: ctx.aR1.id, isActive: false, linkStatus: 'linked', integrationId: ctx.r.id })
    const reviewItem = await api('GET', `/api/admin/directory/accounts/${ctx.aR1.id}/review-item`, tokens.admin)
    expect(reviewItem.status).toBe(200)
    expect(reviewItem.json.data.item).toMatchObject({ kind: 'inactive_linked', actionable: { canBatchUnbind: true } })
  })

  it('C-21 sync runs and alerts of the retired integration stay readable', async () => {
    await expectRetiredShape(ctx.r)
    const runs = await api('GET', `/api/admin/directory/integrations/${ctx.r.id}/runs`, tokens.admin)
    expect(runs.status).toBe(200)
    expect(runs.json.data.total).toBe(1)
    expect(runs.json.data.items[0]).toMatchObject({ id: ctx.runId, integrationId: ctx.r.id, status: 'success' })
    const run = await api('GET', `/api/admin/directory/integrations/${ctx.r.id}/runs/${ctx.runId}`, tokens.admin)
    expect(run.status).toBe(200)
    expect(run.json.data.run).toMatchObject({ id: ctx.runId, status: 'success', stats: { accounts: 6 } })
    const alerts = await api('GET', `/api/admin/directory/integrations/${ctx.r.id}/alerts`, tokens.admin)
    expect(alerts.status).toBe(200)
    expect(alerts.json.data.total).toBe(1)
    expect(alerts.json.data.counts).toEqual({ total: 1, pending: 1, acknowledged: 0 })
    expect(alerts.json.data.items[0]).toMatchObject({ code: 'LC0_FIXTURE', runId: ctx.runId })
  })

  it('C-31 the inactive-linked metric of the retired integration lists the linked accounts of active users', async () => {
    const metric = await api('GET', `/api/admin/directory/integrations/${ctx.r.id}/inactive-linked?days=7`, tokens.admin)
    expect(metric.status).toBe(200)
    expect(metric.json.data.metric.thresholdDays).toBe(7)
    expect(metric.json.data.metric.count).toBe(3)
    expect(metric.json.data.metric.sample.map((row: any) => row.externalUserId).sort()).toEqual(['r1', 'r2', 'r4'])
    expect(metric.json.data.metric.sample.every((row: any) => row.inactiveDays >= 7)).toBe(true)
  })

  it('C-03 deprovision events and effects of the retired integration stay readable', async () => {
    await expectRetiredShape(ctx.r)
    const events = await listDeprovisionEvents({ integrationId: ctx.r.id })
    expect(events.map((row: any) => [row.id, row.status, row.local_user_id, row.open_effect_count])).toEqual([
      [ctx.eventId, 'applied', U.deprov, 1],
    ])
    const effects = await listDeprovisionEffects(ctx.eventId)
    expect(effects.map((row: any) => [row.effect_type, row.status, row.before_active, row.after_active])).toEqual([
      ['user_changed', 'applied', true, false],
    ])
    const routed = await api('GET', `/api/admin/directory/integrations/${ctx.r.id}/deprovision-events`, tokens.admin)
    expect(routed.status).toBe(200)
  })

  it('C-04 evidence recovery against the retired source is refused with the typed source code and writes nothing', async () => {
    await expect(
      restoreDeprovisionEvent({ eventId: ctx.eventId, mode: 'rehire', adminUserId: U.admin }),
    ).rejects.toMatchObject({ code: 'SOURCE_INACTIVE' })
    const user = await q(`SELECT is_active FROM users WHERE id = $1`, [U.deprov])
    expect(user.rows[0].is_active).toBe(false)
    const event = await q(`SELECT status FROM directory_deprovision_events WHERE id = $1::uuid`, [ctx.eventId])
    expect(event.rows[0].status).toBe('applied')
  })

  it('C-06 a finished transfer of the retired integration stays readable', async () => {
    await expectRetiredShape(ctx.r)
    const detail = await getOrgTransfer(ctx.transferId)
    expect(detail.transfer).toMatchObject({
      id: ctx.transferId,
      orgId: ORG_MAIN,
      provider: 'dingtalk',
      sourceIntegrationId: ctx.r.id,
      targetIntegrationId: ctx.s.id,
      status: 'applied',
    })
    expect(detail.decisionCounts).toEqual({ total: 0, pending: 0 })
  })

  it('C-08 the approval routing policy of an organisation resolves through its canonical integration, not the retired one', async () => {
    await expectRetiredShape(ctx.rp)
    const relations = await resolveApprovalRequesterOrgRelations(U.pol, q as never, {
      orgId: ORG_POL,
      includeDepartmentFieldContext: true,
    })
    expect(relations).toEqual({
      canonicalIntegrationId: ctx.sp.id,
      primaryDepartmentId: ctx.dSP1.id,
      primaryDepartmentName: 'SP Dept',
    })

    // A policy that names the retired integration is refused with the typed policy error.
    await q(`UPDATE org_directory_routing_policy SET canonical_integration_id = $1::uuid WHERE org_id = $2`, [ctx.rp.id, ORG_POL])
    try {
      await expect(
        resolveApprovalRequesterOrgRelations(U.pol, q as never, { orgId: ORG_POL, includeDepartmentFieldContext: true }),
      ).rejects.toMatchObject({
        name: 'ApprovalRoutingPolicyError',
        message: `the approval_routing policy for org "${ORG_POL}" points at a 'retired' integration; fix the routing policy`,
      })
    } finally {
      await q(`UPDATE org_directory_routing_policy SET canonical_integration_id = $1::uuid WHERE org_id = $2`, [ctx.sp.id, ORG_POL])
    }
  })

  it('C-09 / T-26 delegated scope rows stay listed as inactive and reach no user', async () => {
    const summary = await api('GET', '/api/admin/role-delegation/summary', tokens.delegate)
    expect(summary.status).toBe(200)
    expect(summary.json.data.delegableNamespaces).toEqual([NAMESPACE])
    expect(summary.json.data.scopeAssignments).toHaveLength(1)
    expect(summary.json.data.scopeAssignments[0]).toMatchObject({
      adminUserId: U.delegate,
      namespace: NAMESPACE,
      directoryDepartmentId: ctx.dR1.id,
      integrationId: ctx.r.id,
      departmentName: 'R Dept 1',
      departmentActive: false,
    })
    const users = await api('GET', '/api/admin/role-delegation/users', tokens.delegate)
    expect(users.status).toBe(200)
    expect(users.json.data.total).toBe(0)
    expect(users.json.data.items).toEqual([])
    const access = await api('GET', `/api/admin/role-delegation/users/${U.only}/access`, tokens.delegate)
    expect(access.status).toBe(403)
    expect(access.json.error.code).toBe('ROLE_DELEGATION_USER_OUT_OF_SCOPE')
  })

  it('C-10 scope templates keep their retired department rows as inactive', async () => {
    const detail = await api('GET', `/api/admin/role-delegation/scope-templates/${ctx.templateId}`, tokens.admin)
    expect(detail.status).toBe(200)
    expect(detail.json.data.item.departmentCount).toBe(1)
    expect(detail.json.data.item.departments).toEqual([
      expect.objectContaining({ directoryDepartmentId: ctx.dR1.id, integrationId: ctx.r.id, departmentActive: false }),
    ])
    const list = await api('GET', `/api/admin/role-delegation/scope-templates?q=${encodeURIComponent(`${TAG} template`)}`, tokens.admin)
    expect(list.status).toBe(200)
    expect(list.json.data.items.map((item: any) => [item.id, item.departmentCount])).toEqual([[ctx.templateId, 1]])
  })

  it('C-11 a stored department statistics row of the retired integration stays readable', async () => {
    await expectRetiredShape(ctx.r)
    const stats = await getElearningDepartmentStatsDaily(
      { query: (sql: string, params?: unknown[]) => q(sql, params) } as never,
      { orgId: ORG_MAIN, actorId: U.admin, isGlobalAdmin: true, departmentId: ctx.dR1.id, statsDate: '2026-05-01' },
    )
    expect(stats).toEqual({
      departmentId: ctx.dR1.id,
      statsDate: '2026-05-01',
      periodStart: '2026-05-01T00:00:00.000Z',
      periodEnd: '2026-05-02T00:00:00.000Z',
      sourceVersion: 'lc0-fixture',
      minGroupSize: 5,
      projectedVersion: 1,
      lastProjectedAt: expect.any(String),
      lastErrorCode: null,
      suppressed: true,
    })
  })

  it('C-12 / T-27 requester organisation relations ignore the retired source', async () => {
    const options = { orgId: ORG_MAIN, includeDepartmentFieldContext: true }
    expect(await resolveApprovalRequesterOrgRelations(U.only, q as never, options)).toEqual({})
    expect(await resolveApprovalRequesterOrgRelations(U.both, q as never, options)).toEqual({
      canonicalIntegrationId: ctx.s.id,
      primaryDepartmentId: ctx.dS1.id,
      primaryDepartmentName: 'S Dept',
    })
    expect(
      await resolveApprovalRequesterOrgRelations(U.solo, q as never, { orgId: ORG_SOLO, includeDepartmentFieldContext: true }),
    ).toEqual({})
  })

  it('C-13 / T-28 a card callback pinned to the retired integration resolves its operator as unlinked and keeps the delivery row', async () => {
    const result = await executeDingTalkApprovalCardCallback(
      { query: q as never, approvals: {} as never },
      {
        outTrackId: ctx.deliveryId,
        userId: ctx.aR1.externalUserId,
        userIdType: 1,
        corpId: ctx.r.corpId,
        action: 'approve',
      },
    )
    expect(result).toEqual({ outcome: 'operator_unresolved', deliveryId: ctx.deliveryId, reason: 'unlinked' })
    const row = await q(`SELECT integration_id::text AS integration_id, card_state FROM dingtalk_approval_card_deliveries WHERE id = $1`, [ctx.deliveryId])
    expect(row.rows[0]).toEqual({ integration_id: ctx.r.id, card_state: 'sent' })
  })

  it('C-14 delivery channels resolve no recipient through the retired integration', async () => {
    const unusedConfig = async () => {
      throw new Error('configuration must not be read when no recipient resolves')
    }
    const attendance = new DingTalkAttendanceDeliveryChannel({
      query: q as never,
      readConfig: unusedConfig as never,
      fetchAccessToken: unusedConfig as never,
    })
    const message = (orgId: string, recipientUserId: string) => ({
      id: `${TAG}-message`,
      orgId,
      sourceType: 'lc0',
      sourceId: null,
      sourceKey: `${TAG}-key`,
      recipientUserId,
      recipientRole: 'user',
      channel: 'dingtalk_work_notification',
      payload: {},
    })
    expect(await attendance.send(message(ORG_SOLO, U.solo))).toEqual({
      ok: false,
      retryable: true,
      error: 'dingtalk_org_integration_inactive',
    })
    expect(await attendance.send(message(ORG_MAIN, U.only))).toEqual({
      ok: false,
      retryable: false,
      skip: true,
      error: 'dingtalk_recipient_not_bound',
    })

    const task = new DingTalkTaskDeliveryChannel({
      query: q as never,
      fetchAccessToken: unusedConfig as never,
      sendWorkNotification: unusedConfig as never,
    })
    expect(await task.prepare({ deliveryId: `${TAG}-task`, orgId: ORG_SOLO, recipientUserId: U.solo })).toEqual({
      ok: false,
      result: { ok: false, retryable: false, skip: true, error: 'dingtalk_org_integration_inactive' },
    })
    expect(await task.prepare({ deliveryId: `${TAG}-task`, orgId: ORG_MAIN, recipientUserId: U.only })).toEqual({
      ok: false,
      result: { ok: false, retryable: false, skip: true, error: 'dingtalk_recipient_not_bound' },
    })

    expect(
      await prepareElearningDingTalkNotification(q as never, { orgId: ORG_MAIN, recipientUserId: U.only, kind: 'assignment_reminder' }, {
        fetchAccessToken: unusedConfig as never,
        sendWorkNotification: unusedConfig as never,
      }),
    ).toEqual({ outcome: 'failed', code: 'RECIPIENT_IDENTITY_UNAVAILABLE' })
  })

  it('C-15 / T-29 person-message recipients are reached only through an active account', async () => {
    const statuses = await readDingTalkPersonRecipientStatuses(q as never, [U.both, U.only, U.solo])
    expect(statuses).toEqual([
      { userId: U.both, exists: true, active: true, dingtalkLinked: true },
      { userId: U.only, exists: true, active: true, dingtalkLinked: false },
      { userId: U.solo, exists: true, active: true, dingtalkLinked: false },
    ])
    const rows = await q(DINGTALK_PERSON_RECIPIENT_STATUS_SQL, [[U.both, U.only, U.solo]])
    const resolution = resolveDingTalkPersonRecipientRows(rows.rows)
    expect([...resolution.reachable.values()]).toEqual([
      { localUserId: U.both, dingtalkUserId: ctx.aS2.externalUserId, integrationId: ctx.s.id },
    ])
  })

  it('C-22 person-message deliveries show the retired binding as unbound', async () => {
    const deliveries = await listAutomationDingTalkPersonDeliveries(q as never, ctx.ruleId)
    expect(
      deliveries
        .map((row: any) => [row.localUserId, row.localUserDingTalkLinked, row.localUserIsActive])
        .sort((a: any[], b: any[]) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      [U.both, true, true],
      [U.only, false, true],
    ])
  })

  it('C-23 sheet share candidates report no person-message delivery through the retired binding', async () => {
    const candidate = (subjectId: string) => ({
      subjectType: 'user' as const,
      subjectId,
      label: subjectId,
      subtitle: null,
      isActive: true,
      accessLevel: null,
    })
    const enriched = await enrichFormShareCandidatesWithDingTalkStatus(q as never, [candidate(U.both), candidate(U.only)] as never)
    expect(enriched.map((row: any) => [row.subjectId, row.dingtalkPersonDeliveryAvailable, row.dingtalkBound, row.dingtalkGrantEnabled])).toEqual([
      [U.both, true, true, false],
      [U.only, false, false, false],
    ])
  })

  it('C-25 attendance readiness counts no recipient and no linked account behind the retired integration', async () => {
    expect(await readAttendanceSetupReadinessOrgRecipientBinding(ORG_SOLO, q as never)).toEqual({
      boundRecipientCount: 0,
      hasAnyBoundRecipient: false,
    })
    expect(await readOrgDirectoryReadiness(ORG_SOLO, q as never)).toMatchObject({ hasLinkedDirectoryAccounts: false })
    expect(await readAttendanceSetupReadinessOrgRecipientBinding(ORG_MAIN, q as never)).toEqual({
      boundRecipientCount: 1,
      hasAnyBoundRecipient: true,
    })
    expect(await readOrgDirectoryReadiness(ORG_MAIN, q as never)).toMatchObject({ hasLinkedDirectoryAccounts: true })
  })

  it('C-26 task notification channels include DingTalk only for an organisation with an active integration', async () => {
    const db = { query: (sql: string, params?: unknown[]) => q(sql, params) }
    expect(await resolveTaskDeliveryChannelsForOrg(db as never, ORG_SOLO, ['dingtalk_work_notification'])).toEqual([])
    expect(await resolveTaskDeliveryChannelsForOrg(db as never, ORG_MAIN, ['dingtalk_work_notification'])).toEqual([
      'dingtalk_work_notification',
    ])
  })

  it('C-27 the todo mirror resolves no operator identity through the retired integration', async () => {
    expect(await resolveDingTalkTodoOperatorUnionId(ctx.r.id, ORG_MAIN, q as never)).toBe('')
    expect(await resolveDingTalkTodoOperatorUnionId(ctx.r.id, ORG_MAIN)).toBe('')
  })

  it('C-28 inactive retired-source accounts are not counted as other bindings', async () => {
    const client = { query: (sql: string, params?: unknown[]) => q(sql, params) }
    const { plan, snapshot } = await planDirectoryDeprovisionCandidate(client as never, {
      localUserId: U.sib,
      orgId: ORG_MAIN,
      integrationId: ctx.s.id,
      directoryAccountId: ctx.aSdep.id,
      policy: 'mark_inactive',
      write: false,
    })
    expect(plan).toBeTruthy()
    expect([snapshot.globallyClear, snapshot.orgCandidacyClear, snapshot.orgMembershipActive]).toEqual([true, true, true])

    await deactivateUserOrgMembershipIfNoOtherActiveBinding(client as never, { userId: U.sib, orgId: ORG_MAIN })
    const membership = await q(`SELECT is_active FROM user_orgs WHERE user_id = $1 AND org_id = $2`, [U.sib, ORG_MAIN])
    expect(membership.rows[0].is_active).toBe(false)
  })

  it('C-20 stock preparation delegated scope stays configured and reaches no user', async () => {
    const configured = await q(STOCK_PREP_MEMBERS_SCOPE_CONFIGURED_SQL, [U.delegate, 'stock-prep'])
    expect(configured.rows[0].configured).toBe(true)
    const scoped = await q(STOCK_PREP_MEMBERS_SCOPED_USERS_SQL, [U.delegate, 'stock-prep', [U.only, U.both, U.sib]])
    expect(scoped.rows).toEqual([])
  })

  it('C-18 activation of a pending user linked only to the retired source is refused with the integration code', async () => {
    await expect(
      activatePendingUser({ userId: U.pending, mode: 'admin_no_password', adminUserId: U.admin }),
    ).rejects.toMatchObject({ code: 'ACTIVATE_INTEGRATION_INACTIVE' })
    const user = await q(`SELECT is_active, activation_status FROM users WHERE id = $1`, [U.pending])
    expect(user.rows[0]).toEqual({ is_active: false, activation_status: 'pending_activation' })
  })

  it('C-30 self-service binding still treats a user linked to the retired source as directory-managed', async () => {
    await expectRetiredShape(ctx.r)
    const before = await q(`SELECT count(*)::int AS n FROM user_external_identities WHERE local_user_id = $1`, [U.only])
    await expect(
      bindDingTalkIdentityToUser({
        localUserId: U.only,
        enableGrant: true,
        dtUser: { openId: `${TAG}-open`, unionId: `${TAG}-union`, nick: 'fixture' } as never,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'directory_managed_identity' })
    const after = await q(`SELECT count(*)::int AS n FROM user_external_identities WHERE local_user_id = $1`, [U.only])
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })

  it('T-31 binding and admission on a retired-source account are refused by the application before any write', async () => {
    const linksBefore = await q(
      `SELECT directory_account_id::text AS account_id, local_user_id, link_status FROM directory_account_links
        WHERE directory_account_id = ANY($1::uuid[]) ORDER BY directory_account_id`,
      [[ctx.aR1.id, ctx.aRp.id]],
    )
    const usersBefore = await q(`SELECT count(*)::int AS n FROM users WHERE id LIKE $1 OR email LIKE $2`, [`${TAG}%`, `${TAG}%`])

    const bind = await api('POST', `/api/admin/directory/accounts/${ctx.aR1.id}/bind`, tokens.admin, {
      localUserRef: U.target,
      enableDingTalkGrant: false,
    })
    expect(bind.status).toBe(409)
    expect(bind.json.error).toMatchObject({ code: 'DIRECTORY_BIND_FAILED', message: 'Directory account is inactive and cannot be bound' })

    const admit = await api('POST', `/api/admin/directory/accounts/${ctx.aRp.id}/admit-user`, tokens.admin, {
      name: 'Admitted Fixture',
      email: `${TAG}-admitted@example.test`,
      password: 'Lc0-Fixture-Passw0rd!x',
      enableDingTalkGrant: false,
    })
    expect(admit.status).toBe(409)
    expect(admit.json.error.code).toBe('DIRECTORY_ADMISSION_FAILED')

    const linksAfter = await q(
      `SELECT directory_account_id::text AS account_id, local_user_id, link_status FROM directory_account_links
        WHERE directory_account_id = ANY($1::uuid[]) ORDER BY directory_account_id`,
      [[ctx.aR1.id, ctx.aRp.id]],
    )
    expect(linksAfter.rows).toEqual(linksBefore.rows)
    const usersAfter = await q(`SELECT count(*)::int AS n FROM users WHERE id LIKE $1 OR email LIKE $2`, [`${TAG}%`, `${TAG}%`])
    expect(usersAfter.rows[0].n).toBe(usersBefore.rows[0].n)
  })

  it('C-32 purging a user rewrites the retired-source accounts it was linked to and releases the link', async () => {
    await expectRetiredShape(ctx.q)
    await transaction(async (client) => {
      await scrubPurgedUserIdentity(client as never, {
        userId: U.purge,
        email: `${U.purge}@example.test`,
        username: null,
        mobile: null,
        at: new Date().toISOString(),
      })
    })
    const account = await q(
      `SELECT name, is_active, external_user_id, email FROM directory_accounts WHERE id = $1::uuid`,
      [ctx.aQ2.id],
    )
    expect(account.rows[0]).toEqual({
      name: USER_TOMBSTONE_NAME,
      is_active: false,
      external_user_id: `purged:${ctx.aQ2.id}`,
      email: null,
    })
    const link = await q(`SELECT local_user_id, link_status FROM directory_account_links WHERE directory_account_id = $1::uuid`, [ctx.aQ2.id])
    expect(link.rows[0]).toEqual({ local_user_id: null, link_status: 'unlinked' })
  })

  it('T-45 an active integration is preferred over the retired one when no integration is named', async () => {
    const status = await getDingTalkWorkNotificationRuntimeStatusFromStore()
    expect(status.integration).toMatchObject({ id: ctx.s.id, status: 'active' })
    const previous = process.env.APPROVAL_CARD_LINK_SECRET
    delete process.env.APPROVAL_CARD_LINK_SECRET
    try {
      expect(await resolveApprovalCardLinkSecret()).toBe(`${TAG}-link-s`)
    } finally {
      if (previous !== undefined) process.env.APPROVAL_CARD_LINK_SECRET = previous
    }
  })
})
