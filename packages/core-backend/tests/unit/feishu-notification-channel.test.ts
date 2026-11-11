/**
 * The generic Feishu notification channel, real path and default path.
 *
 * The channel is driven through injected collaborators: a topic lookup, an allow-set, an endpoint
 * resolver and a capability lookup, all in-memory here, and the real send core against a local server.
 * Without collaborators it keeps its result of `failed` / `transport_not_configured`, with no request
 * and no wait. Nothing assembles a channel with collaborators in the running application.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FEISHU_CHANNEL_MIN_SEND_INTERVAL_MS,
  FeishuNotificationChannel,
  NotificationServiceImpl,
  notificationService,
  type FeishuChannelDeps,
  type FeishuChannelEndpointResult,
} from '../../src/services/NotificationService'
import {
  NOTIFICATION_NO_CHANNEL_RECIPIENTS_REASON,
  NOTIFICATION_RECIPIENTS_NOT_ALLOWED_REASON,
  NOTIFICATION_RECIPIENTS_NOT_BOUND_REASON,
  NOTIFICATION_TRANSPORT_DISABLED_REASON,
  NOTIFICATION_TRANSPORT_NOT_CONFIGURED_REASON,
} from '../../src/services/notification-delivery-outcome'
import type { FeishuCapabilityDecision, FeishuSendInput, FeishuSendOutcome } from '../../src/services/feishu-message-sender'
import type { Notification, NotificationRecipient } from '../../src/types/plugin'
import { listSourceFiles } from '../helpers/import-edge-allowlist'
import {
  CONNECTION_ID,
  EFFECTIVE,
  OTHER_CONNECTION_ID,
  SEND_ROUTE,
  TENANT,
  acceptedStep,
  createSendHarness,
  endpointFor,
  refusedStep,
  type SendHarness,
} from '../helpers/feishu-send-harness'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const afterSalesAdapter = require('../../../../plugins/plugin-after-sales/lib/notification-adapter.cjs') as {
  buildNotificationsForTopic: (input: Record<string, unknown>) => Array<{ channel: string; notification: Notification }>
}

const ORG = 'org-fx-1'
const TOPIC = 'fx.topic.reminder'
const OTHER_TOPIC = 'fx.topic.other'
const UNINTEGRATED_TOPIC = 'fx.topic.not-integrated'
const BODY_TEXT = 'channel body text fx-0077'

interface FakeUser {
  openId: string
  connectionId?: string
  /** Topics the user selected Feishu for. */
  selected?: string[]
  /** Withhold the stored endpoint. */
  noEndpoint?: boolean
  backupOpenId?: string
}

interface World {
  topics: Map<string, { integrated: boolean }>
  orgs: Map<string, { policy: 'active' | 'paused'; profiles: Set<string> }>
  users: Map<string, FakeUser>
  capability: Map<string, FeishuCapabilityDecision>
  calls: { topic: string[]; allowSet: unknown[]; endpoint: unknown[]; capability: string[] }
  sleeps: number[]
  failures: { topic?: boolean; allowSet?: boolean; endpoint?: boolean; capability?: boolean }
}

function newWorld(): World {
  return {
    topics: new Map([
      [TOPIC, { integrated: true }],
      [OTHER_TOPIC, { integrated: true }],
      [UNINTEGRATED_TOPIC, { integrated: false }],
    ]),
    orgs: new Map([[ORG, { policy: 'active', profiles: new Set([TOPIC, UNINTEGRATED_TOPIC]) }]]),
    users: new Map([
      ['u1', { openId: 'ou_fx_user_one_0001', selected: [TOPIC, UNINTEGRATED_TOPIC] }],
      ['u2', { openId: 'ou_fx_user_two_0002', selected: [TOPIC, UNINTEGRATED_TOPIC] }],
      ['u3', { openId: 'ou_fx_user_three_0003', selected: [TOPIC, UNINTEGRATED_TOPIC] }],
    ]),
    capability: new Map(),
    calls: { topic: [], allowSet: [], endpoint: [], capability: [] },
    sleeps: [],
    failures: {},
  }
}

