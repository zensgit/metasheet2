/**
 * DingTalk approval-todo ONE-WAY mirror — the DELIVERY half (design
 * docs/development/takeover-beiliao-20260821/dingtalk-todo-mirror-b-design-20260916.md §4/§5/§9).
 *
 * Unit-level DI (query / config / token / todo transport injected), the same discipline as
 * attendance-dingtalk-outcome-unknown.test.ts: nothing here reaches the network or a database.
 *
 * The load-bearing behaviours pinned here:
 *   - claim takes a LEASE with FOR UPDATE SKIP LOCKED and NEVER matches a terminal row;
 *   - every terminal write is a CAS on (status, claim_worker_id, attempt_count) — a stolen lease
 *     writes nothing ("lost-lease");
 *   - an outcome-UNKNOWN send terminates as `outcome_unknown`, never retried, never redelivery-safe,
 *     and the operator requeue gate refuses it;
 *   - a DEFINITE rejection is `failed` + redelivery_safe, and a requeue restores the row's PHASE
 *     (a row that already has a DingTalk task id goes back to `completing`, never to `pending` —
 *     that would create a second todo);
 *   - identity resolution is org-scoped and never guesses between two candidates.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  DingTalkTodoMirrorWorker,
  TODO_MIRROR_ERROR_CODES,
  buildTodoMirrorDetailUrl,
  buildTodoMirrorSubject,
  computeTodoMirrorBackoffMs,
  isDingTalkTodoTaskMissing,
  requeueFailedDingTalkTodoMirror,
  resolveTodoMirrorAppBaseUrl,
  type TodoMirrorRow,
} from '../../src/services/dingtalk-todo-mirror-worker'
import { DingTalkBusinessError, DingTalkRequestError } from '../../src/integrations/dingtalk/client'

type Call = { sql: string; params: unknown[] }

const CONFIG = { appKey: 'k', appSecret: 's', agentId: '42' }

function pendingRow(over: Partial<TodoMirrorRow> = {}): TodoMirrorRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    org_id: 'org-1',
    instance_id: 'inst-1',
    request_no: 'REQ-0001',
    template_id: 'tpl-1',
    node_key: 'node-a',
    entry_epoch: 1,
    recipient_user_id: 'user-1',
    recipient_union_id: null,
    integration_id: null,
    source_key: 'approval-task:inst-1:node-a:1:user-1',
    dingtalk_task_id: null,
    status: 'sending',
    attempt_count: 1,
    ...over,
  }
}

interface HarnessOptions {
  claimed?: TodoMirrorRow[]
  linked?: Array<{ integration_id: string; union_id: string | null }>
  fallback?: Array<{ integration_id: string; provider_union_id: string | null }>
  orgHasActiveIntegration?: boolean
  casRowCount?: number
  operatorUnionId?: string
  createTodoTask?: ReturnType<typeof vi.fn>
  completeTodoTask?: ReturnType<typeof vi.fn>
  readConfig?: () => Promise<typeof CONFIG>
  maxAttempts?: number
}

function harness(options: HarnessOptions = {}) {
  const calls: Call[] = []
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params })
    if (sql.includes('WITH claim AS')) return { rows: options.claimed ?? [], rowCount: (options.claimed ?? []).length }
    if (sql.includes('FROM directory_account_links')) return { rows: options.linked ?? [], rowCount: (options.linked ?? []).length }
    if (sql.includes('FROM user_external_identities')) return { rows: options.fallback ?? [], rowCount: (options.fallback ?? []).length }
    if (sql.includes('SELECT EXISTS')) return { rows: [{ has_active: options.orgHasActiveIntegration ?? true }], rowCount: 1 }
    if (sql.includes('FROM approval_templates')) return { rows: [{ name: '备料审批' }], rowCount: 1 }
    if (sql.includes('UPDATE dingtalk_todo_mirrors')) return { rows: [], rowCount: options.casRowCount ?? 1 }
    return { rows: [], rowCount: 0 }
  })
  const createTodoTask = options.createTodoTask ?? vi.fn(async () => ({ taskId: 'dt-task-1', raw: {} }))
  const completeTodoTask = options.completeTodoTask ?? vi.fn(async () => ({ taskId: 'dt-task-1', raw: {} }))
  const worker = new DingTalkTodoMirrorWorker({
    query: query as never,
    workerId: 'worker-test',
    now: () => new Date('2026-09-16T00:00:00.000Z'),
    env: { PUBLIC_APP_URL: 'https://app.example.com' } as NodeJS.ProcessEnv,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    readConfig: options.readConfig ?? (async () => CONFIG),
    fetchAccessToken: async () => 'access-token',
    resolveOperatorUnionId: async () => (options.operatorUnionId === undefined ? 'op-union-1' : options.operatorUnionId),
    createTodoTask: createTodoTask as never,
    completeTodoTask: completeTodoTask as never,
    ...(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {}),
  })
  // the CLAIM statement also contains an UPDATE - exclude it so `writes()` is the terminal/retry write only
  const writes = () => calls.filter((c) => c.sql.includes('UPDATE dingtalk_todo_mirrors') && !c.sql.includes('WITH claim AS'))
  return { worker, query, calls, writes, createTodoTask, completeTodoTask }
}

describe('todo mirror worker — claim', () => {
  it('claims due work under a lease with SKIP LOCKED and never matches a terminal row', async () => {
    const h = harness({ claimed: [] })
    await h.worker.runBatch()
    const claim = h.calls[0]
    expect(claim.sql).toContain('FOR UPDATE SKIP LOCKED')
    expect(claim.sql).toContain("status IN ('pending', 'completing')")
    expect(claim.sql).toContain("status = 'sending'")
    expect(claim.sql).toContain('claim_expires_at <= $1::timestamptz')
    // a claimed pending row becomes `sending`; a claimed completing row KEEPS its phase
    expect(claim.sql).toContain("SET status = CASE WHEN d.status = 'completing' THEN 'completing' ELSE 'sending' END")
    // TERMINAL states appear NOWHERE in the claim predicate — this is half of "never resent"
    for (const terminal of ['outcome_unknown', "'failed'", "'completed'", "'superseded'", "'skipped'"]) {
      expect(claim.sql).not.toContain(terminal)
    }
    expect(claim.params[3]).toBe('worker-test')
  })
})

describe('todo mirror worker — create phase', () => {
  it('sends ONE todo to the linked unionId and CAS-writes `created` with the returned task id', async () => {
    const h = harness({ claimed: [pendingRow()], linked: [{ integration_id: 'integ-1', union_id: 'union-recipient' }] })
    const result = await h.worker.runBatch()
    expect(result).toMatchObject({ claimed: 1, created: 1, failed: 0, skipped: 0, outcomeUnknown: 0 })
    expect(h.createTodoTask).toHaveBeenCalledTimes(1)
    const [, operator, input] = h.createTodoTask.mock.calls[0]
    expect(operator).toBe('op-union-1')
    expect(input).toMatchObject({
      sourceId: 'approval-task:inst-1:node-a:1:user-1',
      subject: '审批待处理：备料审批 REQ-0001',
      creatorUnionId: 'op-union-1',
      executorUnionIds: ['union-recipient'],
      detailUrl: 'https://app.example.com/approvals/inst-1',
    })
    const write = h.writes()[0]
    expect(write.sql).toContain("SET status = 'created'")
    // the CAS: only the lease holder, on the matching attempt, may write
    expect(write.sql).toContain("AND status = 'sending'")
    expect(write.sql).toContain('AND claim_worker_id = $3')
    expect(write.sql).toContain('AND attempt_count = $4::int')
    expect(write.params[2]).toBe('worker-test')
    expect(write.params[3]).toBe(1)
    expect(write.params[4]).toBe('dt-task-1')
  })

  it('a stolen lease (CAS matches 0 rows) writes nothing and reports lost-lease', async () => {
    const h = harness({ claimed: [pendingRow()], linked: [{ integration_id: 'integ-1', union_id: 'u' }], casRowCount: 0 })
    const result = await h.worker.runBatch()
    expect(result).toMatchObject({ claimed: 1, created: 0, lostLease: 1 })
  })

  it('no DingTalk identity + an ACTIVE org integration => terminal `skipped`, nothing sent', async () => {
    const h = harness({ claimed: [pendingRow()], linked: [], fallback: [], orgHasActiveIntegration: true })
    const result = await h.worker.runBatch()
    expect(result).toMatchObject({ skipped: 1, created: 0 })
    expect(h.createTodoTask).not.toHaveBeenCalled()
    const write = h.writes()[0]
    expect(write.params[4]).toBe('skipped')
    expect(write.params[5]).toBe(TODO_MIRROR_ERROR_CODES.recipientNotBound)
    expect(write.params[6]).toBe(false)
  })

  it('no identity because the ORG has no active integration => retryable (self-heals), not skipped', async () => {
    const h = harness({ claimed: [pendingRow()], linked: [], fallback: [], orgHasActiveIntegration: false })
    const result = await h.worker.runBatch()
    expect(result).toMatchObject({ retrying: 1, skipped: 0 })
    const write = h.writes()[0]
    expect(write.sql).toContain('SET status = $7')
    expect(write.params[6]).toBe('pending')
    expect(write.params[2]).toBe(TODO_MIRROR_ERROR_CODES.orgIntegrationInactive)
  })

  it('the identity join is ORG-SCOPED on both the primary and the fallback path', async () => {
    const h = harness({ claimed: [pendingRow()], linked: [], fallback: [{ integration_id: 'integ-2', provider_union_id: 'union-oauth' }] })
    await h.worker.runBatch()
    const primary = h.calls.find((c) => c.sql.includes('FROM directory_account_links'))!
    expect(primary.sql).toContain('AND i.org_id = $2')
    expect(primary.sql).toContain("AND l.link_status = 'linked'")
    expect(primary.sql).toContain('AND a.is_active = true')
    expect(primary.params).toEqual(['user-1', 'org-1'])
    const fallback = h.calls.find((c) => c.sql.includes('FROM user_external_identities'))!
    // the fallback may NOT resolve a foreign corp: it is joined to an ACTIVE integration of THIS org
    expect(fallback.sql).toContain('ON i.corp_id = e.corp_id')
    expect(fallback.sql).toContain('AND i.org_id = $2')
    expect(fallback.params).toEqual(['user-1', 'org-1'])
    expect(h.createTodoTask.mock.calls[0][2]).toMatchObject({ executorUnionIds: ['union-oauth'] })
  })

  it('two candidate identities are a data anomaly: it FAILS instead of guessing a corp account', async () => {
    const h = harness({
      claimed: [pendingRow()],
      linked: [
        { integration_id: 'integ-1', union_id: 'union-a' },
        { integration_id: 'integ-2', union_id: 'union-b' },
      ],
    })
    const result = await h.worker.runBatch()
    expect(result).toMatchObject({ failed: 1, created: 0 })
    expect(h.createTodoTask).not.toHaveBeenCalled()
    expect(h.writes()[0].params[4]).toBe('failed')
    expect(h.writes()[0].params[5]).toBe(TODO_MIRROR_ERROR_CODES.recipientAmbiguous)
    // nothing was sent, so an operator MAY requeue it once the duplicate links are cleaned up
    expect(h.writes()[0].params[6]).toBe(true)
  })

  it('a missing todoOperatorUnionId is retryable (the owner prerequisite can still be filled in)', async () => {
    const h = harness({ claimed: [pendingRow()], linked: [{ integration_id: 'integ-1', union_id: 'u' }], operatorUnionId: '' })
    const result = await h.worker.runBatch()
    expect(result).toMatchObject({ retrying: 1 })
    expect(h.createTodoTask).not.toHaveBeenCalled()
    expect(h.writes()[0].params[2]).toBe(TODO_MIRROR_ERROR_CODES.operatorMissing)
  })

  it('an OUTCOME-UNKNOWN send is TERMINAL: outcome_unknown, redelivery_safe=false, one attempt only', async () => {
    const unknown = Object.assign(new TypeError('fetch failed'), { outcomeUnknown: true })
    const h = harness({
      claimed: [pendingRow()],
      linked: [{ integration_id: 'integ-1', union_id: 'u' }],
      createTodoTask: vi.fn(async () => { throw unknown }),
    })
    const result = await h.worker.runBatch()
    expect(result).toMatchObject({ outcomeUnknown: 1, retrying: 0, failed: 0 })
    expect(h.createTodoTask).toHaveBeenCalledTimes(1)
    const write = h.writes()[0]
    expect(write.params[4]).toBe('outcome_unknown')
    expect(write.params[5]).toBe(TODO_MIRROR_ERROR_CODES.createOutcomeUnknown)
    // NEVER redelivery-safe: the todo may exist, so no operator action may resend it
    expect(write.params[6]).toBe(false)
  })

  it('a DEFINITE rejection is failed + redelivery_safe (nothing was created)', async () => {
    const h = harness({
      claimed: [pendingRow()],
      linked: [{ integration_id: 'integ-1', union_id: 'u' }],
      createTodoTask: vi.fn(async () => { throw new DingTalkBusinessError('bad param', { code: 'InvalidParameter' }) }),
    })
    const result = await h.worker.runBatch()
    expect(result).toMatchObject({ failed: 1 })
    const write = h.writes()[0]
    expect(write.params[4]).toBe('failed')
    expect(write.params[5]).toBe(TODO_MIRROR_ERROR_CODES.createFailed)
    expect(write.params[6]).toBe(true)
  })

  it('a retryable failure dead-letters once the attempt budget is spent', async () => {
    const h = harness({
      claimed: [pendingRow({ attempt_count: 5 })],
      linked: [{ integration_id: 'integ-1', union_id: 'u' }],
      readConfig: async () => { throw new Error('config unavailable') },
    })
    const result = await h.worker.runBatch()
    expect(result).toMatchObject({ failed: 1, retrying: 0 })
    expect(h.writes()[0].params[4]).toBe('failed')
  })

  it('last_error is always a FIXED code — never a DingTalk message, never a value', async () => {
    const h = harness({
      claimed: [pendingRow()],
      linked: [{ integration_id: 'integ-1', union_id: 'u' }],
      createTodoTask: vi.fn(async () => { throw new DingTalkBusinessError('张三 的待办创建失败: 主题「备料审批 REQ-0001」', { code: 'X' }) }),
    })
    await h.worker.runBatch()
    const written = h.writes()[0].params.map((p) => String(p)).join('|')
    expect(written).toContain(TODO_MIRROR_ERROR_CODES.createFailed)
    expect(written).not.toContain('张三')
    expect(written).not.toContain('REQ-0001')
  })
})

describe('todo mirror worker — completion phase', () => {
  const completingRow = () => pendingRow({ status: 'completing', dingtalk_task_id: 'dt-task-1', integration_id: 'integ-1', recipient_union_id: 'u' })

  it('marks the mirrored todo done and CAS-writes `completed`', async () => {
    const h = harness({ claimed: [completingRow()] })
    const result = await h.worker.runBatch()
    expect(result).toMatchObject({ completed: 1 })
    expect(h.completeTodoTask).toHaveBeenCalledWith('access-token', 'op-union-1', 'dt-task-1', {})
    expect(h.writes()[0].params[4]).toBe('completed')
  })

  it('a todo DingTalk says does not exist counts as completed (already cleaned up)', async () => {
    const h = harness({
      claimed: [completingRow()],
      completeTodoTask: vi.fn(async () => { throw new DingTalkRequestError('not found', 404, null) }),
    })
    const result = await h.worker.runBatch()
    expect(result).toMatchObject({ completed: 1, failed: 0 })
    expect(h.writes()[0].params[4]).toBe('completed')
  })

  it('a retry of the COMPLETION phase goes back to `completing`, never to `pending` (no second todo)', async () => {
    const h = harness({
      claimed: [completingRow()],
      completeTodoTask: vi.fn(async () => { throw new Error('socket hang up') }),
    })
    const result = await h.worker.runBatch()
    expect(result).toMatchObject({ retrying: 1 })
    const write = h.writes()[0]
    expect(write.params[6]).toBe('completing')
    expect(write.params[7]).toBe('completing')
  })

  it('an ambiguous completion is outcome_unknown (terminal), never resent', async () => {
    const unknown = Object.assign(new Error('timeout'), { outcomeUnknown: true })
    const h = harness({ claimed: [completingRow()], completeTodoTask: vi.fn(async () => { throw unknown }) })
    const result = await h.worker.runBatch()
    expect(result).toMatchObject({ outcomeUnknown: 1 })
    expect(h.writes()[0].params[4]).toBe('outcome_unknown')
    expect(h.writes()[0].params[6]).toBe(false)
  })

  it('a completing row with no task id fails WITHOUT being redelivery-safe (operator must look)', async () => {
    const h = harness({ claimed: [pendingRow({ status: 'completing', dingtalk_task_id: null, integration_id: 'integ-1' })] })
    const result = await h.worker.runBatch()
    expect(result).toMatchObject({ failed: 1 })
    expect(h.writes()[0].params[5]).toBe(TODO_MIRROR_ERROR_CODES.missingTaskId)
    expect(h.writes()[0].params[6]).toBe(false)
  })
})

describe('todo mirror worker — operator requeue gate', () => {
  /**
   * MUTATION-SENSITIVE fake: it EVALUATES the gate predicates that are actually present in the SQL
   * against an in-memory row instead of returning a canned rowCount. Delete `AND status = 'failed'` or
   * `AND redelivery_safe = true` from the production statement and this fake starts matching rows the
   * gate is supposed to refuse — which is exactly what the tests below assert it must not.
   */
  function requeueHarness(
    row: { status: string; org_id?: string; redelivery_safe?: boolean; dingtalk_task_id?: string | null } | null,
  ) {
    const calls: Call[] = []
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params })
      if (sql.includes('UPDATE dingtalk_todo_mirrors') && sql.includes('SET status =')) {
        if (!row) return { rows: [], rowCount: 0 }
        const statusGate = !sql.includes("AND status = 'failed'") || row.status === 'failed'
        const safeGate = !sql.includes('AND redelivery_safe = true') || row.redelivery_safe === true
        if (!statusGate || !safeGate) return { rows: [], rowCount: 0 }
        const restoresPhase = sql.includes("CASE WHEN dingtalk_task_id IS NOT NULL THEN 'completing' ELSE 'pending' END")
        const nextStatus = restoresPhase && row.dingtalk_task_id ? 'completing' : 'pending'
        return { rows: [{ org_id: row.org_id ?? 'org-1', status: nextStatus }], rowCount: 1 }
      }
      return row ? { rows: [{ status: row.status, org_id: row.org_id ?? 'org-1' }], rowCount: 1 } : { rows: [], rowCount: 0 }
    })
    return { query, calls }
  }

  it('failed + redelivery_safe => requeued, and the PHASE is restored (task id present => completing)', async () => {
    const h = requeueHarness({ status: 'failed', redelivery_safe: true, dingtalk_task_id: 'dt-1' })
    const result = await requeueFailedDingTalkTodoMirror(h.query as never, '11111111-1111-4111-8111-111111111111')
    expect(result.outcome).toBe('requeued')
    expect(result.status).toBe('completing')
    const gate = h.calls[0]
    // BOTH gate predicates are load-bearing
    expect(gate.sql).toContain("AND status = 'failed'")
    expect(gate.sql).toContain('AND redelivery_safe = true')
    // and the phase restore, not a blanket reset to pending
    expect(gate.sql).toContain("SET status = CASE WHEN dingtalk_task_id IS NOT NULL THEN 'completing' ELSE 'pending' END")
  })

  it('outcome_unknown is REFUSED (never resent, distinct operator-review bucket)', async () => {
    // a row that ALREADY reached outcome_unknown: its send may have landed, so no gate may requeue it
    const h = requeueHarness({ status: 'outcome_unknown', redelivery_safe: true })
    const result = await requeueFailedDingTalkTodoMirror(h.query as never, '11111111-1111-4111-8111-111111111111')
    expect(result.outcome).toBe('refused_outcome_unknown')
    expect(result.status).toBe('outcome_unknown')
  })

  it('a failed row that is NOT redelivery-safe is not_eligible', async () => {
    const h = requeueHarness({ status: 'failed', redelivery_safe: false })
    const result = await requeueFailedDingTalkTodoMirror(h.query as never, '11111111-1111-4111-8111-111111111111')
    expect(result.outcome).toBe('not_eligible')
  })

  it('an already-delivered row is a no-op, and an unknown id is not_found', async () => {
    expect((await requeueFailedDingTalkTodoMirror(requeueHarness({ status: 'created' }).query as never, 'x')).outcome).toBe('already_delivered')
    expect((await requeueFailedDingTalkTodoMirror(requeueHarness({ status: 'completed' }).query as never, 'x')).outcome).toBe('already_delivered')
    expect((await requeueFailedDingTalkTodoMirror(requeueHarness(null).query as never, 'x')).outcome).toBe('not_found')
    expect((await requeueFailedDingTalkTodoMirror(requeueHarness(null).query as never, '  ')).outcome).toBe('not_found')
  })
})

