import { beforeEach, describe, expect, it, vi } from 'vitest'
import { insertRoutedReminderDeliveries, writeRoutedReminderOrg, ROUTED_OWNERSHIP_PREDICATE, ROUTED_BRANCH_MAX_STATEMENTS_BETWEEN_HEARTBEATS } from '../../src/services/task-routed-reminders'
import { resolveEffectiveNotificationCapabilityForBackground } from '../../src/integrations/integration-capability-resolve-background'
import { runTaskReminderScan } from '../../src/services/task-scheduler'
import { metrics } from '../../src/metrics/metrics'
import type { RecipientDecision } from '../../src/services/task-routed-reminders'
import type { TaskSchedulerJobContext } from '../../src/services/task-scheduler'

vi.mock('../../src/db/pg', () => ({ pool: null, query: vi.fn() }))
vi.mock('../../src/integrations/integration-capability-resolve-background', () => ({ resolveEffectiveNotificationCapabilityForBackground: vi.fn() }))
vi.mock('../../src/notifications/adapters/notification-adapter', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/notifications/adapters/notification-adapter')>(),
  resolveNotificationAdapter: () => ({ transport: 'work_notification', fingerprint: async () => {
    fingerprintLog?.push('SELECT fingerprint_tuple')
    return { ok: true, value: 'f'.repeat(64) }
  } }),
}))
let fingerprintLog: string[] | undefined
vi.mock('../../src/notifications/recipient-resolver', () => ({ createRecipientResolver: () => ({
  verifyEndpoints: async (_db: unknown, input: { refs: Array<{ userId: string }> }) => input.refs.map(ref => target(ref.userId)),
  deriveDefaultTargets: async (_db: unknown, input: { userIds: string[] }) => input.userIds.map(target),
}) }))
function target(userId: string) { return { ok: true, target: { connectionId: separateConnections && userId === 'user1' ? SECOND_CONNECTION : CONNECTION, provider: 'dingtalk', transport: 'work_notification',
  proofId: userId, addressKind: 'dingtalk_userid', addressWitness: 'a'.repeat(64), proofWitness: 'b'.repeat(64),
  boundTenant: 'tenant', boundAppScope: 'scope', address: { reveal: () => 'PRIVATE_ADDRESS' } } } }
const CONNECTION = '11111111-1111-4111-8111-111111111111'
const SECOND_CONNECTION = '22222222-2222-4222-8222-222222222222'
let separateConnections = false
const NOW = new Date('2030-01-01T12:00:00Z')
const ENV = { TASKS_ENABLED: 'true', TASKS_SCHEDULER_ENABLED: 'true', TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: 'true',
  TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED: 'true', USER_NOTIFICATION_PREFERENCES_ENABLED: 'true', EXTERNAL_NOTIFICATION_DELIVERY_ENABLED: 'true' }
const ctx = (): TaskSchedulerJobContext => ({ now: () => NOW, stopping: () => false, leaderLost: () => false, leaderHeartbeat: vi.fn(async () => {}) })
const task = (org = 'fixture-other') => ({ id: 'task_fixture', org_id: org, created_by: 'user0', remind_at: NOW,
  remind_at_cursor: NOW.toISOString(), floor: new Date(NOW.getTime() - 1000) })
