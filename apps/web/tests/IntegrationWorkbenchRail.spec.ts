import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp, type Component } from 'vue'
import IntegrationWorkbenchRail, {
  type IntegrationWorkbenchRailGroup,
} from '../src/components/integration/IntegrationWorkbenchRail.vue'

// IU-2a (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-2):
// Workbench chrome — PageShell + sticky left rail + anchor navigation, zero behavior/logic
// migration. This spec covers what tests/IntegrationWorkbenchView.spec.ts's existing 49 tests
// don't: the rail component's own rendering/emit contract, and a light integration check that
// the view actually wires PageShell/PageHeader/the rail/all ten section ids, that a rail click
// drives `scrollIntoView` on the right section, and that mounting never crashes when
// IntersectionObserver is unavailable (the jsdom default — no polyfill is installed anywhere in
// this test file, unlike some browser-shimmed suites elsewhere in the repo).

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const apiFetchMock = vi.fn()
const apiGetMock = vi.fn()

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiGet: (...args: unknown[]) => apiGetMock(...args),
}))

async function flushUi(cycles = 5): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    // Macrotask hop (same pattern as tests/IntegrationWorkbenchView.spec.ts's flushUi): a
    // microtask-only flush is not enough on Node 20's scheduler for the fetch-mock chains this
    // view drives on mount.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

const bi = (zh: string, _en: string): string => zh

const railGroups: IntegrationWorkbenchRailGroup[] = [
  { id: 'connection', label: '连接管理', targetId: 'int-sec-connection' },
  { id: 'read-source', label: '读取源', targetId: 'int-sec-read-source' },
  { id: 'combination', label: '组合', targetId: 'int-sec-combination-config' },
  { id: 'cleaning-mapping', label: '清洗映射', targetId: 'int-sec-object-template' },
  { id: 'run-push', label: '运行与推送', targetId: 'int-sec-run-push' },
  { id: 'monitoring', label: '监控与死信', targetId: 'int-sec-monitoring' },
  // BA-UI-1 (docs/development/bridge-agent-admin-page-design-lock-20260707.md): 7th group —
  // ADD-ONLY extension; the six IU-2a groups above are untouched.
  { id: 'bridge-agent', label: 'Bridge Agent 观测', targetId: 'int-sec-bridge-agent' },
]

describe('IntegrationWorkbenchRail (unit)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  async function mountRail(extraProps: Record<string, unknown> = {}): Promise<void> {
    container = document.createElement('div')
    document.body.appendChild(container)
    const Host = defineComponent({
      setup() {
        return () => h(IntegrationWorkbenchRail as unknown as Component, {
          groups: railGroups,
          activeGroupId: 'connection',
          tr: bi,
          ...extraProps,
        })
      },
    })
    app = createApp(Host)
    app.mount(container)
    await flushUi(1)
  }

  it('renders all seven groups (six IU-2a design-lock groups + the BA-UI-1 bridge-agent group)', async () => {
    await mountRail()
    const items = container!.querySelectorAll('.integration-workbench-rail__item')
    expect(items.length).toBe(7)
    expect(container!.textContent).toContain('连接管理')
    expect(container!.textContent).toContain('读取源')
    expect(container!.textContent).toContain('组合')
    expect(container!.textContent).toContain('清洗映射')
    expect(container!.textContent).toContain('运行与推送')
    expect(container!.textContent).toContain('监控与死信')
    // BA-UI-1: 7th group (add-only — the six assertions above are unchanged).
    expect(container!.textContent).toContain('Bridge Agent 观测')
  })

  it('marks the active group via aria-current and the active class', async () => {
    await mountRail({ activeGroupId: 'run-push' })
    const active = container!.querySelector('[data-testid="integration-rail-run-push"]')
    expect(active?.getAttribute('aria-current')).toBe('true')
    expect(active?.classList.contains('integration-workbench-rail__item--active')).toBe(true)
    const inactive = container!.querySelector('[data-testid="integration-rail-connection"]')
    expect(inactive?.getAttribute('aria-current')).toBeNull()
    expect(inactive?.classList.contains('integration-workbench-rail__item--active')).toBe(false)
  })

  it('emits select with the full clicked group object', async () => {
    const selected: IntegrationWorkbenchRailGroup[] = []
    await mountRail({ onSelect: (group: IntegrationWorkbenchRailGroup) => selected.push(group) })
    ;(container!.querySelector('[data-testid="integration-rail-monitoring"]') as HTMLElement).click()
    await flushUi(1)
    expect(selected).toHaveLength(1)
    expect(selected[0]).toEqual(railGroups.find((g) => g.id === 'monitoring'))
  })
})

