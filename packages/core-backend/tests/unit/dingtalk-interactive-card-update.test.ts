/**
 * B-4 terminal card update (Slice B design lock §B-4) — unit matrix for the copy builder and the
 * presentation-follow-up orchestration.
 *
 * Pins, per the ratified §B-4 table:
 *  - success approve → `已由 <display name> 同意 · <time>` — the display name comes from the
 *    CONTEXT (server-side local user data threaded by the callback adapter), never from summary
 *    or payload fields;
 *  - stale/duplicate → the current TRUE terminal state derived ONLY from status-level summary
 *    fields (cardState/actedAction/actedAt/approval.status);
 *  - unmapped operator → the bind-first copy — and (review P3-H) `delivery_not_found` renders the
 *    BYTE-EQUAL same copy so card copy never becomes a delivery-existence oracle;
 *  - non-recipient / permission denied → `当前账号无权处理该审批`;
 *  - engine validation error → reason-coded copy (stable code only, NO values);
 *  - update failure after a committed action → the orchestrator resolves (never throws) and owns
 *    no DB access at all, so a rollback is structurally impossible from here.
 *
 * VALUES-FREE FENCE (mutation-verified): every expected statusText is asserted byte-exact over a
 * summary poisoned with canary values in ALL non-status fields — any leak of title/requestNo/
 * nodeKey/recipient/instance data into the copy turns a test red.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DINGTALK_APPROVAL_CARD_NEUTRAL_UNPROCESSABLE_TEXT,
  DINGTALK_APPROVAL_CARD_NO_PERMISSION_TEXT,
  DINGTALK_APPROVAL_CARD_SYSTEM_UNAVAILABLE_TEXT,
  applyDingTalkApprovalCardTerminalUpdate,
  buildDingTalkApprovalCardTerminalUpdate,
  createDingTalkApprovalCardStreamUpdateSender,
} from '../../src/integrations/dingtalk/interactive-card-update'
import type { DingTalkApprovalCardCallbackResult } from '../../src/integrations/dingtalk/interactive-card-callback'
import { __resetDingTalkAppAccessTokenCacheForTests } from '../../src/integrations/dingtalk/client'
import type { ApprovalCardDeliverySummary } from '../../src/services/ApprovalCardDeliveryAction'

const DELIVERY_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
// 2026-07-10T06:30Z = 2026/07/10 14:30 Asia/Shanghai — the card audience timezone.
const ACTED_AT = '2026-07-10T06:30:00.000Z'
const ACTED_AT_TEXT = '2026/07/10 14:30'

/** Summary poisoned with canaries in every NON-status field (values-free fence probes). */
function canarySummary(overrides: Partial<ApprovalCardDeliverySummary> = {}, approvalOverrides: Partial<ApprovalCardDeliverySummary['approval']> = {}): ApprovalCardDeliverySummary {
  return {
    deliveryId: DELIVERY_ID,
    cardState: 'acted',
    sendStatus: 'sent',
    nodeKey: 'NODE_KEY_CANARY',
    recipientUserId: 'RECIPIENT_CANARY',
    viewerIsRecipient: true,
    actionable: false,
    approval: {
      instanceId: 'INSTANCE_CANARY',
      title: 'TITLE_CANARY_机密采购单',
      requestNo: 'REQNO_CANARY',
      status: 'approved',
      currentNodeKey: 'CURRENT_NODE_CANARY',
      rejectCommentRequired: true,
      ...approvalOverrides,
    },
    actedAction: 'approve',
    actedAt: ACTED_AT,
    ...overrides,
  }
}

const CANARIES = [
  'NODE_KEY_CANARY',
  'RECIPIENT_CANARY',
  'INSTANCE_CANARY',
  'TITLE_CANARY',
  '机密采购单',
  'REQNO_CANARY',
  'CURRENT_NODE_CANARY',
]

function executed(summary = canarySummary()): DingTalkApprovalCardCallbackResult {
  return { outcome: 'executed', deliveryId: DELIVERY_ID, summary }
}