function buildDeps(world: World, h: SendHarness, overrides: Partial<FeishuChannelDeps> = {}): FeishuChannelDeps {
  return {
    deliveryFlag: () => h.flag.value,
    resolveTopic: (topic) => {
      world.calls.topic.push(topic)
      if (world.failures.topic) throw new Error('topic lookup failed')
      return world.topics.get(topic) ?? null
    },
    resolveAllowSet: async (input) => {
      world.calls.allowSet.push(input)
      if (world.failures.allowSet) throw new Error('allow-set lookup failed')
      const org = world.orgs.get(input.orgId)
      if (org === undefined || org.policy !== 'active' || !org.profiles.has(input.topic)) return new Set()
      return new Set(input.userIds.filter((userId) => world.users.get(userId)?.selected?.includes(input.topic) === true))
    },
    resolveEndpoint: async (input): Promise<FeishuChannelEndpointResult> => {
      world.calls.endpoint.push(input)
      if (world.failures.endpoint) throw new Error('endpoint lookup failed')
      const user = world.users.get(input.userId)
      if (user === undefined || user.noEndpoint === true) return { kind: 'none' }
      const connectionId = user.connectionId ?? CONNECTION_ID
      const anchor = { tenant: TENANT, appScope: connectionId === CONNECTION_ID ? 'cli_fx_0001' : 'cli_fx_0002' }
      const found: FeishuChannelEndpointResult = {
        kind: 'found',
        connectionId,
        endpoint: endpointFor(user.openId, { connectionId, anchor, evidence: [`evidence-${input.userId}`, '1'] }),
      }
      if (user.backupOpenId !== undefined) {
        found.backup = { connectionId, endpoint: endpointFor(user.backupOpenId, { connectionId, anchor, evidence: ['backup', '1'] }) }
      }
      return found
    },
    resolveCapability: async (connectionId) => {
      world.calls.capability.push(connectionId)
      if (world.failures.capability) throw new Error('capability lookup failed')
      return world.capability.get(connectionId) ?? EFFECTIVE
    },
    sender: h.sender,
    sleep: async (ms) => {
      world.sleeps.push(ms)
    },
    ...overrides,
  }
}

const userRecipients = (...ids: string[]): NotificationRecipient[] => ids.map((id) => ({ id, type: 'user' }))

function notification(overrides: Partial<Notification> = {}, metadata: Record<string, unknown> = {}): Notification {
  return {
    id: 'notification-fx-0001',
    channel: 'feishu',
    subject: 'Subject line',
    content: BODY_TEXT,
    recipients: userRecipients('u1'),
    metadata: { topic: TOPIC, orgId: ORG, ...metadata },
    ...overrides,
  }
}

let h: SendHarness
let world: World

beforeEach(async () => {
  h = await createSendHarness()
  world = newWorld()
})

afterEach(async () => {
  await h.close()
  vi.useRealTimers()
  expect(h.guard.violations).toEqual([])
  expect(h.server.unscripted).toEqual([])
})

const channel = (overrides: Partial<FeishuChannelDeps> = {}): FeishuNotificationChannel =>
  new FeishuNotificationChannel({}, buildDeps(world, h, overrides))

const run = (n: Notification, overrides: Partial<FeishuChannelDeps> = {}) => channel(overrides).sender(n, n.recipients)

const bodies = (): Array<{ receive_id: string; uuid: string; content: string }> => h.sendRequests().map((request) => JSON.parse(request.body))

