/**
 * 催办站内通知 —— 通知中心铃铛里的显示与跳转。
 *
 * 服务端催办时写的通知不挂表、不挂记录，正文末行是审批详情路径。铃铛：
 *  - 显示时去掉路径行，只显示给人看的文字；
 *  - 点击时标已读并跳到审批详情，不发 navigate（不去多维表里找记录）；
 *  - 挂了表或记录的通知、末行不是审批路径的通知，照旧处理。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { routerKey } from 'vue-router'
import MetaNotificationBell from '../src/multitable/components/MetaNotificationBell.vue'
import { MultitableApiClient } from '../src/multitable/api/client'
import type { MetaRecordSubscriptionNotification } from '../src/multitable/types'
import { parseApprovalNotificationLink } from '../src/multitable/utils/approval-notification-link'

const REMIND_TEXT = '【催办】发起人甲 提醒你处理审批「采购申请」（编号 AP-0001）'

function remindRow(overrides: Partial<MetaRecordSubscriptionNotification> = {}): MetaRecordSubscriptionNotification {
  return {
    id: 'n_remind',
    sheetId: '',
    recordId: '',
    userId: 'u1',
    eventType: 'notification.sent',
    actorId: 'u-req',
    revisionId: null,
    commentId: null,
    message: `${REMIND_TEXT}\n/approvals/apv_1`,
    createdAt: '2026-10-27T00:00:00Z',
    readAt: null,
    ...overrides,
  }
}

const flush = async () => { await nextTick(); await Promise.resolve(); await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); await nextTick() }

function mount(items: MetaRecordSubscriptionNotification[], options: { router?: { push: ReturnType<typeof vi.fn> } | null; onNavigate?: (p: unknown) => void } = {}) {
  const apiClient = {
    listRecordSubscriptionNotifications: vi.fn(async () => items),
    getRecordSubscriptionUnreadCount: vi.fn(async () => items.filter((n) => !n.readAt).length),
    markRecordSubscriptionNotificationsRead: vi.fn(async () => 1),
    markAllRecordSubscriptionNotificationsRead: vi.fn(async () => 1),
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    render: () => h(MetaNotificationBell, { apiClient: apiClient as never, ...(options.onNavigate ? { onNavigate: options.onNavigate } : {}) }),
  })
  if (options.router) app.provide(routerKey, options.router as never)
  app.mount(container)
  return { container, app, apiClient }
}

async function openPanel(container: HTMLElement) {
  await flush()
  container.querySelector<HTMLButtonElement>('[data-test="notification-bell-btn"]')!.click()
  await flush()
}

describe('parseApprovalNotificationLink', () => {
  it('recognises a record-less notification.sent row whose last line is an approval path', () => {
    expect(parseApprovalNotificationLink(remindRow())).toEqual({ text: REMIND_TEXT, path: '/approvals/apv_1' })
    expect(parseApprovalNotificationLink(remindRow({ message: `${REMIND_TEXT}\n/approvals/plm%3Aeco-1` })))
      .toEqual({ text: REMIND_TEXT, path: '/approvals/plm%3Aeco-1' })
  })

  it('ignores rows that belong to a sheet or a record', () => {
    expect(parseApprovalNotificationLink(remindRow({ sheetId: 's1' }))).toBeNull()
    expect(parseApprovalNotificationLink(remindRow({ recordId: 'rec_1' }))).toBeNull()
  })

  it('ignores other event types and messages without a path line', () => {
    expect(parseApprovalNotificationLink(remindRow({ eventType: 'record.updated' }))).toBeNull()
    expect(parseApprovalNotificationLink(remindRow({ message: REMIND_TEXT }))).toBeNull()
    expect(parseApprovalNotificationLink(remindRow({ message: null }))).toBeNull()
  })

  it('only accepts a single path segment under /approvals/', () => {
    for (const last of ['/approvals/', '/approvals/a/b', '/approvals/a?x=1', '/approvals/a#x', '/other/apv_1', 'https://example.invalid/approvals/apv_1', '//approvals/apv_1']) {
      expect(parseApprovalNotificationLink(remindRow({ message: `${REMIND_TEXT}\n${last}` }))).toBeNull()
    }
  })
})

describe('MetaNotificationBell — 催办站内通知', () => {
  let mounted: { container: HTMLElement; app: App } | null = null
  afterEach(() => { if (mounted) { mounted.app.unmount(); mounted.container.remove(); mounted = null } })

  it('shows the text without the path line', async () => {
    const m = mount([remindRow()], { router: { push: vi.fn(async () => undefined) } }); mounted = m
    await openPanel(m.container)
    const message = m.container.querySelector('[data-test="notification-message"]')
    expect(message?.textContent).toBe(REMIND_TEXT)
  })

  it('click marks it read and opens the approval detail; it never emits navigate', async () => {
    const push = vi.fn(async () => undefined)
    const onNavigate = vi.fn()
    const m = mount([remindRow()], { router: { push }, onNavigate }); mounted = m
    await openPanel(m.container)
    m.container.querySelector<HTMLElement>('[data-test="notification-item"]')!.click()
    await flush()
    expect(m.apiClient.markRecordSubscriptionNotificationsRead).toHaveBeenCalledWith(['n_remind'])
    expect(push).toHaveBeenCalledWith('/approvals/apv_1')
    expect(onNavigate).not.toHaveBeenCalled()
    expect(m.container.querySelector('[data-test="notification-panel"]')).toBeNull()
  })

  it('without a router it only marks the row read', async () => {
    const m = mount([remindRow()]); mounted = m
    await openPanel(m.container)
    m.container.querySelector<HTMLElement>('[data-test="notification-item"]')!.click()
    await flush()
    expect(m.apiClient.markRecordSubscriptionNotificationsRead).toHaveBeenCalledWith(['n_remind'])
  })

  // 走真实的多维表客户端（真实规范化）：服务端返回的催办行 sheetId、recordId 都是空串，必须能列出来、点进审批详情。
  it('through the real client: a sheet-less remind row is listed and opens the approval detail', async () => {
    const wireRow = {
      id: 'n_remind', sheetId: '', recordId: '', userId: 'u1', eventType: 'notification.sent', actorId: 'u-req',
      revisionId: null, commentId: null, message: `${REMIND_TEXT}\n/approvals/apv_1`, createdAt: '2026-10-27T00:00:00Z', readAt: null,
    }
    const fetchFn = vi.fn(async (url: string, _init?: RequestInit) => {
      const json = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), { status: 200 })
      if (url.startsWith('/api/multitable/record-subscription-notifications/unread-count')) return json({ count: 1 })
      if (url.startsWith('/api/multitable/record-subscription-notifications/mark-read')) return json({ updated: 1 })
      if (url.startsWith('/api/multitable/record-subscription-notifications/mark-all-read')) return json({ updated: 1 })
      if (url.startsWith('/api/multitable/record-subscription-notifications')) return json({ items: [wireRow] })
      return new Response(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'not found' } }), { status: 404 })
    })
    const apiClient = new MultitableApiClient({ fetchFn })
    const push = vi.fn(async () => undefined)
    const onNavigate = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({ render: () => h(MetaNotificationBell, { apiClient, onNavigate }) })
    app.provide(routerKey, { push } as never)
    app.mount(container)
    mounted = { container, app }

    await openPanel(container)
    const items = container.querySelectorAll('[data-test="notification-item"]')
    expect(items).toHaveLength(1)
    expect(container.querySelector('[data-test="notification-message"]')?.textContent).toBe(REMIND_TEXT)
    ;(items[0] as HTMLElement).click()
    await flush()
    expect(fetchFn).toHaveBeenCalledWith('/api/multitable/record-subscription-notifications/mark-read', expect.objectContaining({ method: 'POST' }))
    expect(push).toHaveBeenCalledWith('/approvals/apv_1')
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('a record-less row from a sheet rule keeps its old behaviour (no jump, message unchanged)', async () => {
    const push = vi.fn(async () => undefined)
    const ruleRow = remindRow({ id: 'n_rule', sheetId: 's1', message: 'approval done\n/approvals/apv_1' })
    const m = mount([ruleRow], { router: { push } }); mounted = m
    await openPanel(m.container)
    expect(m.container.querySelector('[data-test="notification-message"]')?.textContent).toBe('approval done\n/approvals/apv_1')
    m.container.querySelector<HTMLElement>('[data-test="notification-item"]')!.click()
    await flush()
    expect(push).not.toHaveBeenCalled()
  })
})
