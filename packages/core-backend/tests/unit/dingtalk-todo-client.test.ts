/**
 * DingTalk TODO client (design §6/§9) — FIXTURED responses only, never the real network.
 *
 * Four response classes per the design's verification matrix: success / business rejection /
 * timeout / malformed 2xx. The three calls are `kind: 'send'`, so the transport must NEVER retry them
 * and must mark the ambiguous classes `isDingTalkOutcomeUnknown` — that marker is exactly what the
 * mirror ledger turns into the terminal `outcome_unknown` state instead of a duplicate todo.
 *
 * Credentials in this file are obviously fake.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  DingTalkMalformedResponseError,
  DingTalkRequestError,
  DingTalkTimeoutError,
  createDingTalkTodoTask,
  completeDingTalkTodoTask,
  deleteDingTalkTodoTask,
  isDingTalkOutcomeUnknown,
} from '../../src/integrations/dingtalk/client'

const TOKEN = 'fake-access-token'
const OPERATOR = 'fake-operator-union-id'

function okResponse(body: unknown) {
  return vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body }))
}

function errorResponse(status: number, body: unknown) {
  return vi.fn(async () => ({ ok: false, status, headers: { get: () => null }, json: async () => body }))
}

describe('createDingTalkTodoTask', () => {
  it('POSTs the v1.0 todo endpoint with the access-token header and the executor-only body', async () => {
    const fetchFn = okResponse({ id: 'todo-123' })
    const result = await createDingTalkTodoTask(
      TOKEN,
      OPERATOR,
      {
        sourceId: 'approval-task:inst-1:node-a:1:user-1',
        subject: '审批待处理：备料审批 REQ-1',
        creatorUnionId: OPERATOR,
        executorUnionIds: ['fake-executor-union-id'],
        detailUrl: 'https://app.example.com/approvals/inst-1',
      },
      {},
      { fetchFn: fetchFn as never },
    )
    expect(result.taskId).toBe('todo-123')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`https://api.dingtalk.com/v1.0/todo/users/${OPERATOR}/tasks`)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['x-acs-dingtalk-access-token']).toBe(TOKEN)
    expect(JSON.parse(String(init.body))).toEqual({
      sourceId: 'approval-task:inst-1:node-a:1:user-1',
      subject: '审批待处理：备料审批 REQ-1',
      creatorId: OPERATOR,
      executorIds: ['fake-executor-union-id'],
      isOnlyShowExecutor: true,
      notifyConfigs: { dingNotify: '1' },
      detailUrl: { appUrl: 'https://app.example.com/approvals/inst-1', pcUrl: 'https://app.example.com/approvals/inst-1' },
    })
  })

  it('a business rejection (4xx) throws DingTalkRequestError and is NOT outcome-unknown', async () => {
    const fetchFn = errorResponse(400, { code: 'InvalidParameter', message: 'bad sourceId' })
    const error = await createDingTalkTodoTask(
      TOKEN, OPERATOR,
      { sourceId: 's', subject: 'x', creatorUnionId: OPERATOR, executorUnionIds: ['e'] },
      {}, { fetchFn: fetchFn as never },
    ).catch((e) => e)
    expect(error).toBeInstanceOf(DingTalkRequestError)
    expect((error as DingTalkRequestError).statusCode).toBe(400)
    expect(isDingTalkOutcomeUnknown(error)).toBe(false)
    // send tier: definitely rejected, definitely ONE attempt
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('a timeout is OUTCOME-UNKNOWN and is never retried (the todo may exist)', async () => {
    const fetchFn = vi.fn(async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }) })
    const error = await createDingTalkTodoTask(
      TOKEN, OPERATOR,
      { sourceId: 's', subject: 'x', creatorUnionId: OPERATOR, executorUnionIds: ['e'] },
      {}, { fetchFn: fetchFn as never },
    ).catch((e) => e)
    expect(error).toBeInstanceOf(DingTalkTimeoutError)
    expect(isDingTalkOutcomeUnknown(error)).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('a malformed 2xx never normalizes to success — it is OUTCOME-UNKNOWN', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => { throw new SyntaxError('Unexpected token < in JSON') },
    }))
    const error = await createDingTalkTodoTask(
      TOKEN, OPERATOR,
      { sourceId: 's', subject: 'x', creatorUnionId: OPERATOR, executorUnionIds: ['e'] },
      {}, { fetchFn: fetchFn as never },
    ).catch((e) => e)
    expect(error).toBeInstanceOf(DingTalkMalformedResponseError)
    expect(isDingTalkOutcomeUnknown(error)).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('a 5xx is outcome-unknown too (the request reached DingTalk), and is never resent', async () => {
    const fetchFn = errorResponse(502, {})
    const error = await createDingTalkTodoTask(
      TOKEN, OPERATOR,
      { sourceId: 's', subject: 'x', creatorUnionId: OPERATOR, executorUnionIds: ['e'] },
      {}, { fetchFn: fetchFn as never },
    ).catch((e) => e)
    expect(isDingTalkOutcomeUnknown(error)).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('refuses to send with a blank required field (no half-formed todo ever leaves)', async () => {
    const fetchFn = okResponse({ id: 'x' })
    const base = { sourceId: 's', subject: 'x', creatorUnionId: OPERATOR, executorUnionIds: ['e'] }
    await expect(createDingTalkTodoTask('', OPERATOR, base, {}, { fetchFn: fetchFn as never })).rejects.toThrow(/access token/)
    await expect(createDingTalkTodoTask(TOKEN, '  ', base, {}, { fetchFn: fetchFn as never })).rejects.toThrow(/operator unionId/)
    await expect(createDingTalkTodoTask(TOKEN, OPERATOR, { ...base, sourceId: ' ' }, {}, { fetchFn: fetchFn as never })).rejects.toThrow(/sourceId/)
    await expect(createDingTalkTodoTask(TOKEN, OPERATOR, { ...base, subject: '' }, {}, { fetchFn: fetchFn as never })).rejects.toThrow(/subject/)
    await expect(createDingTalkTodoTask(TOKEN, OPERATOR, { ...base, executorUnionIds: [] }, {}, { fetchFn: fetchFn as never })).rejects.toThrow(/executorIds/)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('omits detailUrl entirely when no public base url is configured', async () => {
    const fetchFn = okResponse({ id: 'todo-9' })
    await createDingTalkTodoTask(
      TOKEN, OPERATOR,
      { sourceId: 's', subject: 'x', creatorUnionId: OPERATOR, executorUnionIds: ['e'] },
      {}, { fetchFn: fetchFn as never },
    )
    const body = JSON.parse(String((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(body.detailUrl).toBeUndefined()
  })
})

describe('completeDingTalkTodoTask / deleteDingTalkTodoTask', () => {
  it('PUTs done:true against the operator + task path', async () => {
    const fetchFn = okResponse({ result: true })
    const result = await completeDingTalkTodoTask(TOKEN, OPERATOR, 'todo-123', {}, { fetchFn: fetchFn as never })
    expect(result.taskId).toBe('todo-123')
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`https://api.dingtalk.com/v1.0/todo/users/${OPERATOR}/tasks/todo-123`)
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({ done: true })
  })

  it('a 404 on complete surfaces as DingTalkRequestError 404 (the ledger reads it as already cleaned up)', async () => {
    const fetchFn = errorResponse(404, { code: 'todoTaskNotExist' })
    const error = await completeDingTalkTodoTask(TOKEN, OPERATOR, 'todo-404', {}, { fetchFn: fetchFn as never }).catch((e) => e)
    expect(error).toBeInstanceOf(DingTalkRequestError)
    expect((error as DingTalkRequestError).statusCode).toBe(404)
    expect(isDingTalkOutcomeUnknown(error)).toBe(false)
  })

  it('DELETE targets the same path and is send-tier too', async () => {
    const fetchFn = okResponse({ result: true })
    await deleteDingTalkTodoTask(TOKEN, OPERATOR, 'todo-123', {}, { fetchFn: fetchFn as never })
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`https://api.dingtalk.com/v1.0/todo/users/${OPERATOR}/tasks/todo-123`)
    expect(init.method).toBe('DELETE')
  })

  it('url-encodes the operator and task path segments', async () => {
    const fetchFn = okResponse({ result: true })
    await completeDingTalkTodoTask(TOKEN, 'op/../admin', 'task id', {}, { fetchFn: fetchFn as never })
    const [url] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.dingtalk.com/v1.0/todo/users/op%2F..%2Fadmin/tasks/task%20id')
  })
})
