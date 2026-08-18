/**
 * F4 route-level drag-state clearing (delta §5 F4, F2-gate handoff condition 3;
 * approval-form-builder-parity-delta-design-20260811.md §3.1: "route change ...
 * clear[s] all transient drag state"). `ApprovalFormBuilder`'s own `onBeforeUnmount`
 * (F2) already clears the shared drag session on a GENUINE unmount, but `v-show`
 * keeps the step chrome — and therefore the mounted builder — alive across
 * `activeAuthoringSection` switches, and `TemplateAuthoringView`'s pre-existing
 * `onBeforeRouteLeave` dirty-draft guard can be CANCELLED (user picks 留下): no
 * unmount ever happens even though a navigation attempt began and any in-flight
 * drag was already visually interrupted. This spec constructs exactly that leak
 * with a REAL vue-router (unlike apps/web/tests/approvalTemplateAuthoring.spec.ts,
 * which mocks `useRoute`/`useRouter` and leaves `onBeforeRouteLeave` a documented
 * no-op — see that file's top-of-file `vi.mock('vue-router', ...)`).
 *
 * Mount pattern: repo-standard `createApp` + real DOM events (no test-utils),
 * mirroring apps/web/tests/approvalTemplateAuthoring.spec.ts's stub set, PLUS a
 * real `createRouter`/`createMemoryHistory` so `onBeforeRouteLeave` genuinely
 * registers and fires.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, type App as VueApp } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router'
import TemplateAuthoringView from '../src/views/approval/TemplateAuthoringView.vue'
import { APPROVAL_FORM_DRAG_MIME } from '../src/approvals/approvalFormDragPayload'

const canManageTemplates = { value: true }
vi.mock('../src/approvals/permissions', () => ({
  useApprovalPermissions: () => ({
    canManageTemplates,
    canRead: { value: true },
    canWrite: { value: true },
    canAct: { value: true },
  }),
}))

const approvalCanvasV2 = { value: true }
vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    features: computed(() => ({ approvalCanvasV2: approvalCanvasV2.value })),
  }),
}))

const createTemplateSpy = vi.fn()
const updateTemplateSpy = vi.fn()
const publishTemplateSpy = vi.fn()
const getTemplateSpy = vi.fn()
const dryRunApprovalConditionFormulaSpy = vi.fn()

vi.mock('../src/approvals/api', () => ({
  createTemplate: (payload: unknown) => createTemplateSpy(payload),
  updateTemplate: (id: string, payload: unknown) => updateTemplateSpy(id, payload),
  publishTemplate: (id: string, payload: unknown) => publishTemplateSpy(id, payload),
  getTemplate: (id: string) => getTemplateSpy(id),
  dryRunApprovalConditionFormula: (payload: unknown) => dryRunApprovalConditionFormulaSpy(payload),
}))

// The dirty-draft leave guard is the mechanism under test: it must run and be
// CANCELLABLE. `.mockRejectedValueOnce` (per test) simulates the user picking 留下.
const confirmSpy = vi.fn().mockResolvedValue(undefined)
vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
  ElMessageBox: { confirm: (...args: unknown[]) => confirmSpy(...args) },
}))

// Minimal Element Plus stubs — same discipline as approvalTemplateAuthoring.spec.ts's
// installStubs, trimmed to what TemplateAuthoringView's always-rendered chrome needs
// to mount without throwing (unknown-element warnings are harmless; missing directives
// or components whose absence crashes render are not).
const passthrough = (name: string, tag = 'div') =>
  defineComponent({
    name,
    inheritAttrs: false,
    render() {
      return h(tag, { 'data-testid': (this.$attrs as Record<string, unknown>)?.['data-testid'] }, this.$slots.default?.())
    },
  })

const ElButton = defineComponent({
  name: 'ElButton',
  props: { disabled: Boolean, loading: Boolean, type: String, text: Boolean, size: String },
  emits: ['click'],
  render() {
    return h(
      'button',
      {
        type: 'button',
        disabled: this.disabled || this.loading,
        'data-testid': (this.$attrs as Record<string, unknown>)?.['data-testid'],
        onClick: (event: Event) => this.$emit('click', event),
      },
      this.$slots.default?.(),
    )
  },
})

const ElInput = defineComponent({
  name: 'ElInput',
  props: { modelValue: [String, Number], disabled: Boolean, type: String, rows: Number, placeholder: String, size: String },
  emits: ['update:modelValue'],
  render() {
    return h('input', {
      value: this.modelValue ?? '',
      disabled: this.disabled,
      'data-testid': (this.$attrs as Record<string, unknown>)?.['data-testid'],
      onInput: (event: Event) => this.$emit('update:modelValue', (event.target as HTMLInputElement).value),
    })
  },
})

function installStubs(app: VueApp<Element>) {
  app.directive('loading', {})
  app.component('ElButton', ElButton)
  app.component('ElInput', ElInput)
  app.component('ElInputNumber', passthrough('ElInputNumber', 'input'))
  app.component('ElSelect', passthrough('ElSelect', 'select'))
  app.component('ElOption', passthrough('ElOption', 'option'))
  app.component('ElCheckbox', passthrough('ElCheckbox', 'label'))
  app.component('ElRadioGroup', passthrough('ElRadioGroup'))
  app.component('ElRadio', passthrough('ElRadio', 'label'))
  app.component('ElAlert', passthrough('ElAlert'))
  app.component('ElDialog', defineComponent({
    name: 'ElDialog',
    props: { modelValue: Boolean },
    render() {
      return this.modelValue ? h('div', { 'data-testid': (this.$attrs as Record<string, unknown>)?.['data-testid'] }, this.$slots.default?.()) : null
    },
  }))
  app.component('ElTable', passthrough('ElTable'))
  app.component('ElTableColumn', passthrough('ElTableColumn'))
  app.component('ElCard', passthrough('ElCard', 'section'))
  app.component('ElForm', passthrough('ElForm', 'form'))
  app.component('ElFormItem', passthrough('ElFormItem', 'label'))
  app.component('ElIcon', passthrough('ElIcon', 'span'))
  app.component('ElCollapse', passthrough('ElCollapse'))
  app.component('ElCollapseItem', passthrough('ElCollapseItem'))
}

const Elsewhere = defineComponent({
  name: 'ElsewhereRouteStub',
  render() {
    return h('div', { 'data-testid': 'elsewhere-route' }, 'elsewhere')
  },
})

let container: HTMLDivElement | null = null
let app: VueApp<Element> | null = null
let router: Router | null = null

async function mountRoutedView(): Promise<Router> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/approval-templates/new', component: TemplateAuthoringView },
      { path: '/approval-templates/:id/edit', component: TemplateAuthoringView },
      { path: '/elsewhere', component: Elsewhere },
    ],
  })
  const RootShell = defineComponent({
    name: 'RootShell',
    render() {
      return h(RouterView)
    },
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(RootShell)
  installStubs(app)
  app.use(router)
  app.mount(container)
  await router.push('/approval-templates/new')
  await router.isReady()
  await nextTick()
  await Promise.resolve()
  await nextTick()
  return router
}

async function flushUi() {
  for (let i = 0; i < 6; i += 1) {
    await nextTick()
    await Promise.resolve()
  }
}

function makeDataTransfer() {
  const store = new Map<string, string>()
  return {
    get types(): string[] {
      return Array.from(store.keys())
    },
    setData(type: string, value: string): void {
      store.set(type, String(value))
    },
    getData(type: string): string {
      return store.get(type) ?? ''
    },
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
  } as unknown as DataTransfer
}

function dispatchDrag(el: Element, type: string, dataTransfer: DataTransfer): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  el.dispatchEvent(event)
}

beforeEach(() => {
  canManageTemplates.value = true
  approvalCanvasV2.value = true
  createTemplateSpy.mockReset()
  updateTemplateSpy.mockReset()
  publishTemplateSpy.mockReset()
  getTemplateSpy.mockReset()
  dryRunApprovalConditionFormulaSpy.mockReset()
  confirmSpy.mockReset()
  confirmSpy.mockResolvedValue(undefined)
})

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
  router = null
})

describe('F4 route-level drag-state clearing (delta §5 F4 handoff condition 3)', () => {
  it('a drag interrupted by an ATTEMPTED-BUT-CANCELLED navigation clears — the leave guard clears drag state as its FIRST statement, before the (cancellable) dirty-draft confirm', async () => {
    await mountRoutedView()

    const chip = container!.querySelector('[data-testid="approval-form-palette-chip-text"]') as HTMLElement
    expect(chip).not.toBeNull()

    // Dirty the draft so the pre-existing onBeforeRouteLeave guard's confirm branch runs (it is a
    // no-op early-return otherwise, which would make this test's "cancelled navigation" premise
    // untestable).
    chip.click()
    await flushUi()

    // Begin (but do not complete) a drag on a SECOND palette chip.
    const dt = makeDataTransfer()
    dt.setData(APPROVAL_FORM_DRAG_MIME, JSON.stringify({ version: 1, kind: 'palette', fieldType: 'number' }))
    const numberChip = container!.querySelector('[data-testid="approval-form-palette-chip-number"]') as HTMLElement
    dispatchDrag(numberChip, 'dragstart', dt)
    await flushUi()

    const builderEl = () => container!.querySelector('[data-testid="approval-form-builder"]') as HTMLElement
    // Positive control: the drag IS active before navigation — proves "cleared" below is not vacuous.
    expect(builderEl().getAttribute('data-drag-active')).toBe('true')

    // Attempt navigation, then CANCEL it (simulates the user picking 留下 in the confirm dialog).
    confirmSpy.mockRejectedValueOnce(new Error('cancel'))
    const pushResult = await router!.push('/elsewhere')
    await flushUi()

    // Navigation was cancelled: still on the edit route, component still mounted.
    expect(router!.currentRoute.value.path).toBe('/approval-templates/new')
    expect(container!.querySelector('[data-testid="approval-form-designer-v2"]')).not.toBeNull()
    void pushResult

    // The drag state is gone regardless — cleared unconditionally at the start of the guard, not
    // contingent on the navigation actually proceeding.
    expect(builderEl().getAttribute('data-drag-active')).toBeNull()
  })
})
