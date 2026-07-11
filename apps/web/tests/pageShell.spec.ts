import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp } from 'vue'
import { ElButton, ElIcon } from 'element-plus'

// UI foundation design-lock (docs/development/ui-foundation-design-lock-20260706.md §4/§6 UF-2):
// PageShell = the single page-container convention (width tiers narrow/default/wide); PageHeader
// = the single page-header convention (title/subtitle/back/actions/meta). Both are pure
// presentation — no store/router side effects beyond the explicit back-navigation contract.

const pushSpy = vi.fn()

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: pushSpy }),
  }
})

async function flushUi(cycles = 3): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('PageShell', () => {
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

  async function mountShell(props: Record<string, unknown> = {}) {
    const { default: PageShell } = await import('../src/components/layout/PageShell.vue')
    const Host = defineComponent({
      setup() {
        return () => h(PageShell as any, props, { default: () => h('div', { 'data-testid': 'shell-content' }, 'content') })
      },
    })
    app = createApp(Host)
    app.mount(container!)
    await flushUi()
  }

  it('defaults to the "default" width tier when no prop is given', async () => {
    await mountShell()
    const shell = container!.querySelector('.ms-page-shell')
    expect(shell?.classList.contains('ms-page-shell--default')).toBe(true)
    expect(shell?.classList.contains('ms-page-shell--narrow')).toBe(false)
    expect(shell?.classList.contains('ms-page-shell--wide')).toBe(false)
  })

  it.each(['narrow', 'default', 'wide'] as const)('renders the %s width tier class exclusively', async (width) => {
    await mountShell({ width })
    const shell = container!.querySelector('.ms-page-shell')
    expect(shell?.classList.contains(`ms-page-shell--${width}`)).toBe(true)
    for (const other of ['narrow', 'default', 'wide'] as const) {
      if (other === width) continue
      expect(shell?.classList.contains(`ms-page-shell--${other}`)).toBe(false)
    }
  })

  it('renders the default slot inside the centered container', async () => {
    await mountShell({ width: 'narrow' })
    const container_ = container!.querySelector('.ms-page-shell__container')
    expect(container_?.querySelector('[data-testid="shell-content"]')?.textContent).toBe('content')
  })

  // Source-level guard (design-lock §4 container widths): the width tiers must map to the exact
  // token names, not ad-hoc hardcoded pixel values re-introduced in the component itself.
  it('maps each width tier to the design-lock token (source guard)', () => {
    const src = readFileSync(join(__dirname, '../src/components/layout/PageShell.vue'), 'utf8')
    expect(src).toContain('.ms-page-shell--narrow .ms-page-shell__container')
    expect(src).toMatch(/\.ms-page-shell--narrow \.ms-page-shell__container\s*{\s*max-width:\s*var\(--ms-page-narrow\)/)
    expect(src).toMatch(/\.ms-page-shell--default \.ms-page-shell__container\s*{\s*max-width:\s*var\(--ms-page-default\)/)
    expect(src).toMatch(/\.ms-page-shell--wide \.ms-page-shell__container\s*{\s*max-width:\s*100%/)
    // padding token (design-lock §6 UF-2: 24px default, 16px on ≤768px)
    expect(src).toMatch(/\.ms-page-shell\s*{\s*padding:\s*var\(--ms-space-5\)/)
    expect(src).toMatch(/@media \(max-width: 768px\)/)
  })
})

describe('PageHeader', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    pushSpy.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  async function mountHeader(props: Record<string, unknown>, slots: Record<string, unknown> = {}) {
    const { default: PageHeader } = await import('../src/components/layout/PageHeader.vue')
    const emittedRef = { back: 0 }
    const Host = defineComponent({
      setup() {
        return () =>
          h(
            PageHeader as any,
            { ...props, onBack: () => { emittedRef.back += 1 } },
            slots,
          )
      },
    })
    app = createApp(Host)
    app.component('ElButton', ElButton)
    app.component('ElIcon', ElIcon)
    app.mount(container!)
    await flushUi()
    return emittedRef
  }

  it('renders the title', async () => {
    await mountHeader({ title: '审批中心' })
    expect(container!.querySelector('.ms-page-header__title')?.textContent).toBe('审批中心')
  })

  it('renders the subtitle only when provided', async () => {
    await mountHeader({ title: '委托管理', subtitle: '为审批人配置时间窗内的委托' })
    expect(container!.querySelector('.ms-page-header__subtitle')?.textContent).toBe('为审批人配置时间窗内的委托')
  })

  it('omits the subtitle element when not provided', async () => {
    await mountHeader({ title: '审批中心' })
    expect(container!.querySelector('.ms-page-header__subtitle')).toBeNull()
  })

  it('renders actions slot content, right-aligned container', async () => {
    await mountHeader({ title: '审批中心' }, {
      actions: () => h('button', { 'data-testid': 'my-action' }, '发起审批'),
    })
    const actions = container!.querySelector('.ms-page-header__actions')
    expect(actions).toBeTruthy()
    expect(actions?.querySelector('[data-testid="my-action"]')?.textContent).toBe('发起审批')
  })

  it('omits the actions container when no actions slot is passed', async () => {
    await mountHeader({ title: '审批中心' })
    expect(container!.querySelector('.ms-page-header__actions')).toBeNull()
  })

  it('renders meta slot content (chip row) under the title', async () => {
    await mountHeader({ title: '出差报销申请' }, {
      meta: () => h('span', { 'data-testid': 'status-chip' }, '待处理'),
    })
    const meta = container!.querySelector('.ms-page-header__meta')
    expect(meta).toBeTruthy()
    expect(meta?.querySelector('[data-testid="status-chip"]')?.textContent).toBe('待处理')
  })

  it('renders no back button when neither back nor backTo is set', async () => {
    await mountHeader({ title: '审批中心' })
    expect(container!.querySelector('.ms-page-header__back')).toBeNull()
  })

  it('backTo: clicking pushes the given path via router.push', async () => {
    await mountHeader({ title: '发起审批', backTo: '/approval-templates', backLabel: '返回' })
    const backBtn = container!.querySelector('.ms-page-header__back') as HTMLElement
    expect(backBtn).toBeTruthy()
    expect(backBtn.textContent).toContain('返回')
    backBtn.click()
    await flushUi()
    expect(pushSpy).toHaveBeenCalledWith('/approval-templates')
    expect(pushSpy).toHaveBeenCalledTimes(1)
  })

  it('back: clicking emits a "back" event instead of navigating', async () => {
    const emitted = await mountHeader({ title: '审批详情', back: true, backLabel: '返回列表' })
    const backBtn = container!.querySelector('.ms-page-header__back') as HTMLElement
    expect(backBtn).toBeTruthy()
    expect(backBtn.textContent).toContain('返回列表')
    backBtn.click()
    await flushUi()
    expect(emitted.back).toBe(1)
    expect(pushSpy).not.toHaveBeenCalled()
  })

  it('back takes priority over backTo when both are set', async () => {
    const emitted = await mountHeader({ title: '审批详情', back: true, backTo: '/should-not-be-used' })
    const backBtn = container!.querySelector('.ms-page-header__back') as HTMLElement
    backBtn.click()
    await flushUi()
    expect(emitted.back).toBe(1)
    expect(pushSpy).not.toHaveBeenCalled()
  })

  it('defaults the back label to 返回 when backLabel is not given', async () => {
    await mountHeader({ title: '发起审批', backTo: '/approvals' })
    const backBtn = container!.querySelector('.ms-page-header__back') as HTMLElement
    expect(backBtn.textContent).toContain('返回')
  })
})