describe('todo mirror worker — pure helpers', () => {
  it('the backoff ladder is the attendance ladder (1m/5m/15m/60m/6h)', () => {
    expect([1, 2, 3, 4, 5, 9].map(computeTodoMirrorBackoffMs)).toEqual([
      60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 6 * 60 * 60_000,
    ])
  })

  it('the subject carries the template name and request no ONLY, and degrades gracefully', () => {
    expect(buildTodoMirrorSubject({ templateName: '备料审批', requestNo: 'REQ-1' })).toBe('审批待处理：备料审批 REQ-1')
    expect(buildTodoMirrorSubject({ templateName: null, requestNo: 'REQ-1' })).toBe('审批待处理：REQ-1')
    expect(buildTodoMirrorSubject({ templateName: null, requestNo: null })).toBe('审批待处理')
  })

  it('the deep link points at the platform approval detail and is empty without a base url', () => {
    expect(buildTodoMirrorDetailUrl('https://app.example.com/', 'inst-1')).toBe('https://app.example.com/approvals/inst-1')
    expect(buildTodoMirrorDetailUrl('', 'inst-1')).toBe('')
    expect(resolveTodoMirrorAppBaseUrl({ APP_BASE_URL: 'https://b' } as NodeJS.ProcessEnv)).toBe('https://b')
    expect(resolveTodoMirrorAppBaseUrl({} as NodeJS.ProcessEnv)).toBe('')
  })

  it('"task missing" recognizes a 404 and a not-exist business code, and nothing else', () => {
    expect(isDingTalkTodoTaskMissing(new DingTalkRequestError('gone', 404, null))).toBe(true)
    expect(isDingTalkTodoTaskMissing(new DingTalkBusinessError('x', { code: 'todoTaskNotExist' }))).toBe(true)
    expect(isDingTalkTodoTaskMissing(new DingTalkRequestError('server', 500, null))).toBe(false)
    expect(isDingTalkTodoTaskMissing(new DingTalkBusinessError('x', { code: 'Forbidden' }))).toBe(false)
    expect(isDingTalkTodoTaskMissing(new Error('boom'))).toBe(false)
  })
})
