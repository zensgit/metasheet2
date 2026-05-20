import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import MetaLinkPicker from '../src/multitable/components/MetaLinkPicker.vue'

const { mockListLinkOptions } = vi.hoisted(() => ({
  mockListLinkOptions: vi.fn(),
}))

vi.mock('../src/multitable/api/client', () => ({
  multitableClient: {
    listLinkOptions: mockListLinkOptions,
  },
}))

const linkField = {
  id: 'fld_vendor',
  name: 'Vendor',
  type: 'link',
}

const personField = {
  id: 'fld_owner',
  name: 'Owner',
  type: 'link',
  property: {
    refKind: 'user',
    limitSingleRecord: true,
  },
}

let app: App<Element> | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  mockListLinkOptions.mockReset()
  useLocale().setLocale('en')
})

async function flushUi(cycles = 4): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

async function mountPicker(props: Record<string, unknown> = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)

  const Harness = defineComponent({
    setup() {
      const visible = ref(false)
      return {
        visible,
        onClose: () => {
          visible.value = false
        },
      }
    },
    render() {
      return h(MetaLinkPicker, {
        visible: this.visible,
        field: linkField,
        currentValue: [],
        onClose: this.onClose,
        onConfirm: vi.fn(),
        ...props,
      })
    },
  })

  app = createApp(Harness)
  const vm = app.mount(container) as { visible: boolean }
  vm.visible = true
  await flushUi()
  return container
}

describe('MetaLinkPicker i18n', () => {
  it('renders zh-CN record-link chrome and preserves linked record display values raw', async () => {
    useLocale().setLocale('zh-CN')
    mockListLinkOptions.mockResolvedValue({
      field: linkField,
      targetSheet: { id: 'sheet_vendors', baseId: 'base_1', name: 'Vendors' },
      selected: [{ id: 'vendor_1', display: 'Acme Supply' }],
      records: [
        { id: 'vendor_1', display: 'Acme Supply' },
        { id: 'vendor_2', display: 'Beacon Labs' },
      ],
      page: { offset: 0, limit: 50, total: 2, hasMore: true },
    })

    const root = await mountPicker({ currentValue: ['vendor_1'] })
    const text = root.textContent ?? ''

    expect(text).toContain('选择关联记录 — Vendor')
    expect(root.querySelector<HTMLInputElement>('.meta-link-picker__input')?.getAttribute('placeholder')).toBe('搜索记录...')
    expect(root.querySelector<HTMLButtonElement>('.meta-link-picker__close')?.getAttribute('aria-label')).toBe('关闭关联记录选择器')
    expect(text).toContain('已选择')
    expect(text).toContain('清除')
    expect(text).toContain('已选择 1 条')
    expect(text).toContain('加载更多')
    expect(text).toContain('取消')
    expect(text).toContain('确认')
    expect(text).toContain('Acme Supply')
    expect(text).toContain('Beacon Labs')
    expect(text).not.toContain('Selected')
    expect(text).not.toContain('Load more')
  })

  it('renders zh-CN person picker title and search placeholder', async () => {
    useLocale().setLocale('zh-CN')
    mockListLinkOptions.mockResolvedValue({
      field: personField,
      targetSheet: { id: 'sheet_people', baseId: 'base_1', name: 'People' },
      selected: [],
      records: [{ id: 'user_1', display: 'Amy' }],
      page: { offset: 0, limit: 50, total: 1, hasMore: false },
    })

    const root = await mountPicker({ field: personField })

    expect(root.textContent ?? '').toContain('选择人员 — Owner')
    expect(root.querySelector<HTMLInputElement>('.meta-link-picker__input')?.getAttribute('placeholder')).toBe('搜索人员...')
  })

  it('renders zh-CN empty and fallback error states', async () => {
    useLocale().setLocale('zh-CN')
    mockListLinkOptions.mockResolvedValueOnce({
      field: linkField,
      targetSheet: { id: 'sheet_vendors', baseId: 'base_1', name: 'Vendors' },
      selected: [],
      records: [],
      page: { offset: 0, limit: 50, total: 0, hasMore: false },
    })

    let root = await mountPicker()
    expect(root.textContent ?? '').toContain('未找到记录')
    app?.unmount()
    container?.remove()
    app = null
    container = null

    mockListLinkOptions.mockRejectedValueOnce({})
    root = await mountPicker()
    expect(root.textContent ?? '').toContain('加载记录失败')
  })

  it('preserves English picker chrome as the default locale regression', async () => {
    useLocale().setLocale('en')
    mockListLinkOptions.mockResolvedValue({
      field: linkField,
      targetSheet: { id: 'sheet_vendors', baseId: 'base_1', name: 'Vendors' },
      selected: [],
      records: [],
      page: { offset: 0, limit: 50, total: 0, hasMore: false },
    })

    const root = await mountPicker()
    const text = root.textContent ?? ''

    expect(text).toContain('Link Records — Vendor')
    expect(root.querySelector<HTMLInputElement>('.meta-link-picker__input')?.getAttribute('placeholder')).toBe('Search records...')
    expect(root.querySelector<HTMLButtonElement>('.meta-link-picker__close')?.getAttribute('aria-label')).toBe('Close link picker')
    expect(text).toContain('No records found')
    expect(text).toContain('0 selected')
    expect(text).toContain('Cancel')
    expect(text).toContain('Confirm')
    expect(text).not.toContain('选择关联记录')
  })
})
