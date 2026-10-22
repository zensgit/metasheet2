import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'

import MetaAutomationGroupDeliveryViewer from '../src/multitable/components/MetaAutomationGroupDeliveryViewer.vue'
import MetaAutomationPersonDeliveryViewer from '../src/multitable/components/MetaAutomationPersonDeliveryViewer.vue'
import { useLocale } from '../src/composables/useLocale'
import type { DingTalkGroupDelivery, DingTalkPersonDelivery } from '../src/multitable/types'

let app: App<Element> | null = null
let container: HTMLDivElement | null = null

function flushPromises() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => nextTick())
}

function mount(
  component: typeof MetaAutomationGroupDeliveryViewer | typeof MetaAutomationPersonDeliveryViewer,
  client: Record<string, unknown>,
  extraProps: Record<string, unknown> = {},
) {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({
    render: () => h(component, {
      visible: true,
      sheetId: 'sheet_1',
      ruleId: 'rule_1',
      client,
      ...extraProps,
    }),
  })
  app.mount(container)
  return container
}

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  useLocale().setLocale('en')
})

const GROUP_DELIVERIES: DingTalkGroupDelivery[] = [
  {
    id: 'group_delivery_1',
    destinationId: 'dt_group_1',
    destinationName: 'Ops Group',
    sourceType: 'automation',
    subject: 'Ticket rec_1 pending',
    content: 'Please process.',
    success: true,
    createdAt: '2026-05-01T10:00:00.000Z',
  },
  {
    id: 'group_delivery_2',
    destinationId: 'dt_group_2',
    sourceType: 'automation',
    subject: 'Ticket rec_2 pending',
    content: 'Please process.',
    success: false,
    errorMessage: 'Robot webhook rejected request',
    createdAt: '2026-05-01T10:01:00.000Z',
  },
]

const PERSON_DELIVERIES: DingTalkPersonDelivery[] = [
  {
    id: 'person_delivery_1',
    localUserId: 'user_1',
    localUserLabel: 'Lin Lan',
    localUserSubtitle: 'lin@example.com',
    localUserIsActive: true,
    dingtalkUserId: 'dt_user_1',
    sourceType: 'automation',
    subject: 'Ticket rec_1 ready',
    content: 'Please review.',
    success: true,
    status: 'success',
    createdAt: '2026-05-01T10:00:00.000Z',
  },
  {
    id: 'person_delivery_2',
    localUserId: 'user_2',
    localUserLabel: 'Inactive User',
    localUserIsActive: false,
    sourceType: 'automation',
    subject: 'Ticket rec_2 ready',
    content: 'Please review.',
    success: false,
    status: 'skipped',
    errorMessage: 'DingTalk account is not linked or user is inactive',
    createdAt: '2026-05-01T10:01:00.000Z',
  },
]