describe('buildDingTalkApprovalCardTerminalUpdate (§B-4 mapping table)', () => {
  it('success approve → 已由 <display name> 同意 · <time> (name from server-side context, time from the ledger acted_at)', () => {
    const update = buildDingTalkApprovalCardTerminalUpdate(executed(), { operatorDisplayName: '张审批' })
    expect(update).toEqual({
      outTrackId: DELIVERY_ID,
      statusText: `已由 张审批 同意 · ${ACTED_AT_TEXT}`,
    })
  })

  it('success approve without a resolvable display name still renders a terminal state (name omitted, never guessed)', () => {
    const update = buildDingTalkApprovalCardTerminalUpdate(executed(), {})
    expect(update?.statusText).toBe(`已同意 · ${ACTED_AT_TEXT}`)
  })

  it('success approve with a missing acted_at falls back to the injected now', () => {
    const update = buildDingTalkApprovalCardTerminalUpdate(
      executed(canarySummary({ actedAt: null })),
      { operatorDisplayName: '张审批', now: new Date(ACTED_AT) },
    )
    expect(update?.statusText).toBe(`已由 张审批 同意 · ${ACTED_AT_TEXT}`)
  })

  it('stale on an acted card → the ledger terminal action (approve/reject), status-level only', () => {
    const approved = buildDingTalkApprovalCardTerminalUpdate({
      outcome: 'stale', deliveryId: DELIVERY_ID, summary: canarySummary(),
    })
    expect(approved).toEqual({ outTrackId: DELIVERY_ID, statusText: `已同意 · ${ACTED_AT_TEXT}` })

    const rejected = buildDingTalkApprovalCardTerminalUpdate({
      outcome: 'stale',
      deliveryId: DELIVERY_ID,
      summary: canarySummary({ actedAction: 'reject' }, { status: 'rejected' }),
    })
    expect(rejected?.statusText).toBe(`已驳回 · ${ACTED_AT_TEXT}`)
  })

  it('stale on a non-acted card falls through to the instance terminal status', () => {
    for (const [status, text] of [
      ['approved', '审批已通过'],
      ['rejected', '审批已拒绝'],
      ['revoked', '审批已撤销'],
    ] as const) {
      const update = buildDingTalkApprovalCardTerminalUpdate({
        outcome: 'stale',
        deliveryId: DELIVERY_ID,
        summary: canarySummary({ cardState: 'superseded', actedAction: null, actedAt: null }, { status }),
      })
      expect(update?.statusText).toBe(text)
    }
  })

  it('stale on a still-pending instance renders card-level convergence copy (expired/superseded/undelivered)', () => {
    const expired = buildDingTalkApprovalCardTerminalUpdate({
      outcome: 'stale',
      deliveryId: DELIVERY_ID,
      summary: canarySummary({ cardState: 'expired', actedAction: null, actedAt: null }, { status: 'pending' }),
    })
    expect(expired?.statusText).toBe('卡片已过期，请在网页端处理')

    const superseded = buildDingTalkApprovalCardTerminalUpdate({
      outcome: 'stale',
      deliveryId: DELIVERY_ID,
      summary: canarySummary({ cardState: 'superseded', actedAction: null, actedAt: null }, { status: 'pending' }),
    })
    expect(superseded?.statusText).toBe('该任务已流转，请在网页端查看')

    const undelivered = buildDingTalkApprovalCardTerminalUpdate({
      outcome: 'stale',
      deliveryId: DELIVERY_ID,
      summary: canarySummary({ cardState: 'sent', sendStatus: 'pending', actedAction: null, actedAt: null }, { status: 'pending' }),
    })
    expect(undelivered?.statusText).toBe('卡片已失效，请在网页端查看')
  })

  it('P3-H: delivery_not_found and EVERY operator_unresolved reason render BYTE-EQUAL neutral copy (no existence oracle)', () => {
    const notFound = buildDingTalkApprovalCardTerminalUpdate({
      outcome: 'delivery_not_found', outTrackId: DELIVERY_ID,
    })
    expect(notFound).toEqual({ outTrackId: DELIVERY_ID, statusText: DINGTALK_APPROVAL_CARD_NEUTRAL_UNPROCESSABLE_TEXT })

    for (const reason of ['unlinked', 'inactive', 'ambiguous', 'integration_unpinned'] as const) {
      const unresolved = buildDingTalkApprovalCardTerminalUpdate({
        outcome: 'operator_unresolved', deliveryId: DELIVERY_ID, reason,
      })
      // toBe on the exact same string: byte-equal, not merely similar.
      expect(unresolved?.statusText).toBe(notFound?.statusText)
    }
    // …and the shared copy is the ratified unmapped-user row (lock §B-4).
    expect(DINGTALK_APPROVAL_CARD_NEUTRAL_UNPROCESSABLE_TEXT).toBe('请先在网页端绑定钉钉后再处理')
  })

  it('link_secret_unavailable / wrapper_not_found → generic values-free system copy', () => {
    const secret = buildDingTalkApprovalCardTerminalUpdate({
      outcome: 'link_secret_unavailable', deliveryId: DELIVERY_ID,
    })
    const wrapper = buildDingTalkApprovalCardTerminalUpdate({
      outcome: 'wrapper_not_found', deliveryId: DELIVERY_ID,
    })
    expect(secret?.statusText).toBe(DINGTALK_APPROVAL_CARD_SYSTEM_UNAVAILABLE_TEXT)
    expect(wrapper?.statusText).toBe(secret?.statusText)
  })

  it('non-recipient / permission denied → 当前账号无权处理该审批', () => {
    const forbidden = buildDingTalkApprovalCardTerminalUpdate({
      outcome: 'engine_rejected', deliveryId: DELIVERY_ID, code: 'APPROVAL_ASSIGNMENT_REQUIRED', httpStatus: 403, summary: canarySummary({}, { status: 'pending' }),
    })
    expect(forbidden?.statusText).toBe(DINGTALK_APPROVAL_CARD_NO_PERMISSION_TEXT)

    // The engine's assignee gate code maps to the same copy even if the HTTP class drifts.
    const codeOnly = buildDingTalkApprovalCardTerminalUpdate({
      outcome: 'engine_rejected', deliveryId: DELIVERY_ID, code: 'APPROVAL_ASSIGNMENT_REQUIRED', httpStatus: 422, summary: canarySummary({}, { status: 'pending' }),
    })
    expect(codeOnly?.statusText).toBe(DINGTALK_APPROVAL_CARD_NO_PERMISSION_TEXT)
  })

  it('engine validation error → reason-coded copy, stable code only, NO values', () => {
    const update = buildDingTalkApprovalCardTerminalUpdate({
      outcome: 'engine_rejected', deliveryId: DELIVERY_ID, code: 'VALIDATION_ERROR', httpStatus: 400, summary: canarySummary({}, { status: 'pending' }),
    })
    expect(update?.statusText).toBe('无法处理该审批（VALIDATION_ERROR）')
  })

  it('parse-level rejections and unsupported actions are a NO-OP (no card update built)', () => {
    expect(buildDingTalkApprovalCardTerminalUpdate({ outcome: 'rejected', reason: 'payload_not_object' })).toBeNull()
    expect(buildDingTalkApprovalCardTerminalUpdate({ outcome: 'ignored_unsupported_action', outTrackId: DELIVERY_ID })).toBeNull()
  })

  it('VALUES-FREE fence: no summary identifier/title/request field ever reaches the terminal copy', () => {
    const results: DingTalkApprovalCardCallbackResult[] = [
      executed(),
      { outcome: 'stale', deliveryId: DELIVERY_ID, summary: canarySummary() },
      { outcome: 'stale', deliveryId: DELIVERY_ID, summary: canarySummary({ cardState: 'superseded', actedAction: null, actedAt: null }, { status: 'pending' }) },
      { outcome: 'engine_rejected', deliveryId: DELIVERY_ID, code: 'VALIDATION_ERROR', httpStatus: 400, summary: canarySummary({}, { status: 'pending' }) },
    ]
    for (const result of results) {
      const update = buildDingTalkApprovalCardTerminalUpdate(result, { operatorDisplayName: '张审批' })
      expect(update).not.toBeNull()
      for (const canary of CANARIES) {
        expect(update!.statusText).not.toContain(canary)
      }
    }
  })
})

