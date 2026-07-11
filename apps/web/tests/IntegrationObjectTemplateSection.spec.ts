import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp, type Component } from 'vue'
import IntegrationObjectTemplateSection from '../src/components/integration/IntegrationObjectTemplateSection.vue'
import type { IntegrationObjectSchema, IntegrationSystemObject, WorkbenchExternalSystem } from '../src/services/integration/workbench'

// IU-2c (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-2,
// stage C): structural smoke test for the extracted object-template section — see
// IntegrationMonitoringSection.spec.ts's header comment for why this is a light isolation check,
// not a re-test of behavior already covered via the parent's unchanged 50 tests.
const ElCard = defineComponent({
  name: 'ElCard',
  props: { shadow: { type: String, required: false, default: undefined } },
  setup(_props, { slots }) {
    return () => h('div', { class: 'el-card' }, [
      slots.header ? h('div', { class: 'el-card__header' }, slots.header()) : null,
      h('div', { class: 'el-card__body' }, slots.default?.()),
    ])
  },
})

describe('IntegrationObjectTemplateSection (unit)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  async function mountSection(props: Record<string, unknown>): Promise<void> {
    container = document.createElement('div')
    document.body.appendChild(container)
    const Host = defineComponent({
      setup() {
        return () => h(IntegrationObjectTemplateSection as unknown as Component, props)
      },
    })
    app = createApp(Host)
    app.component('ElCard', ElCard)
    app.component('router-link', { props: ['to'], setup(_props, { slots }) { return () => h('a', slots.default?.()) } })
    app.mount(container)
    await nextTick()
  }

  const emptySchema: IntegrationObjectSchema = { object: '', fields: [] }
  const noopFn = (..._args: unknown[]): unknown => undefined

  function baseProps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      sourceSystems: [] as WorkbenchExternalSystem[],
      isSourceOptionDisabled: () => false,
      handleSourceSystemChange: vi.fn(noopFn),
      sourceSelectorExplanation: '',
      selectedPlmApprovalCapabilityEntry: null,
      selectedPlmBomMultitableCapabilityEntry: null,
      selectedSourcePlmDataSourceId: '',
      hasRunnableSourceSystem: false,
      showStagingSetup: vi.fn(noopFn),
      showSqlSetup: vi.fn(noopFn),
      sourceRuntimeBlocker: '',
      k3WebApiReadGateNotice: '',
      sqlChannelDisabledHint: '',
      sourceConnectionStatus: 'inactive',
      sourceConnectionLabel: '未测试',
      testSystem: vi.fn(noopFn),
      loadObjects: vi.fn(noopFn),
      handleSourceObjectChange: vi.fn(noopFn),
      sourceObjects: [] as IntegrationSystemObject[],
      sourceSchema: emptySchema,
      targetSystems: [] as WorkbenchExternalSystem[],
      targetSelectorExplanation: '',
      targetConnectionStatus: 'inactive',
      targetConnectionLabel: '未测试',
      loadSchema: vi.fn(noopFn),
      targetObjects: [] as IntegrationSystemObject[],
      targetSchema: emptySchema,
      sameSystemNotice: '',
      protocolSplitNotice: '',
      stagingTargetMismatchNotice: '',
      recommendedStagingSourceObject: '',
      stagingDatasetCopy: {} as Record<string, { area: string; name: string; description: string }>,
      useRecommendedStagingSource: vi.fn(noopFn),
      'onUpdate:sourceSystemId': vi.fn(noopFn),
      sourceSystemId: '',
      'onUpdate:sourceObjectName': vi.fn(noopFn),
      sourceObjectName: '',
      'onUpdate:targetSystemId': vi.fn(noopFn),
      targetSystemId: '',
      'onUpdate:targetObjectName': vi.fn(noopFn),
      targetObjectName: '',
      ...overrides,
    }
  }

  it('renders the section id and the source-empty state when there is no runnable source system', async () => {
    await mountSection(baseProps())
    expect(container?.querySelector('#int-sec-object-template')).toBeTruthy()
    expect(container?.querySelector('[data-testid="source-empty-state"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="show-staging-setup"]')).toBeTruthy()
  })

  it('forwards the test-source-system click to the prop function with the right side', async () => {
    const testSystem = vi.fn(noopFn)
    await mountSection(baseProps({ testSystem }))
    const button = container?.querySelector<HTMLButtonElement>('[data-testid="test-source-system"]')
    button?.click()
    await nextTick()
    expect(testSystem).toHaveBeenCalledWith('source')
  })

  it('renders a source system option and forwards a select change to update:sourceSystemId', async () => {
    const system: WorkbenchExternalSystem = { id: 'sys-1', name: 'K3 WISE', kind: 'k3wise', role: 'source', status: 'active' } as WorkbenchExternalSystem
    const onUpdateSourceSystemId = vi.fn(noopFn)
    await mountSection(baseProps({ sourceSystems: [system], hasRunnableSourceSystem: true, 'onUpdate:sourceSystemId': onUpdateSourceSystemId }))
    expect(container?.querySelector('[data-testid="source-system-option-sys-1"]')).toBeTruthy()
    const select = container?.querySelector<HTMLSelectElement>('[data-testid="source-system"]')
    expect(select).toBeTruthy()
    if (select) {
      select.value = 'sys-1'
      select.dispatchEvent(new Event('change'))
    }
    await nextTick()
    expect(onUpdateSourceSystemId).toHaveBeenCalledWith('sys-1')
  })
})
