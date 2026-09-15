/**
 * DingTalk approval-todo ONE-WAY mirror — the DELIVERY half (design
 * docs/development/takeover-beiliao-20260821/dingtalk-todo-mirror-b-design-20260916.md §4/§5/§9).
 *
 * Unit-level DI (query / config / token / todo transport injected), the same discipline as
 * attendance-dingtalk-outcome-unknown.test.ts: nothing here reaches the network or a database.
 *
 * ERROR SHAPES ARE THE REACHABLE ONES (Q19 re-review). The three todo endpoints go through
 * `requestDingTalkJson` with `envelope: 'none'` (client.ts:193-197), and the transport only ever raises
 * `DingTalkBusinessError` for `envelope: 'oapi'` (transport.ts:398-404) — so a todo call can raise
 * `DingTalkRequestError` / `DingTalkTimeoutError` / `DingTalkMalformedResponseError`, never a business
 * error. Every send-path case below therefore uses `DingTalkRequestError`; the `DingTalkBusinessError`
 * cases survive only as assertions on the PURE predicates, explicitly labelled unreachable.
 *
 * The load-bearing behaviours pinned here:
 *   - claim takes a LEASE with FOR UPDATE SKIP LOCKED and NEVER matches a terminal row;
 *   - every terminal write is a CAS on (status, claim_worker_id, attempt_count) — a stolen lease
 *     writes nothing ("lost-lease") and, for a create, sends NOTHING;
 *   - an outcome-UNKNOWN send terminates as `outcome_unknown`, never retried, never redelivery-safe,
 *     and the operator requeue gate refuses it;
 *   - a RE-CLAIMED in-flight send is ambiguous and terminates the same way — it is never re-sent;
 *   - 429/408 are TRANSIENT and ride the backoff ladder; other 4xx are definite;
 *   - a seat that dies WHILE the create is in flight is retired right after the create;
 *   - identity resolution is org-scoped and never guesses between two candidates;
 *   - the operator requeue gate is org-scoped, needs failed + redelivery_safe, and refuses to mint a
 *     todo for a seat that is no longer live.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  DingTalkTodoMirrorWorker,
  TODO_MIRROR_ERROR_CODES,
  buildTodoMirrorDetailUrl,
  buildTodoMirrorSubject,
  computeTodoMirrorBackoffMs,
  isDingTalkTodoTaskMissing,
  parseTodoMirrorRequeueArgv,
  requeueFailedDingTalkTodoMirror,
  resolveTodoMirrorAppBaseUrl,
  runDingTalkTodoMirrorRequeueCli,
  todoMirrorReasonFromInstanceStatus,
  type TodoMirrorRow,
} from '../../src/services/dingtalk-todo-mirror-worker'
import { DingTalkBusinessError, DingTalkRequestError } from '../../src/integrations/dingtalk/client'

type Call = { sql: string; params: unknown[] }

const CONFIG = { appKey: 'k', appSecret: 's', agentId: '42' }
const ROW_ID = '11111111-1111-4111-8111-111111111111'

function pendingRow(over: Partial<TodoMirrorRow> = {}): TodoMirrorRow {
  return {
    id: ROW_ID,
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
    prior_status: 'pending',
    send_issued_at: null,
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
  /** Injected app-access-token fetch (the READ tier before the create request). */
  fetchAccessToken?: () => Promise<string>
  maxAttempts?: number
  /** post-create liveness probe: is the approval seat still an ACTIVE assignment? */
  seatLive?: boolean
  instanceStatus?: string
}

