/**
 * 「选择关联记录」弹窗：关联字段没有目标表时给人话，不再甩后端原文（2026-09-10 用户报告）。
 *
 * 用户看到的是 `Link field is missing foreignSheetId: fld_63b459ab-...` —— 后端 400 的 message 被
 * MetaLinkPicker 原样渲染。修复后后端答稳定码 `LINK_FIELD_FOREIGN_SHEET_MISSING`（message 已 values-free），
 * 前端按 CODE 翻成人话，中英各一份。其它错误（403/503/网络）仍走 message → 通用文案的原有兜底。
 *
 * 文件名前缀命中既有的 `multitable-link-picker` 过滤 token（multitable-web-guard.yml 与
 * run-required-web-tests.sh 都已登记该 token），所以无需改那两条巨行。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import MetaLinkPicker from '../src/multitable/components/MetaLinkPicker.vue'
import { useLocale } from '../src/composables/useLocale'
import { linkPickerErrorMessage } from '../src/multitable/utils/meta-link-picker-labels'

const { mockListLinkOptions } = vi.hoisted(() => ({
  mockListLinkOptions: vi.fn(),
}))

vi.mock('../src/multitable/api/client', () => ({
  multitableClient: {
    listLinkOptions: mockListLinkOptions,
  },
}))

const brokenLinkField = {
  id: 'fld_63b459ab-1a89-4864-a31b-475155fc9c88',
  name: '关联',
  type: 'link',
}

function apiError(code: string, message: string): Error & { code: string; status: number } {
  const error = new Error(message) as Error & { code: string; status: number }
  error.name = 'MultitableApiError'
  error.code = code
  error.status = 400
  return error
}

async function flushPromises() {
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

async function mountPickerAndOpen() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const Harness = defineComponent({
    setup() {
      const visible = ref(false)
      return { visible }
    },
    render() {
      return h(MetaLinkPicker, {
        visible: this.visible,
        field: brokenLinkField,
        currentValue: [],
        onClose: vi.fn(),
        onConfirm: vi.fn(),
      })
    },
  })
  const app = createApp(Harness)
  const vm = app.mount(container) as any
  vm.visible = true
  await flushPromises()
  return { app, container }
}

describe('MetaLinkPicker — 关联字段没有目标表', () => {
  afterEach(() => {
    useLocale().setLocale('en')
    vi.clearAllMocks()
  })

  it('把 LINK_FIELD_FOREIGN_SHEET_MISSING 翻成中文人话，不显示 fieldId', async () => {
    useLocale().setLocale('zh-CN')
    mockListLinkOptions.mockRejectedValue(
      apiError('LINK_FIELD_FOREIGN_SHEET_MISSING', '该关联字段还没有设置要关联哪张数据表'),
    )

    const { app, container } = await mountPickerAndOpen()
    const error = container.querySelector('[data-test="link-picker-error"]')

    expect(error?.textContent).toContain('这个关联字段还没有设置要关联哪张表')
    expect(error?.textContent).toContain('管理字段')
    expect(container.textContent).not.toContain(brokenLinkField.id)
    expect(container.textContent).not.toContain('foreignSheetId')

    app.unmount()
    container.remove()
  })

  it('英文 locale 下给英文人话', async () => {
    useLocale().setLocale('en')
    mockListLinkOptions.mockRejectedValue(
      apiError('LINK_FIELD_FOREIGN_SHEET_MISSING', '该关联字段还没有设置要关联哪张数据表'),
    )

    const { app, container } = await mountPickerAndOpen()
    const error = container.querySelector('[data-test="link-picker-error"]')

    expect(error?.textContent).toContain('This link field has no target sheet yet')
    expect(error?.textContent).toContain('Manage fields')
    expect(container.textContent).not.toContain(brokenLinkField.id)

    app.unmount()
    container.remove()
  })

  it('其它错误仍按后端 message 呈现（兜底未被改宽/改窄）', async () => {
    useLocale().setLocale('en')
    mockListLinkOptions.mockRejectedValue(apiError('FORBIDDEN', 'Insufficient permissions'))

    const { app, container } = await mountPickerAndOpen()
    const error = container.querySelector('[data-test="link-picker-error"]')

    expect(error?.textContent).toContain('Insufficient permissions')
    expect(error?.textContent).not.toContain('This link field has no target sheet yet')

    app.unmount()
    container.remove()
  })

  it('linkPickerErrorMessage：写入口的 REQUIRED 码同样翻人话；无码/无 message 退回通用文案', () => {
    expect(linkPickerErrorMessage({ code: 'LINK_FIELD_FOREIGN_SHEET_REQUIRED' }, true))
      .toContain('这个关联字段还没有设置要关联哪张表')
    expect(linkPickerErrorMessage({ message: 'boom' }, false)).toBe('boom')
    expect(linkPickerErrorMessage(null, false)).toBe('Failed to load records')
    expect(linkPickerErrorMessage({}, true)).toBe('加载记录失败')
  })
})
