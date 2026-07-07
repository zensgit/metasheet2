import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp, type Component } from 'vue'
import IntegrationCleaningDatasetSection from '../src/components/integration/IntegrationCleaningDatasetSection.vue'
import type { IntegrationObjectSchema, IntegrationStagingDescriptor } from '../src/services/integration/workbench'

// IU-2b (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-2,
// stage B): structural smoke test for the extracted cleaning-dataset section — see
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

describe('IntegrationCleaningDatasetSection (unit)', () => {
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
        return () => h(IntegrationCleaningDatasetSection as unknown as Component, props)
      },
    })
    app = createApp(Host)
    app.component('ElCard', ElCard)
    app.mount(container)
    await nextTick()
  }

  const emptySchema: IntegrationObjectSchema = { object: '', fields: [] }
  const noopFn = (..._args: unknown[]): unknown => undefined

  function baseProps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      sourceDatasetTitle: '请选择来源数据集',
      sourceDatasetDescription: '',
      sourceSchema: emptySchema,
      sourceConnectionLabel: '未测试',
      selectedStagingDescriptor: null,
      stagingDescriptors: [] as IntegrationStagingDescriptor[],
      getStagingAreaLabel: () => '',
      targetDatasetTitle: '请选择目标数据集',
      targetDatasetDescription: '',
      targetSchema: emptySchema,
      requiredTargetFieldCount: 0,
      stagingDatasetCards: [],
      installingStaging: false,
      stagingProjectId: '',
      stagingProjectIdScopeStatus: '',
      stagingProjectIdScopeWarning: '',
      stagingInstallResultText: '',
      installStagingTables: vi.fn(noopFn),
      useStagingAsSource: vi.fn(noopFn),
      useStagingAsTarget: vi.fn(noopFn),
      focusStagingInstall: vi.fn(noopFn),
      onStagingProjectIdInput: vi.fn(noopFn),
      normalizeStagingProjectIdToScope: vi.fn(noopFn),
      'onUpdate:stagingBaseId': vi.fn(noopFn),
      stagingBaseId: '',
      ...overrides,
    }
  }

  it('renders the section id, dataset cards, and the staging-empty state', async () => {
    await mountSection(baseProps())
    expect(container?.querySelector('#int-sec-cleaning-dataset')).toBeTruthy()
    expect(container?.querySelector('[data-testid="dataset-cards"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="staging-empty"]')).toBeTruthy()
  })

  it('forwards the install-staging click to the prop function', async () => {
    const installStagingTables = vi.fn(noopFn)
    await mountSection(baseProps({ installStagingTables }))
    const button = container?.querySelector<HTMLButtonElement>('[data-testid="install-staging"]')
    button?.click()
    await nextTick()
    expect(installStagingTables).toHaveBeenCalledTimes(1)
  })
})
