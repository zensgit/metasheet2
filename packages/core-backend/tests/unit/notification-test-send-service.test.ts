import { describe, expect, it, vi } from 'vitest'
import type { AdapterPrepared, AdapterSendResult, NotificationAdapter } from '../../src/notifications/adapters/notification-adapter'
import {
  createNotificationTestSendService,
  type ConnectionReadiness,
  type NotificationTestSendDeps,
} from '../../src/notifications/test-send-service'
import { ProtectedAddress, type Db, type RecipientResolver, type ResolvedTarget, type ResolveResult } from '../../src/notifications/recipient-resolver'

const INPUT = {
  orgId: 'fixture-org', userId: 'fixture-user',
  endpointId: '00000000-0000-4000-8000-000000000111', idempotencyKey: 'fixture-key-0001',
}
const CONNECTION = '00000000-0000-4000-8000-000000000112'
const SEND_ID = '00000000-0000-4000-8000-000000000113'
const TARGET: ResolvedTarget = {
  connectionId: CONNECTION, provider: 'dingtalk', transport: 'work_notification',
  addressKind: 'dingtalk_userid', proofKind: 'directory_link',
  proofId: '00000000-0000-4000-8000-000000000114',
  proofWitness: 'proof', addressWitness: 'address', tenantAddressWitness: 'tenant-address',
  boundTenant: 'fixture-tenant', boundAppScope: 'fixture-app', address: new ProtectedAddress('private-recipient'),
}

type Row = Record<string, unknown>
type QueryCall = { sql: string; params: unknown[]; tx: boolean }

function harness(options: {
  preferences?: boolean
  delivery?: boolean
  endpoint?: Row | null
  resolve?: ResolveResult
  readiness?: ConnectionReadiness
  replay?: Array<Row | undefined>
  retryAfter?: number
  expiredCount?: number
  fence?: boolean
  fenceError?: Error
  fenceApplied?: boolean
  finishRow?: Row
  prepared?: AdapterPrepared | Error
  sent?: AdapterSendResult | Error
  afterPrepare?: () => void
  adapterError?: boolean
  transport?: string
} = {}) {
  const calls: QueryCall[] = []
  const events: string[] = []
  const replay = [...(options.replay ?? [])]
  let ledger: Row | undefined
  const flags = { preferences: options.preferences ?? true, delivery: options.delivery ?? true }
  const endpoint = options.endpoint === undefined
    ? { id: INPUT.endpointId, connection_id: CONNECTION, provider: 'dingtalk', status: 'active' }
    : options.endpoint

  async function query(sql: string, params: unknown[] = [], tx: boolean) {
    calls.push({ sql, params, tx })
    if (/^SET /u.test(sql)) { events.push('set'); return { rows: [] } }
    if (sql.includes('pg_advisory_xact_lock')) { events.push('lock'); return { rows: [] } }
    if (sql.includes('FROM user_notification_endpoints')) {
      events.push('endpoint')
      return { rows: endpoint ? [endpoint] : [] }
    }
    if (sql.includes("SET state = 'outcome_unknown'")) {
      events.push('expire')
      return { rows: Array.from({ length: options.expiredCount ?? 0 }, () => ({ id: SEND_ID })) }
    }
    if (sql.includes('SELECT ceil(extract')) {
      events.push('limits')
      return { rows: [{ retry_after: options.retryAfter ?? 0 }] }
    }
    if (sql.startsWith('SELECT') && sql.includes('FROM notification_test_sends')) {
      events.push('replay')
      const row = replay.length > 0 ? replay.shift() : ledger
      return { rows: row ? [row] : [] }
    }
    if (sql.startsWith('INSERT INTO notification_test_sends')) {
      events.push('insert')
      ledger = { id: SEND_ID, state: 'pending', outcome_code: null }
      return { rows: [ledger] }
    }
    if (sql.includes("SET state = 'sending'")) {
      events.push('fence')
      if (options.fenceError) {
        if (options.fenceApplied) ledger = { id: SEND_ID, state: 'sending', outcome_code: null }
        throw options.fenceError
      }
      if (options.fence === false) return { rows: [] }
      ledger = { id: SEND_ID, state: 'sending', outcome_code: null }
      return { rows: [ledger] }
    }
    if (sql.includes('SET state = $2')) {
      events.push('finish')
      if (options.finishRow) ledger = options.finishRow
      if (!ledger || !(params[3] as string[]).includes(String(ledger.state))) return { rows: [] }
      ledger = { ...ledger, state: params[1], outcome_code: params[2] }
      return { rows: [ledger] }
    }
    throw new Error('unexpected fixture query')
  }
  const db: Db = { query: vi.fn((sql, params) => query(sql, params, false)) }
  const tx: Db = { query: vi.fn((sql, params) => query(sql, params, true)) }
  const transaction: NotificationTestSendDeps['transaction'] = vi.fn(async (callback) => {
    events.push('begin')
    try {
      const result = await callback(tx)
      events.push('commit')
      return result
    } catch (error) { events.push('rollback'); throw error }
  })
  const verifyEndpoint = vi.fn(async (): Promise<ResolveResult> => options.resolve ?? { ok: true, target: TARGET })
  const unused = vi.fn(async () => { throw new Error('unexpected resolver method') })
  const resolver: RecipientResolver = {
    listCandidates: unused, resolveMany: unused, verifyEndpoints: unused, deriveDefaultTargets: unused,
    resolveForConnection: unused, verifyEndpoint, deriveDefaultTarget: unused,
  }
  const send = vi.fn(async (): Promise<AdapterSendResult> => {
    events.push('send')
    if (options.sent instanceof Error) throw options.sent
    return options.sent ?? { ok: true }
  })
  const prepare = vi.fn(async (): Promise<AdapterPrepared> => {
    events.push('prepare')
    options.afterPrepare?.()
    if (options.prepared instanceof Error) throw options.prepared
    return options.prepared ?? { ok: true, send }
  })
  const adapter: NotificationAdapter = {
    provider: 'dingtalk', transport: options.transport ?? TARGET.transport, prepare,
    fingerprint: vi.fn(async () => ({ ok: true, value: 'a'.repeat(64) })),
  }
  const adapterFor = vi.fn(() => {
    if (options.adapterError) throw new Error('fixture adapter absent')
    return adapter
  })
  const checkConnection = vi.fn(async (): Promise<ConnectionReadiness> => options.readiness ?? { ok: true, witness: 'b'.repeat(64) })
  const onOutcome = vi.fn()
  const service = createNotificationTestSendService({
    db, transaction, resolver, checkConnection, prepareBudgetMs: 250,
    isPreferencesEnabled: () => flags.preferences, isDeliveryEnabled: () => flags.delivery,
    adapter: adapterFor, onOutcome,
  })
  return { service, flags, db, tx, transaction, calls, events, verifyEndpoint, checkConnection, adapterFor, prepare, send, onOutcome }
}

