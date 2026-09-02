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

/**
 * The fixture is ORG-SCOPED by default, and that is the F4 guard showing up in the harness rather
 * than an arbitrary choice: `sendToDestination` refuses any row whose `org_id` is null, because
 * private and sheet-scoped rows are writable by ordinary users (see the method's doc comment) and a
 * server-originated send must not lend core's authority to one. A default of `org_id: null` here
 * would make every happy-path test below assert the refusal instead of the send.
 */
function destinationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dt_1',
    name: 'Ops DingTalk Group',
    webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=test-token',
    secret: 'SEC123',
    enabled: true,
    sheet_id: null,
    org_id: 'org_1',
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

  // ---------------------------------------------------------------------------
  // F4 — a server-originated send rides ONLY an admin-managed (org-scoped) destination
  // ---------------------------------------------------------------------------
  //
  // THE HOLE THIS CLOSES. `sendToDestination` has no user, so it cannot call
  // `loadAuthorizedDestination`. Without a replacement check, the row it loads by id could be a
  // PRIVATE-scope destination — and POST /api/multitable/dingtalk-groups only demands org-admin when
  // `scope === 'org'`, while PATCH /:id only reaches `requireOrgAdminAccess` when the request
  // carries an orgId. So any authenticated user can create a private row and afterwards rewrite its
  // `webhookUrl` / `secret` / `enabled` through the `created_by === userId` branch. If an operator
  // pastes such an id into the 通知下一步 config, that user silently owns the terminal 仓库/采购
  // fan-out: repoint it, or switch it off, and nobody sees anything except the right people no
  // longer being told.
  //
  // An ORG-scoped row is the ONE shape whose create AND update are both admin-gated, which makes
  // "org_id is not null" a property the server can check with no user in hand. These three cases
  // pin exactly that: private throws, sheet throws, org sends — and the refusals never reach fetch.

  test('F4: refuses a PRIVATE-scope destination — no fetch, no delivery row', async () => {
    const { db, roots } = createMockDb()
    const fetchFn = vi.fn(async () => okResponse())
    const service = new DingTalkGroupDestinationService(db, fetchFn as typeof fetch)

    executeTakeFirstQueue.push(destinationRow({ org_id: null, sheet_id: null, created_by: 'attacker_1' }))
    await expect(service.sendToDestination('dt_1', { subject: 'S', content: 'B' }))
      .rejects.toThrow('not organization-scoped')

    // The refusal must come BEFORE the webhook POST — a guard that fired after the send would have
    // already handed the message to whatever group the row now points at.
    expect(fetchFn).not.toHaveBeenCalled()
    expect(roots.insertInto).not.toHaveBeenCalled()
    expect(roots.updateTable).not.toHaveBeenCalled()
  })

  test('F4: refuses a SHEET-scope destination too — sheet membership is not admin management', async () => {
    const { db, roots } = createMockDb()
    const fetchFn = vi.fn(async () => okResponse())
    const service = new DingTalkGroupDestinationService(db, fetchFn as typeof fetch)

    // A sheet row is manageable by ANY non-owner who can reach that sheet
    // (`loadAuthorizedDestination`'s sheet branch checks only that the sheetId matches), so it is
    // no more admin-managed than a private one.
    executeTakeFirstQueue.push(destinationRow({ org_id: null, sheet_id: 'sheet_1' }))
    await expect(service.sendToDestination('dt_1', { subject: 'S', content: 'B' }))
      .rejects.toThrow('not organization-scoped')

    expect(fetchFn).not.toHaveBeenCalled()
    expect(roots.insertInto).not.toHaveBeenCalled()
  })

  test('F4: an ORG-scoped destination is sent to — the guard is a scope rule, not a blanket refusal', async () => {
    const { db } = createMockDb()
    const fetchFn = vi.fn(async () => okResponse())
    const service = new DingTalkGroupDestinationService(db, fetchFn as typeof fetch)

    executeTakeFirstQueue.push(destinationRow({ org_id: 'org_1', sheet_id: null }))
    await expect(service.sendToDestination('dt_1', { subject: 'S', content: 'B' }))
      .resolves.toEqual({ ok: true })

    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  test('F4: the fan-out counts a private destination as FAILED and still delivers to the org one', async () => {
    const { db } = createMockDb()
    const fetchFn = vi.fn(async () => okResponse())
    const service = new DingTalkGroupDestinationService(db, fetchFn as typeof fetch)

    // The realistic deployment mistake: an operator pastes one good org id and one id that turns out
    // to be somebody's private row. The refusal must be a COUNTED failure inside the fan-out — not
    // an exception that silences the destination beside it, and not a silent success.
    executeTakeFirstQueue.push(destinationRow({ id: 'dest-private', org_id: null, sheet_id: null }))
    executeTakeFirstQueue.push(destinationRow({ id: 'dest-warehouse', org_id: 'org_1' }))

    const result = await sendStockPreparationHandoffNotificationToDestinations(service, {
      destinationIds: ['dest-private', 'dest-warehouse'],
      title: '备料完成',
      body: '项目 P-2026-001 备料已完成',
    })

    expect(result).toEqual({ delivered: 1, failed: 1 })
    // Exactly ONE webhook POST: the private row never reached fetch, the org row did.
    expect(fetchFn).toHaveBeenCalledTimes(1)
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
