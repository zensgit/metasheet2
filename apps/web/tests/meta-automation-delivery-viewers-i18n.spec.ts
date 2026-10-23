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
  // 未找到该用户 (never the bare id as a name, never "inactive user"). Codex review P2: a skipped row keeps the
  // reason STORED at send time; the user's state today is a separate line labelled 当前状态, never the cause.
  const SKIP_BASE = {
    sourceType: 'automation',
    subject: 'Ticket rec_9 ready',
    content: 'Please review.',
    success: false,
    status: 'skipped' as const,
    errorMessage: 'DingTalk account is not linked or user is inactive',
    createdAt: '2026-10-21T10:00:00.000Z',
  }

  it('a delivery to an id with no user reads 未找到该用户 with the id on the secondary line; a label equal to the id is not a name', async () => {
    useLocale().setLocale('zh-CN')
    const deliveries: DingTalkPersonDelivery[] = [
      { ...SKIP_BASE, id: 'd_missing', localUserId: 'user_fake_typo', localUserExists: false, localUserIsActive: null, localUserDingTalkLinked: null },
      { ...SKIP_BASE, id: 'd_unnamed', localUserId: 'user_fake_noname', localUserLabel: 'user_fake_noname', localUserExists: true, localUserIsActive: true, localUserDingTalkLinked: false },
    ]
    const root = mount(MetaAutomationPersonDeliveryViewer, { getAutomationDingTalkPersonDeliveries: async () => deliveries })
    await flushPromises()
    const row = (id: string) => root.querySelector(`[data-person-delivery-id="${id}"]`) as HTMLElement
    const name = (id: string) => row(id).querySelector('[data-field="person-delivery-recipient"]')?.textContent?.trim()

    expect(name('d_missing')).toBe('未找到该用户')
    expect(name('d_missing')).not.toContain('user_fake_typo')
    expect(name('d_missing')).not.toContain('已停用用户')
    expect(row('d_missing').querySelector('[data-field="person-delivery-local-user-id"]')?.textContent).toBe('user_fake_typo')
    expect(name('d_unnamed')).toBe('未命名用户')
    expect(row('d_unnamed').querySelector('[data-field="person-delivery-local-user-id"]')?.textContent).toBe('user_fake_noname')
  })

  it('Codex P2: a user linked at send time, skipped, and active + linked now is NOT shown 「钉钉账号未绑定」 as the cause', async () => {
    useLocale().setLocale('zh-CN')
    // skipped rows carry no DingTalk id (the sender stores none on a skip), whatever the cause was
    const deliveries: DingTalkPersonDelivery[] = [
      { ...SKIP_BASE, id: 'd_reactivated', localUserId: 'user_fake_back', localUserLabel: 'Fake Back', localUserExists: true, localUserIsActive: true, localUserDingTalkLinked: true },
    ]
    const root = mount(MetaAutomationPersonDeliveryViewer, { getAutomationDingTalkPersonDeliveries: async () => deliveries })
    await flushPromises()
    const row = root.querySelector('[data-person-delivery-id="d_reactivated"]') as HTMLElement

    // the reason is what was stored at send time — the generic sentence, not an inferred 「钉钉账号未绑定」
    expect(row.querySelector('[data-field="person-delivery-reason"]')?.textContent?.trim()).toBe('钉钉账号未绑定或用户已停用')
    // today's state is a separate, labelled line
    expect(row.querySelector('[data-field="person-delivery-current-state"]')?.textContent?.trim()).toBe('当前状态：已启用且已绑定钉钉')
    expect(row.querySelector('[data-field="person-delivery-current-state"]')?.textContent).not.toContain('未绑定')
  })

  it('the current-state line names each state today, labelled as current; an older server (no flag) shows none', async () => {
    useLocale().setLocale('zh-CN')
    const deliveries: DingTalkPersonDelivery[] = [
      { ...SKIP_BASE, id: 'c_missing', localUserId: 'user_fake_typo', localUserExists: false, localUserIsActive: null, localUserDingTalkLinked: null },
      { ...SKIP_BASE, id: 'c_inactive', localUserId: 'user_fake_off', localUserLabel: 'Fake Off', localUserExists: true, localUserIsActive: false, localUserDingTalkLinked: true },
      { ...SKIP_BASE, id: 'c_unlinked', localUserId: 'user_fake_on', localUserLabel: 'Fake On', localUserExists: true, localUserIsActive: true, localUserDingTalkLinked: false },
      { ...SKIP_BASE, id: 'c_ready', localUserId: 'user_fake_ok', localUserLabel: 'Fake Ok', localUserExists: true, localUserIsActive: true, localUserDingTalkLinked: true },
      { ...SKIP_BASE, id: 'c_legacy', localUserId: 'user_fake_old', localUserLabel: 'Fake Old', localUserIsActive: true },
      { ...SKIP_BASE, id: 'c_success', status: 'success', success: true, errorMessage: undefined, localUserId: 'user_fake_ok', localUserLabel: 'Fake Ok', localUserExists: true, localUserIsActive: true, localUserDingTalkLinked: true },
    ]
    const root = mount(MetaAutomationPersonDeliveryViewer, { getAutomationDingTalkPersonDeliveries: async () => deliveries })
    await flushPromises()
    const current = (id: string) => root.querySelector(`[data-person-delivery-id="${id}"] [data-field="person-delivery-current-state"]`)?.textContent?.trim() ?? null
    const reason = (id: string) => root.querySelector(`[data-person-delivery-id="${id}"] [data-field="person-delivery-reason"]`)?.textContent?.trim() ?? null

    expect(current('c_missing')).toBe('当前状态：找不到该用户')
    expect(current('c_inactive')).toBe('当前状态：已停用')
    expect(current('c_unlinked')).toBe('当前状态：未绑定钉钉')
    expect(current('c_ready')).toBe('当前状态：已启用且已绑定钉钉')
    expect(current('c_legacy')).toBeNull()
    expect(current('c_success')).toBeNull()
    // every skipped row keeps the stored reason, whatever its user looks like today
    for (const id of ['c_missing', 'c_inactive', 'c_unlinked', 'c_ready', 'c_legacy']) expect(reason(id)).toBe('钉钉账号未绑定或用户已停用')

    useLocale().setLocale('en')
    await flushPromises()
    expect(current('c_unlinked')).toBe('Current state: not linked to DingTalk')
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
    // unfiltered: the original 3-argument call
    expect(list.mock.calls.at(-1)).toEqual(['sheet_1', 'rule_1', 50])
  })
})