describe('IntegrationWorkbenchView — IU-2a chrome integration', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    apiFetchMock.mockReset()
    apiGetMock.mockReset()
    // Blanket empty-list response: this describe block only asserts chrome/DOM wiring
    // (PageShell/PageHeader/rail/section ids/scroll behavior), not data-dependent rendering,
    // so every endpoint the view's onMounted bootstrap calls can safely resolve to an empty list.
    apiFetchMock.mockImplementation(async () => jsonResponse([]))
    apiGetMock.mockImplementation(async () => jsonResponse([]))
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  async function mountView(): Promise<void> {
    const View = (await import('../src/views/IntegrationWorkbenchView.vue')).default
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(View as Component)
    app.component('router-link', {
      props: ['to'],
      setup(_props, { slots }) {
        return () => h('a', slots.default?.())
      },
    })
    app.component('ElCard', defineComponent({
      name: 'ElCard',
      props: { shadow: { type: String, required: false, default: undefined } },
      setup(_props, { slots }) {
        return () => h('div', { class: 'el-card' }, [
          slots.header ? h('div', { class: 'el-card__header' }, slots.header()) : null,
          h('div', { class: 'el-card__body' }, slots.default?.()),
        ])
      },
    }))
    app.mount(container)
    await flushUi()
  }

  const sectionIds = [
    'int-sec-connection',
    'int-sec-read-source',
    'int-sec-combination-config',
    'int-sec-combination-run',
    'int-sec-object-template',
    'int-sec-cleaning-dataset',
    'int-sec-cleaning-rules',
    'int-sec-run-push',
    'int-sec-monitoring',
    'int-sec-preview',
    // BA-UI-1 (docs/development/bridge-agent-admin-page-design-lock-20260707.md): 11th section
    // anchor — add-only extension of the IU-2a ten.
    'int-sec-bridge-agent',
  ]

  it('renders PageShell (wide) + PageHeader chrome, the rail, and all eleven section anchors', async () => {
    await mountView()
    expect(container!.querySelector('.ms-page-shell')).toBeTruthy()
    expect(container!.querySelector('.ms-page-shell--wide')).toBeTruthy()
    expect(container!.querySelector('.ms-page-header__title')?.textContent).toBe('数据工厂')
    expect(container!.querySelector('[data-testid="integration-help-link"]')).toBeTruthy()
    for (const groupId of ['connection', 'read-source', 'combination', 'cleaning-mapping', 'run-push', 'monitoring', 'bridge-agent']) {
      expect(container!.querySelector(`[data-testid="integration-rail-${groupId}"]`)).toBeTruthy()
    }
    for (const id of sectionIds) {
      expect(container!.querySelector(`#${id}`)).toBeTruthy()
    }
  })

  it('clicking a rail item scrolls its target section into view', async () => {
    await mountView()
    const target = container!.querySelector('#int-sec-monitoring') as HTMLElement
    const scrollSpy = vi.fn()
    target.scrollIntoView = scrollSpy
    ;(container!.querySelector('[data-testid="integration-rail-monitoring"]') as HTMLElement).click()
    await flushUi(1)
    expect(scrollSpy).toHaveBeenCalledTimes(1)
  })

  it('mounts cleanly with no active-highlight crash when IntersectionObserver is unavailable', async () => {
    // jsdom (this project's test environment) does not implement IntersectionObserver at all —
    // no polyfill is registered anywhere in this test file. This asserts the view's feature-detect
    // guard, not a simulated absence.
    expect(typeof (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver).toBe('undefined')
    await expect(mountView()).resolves.toBeUndefined()
    expect(container!.querySelector('.integration-workbench-rail')).toBeTruthy()
  })
})