function harness(options: HarnessOptions = {}) {
  const calls: Call[] = []
  /** Ordered stage trace — the only way to see a NON-query stage (the token fetch) in the sequence. */
  const trace: string[] = []
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params })
    if (sql.includes('UPDATE dingtalk_todo_mirrors')) {
      trace.push(
        sql.includes('WITH claim AS') ? 'claim' : sql.includes('SET send_issued_at') ? 'send_issued_at' : 'mirror_write',
      )
    }
    if (sql.includes('WITH claim AS')) return { rows: options.claimed ?? [], rowCount: (options.claimed ?? []).length }
    // checked BEFORE the generic `SELECT EXISTS` branch: this is the post-create seat probe
    if (sql.includes('AS seat_live')) {
      return {
        rows: [{ seat_live: options.seatLive ?? true, instance_status: options.instanceStatus ?? 'pending' }],
        rowCount: 1,
      }
    }
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
    fetchAccessToken: async () => {
      trace.push('token')
      return options.fetchAccessToken ? options.fetchAccessToken() : 'access-token'
    },
    resolveOperatorUnionId: async () => (options.operatorUnionId === undefined ? 'op-union-1' : options.operatorUnionId),
    createTodoTask: createTodoTask as never,
    completeTodoTask: completeTodoTask as never,
    ...(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {}),
  })
  const mirrorUpdates = () => calls.filter((c) => c.sql.includes('UPDATE dingtalk_todo_mirrors') && !c.sql.includes('WITH claim AS'))
  // the claim statement also contains an UPDATE, and the pre-send `send_issued_at` stamp is a write of
  // its own - exclude both so `writes()` is the terminal/retry/created write only
  const writes = () => mirrorUpdates().filter((c) => !c.sql.includes('SET send_issued_at'))
  const sendStamps = () => mirrorUpdates().filter((c) => c.sql.includes('SET send_issued_at'))
  return { worker, query, calls, trace, writes, sendStamps, createTodoTask, completeTodoTask }
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
    // the PRE-claim status travels with the row: it is what tells a re-claimed in-flight send apart
    expect(claim.sql).toContain('SELECT id, status AS prior_status')
    expect(claim.sql).toContain('claim.prior_status')
    expect(claim.sql).toContain('d.send_issued_at')
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

  it('stamps send_issued_at under the SAME CAS AFTER the token fetch and immediately BEFORE the request', async () => {
    const h = harness({ claimed: [pendingRow()], linked: [{ integration_id: 'integ-1', union_id: 'u' }] })
    await h.worker.runBatch()
    const stamp = h.sendStamps()[0]
    expect(stamp).toBeDefined()
    expect(stamp.sql).toContain("AND status = 'sending'")
    expect(stamp.sql).toContain('AND claim_worker_id = $3')
    expect(stamp.sql).toContain('AND attempt_count = $4::int')
    // it really is BEFORE the send: the stamp is the first non-claim mirror write of the batch
    const stampIdx = h.calls.findIndex((c) => c.sql.includes('SET send_issued_at'))
    const createdIdx = h.calls.findIndex((c) => c.sql.includes("SET status = 'created'"))
    expect(stampIdx).toBeGreaterThan(0)
    expect(stampIdx).toBeLessThan(createdIdx)
    // ...and AFTER the READ-tier token fetch (Q19 judge item): the stamp means "a create request left
    // this process", so no stage that issues nothing may run between it and createTodoTask.
    expect(h.trace).toEqual(['claim', 'token', 'send_issued_at', 'mirror_write'])
  })

  it('a stolen lease (CAS matches 0 rows) sends NOTHING and reports lost-lease', async () => {
    const h = harness({ claimed: [pendingRow()], linked: [{ integration_id: 'integ-1', union_id: 'u' }], casRowCount: 0 })
    const result = await h.worker.runBatch()
    expect(result).toMatchObject({ claimed: 1, created: 0, lostLease: 1 })
    // the pre-send stamp IS the lease check: a worker whose lease was stolen must not reach DingTalk
    expect(h.createTodoTask).not.toHaveBeenCalled()
  })

  // Q19 judge item: the token fetch is a READ-tier call that issues NO create request. Both shapes below
  // must be retried like any other pre-send stage failure and must leave `send_issued_at` NULL — otherwise
  // a crash/timeout at the token stage is later judged "request issued" (terminal `outcome_unknown`,
  // never resent) for a todo that was never asked for. The AMBIGUOUS shape is the load-bearing one: with
  // the token fetch inside the create's try/catch it lands on the outcome_unknown arm.
  it.each([
    ['a transient token endpoint failure', () => new DingTalkRequestError('token endpoint unavailable', 503, { code: 'x' })],
    ['an AMBIGUOUS token failure (outcomeUnknown-marked)', () => Object.assign(new TypeError('fetch failed'), { outcomeUnknown: true })],
  ])('%s issues NOTHING: normal retry, never outcome_unknown, send_issued_at never stamped', async (_label, makeError) => {
    const h = harness({
      claimed: [pendingRow()],
      linked: [{ integration_id: 'integ-1', union_id: 'u' }],
      fetchAccessToken: async () => { throw makeError() },
    })
    const result = await h.worker.runBatch()
    expect(result).toMatchObject({ claimed: 1, retrying: 1, created: 0, outcomeUnknown: 0, failed: 0 })
    expect(h.createTodoTask).not.toHaveBeenCalled()
    // the token stage WAS reached, and still nothing was stamped: a re-claim of this row is a normal
    // create attempt (`deliver`'s NULL branch), not an ambiguous one.
    expect(h.trace).toEqual(['claim', 'token', 'mirror_write'])
    expect(h.sendStamps()).toHaveLength(0)
    const write = h.writes()[0]
    expect(write.sql).toContain('SET status = $7')
    expect(write.params[6]).toBe('pending')
    expect(write.params[2]).toBe(TODO_MIRROR_ERROR_CODES.tokenUnavailable)
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

  it('a DEFINITE rejection (HTTP 400, the shape an envelope:none endpoint really raises) is failed + redelivery_safe', async () => {
    const h = harness({
      claimed: [pendingRow()],
      linked: [{ integration_id: 'integ-1', union_id: 'u' }],
      createTodoTask: vi.fn(async () => { throw new DingTalkRequestError('bad request', 400, { code: 'InvalidParameter' }) }),
    })
    const result = await h.worker.runBatch()
    expect(result).toMatchObject({ failed: 1, retrying: 0 })
    const write = h.writes()[0]
    expect(write.params[4]).toBe('failed')
    expect(write.params[5]).toBe(TODO_MIRROR_ERROR_CODES.createFailed)
    expect(write.params[6]).toBe(true)
  })

  it.each([
    ['429 flow control', 429],
    ['408 gateway timeout', 408],
    ['503 bare 5xx', 503],
  ])('a TRANSIENT %s rides the backoff ladder instead of dead-lettering on attempt #1', async (_label, statusCode) => {
    const h = harness({
      claimed: [pendingRow()],
      linked: [{ integration_id: 'integ-1', union_id: 'u' }],
      createTodoTask: vi.fn(async () => { throw new DingTalkRequestError('transient', statusCode, { code: 'flowControl' }) }),
    })
    const result = await h.worker.runBatch()
    expect(result).toMatchObject({ retrying: 1, failed: 0, outcomeUnknown: 0 })
    const write = h.writes()[0]
    // back to `pending` (the create phase) on the 1m/5m/15m/60m/6h ladder, error code unchanged
    expect(write.params[6]).toBe('pending')
    expect(write.params[2]).toBe(TODO_MIRROR_ERROR_CODES.createFailed)
    expect(write.params[1]).toBe(new Date('2026-09-16T00:01:00.000Z').toISOString())
  })

  it('a completion that comes back 429 retries too (same classifier, completion phase)', async () => {
    const h = harness({
      claimed: [pendingRow({ status: 'completing', prior_status: 'completing', dingtalk_task_id: 'dt-task-1', integration_id: 'integ-1' })],
      completeTodoTask: vi.fn(async () => { throw new DingTalkRequestError('rate limited', 429, { code: 'flowControl' }) }),
    })
    const result = await h.worker.runBatch()
    expect(result).toMatchObject({ retrying: 1, failed: 0 })
    expect(h.writes()[0].params[6]).toBe('completing')
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
      createTodoTask: vi.fn(async () => {
        throw new DingTalkRequestError('张三 的待办创建失败: 主题「备料审批 REQ-0001」', 400, { code: 'X' })
      }),
    })
    await h.worker.runBatch()
    const written = h.writes()[0].params.map((p) => String(p)).join('|')
    expect(written).toContain(TODO_MIRROR_ERROR_CODES.createFailed)
    expect(written).not.toContain('张三')
    expect(written).not.toContain('REQ-0001')
  })
})

