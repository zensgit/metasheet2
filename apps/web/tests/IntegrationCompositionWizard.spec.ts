import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp } from 'vue'
import { useLocale } from '../src/composables/useLocale'

const apiFetchMock = vi.fn()

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiGet: vi.fn(),
}))

import IntegrationReadSourceCompositionAuthoringPanel from '../src/components/integration/IntegrationReadSourceCompositionAuthoringPanel.vue'

// IU-4 three-step composition wizard (design-lock
// docs/development/integration-iu4-composition-wizard-design-lock-20260707.md, #3803, sibling of IU-3
// docs/development/integration-iu3-read-source-wizard-design-lock-20260707.md).
//
// Every test here mounts the REAL IntegrationReadSourceCompositionAuthoringPanel in its DEFAULT mode
// (wizard) — not the wizard component in isolation — so the parent↔wizard wiring (shared draft, the
// emitted `save` landing on the SAME panel function the expert form's own button calls) is exercised
// end-to-end, mirroring IntegrationReadSourceWizard.spec.ts's discipline. That sibling spec
// (IntegrationReadSourceCompositionAuthoringPanel.spec.ts) pins the panel to expert mode and is
// unchanged assertion-for-assertion (design-lock §2 既有测试不变量).
//
// el-steps / el-step / el-icon stubs: same approach as IntegrationReadSourceWizard.spec.ts — real
// Element Plus is not globally installed in these bare `createApp()` instances, so the tags the
// wizard template uses get minimal local stubs that render their slot/title content. All step
// NAVIGATION in the component is plain <button> + internal state — nothing here (or the component)
// relies on Element Plus behavior.
const ElSteps = defineComponent({
  name: 'ElSteps',
  props: { active: { type: Number, required: false, default: 0 }, alignCenter: { type: Boolean, required: false, default: false } },
  setup(props, { slots }) {
    return () => h('div', { class: 'el-steps', 'data-active-step': String(props.active) }, slots.default?.())
  },
})
const ElStep = defineComponent({
  name: 'ElStep',
  props: { title: { type: String, required: false, default: '' } },
  setup(props) {
    return () => h('div', { class: 'el-step' }, props.title)
  },
})
const ElIcon = defineComponent({
  name: 'ElIcon',
  setup(_props, { slots }) {
    return () => h('span', { class: 'el-icon' }, slots.default?.())
  },
})
const ElTooltip = defineComponent({
  name: 'ElTooltip',
  props: { content: { type: String, required: false, default: '' } },
  setup(_props, { slots }) {
    return () => h('span', { class: 'el-tooltip' }, slots.default?.())
  },
})

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), { status, headers: { 'Content-Type': 'application/json' } })
}

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

async function waitUntil(condition: () => boolean, label: string, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
  throw new Error(`waitUntil timed out: ${label}`)
}

const APPROVED_RESOLVER_ROWS = [
  { id: 'rsc_material_lookup', systemId: 'sys_k3', object: 'material', mode: 'resolver_lookup', version: 1, status: 'approved', contentKey: 'ck1', createdBy: null, updatedAt: '2026-07-05' },
  { id: 'rsc_bom_lookup', systemId: 'sys_k3', object: 'bom', mode: 'resolver_lookup', version: 1, status: 'approved', contentKey: 'ck2', createdBy: null, updatedAt: '2026-07-05' },
  // Same status (approved) but the WRONG mode — must never appear as a hop card.
  { id: 'rsc_list_page', systemId: 'sys_k3', object: 'material_list', mode: 'list_page', version: 1, status: 'approved', contentKey: 'ck3', createdBy: null, updatedAt: '2026-07-05' },
  // A draft resolver_lookup row — the mock mirrors the real server's status=approved query filter, so
  // this row never reaches the component at all.
  { id: 'rsc_draft_resolver', systemId: 'sys_k3', object: 'other', mode: 'resolver_lookup', version: 1, status: 'draft', contentKey: 'ck4', createdBy: null, updatedAt: '2026-07-05' },
]

