import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaCellEditor from '../src/multitable/components/cells/MetaCellEditor.vue'
import MetaCellRenderer from '../src/multitable/components/cells/MetaCellRenderer.vue'
import MetaFieldManager from '../src/multitable/components/MetaFieldManager.vue'
import MetaFormView from '../src/multitable/components/MetaFormView.vue'
import MetaRecordDrawer from '../src/multitable/components/MetaRecordDrawer.vue'
import {
  dateTimeInputValue,
  dateTimeValueFromLocalInput,
  resolveDateTimeTimezone,
} from '../src/multitable/utils/field-display'

async function flushUi(cycles = 3) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('dateTime field UI', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('normalizes timezone property and local datetime input helpers', () => {
    expect(resolveDateTimeTimezone({ timezone: 'Asia/Shanghai' })).toBe('Asia/Shanghai')
    expect(resolveDateTimeTimezone({ timezone: 'Invalid/Zone' })).toBe('UTC')
    expect(dateTimeInputValue('2026-05-06T02:30:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)

    const iso = dateTimeValueFromLocalInput('2026-05-06T10:30')
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/)
    expect(dateTimeValueFromLocalInput('')).toBeNull()
    expect(dateTimeValueFromLocalInput('not-a-date')).toBeNull()
  })

  it('renders datetime values with a datetime-specific class', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaCellRenderer, {
          field: { id: 'fld_datetime', name: 'Visit time', type: 'dateTime', property: { timezone: 'UTC' } },
          value: '2026-05-06T02:30:00.000Z',
        })
      },
    })

    app.mount(container)
    await flushUi()

    const value = container.querySelector('.meta-cell-renderer__date-time') as HTMLElement | null
    expect(value).not.toBeNull()
    expect(value?.textContent).not.toBe('')

    app.unmount()
    container.remove()
  })

  it('uses a datetime-local cell editor and emits ISO/null values', async () => {
    const updateSpy = vi.fn()
    const confirmSpy = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaCellEditor, {
          field: { id: 'fld_datetime', name: 'Visit time', type: 'dateTime' },
          modelValue: '2026-05-06T02:30:00.000Z',
          'onUpdate:modelValue': updateSpy,
          onConfirm: confirmSpy,
          onCancel: vi.fn(),
          onOpenLinkPicker: vi.fn(),
        })
      },
    })

    app.mount(container)
    await flushUi()

    const input = container.querySelector('input[type="datetime-local"]') as HTMLInputElement | null
    expect(input).not.toBeNull()
    input!.value = '2026-05-06T10:30'
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushUi()

    expect(updateSpy).toHaveBeenCalledWith(expect.stringMatching(/Z$/))
    expect(confirmSpy).toHaveBeenCalledTimes(1)

    input!.value = ''
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    expect(updateSpy).toHaveBeenLastCalledWith(null)

    app.unmount()
    container.remove()
  })

  it('creates dateTime fields from the field manager without configurable property', async () => {
    const createSpy = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaFieldManager, {
          visible: true,
          sheetId: 'sheet_1',
          sheets: [],
          fields: [],
          onCreateField: createSpy,
        })
      },
    })

    app.mount(container)
    await flushUi()

    const nameInput = container.querySelector('.meta-field-mgr__add-row .meta-field-mgr__input') as HTMLInputElement
    const typeSelect = container.querySelector('.meta-field-mgr__add-row .meta-field-mgr__select') as HTMLSelectElement
    expect(Array.from(typeSelect.options).map((option) => option.value)).toContain('dateTime')

    nameInput.value = 'Visit time'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    typeSelect.value = 'dateTime'
    typeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('+ Add'))
      ?.click()
    await flushUi()

    expect(createSpy).toHaveBeenCalledWith({
      sheetId: 'sheet_1',
      name: 'Visit time',
      type: 'dateTime',
    })

    app.unmount()
    container.remove()
  })

  it('submits datetime values from form view', async () => {
    const submitSpy = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaFormView, {
          fields: [{ id: 'fld_datetime', name: 'Visit time', type: 'dateTime' }],
          record: { id: 'rec_1', version: 1, data: { fld_datetime: '2026-05-06T02:30:00.000Z' } },
          loading: false,
          readOnly: false,
          onSubmit: submitSpy,
          onOpenLinkPicker: vi.fn(),
        })
      },
    })

    app.mount(container)
    await flushUi()

    const input = container.querySelector('#field_fld_datetime') as HTMLInputElement | null
    expect(input?.type).toBe('datetime-local')
    input!.value = '2026-05-06T10:30'
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    container.querySelector('form')?.dispatchEvent(new Event('submit'))
    await flushUi()

    expect(submitSpy).toHaveBeenCalledWith({ fld_datetime: expect.stringMatching(/Z$/) })

    app.unmount()
    container.remove()
  })

  it('patches datetime values from the record drawer', async () => {
    const patchSpy = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaRecordDrawer, {
          visible: true,
          record: { id: 'rec_1', version: 1, data: { fld_datetime: '2026-05-06T02:30:00.000Z' } },
          fields: [{ id: 'fld_datetime', name: 'Visit time', type: 'dateTime' }],
          canEdit: true,
          canComment: false,
          canDelete: false,
          onPatch: patchSpy,
        })
      },
    })

    app.mount(container)
    await flushUi()

    const input = container.querySelector('#drawer_field_fld_datetime') as HTMLInputElement | null
    expect(input?.type).toBe('datetime-local')
    input!.value = '2026-05-06T10:30'
    input!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    expect(patchSpy).toHaveBeenCalledWith('fld_datetime', expect.stringMatching(/Z$/))

    app.unmount()
    container.remove()
  })
})
