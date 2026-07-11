import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import StatusTag from '../src/components/status/StatusTag.vue'
import { resolveStatusDisplay } from '../src/utils/statusDomains'
import { useLocale } from '../src/composables/useLocale'

// UF-3 — StatusTag + status-domain map convergence (docs/development/
// ui-foundation-design-lock-20260706.md §3.4, §6). Locks: tone-per-domain mapping, the
// unknown-status fail-safe (never throw / never blank), zh<->en label switching, and the "no
// hardcoded hex" guard the design-lock's "颜色只从 tokens.css 取" principle requires of any new
// status-color renderer.

describe('resolveStatusDisplay (pure)', () => {
  it('maps approvalInstance tones: approved -> success, rejected -> danger, pending -> warning', () => {
    expect(resolveStatusDisplay('approvalInstance', 'approved', true)).toEqual({ tone: 'success', label: '已通过' })
    expect(resolveStatusDisplay('approvalInstance', 'rejected', true)).toEqual({ tone: 'danger', label: '已驳回' })
    expect(resolveStatusDisplay('approvalInstance', 'pending', true)).toEqual({ tone: 'warning', label: '待处理' })
    expect(resolveStatusDisplay('approvalInstance', 'revoked', true)).toEqual({ tone: 'info', label: '已撤回' })
    expect(resolveStatusDisplay('approvalInstance', 'cancelled', true)).toEqual({ tone: 'info', label: '已取消' })
  })

  it('maps approvalTemplate tones: published -> success, draft -> warning, archived -> info', () => {
    expect(resolveStatusDisplay('approvalTemplate', 'published', true)).toEqual({ tone: 'success', label: '已发布' })
    expect(resolveStatusDisplay('approvalTemplate', 'draft', true)).toEqual({ tone: 'warning', label: '草稿' })
    expect(resolveStatusDisplay('approvalTemplate', 'archived', true)).toEqual({ tone: 'info', label: '已归档' })
    expect(resolveStatusDisplay('approvalTemplate', 'published', false)).toEqual({ tone: 'success', label: 'Published' })
    expect(resolveStatusDisplay('approvalTemplate', 'draft', false)).toEqual({ tone: 'warning', label: 'Draft' })
    expect(resolveStatusDisplay('approvalTemplate', 'archived', false)).toEqual({ tone: 'info', label: 'Archived' })
  })

  it('maps delegation tones exactly per the existing DELEGATION_STATUS_TAG_TYPE semantics', () => {
    expect(resolveStatusDisplay('delegation', '未开始', true)).toEqual({ tone: 'info', label: '未开始' })
    expect(resolveStatusDisplay('delegation', '生效中', true)).toEqual({ tone: 'success', label: '生效中' })
    expect(resolveStatusDisplay('delegation', '已过期', true)).toEqual({ tone: 'warning', label: '已过期' })
    expect(resolveStatusDisplay('delegation', '已停用', true)).toEqual({ tone: 'danger', label: '已停用' })
  })

  it('maps automationRun tones: resolved -> success, failed/errored/rejected -> danger, skipped -> neutral, in-flight -> primary', () => {
    expect(resolveStatusDisplay('automationRun', 'resolved', false)).toEqual({ tone: 'success', label: 'resolved' })
    expect(resolveStatusDisplay('automationRun', 'failed', false)).toEqual({ tone: 'danger', label: 'failed' })
    expect(resolveStatusDisplay('automationRun', 'errored', false)).toEqual({ tone: 'danger', label: 'errored' })
    expect(resolveStatusDisplay('automationRun', 'rejected', false)).toEqual({ tone: 'danger', label: 'rejected' })
    expect(resolveStatusDisplay('automationRun', 'skipped', false)).toEqual({ tone: 'neutral', label: 'skipped' })
    expect(resolveStatusDisplay('automationRun', 'running', false)).toEqual({ tone: 'primary', label: 'running' })
    expect(resolveStatusDisplay('automationRun', 'queued', false)).toEqual({ tone: 'primary', label: 'queued' })
    expect(resolveStatusDisplay('automationRun', 'suspended', false)).toEqual({ tone: 'primary', label: 'suspended' })
  })

  it('zh/en switch flips the label without changing the tone', () => {
    const zh = resolveStatusDisplay('approvalInstance', 'approved', true)
    const en = resolveStatusDisplay('approvalInstance', 'approved', false)
    expect(zh.tone).toBe(en.tone)
    expect(zh.label).toBe('已通过')
    expect(en.label).toBe('Approved')
  })

  it('fail-safe: an unknown status per domain renders tone "neutral" and the raw status as label (never throws, never blank)', () => {
    expect(resolveStatusDisplay('approvalInstance', 'draft', true)).toEqual({ tone: 'neutral', label: 'draft' })
    expect(resolveStatusDisplay('approvalInstance', 'totally-unknown-status', false)).toEqual({ tone: 'neutral', label: 'totally-unknown-status' })
    expect(resolveStatusDisplay('approvalTemplate', 'not-a-real-template-status', true)).toEqual({ tone: 'neutral', label: 'not-a-real-template-status' })
    expect(resolveStatusDisplay('delegation', 'not-a-real-delegation-status', true)).toEqual({ tone: 'neutral', label: 'not-a-real-delegation-status' })
    expect(resolveStatusDisplay('automationRun', 'not-a-real-automation-status', false)).toEqual({ tone: 'neutral', label: 'not-a-real-automation-status' })
    expect(() => resolveStatusDisplay('approvalInstance', '', true)).not.toThrow()
  })
})

