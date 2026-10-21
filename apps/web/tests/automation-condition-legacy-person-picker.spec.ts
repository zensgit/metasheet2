// 客户反馈 2026-09-24 #4b（自动化条件按字段类型编辑），裁定见 PR #6074 — a LEGACY person field (stored as
// `type: 'link'` + `property.refKind: 'user'`, produced by ensurePeopleSheetPreset) in an automation condition.
// Its values are people-sheet RECORD ids, so ConditionValueInput opens the REAL record picker (MetaLinkPicker,
// not stubbed here), which is single-select for `refKind: 'user'` by default. `负责人 属于 [张三, 李四]` must
// still be authorable: for `in` / `not_in` the picker takes the operator's cap and keeps both picks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import ConditionValueInput from '../src/multitable/components/ConditionValueInput.vue'
import MetaLinkPicker from '../src/multitable/components/MetaLinkPicker.vue'
import { useLocale } from '../src/composables/useLocale'
import type { ConditionFieldLike } from '../src/multitable/utils/automation-condition-values'
import type { ConditionOperator, MetaField } from '../src/multitable/types'

const { mockListLinkOptions } = vi.hoisted(() => ({ mockListLinkOptions: vi.fn() }))

vi.mock('../src/multitable/api/client', () => ({
  multitableClient: {
    listLinkOptions: mockListLinkOptions,
  },
}))

const legacyPerson: ConditionFieldLike = {
  id: 'fld_lead',
  name: '负责人',
  type: 'link',
  property: { refKind: 'user', foreignSheetId: 'sheet_people', limitSingleRecord: true },
}

const PEOPLE = [
  { id: 'rec_zhang', display: '张三' },
  { id: 'rec_li', display: '李四' },
  { id: 'rec_wang', display: '王五' },
]

// Explicit per-test timeout: the first Element Plus control mounted in a worker is the slow one.
const EP_MOUNT_TIMEOUT_MS = 30_000

function flush() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => nextTick())
}

function mountInput(operator: ConditionOperator, initial: unknown = '') {
  const value = ref<unknown>(initial)
  const emitted: unknown[] = []
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(defineComponent({
    setup() {
      return () => h(ConditionValueInput, {
        modelValue: value.value,
        operator,
        field: legacyPerson,
        pending: false,
        sheetId: 'sheet_tasks',
        'onUpdate:modelValue': (next: unknown) => {
          emitted.push(next)
          value.value = next
        },
      })
    },
  }))
  app.mount(container)
  return { container, value, emitted, app }
}

function pickerCheckbox(container: HTMLElement, display: string): HTMLInputElement {
  const item = Array.from(container.querySelectorAll('.meta-link-picker__item'))
    .find((row) => row.textContent?.includes(display))
  const checkbox = item?.querySelector('input[type="checkbox"]') as HTMLInputElement | null
  if (!checkbox) throw new Error(`no picker row for ${display}`)
  return checkbox
}

async function openPicker(container: HTMLElement) {
  const pick = container.querySelector('[data-action="pick-condition-record"]') as HTMLButtonElement
  pick.click()
  await flush()
  await flush()
}

beforeEach(() => {
  useLocale().setLocale('zh-CN')
  mockListLinkOptions.mockReset()
  mockListLinkOptions.mockResolvedValue({
    field: { id: 'fld_lead', name: '负责人', type: 'link' },
    targetSheet: { id: 'sheet_people', baseId: 'base_1', name: '人员' },
    selected: [],
    records: PEOPLE,
    page: { offset: 0, limit: 50, total: PEOPLE.length, hasMore: false },
  })
})

afterEach(() => {
  document.body.innerHTML = ''
  useLocale().setLocale('en')
})

