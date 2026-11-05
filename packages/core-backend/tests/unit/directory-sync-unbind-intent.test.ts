import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))

const dingtalkMocks = vi.hoisted(() => ({
  fetchDingTalkAppAccessToken: vi.fn(),
  listDingTalkDepartments: vi.fn(),
  listDingTalkDepartmentUsers: vi.fn(),
  getDingTalkUserDetail: vi.fn(),
  getDingTalkDepartmentDetail: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
}))

vi.mock('../../src/integrations/dingtalk/client', () => ({
  fetchDingTalkAppAccessToken: dingtalkMocks.fetchDingTalkAppAccessToken,
  listDingTalkDepartments: dingtalkMocks.listDingTalkDepartments,
  listDingTalkDepartmentUsers: dingtalkMocks.listDingTalkDepartmentUsers,
  getDingTalkUserDetail: dingtalkMocks.getDingTalkUserDetail,
  getDingTalkDepartmentDetail: dingtalkMocks.getDingTalkDepartmentDetail,
}))

import {
  previewDirectorySyncIntegration,
  syncDirectoryIntegration,
} from '../../src/directory/directory-sync'
import {
  DIRECTORY_LINK_NOT_ADMIN_UNBOUND_SQL,
  isAdminUnboundDirectoryLink,
} from '../../src/directory/directory-link-intent'

/**
 * Offline, fake-client proof that the real sync and preview honour an administrator's
 * explicit unbind. The DingTalk client is mocked to pull ONE in-scope user; `db/pg` is an
 * SQL-shape dispatcher (same pattern as directory-sync-run-lease.test.ts) that answers the
 * handful of reads the apply transaction needs to reach the identity cascade for that user,
 * and records every statement so the assertions can say what was NOT written.
 *
 * The integration runs in `auto_for_scoped_departments` with the pulled user's department in
 * scope and no identity / email / mobile match, which is the configuration under which an
 * unmatched account would otherwise be admitted as a brand-new local user. A control case
 * with an ordinary unmatched link row proves the harness really reaches that branch, so the
 * held case's "nothing written" assertions are not vacuous.
 */

const INTEGRATION_ID = 'd1000000-0000-4000-8000-00000000f001'
const ACCOUNT_ID = 'a1000000-0000-4000-8000-00000000f001'
const DEPT_ID = 'dept-in-scope'
const EXTERNAL_USER_ID = 'dt-user-held'
const UNION_ID = 'union-held'
const OPEN_ID = 'open-held'
const RUN_ID = 'run-uip'

const INTEGRATION_ROW = {
  id: INTEGRATION_ID,
  org_id: 'default',
  provider: 'dingtalk',
  name: 'DingTalk CN',
  status: 'active',
  corp_id: 'dingcorp',
  config: {
    appKey: 'k',
    appSecret: 's',
    admissionMode: 'auto_for_scoped_departments',
    admissionDepartmentIds: [DEPT_ID],
    excludeDepartmentIds: [],
  },
  sync_enabled: true,
  schedule_cron: null,
  default_deprovision_policy: 'mark_inactive',
  last_sync_at: null,
  last_success_at: null,
  last_error: null,
  created_at: '2026-07-08T00:00:00.000Z',
  updated_at: '2026-07-08T00:00:00.000Z',
}

const ACCOUNT_ROW = {
  id: ACCOUNT_ID,
  corp_id: 'dingcorp',
  external_user_id: EXTERNAL_USER_ID,
  union_id: UNION_ID,
  open_id: OPEN_ID,
  external_key: UNION_ID,
  name: 'Held Account',
  email: null,
  mobile: null,
  is_active: true,
}

type LinkShape = { local_user_id: string | null; link_status: string; match_strategy: string | null }

const HELD_LINK: LinkShape = { local_user_id: null, link_status: 'unmatched', match_strategy: 'manual_unbound' }
const ORDINARY_UNMATCHED_LINK: LinkShape = { local_user_id: null, link_status: 'unmatched', match_strategy: 'none' }

