// 客户反馈 2026-09-24 #4b（自动化条件按字段类型编辑），裁定见 PR #6074 — ConditionValueInput.vue, the ONE typed
// value control shared by the rule-level condition rows and the condition_branch rows. Every case asserts
// the SHAPE of what the control emits, because that is exactly what the rule is saved with.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import ConditionValueInput from '../src/multitable/components/ConditionValueInput.vue'
import { useLocale } from '../src/composables/useLocale'
import { resetBusinessTimezone } from '../src/multitable/utils/business-timezone'
import type { ConditionFieldLike } from '../src/multitable/utils/automation-condition-values'
import type { ConditionOperator } from '../src/multitable/types'
import { epOptions, epSelectValue, epSelectValues, epSetSelect } from './helpers/epControls'

// The person / record pickers are the EXISTING grid pickers (MetaPersonPicker / MetaLinkPicker); they talk to
// the API themselves, so they are stubbed here and the stub records what the control handed them.
const pickerProps = vi.hoisted(() => ({ person: null as Record<string, unknown> | null, link: null as Record<string, unknown> | null }))
vi.mock('../src/multitable/components/MetaPersonPicker.vue', async () => {
  const { defineComponent: define, h: render } = await import('vue')
  return {
    default: define({
      name: 'MetaPersonPickerStub',
      props: ['visible', 'field', 'sheetId', 'currentValue', 'currentSummaries'],
      emits: ['close', 'confirm'],
      setup(props, { emit }) {
        return () => {
          if (!props.visible) return null
          pickerProps.person = { ...props }
          return render('button', {
            type: 'button',
            'data-stub-person-confirm': '',
            onClick: () => emit('confirm', {
              userIds: ['user_1', 'user_2'],
              summaries: [{ id: 'user_1', display: 'Lin Lan' }, { id: 'user_2', display: 'Wang Wu' }],
            }),
          }, 'confirm')
        }
      },
    }),
  }
})
vi.mock('../src/multitable/components/MetaLinkPicker.vue', async () => {
  const { defineComponent: define, h: render } = await import('vue')
  return {
    default: define({
      name: 'MetaLinkPickerStub',
      props: ['visible', 'field', 'currentValue', 'selectionMode'],
      emits: ['close', 'confirm'],
      setup(props, { emit }) {
        return () => {
          if (!props.visible) return null
          pickerProps.link = { ...props }
          return render('button', {
            type: 'button',
            'data-stub-link-confirm': '',
            onClick: () => emit('confirm', { recordIds: ['rec_9'], summaries: [{ id: 'rec_9', display: 'Project Nine' }] }),
          }, 'confirm')
        }
      },
    }),
  }
})

function flush() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => nextTick())
}

type MountOptions = {
  field: ConditionFieldLike | null
  operator: ConditionOperator
  value?: unknown
  pending?: boolean
}

// Mounts the control under a parent that owns the value (like the editor row does), so the emitted value
// flows back in as `modelValue` exactly as it does in the real editor.
function mountInput(options: MountOptions) {
  const value = ref<unknown>(options.value ?? '')
  const emitted: unknown[] = []
  const container = document.createElement('div')
  document.body.appendChild(container)
  const Host = defineComponent({
    setup() {
      return () => h(ConditionValueInput, {
        modelValue: value.value,
        operator: options.operator,
        field: options.field,
        pending: options.pending ?? false,
        sheetId: 'sheet_1',
        'onUpdate:modelValue': (next: unknown) => {
          emitted.push(next)
          value.value = next
        },
      })
    },
  })
  const app = createApp(Host)
  app.mount(container)
  return { container, value, emitted, app }
}

function typeInto(input: HTMLInputElement, text: string) {
  input.value = text
  input.dispatchEvent(new Event('input'))
}

const numberField: ConditionFieldLike = { id: 'fld_score', name: 'Score', type: 'number' }
const boolField: ConditionFieldLike = { id: 'fld_done', name: 'Done', type: 'boolean' }
const dateField: ConditionFieldLike = { id: 'fld_due', name: 'Due', type: 'date' }
const dateTimeField: ConditionFieldLike = { id: 'fld_start', name: 'Start', type: 'dateTime' }
const selectField: ConditionFieldLike = { id: 'fld_status', name: 'Status', type: 'select', options: [{ value: 'todo', label: 'To do' }, { value: 'done', label: 'Done' }] }
const personField: ConditionFieldLike = { id: 'fld_owner', name: 'Owner', type: 'person', property: { limitSingleRecord: true } }
const linkField: ConditionFieldLike = { id: 'fld_project', name: 'Project', type: 'link', property: { foreignSheetId: 'sheet_projects' } }