describe('automation condition on a legacy link-backed person field (real record picker)', () => {
  it('`in`: two people can be picked and are saved as a list of their record ids', async () => {
    const { container, emitted, value } = mountInput('in')
    await flush()
    const pick = container.querySelector('[data-action="pick-condition-record"]') as HTMLButtonElement
    expect(pick.textContent?.trim()).toBe('选择人员') // not 选择记录
    await openPicker(container)
    expect(container.querySelector('.meta-link-picker__title')?.textContent).toContain('选择人员')
    pickerCheckbox(container, '张三').click()
    await nextTick()
    pickerCheckbox(container, '李四').click()
    await nextTick()
    // Both stay ticked: the picker did not fall back to single-select for refKind 'user'.
    expect(pickerCheckbox(container, '张三').checked).toBe(true)
    expect(pickerCheckbox(container, '李四').checked).toBe(true)
    ;(container.querySelector('.meta-link-picker__confirm') as HTMLButtonElement).click()
    await flush()
    expect(emitted.at(-1)).toEqual(['rec_zhang', 'rec_li'])
    expect(value.value).toEqual(['rec_zhang', 'rec_li'])
    expect(Array.from(container.querySelectorAll('[data-condition-value-id]')).map((chip) => chip.getAttribute('data-condition-value-id')))
      .toEqual(['rec_zhang', 'rec_li'])

    // Re-opening keeps the list and adds to it (no clear-on-toggle).
    await openPicker(container)
    expect(pickerCheckbox(container, '张三').checked).toBe(true)
    expect(pickerCheckbox(container, '李四').checked).toBe(true)
    pickerCheckbox(container, '王五').click()
    await nextTick()
    ;(container.querySelector('.meta-link-picker__confirm') as HTMLButtonElement).click()
    await flush()
    expect(emitted.at(-1)).toEqual(['rec_zhang', 'rec_li', 'rec_wang'])
  }, EP_MOUNT_TIMEOUT_MS)

  it('`equals`: single-pick — a second pick replaces the first, and ONE record id string is saved', async () => {
    const { container, emitted } = mountInput('equals')
    await flush()
    await openPicker(container)
    pickerCheckbox(container, '张三').click()
    await nextTick()
    pickerCheckbox(container, '李四').click()
    await nextTick()
    expect(pickerCheckbox(container, '张三').checked).toBe(false)
    expect(pickerCheckbox(container, '李四').checked).toBe(true)
    ;(container.querySelector('.meta-link-picker__confirm') as HTMLButtonElement).click()
    await flush()
    expect(emitted.at(-1)).toBe('rec_li')
  }, EP_MOUNT_TIMEOUT_MS)
})

describe('MetaLinkPicker selectionMode', () => {
  function mountPicker(field: MetaField, selectionMode?: 'single' | 'multiple') {
    const onConfirm = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp(defineComponent({
      setup() {
        const visible = ref(false)
        return { visible }
      },
      render() {
        return h(MetaLinkPicker, {
          visible: this.visible,
          field,
          currentValue: [],
          ...(selectionMode ? { selectionMode } : {}),
          onConfirm,
        })
      },
    }))
    const vm = app.mount(container) as unknown as { visible: boolean }
    return { container, vm, onConfirm }
  }

  it('omitted: every existing caller keeps the field-decided cap (a legacy person stays single-select)', async () => {
    const field = { id: 'fld_lead', name: '负责人', type: 'link', property: { refKind: 'user' } } as MetaField
    const { container, vm, onConfirm } = mountPicker(field)
    vm.visible = true
    await flush()
    await flush()
    pickerCheckbox(container, '张三').click()
    await nextTick()
    pickerCheckbox(container, '李四').click()
    await nextTick()
    ;(container.querySelector('.meta-link-picker__confirm') as HTMLButtonElement).click()
    expect(onConfirm.mock.calls.at(-1)?.[0].recordIds).toEqual(['rec_li'])
  }, EP_MOUNT_TIMEOUT_MS)

  it("'single' caps a multi-record link field; 'multiple' lifts a single-record cap", async () => {
    const multiLink = { id: 'fld_team', name: 'Team', type: 'link', property: { limitSingleRecord: false } } as MetaField
    const capped = mountPicker(multiLink, 'single')
    capped.vm.visible = true
    await flush()
    await flush()
    pickerCheckbox(capped.container, '张三').click()
    await nextTick()
    pickerCheckbox(capped.container, '李四').click()
    await nextTick()
    ;(capped.container.querySelector('.meta-link-picker__confirm') as HTMLButtonElement).click()
    expect(capped.onConfirm.mock.calls.at(-1)?.[0].recordIds).toEqual(['rec_li'])
    document.body.innerHTML = ''

    const singleLink = { id: 'fld_parent', name: 'Parent', type: 'link', property: { limitSingleRecord: true } } as MetaField
    const lifted = mountPicker(singleLink, 'multiple')
    lifted.vm.visible = true
    await flush()
    await flush()
    pickerCheckbox(lifted.container, '张三').click()
    await nextTick()
    pickerCheckbox(lifted.container, '李四').click()
    await nextTick()
    ;(lifted.container.querySelector('.meta-link-picker__confirm') as HTMLButtonElement).click()
    expect(lifted.onConfirm.mock.calls.at(-1)?.[0].recordIds).toEqual(['rec_zhang', 'rec_li'])
  }, EP_MOUNT_TIMEOUT_MS)
})