function setup(count = 2) {
  const log: string[] = []
  fingerprintLog = log
  let already = false
  let written: Record<string, unknown>[] = []
  const db = { query: vi.fn(async (sql: string, params?: unknown[]) => {
    log.push(sql)
    if (sql.includes('FROM task_assignees')) return { rows: Array.from({ length: count }, (_, i) => ({ task_id: 'task_fixture', user_id: `user${i}`, completed_at: null })) }
    if (sql.includes("'pending' AS outcome")) return { rows: already ? [{ outcome: 'already_decided', count }] : Array.from({ length: count }, (_, ordinal) => ({ ordinal, outcome: 'pending' })) }
    if (sql.includes('FROM user_orgs')) return { rows: Array.from({ length: count }, (_, i) => ({ user_id: `user${i}` })) }
    if (sql.includes('FROM notification_connection_verifications')) return { rows: [{ connection_id: CONNECTION, provider: 'dingtalk', reached_level: 'token',
      tuple_fingerprint: 'f'.repeat(64), bound_tenant: 'tenant', bound_app_scope: 'scope', invalidated_at: null, verified_at: NOW }] }
    if (sql.startsWith('WITH r AS')) {
      written = JSON.parse(String(params![0])); already = true; return { rows: written.map(row => ({ id: row.delivery_id })) }
    }
    return { rows: [] }
  }) }
  const context = ctx(); context.leaderHeartbeat = async () => { log.push('HEARTBEAT') }
  const transaction = async <T>(fn: (client: typeof db) => Promise<T>) => { log.push('BEGIN ISOLATION LEVEL READ COMMITTED');
    try { const value = await fn(db); log.push('COMMIT'); return value } catch (error) { log.push('ROLLBACK'); throw error } }
  return { db, log, context, transaction, rows: () => written }
}
beforeEach(() => { separateConnections = false; vi.restoreAllMocks(); vi.clearAllMocks(); vi.mocked(resolveEffectiveNotificationCapabilityForBackground).mockImplementation(async executor => {
  for (let index = 0; index < 6; index++) await executor.query('SELECT capability_fixture')
  return { effective: true, orgId: 'fixture-other', provider: 'dingtalk', revision: 2, witness: 'c'.repeat(64), orgSource: 'background_event_row' } as never
}) })