describe('FX-M12 aggregation over several recipients', () => {
  it('accepted, refused and unknown: failed, with every count and the unknown outcome named', async () => {
    h.server.script(SEND_ROUTE, [acceptedStep(), refusedStep(230013), refusedStep(999999)])
    const result = await run(notification({ recipients: userRecipients('u1', 'u2', 'u3') }))
    expect(result.status).toBe('failed')
    expect(result.sentAt).toBeUndefined()
    expect(result.metadata).toEqual({ channel: 'feishu', recipientCount: 3, acceptedCount: 1, unknownCount: 1, sendOutcome: 'unknown' })
    expect(result.failedReason).toBe('feishu did not confirm the send for at least one recipient')
    expect(h.sendRequests()).toHaveLength(3)
  })

  it('every recipient accepted: sent, with a sentAt and the counts', async () => {
    h.server.script(SEND_ROUTE, [acceptedStep('om_a'), acceptedStep('om_b')])
    const result = await run(notification({ recipients: userRecipients('u1', 'u2') }))
    expect(result.status).toBe('sent')
    expect(result.sentAt).toBeInstanceOf(Date)
    expect(result.metadata).toEqual({ channel: 'feishu', recipientCount: 2, acceptedCount: 2 })
  })

  it('refusals only: failed, rejected', async () => {
    h.server.script(SEND_ROUTE, [refusedStep(230013), refusedStep(230029)])
    const result = await run(notification({ recipients: userRecipients('u1', 'u2') }))
    expect(result.status).toBe('failed')
    expect(result.metadata).toEqual({ channel: 'feishu', recipientCount: 2, acceptedCount: 0, unknownCount: 0, sendOutcome: 'rejected' })
    expect(result.failedReason).toBe('feishu send was not accepted for every recipient')
  })

  it('a recipient that was not sent to keeps the result from being sent', async () => {
    world.users.get('u2')!.noEndpoint = true
    h.server.script(SEND_ROUTE, [acceptedStep()])
    const result = await run(notification({ recipients: userRecipients('u1', 'u2') }))
    expect(result.status).toBe('failed')
    expect(result.metadata).toEqual({ channel: 'feishu', recipientCount: 2, acceptedCount: 1, unknownCount: 0, sendOutcome: 'rejected' })

    world.users.get('u2')!.noEndpoint = false
    world.users.get('u2')!.selected = []
    h.server.script(SEND_ROUTE, [acceptedStep()])
    const notAllowed = await run(notification({ recipients: userRecipients('u1', 'u2') }))
    expect(notAllowed.status).toBe('failed')
    expect(notAllowed.metadata).toMatchObject({ recipientCount: 2, acceptedCount: 1 })
    expect(h.sendRequests()).toHaveLength(2)
  })

  it('a sender that throws counts as unknown, and the other recipients are still handled', async () => {
    const sender = {
      sendFeishuText: vi.fn(async (input: FeishuSendInput): Promise<FeishuSendOutcome> => {
        if (input.endpoint.ref.value === world.users.get('u1')!.openId) throw new Error('boom')
        return { kind: 'accepted', messageRef: 'om_x' }
      }),
    }
    const result = await run(notification({ recipients: userRecipients('u1', 'u2') }), { sender })
    expect(result.status).toBe('failed')
    expect(result.metadata).toEqual({ channel: 'feishu', recipientCount: 2, acceptedCount: 1, unknownCount: 1, sendOutcome: 'unknown' })
    expect(sender.sendFeishuText).toHaveBeenCalledTimes(2)
  })

  it('waits the minimum interval between sends on one connection and not across connections', async () => {
    h.server.script(SEND_ROUTE, [acceptedStep(), acceptedStep(), acceptedStep()])
    await run(notification({ recipients: userRecipients('u1', 'u2', 'u3') }))
    expect(world.sleeps).toEqual([FEISHU_CHANNEL_MIN_SEND_INTERVAL_MS, FEISHU_CHANNEL_MIN_SEND_INTERVAL_MS])
    expect(FEISHU_CHANNEL_MIN_SEND_INTERVAL_MS).toBe(200)

    world.sleeps.length = 0
    world.users.get('u2')!.connectionId = OTHER_CONNECTION_ID
    h.server.script(SEND_ROUTE, [acceptedStep(), acceptedStep()])
    await run(notification({ recipients: userRecipients('u1', 'u2') }))
    expect(world.sleeps).toEqual([])
  })

  it('waits with real timers when no wait is injected', async () => {
    h.server.script(SEND_ROUTE, [acceptedStep(), acceptedStep()])
    const started = Date.now()
    const result = await run(notification({ recipients: userRecipients('u1', 'u2') }), { sleep: undefined })
    expect(result.status).toBe('sent')
    expect(Date.now() - started).toBeGreaterThanOrEqual(150)
  })

  it('addresses a user once however often the recipient is listed, and ignores recipients of other types', async () => {
    h.server.script(SEND_ROUTE, [acceptedStep()])
    const recipients: NotificationRecipient[] = [
      { id: 'u1', type: 'user' },
      { id: 'u1', type: 'user' },
      { id: 'someone@example.com', type: 'email' },
      { id: 'https://example.invalid/hook', type: 'webhook' },
    ]
    const result = await run(notification({ recipients }))
    expect(result.status).toBe('sent')
    expect(result.metadata).toEqual({ channel: 'feishu', recipientCount: 1, acceptedCount: 1 })
    expect(h.sendRequests()).toHaveLength(1)
  })

  it('sends the subject and the body as one text, the body alone when there is no subject', async () => {
    h.server.script(SEND_ROUTE, [acceptedStep(), acceptedStep()])
    await run(notification())
    await run(notification({ subject: '  ' }))
    expect(bodies().map((body) => JSON.parse(body.content).text)).toEqual([`Subject line\n${BODY_TEXT}`, BODY_TEXT])
  })

  it('an empty message is not attempted for any recipient: failed, nothing sent', async () => {
    const result = await run(notification({ subject: '', content: '' }))
    expect(result.status).toBe('failed')
    expect(result.metadata).toEqual({ channel: 'feishu', recipientCount: 1, acceptedCount: 0, unknownCount: 0, sendOutcome: 'rejected' })
    expect(h.server.count()).toBe(0)
  })

  it('a connection that is not configured is failed, nothing sent', async () => {
    h.rows.set(CONNECTION_ID, null)
    const result = await run(notification())
    expect(result.status).toBe('failed')
    expect(h.server.count()).toBe(0)
  })
})

