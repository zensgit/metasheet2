import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Kysely } from 'kysely'
import type { Database } from '../../src/db/types'
import { DingTalkGroupDestinationService } from '../../src/multitable/dingtalk-group-destination-service'
import { sendStockPreparationHandoffNotificationToDestinations } from '../../src/multitable/stock-preparation-handoff-notifier'
import { encryptStoredSecretValue } from '../../src/security/encrypted-secrets'

/**
 * 通知下一步 (light 备料 handoff) — the SERVER-ORIGINATED DingTalk send path and its fan-out.
 *
 * Same harness as `dingtalk-group-destination-service.test.ts` (mock Kysely chain + queued rows),
 * because this exercises the same service; what is new is that nobody is logged in. `testSend` is a
 * human poking a destination they can see; `sendToDestination` is core acting on a destination id an
 * operator put in a deploy-time config file, with no user whose scope could be checked and no one
 * watching the result.
 */

beforeAll(() => {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'unit-test-key'
  process.env.ENCRYPTION_SALT = process.env.ENCRYPTION_SALT || 'unit-test-salt'
})

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

function okResponse() {
  return new Response(
    JSON.stringify({ errcode: 0, errmsg: 'ok' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

describe('DingTalkGroupDestinationService.sendToDestination (server-originated)', () => {
  beforeEach(() => {
    executeQueue = []
    executeTakeFirstQueue = []
  })

  test('records an automation delivery and never touches the manual-test verdict', async () => {
    const { db, roots } = createMockDb()
    const fetchFn = vi.fn(async () => okResponse())
    const service = new DingTalkGroupDestinationService(db, fetchFn as typeof fetch)

    executeTakeFirstQueue.push(destinationRow())
    await expect(service.sendToDestination('dt_1', {
      subject: '备料交接: 进入加工',
      content: '项目 P-2026-001 已由张三交给李四',
    })).resolves.toEqual({ ok: true })

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(roots.insertInto).toHaveBeenCalledWith('dingtalk_group_deliveries')
    const insertChain = roots.insertInto.mock.results[0]?.value as MockChain | undefined
    const deliveryValues = insertChain?.values?.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    // 'automation' is the only non-manual value recordDelivery accepts; a server notification must
    // never be filed as somebody's manual test.
    expect(deliveryValues?.source_type).toBe('automation')
    expect(deliveryValues?.success).toBe(true)
    expect(deliveryValues?.http_status).toBe(200)
    expect(deliveryValues?.subject).toBe('备料交接: 进入加工')
    expect(deliveryValues?.initiated_by).toBeNull()

    // The load-bearing negative: `last_tested_at` / `last_test_status` / `last_test_error` describe
    // an operator's MANUAL test. A handoff notification firing in the background must not overwrite
    // that verdict — and since the only write to `dingtalk_group_destinations` on this path would be
    // that update, the table must not be written at all.
    expect(roots.updateTable).not.toHaveBeenCalled()
  })

  test('carries initiatedBy into the delivery ledger when the caller supplies one', async () => {
    const { db, roots } = createMockDb()
    const fetchFn = vi.fn(async () => okResponse())
    const service = new DingTalkGroupDestinationService(db, fetchFn as typeof fetch)

    executeTakeFirstQueue.push(destinationRow())
    await service.sendToDestination('dt_1', { subject: 'S', content: 'B', initiatedBy: 'user_9' })

    const insertChain = roots.insertInto.mock.results[0]?.value as MockChain | undefined
    const deliveryValues = insertChain?.values?.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(deliveryValues?.initiated_by).toBe('user_9')
  })

  test('refuses a DISABLED destination without sending', async () => {
    const { db, roots } = createMockDb()
    const fetchFn = vi.fn(async () => okResponse())
    const service = new DingTalkGroupDestinationService(db, fetchFn as typeof fetch)

    executeTakeFirstQueue.push(destinationRow({ enabled: false }))
    // `enabled=false` is an operator saying "stop sending here". The server has no standing to
    // override that just because a config file still names the id.
    await expect(service.sendToDestination('dt_1', { subject: 'S', content: 'B' }))
      .rejects.toThrow('Destination is disabled')

    expect(fetchFn).not.toHaveBeenCalled()
    expect(roots.insertInto).not.toHaveBeenCalled()
    expect(roots.updateTable).not.toHaveBeenCalled()
  })

  test('refuses a MISSING destination instead of silently succeeding', async () => {
    const { db, roots } = createMockDb()
    const fetchFn = vi.fn(async () => okResponse())
    const service = new DingTalkGroupDestinationService(db, fetchFn as typeof fetch)

    // Nothing queued -> executeTakeFirst resolves undefined, the row a config typo would produce.
    // A typo must be loud; resolving {ok:true} here would report "sent" to a group that does not exist.
    await expect(service.sendToDestination('dt_missing', { subject: 'S', content: 'B' }))
      .rejects.toThrow('Destination not found')

    expect(fetchFn).not.toHaveBeenCalled()
    expect(roots.insertInto).not.toHaveBeenCalled()
  })

  test('decrypts credentials at rest before signing and sending (DT-HARDEN-03)', async () => {
    const { db } = createMockDb()
    const fetchFn = vi.fn(async () => okResponse())
    const service = new DingTalkGroupDestinationService(db, fetchFn as typeof fetch)

    executeTakeFirstQueue.push(destinationRow({
      webhook_url: encryptStoredSecretValue('https://oapi.dingtalk.com/robot/send?access_token=handoff-token'),
      secret: encryptStoredSecretValue('SECHANDOFF'),
    }))
    // A regression that read the raw `enc:` column would fail DingTalk-URL validation before fetch
    // was ever called — a signed plaintext token in the request URL is only reachable if both
    // webhook_url and secret were decrypted first.
    await expect(service.sendToDestination('dt_1', { subject: 'S', content: 'B' }))
      .resolves.toEqual({ ok: true })

    const calledUrl = fetchFn.mock.calls[0]?.[0] as string
    expect(calledUrl).toContain('access_token=handoff-token')
    expect(calledUrl).toContain('&sign=')
  })

  test('records a failed automation delivery and still leaves the manual-test verdict alone', async () => {
    const { db, roots } = createMockDb()
    const fetchFn = vi.fn(async () => new Response(
      JSON.stringify({ errcode: 310000, errmsg: 'signature mismatch' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    const service = new DingTalkGroupDestinationService(db, fetchFn as typeof fetch)

    executeTakeFirstQueue.push(destinationRow())
    await expect(service.sendToDestination('dt_1', { subject: 'S', content: 'B' }))
      .rejects.toThrow('signature mismatch')

    const insertChain = roots.insertInto.mock.results[0]?.value as MockChain | undefined
    const deliveryValues = insertChain?.values?.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(deliveryValues?.source_type).toBe('automation')
    expect(deliveryValues?.success).toBe(false)
    expect(deliveryValues?.error_message).toContain('signature mismatch')
    expect(roots.updateTable).not.toHaveBeenCalled()
  })
})

describe('sendStockPreparationHandoffNotificationToDestinations (fan-out)', () => {
  beforeEach(() => {
    executeQueue = []
    executeTakeFirstQueue = []
  })

  /**
   * THE load-bearing case. A terminal 备料 notice goes to warehouse AND purchasing. If warehouse's
   * robot has a rotated secret, purchasing must STILL be told — an early return, a rethrow, or a
   * `Promise.all` in the loop would turn one dead webhook into total silence, and the operator would
   * see 'failed' with no idea that anyone had in fact been notified.
   *
   * Wired end to end through the real service so the guarantee is proven against the actual send
   * path, not a stand-in for it: the first destination's webhook answers HTTP 500, the second's is
   * healthy.
   */
  test('one destination failing does not abort the rest', async () => {
    const { db } = createMockDb()
    let call = 0
    const fetchFn = vi.fn(async () => {
      call += 1
      if (call === 1) return new Response('boom', { status: 500, statusText: 'Internal Server Error' })
      return okResponse()
    })
    const service = new DingTalkGroupDestinationService(db, fetchFn as typeof fetch)

    executeTakeFirstQueue.push(destinationRow({ id: 'dest-warehouse' }))
    executeTakeFirstQueue.push(destinationRow({ id: 'dest-purchasing' }))

    const result = await sendStockPreparationHandoffNotificationToDestinations(service, {
      destinationIds: ['dest-warehouse', 'dest-purchasing'],
      title: '备料完成',
      body: '项目 P-2026-001 备料已完成',
    })

    expect(result).toEqual({ delivered: 1, failed: 1 })
    // Both were attempted: a loop that aborted on the first failure would show one fetch, not two.
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  test('maps title -> subject and body -> content for every destination', async () => {
    const sendToDestination = vi.fn(async () => ({ ok: true as const }))

    const result = await sendStockPreparationHandoffNotificationToDestinations(
      { sendToDestination },
      { destinationIds: ['d1', 'd2'], title: 'T', body: 'B' },
    )

    expect(result).toEqual({ delivered: 2, failed: 0 })
    expect(sendToDestination).toHaveBeenNthCalledWith(1, 'd1', { subject: 'T', content: 'B' })
    expect(sendToDestination).toHaveBeenNthCalledWith(2, 'd2', { subject: 'T', content: 'B' })
  })

  test('reports every destination failing as delivered:0 without throwing', async () => {
    const sendToDestination = vi.fn(async () => {
      throw new Error('webhook rejected')
    })

    // The plugin reads delivered === 0 as 'failed'. The fan-out must answer with counts, never by
    // throwing, so the route can report an honest outcome for a turn that already committed.
    const result = await sendStockPreparationHandoffNotificationToDestinations(
      { sendToDestination },
      { destinationIds: ['d1', 'd2'], title: 'T', body: 'B' },
    )

    expect(result).toEqual({ delivered: 0, failed: 2 })
    expect(sendToDestination).toHaveBeenCalledTimes(2)
  })

  test('an empty destination list sends nothing', async () => {
    const sendToDestination = vi.fn(async () => ({ ok: true as const }))

    const result = await sendStockPreparationHandoffNotificationToDestinations(
      { sendToDestination },
      { destinationIds: [], title: 'T', body: 'B' },
    )

    expect(result).toEqual({ delivered: 0, failed: 0 })
    expect(sendToDestination).not.toHaveBeenCalled()
  })
})
