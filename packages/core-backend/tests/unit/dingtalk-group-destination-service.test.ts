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
    'limit',
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
    sheet_id: null,
    org_id: null,
    created_by: 'user_1',
    created_at: '2026-04-19T10:00:00.000Z',
    updated_at: '2026-04-19T10:10:00.000Z',
    last_tested_at: null,
    last_test_status: null,
    last_test_error: null,
    ...overrides,
  }
}

function deliveryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dtd_1',
    destination_id: 'dt_1',
    source_type: 'automation',
    subject: 'Please fill incident details',
    content: 'Body',
    success: true,
    http_status: 200,
    response_body: '{"errcode":0,"errmsg":"ok"}',
    error_message: null,
    automation_rule_id: 'rule_1',
    record_id: 'rec_1',
    initiated_by: 'user_1',
    created_at: '2026-04-19T10:30:00.000Z',
    delivered_at: '2026-04-19T10:30:01.000Z',
    ...overrides,
  }
}

describe('DingTalkGroupDestinationService', () => {
  beforeEach(() => {
    executeQueue = []
    executeTakeFirstQueue = []
  })

  test('creates and lists destinations', async () => {
    const { db, roots } = createMockDb()
    const service = new DingTalkGroupDestinationService(db, vi.fn())

    const created = await service.createDestination('user_1', {
      name: ' Ops DingTalk Group ',
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=test-token',
      secret: ' SEC123 ',
      sheetId: 'sheet_1',
    })

    expect(created.name).toBe('Ops DingTalk Group')
    expect(created.secret).toBe('SEC123')
    expect(created.enabled).toBe(true)
    expect(created.scope).toBe('sheet')
    expect(created.sheetId).toBe('sheet_1')
    const insertChain = roots.insertInto.mock.results[0]?.value as MockChain | undefined
    const values = insertChain?.values?.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(values?.secret).toBe('SEC123')
    expect(values?.org_id).toBeNull()

    executeQueue.push([destinationRow({ sheet_id: 'sheet_1' }), destinationRow({ id: 'dt_legacy', sheet_id: null })])
    const listed = await service.listDestinations('user_1', 'sheet_1')
    expect(listed).toHaveLength(2)
    expect(listed[0].name).toBe('Ops DingTalk Group')
    expect(listed[0].scope).toBe('sheet')
    expect(listed[0].sheetId).toBe('sheet_1')
  })

  test('creates organization-scoped destinations', async () => {
    const { db, roots } = createMockDb()
    const service = new DingTalkGroupDestinationService(db, vi.fn())

    const created = await service.createDestination('admin_1', {
      name: 'Org Ops DingTalk Group',
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=test-token',
      scope: 'org',
      orgId: 'org_1',
    })

    expect(created.scope).toBe('org')
    expect(created.orgId).toBe('org_1')
    expect(created.sheetId).toBeUndefined()
    const insertChain = roots.insertInto.mock.results[0]?.value as MockChain | undefined
    const values = insertChain?.values?.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(values?.sheet_id).toBeNull()
    expect(values?.org_id).toBe('org_1')
  })

  test('rejects invalid organization destination scope combinations', async () => {
    const { db, roots } = createMockDb()
    const service = new DingTalkGroupDestinationService(db, vi.fn())

    await expect(service.createDestination('admin_1', {
      name: 'Org Ops DingTalk Group',
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=test-token',
      scope: 'org',
    })).rejects.toThrow('orgId is required')

    await expect(service.createDestination('admin_1', {
      name: 'Private Ops DingTalk Group',
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=test-token',
      scope: 'private',
      orgId: 'org_1',
    })).rejects.toThrow('private DingTalk group destinations cannot include sheetId or orgId')

    expect(roots.insertInto).not.toHaveBeenCalled()
  })

  test.each([
    ['http://oapi.dingtalk.com/robot/send?access_token=test-token', 'HTTPS'],
    ['https://example.com/robot/send?access_token=test-token', 'DingTalk robot URL'],
    ['https://oapi.dingtalk.com/wrong?access_token=test-token', 'DingTalk robot URL'],
    ['https://oapi.dingtalk.com/robot/send', 'access_token'],
  ])('rejects invalid DingTalk robot webhook URL on create: %s', async (webhookUrl, expectedMessage) => {
    const { db, roots } = createMockDb()
    const service = new DingTalkGroupDestinationService(db, vi.fn())

    await expect(service.createDestination('user_1', {
      name: 'Ops DingTalk Group',
      webhookUrl,
    })).rejects.toThrow(expectedMessage)

    expect(roots.insertInto).not.toHaveBeenCalled()
  })

  test('rejects invalid DingTalk robot secret on create', async () => {
    const { db, roots } = createMockDb()
    const service = new DingTalkGroupDestinationService(db, vi.fn())

    await expect(service.createDestination('user_1', {
      name: 'Ops DingTalk Group',
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=test-token',
      secret: 'bad-secret',
    })).rejects.toThrow('DingTalk robot secret must start with SEC')

    expect(roots.insertInto).not.toHaveBeenCalled()
  })

  test('shared sheet destinations can be managed by non-owners on the same sheet', async () => {
    const { db, roots } = createMockDb()
    const service = new DingTalkGroupDestinationService(db, vi.fn())

    executeTakeFirstQueue.push(destinationRow({ sheet_id: 'sheet_1', created_by: 'owner_user' }))
    executeTakeFirstQueue.push(destinationRow({
      sheet_id: 'sheet_1',
      created_by: 'owner_user',
      name: 'Updated shared group',
      enabled: false,
    }))

    const updated = await service.updateDestination('dt_1', 'user_2', {
      name: 'Updated shared group',
      enabled: false,
    }, 'sheet_1')

    expect(updated.name).toBe('Updated shared group')
    expect(updated.sheetId).toBe('sheet_1')
    expect(roots.updateTable).toHaveBeenCalledWith('dingtalk_group_destinations')
  })

  test('organization destinations require matching org authorization for mutation', async () => {
    const { db, roots } = createMockDb()
    const service = new DingTalkGroupDestinationService(db, vi.fn())

    executeTakeFirstQueue.push(destinationRow({ id: 'dt_org', org_id: 'org_1', created_by: 'admin_1' }))
    executeTakeFirstQueue.push(destinationRow({
      id: 'dt_org',
      org_id: 'org_1',
      created_by: 'admin_1',
      name: 'Updated org group',
    }))

    const updated = await service.updateDestination('dt_org', 'admin_2', {
      name: 'Updated org group',
    }, undefined, 'org_1')

    expect(updated.scope).toBe('org')
    expect(updated.orgId).toBe('org_1')
    expect(roots.updateTable).toHaveBeenCalledWith('dingtalk_group_destinations')

    executeTakeFirstQueue.push(destinationRow({ id: 'dt_org', org_id: 'org_1', created_by: 'admin_1' }))
    await expect(service.deleteDestination('dt_org', 'admin_2', undefined, 'org_2')).rejects.toThrow('Not authorized')
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

  test('rejects invalid DingTalk robot webhook URL on update', async () => {
    const { db, roots } = createMockDb()
    const service = new DingTalkGroupDestinationService(db, vi.fn())

    executeTakeFirstQueue.push(destinationRow())

    await expect(service.updateDestination('dt_1', 'user_1', {
      webhookUrl: 'https://example.com/hook',
    })).rejects.toThrow('DingTalk robot URL')

    expect(roots.updateTable).not.toHaveBeenCalled()
  })

  test('lists deliveries for a destination', async () => {
    const { db } = createMockDb()
    const service = new DingTalkGroupDestinationService(db, vi.fn())

    executeQueue.push([deliveryRow(), deliveryRow({ id: 'dtd_2', source_type: 'manual_test', success: false, error_message: 'signature mismatch' })])
    const deliveries = await service.listDeliveries('dt_1', 20)

    expect(deliveries).toHaveLength(2)
    expect(deliveries[0].destinationId).toBe('dt_1')
    expect(deliveries[0].subject).toBe('Please fill incident details')
    expect(deliveries[1].sourceType).toBe('manual_test')
    expect(deliveries[1].success).toBe(false)
  })

  test('deletes a destination after ownership check', async () => {
    const { db, roots } = createMockDb()
    const service = new DingTalkGroupDestinationService(db, vi.fn())

    executeTakeFirstQueue.push(destinationRow())
    await service.deleteDestination('dt_1', 'user_1')

    expect(roots.deleteFrom).toHaveBeenCalledWith('dingtalk_group_destinations')
  })

  test('deletes a shared destination when sheet access matches even for non-owner', async () => {
    const { db, roots } = createMockDb()
    const service = new DingTalkGroupDestinationService(db, vi.fn())

    executeTakeFirstQueue.push(destinationRow({ sheet_id: 'sheet_1', created_by: 'owner_user' }))
    await service.deleteDestination('dt_1', 'user_2', 'sheet_1')

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
    const fetchInit = fetchFn.mock.calls[0]?.[1] as RequestInit | undefined
    expect(fetchInit?.signal).toBeTruthy()
    expect(roots.insertInto).toHaveBeenCalledWith('dingtalk_group_deliveries')
    const insertChain = roots.insertInto.mock.results[0]?.value as MockChain | undefined
    const deliveryValues = insertChain?.values?.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(deliveryValues?.http_status).toBe(200)
    expect(deliveryValues?.response_body).toContain('"errcode":0')
    const updateChain = roots.updateTable.mock.results[0]?.value as MockChain | undefined
    const setArg = updateChain?.set?.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(setArg?.last_test_status).toBe('success')
    expect(setArg?.last_test_error).toBeNull()
  })

  test('testSend rejects legacy invalid webhook URL without fetch', async () => {
    const { db, roots } = createMockDb()
    const fetchFn = vi.fn(async () => new Response(
      JSON.stringify({ errcode: 0, errmsg: 'ok' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    const service = new DingTalkGroupDestinationService(db, fetchFn as typeof fetch)

    executeTakeFirstQueue.push(destinationRow({ webhook_url: 'https://example.com/hook' }))
    await expect(service.testSend('dt_1', 'user_1', {})).rejects.toThrow('DingTalk robot URL')

    expect(fetchFn).not.toHaveBeenCalled()
    expect(roots.insertInto).toHaveBeenCalledWith('dingtalk_group_deliveries')
    const insertChain = roots.insertInto.mock.results[0]?.value as MockChain | undefined
    const deliveryValues = insertChain?.values?.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(deliveryValues?.success).toBe(false)
    expect(deliveryValues?.http_status).toBeNull()
    expect(deliveryValues?.error_message).toContain('DingTalk robot URL')
    const updateChain = roots.updateTable.mock.results[0]?.value as MockChain | undefined
    const setArg = updateChain?.set?.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(setArg?.last_test_status).toBe('failed')
    expect(setArg?.last_test_error).toContain('DingTalk robot URL')
  })

  test('testSend allows shared destination access for non-owner on the same sheet', async () => {
    const { db } = createMockDb()
    const fetchFn = vi.fn(async () => new Response(
      JSON.stringify({ errcode: 0, errmsg: 'ok' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    const service = new DingTalkGroupDestinationService(db, fetchFn as typeof fetch)

    executeTakeFirstQueue.push(destinationRow({ sheet_id: 'sheet_1', created_by: 'owner_user' }))
    await expect(service.testSend('dt_1', 'user_2', {}, 'sheet_1')).resolves.toEqual({ ok: true })
    expect(fetchFn).toHaveBeenCalledTimes(1)
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

    expect(roots.insertInto).toHaveBeenCalledWith('dingtalk_group_deliveries')
    const insertChain = roots.insertInto.mock.results[0]?.value as MockChain | undefined
    const deliveryValues = insertChain?.values?.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(deliveryValues?.http_status).toBe(200)
    expect(deliveryValues?.response_body).toContain('signature mismatch')
    expect(deliveryValues?.error_message).toContain('signature mismatch')
    const updateChain = roots.updateTable.mock.results[0]?.value as MockChain | undefined
    const setArg = updateChain?.set?.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(setArg?.last_test_status).toBe('failed')
    expect(setArg?.last_test_error).toMatch(/signature mismatch/)
  })

  test('testSend still succeeds when delivery history persistence fails', async () => {
    const { db, roots } = createMockDb()
    const fetchFn = vi.fn(async () => new Response(
      JSON.stringify({ errcode: 0, errmsg: 'ok' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    const deliveryInsertChain = makeChain()
    deliveryInsertChain.execute = vi.fn(async () => {
      throw new Error('delivery history unavailable')
    })
    roots.insertInto.mockReturnValueOnce(deliveryInsertChain as never)
    const service = new DingTalkGroupDestinationService(db, fetchFn as typeof fetch)

    executeTakeFirstQueue.push(destinationRow())
    await expect(service.testSend('dt_1', 'user_1', {})).resolves.toEqual({ ok: true })

    const updateChain = roots.updateTable.mock.results[0]?.value as MockChain | undefined
    const setArg = updateChain?.set?.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(setArg?.last_test_status).toBe('success')
  })
})
