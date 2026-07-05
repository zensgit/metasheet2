import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, type App as VueApp } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import ApprovalMobileList from '../src/views/approval/ApprovalMobileList.vue'

// ---------------------------------------------------------------------------
// T3-1 v0 mobile approval surface — i18n follow-up (ballot T3-1 build-contract
// must-fix: "all user-facing labels must go through i18n, including
// mobile-only empty/error/action states").
//
// The runtime shipped in #3517 hardcoded ApprovalMobileList's loading/empty/
// status/title-fallback copy as Chinese-only literals with no locale
// awareness (self-flagged by that PR as an open must-fix). This spec locks
// the retrofit: labels must track `useLocale()`'s `isZh`, mirroring the app's
// existing `isZh` computed-dictionary convention (see ApprovalInboxView.vue).
//
// RED-before: reverting ApprovalMobileList.vue to the pre-retrofit hardcoded
// strings makes the "renders English labels" test fail — the component would
// render Chinese text ('加载中…' / '待处理' / '暂无审批' / '审批申请')
// regardless of the active locale, since there was no isZh branch at all.
// ---------------------------------------------------------------------------

async function flushUi(cycles = 3): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function pendingRow(id: string, title: string | undefined): any {
  return {
    id,
    requestNo: `AP-${id}`,
    title,
    status: 'pending',
    requester: { name: 'Zhang San' },
    createdAt: '2026-04-10T08:00:00Z',
    assignments: [],
  }
}

describe('ApprovalMobileList — i18n retrofit (T3-1 build-contract must-fix)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  async function mount(props: Record<string, unknown>) {
    app = createApp({ render: () => h(ApprovalMobileList as any, props) })
    app.mount(container!)
    await flushUi()
  }

  it('renders English labels when the locale is "en" (loading, empty, status, title fallback)', async () => {
    window.localStorage.setItem('metasheet_locale', 'en')
    useLocale().setLocale('en')

    await mount({ approvals: [], loading: true })
    expect(container!.querySelector('[data-testid="approval-mobile-loading"]')!.textContent)
      .toBe('Loading…')

    if (app) app.unmount()
    await mount({ approvals: [] })
    expect(container!.querySelector('[data-testid="approval-mobile-empty"]')!.textContent)
      .toBe('No approvals')

    if (app) app.unmount()
    await mount({ approvals: [pendingRow('1', undefined)] })
    const card = container!.querySelector('[data-testid="approval-mobile-card"]')!
    expect(card.textContent).toContain('Approval request')
    expect(card.textContent).toContain('Pending')
  })

  it('renders Chinese labels when the locale is "zh-CN" (loading, empty, status, title fallback)', async () => {
    window.localStorage.setItem('metasheet_locale', 'zh-CN')
    useLocale().setLocale('zh-CN')

    await mount({ approvals: [], loading: true })
    expect(container!.querySelector('[data-testid="approval-mobile-loading"]')!.textContent)
      .toBe('加载中…')

    if (app) app.unmount()
    await mount({ approvals: [] })
    expect(container!.querySelector('[data-testid="approval-mobile-empty"]')!.textContent)
      .toBe('暂无审批')

    if (app) app.unmount()
    await mount({ approvals: [pendingRow('1', undefined)] })
    const card = container!.querySelector('[data-testid="approval-mobile-card"]')!
    expect(card.textContent).toContain('审批申请')
    expect(card.textContent).toContain('待处理')
  })

  it('an explicit emptyText prop always overrides the localized default, in either locale', async () => {
    window.localStorage.setItem('metasheet_locale', 'en')
    useLocale().setLocale('en')
    await mount({ approvals: [], emptyText: 'No matching approvals found' })
    expect(container!.querySelector('[data-testid="approval-mobile-empty"]')!.textContent)
      .toBe('No matching approvals found')

    if (app) app.unmount()
    window.localStorage.setItem('metasheet_locale', 'zh-CN')
    useLocale().setLocale('zh-CN')
    await mount({ approvals: [], emptyText: '未找到匹配的审批' })
    expect(container!.querySelector('[data-testid="approval-mobile-empty"]')!.textContent)
      .toBe('未找到匹配的审批')
  })
})
