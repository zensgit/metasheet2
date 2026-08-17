/* eslint-disable vue/one-component-per-file, vue/require-default-prop */
/**
 * Lock-8 L8-B (docs/development/approval-lock8-field-vocabulary-20260817.md §1.2, §2.6) —
 * ApprovalFormInlineEditor.vue is the ONLY property-editor surface (no per-type inspector
 * component exists, §2.6); a new type silently renders only type-invariant rows unless an arm is
 * added. This proves the date_range arm DOES render — the type option exists in the retype
 * `<select>`, and a date_range field's property block renders REAL, WIRED controls (dateType/
 * startLabel/endLabel/durationLabel — M7: no inert/disabled-theater controls), standalone mount,
 * mirroring `approval-form-inline-editor-extract.spec.ts`'s own "(c) standalone mount" harness.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp } from 'vue'
import ApprovalFormInlineEditor from '../src/approvals/components/ApprovalFormInlineEditor.vue'
import { createEmptyFieldDraft, type FieldAuthoringDraft } from '../src/approvals/templateAuthoring'

const ElButton = defineComponent({
  name: 'ElButton',
  props: { disabled: Boolean, loading: Boolean, type: String, text: Boolean, link: Boolean, size: String },
  emits: ['click'],
  render() {
    return h('button', {
      type: 'button',
      disabled: this.disabled || this.loading,
      'data-testid': (this.$attrs as any)?.['data-testid'],
      onClick: (event: Event) => this.$emit('click', event),
    }, this.$slots.default?.())
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
      placeholder: this.placeholder,
      'data-testid': (this.$attrs as any)?.['data-testid'],
      onInput: (event: Event) => this.$emit('update:modelValue', (event.target as HTMLInputElement).value),
    })
  },
})

const ElSelect = defineComponent({
  name: 'ElSelect',
  props: { modelValue: [String, Array], disabled: Boolean },
  emits: ['update:modelValue', 'change', 'visible-change'],
  render() {
    return h('select', {
      value: this.modelValue ?? '',
      disabled: this.disabled,
      'data-testid': (this.$attrs as any)?.['data-testid'],
      onChange: (event: Event) => {
        const value = (event.target as HTMLSelectElement).value
        this.$emit('update:modelValue', value)
        this.$emit('change', value)
      },
    }, this.$slots.default?.())
  },
})

const ElOption = defineComponent({
  name: 'ElOption',
  props: { label: String, value: String },
  render() {
    return h('option', { value: this.value }, this.label)
  },
})

const ElCheckbox = defineComponent({
  name: 'ElCheckbox',
  inheritAttrs: false,
  props: { modelValue: Boolean, disabled: Boolean },
  emits: ['update:modelValue'],
  render() {
    return h('label', [
      h('input', {
        type: 'checkbox',
        checked: this.modelValue,
        disabled: this.disabled,
        'data-testid': (this.$attrs as any)?.['data-testid'],
        onChange: (event: Event) => this.$emit('update:modelValue', (event.target as HTMLInputElement).checked),
      }),
      this.$slots.default?.(),
    ])
  },
})

const passthrough = (name: string, tag = 'div') => defineComponent({
  name,
  render() {
    return h(tag, { 'data-testid': (this.$attrs as any)?.['data-testid'] }, this.$slots.default?.())
  },
})

function installStubs(app: VueApp<Element>) {
  app.directive('loading', {})
  app.component('ElButton', ElButton)
  app.component('ElInput', ElInput)
  app.component('ElInputNumber', passthrough('ElInputNumber', 'input'))
  app.component('ElSelect', ElSelect)
  app.component('ElOption', ElOption)
  app.component('ElCheckbox', ElCheckbox)
  app.component('ElAlert', passthrough('ElAlert'))
  app.component('ElDialog', passthrough('ElDialog'))
  app.component('ElTable', passthrough('ElTable'))
  app.component('ElTableColumn', passthrough('ElTableColumn'))
  app.component('ElCard', passthrough('ElCard'))
  app.component('ElForm', passthrough('ElForm', 'form'))
  app.component('ElFormItem', passthrough('ElFormItem', 'section'))
  app.component('ElIcon', passthrough('ElIcon', 'span'))
  app.component('ElCollapse', passthrough('ElCollapse'))
  app.component('ElCollapseItem', passthrough('ElCollapseItem'))
}

let app: VueApp<Element> | null = null
let container: HTMLDivElement | null = null

function mount(fields: FieldAuthoringDraft[]) {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({
    render() {
      return h(ApprovalFormInlineEditor, {
        fields,
        readOnly: false,
        templateName: 'date_range 独立挂载测试',
        formFieldFocusLocalId: fields[0]?.localId ?? null,
        fieldPaletteGroups: [{
          id: 'date',
          label: '日期',
          entries: [{ type: 'date_range', label: '日期区间', mark: '区' }],
        }],
        fieldPaletteLabels: {
          text: '文本', textarea: '多行文本', number: '数字', date: '日期', datetime: '日期时间',
          select: '单选', 'multi-select': '多选', user: '人员', detail: '明细', 'record-link': '关联记录',
          date_range: '日期区间',
        },
        detailLeafTypeOptions: [],
        recordLinkCatalogError: '',
        recordLinkCatalogLoading: false,
        recordLinkCatalogLoaded: true,
        recordLinkBaseOptionsFor: () => [],
        recordLinkSheetOptionsFor: () => [],
        visibilityFieldOptions: () => [],
        onAddFieldOfType: vi.fn(),
        onSelectFieldFocus: vi.fn(),
        onMoveField: vi.fn(),
        onRemoveField: vi.fn(),
        onRetryRecordLinkCatalog: vi.fn(),
      })
    },
  })
  installStubs(app)
  app.mount(container)
  return container
}

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
})

describe('ApprovalFormInlineEditor date_range arm (Lock-8 L8-B)', () => {
  it('the retype <select> offers 日期区间/date_range (M7: reachable from every field, not just fresh adds)', async () => {
    const field: FieldAuthoringDraft = { ...createEmptyFieldDraft(1), localId: 'f1', id: 'field_1' }
    const el = mount([field])
    await nextTick()
    const typeSelect = el.querySelector('[data-testid="approval-field-type"]') as HTMLSelectElement
    const options = Array.from(typeSelect.querySelectorAll('option')).map((o) => o.getAttribute('value'))
    expect(options).toContain('date_range')
  })

  it('a date_range field renders the property block with dateType/startLabel/endLabel/durationLabel controls', async () => {
    const field: FieldAuthoringDraft = {
      ...createEmptyFieldDraft(1),
      localId: 'f1', id: 'range', type: 'date_range',
      dateRangeDateType: '', dateRangeStartLabel: '', dateRangeEndLabel: '', dateRangeDurationLabel: '',
    }
    const el = mount([field])
    await nextTick()
    expect(el.querySelector('[data-testid="approval-date-range-config"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="approval-date-range-type-select"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="approval-date-range-start-label"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="approval-date-range-end-label"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="approval-date-range-duration-label"]')).not.toBeNull()
    // The dateType select's own option set — the required 3-way granularity enum (C-6/C-7), no
    // pre-selected default (an unset draft renders '' selected, never silently defaulting to an arm).
    const dateTypeSelect = el.querySelector('[data-testid="approval-date-range-type-select"]') as HTMLSelectElement
    const dateTypeOptions = Array.from(dateTypeSelect.querySelectorAll('option')).map((o) => o.getAttribute('value'))
    expect(dateTypeOptions.sort()).toEqual(['date', 'date_half_day', 'date_minute'].sort())
  })

  it('every date_range control is WIRED, not inert (M7) — typing into startLabel mutates the SAME reactive draft object the parent owns', async () => {
    const field: FieldAuthoringDraft = {
      ...createEmptyFieldDraft(1),
      localId: 'f1', id: 'range', type: 'date_range',
      dateRangeDateType: '', dateRangeStartLabel: '', dateRangeEndLabel: '', dateRangeDurationLabel: '',
    }
    const el = mount([field])
    await nextTick()
    const startInput = el.querySelector('[data-testid="approval-date-range-start-label"]') as HTMLInputElement
    startInput.value = '出差开始'
    startInput.dispatchEvent(new Event('input'))
    await nextTick()
    // Direct-property-edit path (FB-D7 legacy, same discipline as record-link/L8-C): the v-model
    // writes straight onto the SAME object reference passed in via the `fields` prop.
    expect(field.dateRangeStartLabel).toBe('出差开始')

    const dateTypeSelect = el.querySelector('[data-testid="approval-date-range-type-select"]') as HTMLSelectElement
    dateTypeSelect.value = 'date_minute'
    dateTypeSelect.dispatchEvent(new Event('change'))
    await nextTick()
    expect(field.dateRangeDateType).toBe('date_minute')
  })

  it('a NON-date_range field renders NO date_range property block (the arm is type-selected, not always-on)', async () => {
    const field: FieldAuthoringDraft = { ...createEmptyFieldDraft(1), localId: 'f1', id: 'field_1', type: 'text' }
    const el = mount([field])
    await nextTick()
    expect(el.querySelector('[data-testid="approval-date-range-config"]')).toBeNull()
  })
})