describe('FX-M13 results that are cancelled', () => {
  it('no recipient of type user: cancelled, no_channel_recipients, nothing is looked up', async () => {
    const result = await run(notification({ recipients: [{ id: 'a@example.com', type: 'email' }] }))
    expect(result.status).toBe('cancelled')
    expect(result.metadata).toEqual({ channel: 'feishu', reason: NOTIFICATION_NO_CHANNEL_RECIPIENTS_REASON, recipientCount: 0 })
    const none = await run(notification({ recipients: [] }))
    expect(none.metadata).toMatchObject({ reason: 'no_channel_recipients' })
    expect(world.calls.topic).toEqual([])
    expect(h.server.count()).toBe(0)
  })

  it('users without any stored endpoint: cancelled, recipients_not_bound', async () => {
    for (const user of world.users.values()) user.noEndpoint = true
    const result = await run(notification({ recipients: userRecipients('u1', 'u2', 'ghost') }))
    expect(result.status).toBe('cancelled')
    expect(result.metadata).toEqual({ channel: 'feishu', reason: NOTIFICATION_RECIPIENTS_NOT_BOUND_REASON, recipientCount: 3 })
    expect(h.server.count()).toBe(0)
  })

  it('a notification without an organisation: cancelled, recipients_not_bound, the allow-set is not asked', async () => {
    const result = await run(notification({ metadata: { topic: TOPIC } }))
    expect(result.status).toBe('cancelled')
    expect(result.metadata).toMatchObject({ reason: 'recipients_not_bound' })
    for (const orgId of ['', 7, null]) {
      const other = await run(notification({ metadata: { topic: TOPIC, orgId } }))
      expect(other.metadata).toMatchObject({ reason: 'recipients_not_bound' })
    }
    expect(world.calls.allowSet).toEqual([])
    expect(h.server.count()).toBe(0)
  })

  it('the switch off: cancelled, transport_disabled, nothing is looked up', async () => {
    for (const value of [undefined, 'false', 'TRUE', '1']) {
      h.flag.value = value
      const result = await run(notification())
      expect(result.status).toBe('cancelled')
      expect(result.metadata).toEqual({ channel: 'feishu', reason: NOTIFICATION_TRANSPORT_DISABLED_REASON, recipientCount: 1 })
    }
    expect(world.calls.topic).toEqual([])
    expect(h.server.count()).toBe(0)
  })

  it('a capability that is not effective for the connection: cancelled, transport_disabled, no request', async () => {
    world.capability.set(CONNECTION_ID, { effective: false, reason: 'switch_off' })
    const result = await run(notification({ recipients: userRecipients('u1', 'u2') }))
    expect(result.status).toBe('cancelled')
    expect(result.metadata).toMatchObject({ reason: 'transport_disabled', recipientCount: 2 })
    expect(h.server.count()).toBe(0)
    // asked once per connection
    expect(world.calls.capability).toEqual([CONNECTION_ID])
  })

  it('an unreadable capability is not effective', async () => {
    world.failures.capability = true
    const result = await run(notification())
    expect(result.metadata).toMatchObject({ reason: 'transport_disabled' })
    expect(h.server.count()).toBe(0)
  })

  it('a collaborator that fails leaves the recipients unsent', async () => {
    world.failures.allowSet = true
    expect((await run(notification())).metadata).toMatchObject({ reason: 'recipients_not_allowed' })
    world.failures.allowSet = false
    world.failures.endpoint = true
    expect((await run(notification())).metadata).toMatchObject({ reason: 'recipients_not_bound' })
    world.failures.endpoint = false
    world.failures.topic = true
    expect((await run(notification())).metadata).toMatchObject({ reason: 'recipients_not_allowed' })
    expect(h.server.count()).toBe(0)
  })

  it('when some users are not allowed and the allowed ones have no endpoint, the result is recipients_not_bound', async () => {
    world.users.get('u2')!.selected = []
    world.users.get('u1')!.noEndpoint = true
    const result = await run(notification({ recipients: userRecipients('u1', 'u2') }))
    expect(result.metadata).toMatchObject({ reason: 'recipients_not_bound', recipientCount: 2 })
  })
})

