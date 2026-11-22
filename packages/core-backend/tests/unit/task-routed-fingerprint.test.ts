import { beforeEach, expect, it, vi } from 'vitest'
import { writeRoutedReminderOrg } from '../../src/services/task-routed-reminders'
import { resolveEffectiveNotificationCapabilityForBackground } from '../../src/integrations/integration-capability-resolve-background'
import { DingTalkWorkNotificationAdapter } from '../../src/notifications/adapters/dingtalk-work-notification-adapter'
import { DingTalkMessageConfigError } from '../../src/integrations/dingtalk/config-validation-error'
import { metrics } from '../../src/metrics/metrics'
import type { TaskSchedulerJobContext } from '../../src/services/task-scheduler'

const CONNECTION = '11111111-1111-4111-8111-111111111111'
const NOW = new Date('2030-01-01T12:00:00Z')
let transient = true
let readError: Error | undefined
const realAdapter = new DingTalkWorkNotificationAdapter({
  normalizeBaseUrl: (value: unknown) => String(value ?? 'https://oapi.dingtalk.com'),
  classifySendError: () => { throw new Error('unused') },
  // A pool/statement failure while reading the stored tuple (for example 57014), not a config defect.
  readTuple: async () => {
    if (transient && readError) throw readError
    if (transient) throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
    return { config: { appKey: 'k', appSecret: 's', agentId: '1', baseUrl: 'https://oapi.dingtalk.com' } } as never
  },
})
vi.mock('../../src/db/pg', () => ({ pool: null, query: vi.fn() }))
vi.mock('../../src/integrations/integration-capability-resolve-background', () => ({ resolveEffectiveNotificationCapabilityForBackground: vi.fn() }))
vi.mock('../../src/notifications/adapters/notification-adapter', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/notifications/adapters/notification-adapter')>(),
  resolveNotificationAdapter: () => realAdapter,
}))
vi.mock('../../src/notifications/recipient-resolver', () => ({ createRecipientResolver: () => ({
  verifyEndpoints: async () => [],
  deriveDefaultTargets: async (_db: unknown, input: { userIds: string[] }) => input.userIds.map(userId => ({ ok: true, target: {
    connectionId: CONNECTION, provider: 'dingtalk', transport: 'work_notification', proofId: userId, addressKind: 'dingtalk_userid',
    addressWitness: 'a'.repeat(64), proofWitness: 'b'.repeat(64), boundTenant: 'tenant', boundAppScope: 'scope' } })),
}) }))

function harness() {
  let written: Record<string, unknown>[] = []
  const db = { query: vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM task_assignees')) return { rows: [{ task_id: 'task_fixture', user_id: 'user0', completed_at: null }] }
    if (sql.includes("'pending' AS outcome")) return { rows: written.length ? [] : [{ ordinal: 0, outcome: 'pending' }] }
    if (sql.includes('FROM user_orgs')) return { rows: [{ user_id: 'user0' }] }
    if (sql.includes('FROM notification_connection_verifications')) return { rows: [{ connection_id: CONNECTION, provider: 'dingtalk', reached_level: 'token',
      // Evidence recorded for the real tuple fingerprint, so only the transient read can fail the check.
      tuple_fingerprint: (await realAdapterFingerprintWhenHealthy()), bound_tenant: 'tenant', bound_app_scope: 'scope', invalidated_at: null, verified_at: NOW }] }
    if (sql.startsWith('WITH r AS')) { written = JSON.parse(String(params![0])); return { rows: written.map(row => ({ id: row.delivery_id })) } }
    return { rows: [] }
  }) }
  const ctx: TaskSchedulerJobContext = { now: () => NOW, stopping: () => false, leaderLost: () => false, leaderHeartbeat: async () => {} }
  const transaction = async <T>(fn: (client: typeof db) => Promise<T>) => fn(db)
  const args = { db, ctx, tasks: [{ id: 'task_fixture', org_id: 'fixture-org', created_by: 'user0', remind_at: NOW }],
    policy: { state: 'active' as const, revision: 1, defaultConnectionId: CONNECTION }, now: NOW, transaction, warn: vi.fn() }
  return { args, rows: () => written }
}
async function realAdapterFingerprintWhenHealthy() {
  const saved = transient; transient = false
  try { const value = await realAdapter.fingerprint(CONNECTION); return value.ok ? value.value : 'unavailable' } finally { transient = saved }
}
beforeEach(() => {
  transient = true; readError = undefined
  vi.mocked(resolveEffectiveNotificationCapabilityForBackground).mockResolvedValue({ effective: true, orgId: 'fixture-org', provider: 'dingtalk', revision: 2,
    witness: 'c'.repeat(64), orgSource: 'background_event_row' } as never)
})

it('control: the real adapter reports the transient tuple failure as retryable credentials-unavailable', async () => {
  expect(await realAdapter.fingerprint(CONNECTION)).toEqual({ ok: false, code: 'routed_credentials_unavailable', failureKind: 'read_failed' })
})
it('control: with a healthy tuple read the same recipient is routed', async () => {
  transient = false
  const h = harness(); await writeRoutedReminderOrg(h.args)
  expect(h.rows()).toMatchObject([{ status: 'pending', channel: 'routed_dingtalk_work_notification', reason: null }])
})
it('defers a real adapter 57014 without occupying the event, then retries successfully', async () => {
  const counter = vi.spyOn(metrics.notificationRoutingDecisionsTotal, 'inc')
  const h = harness(); await writeRoutedReminderOrg(h.args)
  expect(h.rows()).toEqual([])
  expect(counter).toHaveBeenCalledWith({ topic: 'task_reminder', outcome: 'defer', reason: 'capability_unreadable' })
  transient = false
  await writeRoutedReminderOrg(h.args)
  expect(h.rows()).toMatchObject([{ status: 'pending', reason: null }])
  counter.mockRestore()
})
it('contrast: a capability read failure on the same connection persists nothing (defer)', async () => {
  vi.mocked(resolveEffectiveNotificationCapabilityForBackground).mockResolvedValue({ effective: false, reason: 'read_failed' } as never)
  const h = harness(); await writeRoutedReminderOrg(h.args)
  expect(h.rows()).toEqual([])
})

it('a deterministic missing credential remains an exclusion rather than an endless retry', async () => {
  readError = new DingTalkMessageConfigError('integration_tuple_incomplete', 'Synthetic tuple incomplete')
  const h = harness(); await writeRoutedReminderOrg(h.args)
  expect(h.rows()).toMatchObject([{ status: 'skipped', reason: 'no_valid_target', excluded: [{ rank: null, code: 'connection_not_verified' }] }])
})
it('an adapter throwing directly also defers without a permanent decision', async () => {
  const fingerprint = vi.spyOn(realAdapter, 'fingerprint')
  // Evidence is prepared with a healthy call before the scan reads its current fingerprint.
  fingerprint.mockImplementationOnce(async () => ({ ok: true, value: 'f'.repeat(64) }))
    .mockRejectedValueOnce(Object.assign(new Error('synthetic read failure'), { code: '57014' }))
  try {
    const h = harness(); await writeRoutedReminderOrg(h.args)
    expect(h.rows()).toEqual([])
  } finally { fingerprint.mockRestore() }
})