describe('StatusTag.vue (mounted)', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    useLocale().setLocale('zh-CN')
  })

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
  })

  function mount(domain: string, status: string, size?: 'sm' | 'md', forceLocale?: 'zh' | 'en') {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({ render: () => h(StatusTag, { domain, status, size, forceLocale }) })
    app.mount(container)
    return container
  }

  it('renders the resolved label and data-domain/data-status/data-tone attributes', async () => {
    const c = mount('approvalInstance', 'approved')
    await nextTick()
    const el = c.querySelector('.ms-status-tag') as HTMLElement
    expect(el).not.toBeNull()
    expect(el.textContent).toBe('已通过')
    expect(el.getAttribute('data-domain')).toBe('approvalInstance')
    expect(el.getAttribute('data-status')).toBe('approved')
    expect(el.getAttribute('data-tone')).toBe('success')
  })

  it('unknown status renders the raw status text with tone "neutral", never blank', async () => {
    const c = mount('automationRun', 'some_future_status')
    await nextTick()
    const el = c.querySelector('.ms-status-tag') as HTMLElement
    expect(el.textContent).toBe('some_future_status')
    expect(el.getAttribute('data-tone')).toBe('neutral')
  })

  it('switches label text when the locale changes (zh <-> en), tone stays stable', async () => {
    const { setLocale } = useLocale()
    const c = mount('delegation', '生效中')
    await nextTick()
    const el = c.querySelector('.ms-status-tag') as HTMLElement
    expect(el.textContent).toBe('生效中')
    expect(el.getAttribute('data-tone')).toBe('success')

    setLocale('en')
    await nextTick()
    expect(el.textContent).toBe('Active')
    expect(el.getAttribute('data-tone')).toBe('success')

    setLocale('zh-CN')
    await nextTick()
    expect(el.textContent).toBe('生效中')
  })

  it('UF-7b: forceLocale="zh" renders the zh label even while the global locale is en', async () => {
    const { setLocale } = useLocale()
    setLocale('en')
    const c = mount('delegation', '生效中', undefined, 'zh')
    await nextTick()
    const el = c.querySelector('.ms-status-tag') as HTMLElement
    expect(el.textContent).toBe('生效中')
    expect(el.getAttribute('data-tone')).toBe('success')
    setLocale('zh-CN')
  })

  it('UF-7b: forceLocale="en" renders the en label even while the global locale is zh', async () => {
    const c = mount('approvalInstance', 'approved', undefined, 'en')
    await nextTick()
    const el = c.querySelector('.ms-status-tag') as HTMLElement
    expect(el.textContent).toBe('Approved')
  })

  it('UF-7b: leaving forceLocale unset keeps following useLocale() exactly as before', async () => {
    const { setLocale } = useLocale()
    const c = mount('approvalInstance', 'approved')
    await nextTick()
    const el = c.querySelector('.ms-status-tag') as HTMLElement
    expect(el.textContent).toBe('已通过')

    setLocale('en')
    await nextTick()
    expect(el.textContent).toBe('Approved')

    setLocale('zh-CN')
    await nextTick()
    expect(el.textContent).toBe('已通过')
  })

  it('guard: the rendered inline style references only CSS custom properties, never a hardcoded hex', async () => {
    // jsdom's CSSStyleDeclaration NORMALIZES any literal color it's given (hex, `rgb()`, named
    // color) to `rgb(r, g, b)` on assignment — a `background: '#f5f6f8'` mutation would NOT
    // survive as `#f5f6f8` in `el.getAttribute('style')`, it would read back as `rgb(245, 246,
    // 248)`. So the real "did someone hardcode a color" signal in a jsdom-rendered style
    // attribute is the presence of an `rgb(`/`rgba(` function — a `var(--...)` reference is
    // never resolved by jsdom and passes through as literal text. Assert against BOTH forms
    // (verified by mutation: swapping the neutral-tone background to a hex literal made this
    // assertion fail via the `rgb(` branch, not the `#` branch).
    const cases: Array<[string, string]> = [
      ['approvalInstance', 'approved'],
      ['approvalInstance', 'rejected'],
      ['approvalInstance', 'pending'],
      ['approvalInstance', 'revoked'],
      ['approvalTemplate', 'published'],
      ['approvalTemplate', 'draft'],
      ['approvalTemplate', 'archived'],
      ['delegation', '未开始'],
      ['delegation', '生效中'],
      ['delegation', '已过期'],
      ['delegation', '已停用'],
      ['automationRun', 'resolved'],
      ['automationRun', 'failed'],
      ['automationRun', 'skipped'],
      ['automationRun', 'running'],
      ['automationRun', 'unknown-guard-case'],
    ]
    for (const [domain, status] of cases) {
      const c = mount(domain, status)
      await nextTick()
      const el = c.querySelector('.ms-status-tag') as HTMLElement
      const styleAttr = el.getAttribute('style') ?? ''
      expect(styleAttr, `${domain}/${status} style: ${styleAttr}`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(styleAttr, `${domain}/${status} style: ${styleAttr}`).not.toMatch(/rgba?\(/)
      expect(styleAttr, `${domain}/${status} style: ${styleAttr}`).toMatch(/var\(--/)
      app?.unmount()
      container?.remove()
      app = null
      container = null
    }
  })
})
