import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import MetaFieldManager from '../src/multitable/components/MetaFieldManager.vue'
import MetaFieldValidationPanel from '../src/multitable/components/MetaFieldValidationPanel.vue'
import MetaViewManager from '../src/multitable/components/MetaViewManager.vue'
import {
  formattingOperatorLabel,
  formattingPickColor,
  managerLabel,
} from '../src/multitable/utils/meta-manager-labels'

function mount(render: () => ReturnType<typeof h>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app: App = createApp({ render })
  app.mount(container)
  return { app, container }
}

async function flush() {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

describe('multitable manager panel i18n', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    useLocale().setLocale('en')
    vi.restoreAllMocks()
  })

  it('renders field manager chrome in zh-CN while preserving authored field names', async () => {
    useLocale().setLocale('zh-CN')
    const { container, app } = mount(() =>
      h(MetaFieldManager, {
        visible: true,
        sheetId: 'sheet_1',
        sheets: [],
        fields: [
          { id: 'fld_status', name: 'Status', type: 'string', property: {} },
        ],
      }),
    )
    await flush()

    expect(container.textContent).toContain('管理字段')
    expect(container.textContent).toContain('Status')
    expect(container.textContent).toContain('文本')
    expect(container.querySelector('.meta-field-mgr__action[title="配置"]')).toBeTruthy()

    ;(container.querySelector('.meta-field-mgr__action[title="配置"]') as HTMLButtonElement).click()
    await flush()

    expect(container.textContent).toContain('配置 Status')
    expect(container.textContent).toContain('保存字段设置')
    expect(container.textContent).toContain('校验规则')

    app.unmount()
  })

  it('renders view manager chrome in zh-CN while preserving authored view names', async () => {
    useLocale().setLocale('zh-CN')
    const { container, app } = mount(() =>
      h(MetaViewManager, {
        visible: true,
        sheetId: 'sheet_1',
        activeViewId: 'view_timeline',
        fields: [
          { id: 'fld_title', name: 'Title', type: 'string' },
          { id: 'fld_start', name: 'Start', type: 'date' },
          { id: 'fld_end', name: 'End', type: 'date' },
        ],
        views: [
          {
            id: 'view_timeline',
            sheetId: 'sheet_1',
            name: 'Roadmap',
            type: 'timeline',
            config: { startFieldId: 'fld_start', endFieldId: 'fld_end', labelFieldId: 'fld_title', zoom: 'week' },
          },
        ],
      }),
    )
    await flush()

    expect(container.textContent).toContain('管理视图')
    expect(container.textContent).toContain('Roadmap')
    expect(container.textContent).toContain('时间轴')
    expect(container.querySelector('.meta-view-mgr__action[title="配置"]')).toBeTruthy()

    ;(container.querySelector('.meta-view-mgr__action[title="配置"]') as HTMLButtonElement).click()
    await flush()

    expect(container.textContent).toContain('配置 Roadmap')
    expect(container.textContent).toContain('开始字段')
    expect(container.textContent).toContain('筛选、排序、分组')
    expect(container.textContent).toContain('保存视图设置')

    app.unmount()
  })

  it('renders field validation panel chrome in zh-CN', async () => {
    useLocale().setLocale('zh-CN')
    const { container, app } = mount(() =>
      h(MetaFieldValidationPanel, {
        fieldId: 'fld_text',
        fieldType: 'text',
        rules: [{ type: 'required' }, { type: 'minLength', value: 3 }],
      }),
    )
    await flush()

    expect(container.textContent).toContain('校验规则')
    expect(container.textContent).toContain('必填')
    expect(container.textContent).toContain('最小长度')
    expect(container.textContent).toContain('模式')
    expect(container.textContent).toContain('预览')

    app.unmount()
  })

  it('preserves English manager chrome by default', async () => {
    useLocale().setLocale('en')
    const { container, app } = mount(() =>
      h(MetaViewManager, {
        visible: true,
        sheetId: 'sheet_1',
        activeViewId: 'view_grid',
        fields: [],
        views: [
          { id: 'view_grid', sheetId: 'sheet_1', name: 'Grid', type: 'grid', config: {} },
        ],
      }),
    )
    await flush()

    expect(container.textContent).toContain('Manage Views')
    expect(container.textContent).toContain('grid')
    expect(container.querySelector('.meta-view-mgr__action[title="Configure"]')).toBeTruthy()

    app.unmount()
  })

  it('formats conditional-formatting manager labels and preserves raw values', () => {
    expect(managerLabel('formatting.title', false)).toBe('Conditional formatting')
    expect(managerLabel('formatting.title', true)).toBe('条件格式')
    expect(formattingOperatorLabel('eq', 'select', false)).toBe('is')
    expect(formattingOperatorLabel('eq', 'multiSelect', true)).toBe('是')
    expect(formattingOperatorLabel('eq', 'number', true)).toBe('=')
    expect(formattingOperatorLabel('between', 'number', true)).toBe('介于')
    expect(formattingOperatorLabel('contains', 'string', true)).toBe('包含')
    expect(formattingOperatorLabel('is_true', 'boolean', true)).toBe('已勾选')
    expect(formattingOperatorLabel('is_today', 'date', true)).toBe('是今天')
    expect(formattingOperatorLabel('unknown_operator', 'string', true)).toBe('unknown_operator')
    expect(formattingPickColor('#fce4e4', true)).toBe('选择颜色 #fce4e4')
  })
})