describe('routed scan atomicity and statement bounds', () => {
  it('carries recipient and decision as one object when a middle decision is deferred', async () => {
    const query = vi.fn(async () => ({ rows: [{ id: 'one' }, { id: 'three' }] }))
    const decisions: RecipientDecision[] = ['one', 'two', 'three'].map((userId, index) => ({
      recipient: { orgId: 'org', userId, taskId: 'task', remindAt: NOW.toISOString(), role: 'assignee', eventKey: 'event', legacySourceKey: `legacy-${userId}` },
      decision: index === 1 ? { kind: 'defer', code: 'capability_unreadable' } : { kind: 'route',
        targets: [{ routeSource: 'user_primary', connectionId: CONNECTION, endpointId: `endpoint-${userId}`, endpointRevision: 1,
          proofId: userId, capabilityRevision: 1, capabilityWitness: 'a'.repeat(64), verificationLevel: 'token',
          addressKind: 'dingtalk_userid', addressWitness: 'b'.repeat(64), proofWitness: 'c'.repeat(64), boundTenant: 'tenant', boundAppScope: 'scope' }],
        excluded: [], policyRevision: 1, preferenceRevision: 1 },
    }))
    expect(await insertRoutedReminderDeliveries({ query }, decisions, NOW)).toBe(2)
    const rows = JSON.parse(query.mock.calls[0][1][0])
    expect(rows.map(row => [row.recipient_user_id, row.endpoint_id])).toEqual([['one', 'endpoint-one'], ['three', 'endpoint-three']])
    expect(query.mock.calls[0][0]).toContain('ON CONFLICT (org_id, recipient_user_id, event_key, rank) DO NOTHING')
    expect(query.mock.calls[0][0]).toContain('l.source_key = r.legacy_source_key')
    expect(query.mock.calls[0][0]).toContain("SELECT r.delivery_id, r.org_id, 'task_reminder', r.task_id, r.source_key, r.recipient_user_id")
  })
  it.each([10, 2000])('handles %i recipients with a constant statement bound and zero second-tick parsing', async count => {
    const s = setup(count)
    const args = { db: s.db, ctx: s.context, tasks: [task()], policy: { state: 'active' as const, revision: 1, defaultConnectionId: CONNECTION }, now: NOW, transaction: s.transaction, warn: vi.fn() }
    expect(await writeRoutedReminderOrg(args)).toBe(count)
    expect(resolveEffectiveNotificationCapabilityForBackground).toHaveBeenCalledOnce()
    expect(resolveEffectiveNotificationCapabilityForBackground).toHaveBeenCalledWith(expect.anything(), { integrationId: CONNECTION, eventOrgId: 'fixture-other' })
    expect(s.log.find(line => line.includes("'pending' AS outcome"))).toContain(ROUTED_OWNERSHIP_PREDICATE)
    expect(s.log.find(line => line.includes('INSERT INTO task_notification_delivery_decisions'))).toContain(ROUTED_OWNERSHIP_PREDICATE)
    expect(s.log.filter(line => line !== 'HEARTBEAT')).toHaveLength(18)
    let statements = 0
    for (const entry of [...s.log, 'HEARTBEAT']) {
      if (entry === 'HEARTBEAT') { expect(statements).toBeLessThanOrEqual(ROUTED_BRANCH_MAX_STATEMENTS_BETWEEN_HEARTBEATS); statements = 0 }
      else statements++
    }
    const start = s.log.indexOf('BEGIN ISOLATION LEVEL READ COMMITTED')
    expect(s.log.slice(start, start + 3)).toEqual(['BEGIN ISOLATION LEVEL READ COMMITTED', "SET LOCAL lock_timeout = '2s'", "SET LOCAL statement_timeout = '5s'"])
    expect(JSON.stringify(s.rows())).not.toContain('PRIVATE_ADDRESS')
    expect(s.rows()[0].capability_witness).toBe('c'.repeat(64))
    const calls = s.db.query.mock.calls.length
    expect(await writeRoutedReminderOrg(args)).toBe(0)
    expect(s.db.query.mock.calls.length - calls).toBe(2)
    expect(resolveEffectiveNotificationCapabilityForBackground).toHaveBeenCalledOnce()
  })
  it('rejects a foreign success result without rewriting the event org', async () => {
    vi.mocked(resolveEffectiveNotificationCapabilityForBackground).mockResolvedValue({ effective: true, orgId: 'foreign', provider: 'dingtalk', revision: 1, witness: 'd'.repeat(64) } as never)
    const s = setup(); const warn = vi.fn()
    await writeRoutedReminderOrg({ db: s.db, ctx: s.context, tasks: [task()], policy: { state: 'active', revision: 1, defaultConnectionId: CONNECTION }, now: NOW, transaction: s.transaction, warn })
    expect(s.rows()[0]).toMatchObject({ org_id: 'fixture-other', reason: 'no_valid_target', excluded: [{ rank: null, code: 'connection_org_mismatch' }] })
    expect(warn).toHaveBeenCalledWith('routed_decision_mismatch')
  })
  it.each(['switch_off', 'read_failed', 'input_invalid'] as const)('persists nothing for background %s', async reason => {
    vi.mocked(resolveEffectiveNotificationCapabilityForBackground).mockResolvedValue({ effective: false, reason })
    const s = setup()
    expect(await writeRoutedReminderOrg({ db: s.db, ctx: s.context, tasks: [task()], policy: { state: 'active', revision: 1, defaultConnectionId: CONNECTION }, now: NOW, transaction: s.transaction, warn: vi.fn() })).toBe(0)
    expect(s.rows()).toEqual([])
    if (reason === 'read_failed') expect(s.log).toContain('ROLLBACK')
  })
  it('stops after a heartbeat before any reads and defers an exceeded phase budget', async () => {
    const s = setup(); s.context.stopping = () => true
    const args = { db: s.db, ctx: s.context, tasks: [task()], policy: { state: 'active' as const, revision: 1, defaultConnectionId: CONNECTION }, now: NOW, transaction: s.transaction, warn: vi.fn() }
    expect(await writeRoutedReminderOrg(args)).toBe(0); expect(s.db.query).not.toHaveBeenCalled()
    s.context.stopping = () => false
    let time = 0
    expect(await writeRoutedReminderOrg({ ...args, clock: () => { time += 10_001; return time } })).toBe(0)
    expect(resolveEffectiveNotificationCapabilityForBackground).not.toHaveBeenCalled()
    expect(s.rows()).toEqual([])
  })
  it.each(['paused', 'unreadable'] as const)('scanning %s never consults legacy channels', async state => {
    const query = vi.fn(async () => ({ rows: [task()] }))
    expect(await runTaskReminderScan(ctx(), { env: ENV, query, takeover: async () => ({ state }), logger: { warn: vi.fn(), info: vi.fn() } })).toMatchObject({ written: 0 })
    expect(query).toHaveBeenCalledOnce()
  })
  it('one poisoned routed organization does not roll back a legacy organization on the same page', async () => {
    const log: string[] = []
    const query = vi.fn(async (sql: string) => {
      log.push(sql)
      if (sql.includes('FROM tasks')) return { rows: [task('legacy'), { ...task('routed'), id: 'task_poison' }] }
      if (sql.includes('AS dingtalk_active')) return { rows: [{ dingtalk_active: true }] }
      if (sql.includes('FROM task_assignees') && log.some(text => text.startsWith('INSERT'))) throw new Error('poison')
      if (sql.includes('FROM task_assignees')) return { rows: [] }
      if (sql.startsWith('INSERT')) return { rows: [{ id: 'legacy-fixture' }], rowCount: 1 }
      throw new Error('unexpected SQL')
    })
    const warn = vi.fn()
    expect(await runTaskReminderScan(ctx(), { env: ENV, query, takeover: async org => org === 'legacy' ? { state: 'none' } : { state: 'active', revision: 1, defaultConnectionId: CONNECTION }, logger: { warn, info: vi.fn() } })).toMatchObject({ written: 1 })
    expect(warn).toHaveBeenCalledWith('routed_branch_error')
    expect(log.filter(sql => sql.startsWith('INSERT'))).toHaveLength(1)
  })
  it('heartbeats once per connection and stops before the next authority transaction', async () => {
    separateConnections = true
    const s = setup(); const args = { db: s.db, ctx: s.context, tasks: [task()], policy: { state: 'active' as const, revision: 1, defaultConnectionId: CONNECTION }, now: NOW, transaction: s.transaction, warn: vi.fn() }
    await writeRoutedReminderOrg(args)
    expect(resolveEffectiveNotificationCapabilityForBackground).toHaveBeenCalledTimes(2)
    expect(s.log.filter(sql => sql === 'HEARTBEAT')).toHaveLength(5)
    expect(ROUTED_BRANCH_MAX_STATEMENTS_BETWEEN_HEARTBEATS).toBe(11)
    const stopped = setup(); let beats = 0
    stopped.context.leaderHeartbeat = async () => { beats++ }
    stopped.context.leaderLost = () => beats === 3
    expect(await writeRoutedReminderOrg({ ...args, db: stopped.db, ctx: stopped.context, transaction: stopped.transaction })).toBe(0)
    expect(stopped.log).not.toContain('BEGIN ISOLATION LEVEL READ COMMITTED')
  })
  it('counts route and prefiltered outcomes with the closed topic/outcome/reason labels', async () => {
    const counter = vi.spyOn(metrics.notificationRoutingDecisionsTotal, 'inc')
    const s = setup(); const args = { db: s.db, ctx: s.context, tasks: [task()], policy: { state: 'active' as const, revision: 1, defaultConnectionId: CONNECTION }, now: NOW, transaction: s.transaction, warn: vi.fn() }
    await writeRoutedReminderOrg(args); await writeRoutedReminderOrg(args)
    expect(counter).toHaveBeenCalledWith({ topic: 'task_reminder', outcome: 'route', reason: '' })
    expect(counter).toHaveBeenCalledWith({ topic: 'task_reminder', outcome: 'already_decided', reason: '' }, 2)
  })
  it('reports persistent phase-budget stalls once per tick without writing', async () => {
    const counter = vi.spyOn(metrics.notificationRoutingDecisionsTotal, 'inc')
    const s = setup(); let time = 0
    const args = { db: s.db, ctx: s.context, tasks: [task()], policy: { state: 'active' as const, revision: 1, defaultConnectionId: CONNECTION }, now: NOW, transaction: s.transaction, warn: vi.fn(), clock: () => { time += 10_001; return time } }
    await writeRoutedReminderOrg(args); await writeRoutedReminderOrg(args)
    expect(counter.mock.calls.filter(([labels]) => labels.reason === 'routed_branch_budget')).toHaveLength(2)
    expect(s.rows()).toEqual([])
  })
  it('warns once per tick when both organizations have unreadable takeover state', async () => {
    const warn = vi.fn(); const query = vi.fn(async () => ({ rows: [task('a'), task('b')] }))
    await runTaskReminderScan(ctx(), { env: ENV, query, takeover: async () => ({ state: 'unreadable' }), logger: { warn, info: vi.fn() } })
    expect(warn.mock.calls).toEqual([['notification_takeover_unreadable']])
    expect(query).toHaveBeenCalledOnce()
  })

  it('never sends active takeover tasks to the legacy channel precondition', async () => {
    const queries: string[] = []; const warn = vi.fn()
    const query = async (sql: string) => {
      queries.push(sql)
      if (sql.includes('FROM tasks')) return { rows: [task()] }
      if (sql.includes('FROM task_assignees')) throw new Error('stop fixture routing after entry')
      throw new Error('legacy query reached')
    }
    expect(await runTaskReminderScan(ctx(), { env: ENV, query, takeover: async () => ({ state: 'active', revision: 1, defaultConnectionId: CONNECTION }), logger: { warn, info: vi.fn() } })).toMatchObject({ written: 0 })
    expect(queries.some(sql => sql.includes('AS dingtalk_active'))).toBe(false)
    expect(warn.mock.calls).toEqual([['routed_branch_error']])
  })

})

