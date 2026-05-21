import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'

import { useLocale } from '../src/composables/useLocale'
import ConditionalFormattingDialog from '../src/multitable/components/ConditionalFormattingDialog.vue'
import type { ConditionalFormattingRule, MetaField } from '../src/multitable/types'

const fields: MetaField[] = [
  { id: 'fld_amount', name: 'Amount', type: 'number', property: {} },
  { id: 'fld_title', name: 'Title', type: 'string', property: {} },
  {
    id: 'fld_status',
    name: 'Status',
    type: 'select',
    options: [{ value: 'Pending' }, { value: 'Done' }],
    property: {},
  },
  {
    id: 'fld_tags',
    name: 'Tags',
    type: 'multiSelect',
    options: [{ value: '未处理' }, { value: 'Escalated' }],
    property: {},
  },
  { id: 'fld_done', name: 'Done', type: 'boolean', property: {} },
  { id: 'fld_due', name: 'Due', type: 'date', property: {} },
]

function rule(partial: Partial<ConditionalFormattingRule>): ConditionalFormattingRule {
  return {
    id: 'rule_1',
    order: 0,
    fieldId: 'fld_amount',
    operator: 'between',
    value: [1, 5],
    style: { backgroundColor: '#fce4e4', applyToRow: true },
    enabled: true,
    ...partial,
  }
}

function mountDialog(propsOverride: Partial<{
  visible: boolean
  fields: MetaField[]
  viewConfig: Record<string, unknown>
  onClose: () => void
  onSave: (rules: ConditionalFormattingRule[]) => void
  'onUpdate:dirty': (dirty: boolean) => void
}> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const props = {
    visible: true,
    fields,
    viewConfig: {
      conditionalFormattingRules: [
        rule({ id: 'rule_number', order: 0, fieldId: 'fld_amount', operator: 'between', value: [1, 5] }),
        rule({ id: 'rule_text', order: 1, fieldId: 'fld_title', operator: 'contains', value: 'Alpha' }),
        rule({ id: 'rule_select', order: 2, fieldId: 'fld_status', operator: 'eq', value: 'Pending' }),
        rule({ id: 'rule_multi', order: 3, fieldId: 'fld_tags', operator: 'contains', value: '未处理' }),
        rule({ id: 'rule_bool', order: 4, fieldId: 'fld_done', operator: 'is_true', value: undefined }),
        rule({ id: 'rule_date', order: 5, fieldId: 'fld_due', operator: 'is_today', value: undefined }),
      ],
    },
    onClose: vi.fn(),
    onSave: vi.fn(),
    'onUpdate:dirty': vi.fn(),
    ...propsOverride,
  }
  const app: App = createApp({ render: () => h(ConditionalFormattingDialog, props) })
  app.mount(container)
  return { app, container, props }
}

async function flush() {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

describe('ConditionalFormattingDialog i18n', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    useLocale().setLocale('en')
    vi.restoreAllMocks()
  })

  it('renders conditional-formatting chrome in zh-CN while preserving raw fields/options/colors', async () => {
    useLocale().setLocale('zh-CN')
    const { app, container } = mountDialog()
    await flush()

    expect(container.querySelector('.cf-dlg')?.getAttribute('aria-label')).toBe('条件格式规则')
    expect(container.textContent).toContain('条件格式')
    expect(container.querySelector('.cf-dlg__close')?.getAttribute('aria-label')).toBe('关闭')
    expect(container.textContent).toContain('颜色')
    expect(container.textContent).toContain('应用到整行')
    expect(container.textContent).toContain('启用')
    expect(container.textContent).toContain('▲ 上移')
    expect(container.textContent).toContain('▼ 下移')
    expect(container.textContent).toContain('+ 添加规则')
    expect(container.textContent).toContain('取消')
    expect(container.textContent).toContain('保存规则')

    expect(container.textContent).toContain('Amount')
    expect(container.textContent).toContain('Status')
    expect(container.textContent).toContain('Pending')
    expect(container.textContent).toContain('未处理')
    expect(container.querySelector('.cf-dlg__swatch')?.getAttribute('aria-label')).toBe('选择颜色 #fce4e4')
    expect(container.querySelector('.cf-dlg__hex')?.getAttribute('placeholder')).toBe('#RRGGBB')

    const numberInputs = Array.from(container.querySelectorAll('.cf-dlg__input--mini')) as HTMLInputElement[]
    expect(numberInputs.map((input) => input.getAttribute('placeholder'))).toEqual(['最小值', '最大值'])

    const optionLabels = Array.from(container.querySelectorAll('option')).map((option) => option.textContent ?? '')
    expect(optionLabels).toContain('=')
    expect(optionLabels).toContain('介于')
    expect(optionLabels).toContain('包含')
    expect(optionLabels).toContain('是')
    expect(optionLabels).toContain('已勾选')
    expect(optionLabels).toContain('是今天')

    app.unmount()
  })

  it('preserves English conditional-formatting chrome by default', async () => {
    const { app, container } = mountDialog()
    await flush()

    expect(container.querySelector('.cf-dlg')?.getAttribute('aria-label')).toBe('Conditional formatting rules')
    expect(container.textContent).toContain('Conditional formatting')
    expect(container.textContent).toContain('Apply to whole row')
    expect(container.textContent).toContain('▲ Up')
    expect(container.textContent).toContain('▼ Down')
    expect(container.querySelector('.cf-dlg__swatch')?.getAttribute('aria-label')).toBe('Pick color #fce4e4')

    const optionLabels = Array.from(container.querySelectorAll('option')).map((option) => option.textContent ?? '')
    expect(optionLabels).toContain('between')
    expect(optionLabels).toContain('contains')
    expect(optionLabels).toContain('is')

    app.unmount()
  })

  it('uses the localized dirty-confirm message without adding aria attributes', async () => {
    useLocale().setLocale('zh-CN')
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { app, container, props } = mountDialog()
    await flush()

    const applyToRow = container.querySelector('.cf-dlg__check-inline input[type=checkbox]') as HTMLInputElement
    applyToRow.checked = false
    applyToRow.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()

    const close = container.querySelector('.cf-dlg__close') as HTMLButtonElement
    close.click()
    await flush()

    expect(confirmSpy).toHaveBeenCalledWith('放弃未保存的格式规则吗？')
    expect(props.onClose).not.toHaveBeenCalled()
    expect(container.querySelectorAll('[aria-label]')).toHaveLength(50)

    app.unmount()
  })

  it('renders empty/no-field states in zh-CN', async () => {
    useLocale().setLocale('zh-CN')
    const { app, container } = mountDialog({
      fields: [],
      viewConfig: { conditionalFormattingRules: [] },
    })
    await flush()

    expect(container.textContent).toContain('暂无规则。添加规则后，可根据字段值为单元格或整行着色。')
    expect(container.textContent).toContain('请先向 Sheet 添加字段，再创建格式规则。')

    app.unmount()
  })
})
