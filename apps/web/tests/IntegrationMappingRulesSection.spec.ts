import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, reactive, type App as VueApp, type Component } from 'vue'
import IntegrationMappingRulesSection from '../src/components/integration/IntegrationMappingRulesSection.vue'
import {
  TRANSFORM_OPTIONS,
  createEditableMapping,
  createTransformArgs,
  createTransformStep,
} from '../src/components/integration/integrationMappingTransform'
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
      addTransformStep: vi.fn(noopFn),
      removeTransformStep: vi.fn(noopFn),
      ...overrides,
    }
  }

  // G27: mappings are built through the shared factory so this file cannot drift from
  // `EditableMapping`'s shape as the editor grows.
  function editable(overrides: Partial<EditableMapping> = {}): EditableMapping {
    return createEditableMapping({ id: 'm1', sourceField: 'code', targetField: 'FNumber', ...overrides })
  }

  const FIELD_OPTIONS = [
    { value: 'spec', label: 'Spec · spec', type: 'string', stale: false },
    { value: 'color', label: 'Color · color', type: 'string', stale: false },
  ]

  function testid<T extends Element>(id: string): T | null {
    return (container?.querySelector(`[data-testid="${id}"]`) as T | null) ?? null
  }

  it('renders the section id and one mapping card per mapping', async () => {
    const mapping = editable({ transformFn: 'trim', required: true })
    await mountSection(baseProps({ mappings: [mapping] }))
    expect(container?.querySelector('#int-sec-cleaning-rules')).toBeTruthy()
    expect(container?.querySelector('[data-testid="mapping-summary-0"]')?.textContent).toContain('code -> FNumber')
  })

  it('forwards add-mapping and remove-mapping clicks to their prop functions', async () => {
    const addMapping = vi.fn(noopFn)
    const removeMapping = vi.fn(noopFn)
    const mapping = editable({ transformFn: 'trim' })
    await mountSection(baseProps({ mappings: [mapping], addMapping, removeMapping }))
    container?.querySelector<HTMLButtonElement>('[data-testid="add-mapping"]')?.click()
    await nextTick()
    expect(addMapping).toHaveBeenCalledTimes(1)
    const removeButton = Array.from(container?.querySelectorAll('button') ?? []).find((btn) => btn.textContent === '删除')
    removeButton?.click()
    await nextTick()
    expect(removeMapping).toHaveBeenCalledWith(0)
  })

  // -------------------------------------------------------------------------
  // G27 — transform argument controls, the chain, and the pattern/enum/default rule inputs.
  // The engine has supported toDate/defaultValue/concat/chains and pattern/enum all along; these
  // tests pin WHICH control each transform shows (a control rendered for the wrong fn would write
  // an argument the engine ignores) and that every control writes back onto the mapping object the
  // view owns — the same nested-mutation contract the pre-existing controls rely on.
  // -------------------------------------------------------------------------

  it('shows no argument control for the transforms that take no argument', async () => {
    for (const fn of ['', 'trim', 'upper', 'lower', 'toNumber'] as const) {
      await mountSection(baseProps({ mappings: [editable({ transformFn: fn })], transformOptions: TRANSFORM_OPTIONS }))
      expect(testid('transform-args-0-date-format')).toBeNull()
      expect(testid('transform-args-0-default-value')).toBeNull()
      expect(testid('transform-args-0-concat-fields')).toBeNull()
      expect(testid('transform-args-0-concat-separator')).toBeNull()
      expect(testid('dict-map-0')).toBeNull()
      if (app) app.unmount()
      container?.remove()
      app = null
      container = null
    }
  })

  it('shows only the toDate format select for toDate, and writes the chosen format back', async () => {
    const mapping = editable({ transformFn: 'toDate' })
    await mountSection(baseProps({ mappings: [mapping], transformOptions: TRANSFORM_OPTIONS }))
    expect(testid('transform-args-0-default-value')).toBeNull()
    expect(testid('transform-args-0-concat-fields')).toBeNull()
    const select = testid<HTMLSelectElement>('transform-args-0-date-format')
    expect(select).not.toBeNull()
    expect(Array.from(select!.options).map((option) => option.value)).toEqual(['iso', 'date'])
    expect(select!.value).toBe('iso')
    select!.value = 'date'
    select!.dispatchEvent(new Event('change'))
    await nextTick()
    expect(mapping.transformArgs.dateFormat).toBe('date')
    expect(testid('transform-args-0-date-format-help')?.textContent).toContain('引擎只区分')
  })

  it('shows only the value input for defaultValue, and writes the value back', async () => {
    const mapping = editable({ transformFn: 'defaultValue' })
    await mountSection(baseProps({ mappings: [mapping], transformOptions: TRANSFORM_OPTIONS }))
    expect(testid('transform-args-0-date-format')).toBeNull()
    const input = testid<HTMLInputElement>('transform-args-0-default-value')
    expect(input).not.toBeNull()
    input!.value = 'UNKNOWN'
    input!.dispatchEvent(new Event('input'))
    await nextTick()
    expect(mapping.transformArgs.defaultValueText).toBe('UNKNOWN')
  })

  it('shows a source-field multi-select plus separator for concat, and writes both back', async () => {
    const mapping = editable({ transformFn: 'concat' })
    await mountSection(baseProps({
      mappings: [mapping],
      transformOptions: TRANSFORM_OPTIONS,
      hasSourceFieldOptions: true,
      sourceFieldOptionsForMapping: () => FIELD_OPTIONS,
    }))
    const select = testid<HTMLSelectElement>('transform-args-0-concat-fields')
    expect(select).not.toBeNull()
    expect(select!.multiple).toBe(true)
    expect(Array.from(select!.options).map((option) => option.value)).toEqual(['spec', 'color'])
    expect(select!.options[0].textContent).toContain('Spec · spec')
    select!.options[0].selected = true
    select!.options[1].selected = true
    select!.dispatchEvent(new Event('change'))
    await nextTick()
    expect(mapping.transformArgs.concatFields).toEqual(['spec', 'color'])

    const separator = testid<HTMLInputElement>('transform-args-0-concat-separator')
    separator!.value = '-'
    separator!.dispatchEvent(new Event('input'))
    await nextTick()
    expect(mapping.transformArgs.concatSeparator).toBe('-')
    expect(testid('transform-args-0-concat-help')?.textContent).toContain('当前来源字段的值排在最前')
  })

  it('falls back to a comma-separated concat field input when the source schema is unknown', async () => {
    const mapping = editable({ transformFn: 'concat' })
    await mountSection(baseProps({ mappings: [mapping], transformOptions: TRANSFORM_OPTIONS, hasSourceFieldOptions: false }))
    const input = testid<HTMLInputElement>('transform-args-0-concat-fields')
    expect(input?.tagName).toBe('INPUT')
    input!.value = ' spec , color , '
    input!.dispatchEvent(new Event('input'))
    await nextTick()
    expect(mapping.transformArgs.concatFields).toEqual(['spec', 'color'])
  })

  // F06 regression (#5596): the fallback input used to bind `:value` to
  // `args.concatFields.join(', ')`. Because the parse drops the empty tail, typing `spec,` left
  // the derived string at `spec`, and the next deep-reactive re-render patched the comma away
  // mid-typing — i.e. you could not type a second field name at all. This is the ONLY concat
  // authoring path when the source schema is unavailable (source DB 503), so it had to be a
  // controlled draft, not a derived value.
  it('keeps a trailing comma the operator just typed in the concat fallback input', async () => {
    const mapping = reactive(editable({ transformFn: 'concat' })) as EditableMapping
    await mountSection(baseProps({ mappings: [mapping], transformOptions: TRANSFORM_OPTIONS, hasSourceFieldOptions: false }))
    const input = testid<HTMLInputElement>('transform-args-0-concat-fields')!
    input.value = 'spec'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    expect(mapping.transformArgs.concatFields).toEqual(['spec'])

    input.value = 'spec,'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    // The array is unchanged (the tail is empty), and that must NOT wipe the typed comma.
    expect(mapping.transformArgs.concatFields).toEqual(['spec'])
    expect(input.value).toBe('spec,')

    // A sibling write on the same reactive mapping forces another render — still no wipe.
    mapping.transformArgs.concatSeparator = '-'
    await nextTick()
    expect(input.value).toBe('spec,')

    input.value = 'spec,color'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    expect(mapping.transformArgs.concatFields).toEqual(['spec', 'color'])
    expect(input.value).toBe('spec,color')
  })

  it('re-syncs the concat fallback input when the field list changes from OUTSIDE the input', async () => {
    const mapping = reactive(editable({ transformFn: 'concat' })) as EditableMapping
    await mountSection(baseProps({ mappings: [mapping], transformOptions: TRANSFORM_OPTIONS, hasSourceFieldOptions: false }))
    const input = testid<HTMLInputElement>('transform-args-0-concat-fields')!
    input.value = 'spec,'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    // e.g. a round-trip load replacing the parsed list — the draft must follow.
    mapping.transformArgs.concatFields = ['color', 'size']
    await nextTick()
    expect(input.value).toBe('color, size')
  })

  it('renders one chained-step editor per extra step, with its own fn and argument controls', async () => {
    // `reactive` because this test changes a step's fn AFTER mount and asserts the arg control
    // follows — in the view the array lives in a `ref`, which is deeply reactive the same way.
    const mapping = reactive(editable({
      transformFn: 'trim',
      extraSteps: [
        createTransformStep('m1:1', { fn: 'upper' }),
        createTransformStep('m1:2', { fn: 'toDate', args: createTransformArgs({ dateFormat: 'date' }) }),
      ],
    })) as EditableMapping
    await mountSection(baseProps({ mappings: [mapping], transformOptions: TRANSFORM_OPTIONS }))
    expect(testid<HTMLSelectElement>('transform-step-fn-0-0')?.value).toBe('upper')
    expect(testid<HTMLSelectElement>('transform-step-fn-0-1')?.value).toBe('toDate')
    // Step 2's toDate arg control is its own (prefix carries the step index), not step 1's.
    expect(testid('transform-args-0-date-format')).toBeNull()
    expect(testid<HTMLSelectElement>('transform-args-0-1-date-format')?.value).toBe('date')
    expect(testid('transform-chain-help-0')?.textContent).toContain('上一步的输出就是下一步的输入')

    const stepSelect = testid<HTMLSelectElement>('transform-step-fn-0-0')
    stepSelect!.value = 'dictMap'
    stepSelect!.dispatchEvent(new Event('change'))
    await nextTick()
    expect(mapping.extraSteps[0].fn).toBe('dictMap')
    const stepDict = testid<HTMLTextAreaElement>('transform-step-dict-map-0-0')
    expect(stepDict).not.toBeNull()
    stepDict!.value = 'EA=Pcs'
    stepDict!.dispatchEvent(new Event('input'))
    await nextTick()
    expect(mapping.extraSteps[0].dictMapText).toBe('EA=Pcs')
  })

  it('forwards the chain add/remove clicks to their prop functions with the mapping', async () => {
    const addTransformStep = vi.fn(noopFn)
    const removeTransformStep = vi.fn(noopFn)
    const mapping = editable({ transformFn: 'trim', extraSteps: [createTransformStep('m1:1', { fn: 'upper' })] })
    await mountSection(baseProps({
      mappings: [mapping],
      transformOptions: TRANSFORM_OPTIONS,
      addTransformStep,
      removeTransformStep,
    }))
    testid<HTMLButtonElement>('add-transform-step-0')?.click()
    await nextTick()
    expect(addTransformStep).toHaveBeenCalledWith(mapping)
    testid<HTMLButtonElement>('remove-transform-step-0-0')?.click()
    await nextTick()
    expect(removeTransformStep).toHaveBeenCalledWith(mapping, 0)
  })

  it('writes the pattern, enum and mapping-level default inputs back onto the mapping', async () => {
    const mapping = editable({ transformFn: 'trim' })
    await mountSection(baseProps({ mappings: [mapping], transformOptions: TRANSFORM_OPTIONS }))
    const pattern = testid<HTMLInputElement>('validation-pattern-0')
    pattern!.value = '^MAT-\\d+$'
    pattern!.dispatchEvent(new Event('input'))
    const enumInput = testid<HTMLInputElement>('validation-enum-0')
    enumInput!.value = 'active,inactive'
    enumInput!.dispatchEvent(new Event('input'))
    const defaultInput = testid<HTMLInputElement>('mapping-default-value-0')
    defaultInput!.value = 'N/A'
    defaultInput!.dispatchEvent(new Event('input'))
    await nextTick()
    expect(mapping.patternText).toBe('^MAT-\\d+$')
    expect(mapping.enumText).toBe('active,inactive')
    expect(mapping.defaultValueText).toBe('N/A')
    expect(testid('mapping-rules-help-0')?.textContent).toContain('只在填写时才下发')
  })
})