it('keeps a later routed organization and legacy writes after the first routed organization fails', async () => {
  const entered: string[] = []
  const rows: Record<string, unknown>[] = []
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM tasks')) return { rows: [{ ...task('poison'), id: '0-poison' }, task('healthy'), { ...task('legacy'), id: '2-legacy' }] }
    if (sql.includes('AS dingtalk_active')) return { rows: [{ dingtalk_active: true }] }
    if (sql.includes('FROM task_assignees')) {
      const ids = params![0] as string[]; entered.push(ids[0])
      if (ids[0] === '0-poison') throw new Error('synthetic routing failure')
      return { rows: [] }
    }
    if (sql.includes("'pending' AS outcome")) return { rows: [{ ordinal: 0, outcome: 'pending' }] }
    if (sql.includes('FROM user_orgs')) return { rows: [{ user_id: 'user0' }] }
    if (sql.startsWith('WITH r AS')) { rows.push(...JSON.parse(String(params![0]))); return { rows: [{ id: 'routed' }] } }
    if (sql.startsWith('INSERT')) return { rows: [{ id: 'legacy' }], rowCount: 1 }
    return { rows: [] }
  })
  const warn = vi.fn()
  const result = await runTaskReminderScan(ctx(), { env: ENV, query,
    takeover: async org => org === 'legacy' ? { state: 'none' } : { state: 'active', revision: 1, defaultConnectionId: null },
    logger: { warn, info: vi.fn() } })
  expect(entered.indexOf('0-poison')).toBeLessThan(entered.indexOf('task_fixture'))
  expect(rows).toMatchObject([{ org_id: 'healthy', recipient_user_id: 'user0', status: 'skipped', reason: 'no_route' }])
  expect(result.written).toBe(2)
  expect(warn).toHaveBeenCalledWith('routed_branch_error')
})
it.each(['USER_NOTIFICATION_PREFERENCES_ENABLED', 'EXTERNAL_NOTIFICATION_DELIVERY_ENABLED'])
  ('reads the policy exactly once with %s off and never routes or falls back', async flag => {
    const query = vi.fn(async () => ({ rows: [task(), { ...task(), id: 'second-task' }] }))
    const takeover = vi.fn(async () => ({ state: 'active' as const, revision: 1, defaultConnectionId: CONNECTION }))
    expect(await runTaskReminderScan(ctx(), { env: { ...ENV, [flag]: 'false' }, query, takeover })).toMatchObject({ written: 0 })
    expect(takeover).toHaveBeenCalledOnce(); expect(query).toHaveBeenCalledOnce()
    expect(resolveEffectiveNotificationCapabilityForBackground).not.toHaveBeenCalled()
  })
