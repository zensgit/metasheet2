import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp } from 'vue'
import { useLocale } from '../src/composables/useLocale'

const apiFetchMock = vi.fn()

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiGet: vi.fn(),
}))

import IntegrationReadSourceConfigPanel from '../src/components/integration/IntegrationReadSourceConfigPanel.vue'
import type { WorkbenchExternalSystem } from '../src/services/integration/workbench'

// IU-3 four-step read-source wizard (design-lock
// docs/development/integration-iu3-read-source-wizard-design-lock-20260707.md, #3797).
//
// Every test here mounts the REAL IntegrationReadSourceConfigPanel in its DEFAULT mode (wizard) —
// not the wizard component in isolation — so the parent↔wizard wiring (shared draft, v-model
// bounded-smoke / probe-key, emitted run-probe / save-version / approve-saved landing on the SAME
// panel functions the expert buttons call) is exercised end-to-end against the same apiFetch mock
// discipline as IntegrationReadSourceConfigPanel.spec.ts. That sibling spec pins the panel to
// expert mode and is unchanged assertion-for-assertion (design-lock §2 既有测试不变量).
//
// el-steps / el-step / el-icon stubs: same approach as IU-2a's ElCard stub in
// IntegrationWorkbenchView.spec.ts — real Element Plus is not globally installed in these bare
// `createApp()` instances, so the tags the wizard template uses get minimal local stubs that render
// their slot/title content (dropping them would delete the step header titles from the test DOM).
// All step NAVIGATION in the component is plain <button> + internal state — nothing in these tests
// (or the component) relies on Element Plus behavior.
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

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

// Macrotask-hop flush (same rationale as IntegrationWorkbenchView.spec.ts): microtask+nextTick alone
// is not enough on Node 20's scheduler for fetch-mock chains — hop a timer turn each cycle.
async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

const SYSTEMS: WorkbenchExternalSystem[] = [
  { id: 'sys_1', tenantId: 'default', workspaceId: null, name: 'K3 WISE', kind: 'erp:k3-wise-webapi', role: 'target', status: 'active' },
  { id: 'sys_http', tenantId: 'default', workspaceId: null, name: 'Generic HTTP', kind: 'http', role: 'source', status: 'active' },
]