type LoggedCall = { text: string; params: unknown[] | undefined }

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    integration_id: INTEGRATION_ID,
    status: 'running',
    started_at: '2026-07-09T00:00:00.000Z',
    finished_at: null,
    stats: {},
    error_message: null,
    triggered_by: 'admin-1',
    trigger_source: 'scheduler',
    created_at: '2026-07-09T00:00:00.000Z',
    updated_at: '2026-07-09T00:00:00.000Z',
    ...overrides,
  }
}

function installDingTalkPull() {
  dingtalkMocks.fetchDingTalkAppAccessToken.mockResolvedValue('token')
  dingtalkMocks.listDingTalkDepartments.mockImplementation(async (_token: string, parentId: string) =>
    parentId === '1' ? [{ id: DEPT_ID, parentId: '1', name: 'In Scope', order: 0, source: {} }] : [],
  )
  dingtalkMocks.getDingTalkDepartmentDetail.mockResolvedValue({ deptManagerUserIdList: [] })
  dingtalkMocks.listDingTalkDepartmentUsers.mockImplementation(async (_token: string, deptId: string) =>
    deptId === DEPT_ID
      ? { users: [{ userId: EXTERNAL_USER_ID, name: 'Held Account', departmentIds: [DEPT_ID], source: {} }], nextCursor: null, hasMore: false }
      : { users: [], nextCursor: null, hasMore: false },
  )
  dingtalkMocks.getDingTalkUserDetail.mockResolvedValue({
    userId: EXTERNAL_USER_ID,
    name: 'Held Account',
    unionId: UNION_ID,
    openId: OPEN_ID,
    email: undefined,
    mobile: undefined,
    departmentIds: [DEPT_ID],
    source: {},
  })
}

/** Dispatcher for the whole sync: pool reads outside the transaction and the apply client inside it. */
function installSyncMocks(existingLink: LinkShape | null) {
  const bareCalls: LoggedCall[] = []
  const txCalls: LoggedCall[] = []

  pgMocks.query.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const text = String(sql)
    bareCalls.push({ text, params })
    if (text.includes('SET last_heartbeat_at')) return { rows: [] }
    if (text.includes('INSERT INTO directory_sync_runs')) return { rows: [runRow()] }
    if (text.includes('FROM directory_integrations')) return { rows: [INTEGRATION_ROW] }
    if (text.includes('FROM directory_sync_runs')) return { rows: [runRow({ status: 'completed' })] }
    if (text.includes('to_regclass')) return { rows: [{ reg: null }] }
    return { rows: [] }
  })

  pgMocks.transaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => {
    const client = {
      query: async (sql: unknown, params?: unknown[]) => {
        const text = String(sql)
        txCalls.push({ text, params })
        if (text.includes("SET status = 'completed'")) return { rows: [{ id: RUN_ID }] }
        if (text.includes('to_regclass')) return { rows: [{ reg: null }] }
        if (text.includes('FROM directory_integrations')) return { rows: [INTEGRATION_ROW] }
        // The apply loop's account inventory (every account of the integration).
        if (text.includes('SELECT id, corp_id, external_user_id, union_id, open_id, external_key, name, email, mobile, is_active')) {
          return { rows: [ACCOUNT_ROW] }
        }
        // Access-graph mutex re-check of prior bindings (joins the link row; NULL user = nothing to lock).
        if (text.includes('LEFT JOIN directory_account_links link') && text.includes('account.is_active')) {
          return { rows: [{ account_id: ACCOUNT_ID, external_user_id: EXTERNAL_USER_ID, is_active: true, local_user_id: existingLink?.local_user_id ?? null, link_status: existingLink?.link_status ?? null }] }
        }
        // The link rows the cascade reads.
        if (text.includes('FROM directory_account_links') && text.includes('WHERE directory_account_id = ANY($1::uuid[])')) {
          return { rows: existingLink ? [{ directory_account_id: ACCOUNT_ID, ...existingLink }] : [] }
        }
        if (text.includes('INSERT INTO users')) return { rows: [{ id: 'new-user-1' }] }
        return { rows: [] }
      },
    }
    return fn(client)
  })

  installDingTalkPull()
  return { bareCalls, txCalls }
}