/**
 * REGRESSION (Q19 refuter): the claim predicate re-takes a `sending` row whose lease expired. Re-running
 * the create for one whose request was already ISSUED is the only place the ledger could resend an
 * ambiguous send — a duplicate todo whose first task id is lost forever.
 */
describe('todo mirror worker — a RE-CLAIMED in-flight send', () => {
  it('is ambiguous and TERMINAL when the request had already been issued: nothing is re-sent', async () => {
    const h = harness({
      claimed: [pendingRow({ prior_status: 'sending', send_issued_at: '2026-09-16T00:00:00.000Z', attempt_count: 2 })],
      linked: [{ integration_id: 'integ-1', union_id: 'u' }],
    })
    const result = await h.worker.runBatch()
    expect(result).toMatchObject({ outcomeUnknown: 1, created: 0, retrying: 0, failed: 0 })
    expect(h.createTodoTask).not.toHaveBeenCalled()
    const write = h.writes()[0]
    expect(write.params[4]).toBe('outcome_unknown')
    expect(write.params[5]).toBe(TODO_MIRROR_ERROR_CODES.createReclaimAmbiguous)
    // never redelivery-safe: no operator gate may resend it either
    expect(write.params[6]).toBe(false)
  })

  it('is a NORMAL create attempt when the lease died BEFORE anything was issued (no stamp)', async () => {
    const h = harness({
      claimed: [pendingRow({ prior_status: 'sending', send_issued_at: null, attempt_count: 2 })],
      linked: [{ integration_id: 'integ-1', union_id: 'u' }],
    })
    const result = await h.worker.runBatch()
    expect(result).toMatchObject({ created: 1, outcomeUnknown: 0 })
    expect(h.createTodoTask).toHaveBeenCalledTimes(1)
  })

  it('a re-claimed COMPLETION is unaffected (marking a done todo done again is idempotent)', async () => {
    const h = harness({
      claimed: [pendingRow({ status: 'completing', prior_status: 'completing', dingtalk_task_id: 'dt-task-1', integration_id: 'integ-1' })],
    })
    const result = await h.worker.runBatch()
    expect(result).toMatchObject({ completed: 1, outcomeUnknown: 0 })
  })
})