describe('automation delivery viewers i18n', () => {
  it('localizes DingTalk group delivery chrome while keeping raw status attributes', async () => {
    useLocale().setLocale('zh-CN')
    const root = mount(MetaAutomationGroupDeliveryViewer, {
      getAutomationDingTalkGroupDeliveries: async () => GROUP_DELIVERIES,
    })
    await flushPromises()

    const text = root.textContent ?? ''
    expect(text).toContain('钉钉群投递记录')
    expect(text).toContain('全部状态')
    expect(text).toContain('成功')
    expect(text).toContain('失败')
    expect(text).toContain('刷新')
    expect(text).toContain('Ops Group')
    expect(text).toContain('Robot webhook rejected request')
    expect(text).not.toContain('DingTalk Group Deliveries')

    expect(root.querySelector('[data-status="success"]')?.textContent?.trim()).toBe('成功')
    expect(root.querySelector('[data-status="failed"]')?.textContent?.trim()).toBe('失败')
    expect(root.querySelectorAll('[aria-label]')).toHaveLength(0)
    expect(root.querySelectorAll('[title]')).toHaveLength(0)
    expect(root.querySelectorAll('[placeholder]')).toHaveLength(0)
  })

  it('localizes DingTalk person delivery chrome while preserving raw IDs and status attributes', async () => {
    useLocale().setLocale('zh-CN')
    const root = mount(MetaAutomationPersonDeliveryViewer, {
      getAutomationDingTalkPersonDeliveries: async () => PERSON_DELIVERIES,
    })
    await flushPromises()

    const text = root.textContent ?? ''
    expect(text).toContain('钉钉个人投递记录')
    expect(text).toContain('全部状态')
    expect(text).toContain('跳过 / 未绑定')
    expect(text).toContain('已停用用户')
    expect(text).toContain('钉钉：dt_user_1')
    expect(text).toContain('钉钉账号未绑定或用户已停用')
    expect(text).toContain('lin@example.com')
    expect(text).not.toContain('DingTalk Person Deliveries')
    expect(text).not.toContain('Inactive user')

    expect(root.querySelector('[data-status="success"]')?.textContent?.trim()).toBe('成功')
    expect(root.querySelector('[data-status="skipped"]')?.textContent?.trim()).toBe('跳过')
    expect(root.querySelectorAll('[aria-label]')).toHaveLength(0)
    expect(root.querySelectorAll('[title]')).toHaveLength(0)
    expect(root.querySelectorAll('[placeholder]')).toHaveLength(0)
  })

  it('keeps English labels available when locale is en', async () => {
    useLocale().setLocale('en')
    const root = mount(MetaAutomationPersonDeliveryViewer, {
      getAutomationDingTalkPersonDeliveries: async () => PERSON_DELIVERIES,
    })
    await flushPromises()

    const text = root.textContent ?? ''
    expect(text).toContain('DingTalk Person Deliveries')
    expect(text).toContain('All statuses')
    expect(text).toContain('Skipped / unbound')
    expect(text).toContain('Inactive user')
    expect(text).toContain('DingTalk: dt_user_1')
    expect(text).not.toContain('钉钉个人投递记录')
  })

  it('uses localized static load fallback while preserving backend error messages raw', async () => {
    useLocale().setLocale('zh-CN')
    const fallbackRoot = mount(MetaAutomationGroupDeliveryViewer, {
      getAutomationDingTalkGroupDeliveries: async () => {
        throw 'no details'
      },
    })
    await flushPromises()
    expect(fallbackRoot.textContent ?? '').toContain('加载钉钉群投递记录失败。')

    app?.unmount()
    fallbackRoot.remove()
    app = null
    container = null

    const rawRoot = mount(MetaAutomationPersonDeliveryViewer, {
      getAutomationDingTalkPersonDeliveries: async () => {
        throw new Error('upstream timeout')
      },
    })
    await flushPromises()
    expect(rawRoot.textContent ?? '').toContain('upstream timeout')
    expect(rawRoot.textContent ?? '').not.toContain('加载钉钉个人投递记录失败。')
  })

  // 客户反馈 2026-10-21 item 1 (review round 2): identity text matches the editor — an id with no user reads
  // 未找到该用户 (never the bare id as a name, never "inactive user"), and the skip reason names the real cause.
  it('a delivery to an id with no user reads 未找到该用户 with the id on the secondary line; reasons name the cause', async () => {
    useLocale().setLocale('zh-CN')
    const base = {
      sourceType: 'automation',
      subject: 'Ticket rec_9 ready',
      content: 'Please review.',
      success: false,
      status: 'skipped' as const,
      errorMessage: 'DingTalk account is not linked or user is inactive',
      createdAt: '2026-10-21T10:00:00.000Z',
    }
    const deliveries: DingTalkPersonDelivery[] = [
      { ...base, id: 'd_missing', localUserId: 'user_fake_typo', localUserExists: false, localUserIsActive: null },
      { ...base, id: 'd_inactive', localUserId: 'user_fake_off', localUserLabel: 'Fake Off', localUserExists: true, localUserIsActive: false },
      { ...base, id: 'd_unlinked', localUserId: 'user_fake_on', localUserLabel: 'Fake On', localUserExists: true, localUserIsActive: true },
      { ...base, id: 'd_unnamed', localUserId: 'user_fake_noname', localUserLabel: 'user_fake_noname', localUserExists: true, localUserIsActive: true },
    ]
    const root = mount(MetaAutomationPersonDeliveryViewer, { getAutomationDingTalkPersonDeliveries: async () => deliveries })
    await flushPromises()

    const row = (id: string) => root.querySelector(`[data-person-delivery-id="${id}"]`) as HTMLElement
    const name = (id: string) => row(id).querySelector('[data-field="person-delivery-recipient"]')?.textContent?.trim()

    expect(name('d_missing')).toBe('未找到该用户')
    expect(name('d_missing')).not.toContain('user_fake_typo')
    expect(name('d_missing')).not.toContain('已停用用户')
    expect(row('d_missing').querySelector('[data-field="person-delivery-local-user-id"]')?.textContent).toBe('user_fake_typo')
    expect(row('d_missing').textContent).toContain('找不到该用户，未发送')

    expect(name('d_inactive')).toContain('Fake Off')
    expect(name('d_inactive')).toContain('已停用用户')
    expect(row('d_inactive').textContent).toContain('用户已停用')

    expect(row('d_unlinked').textContent).toContain('钉钉账号未绑定')
    expect(row('d_unlinked').textContent).not.toContain('钉钉账号未绑定或用户已停用')

    // a roster-less label equal to the id is not a name either
    expect(name('d_unnamed')).toBe('未命名用户')
    expect(row('d_unnamed').querySelector('[data-field="person-delivery-local-user-id"]')?.textContent).toBe('user_fake_noname')
  })

  it('asks the SERVER for the status it opens on (the run log link), and reloads with the new status when changed', async () => {
    const list = vi.fn(async () => PERSON_DELIVERIES)
    const root = mount(MetaAutomationPersonDeliveryViewer, { getAutomationDingTalkPersonDeliveries: list }, { initialStatusFilter: 'skipped' })
    await flushPromises()
    expect(list).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledWith('sheet_1', 'rule_1', 50, { status: 'skipped' })

    const select = root.querySelector('[data-field="statusFilter"]') as HTMLSelectElement
    select.value = 'failed'
    select.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(list).toHaveBeenLastCalledWith('sheet_1', 'rule_1', 50, { status: 'failed' })

    select.value = ''
    select.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(list).toHaveBeenLastCalledWith('sheet_1', 'rule_1', 50, {})
  })
})