function completionStats(txCalls: LoggedCall[]): Record<string, unknown> {
  const completion = txCalls.find((call) => call.text.includes("SET status = 'completed'"))
  expect(completion, 'the run completion write').toBeDefined()
  return JSON.parse(String(completion?.params?.[1])) as Record<string, unknown>
}

function linkWritesFor(txCalls: LoggedCall[], accountId: string) {
  return txCalls.filter((call) =>
    call.text.includes('INSERT INTO directory_account_links') && call.params?.[0] === accountId)
}

describe('syncDirectoryIntegration keeps an administrator-unbound link (fake client)', () => {
  beforeEach(() => {
    pgMocks.query.mockReset()
    pgMocks.transaction.mockReset()
    for (const mock of Object.values(dingtalkMocks)) mock.mockReset()
  })

  it('control: an ordinary unmatched in-scope account reaches auto-admission', async () => {
    const { txCalls } = installSyncMocks(ORDINARY_UNMATCHED_LINK)

    const result = await syncDirectoryIntegration(INTEGRATION_ID, 'admin-1', 'scheduler')

    const stats = completionStats(txCalls)
    expect(stats.autoAdmissionCandidateCount).toBe(1)
    expect(stats.adminUnboundHeldCount).toBe(0)
    // The harness really reaches the admission branch: a users insert is attempted (the
    // fake client cannot complete the bind, so the admission is counted as failed).
    expect(txCalls.some((call) => call.text.includes('INSERT INTO users'))).toBe(true)
    expect(stats.autoAdmissionFailedCount).toBe(1)
    expect(linkWritesFor(txCalls, ACCOUNT_ID)).toHaveLength(1)
    expect(result.run.id).toBe(RUN_ID)
  })

  it('held: no users insert, no link write for the account, no admission candidate', async () => {
    const { txCalls } = installSyncMocks(HELD_LINK)

    await syncDirectoryIntegration(INTEGRATION_ID, 'admin-1', 'scheduler')

    const stats = completionStats(txCalls)
    expect(txCalls.some((call) => call.text.includes('INSERT INTO users'))).toBe(false)
    expect(linkWritesFor(txCalls, ACCOUNT_ID)).toHaveLength(0)
    expect(stats.autoAdmissionCandidateCount).toBe(0)
    expect(stats.autoAdmittedCount).toBe(0)
    expect(stats.autoAdmissionFailedCount).toBe(0)
    expect(stats.adminUnboundHeldCount).toBe(1)
    // The row still counts as unmatched in the status tallies.
    expect(stats.unmatchedCount).toBe(1)
    expect(stats.linkedCount).toBe(0)
    expect(stats.pendingCount).toBe(0)
  })

  it('every link write the sync issues is conditional on the current row not being held', async () => {
    const { txCalls } = installSyncMocks(ORDINARY_UNMATCHED_LINK)

    await syncDirectoryIntegration(INTEGRATION_ID, 'admin-1', 'manual')

    const writes = txCalls.filter((call) => call.text.includes('INSERT INTO directory_account_links'))
    expect(writes.length).toBeGreaterThan(0)
    for (const write of writes) {
      expect(write.text).toContain('ON CONFLICT (directory_account_id)')
      expect(write.text).toContain(`WHERE ${DIRECTORY_LINK_NOT_ADMIN_UNBOUND_SQL}`)
    }
  })
})

