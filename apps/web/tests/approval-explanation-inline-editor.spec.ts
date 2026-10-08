/* eslint-disable vue/one-component-per-file, vue/require-default-prop */
/**
 * Lock-8 L8-A (docs/development/approval-lock8-field-vocabulary-20260817.md §1.1, §2.6) —
 * ApprovalFormInlineEditor.vue is the ONLY property-editor surface (no per-type inspector
 * component exists, §2.6); a new type silently renders only type-invariant rows unless an arm is
 * added. This proves the explanation arm DOES render — the type option exists in the retype
 * `<select>`, a explanation field's property block renders a REAL, WIRED props.text control (M7:
 * no inert/disabled-theater control), AND the 必填/占位文本 controls every OTHER type gets are
 * HIDDEN for explanation (A-1: nothing to require or prompt for) — standalone mount, mirroring
 * `approval-date-range-inline-editor.spec.ts`'s own harness.
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
    const tag = this.type === 'textarea' ? 'textarea' : 'input'
    return h(tag, {
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
        templateName: 'explanation 独立挂载测试',
        formFieldFocusLocalId: fields[0]?.localId ?? null,
        fieldPaletteGroups: [{
          id: 'other',
          label: '其他',
          entries: [{ type: 'explanation', label: '说明', mark: '明' }],
        }],
        fieldPaletteLabels: {
          text: '文本', textarea: '多行文本', number: '数字', date: '日期', datetime: '日期时间',
          select: '单选', 'multi-select': '多选', user: '人员', detail: '明细', 'record-link': '关联记录',
          date_range: '日期区间', explanation: '说明',
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

describe('ApprovalFormInlineEditor explanation arm (Lock-8 L8-A)', () => {
  it('the retype <select> offers 说明/explanation (M7: reachable from every field, not just fresh adds)', async () => {
    const field: FieldAuthoringDraft = { ...createEmptyFieldDraft(1), localId: 'f1', id: 'field_1' }
    const el = mount([field])
    await nextTick()
    const typeSelect = el.querySelector('[data-testid="approval-field-type"]') as HTMLSelectElement
    const options = Array.from(typeSelect.querySelectorAll('option')).map((o) => o.getAttribute('value'))
    expect(options).toContain('explanation')
  })

  it('an explanation field renders the props.text config block with a WIRED textarea control', async () => {
    const field: FieldAuthoringDraft = {
      ...createEmptyFieldDraft(1),
      localId: 'f1', id: 'note', type: 'explanation', explanationText: '',
    }
    const el = mount([field])
    await nextTick()
    expect(el.querySelector('[data-testid="approval-explanation-config"]')).not.toBeNull()
    const textInput = el.querySelector('[data-testid="approval-explanation-text"]') as HTMLTextAreaElement
    expect(textInput).not.toBeNull()
    // M7: WIRED, not inert — typing mutates the SAME reactive draft object the parent owns
    // (direct-property-edit path, FB-D7 legacy, same discipline as date_range/record-link).
    textInput.value = '仅供参考，请如实填写'
    textInput.dispatchEvent(new Event('input'))
    await nextTick()
    expect(field.explanationText).toBe('仅供参考，请如实填写')
  })

  it('A-1: 必填/占位文本 controls are HIDDEN for explanation (nothing to require or prompt for)', async () => {
    const field: FieldAuthoringDraft = {
      ...createEmptyFieldDraft(1),
      localId: 'f1', id: 'note', type: 'explanation', explanationText: '仅供参考',
    }
    const el = mount([field])
    await nextTick()
    expect(el.querySelector('[data-testid="approval-explanation-config"]')).not.toBeNull()
    // The ONLY checkbox this editor ever renders (with a single non-detail field selected, as
    // here) is 是否必填 — zero checkboxes proves it is hidden for explanation, not merely
    // unlabeled. Detail sub-field rows render their OWN per-column checkbox, irrelevant here
    // since the mounted field is `explanation`, not `detail`.
    expect(el.querySelectorAll('input[type="checkbox"]').length).toBe(0)
    // 占位文本 binds a plain (non-checkbox) <el-input v-model="field.placeholder">; with the
    // required checkbox proven absent and the explanation config block confirmed present, the
    // total <input>/<textarea> count on the page is the closed set: 字段名称 (label) + 类型
    // (select, not input) + explanation's own props.text textarea — i.e. exactly 2 text-entry
    // elements, not 3 (which 占位文本 present would make it).
    const textEntryElements = el.querySelectorAll('input[type="text"], input:not([type]), textarea')
    expect(textEntryElements.length).toBe(2)
  })

  it('positive control: 必填/占位文本 controls ARE present for a NON-explanation type (hiding is type-selected)', async () => {
    const field: FieldAuthoringDraft = { ...createEmptyFieldDraft(1), localId: 'f1', id: 'field_1', type: 'text' }
    const el = mount([field])
    await nextTick()
    expect(el.querySelectorAll('input[type="checkbox"]').length).toBeGreaterThan(0)
    expect(el.querySelector('[data-testid="approval-explanation-config"]')).toBeNull()
  })

  it('a NON-explanation field renders NO explanation property block (the arm is type-selected, not always-on)', async () => {
    const field: FieldAuthoringDraft = { ...createEmptyFieldDraft(1), localId: 'f1', id: 'field_1', type: 'text' }
    const el = mount([field])
    await nextTick()
    expect(el.querySelector('[data-testid="approval-explanation-config"]')).toBeNull()
  })
})
