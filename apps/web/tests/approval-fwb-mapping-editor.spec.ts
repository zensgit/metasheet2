import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'
import ApprovalFwbMappingEditor from '../src/approvals/components/ApprovalFwbMappingEditor.vue'
import type { FwbMappingDraft, TargetFieldInfo, TemplateFieldInfo } from '../src/approvals/fwbMappingConfig'

// FWB create-mode mapping editor — mounted contract tests over the #4515/#4516 model.
// Element Plus is stubbed with NATIVE form controls (the established pattern in this repo,
// e.g. approvalUserPicker.spec.ts): the stubs prove the component wires the el-select /
// el-option / el-button CONTRACT correctly — value binding, disabled options, click/change
// emission — without dragging in popper/keyboard machinery jsdom cannot layout.

// Native <select> stand-in. The value is synced AFTER options mount (onMounted/onUpdated)
// because a programmatic value set before the <option> children exist would not stick —
// this also matches real browser behavior of selecting a DISABLED option programmatically
// (a loaded blocked mapping stays displayed).
const ElSelect = defineComponent({
  name: 'ElSelect',
  props: {
    modelValue: { type: String, default: undefined },
    disabled: Boolean,
    placeholder: String,
    size: String,
  },
  emits: ['update:modelValue'],
  methods: {
    syncValue() {
      const el = this.$el as HTMLSelectElement | null
      if (el) el.value = this.modelValue ?? ''
    },
  },
  mounted() {
    this.syncValue()
  },
  updated() {
    this.syncValue()
  },
  render() {
    return h('select', {
      disabled: this.disabled,
      'data-placeholder': this.placeholder,
      onChange: (e: Event) => this.$emit('update:modelValue', (e.target as HTMLSelectElement).value),
    }, this.$slots.default?.())
  },
})

const ElOption = defineComponent({
  name: 'ElOption',
  props: { label: String, value: String, disabled: Boolean },
  render() {
    return h('option', { value: this.value, disabled: this.disabled }, this.label)
  },
})

const ElButton = defineComponent({
  name: 'ElButton',
  props: { disabled: Boolean, type: String, size: String, text: Boolean },
  emits: ['click'],
  render() {
    return h('button', {
      disabled: this.disabled,
      onClick: (e: MouseEvent) => this.$emit('click', e),
    }, this.$slots.default?.())
  },
})

const ElIcon = defineComponent({
  name: 'ElIcon',
  render() {
    return h('span', { class: 'el-icon-stub' }, this.$slots.default?.())
  },
})

const TPL: TemplateFieldInfo[] = [
  { id: 'f_title', label: '申请标题' },
  { id: 'f_date', label: '出差日期' },
  { id: 'f_level', label: '报销等级' },
]

const TGT: TargetFieldInfo[] = [
  { id: 't_text', label: '标题', type: 'string' },
  { id: 't_date', label: '日期', type: 'date' },
  { id: 't_sel', label: '等级', type: 'select', selectOptions: ['低', '高'] },
  { id: 't_sel_empty', label: '空选项', type: 'select', selectOptions: [] },
  { id: 't_num', label: '金额', type: 'number' },
  { id: 't_formula', label: '公式', type: 'formula' },
]

const VALID_DRAFT: FwbMappingDraft[] = [
  { formFieldId: 'f_title', targetFieldId: 't_text' },
  { formFieldId: 'f_date', targetFieldId: 't_date' },
  { formFieldId: 'f_level', targetFieldId: 't_sel' },
]

interface EditorEvents {
  'update:modelValue': FwbMappingDraft[][]
  'request-confirmation': unknown[][]
  'invalidate-confirmation': null[]
}

