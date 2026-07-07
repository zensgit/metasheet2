import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp, type Component } from 'vue'
import IntegrationPayloadPreviewSection from '../src/components/integration/IntegrationPayloadPreviewSection.vue'
import type { WorkbenchExternalSystem } from '../src/services/integration/workbench'

// IU-2c (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-2,
// stage C): structural smoke test for the extracted preview section — see
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

describe('IntegrationPayloadPreviewSection (unit)', () => {
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
        return () => h(IntegrationPayloadPreviewSection as unknown as Component, props)
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
      referenceMappingDomains: [] as string[],
      referenceMappingBindings: {} as Record<string, { systemId: string; object: string }>,
      stagingSystems: [] as WorkbenchExternalSystem[],
      onRefMappingSystemChange: vi.fn(noopFn),
      onRefMappingObjectChange: vi.fn(noopFn),
      derivingDraft: false,
      deriveError: '',
      deriveTemplateDraft: vi.fn(noopFn),
      authoredGatedFields: [] as string[],
      sourceReadOnlyBoundaryNotice: '',
      previewPayload: vi.fn(noopFn),
      previewText: '尚未生成预览',
      previewProvenance: null,
      provenanceSourceLabel: (source: string) => source,
      'onUpdate:sampleRecordText': vi.fn(noopFn),
      sampleRecordText: '{}',
      'onUpdate:payloadTemplateText': vi.fn(noopFn),
      payloadTemplateText: '',
      'onUpdate:authoredFieldRules': vi.fn(noopFn),
      authoredFieldRules: [],
      ...overrides,
    }
  }

  it('renders the section id and the payload preview text', async () => {
    await mountSection(baseProps())
    expect(container?.querySelector('#int-sec-preview')).toBeTruthy()
    expect(container?.querySelector('[data-testid="payload-preview"]')?.textContent).toContain('尚未生成预览')
    expect(container?.querySelector('[data-testid="reference-mapping-picker"]')).toBeFalsy()
  })

  it('forwards the preview-payload click to the prop function', async () => {
    const previewPayload = vi.fn(noopFn)
    await mountSection(baseProps({ previewPayload }))
    const button = container?.querySelector<HTMLButtonElement>('[data-testid="preview-payload"]')
    button?.click()
    await nextTick()
    expect(previewPayload).toHaveBeenCalledTimes(1)
  })

  it('renders a reference-mapping row and forwards an object-input change to the prop function', async () => {
    const onRefMappingObjectChange = vi.fn(noopFn)
    await mountSection(baseProps({ referenceMappingDomains: ['plm_material'], onRefMappingObjectChange }))
    const input = container?.querySelector<HTMLInputElement>('[data-testid="ref-mapping-object-plm_material"]')
    expect(input).toBeTruthy()
    if (input) {
      input.value = 'staging_table'
      input.dispatchEvent(new Event('input'))
    }
    await nextTick()
    expect(onRefMappingObjectChange).toHaveBeenCalledWith('plm_material', 'staging_table')
  })
})