describe('previewDirectorySyncIntegration keeps an administrator-unbound link (fake client)', () => {
  beforeEach(() => {
    pgMocks.query.mockReset()
    pgMocks.transaction.mockReset()
    for (const mock of Object.values(dingtalkMocks)) mock.mockReset()
  })

  function installPreviewMocks(existingLink: LinkShape | null) {
    pgMocks.query.mockImplementation(async (sql: unknown) => {
      const text = String(sql)
      if (text.includes('FROM directory_integrations')) return { rows: [INTEGRATION_ROW] }
      if (text.includes('FROM directory_sync_runs') && text.includes("status = 'running'")) return { rows: [] }
      if (text.includes('FROM directory_accounts a') && text.includes('LEFT JOIN directory_account_links l')) {
        return {
          rows: [{
            external_user_id: EXTERNAL_USER_ID,
            name: 'Held Account',
            is_active: true,
            linked: existingLink?.link_status === 'linked' && existingLink.local_user_id !== null,
            local_user_id: existingLink?.local_user_id ?? null,
            link_status: existingLink?.link_status ?? null,
            match_strategy: existingLink?.match_strategy ?? null,
          }],
        }
      }
      return { rows: [] }
    })
    installDingTalkPull()
  }

  it('control: an ordinary unmatched in-scope account is an admission candidate', async () => {
    installPreviewMocks(ORDINARY_UNMATCHED_LINK)
    const preview = await previewDirectorySyncIntegration(INTEGRATION_ID)
    expect(preview.autoAdmissionCandidateCount).toBe(1)
    expect(preview.adminUnboundHeldCount).toBe(0)
  })

  it('held: the account is reported as held and not as an admission candidate', async () => {
    installPreviewMocks(HELD_LINK)
    const preview = await previewDirectorySyncIntegration(INTEGRATION_ID)
    expect(preview.autoAdmissionCandidateCount).toBe(0)
    expect(preview.adminUnboundHeldCount).toBe(1)
  })

  it('an account without a link row is still an admission candidate', async () => {
    installPreviewMocks(null)
    const preview = await previewDirectorySyncIntegration(INTEGRATION_ID)
    expect(preview.autoAdmissionCandidateCount).toBe(1)
    expect(preview.adminUnboundHeldCount).toBe(0)
  })
})

describe('isAdminUnboundDirectoryLink', () => {
  it('recognises the persisted unbind shape by its three columns only', () => {
    expect(isAdminUnboundDirectoryLink(HELD_LINK)).toBe(true)
    expect(isAdminUnboundDirectoryLink({ ...HELD_LINK, link_status: 'pending' })).toBe(true)
    expect(isAdminUnboundDirectoryLink({ ...HELD_LINK, link_status: 'linked' })).toBe(false)
    expect(isAdminUnboundDirectoryLink({ ...HELD_LINK, local_user_id: 'user-1' })).toBe(false)
    expect(isAdminUnboundDirectoryLink({ ...HELD_LINK, match_strategy: 'none' })).toBe(false)
    expect(isAdminUnboundDirectoryLink({ ...HELD_LINK, match_strategy: null })).toBe(false)
    expect(isAdminUnboundDirectoryLink(null)).toBe(false)
    expect(isAdminUnboundDirectoryLink(undefined)).toBe(false)
  })

  it('the SQL form is NULL-safe: a NULL strategy row is still updatable', () => {
    // Each disjunct is NULL-safe on its own; a NULL strategy makes the first one TRUE.
    expect(DIRECTORY_LINK_NOT_ADMIN_UNBOUND_SQL).toContain("match_strategy IS DISTINCT FROM 'manual_unbound'")
    expect(DIRECTORY_LINK_NOT_ADMIN_UNBOUND_SQL).toContain("link_status = 'linked'")
    expect(DIRECTORY_LINK_NOT_ADMIN_UNBOUND_SQL).toContain('local_user_id IS NOT NULL')
    expect(DIRECTORY_LINK_NOT_ADMIN_UNBOUND_SQL).not.toMatch(/\bNOT\s*\(/)
  })
})
