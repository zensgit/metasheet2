/**
 * 字段管理 · 关联字段草稿区：没选目标表就提示 + 禁用保存，选好即自愈（2026-09-10 用户报告）。
 *
 * 用户撞到的坏字段是"link 但 property 里没有 foreignSheetId"（后端旧写口 fail-open 放进来的）。
 * 修复三层里的第三层：在「管理字段」里编辑这种字段时，面板必须显式说"要选目标表"，并且在没选之前
 * 不给保存；选好目标表保存，emit 出去的 property 带 foreignSheetId —— 这就是这类历史坏字段的自愈路径
 * （不做自动迁移去猜目标表）。
 *
 * 文件名前缀命中既有的 `multitable-field-manager` 过滤 token（multitable-web-guard.yml 与
 * run-required-web-tests.sh 都已登记该 token），所以无需改那两条巨行。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaFieldManager from '../src/multitable/components/MetaFieldManager.vue'
import { useLocale } from '../src/composables/useLocale'

const BROKEN_LINK_FIELD = {
  id: 'fld_63b459ab-1a89-4864-a31b-475155fc9c88',
  name: '关联',
  type: 'link',
  // 坏在这里：link 却没有 foreignSheetId（任何别名都没有）
  property: { limitSingleRecord: false },
}

// 历史"link 背书的人员字段"：stored type='link' + refKind:'user'，面板把它显示成 person。
const LEGACY_LINK_BACKED_PERSON = {
  id: 'fld_legacy_person',
  name: '负责人',
  type: 'link',
  property: { refKind: 'user', foreignSheetId: 'sheet_people', foreignDatasheetId: 'sheet_people', limitSingleRecord: true },
}

const HEALTHY_LINK_FIELD = {
  id: 'fld_healthy',
  name: '关联供应商',
  type: 'link',
  property: { foreignSheetId: 'sheet_2', foreignDatasheetId: 'sheet_2', limitSingleRecord: false },
}

function mountManager(fields: unknown[], updateSpy = vi.fn()) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    render() {
      return h(MetaFieldManager, {
        visible: true,
        sheetId: 'sheet_1',
        sheets: [{ id: 'sheet_2', name: 'Related' }],
        fields,
        onUpdateField: updateSpy,
      })
    },
  })
  app.mount(container)
  return { app, container, updateSpy }
}

function openConfigForFirstField(container: HTMLElement) {
  const configButton = Array.from(container.querySelectorAll('.meta-field-mgr__action'))
    .find((button) => button.textContent?.includes('⚙')) as HTMLButtonElement | undefined
  expect(configButton).toBeTruthy()
  configButton?.click()
}

describe('MetaFieldManager — 关联字段缺目标表', () => {
  afterEach(() => {
    useLocale().setLocale('en')
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('编辑一个没有目标表的历史 link 字段：显式提示 + 保存禁用', async () => {
    const { app, container } = mountManager([BROKEN_LINK_FIELD])
    await nextTick()

    openConfigForFirstField(container)
    await nextTick()

    const hint = container.querySelector('[data-test="link-target-required"]')
    expect(hint).toBeTruthy()
    expect(hint?.textContent).toContain('Pick the sheet this field links to')

    const save = container.querySelector('[data-test="field-config-save"]') as HTMLButtonElement | null
    expect(save).toBeTruthy()
    expect(save?.disabled).toBe(true)

    app.unmount()
  })

  it('中文 locale 下提示是中文人话', async () => {
    useLocale().setLocale('zh-CN')
    const { app, container } = mountManager([BROKEN_LINK_FIELD])
    await nextTick()

    openConfigForFirstField(container)
    await nextTick()

    expect(container.querySelector('[data-test="link-target-required"]')?.textContent)
      .toContain('请选择这个字段要关联哪张数据表')

    app.unmount()
  })

  it('选好目标表后提示消失、保存可点，emit 的 property 带 foreignSheetId（自愈）', async () => {
    const updateSpy = vi.fn()
    const { app, container } = mountManager([BROKEN_LINK_FIELD], updateSpy)
    await nextTick()

    openConfigForFirstField(container)
    await nextTick()

    const targetSelect = Array.from(container.querySelectorAll('.meta-field-mgr__config select'))
      .find((select) => Array.from((select as HTMLSelectElement).options).some((option) => option.value === 'sheet_2')) as HTMLSelectElement | undefined
    expect(targetSelect).toBeTruthy()
    targetSelect!.value = 'sheet_2'
    targetSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    expect(container.querySelector('[data-test="link-target-required"]')).toBeNull()
    const save = container.querySelector('[data-test="field-config-save"]') as HTMLButtonElement
    expect(save.disabled).toBe(false)

    save.click()
    await nextTick()

    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy.mock.calls[0][0]).toBe(BROKEN_LINK_FIELD.id)
    expect(updateSpy.mock.calls[0][1].property).toMatchObject({
      foreignSheetId: 'sheet_2',
      foreignDatasheetId: 'sheet_2',
    })

    app.unmount()
  })

  it('健康的 link 字段不受影响：无提示、保存可点（正控）', async () => {
    const { app, container } = mountManager([HEALTHY_LINK_FIELD])
    await nextTick()

    openConfigForFirstField(container)
    await nextTick()

    expect(container.querySelector('[data-test="link-target-required"]')).toBeNull()
    const save = container.querySelector('[data-test="field-config-save"]') as HTMLButtonElement
    expect(save.disabled).toBe(false)

    app.unmount()
  })

  it('新建 link 字段：目标表未选前保存禁用且有提示（写入口前置，和后端 fail-closed 同一条规则）', async () => {
    const { app, container } = mountManager([])
    await nextTick()

    const nameInput = container.querySelector('.meta-field-mgr__add-row .meta-field-mgr__input') as HTMLInputElement
    const typeSelect = container.querySelector('.meta-field-mgr__add-row .meta-field-mgr__select') as HTMLSelectElement
    nameInput.value = '关联'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    typeSelect.value = 'link'
    typeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    expect(container.querySelector('[data-test="link-target-required"]')).toBeTruthy()
    const save = container.querySelector('[data-test="field-config-save"]') as HTMLButtonElement
    expect(save.disabled).toBe(true)

    app.unmount()
  })
  it('历史 link 背书的人员字段：改单选/多选不再抹掉 refKind 与 foreignSheetId（坏字段的生产源）', async () => {
    // 这是 09-10 用户报告里坏字段最可能的来源：`update-field` 整体替换 property，而 person 分支过去只发
    // `limitSingleRecord`，一次编辑就把字段变成"link 但没有目标表"。修复后两个结构键按存量原样带回。
    const updateSpy = vi.fn()
    const { app, container } = mountManager([LEGACY_LINK_BACKED_PERSON], updateSpy)
    await nextTick()

    openConfigForFirstField(container)
    await nextTick()

    const toggle = container.querySelector('.meta-field-mgr__config input[type="checkbox"]') as HTMLInputElement
    expect(toggle).toBeTruthy()
    toggle.checked = !toggle.checked
    toggle.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    const save = container.querySelector('[data-test="field-config-save"]') as HTMLButtonElement
    expect(save.disabled).toBe(false)
    save.click()
    await nextTick()

    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy.mock.calls[0][1].property).toMatchObject({
      refKind: 'user',
      foreignSheetId: 'sheet_people',
      foreignDatasheetId: 'sheet_people',
    })

    app.unmount()
  })
})