describe('FX-M14 the default channel', () => {
  const recipient: NotificationRecipient = { id: 'u1', type: 'user' }
  const asked = { channel: 'feishu', subject: 'S', content: 'C', recipients: [recipient] }

  it.each([
    ['no collaborators argument', () => new FeishuNotificationChannel({})],
    ['an undefined collaborators argument', () => new FeishuNotificationChannel({}, undefined)],
    ['a null collaborators argument', () => new FeishuNotificationChannel({}, null as never)],
    ['collaborators placed in the configuration object, which is never read for them', () => new FeishuNotificationChannel({ deps: buildDeps(world, h) })],
  ])('%s keeps the result without a sender, with no request and no wait', async (_name, make) => {
    vi.useFakeTimers()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('fetch must not be called')
    })
    try {
      const result = await make().sender(asked, [recipient])
      expect(result.status).toBe('failed')
      expect(result.sentAt).toBeUndefined()
      expect(result.failedReason).toBe('feishu transport is not configured')
      expect(result.metadata).toEqual({ channel: 'feishu', reason: NOTIFICATION_TRANSPORT_NOT_CONFIGURED_REASON, recipientCount: 1 })
      expect(vi.getTimerCount()).toBe(0)
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(world.calls.topic).toEqual([])
      expect(h.server.count()).toBe(0)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('the channels of a new service and of the shared service are the default channel', async () => {
    for (const service of [new NotificationServiceImpl(), notificationService as unknown as NotificationServiceImpl]) {
      const feishu = service.getChannels().find((entry) => entry.name === 'feishu')
      expect(feishu).toBeInstanceOf(FeishuNotificationChannel)
      const result = await feishu!.sender({ channel: 'feishu', subject: 'S', content: 'C', recipients: userRecipients('u1') }, userRecipients('u1'))
      expect(result.status).toBe('failed')
      expect(result.metadata).toEqual({ channel: 'feishu', reason: 'transport_not_configured', recipientCount: 1 })
    }
    expect(h.server.count()).toBe(0)
  })
})

describe('FX-M19 only the allow-set decides; identifiers carried by a caller are ignored', () => {
  it('a notification in the shape the after-sales plugin sends is cancelled, recipients_not_allowed, with no request', async () => {
    const built = afterSalesAdapter
      .buildNotificationsForTopic({
        topic: 'after-sales.ticket.assigned',
        payload: { subject: 'Ticket assigned', assignedTo: 'u1' },
        roleRecipients: { supervisor: [{ id: 'u2', type: 'user' }] },
      })
      .find((entry) => entry.channel === 'feishu')
    expect(built).toBeDefined()
    const service = new NotificationServiceImpl()
    service.registerChannel(channel())
    const result = await service.send(built!.notification)
    expect(result.status).toBe('cancelled')
    expect(built!.notification.metadata).toEqual({ topic: 'after-sales.ticket.assigned', event: 'ticket.assigned' })
    expect(result.metadata).toEqual({ channel: 'feishu', reason: NOTIFICATION_RECIPIENTS_NOT_ALLOWED_REASON, recipientCount: 2 })
    expect(h.server.count()).toBe(0)
    expect(world.calls.endpoint).toEqual([])
  })

  it('an identifier forged in the metadata or on a recipient never reaches a lookup or a request', async () => {
    const forged = 'ou_forged_by_caller_0001'
    h.server.script(SEND_ROUTE, [acceptedStep()])
    const result = await run(
      notification(
        { recipients: [{ id: 'u1', type: 'user', metadata: { open_id: forged, receive_id: forged, openId: forged } }] },
        { open_id: forged, receive_id: forged, openId: forged, receiveId: forged, recipients: [forged] },
      ),
    )
    expect(result.status).toBe('sent')
    expect(h.sendRequests()).toHaveLength(1)
    expect(bodies()[0].receive_id).toBe(world.users.get('u1')!.openId)
    expect(JSON.stringify(h.server.requests)).not.toContain(forged)
    expect(JSON.stringify([world.calls.allowSet, world.calls.endpoint, world.calls.topic])).not.toContain(forged)
  })

  it('a forged identifier does not make an unallowed recipient sendable', async () => {
    const forged = 'ou_forged_by_caller_0002'
    world.users.get('u1')!.selected = []
    const result = await run(notification({}, { open_id: forged }))
    expect(result.metadata).toMatchObject({ reason: 'recipients_not_allowed' })
    expect(h.server.count()).toBe(0)
  })

  it('a topic that is missing, empty, not text or outside the closed set is never looked past', async () => {
    for (const topic of [undefined, '', 42, null, 'fx.topic.unknown']) {
      const result = await run(notification({ metadata: { topic, orgId: ORG } }))
      expect(result.status, String(topic)).toBe('cancelled')
      expect(result.metadata, String(topic)).toMatchObject({ reason: 'recipients_not_allowed' })
    }
    expect(world.calls.allowSet).toEqual([])
    expect(world.calls.endpoint).toEqual([])
    expect(h.server.count()).toBe(0)
    // a missing or non-text topic is not even looked up
    expect(world.calls.topic).toEqual(['fx.topic.unknown'])
  })

  it('a missing topic is refused before the organisation is considered', async () => {
    const result = await run(notification({ metadata: {} }))
    expect(result.metadata).toMatchObject({ reason: 'recipients_not_allowed' })
  })
})

describe('FX-M20 one distinct uuid per addressed endpoint', () => {
  it('two recipients of one notification get two uuids; the replay of one keeps its own', async () => {
    h.server.script(SEND_ROUTE, [refusedStep(99991663), acceptedStep(), acceptedStep()])
    const result = await run(notification({ recipients: userRecipients('u1', 'u2') }))
    expect(result.status).toBe('sent')
    const sent = bodies()
    expect(sent.map((body) => body.receive_id)).toEqual([
      world.users.get('u1')!.openId,
      world.users.get('u1')!.openId,
      world.users.get('u2')!.openId,
    ])
    expect(sent[0].uuid).toBe(sent[1].uuid)
    expect(sent[2].uuid).not.toBe(sent[0].uuid)
    expect(sent.every((body) => body.uuid.length === 47)).toBe(true)
  })

  it('the local user is part of the endpoint term: two users with the same open id and evidence never share a uuid', async () => {
    h.server.script(SEND_ROUTE, [acceptedStep(), acceptedStep()])
    const sameEndpointForEveryUser = async (): Promise<FeishuChannelEndpointResult> => ({
      kind: 'found',
      connectionId: CONNECTION_ID,
      endpoint: endpointFor('ou_fx_shared_open_id_0001', { evidence: ['shared-evidence', '1'] }),
    })
    const result = await run(notification({ recipients: userRecipients('u1', 'u2') }), { resolveEndpoint: sameEndpointForEveryUser })
    expect(result.status).toBe('sent')
    expect(bodies()[0].receive_id).toBe(bodies()[1].receive_id)
    expect(bodies()[0].uuid).not.toBe(bodies()[1].uuid)
  })

  it('the same recipient of the same notification in two calls is the same uuid: de-duplication is per call', async () => {
    h.server.script(SEND_ROUTE, [acceptedStep(), acceptedStep()])
    await run(notification())
    await run(notification())
    expect(bodies()[0].uuid).toBe(bodies()[1].uuid)
  })
})

describe('FX-M21 and FX-M22 the allow-set and the topic', () => {
  it.each([
    ['the organisation policy is paused', (w: World) => { w.orgs.get(ORG)!.policy = 'paused' }],
    ['the organisation has no policy', (w: World) => { w.orgs.delete(ORG) }],
    ['the topic does not list Feishu for the organisation', (w: World) => { w.orgs.get(ORG)!.profiles.delete(TOPIC) }],
    ['the user did not select Feishu for the topic', (w: World) => { w.users.get('u1')!.selected = [] }],
  ])('%s: cancelled, recipients_not_allowed, no request and no endpoint lookup', async (_name, change) => {
    change(world)
    const result = await run(notification())
    expect(result.status).toBe('cancelled')
    expect(result.metadata).toEqual({ channel: 'feishu', reason: NOTIFICATION_RECIPIENTS_NOT_ALLOWED_REASON, recipientCount: 1 })
    expect(h.server.count()).toBe(0)
    expect(world.calls.endpoint).toEqual([])
  })

  it('a topic that is not integrated: cancelled, recipients_not_allowed, even with every other term in place', async () => {
    const result = await run(notification({}, { topic: UNINTEGRATED_TOPIC }))
    expect(result.metadata).toMatchObject({ reason: 'recipients_not_allowed' })
    expect(h.server.count()).toBe(0)
    expect(world.calls.allowSet).toEqual([])
  })

  it('only the allowed users are sent to', async () => {
    world.users.get('u2')!.selected = []
    h.server.script(SEND_ROUTE, [acceptedStep()])
    await run(notification({ recipients: userRecipients('u1', 'u2') }))
    expect(bodies().map((body) => body.receive_id)).toEqual([world.users.get('u1')!.openId])
    expect(world.calls.endpoint).toEqual([{ orgId: ORG, userId: 'u1' }])
  })
})

describe('FX-M23 a notification without an id', () => {
  it('uses a fresh key for each call and the same key for the replay inside one call', async () => {
    h.server.script(SEND_ROUTE, [acceptedStep(), refusedStep(99991663), acceptedStep()])
    await run(notification({ id: undefined }))
    await run(notification({ id: undefined }))
    const sent = bodies()
    expect(sent).toHaveLength(3)
    expect(sent[0].uuid).not.toBe(sent[1].uuid)
    expect(sent[1].uuid).toBe(sent[2].uuid)
  })

  it('treats an empty id as missing and takes an injected key generator when there is one', async () => {
    h.server.script(SEND_ROUTE, [acceptedStep(), acceptedStep()])
    await run(notification({ id: '' }), { newDedupeKey: () => 'generated-key-1' })
    await run(notification({ id: '' }), { newDedupeKey: () => 'generated-key-1' })
    expect(bodies()[0].uuid).toBe(bodies()[1].uuid)
  })
})

describe('FX-M06 an unknown or refused outcome is never redirected', () => {
  it.each([
    ['unknown', { kind: 'reset' }],
    ['refused', refusedStep(230013)],
  ] as const)('a %s send to the primary endpoint makes no send to a stored backup endpoint', async (_name, step) => {
    world.users.get('u1')!.backupOpenId = 'ou_fx_backup_0009'
    h.server.script(SEND_ROUTE, [step, acceptedStep()])
    const result = await run(notification())
    expect(result.status).toBe('failed')
    expect(h.sendRequests()).toHaveLength(1)
    expect(bodies().map((body) => body.receive_id)).toEqual([world.users.get('u1')!.openId])
    expect(JSON.stringify(h.server.requests)).not.toContain('ou_fx_backup_0009')
  })
})

describe('FX-M15 nothing identifying is logged', () => {
  it('keeps user ids, open ids, text and uuids out of every log line of a send', async () => {
    h.server.script(SEND_ROUTE, [acceptedStep(), refusedStep(230013), { kind: 'reset' }])
    await run(notification({ recipients: userRecipients('u1', 'u2', 'u3') }))
    world.failures.endpoint = true
    await run(notification({ recipients: userRecipients('u1') }))
    const logged = JSON.stringify(h.logs)
    expect(h.logs.length).toBeGreaterThan(0)
    const uuids = bodies().map((body) => body.uuid)
    for (const needle of ['u1', 'u2', 'u3', 'ou_fx_user', BODY_TEXT, 'Subject line', 'ms2-', 't-fx-token', ...uuids]) {
      expect(logged.includes(needle), needle).toBe(false)
    }
  })
})

describe('FX-M26 the application does not assemble a channel with collaborators', () => {
  const SRC = path.resolve(__dirname, '..', '..', 'src')
  const withoutComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')

  it('only NotificationService constructs the channel, and only without collaborators', () => {
    const constructing: string[] = []
    const mentioning: string[] = []
    const sources = new Map<string, string>()
    for (const file of listSourceFiles(SRC)) {
      const text = withoutComments(readFileSync(file, 'utf8'))
      const relative = path.relative(SRC, file).split(path.sep).join('/')
      sources.set(relative, text)
      if (/\bFeishuNotificationChannel\b/.test(text)) mentioning.push(relative)
      for (const match of text.matchAll(/new\s+FeishuNotificationChannel\s*\(([^)]*)\)/g)) constructing.push(`${relative}: ${match[1].trim()}`)
    }
    expect(mentioning).toEqual(['services/NotificationService.ts'])
    expect(constructing).toEqual(['services/NotificationService.ts: {}'])
    for (const file of ['index.ts', 'core/plugin-service-factory.ts']) {
      const text = sources.get(file)
      expect(text, file).toBeDefined()
      expect(/FeishuNotificationChannel|feishu-message-sender|createFeishuMessageSender|FeishuChannelDeps/.test(text as string), file).toBe(false)
    }
  })

  it('the sender module is imported by no source file except through types in the notification service', () => {
    const importers: string[] = []
    for (const file of listSourceFiles(SRC)) {
      const text = withoutComments(readFileSync(file, 'utf8'))
      if (/feishu-message-sender/.test(text)) importers.push(path.relative(SRC, file).split(path.sep).join('/'))
    }
    expect(importers).toEqual(['services/NotificationService.ts'])
    const service = withoutComments(readFileSync(path.join(SRC, 'services', 'NotificationService.ts'), 'utf8'))
    const statements = service.split(/^import\s/m).filter((chunk) => chunk.includes("from './feishu-message-sender'"))
    expect(statements).toHaveLength(1)
    expect(statements[0].startsWith('type ')).toBe(true)
  })
})