// Explicit per-test timeout: the first Element Plus select / date picker mounted in a worker is the slow one
// (~0.9s idle, well past 5s on a loaded shared CI runner). The global testTimeout stays 5s elsewhere.
const EP_MOUNT_TIMEOUT_MS = 30_000

beforeEach(() => {
  useLocale().setLocale('zh-CN')
  pickerProps.person = null
  pickerProps.link = null
})
afterEach(() => {
  document.body.innerHTML = ''
  resetBusinessTimezone()
  useLocale().setLocale('en')
})

describe('ConditionValueInput — pending (no field yet)', () => {
  it('renders ONE disabled box asking for a field first, and emits nothing', async () => {
    const { container, emitted } = mountInput({ field: null, operator: '' as ConditionOperator, pending: true })
    await flush()
    const input = container.querySelector('[data-condition-value="pending"]') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.disabled).toBe(true)
    expect(input.placeholder).toBe('请先选择字段')
    expect(container.querySelectorAll('input').length).toBe(1)
    expect(emitted).toEqual([])
  }, EP_MOUNT_TIMEOUT_MS)
})

describe('ConditionValueInput — emitted value shape per widget', () => {
  it('number → a number (a half-typed draft is emitted as typed, so the row stays incomplete)', async () => {
    const { container, emitted } = mountInput({ field: numberField, operator: 'greater_than' })
    await flush()
    const input = container.querySelector('[data-condition-value="number"]') as HTMLInputElement
    expect(input.type).toBe('number')
    typeInto(input, '42.5')
    await flush()
    expect(emitted.at(-1)).toBe(42.5)
    expect(typeof emitted.at(-1)).toBe('number')
    typeInto(input, '')
    await flush()
    expect(emitted.at(-1)).toBe('')
  }, EP_MOUNT_TIMEOUT_MS)

  it('boolean → true / false, with the options labelled 是 / 否 (never the raw true / false)', async () => {
    const { container, emitted } = mountInput({ field: boolField, operator: 'equals' })
    await flush()
    const select = container.querySelector('[data-condition-value="boolean"]') as HTMLElement
    const labels = epOptions(select).map((option) => ({ value: option.value, text: option.textContent?.trim() }))
    expect(labels).toEqual([
      { value: '', text: '-- 值 --' },
      { value: 'true', text: '是' },
      { value: 'false', text: '否' },
    ])
    epSetSelect(select, 'false')
    await flush()
    expect(emitted.at(-1)).toBe(false)
    expect(epSelectValue(select)).toBe('false')
    epSetSelect(select, 'true')
    await flush()
    expect(emitted.at(-1)).toBe(true)
  }, EP_MOUNT_TIMEOUT_MS)

  it('boolean `in` → boolean[] from a 是 / 否 multi-select', async () => {
    const { container, emitted } = mountInput({ field: boolField, operator: 'in' })
    await flush()
    const select = container.querySelector('[data-condition-value="boolean-multi-select"]') as HTMLElement
    expect(epOptions(select).map((option) => option.textContent?.trim())).toEqual(['是', '否'])
    epSetSelect(select, 'true')
    await flush()
    epSetSelect(select, 'false')
    await flush()
    expect(emitted.at(-1)).toEqual([true, false])
    expect(epSelectValues(select)).toEqual(['true', 'false'])
  }, EP_MOUNT_TIMEOUT_MS)

  it("date → an Element Plus date picker whose value is 'YYYY-MM-DD'", async () => {
    const { container, emitted } = mountInput({ field: dateField, operator: 'less_than' })
    await flush()
    const input = container.querySelector('[data-condition-value="date"] input') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.type).toBe('text') // not the native type=date box any more
    expect(container.querySelector('.el-date-editor')).toBeTruthy()
    typeInto(input, '2026-05-11')
    input.dispatchEvent(new Event('change'))
    await flush()
    expect(emitted.at(-1)).toBe('2026-05-11')
  }, EP_MOUNT_TIMEOUT_MS)

  it("date: a LOADED value that names its zone shows the day the evaluator reads (its day in the field's zone), not the day as written", async () => {
    // Asia/Shanghai: '2026-09-23T16:00:00.000Z' is 2026-09-24 00:00 — the backend's dayKeyOf reads the 24th.
    const { container, emitted } = mountInput({ field: dateField, operator: 'less_than', value: '2026-09-23T16:00:00.000Z' })
    await flush()
    const input = container.querySelector('[data-condition-value="date"] input') as HTMLInputElement
    expect(input.value).toBe('2026-09-24')
    expect(emitted).toEqual([]) // shown, not rewritten: the save path converts it (coerceConditionValue)
  }, EP_MOUNT_TIMEOUT_MS)

  it('date-time → the #6083 business-timezone wall clock, stored as a UTC ISO instant', async () => {
    const { container, emitted, value } = mountInput({ field: dateTimeField, operator: 'greater_than' })
    await flush()
    const input = container.querySelector('[data-condition-value="date-time"]') as HTMLInputElement
    expect(input.type).toBe('text') // not <input type="datetime-local">
    expect(container.querySelector('[data-meta-datetime-picker-trigger]')).toBeTruthy() // the shared picker beside it
    typeInto(input, '2026-09-24 09:30')
    await flush()
    // Business timezone Asia/Shanghai (UTC+8), whatever the browser's zone is.
    expect(emitted.at(-1)).toBe('2026-09-24T01:30:00.000Z')
    expect(value.value).toBe('2026-09-24T01:30:00.000Z')
    expect(input.value).toBe('2026-09-24 09:30') // the box keeps the wall clock
  }, EP_MOUNT_TIMEOUT_MS)

  it('date-time: a stored UTC instant is shown as the business wall clock; garbage is flagged, emitted as typed', async () => {
    const { container, emitted } = mountInput({ field: dateTimeField, operator: 'equals', value: '2026-09-24T01:30:00.000Z' })
    await flush()
    const input = container.querySelector('[data-condition-value="date-time"]') as HTMLInputElement
    expect(input.value).toBe('2026-09-24 09:30')
    typeInto(input, '2026-09-24 25:99')
    input.dispatchEvent(new Event('blur'))
    await flush()
    expect(emitted.at(-1)).toBe('2026-09-24 25:99') // not an instant → the row is incomplete, save blocked
    expect(input.value).toBe('2026-09-24 25:99') // never reverted / cleared
    expect(container.querySelector('[data-condition-value-invalid]')).toBeTruthy()
  }, EP_MOUNT_TIMEOUT_MS)

  it('date-time: a LOADED value that names no instant (a bare date from the old text box) is flagged at once, never rewritten', async () => {
    const { container, emitted } = mountInput({ field: dateTimeField, operator: 'greater_than', value: '2026-09-24' })
    await flush()
    const input = container.querySelector('[data-condition-value="date-time"]') as HTMLInputElement
    expect(input.value).toBe('2026-09-24') // kept as typed — not cleared, not silently read as midnight
    expect(container.querySelector('[data-condition-value-invalid]')).toBeTruthy() // no focus / blur needed
    expect(emitted).toEqual([])
  }, EP_MOUNT_TIMEOUT_MS)

  it('select → the option value; select `in` → string[]', async () => {
    const single = mountInput({ field: selectField, operator: 'equals' })
    await flush()
    const select = single.container.querySelector('[data-condition-value="select"]') as HTMLElement
    epSetSelect(select, 'done')
    await flush()
    expect(single.emitted.at(-1)).toBe('done')

    const list = mountInput({ field: selectField, operator: 'in' })
    await flush()
    const multi = list.container.querySelector('[data-condition-value="multi-select"]') as HTMLElement
    epSetSelect(multi, 'todo')
    await flush()
    epSetSelect(multi, 'done')
    await flush()
    expect(list.emitted.at(-1)).toEqual(['todo', 'done'])
  }, EP_MOUNT_TIMEOUT_MS)

  it('person → string[] of user ids from the existing person picker (multi-select for `in`)', async () => {
    const { container, emitted } = mountInput({ field: personField, operator: 'in' })
    await flush()
    const pick = container.querySelector('[data-action="pick-condition-person"]') as HTMLButtonElement
    expect(pick.textContent?.trim()).toBe('选择人员')
    pick.click()
    await flush()
    // The picker is the field's own directory picker: this sheet + this field, forced multi-select for `in`.
    expect(pickerProps.person?.sheetId).toBe('sheet_1')
    expect((pickerProps.person?.field as { id: string }).id).toBe('fld_owner')
    expect((pickerProps.person?.field as { property: Record<string, unknown> }).property.limitSingleRecord).toBe(false)
    ;(container.querySelector('[data-stub-person-confirm]') as HTMLButtonElement).click()
    await flush()
    expect(emitted.at(-1)).toEqual(['user_1', 'user_2'])
    // Chips show the picked names; removing one emits the remaining ids.
    const chips = Array.from(container.querySelectorAll('[data-condition-value-id]')).map((chip) => chip.textContent?.replace('×', '').trim())
    expect(chips).toEqual(['Lin Lan', 'Wang Wu'])
    ;(container.querySelector('[data-condition-value-id="user_1"] button') as HTMLButtonElement).click()
    await flush()
    expect(emitted.at(-1)).toEqual(['user_2'])
  }, EP_MOUNT_TIMEOUT_MS)

  it('person `equals` is single-pick whatever the field cap, and saves ONE user id string (the backend-validated shape)', async () => {
    const multiPersonField: ConditionFieldLike = { ...personField, property: { limitSingleRecord: false } }
    const { container, emitted } = mountInput({ field: multiPersonField, operator: 'equals' })
    await flush()
    ;(container.querySelector('[data-action="pick-condition-person"]') as HTMLButtonElement).click()
    await flush()
    expect((pickerProps.person?.field as { property: Record<string, unknown> }).property.limitSingleRecord).toBe(true)
    ;(container.querySelector('[data-stub-person-confirm]') as HTMLButtonElement).click()
    await flush()
    expect(emitted.at(-1)).toBe('user_1')
    expect(Array.from(container.querySelectorAll('[data-condition-value-id]')).map((chip) => chip.getAttribute('data-condition-value-id'))).toEqual(['user_1'])
    ;(container.querySelector('[data-condition-value-id="user_1"] button') as HTMLButtonElement).click()
    await flush()
    expect(emitted.at(-1)).toBe('')
  }, EP_MOUNT_TIMEOUT_MS)

  it('link `equals` → ONE record id string from the existing record picker', async () => {
    const { container, emitted } = mountInput({ field: linkField, operator: 'equals' })
    await flush()
    const pick = container.querySelector('[data-action="pick-condition-record"]') as HTMLButtonElement
    expect(pick.textContent?.trim()).toBe('选择记录')
    pick.click()
    await flush()
    expect((pickerProps.link?.field as { id: string }).id).toBe('fld_project')
    expect((pickerProps.link?.field as { property: Record<string, unknown> }).property.limitSingleRecord).toBe(true)
    expect(pickerProps.link?.selectionMode).toBe('single')
    ;(container.querySelector('[data-stub-link-confirm]') as HTMLButtonElement).click()
    await flush()
    expect(emitted.at(-1)).toBe('rec_9')
    expect(container.querySelector('[data-condition-value-id="rec_9"]')?.textContent).toContain('Project Nine')
  }, EP_MOUNT_TIMEOUT_MS)

  it('a LEGACY link-backed person (link + refKind user): the record picker, labelled 选择人员, multi-pick for `in`', async () => {
    // ensurePeopleSheetPreset fields: type link + refKind user; values are people-sheet record ids. The record
    // picker is single-select for refKind user by default, so the condition hands it the operator's cap.
    const legacyPerson: ConditionFieldLike = { id: 'fld_lead', name: '负责人', type: 'link', property: { refKind: 'user', foreignSheetId: 'sheet_people', limitSingleRecord: true } }
    const list = mountInput({ field: legacyPerson, operator: 'in' })
    await flush()
    const pick = list.container.querySelector('[data-action="pick-condition-record"]') as HTMLButtonElement
    expect(pick.textContent?.trim()).toBe('选择人员')
    pick.click()
    await flush()
    expect(pickerProps.link?.selectionMode).toBe('multiple')
    // refKind stays, so the picker's own title / search copy read 人员.
    expect((pickerProps.link?.field as { property: Record<string, unknown> }).property.refKind).toBe('user')
    list.app.unmount()

    pickerProps.link = null
    const single = mountInput({ field: legacyPerson, operator: 'not_equals' })
    await flush()
    ;(single.container.querySelector('[data-action="pick-condition-record"]') as HTMLButtonElement).click()
    await flush()
    expect(pickerProps.link?.selectionMode).toBe('single')
  }, EP_MOUNT_TIMEOUT_MS)

  it('`in` on a number / date / text field is a comma-separated text box (the save path coerces each entry)', async () => {
    const { container, emitted } = mountInput({ field: numberField, operator: 'in', value: [1, 2] })
    await flush()
    const input = container.querySelector('[data-condition-value="text-list"]') as HTMLInputElement
    expect(input.value).toBe('1, 2')
    expect(input.placeholder).toBe('逗号分隔的值')
    typeInto(input, '1, 2, 3')
    await flush()
    expect(emitted.at(-1)).toBe('1, 2, 3')
  }, EP_MOUNT_TIMEOUT_MS)
})