function routeApiFetch(handlers: {
  save?: (init?: RequestInit) => Response | Promise<Response>
  approve?: (id: string) => Response | Promise<Response>
} = {}): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/integration/read-source-configs')) {
      return jsonResponse(APPROVED_RESOLVER_ROWS.filter((row) => row.status === 'approved'))
    }
    const approveMatch = /\/api\/integration\/read-source-compositions\/([^/?]+)\/approve/.exec(url)
    if (approveMatch) return handlers.approve ? handlers.approve(approveMatch[1]) : jsonResponse({})
    if (url.startsWith('/api/integration/read-source-compositions')) {
      return handlers.save ? handlers.save(init) : jsonResponse({})
    }
    throw new Error(`unexpected URL ${url}`)
  }
}

describe('IntegrationCompositionWizard (via IntegrationReadSourceCompositionAuthoringPanel default surface)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  let originalConfirm: typeof window.confirm

  beforeEach(() => {
    apiFetchMock.mockReset()
    if (typeof localStorage?.clear === 'function') localStorage.clear()
    originalConfirm = window.confirm
    window.confirm = vi.fn(() => true)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    window.confirm = originalConfirm
  })

  function mountPanel(initialViewMode?: 'wizard' | 'expert'): HTMLDivElement {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({
      render: () => h(IntegrationReadSourceCompositionAuthoringPanel, {
        scope: { tenantId: 'default', workspaceId: null },
        ...(initialViewMode ? { initialViewMode } : {}),
      }),
    })
    app.component('ElSteps', ElSteps)
    app.component('ElStep', ElStep)
    app.component('ElIcon', ElIcon)
    app.component('ElTooltip', ElTooltip)
    app.mount(container)
    return container
  }

  function unmountPanel(): void {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  }

  function q<T extends HTMLElement>(root: HTMLElement, testid: string): T {
    const el = root.querySelector<T>(`[data-testid="${testid}"]`)
    if (!el) throw new Error(`missing [data-testid=${testid}]`)
    return el
  }

  function maybe(root: HTMLElement, testid: string): HTMLElement | null {
    return root.querySelector<HTMLElement>(`[data-testid="${testid}"]`)
  }

  function setInput(root: HTMLElement, testid: string, value: string): void {
    const input = q<HTMLInputElement>(root, testid)
    input.value = value
    input.dispatchEvent(new Event('input'))
  }

  function setSelect(root: HTMLElement, testid: string, value: string): void {
    const select = q<HTMLSelectElement>(root, testid)
    select.value = value
    select.dispatchEvent(new Event('change'))
  }

  function grantWrite(): void {
    localStorage.setItem('user_permissions', JSON.stringify(['integration:write']))
  }

  it('wizard is the DEFAULT new-composition surface: three steps render, flat form is not mounted', async () => {
    apiFetchMock.mockImplementation(routeApiFetch())
    const root = mountPanel()
    await waitUntil(() => root.querySelector('[data-testid="iu4-wizard-hop1-rsc_material_lookup"]') !== null, 'hop cards load')

    expect(maybe(root, 'composition-wizard')).not.toBeNull()
    // The expert flat form's own controls are absent by default (wizard replaces, not duplicates).
    expect(maybe(root, 'rscauth-step1')).toBeNull()
    expect(maybe(root, 'rscauth-source-target')).toBeNull()

    const stepsText = q(root, 'iu4-wizard-steps').textContent ?? ''
    for (const title of ['① Pick two hops', '② Wiring visual', '③ Approve']) {
      expect(stepsText).toContain(title)
    }
    expect(maybe(root, 'iu4-wizard-step-1')).not.toBeNull()
  })

  it('hop selection filters to composable configs: only approved resolver_lookup rows appear as hop cards', async () => {
    apiFetchMock.mockImplementation(routeApiFetch())
    const root = mountPanel()
    await waitUntil(() => root.querySelector('[data-testid="iu4-wizard-hop1-rsc_material_lookup"]') !== null, 'hop cards load')

    expect(maybe(root, 'iu4-wizard-hop1-rsc_material_lookup')).not.toBeNull()
    expect(maybe(root, 'iu4-wizard-hop1-rsc_bom_lookup')).not.toBeNull()
    expect(maybe(root, 'iu4-wizard-hop1-rsc_list_page')).toBeNull()
    expect(maybe(root, 'iu4-wizard-hop1-rsc_draft_resolver')).toBeNull()
    expect(maybe(root, 'iu4-wizard-hop2-rsc_material_lookup')).not.toBeNull()
    expect(maybe(root, 'iu4-wizard-hop2-rsc_list_page')).toBeNull()
  })

  it('step-1 gating: next disabled until two DISTINCT hops are picked', async () => {
    apiFetchMock.mockImplementation(routeApiFetch())
    const root = mountPanel()
    await waitUntil(() => root.querySelector('[data-testid="iu4-wizard-hop1-rsc_material_lookup"]') !== null, 'hop cards load')

    expect(q<HTMLButtonElement>(root, 'iu4-wizard-next').disabled).toBe(true)

    q<HTMLButtonElement>(root, 'iu4-wizard-hop1-rsc_material_lookup').click()
    await flushUi()
    expect(q<HTMLButtonElement>(root, 'iu4-wizard-next').disabled).toBe(true) // hop2 not picked yet

    // Same config picked for both hops → still gated, with an explicit hint.
    q<HTMLButtonElement>(root, 'iu4-wizard-hop2-rsc_material_lookup').click()
    await flushUi()
    expect(q<HTMLButtonElement>(root, 'iu4-wizard-next').disabled).toBe(true)
    expect(maybe(root, 'iu4-wizard-hop-same-hint')).not.toBeNull()

    q<HTMLButtonElement>(root, 'iu4-wizard-hop2-rsc_bom_lookup').click()
    await flushUi()
    expect(maybe(root, 'iu4-wizard-hop-same-hint')).toBeNull()
    expect(q<HTMLButtonElement>(root, 'iu4-wizard-next').disabled).toBe(false)

    q<HTMLButtonElement>(root, 'iu4-wizard-next').click()
    await flushUi()
    expect(maybe(root, 'iu4-wizard-step-2')).not.toBeNull()
    expect(maybe(root, 'iu4-wizard-step-1')).toBeNull()
  })

  async function toStep2(root: HTMLElement): Promise<void> {
    q<HTMLButtonElement>(root, 'iu4-wizard-hop1-rsc_material_lookup').click()
    q<HTMLButtonElement>(root, 'iu4-wizard-hop2-rsc_bom_lookup').click()
    await flushUi()
    q<HTMLButtonElement>(root, 'iu4-wizard-next').click()
    await flushUi()
  }

  it('wiring diagram renders the hop1-output ↔ hop2-input correspondence, gated on a non-empty sourceTarget', async () => {
    apiFetchMock.mockImplementation(routeApiFetch())
    const root = mountPanel()
    await waitUntil(() => root.querySelector('[data-testid="iu4-wizard-hop1-rsc_material_lookup"]') !== null, 'hop cards load')
    await toStep2(root)

    // Default sourceTarget is 'internal_id' (panel-level default) → wiring already shows it.
    expect(q(root, 'iu4-wizard-wiring-output').textContent).toContain('internal_id')
    expect(q(root, 'iu4-wizard-wiring-input').textContent).toContain('key')
    expect(q(root, 'iu4-wizard-wiring-hop1').textContent).toContain('rsc_material_lookup')
    expect(q(root, 'iu4-wizard-wiring-hop2').textContent).toContain('rsc_bom_lookup')

    // Editing sourceTarget updates the output-side label live (still a static two-node diagram).
    setInput(root, 'iu4-wizard-source-target', 'resolved_key')
    await flushUi()
    expect(q(root, 'iu4-wizard-wiring-output').textContent).toContain('resolved_key')
    // Never a free canvas: exactly one connecting line / two nodes, never more.
    expect(root.querySelectorAll('[data-testid="iu4-wizard-wiring"] .iu4-wizard__wiring-node')).toHaveLength(2)

    setInput(root, 'iu4-wizard-source-target', '')
    await flushUi()
    expect(q<HTMLButtonElement>(root, 'iu4-wizard-next').disabled).toBe(true)
    setInput(root, 'iu4-wizard-source-target', 'internal_id')
    await flushUi()
    expect(q<HTMLButtonElement>(root, 'iu4-wizard-next').disabled).toBe(false)

    q<HTMLButtonElement>(root, 'iu4-wizard-next').click()
    await flushUi()
    expect(maybe(root, 'iu4-wizard-step-3')).not.toBeNull()
  })

  // `canWrite` is a Vue `computed` over `auth.hasPermission(...)`, which reads localStorage directly
  // (no reactive ref) — it has zero tracked dependencies, so once evaluated it never re-derives from a
  // LATER localStorage write within the same mounted instance. Every permission variant therefore
  // needs its OWN fresh mount with the permission set BEFORE mounting (same discipline as the sibling
  // IntegrationReadSourceCompositionAuthoringPanel.spec.ts, which always sets `user_permissions`
  // before `mountPanel()`, never mid-test).
  it('step-3 save button stays disabled without integration:write, with a permission hint', async () => {
    apiFetchMock.mockImplementation(routeApiFetch())
    const root = mountPanel()
    await waitUntil(() => root.querySelector('[data-testid="iu4-wizard-hop1-rsc_material_lookup"]') !== null, 'hop cards load')
    await toStep2(root)
    q<HTMLButtonElement>(root, 'iu4-wizard-next').click()
    await flushUi()
    setInput(root, 'iu4-wizard-name', 'material_to_bom_v1')
    await flushUi()

    expect(q<HTMLButtonElement>(root, 'iu4-wizard-save').disabled).toBe(true)
    expect(maybe(root, 'iu4-wizard-permission-hint')).not.toBeNull()
    q<HTMLButtonElement>(root, 'iu4-wizard-save').click()
    await flushUi()
    expect(apiFetchMock.mock.calls.some(([url, init]: [unknown, RequestInit?]) =>
      String(url).startsWith('/api/integration/read-source-compositions') && init?.method === 'POST')).toBe(false)
  })

  it('step-3 saves via the existing service path once integration:write is granted', async () => {
    const saveBodies: string[] = []
    apiFetchMock.mockImplementation(routeApiFetch({
      save: (init) => {
        saveBodies.push(String(init?.body ?? ''))
        return jsonResponse({ id: 'rscc_1', name: 'material_to_bom_v1', version: 1, status: 'draft', contentKey: 'ck', updatedAt: '2026-07-05', reused: false }, 201)
      },
    }))
    grantWrite()
    const root = mountPanel()
    await waitUntil(() => root.querySelector('[data-testid="iu4-wizard-hop1-rsc_material_lookup"]') !== null, 'hop cards load')
    await toStep2(root)
    q<HTMLButtonElement>(root, 'iu4-wizard-next').click()
    await flushUi()
    setInput(root, 'iu4-wizard-name', 'material_to_bom_v1')
    await flushUi()

    expect(q<HTMLButtonElement>(root, 'iu4-wizard-save').disabled).toBe(false)
    q<HTMLButtonElement>(root, 'iu4-wizard-save').click()
    await waitUntil(() => root.querySelector('[data-testid="iu4-wizard-save-result"]') !== null, 'save result appears')

    expect(saveBodies).toHaveLength(1)
    expect(JSON.parse(saveBodies[0])).toEqual({
      config: {
        version: 1,
        name: 'material_to_bom_v1',
        operations: ['read'],
        steps: [
          { id: 'step-1', readSourceConfigId: 'rsc_material_lookup' },
          { id: 'step-2', readSourceConfigId: 'rsc_bom_lookup', input: { fromStep: 'step-1', sourceTarget: 'internal_id', toInput: 'key' } },
        ],
      },
    })
    // The existing "已保存组合" side panel (approve/retire/audit, unconditional on view mode) shows the
    // same saved row too — it stays the surface for retire/audit once a composition is approved.
    expect(q(root, 'rscauth-saved').textContent).toContain('rscc_1')
  })

  it('step-3 "提交审批" approves the just-saved id via the existing approve path (design-lock §1 step ③)', async () => {
    const approveCalls: string[] = []
    apiFetchMock.mockImplementation(routeApiFetch({
      save: () => jsonResponse({ id: 'rscc_wiz', name: 'material_to_bom_v1', version: 1, status: 'draft', contentKey: 'ck', updatedAt: '2026-07-05', reused: false }, 201),
      approve: (id) => {
        approveCalls.push(id)
        return jsonResponse({ id, name: 'material_to_bom_v1', version: 1, status: 'approved', contentKey: 'ck', updatedAt: '2026-07-05' })
      },
    }))
    grantWrite()
    const root = mountPanel()
    await waitUntil(() => root.querySelector('[data-testid="iu4-wizard-hop1-rsc_material_lookup"]') !== null, 'hop cards load')
    await toStep2(root)
    q<HTMLButtonElement>(root, 'iu4-wizard-next').click()
    await flushUi()
    setInput(root, 'iu4-wizard-name', 'material_to_bom_v1')
    await flushUi()

    // No approve affordance before a save exists.
    expect(maybe(root, 'iu4-wizard-approve')).toBeNull()

    q<HTMLButtonElement>(root, 'iu4-wizard-save').click()
    await waitUntil(() => root.querySelector('[data-testid="iu4-wizard-approve"]') !== null, 'approve button appears')

    q<HTMLButtonElement>(root, 'iu4-wizard-approve').click()
    await waitUntil(() => q(root, 'rscauth-saved').textContent?.includes('已审批') === true, 'row becomes approved')
    expect(approveCalls).toEqual(['rscc_wiz'])
    // Once approved, the in-wizard approve button retires (mirrors the side panel's own
    // draft-status-only gating) — retire/audit for an approved row live in the shared side panel only.
    expect(maybe(root, 'iu4-wizard-approve')).toBeNull()
  })

  // THE byte-equality hard-lock test (design-lock §2): the same inputs driven through the wizard
  // surface and through the expert flat form must serialize to the IDENTICAL wire body — compared as
  // raw strings (byte equality), not just deep equality.
  async function captureWizardSaveBody(): Promise<string> {
    const bodies: string[] = []
    apiFetchMock.mockImplementation(routeApiFetch({
      save: (init) => {
        bodies.push(String(init?.body ?? ''))
        return jsonResponse({ id: 'rscc_a', name: 'material_to_bom_v1', version: 1, status: 'draft', contentKey: 'ck', updatedAt: '2026-07-05', reused: false }, 201)
      },
    }))
    grantWrite()
    const root = mountPanel()
    await waitUntil(() => root.querySelector('[data-testid="iu4-wizard-hop1-rsc_material_lookup"]') !== null, 'hop cards load')
    q<HTMLButtonElement>(root, 'iu4-wizard-hop1-rsc_material_lookup').click()
    q<HTMLButtonElement>(root, 'iu4-wizard-hop2-rsc_bom_lookup').click()
    await flushUi()
    q<HTMLButtonElement>(root, 'iu4-wizard-next').click()
    await flushUi()
    setInput(root, 'iu4-wizard-source-target', ' resolved_material_id ')
    await flushUi()
    q<HTMLButtonElement>(root, 'iu4-wizard-next').click()
    await flushUi()
    setInput(root, 'iu4-wizard-name', ' material_to_bom_v1 ')
    await flushUi()
    q<HTMLButtonElement>(root, 'iu4-wizard-save').click()
    await flushUi()
    unmountPanel()
    expect(bodies).toHaveLength(1)
    return bodies[0]
  }

  async function captureExpertSaveBody(): Promise<string> {
    const bodies: string[] = []
    apiFetchMock.mockImplementation(routeApiFetch({
      save: (init) => {
        bodies.push(String(init?.body ?? ''))
        return jsonResponse({ id: 'rscc_b', name: 'material_to_bom_v1', version: 1, status: 'draft', contentKey: 'ck', updatedAt: '2026-07-05', reused: false }, 201)
      },
    }))
    grantWrite()
    const root = mountPanel('expert')
    await waitUntil(() => root.querySelector('option[value="rsc_material_lookup"]') !== null, 'pickers load')
    setSelect(root, 'rscauth-step1', 'rsc_material_lookup')
    setSelect(root, 'rscauth-step2', 'rsc_bom_lookup')
    setInput(root, 'rscauth-name', ' material_to_bom_v1 ')
    setInput(root, 'rscauth-source-target', ' resolved_material_id ')
    await flushUi()
    q<HTMLButtonElement>(root, 'rscauth-save').click()
    await flushUi()
    unmountPanel()
    expect(bodies).toHaveLength(1)
    return bodies[0]
  }

  it('BYTE-EQUALITY: wizard output === expert-form output for the same two-hop inputs', async () => {
    const wizardBody = await captureWizardSaveBody()
    const expertBody = await captureExpertSaveBody()

    expect(wizardBody).toBe(expertBody) // byte-for-byte identical wire body
    expect(JSON.parse(wizardBody)).toEqual({
      config: {
        version: 1,
        name: 'material_to_bom_v1',
        operations: ['read'],
        steps: [
          { id: 'step-1', readSourceConfigId: 'rsc_material_lookup' },
          { id: 'step-2', readSourceConfigId: 'rsc_bom_lookup', input: { fromStep: 'step-1', sourceTarget: 'resolved_material_id', toInput: 'key' } },
        ],
      },
    })
  })

  it('expert-mode toggle: switches to the intact flat form and back (折叠≠删除)', async () => {
    apiFetchMock.mockImplementation(routeApiFetch())
    const root = mountPanel()
    await waitUntil(() => root.querySelector('[data-testid="iu4-wizard-hop1-rsc_material_lookup"]') !== null, 'hop cards load')

    expect(maybe(root, 'composition-wizard')).not.toBeNull()
    expect(q(root, 'rscauth-mode-toggle').textContent).toContain('Expert form')

    q<HTMLButtonElement>(root, 'rscauth-mode-toggle').click()
    await flushUi()
    // The full flat form is back, untouched — spot-check its signature controls (the exhaustive
    // flat-form behavior suite is IntegrationReadSourceCompositionAuthoringPanel.spec.ts, unchanged).
    expect(maybe(root, 'composition-wizard')).toBeNull()
    for (const testid of ['rscauth-step1', 'rscauth-step2', 'rscauth-name', 'rscauth-source-target', 'rscauth-save', 'rscauth-refresh']) {
      expect(maybe(root, testid), testid).not.toBeNull()
    }
    expect(q(root, 'rscauth-mode-toggle').textContent).toContain('Back to wizard')

    q<HTMLButtonElement>(root, 'rscauth-mode-toggle').click()
    await flushUi()
    expect(maybe(root, 'composition-wizard')).not.toBeNull()
    expect(maybe(root, 'rscauth-step1')).toBeNull()
  })

  it('zh copy renders through useLocale for step titles, hop groups, wiring labels, and toggle', async () => {
    // Test-env default locale is 'en'; flip via the composable's setter (module-level ref — a
    // localStorage write alone would not re-resolve it), same pattern as the sibling wizard spec.
    const { setLocale } = useLocale()
    setLocale('zh-CN')
    try {
      apiFetchMock.mockImplementation(routeApiFetch())
      const root = mountPanel()
      await waitUntil(() => root.querySelector('[data-testid="iu4-wizard-hop1-rsc_material_lookup"]') !== null, 'hop cards load')

      const stepsText = q(root, 'iu4-wizard-steps').textContent ?? ''
      for (const title of ['①选两跳', '②接线可视', '③审批']) {
        expect(stepsText).toContain(title)
      }
      expect(q(root, 'rscauth-mode-toggle').textContent).toContain('专家表单')
      expect(q(root, 'iu4-wizard-next').textContent).toContain('下一步')

      await toStep2(root)
      expect(q(root, 'iu4-wizard-wiring-hop1').textContent).toContain('第一跳')
      expect(q(root, 'iu4-wizard-wiring-hop2').textContent).toContain('第二跳')
    } finally {
      setLocale('en')
    }
  })
})