const terminal = (state: string, outcome_code: string) => ({ id: SEND_ID, state, outcome_code })

describe('notification test send admission', () => {
  it.each([
    [{ preferences: false }, 404, 'NOT_FOUND'],
    [{ delivery: false }, 409, 'NOTIFICATION_DELIVERY_DISABLED'],
  ] as const)('rejects disabled flags without any database or sender activity %j', async (options, status, code) => {
    const h = harness(options)
    await expect(h.service.send(INPUT)).rejects.toMatchObject({ status, code })
    expect(h.calls).toEqual([])
    expect(h.transaction).not.toHaveBeenCalled()
    expect(h.checkConnection).not.toHaveBeenCalled()
    expect(h.prepare).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
  })

  it.each(['missing', 'another user', 'another organization'])('uses identical absence handling for an endpoint that is %s', async () => {
    const h = harness({ endpoint: null })
    await expect(h.service.send(INPUT)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].sql).toContain('WHERE id = $1::uuid AND org_id = $2 AND user_id = $3')
    expect(h.calls[0].params).toEqual([INPUT.endpointId, INPUT.orgId, INPUT.userId])
    expect(h.verifyEndpoint).not.toHaveBeenCalled()
    expect(h.prepare).not.toHaveBeenCalled()
  })

  it.each(['stale', 'revoked'])('refuses a %s endpoint before preparation', async (status) => {
    const h = harness({ endpoint: { id: INPUT.endpointId, connection_id: CONNECTION, provider: 'dingtalk', status } })
    await expect(h.service.send(INPUT)).rejects.toMatchObject({ status: 409, code: 'ENDPOINT_NOT_USABLE', details: { reason: 'endpoint_stale' } })
    expect(h.verifyEndpoint).not.toHaveBeenCalled()
    expect(h.prepare).not.toHaveBeenCalled()
  })

  it('refuses a proof that no longer resolves', async () => {
    const h = harness({ resolve: { ok: false, code: 'proof_wrong_user' } })
    await expect(h.service.send(INPUT)).rejects.toMatchObject({ status: 409, code: 'ENDPOINT_NOT_USABLE', details: { reason: 'proof_wrong_user' } })
    expect(h.checkConnection).not.toHaveBeenCalled()
    expect(h.prepare).not.toHaveBeenCalled()
  })

  it('requires capability and evidence readiness before creating a ledger entry', async () => {
    const h = harness({ readiness: { ok: false, code: 'verification_missing' } })
    await expect(h.service.send(INPUT)).rejects.toMatchObject({ status: 409, code: 'CONNECTION_NOT_READY', details: { reason: 'verification_missing' } })
    expect(h.checkConnection).toHaveBeenCalledWith({ orgId: INPUT.orgId, connectionId: CONNECTION, provider: 'dingtalk' })
    expect(h.transaction).not.toHaveBeenCalled()
    expect(h.prepare).not.toHaveBeenCalled()
  })

  it.each([{ adapterError: true }, { transport: 'other' }])('refuses an unavailable or wrong-transport adapter %j', async (options) => {
    const h = harness(options)
    await expect(h.service.send(INPUT)).rejects.toMatchObject({ status: 409, code: 'CONNECTION_NOT_READY', details: { reason: 'adapter_unavailable' } })
    expect(h.transaction).not.toHaveBeenCalled()
    expect(h.prepare).not.toHaveBeenCalled()
  })

  it('expires stale attempts while holding user then connection locks, before replay and counting', async () => {
    const h = harness()
    await h.service.send(INPUT)
    const txCalls = h.calls.filter((call) => call.tx)
    expect(txCalls.slice(0, 3).map((call) => call.sql)).toEqual([
      'SET TRANSACTION ISOLATION LEVEL READ COMMITTED', "SET LOCAL lock_timeout = '5s'", "SET LOCAL statement_timeout = '5s'",
    ])
    const locks = txCalls.filter((call) => call.sql.includes('pg_advisory_xact_lock'))
    expect(locks.map((call) => call.params)).toEqual([[INPUT.orgId, INPUT.userId], [INPUT.orgId, INPUT.userId], [CONNECTION]])
    expect(locks[1].sql).toContain("hashtext('notif-test:' || $1::text), hashtext($2::text)")
    expect(locks[2].sql).toContain("hashtext('notif-test-conn'), hashtext($1::text)")
    const expiry = txCalls.find((call) => call.sql.includes("SET state = 'outcome_unknown'"))!
    expect(expiry.sql).toContain("outcome_code = 'test_send_interrupted'")
    expect(expiry.sql).toContain("state IN ('pending', 'sending')")
    expect(expiry.sql).toContain("COALESCE(sending_at, created_at) <= now() - interval '90 seconds'")
    expect(expiry.params).toEqual([INPUT.orgId, INPUT.userId])
    expect(h.events.indexOf('expire')).toBeGreaterThan(h.events.lastIndexOf('lock'))
    expect(h.events.indexOf('expire')).toBeLessThan(h.events.indexOf('replay'))
    expect(h.events.indexOf('replay')).toBeLessThan(h.events.indexOf('limits'))
    expect(h.events.indexOf('limits')).toBeLessThan(h.events.indexOf('insert'))
    expect(h.events.indexOf('commit')).toBeLessThan(h.events.indexOf('prepare'))
    const limits = txCalls.find((call) => call.sql.includes('SELECT ceil(extract'))!
    expect(limits.sql).toContain("endpoint_id = $3::uuid AND created_at > now() - interval '60 seconds' HAVING count(*) >= 1")
    expect(limits.sql).toContain("created_at > now() - interval '1 hour' HAVING count(*) >= 5")
    expect(limits.sql).toContain("connection_id = $4::uuid AND created_at > now() - interval '1 hour' HAVING count(*) >= 60")
    expect(limits.sql).toContain(`SELECT min(COALESCE(sending_at, created_at)) + interval '90 seconds' FROM notification_test_sends
    WHERE org_id = $1 AND user_id = $2 AND state IN ('pending', 'sending')
      AND COALESCE(sending_at, created_at) > now() - interval '90 seconds' HAVING count(*) >= 1`)
    expect(limits.params).toEqual([INPUT.orgId, INPUT.userId, INPUT.endpointId, CONNECTION])
  })

  it('commits expired-attempt cleanup before returning rate limited and never prepares', async () => {
    const h = harness({ retryAfter: 75 })
    await expect(h.service.send(INPUT)).rejects.toMatchObject({ status: 429, code: 'TEST_SEND_RATE_LIMITED', details: { retryAfter: 75 } })
    expect(h.events).toContain('expire')
    expect(h.events.at(-1)).toBe('commit')
    expect(h.onOutcome).toHaveBeenCalledTimes(1)
    expect(h.onOutcome).toHaveBeenCalledWith('rate_limited')
    expect(h.events).not.toContain('insert')
    expect(h.prepare).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
  })
})

