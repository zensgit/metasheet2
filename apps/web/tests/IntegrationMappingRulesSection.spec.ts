import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp, type Component } from 'vue'
import IntegrationMappingRulesSection from '../src/components/integration/IntegrationMappingRulesSection.vue'
import type { EditableMapping } from '../src/components/integration/integrationWorkbenchSectionTypes'

// IU-2b (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-2,
// stage B): structural smoke test for the extracted mapping-rules section — see
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

describe('IntegrationMappingRulesSection (unit)', () => {
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
        return () => h(IntegrationMappingRulesSection as unknown as Component, props)
      },
    })
    app = createApp(Host)
    app.component('ElCard', ElCard)
    app.mount(container)
    await nextTick()
  }

  const noopFn = (..._args: unknown[]): unknown => undefined

  function baseProps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      mappings: [] as EditableMapping[],
      hasSourceFieldOptions: false,
      sourceFieldOptionsForMapping: () => [],
      sourceFieldOptionText: (option: { label: string }) => option.label,
      transformOptions: [{ value: '', label: '无转换' }],
      mappingSummary: (mapping: EditableMapping, index: number) => `${mapping.sourceField || `来源字段 ${index + 1}`} -> ${mapping.targetField || `目标字段 ${index + 1}`}`,
      mappingDetail: () => '',
      addMapping: vi.fn(noopFn),
      removeMapping: vi.fn(noopFn),
      ...overrides,
    }
  }

  it('renders the section id and one mapping card per mapping', async () => {
    const mapping: EditableMapping = {
      id: 'm1',
      sourceField: 'code',
      targetField: 'FNumber',
      transformFn: 'trim',
      dictMapText: '',
      required: true,
      minValueText: '',
      maxValueText: '',
    }
    await mountSection(baseProps({ mappings: [mapping] }))
    expect(container?.querySelector('#int-sec-cleaning-rules')).toBeTruthy()
    expect(container?.querySelector('[data-testid="mapping-summary-0"]')?.textContent).toContain('code -> FNumber')
  })

  it('forwards add-mapping and remove-mapping clicks to their prop functions', async () => {
    const addMapping = vi.fn(noopFn)
    const removeMapping = vi.fn(noopFn)
    const mapping: EditableMapping = {
      id: 'm1',
      sourceField: 'code',
      targetField: 'FNumber',
      transformFn: 'trim',
      dictMapText: '',
      required: false,
      minValueText: '',
      maxValueText: '',
    }
    await mountSection(baseProps({ mappings: [mapping], addMapping, removeMapping }))
    container?.querySelector<HTMLButtonElement>('[data-testid="add-mapping"]')?.click()
    await nextTick()
    expect(addMapping).toHaveBeenCalledTimes(1)
    const removeButton = Array.from(container?.querySelectorAll('button') ?? []).find((btn) => btn.textContent === '删除')
    removeButton?.click()
    await nextTick()
    expect(removeMapping).toHaveBeenCalledWith(0)
  })
})