/**
 * REGRESSION (Q19 refuter): a terminal approval (or a node advance) that lands WHILE a row is `sending`
 * retires nothing — the consumer's sweeps skip `sending` on purpose (the lease is the worker's). The row
 * then settled into `created` and no event would ever come back for it, so the recipient kept an
 * actionable todo for a finished approval forever.
 */
describe('todo mirror worker — the seat dies while the create is in flight', () => {
  it('retires the row to `completing` right after the create when the seat is gone', async () => {
    const h = harness({
      claimed: [pendingRow()],
      linked: [{ integration_id: 'integ-1', union_id: 'u' }],
      seatLive: false,
      instanceStatus: 'approved',
    })
    const result = await h.worker.runBatch()
    expect(result).toMatchObject({ created: 1 })
    const probe = h.calls.find((c) => c.sql.includes('AS seat_live'))!
    expect(probe.sql).toContain('FROM approval_assignments a')
    expect(probe.sql).toContain('AND a.is_active = TRUE')
    expect(probe.params).toEqual(['inst-1', 'node-a', 'user-1', 1])
    const retire = h.writes().find((c) => c.sql.includes("SET status = 'completing'"))!
    expect(retire).toBeDefined()
    // the CAS makes it a no-op if a terminal event got there first
    expect(retire.sql).toContain("AND status = 'created'")
    expect(retire.params[1]).toBe('approved')
  })

  it('leaves a LIVE seat alone (no retire write at all)', async () => {
    const h = harness({ claimed: [pendingRow()], linked: [{ integration_id: 'integ-1', union_id: 'u' }], seatLive: true })
    await h.worker.runBatch()
    expect(h.writes().some((c) => c.sql.includes("SET status = 'completing'"))).toBe(false)
  })

  it('maps the instance status to the complete_reason, defaulting to a plain node advance', () => {
    expect(todoMirrorReasonFromInstanceStatus('approved')).toBe('approved')
    expect(todoMirrorReasonFromInstanceStatus('REJECTED')).toBe('rejected')
    expect(todoMirrorReasonFromInstanceStatus('revoked')).toBe('revoked')
    expect(todoMirrorReasonFromInstanceStatus('canceled')).toBe('cancelled')
    expect(todoMirrorReasonFromInstanceStatus('cancelled')).toBe('cancelled')
    expect(todoMirrorReasonFromInstanceStatus('pending')).toBe('next_node')
    expect(todoMirrorReasonFromInstanceStatus(null)).toBe('next_node')
  })
})

