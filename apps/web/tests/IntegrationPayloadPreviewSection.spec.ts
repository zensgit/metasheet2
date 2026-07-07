import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, reactive, type App as VueApp, type Component } from 'vue'
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

  // IU-5a: `mountSection` above hands the child a *static* props object — fine for asserting a
  // single emit (`onUpdate:x` spy called once), but a plain-object/static-prop host can never
  // show a downstream sibling (JsonAssist) picking up a v-model change, because the host itself
  // never re-renders on emit (see jsonAssist.spec.ts's sibling-propagation note for why). The
  // real parent view (IntegrationWorkbenchView.vue) *does* re-render on emit, since its
  // `sampleRecordText`/`payloadTemplateText` are refs bound via `v-model:sample-record-text=`
  // etc. — this helper reproduces that same live two-way loop locally so the
  // "textarea edit -> JsonAssist status" tests exercise genuine reactivity, not a frozen snapshot.
  async function mountSectionControlled(
    overrides: Record<string, unknown> = {},
  ): Promise<{ state: { sampleRecordText: string; payloadTemplateText: string } }> {
    container = document.createElement('div')
    document.body.appendChild(container)
    const state = reactive({
      sampleRecordText: (overrides.sampleRecordText as string | undefined) ?? '{}',
      payloadTemplateText: (overrides.payloadTemplateText as string | undefined) ?? '',
    })
    const staticProps = baseProps(overrides)
    const Host = defineComponent({
      setup() {
        return () => h(IntegrationPayloadPreviewSection as unknown as Component, {
          ...staticProps,
          sampleRecordText: state.sampleRecordText,
          'onUpdate:sampleRecordText': (value: string) => { state.sampleRecordText = value },
          payloadTemplateText: state.payloadTemplateText,
          'onUpdate:payloadTemplateText': (value: string) => { state.payloadTemplateText = value },
        })
      },
    })
    app = createApp(Host)
    app.component('ElCard', ElCard)
    app.mount(container)
    await nextTick()
    return { state }
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

  // IU-5a (design-lock §2 IU-5, sites 3 "sample-record" + 4 "payload-template"): JsonAssist is a
  // side-mount next to the raw textareas above — these tests are additive, the assertions above
  // are untouched.
  it('renders a JsonAssist strip beside both the sample-record and payload-template textareas', async () => {
    await mountSection(baseProps())
    expect(container?.querySelector('[data-testid="sample-record-json-assist"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="sample-record-json-format"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="sample-record-json-status"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="payload-template-json-assist"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="payload-template-json-format"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="payload-template-json-status"]')).toBeTruthy()
    // The raw textareas keep their own data-testids exactly as before — JsonAssist never
    // replaces them.
    expect(container?.querySelector('[data-testid="sample-record"]')?.tagName).toBe('TEXTAREA')
    expect(container?.querySelector('[data-testid="payload-template"]')?.tagName).toBe('TEXTAREA')
  })

  it('formats the sample-record JSON via the JsonAssist format button and emits update:sampleRecordText', async () => {
    const onUpdateSampleRecordText = vi.fn(noopFn)
    await mountSection(baseProps({ sampleRecordText: '{"materialCode":"X","qty":1}', 'onUpdate:sampleRecordText': onUpdateSampleRecordText }))
    const formatButton = container?.querySelector<HTMLButtonElement>('[data-testid="sample-record-json-format"]')
    expect(formatButton?.disabled).toBe(false)
    formatButton?.click()
    await nextTick()
    expect(onUpdateSampleRecordText).toHaveBeenCalledWith('{\n  "materialCode": "X",\n  "qty": 1\n}')
  })

  it('flips the payload-template JsonAssist status to invalid when the textarea holds malformed JSON', async () => {
    await mountSectionControlled()
    const textarea = container?.querySelector<HTMLTextAreaElement>('[data-testid="payload-template"]')
    expect(textarea).toBeTruthy()
    if (textarea) {
      textarea.value = '{"FNumber": ,}'
      textarea.dispatchEvent(new Event('input'))
    }
    await nextTick()
    const status = container?.querySelector('[data-testid="payload-template-json-status"]')
    expect(status?.getAttribute('data-status')).toBe('invalid')
  })

  it('shows the values-free placeholder example on the payload-template status line while empty', async () => {
    await mountSection(baseProps({ payloadTemplateText: '' }))
    const status = container?.querySelector('[data-testid="payload-template-json-status"]')
    expect(status?.getAttribute('data-status')).toBe('empty')
    expect(status?.textContent).toContain('FNumber')
  })
})