describe('applyDingTalkApprovalCardTerminalUpdate (presentation follow-up, never the source of truth)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('sends the built update through the injected sender', async () => {
    const sends: unknown[] = []
    const outcome = await applyDingTalkApprovalCardTerminalUpdate(
      executed(),
      { operatorDisplayName: '张审批' },
      async (update) => { sends.push(update) },
    )
    expect(outcome).toEqual({ status: 'updated', outTrackId: DELIVERY_ID })
    expect(sends).toEqual([{ outTrackId: DELIVERY_ID, statusText: `已由 张审批 同意 · ${ACTED_AT_TEXT}` }])
  })

  it('NO ROLLBACK: a failing card update resolves to a typed failure — it never throws back into the action path', async () => {
    const outcome = await applyDingTalkApprovalCardTerminalUpdate(
      executed(),
      { operatorDisplayName: '张审批' },
      async () => { throw new Error('DingTalk 5xx with card payload details') },
    )
    expect(outcome).toEqual({ status: 'failed', outTrackId: DELIVERY_ID, reason: 'Error' })
  })

  it('no-op outcomes skip without touching the sender', async () => {
    const sender = vi.fn()
    const outcome = await applyDingTalkApprovalCardTerminalUpdate(
      { outcome: 'rejected', reason: 'payload_not_object' },
      {},
      sender,
    )
    expect(outcome).toEqual({ status: 'skipped', reason: 'no_update_for_outcome' })
    expect(sender).not.toHaveBeenCalled()
  })

  it('without an injected sender the production sender is env-gated: stream config off → skipped, zero network', async () => {
    vi.stubEnv('DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED', '')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await applyDingTalkApprovalCardTerminalUpdate(executed(), { operatorDisplayName: '张审批' })
    expect(outcome).toEqual({ status: 'skipped', reason: 'stream_config_disabled' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(createDingTalkApprovalCardStreamUpdateSender()).toBeNull()
  })

  it('production sender: stream credentials → app token → PUT /v1.0/card/instances with the terminal statusText', async () => {
    __resetDingTalkAppAccessTokenCacheForTests()
    vi.stubEnv('DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED', '1')
    vi.stubEnv('DINGTALK_INTERACTIVE_CARD_CLIENT_ID', 'stream-client-id')
    vi.stubEnv('DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET', 'stream-client-secret')
    vi.stubEnv('DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID', 'tmpl-1')

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, access_token: 'app-tok', expires_in: 7200 }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await applyDingTalkApprovalCardTerminalUpdate(executed(), { operatorDisplayName: '张审批' })
    expect(outcome).toEqual({ status: 'updated', outTrackId: DELIVERY_ID })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [tokenUrl] = fetchMock.mock.calls[0] as [string]
    expect(tokenUrl).toContain('/gettoken?appkey=stream-client-id&appsecret=stream-client-secret')
    const [updateUrl, updateInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(updateUrl).toBe('https://api.dingtalk.com/v1.0/card/instances')
    expect(updateInit.method).toBe('PUT')
    expect((updateInit.headers as Record<string, string>)['x-acs-dingtalk-access-token']).toBe('app-tok')
    expect(JSON.parse(String(updateInit.body))).toMatchObject({
      outTrackId: DELIVERY_ID,
      cardData: { cardParamMap: { statusText: `已由 张审批 同意 · ${ACTED_AT_TEXT}` } },
    })
    __resetDingTalkAppAccessTokenCacheForTests()
  })
})