describe('notification test send replay and delivery', () => {
  it('counts interrupted sends only after the expiry transaction commits, including an idempotent replay', async () => {
    const h = harness({ expiredCount: 1, replay: [terminal('outcome_unknown', 'test_send_interrupted')] })
    h.onOutcome.mockImplementation(() => expect(h.events.at(-1)).toBe('commit'))
    expect(await h.service.send(INPUT)).toEqual({ outcome: 'outcome_unknown', code: 'test_send_interrupted', testSendId: SEND_ID })
    expect(h.onOutcome).toHaveBeenCalledTimes(1)
    expect(h.onOutcome).toHaveBeenCalledWith('outcome_unknown')
    expect(h.calls.find((call) => call.sql.includes("SET state = 'outcome_unknown'"))?.sql).toContain('RETURNING id')
    expect(h.send).not.toHaveBeenCalled()
  })

  it.each([
    ['accepted', 'accepted'], ['failed', 'dingtalk_request_400'],
    ['outcome_unknown', 'test_send_interrupted'], ['refused', 'routed_cancelled'],
  ])('replays stored %s without counting, preparation, sending, or new outcome metrics', async (state, code) => {
    const h = harness({ replay: [terminal(state, code)] })
    expect(await h.service.send(INPUT)).toEqual({ outcome: state, code, testSendId: SEND_ID })
    expect(h.events).not.toContain('limits')
    expect(h.events).not.toContain('insert')
    expect(h.prepare).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
    expect(h.onOutcome).not.toHaveBeenCalled()
    const replay = h.calls.find((call) => call.sql.startsWith('SELECT') && call.sql.includes('FROM notification_test_sends'))!
    expect(replay.sql).toContain('WHERE org_id = $1 AND user_id = $2 AND idempotency_key = $3')
    expect(replay.params).toEqual([INPUT.orgId, INPUT.userId, INPUT.idempotencyKey])
  })

  it.each(['pending', 'sending'])('returns in-progress for a live %s attempt and never sends', async (state) => {
    const h = harness({ replay: [{ id: SEND_ID, state, outcome_code: null }] })
    await expect(h.service.send(INPUT)).rejects.toMatchObject({ status: 409, code: 'TEST_SEND_IN_PROGRESS' })
    expect(h.events.at(-1)).toBe('commit')
    expect(h.onOutcome).not.toHaveBeenCalled()
    expect(h.prepare).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
  })

  it('fences exactly one fake send, uses the fixed message, and records provider acceptance', async () => {
    const h = harness()
    expect(await h.service.send(INPUT)).toEqual({ outcome: 'accepted', code: 'accepted', testSendId: SEND_ID })
    expect(h.prepare).toHaveBeenCalledOnce()
    expect(h.prepare).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: CONNECTION, target: TARGET, budgetMs: 250, dedupeHint: expect.stringMatching(/^[0-9a-f]{64}$/),
    }))
    expect(h.send).toHaveBeenCalledOnce()
    expect(h.send).toHaveBeenCalledWith({ title: 'MetaSheet 通知测试', content: '这是一条测试通知，用于确认此渠道可用，无需操作。' })
    expect(h.events.indexOf('prepare')).toBeLessThan(h.events.indexOf('fence'))
    expect(h.events.indexOf('fence')).toBeLessThan(h.events.indexOf('send'))
    expect(h.events.indexOf('send')).toBeLessThan(h.events.indexOf('finish'))
    expect(h.onOutcome).toHaveBeenCalledWith('accepted')
    const finish = h.calls.find((call) => call.sql.includes('SET state = $2'))!
    expect(finish.sql).toContain('WHERE id = $1::uuid AND state = ANY($4::text[])')
    expect(finish.params).toEqual([SEND_ID, 'accepted', 'accepted', ['sending']])
    expect(JSON.stringify(h.calls)).not.toContain('private-recipient')
  })

  it.each(['routed_simulated', 'routed_cancelled', 'routed_base_url_rejected'])('records preparation refusal %s without crossing the send fence', async (code) => {
    const h = harness({ prepared: { ok: false, retryable: false, skip: true, code } })
    expect(await h.service.send(INPUT)).toEqual({ outcome: 'refused', code, testSendId: SEND_ID })
    expect(h.events).not.toContain('fence')
    expect(h.send).not.toHaveBeenCalled()
    expect(h.onOutcome).toHaveBeenCalledWith('refused')
    expect(h.calls.find((call) => call.sql.includes('SET state = $2'))?.params).toEqual([SEND_ID, 'refused', code, ['pending']])
  })

  it('records thrown preparation as a fixed refusal without leaking the error', async () => {
    const h = harness({ prepared: new Error('private-recipient and provider detail') })
    expect(await h.service.send(INPUT)).toEqual({ outcome: 'refused', code: 'routed_credentials_unavailable', testSendId: SEND_ID })
    expect(h.send).not.toHaveBeenCalled()
    expect(JSON.stringify(h.calls)).not.toContain('private-recipient')
  })

  it('does not send when the pending-to-sending CAS is not obtained', async () => {
    const h = harness({ fence: false, replay: [undefined, terminal('outcome_unknown', 'test_send_interrupted')] })
    expect(await h.service.send(INPUT)).toEqual({ outcome: 'outcome_unknown', code: 'test_send_interrupted', testSendId: SEND_ID })
    expect(h.prepare).toHaveBeenCalledOnce()
    expect(h.send).not.toHaveBeenCalled()
    expect(h.onOutcome).not.toHaveBeenCalled()
    const fence = h.calls.find((call) => call.sql.includes("SET state = 'sending'"))!
    expect(fence.sql).toContain("WHERE id = $1::uuid AND state = 'pending'")
  })

  it('records an unclassified send exception as outcome unknown, never retrying', async () => {
    const h = harness({ sent: new Error('private-recipient and raw provider error') })
    expect(await h.service.send(INPUT)).toEqual({ outcome: 'outcome_unknown', code: 'routed_send_unclassified', testSendId: SEND_ID })
    expect(h.send).toHaveBeenCalledOnce()
    expect(h.onOutcome).toHaveBeenCalledWith('outcome_unknown')
    expect(JSON.stringify(h.calls)).not.toContain('raw provider error')
  })

  it('refuses a connection that becomes unavailable after preparation', async () => {
    const h = harness()
    h.checkConnection.mockResolvedValueOnce({ ok: true, witness: 'b'.repeat(64) })
      .mockResolvedValueOnce({ ok: false, code: 'verification_invalidated' })
    expect(await h.service.send(INPUT)).toEqual({ outcome: 'refused', code: 'routed_target_capability_unavailable', testSendId: SEND_ID })
    expect(h.checkConnection).toHaveBeenCalledTimes(2)
    expect(h.prepare).toHaveBeenCalledOnce()
    expect(h.events).not.toContain('fence')
    expect(h.send).not.toHaveBeenCalled()
  })

  it('refuses a capability witness that changed during preparation', async () => {
    const h = harness()
    h.checkConnection.mockResolvedValueOnce({ ok: true, witness: 'b'.repeat(64) })
      .mockResolvedValueOnce({ ok: true, witness: 'c'.repeat(64) })
    expect(await h.service.send(INPUT)).toEqual({ outcome: 'refused', code: 'routed_target_capability_changed', testSendId: SEND_ID })
    expect(h.prepare).toHaveBeenCalledOnce()
    expect(h.events).not.toContain('fence')
    expect(h.send).not.toHaveBeenCalled()
  })

  it('records a fixed refusal when the second readiness check throws, without leaving pending', async () => {
    const h = harness()
    h.checkConnection.mockResolvedValueOnce({ ok: true, witness: 'b'.repeat(64) })
      .mockRejectedValueOnce(new Error('private readiness detail'))
    expect(await h.service.send(INPUT)).toEqual({ outcome: 'refused', code: 'routed_capability_unreadable', testSendId: SEND_ID })
    expect(h.calls.find((call) => call.sql.includes('SET state = $2'))?.params)
      .toEqual([SEND_ID, 'refused', 'routed_capability_unreadable', ['pending']])
    expect(h.events).not.toContain('fence')
    expect(h.send).not.toHaveBeenCalled()
    expect(h.onOutcome).toHaveBeenCalledOnce()
    expect(h.onOutcome).toHaveBeenCalledWith('refused')
    expect(JSON.stringify(h.calls)).not.toContain('private readiness detail')
  })

  it.each(['pending', 'sending'])('records a fixed refusal after a fence error with the ledger still %s', async (state) => {
    const h = harness({
      fenceError: new Error('private fence detail'),
      fenceApplied: state === 'sending',
    })
    expect(await h.service.send(INPUT)).toEqual({ outcome: 'refused', code: 'routed_send_fence_failed', testSendId: SEND_ID })
    expect(h.calls.find((call) => call.sql.includes('SET state = $2'))?.params)
      .toEqual([SEND_ID, 'refused', 'routed_send_fence_failed', ['pending', 'sending']])
    expect(h.send).not.toHaveBeenCalled()
    expect(h.onOutcome).toHaveBeenCalledOnce()
    expect(h.onOutcome).toHaveBeenCalledWith('refused')
    expect(JSON.stringify(h.calls)).not.toContain('private fence detail')
  })

  it('finishes atomically when the failed fence commits after recovery has started', async () => {
    const h = harness({
      fenceError: new Error('Query read timeout'),
      // The row is pending at the timeout, then becomes sending before the recovery CAS runs.
      finishRow: { id: SEND_ID, state: 'sending', outcome_code: null },
    })
    expect(await h.service.send(INPUT)).toEqual({ outcome: 'refused', code: 'routed_send_fence_failed', testSendId: SEND_ID })
    expect(h.events.slice(h.events.indexOf('fence'))).toEqual(['fence', 'finish'])
    expect(h.send).not.toHaveBeenCalled()
    expect(h.onOutcome).toHaveBeenCalledOnce()
    expect(h.onOutcome).toHaveBeenCalledWith('refused')
  })

  it('preserves a terminal outcome observed after a fence error', async () => {
    const h = harness({
      fenceError: new Error('private fence detail'),
      finishRow: terminal('outcome_unknown', 'test_send_interrupted'),
    })
    expect(await h.service.send(INPUT)).toEqual({ outcome: 'outcome_unknown', code: 'test_send_interrupted', testSendId: SEND_ID })
    expect(h.events.slice(h.events.indexOf('fence'))).toEqual(['fence', 'finish', 'replay'])
    expect(h.send).not.toHaveBeenCalled()
    expect(h.onOutcome).not.toHaveBeenCalled()
  })

  it.each([null, undefined])('records malformed send response %s as outcome unknown with a fixed code', async (response) => {
    const h = harness()
    h.send.mockResolvedValueOnce(response as never)
    expect(await h.service.send(INPUT)).toEqual({ outcome: 'outcome_unknown', code: 'routed_send_unclassified', testSendId: SEND_ID })
    expect(h.send).toHaveBeenCalledOnce()
    expect(h.onOutcome).toHaveBeenCalledWith('outcome_unknown')
  })

  it.each([true, false])('records a definite provider rejection without retrying (retryable %s)', async (retryable) => {
    const h = harness({ sent: { ok: false, retryable, code: 'dingtalk_request_400' } })
    expect(await h.service.send(INPUT)).toEqual({ outcome: 'failed', code: 'dingtalk_request_400', testSendId: SEND_ID })
    expect(h.send).toHaveBeenCalledOnce()
  })

  it.each(['preferences', 'delivery'] as const)('does not cross the fence when %s turns off during preparation', async (flag) => {
    const h = harness({ afterPrepare: () => { h.flags[flag] = false } })
    expect(await h.service.send(INPUT)).toEqual({ outcome: 'refused', code: 'routed_cancelled', testSendId: SEND_ID })
    expect(h.events).not.toContain('fence')
    expect(h.send).not.toHaveBeenCalled()
  })
})
