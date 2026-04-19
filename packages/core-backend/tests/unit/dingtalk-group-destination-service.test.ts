import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Kysely } from 'kysely'
import type { Database } from '../../src/db/types'
import { DingTalkGroupDestinationService } from '../../src/multitable/dingtalk-group-destination-service'

let executeQueue: unknown[]
let executeTakeFirstQueue: unknown[]

type MockChain = Record<string, unknown> & {
  set?: ReturnType<typeof vi.fn>
  execute?: ReturnType<typeof vi.fn>
  executeTakeFirst?: ReturnType<typeof vi.fn>
  executeTakeFirstOrThrow?: ReturnType<typeof vi.fn>
}

function makeChain(): MockChain {
  const self: MockChain = {}
  const chainFn = (..._args: unknown[]) => self
  const methods = [
    'selectFrom',
    'selectAll',
    'select',
    'where',
    'orderBy',
    'insertInto',
    'values',
    'updateTable',
    'set',
    'deleteFrom',
  ]
  for (const method of methods) {
    self[method] = vi.fn(chainFn)
  }
  self.execute = vi.fn(async () => executeQueue.shift() ?? [])
  self.executeTakeFirst = vi.fn(async () => executeTakeFirstQueue.shift())
  self.executeTakeFirstOrThrow = vi.fn(async () => {
    const value = executeTakeFirstQueue.shift()
    if (!value) throw new Error('no rows')
    return value
  })
  return self
}

function createMockDb() {
  const roots: Record<string, ReturnType<typeof vi.fn>> = {}
  for (const method of ['selectFrom', 'insertInto', 'updateTable', 'deleteFrom']) {
    roots[method] = vi.fn(() => makeChain())
  }

  const dbProxy = new Proxy(roots, {
    get(target, prop) {
      return target[prop as string]
    },
  })

  return {
    db: dbProxy as unknown as Kysely<Database>,
    roots,
  }
}

function destinationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dt_1',
    name: 'Ops DingTalk Group',
    webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=test-token',
    secret: 'SEC123',
    enabled: true,
    created_by: 'user_1',
    created_at: '2026-04-19T10:00:00.000Z',
    updated_at: '2026-04-19T10:10:00.000Z',
    last_tested_at: null,
    last_test_status: null,
    last_test_error: null,
    ...overrides,
  }
}

describe('DingTalkGroupDestinationService', () => {
  beforeEach(() => {
    executeQueue = []
    executeTakeFirstQueue = []
  })

  test('creates and lists destinations', async () => {
    const { db } = createMockDb()
    const service = new DingTalkGroupDestinationService(db, vi.fn())

    const created = await service.createDestination('user_1', {
      name: ' Ops DingTalk Group ',
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=test-token',
      secret: 'SEC123',
    })

    expect(created.name).toBe('Ops DingTalk Group')
    expect(created.enabled).toBe(true)

    executeQueue.push([destinationRow()])
    const listed = await service.listDestinations('user_1')
    expect(listed).toHaveLength(1)
    expect(listed[0].name).toBe('Ops DingTalk Group')
  })

  test('updates a destination', async () => {
    const { db } = createMockDb()
    const service = new DingTalkGroupDestinationService(db, vi.fn())

    executeTakeFirstQueue.push(destinationRow())
    executeTakeFirstQueue.push(destinationRow({
      name: 'Updated group',
      enabled: false,
      webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=next',
    }))

    const updated = await service.updateDestination('dt_1', 'user_1', {
      name: 'Updated group',
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=next',
      enabled: false,
    })

    expect(updated.name).toBe('Updated group')
    expect(updated.enabled).toBe(false)
    expect(updated.webhookUrl).toContain('access_token=next')
  })

  test('deletes a destination after ownership check', async () => {
    const { db, roots } = createMockDb()
    const service = new DingTalkGroupDestinationService(db, vi.fn())

    executeTakeFirstQueue.push(destinationRow())
    await service.deleteDestination('dt_1', 'user_1')

    expect(roots.deleteFrom).toHaveBeenCalledWith('dingtalk_group_destinations')
  })

  test('testSend marks success when DingTalk responds ok', async () => {
    const { db, roots } = createMockDb()
    const fetchFn = vi.fn(async () => new Response(
      JSON.stringify({ errcode: 0, errmsg: 'ok' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    const service = new DingTalkGroupDestinationService(db, fetchFn as typeof fetch)

    executeTakeFirstQueue.push(destinationRow())
    await expect(service.testSend('dt_1', 'user_1', {})).resolves.toEqual({ ok: true })

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const updateChain = roots.updateTable.mock.results[0]?.value as MockChain | undefined
    const setArg = updateChain?.set?.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(setArg?.last_test_status).toBe('success')
    expect(setArg?.last_test_error).toBeNull()
  })

  test('testSend marks failure when DingTalk returns an error', async () => {
    const { db, roots } = createMockDb()
    const fetchFn = vi.fn(async () => new Response(
      JSON.stringify({ errcode: 310000, errmsg: 'signature mismatch' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    const service = new DingTalkGroupDestinationService(db, fetchFn as typeof fetch)

    executeTakeFirstQueue.push(destinationRow())
    await expect(service.testSend('dt_1', 'user_1', {})).rejects.toThrow('signature mismatch')

    const updateChain = roots.updateTable.mock.results[0]?.value as MockChain | undefined
    const setArg = updateChain?.set?.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(setArg?.last_test_status).toBe('failed')
    expect(setArg?.last_test_error).toMatch(/signature mismatch/)
  })
})