describe('todo mirror worker — completion phase', () => {
  const completingRow = () => pendingRow({ status: 'completing', prior_status: 'completing', dingtalk_task_id: 'dt-task-1', integration_id: 'integ-1', recipient_union_id: 'u' })

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
      completeTodoTask: vi.fn(async () => { throw new DingTalkRequestError('not found', 404, { code: 'todoTaskNotExist' }) }),
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
    // and a retry clears the send marker, so a later re-claim cannot read a stale "request issued"
    expect(write.sql).toContain('send_issued_at = NULL')
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
    const h = harness({ claimed: [pendingRow({ status: 'completing', prior_status: 'completing', dingtalk_task_id: null, integration_id: 'integ-1' })] })
    const result = await h.worker.runBatch()
    expect(result).toMatchObject({ failed: 1 })
    expect(h.writes()[0].params[5]).toBe(TODO_MIRROR_ERROR_CODES.missingTaskId)
    expect(h.writes()[0].params[6]).toBe(false)
  })
})

describe('todo mirror worker — operator requeue gate', () => {
  /**
   * MUTATION-SENSITIVE fake: it EVALUATES the gate predicates that are actually present in the SQL
   * against an in-memory row instead of returning a canned rowCount. Delete `AND status = 'failed'`,
   * `AND redelivery_safe = true`, `AND org_id = $2` or the seat-liveness arm from the production
   * statement and this fake starts matching rows the gate is supposed to refuse — which is exactly what
   * the tests below assert it must not.
   */
  function requeueHarness(
    row: { status: string; org_id?: string; redelivery_safe?: boolean; dingtalk_task_id?: string | null; seatLive?: boolean } | null,
  ) {
    const calls: Call[] = []
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params })
      const orgId = row?.org_id ?? 'org-1'
      if (sql.includes('UPDATE dingtalk_todo_mirrors') && sql.includes('SET status =')) {
        if (!row) return { rows: [], rowCount: 0 }
        const orgGate = !sql.includes('AND org_id = $2') || orgId === params[1]
        const statusGate = !sql.includes("AND status = 'failed'") || row.status === 'failed'
        const safeGate = !sql.includes('AND redelivery_safe = true') || row.redelivery_safe === true
        const seatGated = /OR EXISTS \(\s*SELECT 1 FROM approval_assignments/.test(sql)
        const seatGate = !seatGated || Boolean(row.dingtalk_task_id) || row.seatLive === true
        if (!orgGate || !statusGate || !safeGate || !seatGate) return { rows: [], rowCount: 0 }
        const restoresPhase = sql.includes("CASE WHEN dingtalk_task_id IS NOT NULL THEN 'completing' ELSE 'pending' END")
        const nextStatus = restoresPhase && row.dingtalk_task_id ? 'completing' : 'pending'
        return { rows: [{ org_id: orgId, status: nextStatus }], rowCount: 1 }
      }
      // the read-back is org-scoped too: another org's row is simply not there
      if (!row) return { rows: [], rowCount: 0 }
      if (sql.includes('AND org_id = $2') && orgId !== params[1]) return { rows: [], rowCount: 0 }
      return {
        rows: [{ status: row.status, org_id: orgId, redelivery_safe: row.redelivery_safe ?? false }],
        rowCount: 1,
      }
    })
    return { query, calls }
  }

  it('failed + redelivery_safe => requeued, and the PHASE is restored (task id present => completing)', async () => {
    const h = requeueHarness({ status: 'failed', redelivery_safe: true, dingtalk_task_id: 'dt-1' })
    const result = await requeueFailedDingTalkTodoMirror(h.query as never, { id: ROW_ID, orgId: 'org-1' })
    expect(result.outcome).toBe('requeued')
    expect(result.status).toBe('completing')
    const gate = h.calls[0]
    // ALL of the gate predicates are load-bearing
    expect(gate.sql).toContain('AND org_id = $2')
    expect(gate.sql).toContain("AND status = 'failed'")
    expect(gate.sql).toContain('AND redelivery_safe = true')
    // and the phase restore, not a blanket reset to pending
    expect(gate.sql).toContain("SET status = CASE WHEN dingtalk_task_id IS NOT NULL THEN 'completing' ELSE 'pending' END")
  })

  it('a row of ANOTHER org is not_found — never requeued, never described back', async () => {
    const h = requeueHarness({ status: 'failed', org_id: 'org-2', redelivery_safe: true, seatLive: true })
    const result = await requeueFailedDingTalkTodoMirror(h.query as never, { id: ROW_ID, orgId: 'org-1' })
    expect(result.outcome).toBe('not_found')
    expect(result.status).toBeNull()
  })

  it('a create requeue whose approval SEAT is gone is refused (no todo for a finished approval)', async () => {
    const h = requeueHarness({ status: 'failed', redelivery_safe: true, dingtalk_task_id: null, seatLive: false })
    const result = await requeueFailedDingTalkTodoMirror(h.query as never, { id: ROW_ID, orgId: 'org-1' })
    expect(result.outcome).toBe('refused_seat_gone')
    const gate = h.calls[0]
    expect(gate.sql).toContain('FROM approval_assignments a')
    expect(gate.sql).toContain('AND a.is_active = TRUE')
  })

  it('a create requeue whose seat is STILL live is requeued to `pending`', async () => {
    const h = requeueHarness({ status: 'failed', redelivery_safe: true, dingtalk_task_id: null, seatLive: true })
    const result = await requeueFailedDingTalkTodoMirror(h.query as never, { id: ROW_ID, orgId: 'org-1' })
    expect(result.outcome).toBe('requeued')
    expect(result.status).toBe('pending')
  })

  it('outcome_unknown is REFUSED (never resent, distinct operator-review bucket)', async () => {
    // a row that ALREADY reached outcome_unknown: its send may have landed, so no gate may requeue it
    const h = requeueHarness({ status: 'outcome_unknown', redelivery_safe: true })
    const result = await requeueFailedDingTalkTodoMirror(h.query as never, { id: ROW_ID, orgId: 'org-1' })
    expect(result.outcome).toBe('refused_outcome_unknown')
    expect(result.status).toBe('outcome_unknown')
  })

  it('a failed row that is NOT redelivery-safe is not_eligible', async () => {
    const h = requeueHarness({ status: 'failed', redelivery_safe: false })
    const result = await requeueFailedDingTalkTodoMirror(h.query as never, { id: ROW_ID, orgId: 'org-1' })
    expect(result.outcome).toBe('not_eligible')
  })

  it('an already-delivered row is a no-op, and an unknown id or a blank scope is not_found', async () => {
    const delivered = async (status: string) => (await requeueFailedDingTalkTodoMirror(
      requeueHarness({ status }).query as never,
      { id: ROW_ID, orgId: 'org-1' },
    )).outcome
    expect(await delivered('created')).toBe('already_delivered')
    expect(await delivered('completed')).toBe('already_delivered')
    expect((await requeueFailedDingTalkTodoMirror(requeueHarness(null).query as never, { id: ROW_ID, orgId: 'org-1' })).outcome).toBe('not_found')
    expect((await requeueFailedDingTalkTodoMirror(requeueHarness(null).query as never, { id: '  ', orgId: 'org-1' })).outcome).toBe('not_found')
    // no org scope => nothing happens at all (fail closed), not "any org"
    const blankOrg = requeueHarness({ status: 'failed', redelivery_safe: true, dingtalk_task_id: 'dt-1' })
    expect((await requeueFailedDingTalkTodoMirror(blankOrg.query as never, { id: ROW_ID, orgId: '' })).outcome).toBe('not_found')
    expect(blankOrg.calls).toEqual([])
  })

  it('the operator CLI is the production caller: it parses --id/--org and reports values-free', async () => {
    expect(parseTodoMirrorRequeueArgv(['--id', ROW_ID, '--org', 'org-1'])).toEqual({ id: ROW_ID, orgId: 'org-1' })
    expect(parseTodoMirrorRequeueArgv(['--id', ROW_ID])).toBeNull()
    expect(parseTodoMirrorRequeueArgv([])).toBeNull()

    const h = requeueHarness({ status: 'failed', redelivery_safe: true, dingtalk_task_id: 'dt-1' })
    const ok = await runDingTalkTodoMirrorRequeueCli(h.query as never, ['--id', ROW_ID, '--org', 'org-1'])
    expect(ok.exitCode).toBe(0)
    expect(ok.report).toMatchObject({ operation: 'dingtalk_todo_mirror_requeue', outcome: 'requeued', status: 'completing', valuesFree: true })

    const refused = await runDingTalkTodoMirrorRequeueCli(
      requeueHarness({ status: 'outcome_unknown', redelivery_safe: true }).query as never,
      ['--id', ROW_ID, '--org', 'org-1'],
    )
    expect(refused.exitCode).toBe(2)
    expect(refused.report).toMatchObject({ outcome: 'refused_outcome_unknown' })

    const usage = await runDingTalkTodoMirrorRequeueCli(requeueHarness(null).query as never, [])
    expect(usage.exitCode).toBe(1)
    expect(usage.report).toMatchObject({ outcome: 'usage' })
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

  it('"task missing" recognizes a 404 and nothing else on the reachable shape', () => {
    expect(isDingTalkTodoTaskMissing(new DingTalkRequestError('gone', 404, { code: 'todoTaskNotExist' }))).toBe(true)
    expect(isDingTalkTodoTaskMissing(new DingTalkRequestError('server', 500, null))).toBe(false)
    expect(isDingTalkTodoTaskMissing(new DingTalkRequestError('rate limited', 429, null))).toBe(false)
    expect(isDingTalkTodoTaskMissing(new Error('boom'))).toBe(false)
    // UNREACHABLE for envelope:'none' endpoints (transport.ts:398-404 raises this class for 'oapi'
    // only) — kept as a predicate-level assertion, never as coverage of the todo send path.
    expect(isDingTalkTodoTaskMissing(new DingTalkBusinessError('x', { code: 'todoTaskNotExist' }))).toBe(true)
    expect(isDingTalkTodoTaskMissing(new DingTalkBusinessError('x', { code: 'Forbidden' }))).toBe(false)
  })
})