describe('ApprovalFwbMappingEditor', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
  })

  async function mountEditor(props: Record<string, unknown> = {}): Promise<EditorEvents> {
    const events: EditorEvents = {
      'update:modelValue': [],
      'request-confirmation': [],
      'invalidate-confirmation': [],
    }
    const Host = defineComponent({
      setup() {
        const model = ref<FwbMappingDraft[]>([
          ...((props.modelValue as readonly FwbMappingDraft[] | undefined) ?? []),
        ])
        return () =>
          h(ApprovalFwbMappingEditor, {
            templateFields: TPL,
            targetFields: TGT,
            ...props,
            modelValue: model.value,
            'onUpdate:modelValue': (value: FwbMappingDraft[]) => {
              model.value = value
              events['update:modelValue'].push(value)
            },
            'onRequest-confirmation': (value: unknown[]) => events['request-confirmation'].push(value),
            'onInvalidate-confirmation': () => events['invalidate-confirmation'].push(null),
          })
      },
    })
    app = createApp(Host)
    app.component('ElSelect', ElSelect)
    app.component('ElOption', ElOption)
    app.component('ElButton', ElButton)
    app.component('ElIcon', ElIcon)
    app.mount(container!)
    await nextTick()
    return events
  }

  function rows(): HTMLElement[] {
    return Array.from(container!.querySelectorAll('[data-testid="fwb-mapping-row"]'))
  }

  function formSelect(row: HTMLElement): HTMLSelectElement {
    return row.querySelector('[data-testid="fwb-form-field-select"]') as HTMLSelectElement
  }

  function targetSelect(row: HTMLElement): HTMLSelectElement {
    return row.querySelector('[data-testid="fwb-target-field-select"]') as HTMLSelectElement
  }

  function targetOptions(row: HTMLElement): HTMLOptionElement[] {
    return Array.from(targetSelect(row).querySelectorAll('option'))
  }

  function change(select: HTMLSelectElement, value: string): void {
    select.value = value
    select.dispatchEvent(new Event('change'))
  }

  function confirmButton(): HTMLButtonElement {
    return container!.querySelector('[data-testid="fwb-request-confirmation"]') as HTMLButtonElement
  }

  it('add appends an empty mapping row; remove drops the row (both invalidate confirmation)', async () => {
    const events = await mountEditor({ modelValue: [] })
    expect(rows()).toHaveLength(0)

    ;(container!.querySelector('[data-testid="fwb-add-mapping"]') as HTMLButtonElement).click()
    await nextTick()
    expect(events['update:modelValue'].at(-1)).toEqual([{ formFieldId: '', targetFieldId: '' }])
    expect(events['invalidate-confirmation']).toHaveLength(1)

    ;(container!.querySelector('[data-testid="fwb-add-mapping"]') as HTMLButtonElement).click()
    await nextTick()
    expect(events['update:modelValue'].at(-1)).toEqual([
      { formFieldId: '', targetFieldId: '' },
      { formFieldId: '', targetFieldId: '' },
    ])

    // remove the second row of a two-row draft
    app!.unmount()
    const events2 = await mountEditor({
      modelValue: [
        { formFieldId: 'f_title', targetFieldId: 't_text' },
        { formFieldId: 'f_date', targetFieldId: 't_date' },
      ],
    })
    const removeButtons = container!.querySelectorAll('[data-testid="fwb-remove-mapping"]')
    ;(removeButtons[1] as HTMLButtonElement).click()
    await nextTick()
    expect(events2['update:modelValue'].at(-1)).toEqual([{ formFieldId: 'f_title', targetFieldId: 't_text' }])
    expect(events2['invalidate-confirmation']).toHaveLength(1)
    expect(events).not.toBe(events2)
  })

  it('stale loaded ids stay losslessly selected: id only as option VALUE, generic localized marker as label', async () => {
    await mountEditor({ modelValue: [{ formFieldId: 'ghost_f', targetFieldId: 'ghost_t' }] })
    const row = rows()[0]

    // both selects keep the stale id as their value (lossless round-trip, no blank select)
    expect(formSelect(row).value).toBe('ghost_f')
    expect(targetSelect(row).value).toBe('ghost_t')

    const staleFormOption = formSelect(row).querySelector('option[value="ghost_f"]') as HTMLOptionElement
    const staleTargetOption = targetSelect(row).querySelector('option[value="ghost_t"]') as HTMLOptionElement
    expect(staleFormOption).not.toBeNull()
    expect(staleTargetOption).not.toBeNull()
    // user-facing label is the generic marker — never the raw id alone
    expect(staleFormOption.textContent?.trim()).toBe('不可用字段')
    expect(staleTargetOption.textContent?.trim()).toBe('不可用字段')
    expect(Array.from(row.querySelectorAll('option')).some((o) => o.textContent?.trim() === 'ghost_f')).toBe(false)
    expect(Array.from(row.querySelectorAll('option')).some((o) => o.textContent?.trim() === 'ghost_t')).toBe(false)

    // stale fields are marked non-authoritative: the row carries block reasons and confirmation stays blocked
    expect(row.querySelector('[data-testid="fwb-row-issues"]')?.textContent).toContain('已失效')
    expect(confirmButton().disabled).toBe(true)
  })

  it('a LOADED exact-number mapping stays visible with a clear blocked reason (never silently dropped)', async () => {
    const events = await mountEditor({ modelValue: [{ formFieldId: 'f_title', targetFieldId: 't_num' }] })
    expect(rows()).toHaveLength(1)
    const row = rows()[0]
    expect(targetSelect(row).value).toBe('t_num')
    const numberOption = targetSelect(row).querySelector('option[value="t_num"]') as HTMLOptionElement
    expect(numberOption).not.toBeNull()
    expect(numberOption.disabled).toBe(true)
    const reason = row.querySelector('[data-testid="fwb-row-issues"]')?.textContent ?? ''
    expect(reason).toContain('数值字段暂不支持')
    confirmButton().click()
    await nextTick()
    expect(events['request-confirmation']).toHaveLength(0)
  })

  it('TRIPWIRE — number/unsupported targets are never offered for NEW mappings (fails if number becomes authorable)', async () => {
    await mountEditor({ modelValue: [{ formFieldId: 'f_title', targetFieldId: '' }] })
    const options = targetOptions(rows()[0])
    // number target: entirely absent from the new-mapping option set
    expect(options.some((o) => o.value === 't_num')).toBe(false)
    // unsupported type: also absent
    expect(options.some((o) => o.value === 't_formula')).toBe(false)
    // every OFFERED (enabled) option is a text/date/select-with-options target — if number
    // ever becomes authorable, an enabled t_num option appears here and this fails
    for (const option of options) {
      if (option.disabled) continue
      expect(['t_text', 't_date', 't_sel']).toContain(option.value)
    }
  })

  it('a select target without options stays visible but blocked — for loaded AND new mappings', async () => {
    // loaded: row visible, blocked reason, confirmation blocked
    const events = await mountEditor({ modelValue: [{ formFieldId: 'f_title', targetFieldId: 't_sel_empty' }] })
    const row = rows()[0]
    expect(targetSelect(row).value).toBe('t_sel_empty')
    expect(row.querySelector('[data-testid="fwb-row-issues"]')?.textContent).toContain('缺少可选值')
    confirmButton().click()
    await nextTick()
    expect(events['request-confirmation']).toHaveLength(0)

    // new mapping: the option-less select target is offered only as a DISABLED, reason-marked option
    app!.unmount()
    await mountEditor({ modelValue: [{ formFieldId: 'f_title', targetFieldId: '' }] })
    const emptySelect = targetOptions(rows()[0]).find((o) => o.value === 't_sel_empty')!
    expect(emptySelect.disabled).toBe(true)
    expect(emptySelect.textContent).toContain('缺少可选值')
  })

  it('duplicate targets block confirmation with a per-row reason', async () => {
    const events = await mountEditor({
      modelValue: [
        { formFieldId: 'f_title', targetFieldId: 't_text' },
        { formFieldId: 'f_date', targetFieldId: 't_text' },
      ],
    })
    expect(rows()[1].querySelector('[data-testid="fwb-row-issues"]')?.textContent).toContain('目标字段重复')
    expect(confirmButton().disabled).toBe(true)
    confirmButton().click()
    await nextTick()
    expect(events['request-confirmation']).toHaveLength(0)
    expect(targetSelect(rows()[0]).querySelector('option[value="t_text"]')?.disabled).toBe(true)
    expect(targetSelect(rows()[1]).querySelector('option[value="t_text"]')?.disabled).toBe(true)
  })

  it('a target selected by another row is unavailable before it can create a duplicate', async () => {
    await mountEditor({
      modelValue: [
        { formFieldId: 'f_title', targetFieldId: 't_text' },
        { formFieldId: 'f_date', targetFieldId: '' },
      ],
    })
    const firstTarget = targetSelect(rows()[0]).querySelector('option[value="t_text"]') as HTMLOptionElement
    const secondTarget = targetSelect(rows()[1]).querySelector('option[value="t_text"]') as HTMLOptionElement
    expect(firstTarget.disabled).toBe(false)
    expect(secondTarget.disabled).toBe(true)
  })

  it('empty config blocks confirmation with a global reason', async () => {
    const events = await mountEditor({ modelValue: [] })
    expect(container!.querySelector('[data-testid="fwb-global-issues"]')?.textContent).toContain('至少需要一条映射')
    expect(confirmButton().disabled).toBe(true)
    confirmButton().click()
    await nextTick()
    expect(events['request-confirmation']).toHaveLength(0)
  })

  it('request-confirmation fires ONLY for a fully valid text/date/select draft, carrying executor-shaped mappings', async () => {
    const events = await mountEditor({ modelValue: VALID_DRAFT })
    expect(confirmButton().disabled).toBe(false)
    confirmButton().click()
    await nextTick()
    expect(events['request-confirmation']).toHaveLength(1)
    expect(events['request-confirmation'][0]).toEqual([
      { formFieldId: 'f_title', targetFieldId: 't_text', targetType: 'text' },
      { formFieldId: 'f_date', targetFieldId: 't_date', targetType: 'date' },
      { formFieldId: 'f_level', targetFieldId: 't_sel', targetType: 'select', selectOptions: ['低', '高'] },
    ])
  })

  it('an edit while CONFIRMED immediately emits invalidate-confirmation (and every mutation does)', async () => {
    const events = await mountEditor({ modelValue: VALID_DRAFT, confirmationState: 'confirmed' })
    expect(container!.querySelector('[data-testid="fwb-confirmation-state"]')?.textContent).toContain('已确认')

    change(formSelect(rows()[0]), 'f_date')
    await nextTick()
    expect(events['update:modelValue'].at(-1)![0]).toMatchObject({ formFieldId: 'f_date', targetFieldId: 't_text' })
    expect(events['invalidate-confirmation'].length).toBeGreaterThanOrEqual(1)
    const invalidationsAfterEdit = events['invalidate-confirmation'].length

    change(targetSelect(rows()[1]), 't_text')
    await nextTick()
    expect(events['update:modelValue'].at(-1)![1]).toMatchObject({ formFieldId: 'f_date', targetFieldId: 't_text' })
    expect(events['invalidate-confirmation'].length).toBe(invalidationsAfterEdit + 1)
  })

  it('does not expose a client-owned confirmation hash prop', () => {
    const componentProps = (ApprovalFwbMappingEditor as unknown as {
      props?: Record<string, unknown>
    }).props ?? {}
    expect(Object.keys(componentProps)).not.toContain('confirmationHash')
  })

  it('disabled and loading disable every control and block all interaction', async () => {
    for (const gate of [{ disabled: true }, { loading: true }]) {
      const events = await mountEditor({ modelValue: VALID_DRAFT, ...gate })
      for (const select of container!.querySelectorAll('select')) {
        expect((select as HTMLSelectElement).disabled).toBe(true)
      }
      for (const button of container!.querySelectorAll('button')) {
        expect((button as HTMLButtonElement).disabled).toBe(true)
      }
      confirmButton().click()
      ;(container!.querySelector('[data-testid="fwb-add-mapping"]') as HTMLButtonElement).click()
      change(formSelect(rows()[0]), 'f_date')
      change(targetSelect(rows()[0]), 't_date')
      await nextTick()
      expect(events['update:modelValue']).toHaveLength(0)
      expect(events['request-confirmation']).toHaveLength(0)
      expect(events['invalidate-confirmation']).toHaveLength(0)
      app!.unmount()
    }
  })

  it('confirming state blocks re-requesting confirmation; state label tracks the prop', async () => {
    const events = await mountEditor({ modelValue: VALID_DRAFT, confirmationState: 'confirming' })
    expect(container!.querySelector('[data-testid="fwb-confirmation-state"]')?.textContent).toContain('确认中')
    expect(confirmButton().disabled).toBe(true)
    confirmButton().click()
    await nextTick()
    expect(events['request-confirmation']).toHaveLength(0)
  })

  it('confirmed state blocks a duplicate confirmation request until a mapping mutation invalidates it', async () => {
    const events = await mountEditor({ modelValue: VALID_DRAFT, confirmationState: 'confirmed' })
    expect(confirmButton().disabled).toBe(true)
    confirmButton().click()
    await nextTick()
    expect(events['request-confirmation']).toHaveLength(0)
  })

  it('en locale renders the generic unavailable marker and reasons in English', async () => {
    await mountEditor({ modelValue: [{ formFieldId: 'ghost_f', targetFieldId: 't_num' }], isZh: false })
    const row = rows()[0]
    expect(formSelect(row).querySelector('option[value="ghost_f"]')?.textContent?.trim()).toBe('Unavailable field')
    expect(row.querySelector('[data-testid="fwb-row-issues"]')?.textContent).toContain('Exact number mapping is not available yet')
    expect(container!.querySelector('[data-testid="fwb-confirmation-state"]')?.textContent).toContain('Unconfirmed')
  })

  it('longest bilingual labels remain inside the bounded row structure', async () => {
    const LONG_ZH = '非常非常非常长的一个审批表单字段名称用于验证布局不会溢出'
    const LONG_EN = 'An-extremely-long-approval-form-field-label-that-must-never-break-the-row-layout'
    await mountEditor({
      templateFields: [{ id: 'f_long', label: LONG_ZH }],
      targetFields: [{ id: 't_long', label: LONG_EN, type: 'string' }],
      modelValue: [{ formFieldId: 'f_long', targetFieldId: 't_long' }],
    })
    const row = rows()[0]
    // row is a fixed 3-column grid; both selects live inside it with the remove button
    expect(row.classList.contains('fwb-mapping-editor__row')).toBe(true)
    expect(row.querySelectorAll('select')).toHaveLength(2)
    expect(row.querySelector('[data-testid="fwb-remove-mapping"]')).not.toBeNull()
    // long labels render as option text (truncation is CSS, content stays lossless)
    expect(formSelect(row).querySelector('option[value="f_long"]')?.textContent).toBe(LONG_ZH)
    expect(targetSelect(row).querySelector('option[value="t_long"]')?.textContent).toBe(LONG_EN)

    expect(container!.querySelector('textarea')).toBeNull()
    expect(container!.querySelector('input')).toBeNull()
  })

  it('add/remove controls carry aria-label + title (icon-only remove button stays accessible)', async () => {
    await mountEditor({ modelValue: [{ formFieldId: 'f_title', targetFieldId: 't_text' }] })
    const add = container!.querySelector('[data-testid="fwb-add-mapping"]') as HTMLButtonElement
    const remove = container!.querySelector('[data-testid="fwb-remove-mapping"]') as HTMLButtonElement
    expect(add.getAttribute('aria-label')).toBe('添加映射')
    expect(add.getAttribute('title')).toBe('添加映射')
    expect(remove.getAttribute('aria-label')).toBe('移除映射')
    expect(remove.getAttribute('title')).toBe('移除映射')
  })
})