describe('IntegrationReadSourceWizard (via IntegrationReadSourceConfigPanel default surface)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  let originalConfirm: typeof window.confirm | undefined
  let confirmMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    apiFetchMock.mockReset()
    originalConfirm = window.confirm
    confirmMock = vi.fn(() => true)
    Object.defineProperty(window, 'confirm', { configurable: true, value: confirmMock })
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    Object.defineProperty(window, 'confirm', { configurable: true, value: originalConfirm })
    app = null
    container = null
  })

  function mountPanel(initialViewMode?: 'wizard' | 'expert'): HTMLDivElement {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({
      render: () => h(IntegrationReadSourceConfigPanel, {
        scope: { tenantId: 'default', workspaceId: null },
        systems: SYSTEMS,
        ...(initialViewMode ? { initialViewMode } : {}),
      }),
    })
    app.component('ElSteps', ElSteps)
    app.component('ElStep', ElStep)
    app.component('ElIcon', ElIcon)
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

  function mockListOnly(rows: unknown[] = []): void {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.startsWith('/api/integration/read-source-configs')) {
        return jsonResponse(rows)
      }
      return jsonResponse(null)
    })
  }

  // Drives the wizard to step 2 with sys_1 selected (step-1 happy path).
  async function toStep2(root: HTMLElement): Promise<void> {
    q<HTMLButtonElement>(root, 'rsc-wizard-system-sys_1').click()
    await flushUi()
    q<HTMLButtonElement>(root, 'rsc-wizard-next').click()
    await flushUi()
  }

  async function fillValidSingleRecordStep2(root: HTMLElement): Promise<void> {
    setInput(root, 'rsc-wizard-object', 'material')
    setInput(root, 'rsc-wizard-read-path', 'K3API/Material/GetDetail')
    setInput(root, 'rsc-wizard-key-field', 'FNumber')
    setInput(root, 'rsc-wizard-container-paths', 'Data')
    await flushUi()
  }

  it('wizard is the DEFAULT new-config surface: four steps render, flat form is not mounted', async () => {
    mockListOnly()
    const root = mountPanel()
    await flushUi()

    expect(maybe(root, 'read-source-wizard')).not.toBeNull()
    // The expert flat form's own controls are absent by default (wizard replaces, not duplicates).
    expect(maybe(root, 'rsc-system')).toBeNull()
    expect(maybe(root, 'rsc-mode')).toBeNull()
    // Four step titles render through the ElSteps/ElStep stubs (en default locale).
    const stepsText = q(root, 'rsc-wizard-steps').textContent ?? ''
    for (const title of ['① Pick system', '② Define shape', '③ Probe', '④ Approve']) {
      expect(stepsText).toContain(title)
    }
    // Step 1 active; the saved-configs list column still renders beside the wizard.
    expect(maybe(root, 'rsc-wizard-step-1')).not.toBeNull()
    expect(maybe(root, 'read-source-list')).not.toBeNull()
  })

  it('step-1 gating: next disabled until a system card is picked; picking fills requiredKind', async () => {
    mockListOnly()
    const root = mountPanel()
    await flushUi()

    expect(q<HTMLButtonElement>(root, 'rsc-wizard-next').disabled).toBe(true)
    expect(maybe(root, 'rsc-wizard-system-sys_1')).not.toBeNull()
    expect(maybe(root, 'rsc-wizard-system-sys_http')).not.toBeNull()

    q<HTMLButtonElement>(root, 'rsc-wizard-system-sys_1').click()
    await flushUi()
    expect(q<HTMLButtonElement>(root, 'rsc-wizard-next').disabled).toBe(false)

    q<HTMLButtonElement>(root, 'rsc-wizard-next').click()
    await flushUi()
    expect(maybe(root, 'rsc-wizard-step-2')).not.toBeNull()
    expect(maybe(root, 'rsc-wizard-step-1')).toBeNull()
  })

  it('step-2 gating: cannot advance past ② until the selected mode\'s required fields validate', async () => {
    mockListOnly()
    const root = mountPanel()
    await flushUi()
    await toStep2(root)

    // single_record default: missing object/readPath/keyField/containerPaths → validation list + gated next.
    expect(q<HTMLButtonElement>(root, 'rsc-wizard-next').disabled).toBe(true)
    expect(q(root, 'rsc-wizard-validation').textContent).toContain('keyField')

    await fillValidSingleRecordStep2(root)
    expect(maybe(root, 'rsc-wizard-validation')).toBeNull()
    expect(q<HTMLButtonElement>(root, 'rsc-wizard-next').disabled).toBe(false)

    q<HTMLButtonElement>(root, 'rsc-wizard-next').click()
    await flushUi()
    expect(maybe(root, 'rsc-wizard-step-3')).not.toBeNull()
  })

  it('preset card selection expands exactly that mode\'s MODE_REQUIRED_FIELDS field set (all four modes)', async () => {
    mockListOnly()
    const root = mountPanel()
    await flushUi()
    await toStep2(root)

    // All four cards render.
    for (const mode of ['single_record', 'list_page', 'detail_with_lines', 'resolver_lookup']) {
      expect(maybe(root, `rsc-wizard-mode-${mode}`), mode).not.toBeNull()
    }

    // single_record (default selected): keyField + containerPaths; no header/lines/resolverRule.
    expect(maybe(root, 'rsc-wizard-key-field')).not.toBeNull()
    expect(maybe(root, 'rsc-wizard-container-paths')).not.toBeNull()
    expect(maybe(root, 'rsc-wizard-header-container-paths')).toBeNull()
    expect(maybe(root, 'rsc-wizard-line-container-paths')).toBeNull()
    expect(maybe(root, 'rsc-wizard-resolver-rule')).toBeNull()

    // list_page: containerPaths only.
    q<HTMLButtonElement>(root, 'rsc-wizard-mode-list_page').click()
    await flushUi()
    expect(maybe(root, 'rsc-wizard-key-field')).toBeNull()
    expect(maybe(root, 'rsc-wizard-container-paths')).not.toBeNull()
    expect(maybe(root, 'rsc-wizard-resolver-rule')).toBeNull()

    // detail_with_lines: header + lines replace containerPaths; keyField only as Advanced optional.
    q<HTMLButtonElement>(root, 'rsc-wizard-mode-detail_with_lines').click()
    await flushUi()
    expect(maybe(root, 'rsc-wizard-container-paths')).toBeNull()
    expect(maybe(root, 'rsc-wizard-header-container-paths')).not.toBeNull()
    expect(maybe(root, 'rsc-wizard-line-container-paths')).not.toBeNull()
    expect(maybe(root, 'rsc-wizard-key-field')).toBeNull()
    q<HTMLButtonElement>(root, 'rsc-wizard-advanced-toggle').click()
    await flushUi()
    expect(maybe(root, 'rsc-wizard-key-field-optional')).not.toBeNull()
    expect(maybe(root, 'rsc-wizard-key-encoding')).not.toBeNull()

    // resolver_lookup: keyField + containerPaths + resolverRule; rule detail fields live in Advanced.
    q<HTMLButtonElement>(root, 'rsc-wizard-mode-resolver_lookup').click()
    await flushUi()
    expect(maybe(root, 'rsc-wizard-key-field')).not.toBeNull()
    expect(maybe(root, 'rsc-wizard-container-paths')).not.toBeNull()
    expect(maybe(root, 'rsc-wizard-resolver-rule')).not.toBeNull()
    setSelect(root, 'rsc-wizard-resolver-rule', 'first_when_sorted')
    await flushUi()
    expect(maybe(root, 'rsc-wizard-resolver-sort-field')).not.toBeNull()
    expect(maybe(root, 'rsc-wizard-resolver-sort-direction')).not.toBeNull()
    expect(maybe(root, 'rsc-wizard-resolver-discriminator-value')).toBeNull()
    setSelect(root, 'rsc-wizard-resolver-rule', 'field_equals')
    await flushUi()
    expect(maybe(root, 'rsc-wizard-resolver-discriminator-field')).not.toBeNull()
    expect(maybe(root, 'rsc-wizard-resolver-discriminator-value')).not.toBeNull()
    expect(maybe(root, 'rsc-wizard-resolver-sort-direction')).toBeNull()
  })

  it('back-navigation returns through earlier steps with state preserved', async () => {
    mockListOnly()
    const root = mountPanel()
    await flushUi()
    await toStep2(root)
    await fillValidSingleRecordStep2(root)
    q<HTMLButtonElement>(root, 'rsc-wizard-next').click()
    await flushUi()
    expect(maybe(root, 'rsc-wizard-step-3')).not.toBeNull()

    q<HTMLButtonElement>(root, 'rsc-wizard-back').click()
    await flushUi()
    expect(maybe(root, 'rsc-wizard-step-2')).not.toBeNull()
    expect(q<HTMLInputElement>(root, 'rsc-wizard-object').value).toBe('material')

    q<HTMLButtonElement>(root, 'rsc-wizard-back').click()
    await flushUi()
    expect(maybe(root, 'rsc-wizard-step-1')).not.toBeNull()
    expect(q<HTMLButtonElement>(root, 'rsc-wizard-back').disabled).toBe(true)
  })

  it('step-3 probe posts the SAME contract body as the expert form and renders a humanized evidence card with collapsed raw codes', async () => {
    const probeBodies: Array<string> = []
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/integration/read-source-configs')) return jsonResponse([])
      if (url.startsWith('/api/integration/external-systems/sys_1/read-source-probe')) {
        probeBodies.push(String(init?.body ?? ''))
        return jsonResponse({
          ok: false,
          object: 'material',
          mode: 'single_record',
          boundedSmoke: true,
          errorCode: 'READ_SOURCE_PROBE_CONTAINER_NOT_FOUND',
          errorType: 'ReadSourceProbeRuntimeError',
          containers: { primary: { type: 'missing', arrayLength: null } },
          containerLocated: false,
        })
      }
      return jsonResponse(null)
    })
    const root = mountPanel()
    await flushUi()
    await toStep2(root)
    await fillValidSingleRecordStep2(root)
    q<HTMLButtonElement>(root, 'rsc-wizard-next').click()
    await flushUi()

    // keyField declared → the probe-key input shows (same S2-b rule as the expert form).
    const smoke = q<HTMLInputElement>(root, 'rsc-wizard-bounded-smoke')
    smoke.checked = true
    smoke.dispatchEvent(new Event('change'))
    await flushUi()
    setInput(root, 'rsc-wizard-probe-key', ' M-001 ')
    await flushUi()

    q<HTMLButtonElement>(root, 'rsc-wizard-probe-run').click()
    await flushUi()

    expect(probeBodies).toHaveLength(1)
    expect(JSON.parse(probeBodies[0])).toEqual({
      config: {
        version: 1,
        systemId: 'sys_1',
        requiredKind: 'erp:k3-wise-webapi',
        object: 'material',
        mode: 'single_record',
        readPath: '/K3API/Material/GetDetail',
        readMethod: 'POST',
        operations: ['read'],
        keyField: 'FNumber',
        containerPaths: ['Data'],
      },
      boundedSmoke: true,
      inputs: { key: 'M-001' },
    })

    // Humanized conclusion in the prominent slot (IU-1 label module, en default locale)…
    expect(q(root, 'rsc-wizard-evidence-summary').textContent).toContain('The target data container could not be found.')
    // …container shape visible…
    expect(q(root, 'rsc-wizard-evidence-container-primary').textContent).toContain('missing')
    // …and raw machine codes demoted into a collapsed <details> block.
    const raw = q<HTMLDetailsElement>(root, 'rsc-wizard-evidence-raw')
    expect(raw.hasAttribute('open')).toBe(false)
    expect(q(root, 'rsc-wizard-evidence-error-code').textContent).toContain('READ_SOURCE_PROBE_CONTAINER_NOT_FOUND')
    expect(q(root, 'rsc-wizard-evidence-error-type').textContent).toContain('ReadSourceProbeRuntimeError')
    // The raw code never appears in the prominent summary slot.
    expect(q(root, 'rsc-wizard-evidence-summary').textContent).not.toContain('READ_SOURCE_PROBE_CONTAINER_NOT_FOUND')
  })

  it('step-4 saves via the existing service path, then approves the saved id via the existing approve path', async () => {
    const saveBodies: string[] = []
    const approveCalls: string[] = []
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/approve') && init?.method === 'POST') {
        approveCalls.push(url)
        return jsonResponse({ id: 'cfg_wiz', systemId: 'sys_1', object: 'material', mode: 'single_record', version: 1, status: 'approved', contentKey: 'ck' })
      }
      if (url.startsWith('/api/integration/read-source-configs') && init?.method === 'POST') {
        saveBodies.push(String(init?.body ?? ''))
        return jsonResponse({ id: 'cfg_wiz', version: 1, status: 'draft', reused: false, contentKey: 'ck' })
      }
      if (url.startsWith('/api/integration/read-source-configs')) return jsonResponse([])
      return jsonResponse(null)
    })
    const root = mountPanel()
    await flushUi()
    await toStep2(root)
    await fillValidSingleRecordStep2(root)
    q<HTMLButtonElement>(root, 'rsc-wizard-next').click()
    await flushUi()
    q<HTMLButtonElement>(root, 'rsc-wizard-next').click()
    await flushUi()
    expect(maybe(root, 'rsc-wizard-step-4')).not.toBeNull()

    // No approve affordance before a save result exists.
    expect(maybe(root, 'rsc-wizard-approve')).toBeNull()

    q<HTMLButtonElement>(root, 'rsc-wizard-save').click()
    await flushUi()
    expect(saveBodies).toHaveLength(1)
    expect(q(root, 'rsc-wizard-save-result').textContent).toContain('v1')

    // Approve requires confirm (same guard as the expert list-row approve); cancel = no call.
    confirmMock.mockReturnValueOnce(false)
    q<HTMLButtonElement>(root, 'rsc-wizard-approve').click()
    await flushUi()
    expect(approveCalls).toHaveLength(0)

    confirmMock.mockReturnValueOnce(true)
    q<HTMLButtonElement>(root, 'rsc-wizard-approve').click()
    await flushUi()
    expect(approveCalls).toHaveLength(1)
    expect(approveCalls[0]).toContain('/api/integration/read-source-configs/cfg_wiz/approve')
  })

  // THE byte-equality hard-lock test (design-lock §2): the same inputs driven through the wizard
  // surface and through the expert flat form must serialize to the IDENTICAL wire body — compared
  // as raw strings (byte equality), not just deep equality.
  async function captureWizardSaveBody(fill: (root: HTMLElement) => Promise<void>): Promise<string> {
    const bodies: string[] = []
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/integration/read-source-configs') && init?.method === 'POST') {
        bodies.push(String(init?.body ?? ''))
        return jsonResponse({ id: 'cfg_a', version: 1, status: 'draft', reused: false, contentKey: 'ck' })
      }
      if (url.startsWith('/api/integration/read-source-configs')) return jsonResponse([])
      return jsonResponse(null)
    })
    const root = mountPanel()
    await flushUi()
    await fill(root)
    q<HTMLButtonElement>(root, 'rsc-wizard-next').click()
    await flushUi()
    q<HTMLButtonElement>(root, 'rsc-wizard-next').click()
    await flushUi()
    q<HTMLButtonElement>(root, 'rsc-wizard-save').click()
    await flushUi()
    unmountPanel()
    expect(bodies).toHaveLength(1)
    return bodies[0]
  }

  async function captureExpertSaveBody(fill: (root: HTMLElement) => Promise<void>): Promise<string> {
    const bodies: string[] = []
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/integration/read-source-configs') && init?.method === 'POST') {
        bodies.push(String(init?.body ?? ''))
        return jsonResponse({ id: 'cfg_b', version: 1, status: 'draft', reused: false, contentKey: 'ck' })
      }
      if (url.startsWith('/api/integration/read-source-configs')) return jsonResponse([])
      return jsonResponse(null)
    })
    const root = mountPanel('expert')
    await flushUi()
    await fill(root)
    q<HTMLButtonElement>(root, 'rsc-save').click()
    await flushUi()
    unmountPanel()
    expect(bodies).toHaveLength(1)
    return bodies[0]
  }

  it('BYTE-EQUALITY: wizard output === expert-form output for the same single_record inputs (incl. advanced fields)', async () => {
    const wizardBody = await captureWizardSaveBody(async (root) => {
      await toStep2(root)
      await fillValidSingleRecordStep2(root)
      // Advanced fields too: keyEncoding + readMethod + fieldMap (with whitespace to exercise trimming).
      q<HTMLButtonElement>(root, 'rsc-wizard-advanced-toggle').click()
      await flushUi()
      setSelect(root, 'rsc-wizard-key-encoding', 'numeric_id')
      setSelect(root, 'rsc-wizard-read-method', 'GET')
      q<HTMLButtonElement>(root, 'rsc-wizard-field-map-add').click()
      await flushUi()
      setInput(root, 'rsc-wizard-field-map-source-0', ' FName ')
      setInput(root, 'rsc-wizard-field-map-target-0', ' material_name ')
      await flushUi()
    })

    const expertBody = await captureExpertSaveBody(async (root) => {
      setSelect(root, 'rsc-system', 'sys_1')
      await flushUi()
      setInput(root, 'rsc-object', 'material')
      setInput(root, 'rsc-read-path', 'K3API/Material/GetDetail')
      setInput(root, 'rsc-key-field', 'FNumber')
      setInput(root, 'rsc-container-paths', 'Data')
      setSelect(root, 'rsc-key-encoding', 'numeric_id')
      setSelect(root, 'rsc-read-method', 'GET')
      q<HTMLButtonElement>(root, 'rsc-field-map-add').click()
      await flushUi()
      setInput(root, 'rsc-field-map-source-0', ' FName ')
      setInput(root, 'rsc-field-map-target-0', ' material_name ')
      await flushUi()
    })

    expect(wizardBody).toBe(expertBody) // byte-for-byte identical wire body
    // Sanity: the shared body really is the fully-normalized S1 config (not two matching empties).
    expect(JSON.parse(wizardBody)).toEqual({
      config: {
        version: 1,
        systemId: 'sys_1',
        requiredKind: 'erp:k3-wise-webapi',
        object: 'material',
        mode: 'single_record',
        readPath: '/K3API/Material/GetDetail',
        readMethod: 'GET',
        operations: ['read'],
        keyField: 'FNumber',
        keyEncoding: 'numeric_id',
        containerPaths: ['Data'],
        fieldMap: [{ source: 'FName', target: 'material_name' }],
      },
    })
  })

  it('BYTE-EQUALITY: wizard output === expert-form output for resolver_lookup / field_equals', async () => {
    const wizardBody = await captureWizardSaveBody(async (root) => {
      await toStep2(root)
      q<HTMLButtonElement>(root, 'rsc-wizard-mode-resolver_lookup').click()
      await flushUi()
      setInput(root, 'rsc-wizard-object', 'material')
      setInput(root, 'rsc-wizard-read-path', '/K3API/Material/GetList')
      setInput(root, 'rsc-wizard-key-field', 'FNumber')
      setInput(root, 'rsc-wizard-container-paths', 'Data')
      setSelect(root, 'rsc-wizard-resolver-rule', 'field_equals')
      await flushUi()
      q<HTMLButtonElement>(root, 'rsc-wizard-advanced-toggle').click()
      await flushUi()
      setInput(root, 'rsc-wizard-resolver-discriminator-field', 'FIsCurrent')
      setInput(root, 'rsc-wizard-resolver-discriminator-value', 'Y')
      q<HTMLButtonElement>(root, 'rsc-wizard-field-map-add').click()
      await flushUi()
      setInput(root, 'rsc-wizard-field-map-source-0', 'FItemID')
      setInput(root, 'rsc-wizard-field-map-target-0', 'item_id')
      await flushUi()
    })

    const expertBody = await captureExpertSaveBody(async (root) => {
      setSelect(root, 'rsc-system', 'sys_1')
      await flushUi()
      setSelect(root, 'rsc-mode', 'resolver_lookup')
      await flushUi()
      setInput(root, 'rsc-object', 'material')
      setInput(root, 'rsc-read-path', '/K3API/Material/GetList')
      setInput(root, 'rsc-key-field', 'FNumber')
      setInput(root, 'rsc-container-paths', 'Data')
      setSelect(root, 'rsc-resolver-rule', 'field_equals')
      await flushUi()
      setInput(root, 'rsc-resolver-discriminator-field', 'FIsCurrent')
      setInput(root, 'rsc-resolver-discriminator-value', 'Y')
      q<HTMLButtonElement>(root, 'rsc-field-map-add').click()
      await flushUi()
      setInput(root, 'rsc-field-map-source-0', 'FItemID')
      setInput(root, 'rsc-field-map-target-0', 'item_id')
      await flushUi()
    })

    expect(wizardBody).toBe(expertBody)
    expect(JSON.parse(wizardBody)).toEqual({
      config: {
        version: 1,
        systemId: 'sys_1',
        requiredKind: 'erp:k3-wise-webapi',
        object: 'material',
        mode: 'resolver_lookup',
        readPath: '/K3API/Material/GetList',
        readMethod: 'POST',
        operations: ['read'],
        keyField: 'FNumber',
        resolverRule: 'field_equals',
        multiplicityRuleField: 'FIsCurrent',
        resolverDiscriminatorValue: 'Y',
        containerPaths: ['Data'],
        fieldMap: [{ source: 'FItemID', target: 'item_id' }],
      },
    })
  })

  it('expert-mode toggle: switches to the intact flat form and back (折叠≠删除)', async () => {
    mockListOnly()
    const root = mountPanel()
    await flushUi()

    expect(maybe(root, 'read-source-wizard')).not.toBeNull()
    expect(q(root, 'rsc-mode-toggle').textContent).toContain('Expert form')

    q<HTMLButtonElement>(root, 'rsc-mode-toggle').click()
    await flushUi()
    // The full flat form is back, untouched — spot-check its signature controls (the exhaustive
    // flat-form behavior suite is IntegrationReadSourceConfigPanel.spec.ts, unchanged).
    expect(maybe(root, 'read-source-wizard')).toBeNull()
    for (const testid of ['rsc-system', 'rsc-required-kind', 'rsc-object', 'rsc-mode', 'rsc-read-path', 'rsc-read-method', 'rsc-operations', 'rsc-version', 'rsc-key-field', 'rsc-key-encoding', 'rsc-container-paths', 'rsc-field-map-add', 'rsc-probe', 'rsc-save']) {
      expect(maybe(root, testid), testid).not.toBeNull()
    }
    expect(q(root, 'rsc-mode-toggle').textContent).toContain('Back to wizard')

    q<HTMLButtonElement>(root, 'rsc-mode-toggle').click()
    await flushUi()
    expect(maybe(root, 'read-source-wizard')).not.toBeNull()
    expect(maybe(root, 'rsc-system')).toBeNull()
  })

  it('zh copy renders through useLocale for step titles, preset cards, nav, and toggle', async () => {
    // Test-env default locale is 'en'; flip via the composable's setter (module-level ref — a
    // localStorage write alone would not re-resolve it), same pattern as the panel spec's zh test.
    const { setLocale } = useLocale()
    setLocale('zh-CN')
    try {
      mockListOnly()
      const root = mountPanel()
      await flushUi()

      const stepsText = q(root, 'rsc-wizard-steps').textContent ?? ''
      for (const title of ['①选系统', '②定形状', '③探测', '④审批']) {
        expect(stepsText).toContain(title)
      }
      expect(q(root, 'rsc-mode-toggle').textContent).toContain('专家表单')
      expect(q(root, 'rsc-wizard-next').textContent).toContain('下一步')
      expect(q(root, 'rsc-wizard-back').textContent).toContain('上一步')

      await toStep2(root)
      const presetGrid = q(root, 'rsc-wizard-preset-grid').textContent ?? ''
      for (const title of ['单记录读', '列表分页读', '主从明细读', '解析定位读']) {
        expect(presetGrid).toContain(title)
      }
      expect(q(root, 'rsc-wizard-advanced-toggle').textContent).toContain('高级')
    } finally {
      setLocale('en')
    }
  })

  // --- TC-1 connector/experience template catalog (design-lock
  // docs/development/integration-connector-template-catalog-design-lock-20260708.md, #3879) ---------
  // ADD-ONLY: every test above this point is unchanged. The template catalog picker is a NEW,
  // collapsed-by-default entry point rendered by the parent panel (IntegrationReadSourceConfigPanel.vue)
  // above the wizard; these tests exercise it end-to-end through the same real panel this file already
  // mounts, never a standalone stub of the picker.

  it('TC-1: template catalog picker is collapsed by default — the blank-form wizard path is unaffected', async () => {
    mockListOnly()
    const root = mountPanel()
    await flushUi()

    expect(maybe(root, 'rsc-template-catalog-toggle')).not.toBeNull()
    const body = maybe(root, 'rsc-template-catalog-body')
    expect(body).not.toBeNull()
    expect((body as HTMLElement).style.display).toBe('none')

    // Blank-form entry still works exactly as before: default mode is single_record (existing
    // 'preset card selection' test already proves the full field set; this just re-confirms the
    // default survives the picker's presence).
    await toStep2(root)
    expect(q(root, 'rsc-wizard-mode-single_record').className).toContain('iu3-wizard__card--selected')
    expect(maybe(root, 'rsc-wizard-key-field')).not.toBeNull()
  })

  it('TC-1: selecting a read-source template card seeds draft.mode to EXACTLY what manually clicking that mode\'s preset card would', async () => {
    mockListOnly()
    const root = mountPanel()
    await flushUi()

    // Expand the picker and select the "generic HTTP · list_page" template BEFORE even picking a
    // system — the seed only ever touches `mode`, so it must survive step-1's system selection
    // untouched and land on step 2 exactly as if the user had clicked the list_page card there.
    q<HTMLButtonElement>(root, 'rsc-template-catalog-toggle').click()
    await flushUi()
    expect(maybe(root, 'rsc-template-catalog-card-http-read-list-page')).not.toBeNull()
    q<HTMLButtonElement>(root, 'rsc-template-catalog-card-http-read-list-page').click()
    await flushUi()

    await toStep2(root)
    expect(q(root, 'rsc-wizard-mode-list_page').className).toContain('iu3-wizard__card--selected')
    // Same field set the manual-selection test asserts for list_page: containerPaths only, no keyField.
    expect(maybe(root, 'rsc-wizard-key-field')).toBeNull()
    expect(maybe(root, 'rsc-wizard-container-paths')).not.toBeNull()
    expect(maybe(root, 'rsc-wizard-resolver-rule')).toBeNull()
  })

  it('TC-1: selecting a template forces the panel back to wizard view even from expert mode', async () => {
    mockListOnly()
    const root = mountPanel('expert')
    await flushUi()
    expect(maybe(root, 'read-source-wizard')).toBeNull()
    expect(maybe(root, 'rsc-system')).not.toBeNull()

    q<HTMLButtonElement>(root, 'rsc-template-catalog-toggle').click()
    await flushUi()
    q<HTMLButtonElement>(root, 'rsc-template-catalog-card-k3-wise-webapi-single-record').click()
    await flushUi()

    expect(maybe(root, 'read-source-wizard')).not.toBeNull()
    expect(maybe(root, 'rsc-system')).toBeNull()
  })

  it('TC-1: template catalog card copy renders bilingually via useLocale', async () => {
    const { setLocale } = useLocale()
    setLocale('zh-CN')
    try {
      mockListOnly()
      const root = mountPanel()
      await flushUi()
      expect(q(root, 'rsc-template-catalog-toggle').textContent).toContain('从模板开始')
      q<HTMLButtonElement>(root, 'rsc-template-catalog-toggle').click()
      await flushUi()
      expect(q(root, 'rsc-template-catalog-card-http-read-single-record').textContent).toContain('通用 HTTP 读取源')
    } finally {
      setLocale('en')
    }
  })
})
