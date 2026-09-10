/**
 * 模板中心「把 Base 存为模板」入口(09-10 测试反馈第 8 条:模板中心只能用、不能建)。
 *
 * 覆盖:
 *  - 入口按权限显隐(镜像服务端 canManageFields = 管理员角色或 multitable:manage-schema);
 *  - 表单校验(没选 Base / 没填名字 → 提交禁用);
 *  - 提交调 client.createTemplateFromBase 并把服务端的降级 warnings 原样展示,列表强制刷新;
 *  - 自定义模板卡片带「自定义」角标与删除入口,内置模板两者都没有;
 *  - 删除走 client.deleteTemplate 并刷新列表。
 *
 * 隐藏只是 UX,服务端才是门 —— 路由级证明在
 * packages/core-backend/tests/unit/multitable-custom-template-routes.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App as VueApp, type Component } from 'vue'
import MultitableTemplateCenterView from '../src/views/MultitableTemplateCenterView.vue'
import { useLocale } from '../src/composables/useLocale'

const USER_PERMISSIONS_KEY = 'user_permissions'

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  listTemplates: vi.fn(),
  installTemplate: vi.fn(),
  listBases: vi.fn(),
  createTemplateFromBase: vi.fn(),
  deleteTemplate: vi.fn(),
}))

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return { ...actual, useRouter: () => ({ push: mocks.push }) }
})

vi.mock('../src/multitable/api/client', () => ({
  multitableClient: {
    listTemplates: mocks.listTemplates,
    installTemplate: mocks.installTemplate,
    listBases: mocks.listBases,
    createTemplateFromBase: mocks.createTemplateFromBase,
    deleteTemplate: mocks.deleteTemplate,
  },
}))

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function makeTemplate(overrides: { id: string; name: string; custom?: boolean; category?: string }) {
  return {
    id: overrides.id,
    name: overrides.name,
    description: '',
    category: overrides.category ?? 'Operations',
    icon: 'T',
    color: '#2563eb',
    sheets: [{ id: 's1', name: 'Sheet', fields: [{ id: 'f1' }], views: [{ id: 'v1', name: 'Grid', type: 'grid' }] }],
    ...(overrides.custom ? { custom: true } : {}),
  }
}

function setValue(input: HTMLInputElement | HTMLSelectElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input'))
  input.dispatchEvent(new Event('change'))
}

describe('模板中心 —— 把 Base 存为模板', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    useLocale().setLocale('zh-CN')
    localStorage.removeItem(USER_PERMISSIONS_KEY)
    mocks.listTemplates.mockResolvedValue({ templates: [] })
    mocks.listBases.mockResolvedValue({ bases: [{ id: 'base_ops', name: '运营库' }] })
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    localStorage.removeItem(USER_PERMISSIONS_KEY)
    useLocale().setLocale('en')
    vi.clearAllMocks()
  })

  function mountView(): HTMLElement {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(MultitableTemplateCenterView as Component)
    app.component('router-link', {
      props: ['to'],
      render() {
        const href = typeof this.$props.to === 'string' ? this.$props.to : JSON.stringify(this.$props.to)
        return h('a', { href, 'data-router-link-to': href }, this.$slots.default ? this.$slots.default() : [])
      },
    })
    app.mount(container)
    return container
  }

  it('没有 multitable:manage-schema 时不给「存为模板」入口', async () => {
    const root = mountView()
    await flushUi()
    expect(root.querySelector('[data-testid="template-create-open"]')).toBeNull()
    expect(root.querySelector('[data-testid="template-create-form"]')).toBeNull()
  })

  it('有 multitable:manage-schema:打开表单会拉 Base 列表,选 Base 自动带出名字', async () => {
    localStorage.setItem(USER_PERMISSIONS_KEY, JSON.stringify(['multitable:manage-schema']))
    const root = mountView()
    await flushUi()

    const open = root.querySelector<HTMLButtonElement>('[data-testid="template-create-open"]')
    expect(open).not.toBeNull()
    open!.click()
    await flushUi()

    expect(mocks.listBases).toHaveBeenCalledTimes(1)
    const form = root.querySelector('[data-testid="template-create-form"]')
    expect(form).not.toBeNull()
    // 未选 Base / 未填名字 → 提交禁用
    const submit = root.querySelector<HTMLButtonElement>('[data-testid="template-create-submit"]')
    expect(submit!.disabled).toBe(true)

    const select = root.querySelector<HTMLSelectElement>('[data-testid="template-create-base"]')!
    setValue(select, 'base_ops')
    await flushUi()
    const name = root.querySelector<HTMLInputElement>('[data-testid="template-create-name"]')!
    expect(name.value).toBe('运营库')
    expect(root.querySelector<HTMLButtonElement>('[data-testid="template-create-submit"]')!.disabled).toBe(false)

    // 名字清空 → 又不可提交(只有 Base 不够)
    setValue(name, '   ')
    await flushUi()
    expect(root.querySelector<HTMLButtonElement>('[data-testid="template-create-submit"]')!.disabled).toBe(true)
  })

  it('提交后调用 createTemplateFromBase、展示降级 warnings、并强制刷新模板列表', async () => {
    localStorage.setItem(USER_PERMISSIONS_KEY, JSON.stringify(['multitable:manage-schema']))
    mocks.createTemplateFromBase.mockResolvedValue({
      template: makeTemplate({ id: 'mtpl_abc', name: '订单模板', custom: true }),
      warnings: ['字段「关联客户」是 link 类型,依赖当前 Base 的其它表/字段,模板里已转为文本列。'],
    })
    const root = mountView()
    await flushUi()
    root.querySelector<HTMLButtonElement>('[data-testid="template-create-open"]')!.click()
    await flushUi()

    setValue(root.querySelector<HTMLSelectElement>('[data-testid="template-create-base"]')!, 'base_ops')
    await flushUi()
    setValue(root.querySelector<HTMLInputElement>('[data-testid="template-create-name"]')!, '订单模板')
    setValue(root.querySelector<HTMLInputElement>('[data-testid="template-create-description"]')!, '订单跟进')
    setValue(root.querySelector<HTMLInputElement>('[data-testid="template-create-category"]')!, '运营')
    await flushUi()

    mocks.listTemplates.mockResolvedValue({
      templates: [makeTemplate({ id: 'mtpl_abc', name: '订单模板', custom: true })],
    })
    root.querySelector<HTMLButtonElement>('[data-testid="template-create-submit"]')!.click()
    await flushUi(10)

    expect(mocks.createTemplateFromBase).toHaveBeenCalledWith({
      baseId: 'base_ops',
      name: '订单模板',
      description: '订单跟进',
      category: '运营',
    })
    // 列表强制刷新(否则客户端缓存会让刚建的模板不出现)
    expect(mocks.listTemplates).toHaveBeenLastCalledWith({ force: true })
    const warnings = root.querySelector('[data-testid="template-create-warnings"]')
    expect(warnings?.textContent).toContain('关联客户')
    expect(root.querySelector('[data-testid="template-create-notice"]')?.textContent).toContain('订单模板')
  })

  it('创建失败时把服务端错误显示出来,且不刷新列表', async () => {
    localStorage.setItem(USER_PERMISSIONS_KEY, JSON.stringify(['multitable:manage-schema']))
    mocks.createTemplateFromBase.mockRejectedValue(new Error('Saving a base as a template requires schema authority'))
    const root = mountView()
    await flushUi()
    root.querySelector<HTMLButtonElement>('[data-testid="template-create-open"]')!.click()
    await flushUi()
    setValue(root.querySelector<HTMLSelectElement>('[data-testid="template-create-base"]')!, 'base_ops')
    await flushUi()

    const callsBefore = mocks.listTemplates.mock.calls.length
    root.querySelector<HTMLButtonElement>('[data-testid="template-create-submit"]')!.click()
    await flushUi(10)

    expect(root.querySelector('[data-testid="template-create-error"]')?.textContent).toContain('schema authority')
    expect(mocks.listTemplates.mock.calls.length).toBe(callsBefore)
  })

  it('自定义模板卡片带「自定义」角标与删除入口;内置模板没有', async () => {
    localStorage.setItem(USER_PERMISSIONS_KEY, JSON.stringify(['multitable:manage-schema']))
    mocks.listTemplates.mockResolvedValue({
      templates: [
        makeTemplate({ id: 'mtpl_abc', name: '订单模板', custom: true }),
        makeTemplate({ id: 'project-tracker', name: 'Project Tracker' }),
      ],
    })
    mocks.deleteTemplate.mockResolvedValue({ templateId: 'mtpl_abc' })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    const root = mountView()
    await flushUi()

    const customCard = root.querySelector<HTMLElement>('[data-template-id="mtpl_abc"]')!
    const builtinCard = root.querySelector<HTMLElement>('[data-template-id="project-tracker"]')!
    expect(customCard.querySelector('[data-testid="template-card-custom-badge"]')?.textContent?.trim()).toBe('自定义')
    expect(builtinCard.querySelector('[data-testid="template-card-custom-badge"]')).toBeNull()
    expect(customCard.querySelector('[data-testid="template-card-delete"]')).not.toBeNull()
    expect(builtinCard.querySelector('[data-testid="template-card-delete"]')).toBeNull()

    customCard.querySelector<HTMLButtonElement>('[data-testid="template-card-delete"]')!.click()
    await flushUi(10)

    expect(confirmSpy).toHaveBeenCalled()
    expect(mocks.deleteTemplate).toHaveBeenCalledWith('mtpl_abc')
    expect(mocks.listTemplates).toHaveBeenLastCalledWith({ force: true })
    confirmSpy.mockRestore()
  })

  it('没有 manage-schema 时自定义模板也不给删除入口', async () => {
    mocks.listTemplates.mockResolvedValue({
      templates: [makeTemplate({ id: 'mtpl_abc', name: '订单模板', custom: true })],
    })
    const root = mountView()
    await flushUi()
    expect(root.querySelector('[data-testid="template-card-custom-badge"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="template-card-delete"]')).toBeNull()
  })
})
