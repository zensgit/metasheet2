import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaCellEditor from '../src/multitable/components/cells/MetaCellEditor.vue'
import MetaCellRenderer from '../src/multitable/components/cells/MetaCellRenderer.vue'
import MetaFieldManager from '../src/multitable/components/MetaFieldManager.vue'
import MetaFormView from '../src/multitable/components/MetaFormView.vue'
import {
  DEFAULT_DURATION_FORMAT,
  DURATION_FORMATS,
  durationSecondsFromInput,
  formatDurationValue,
  resolveDurationFieldProperty,
} from '../src/multitable/utils/field-config'
import { formatFieldDisplay } from '../src/multitable/utils/field-display'

async function flushUi(cycles = 3) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('duration field — format/parse helpers (seconds-backed)', () => {
  it('exposes the two supported formats with h:mm default', () => {
    expect(DURATION_FORMATS).toEqual(['h:mm', 'mm:ss'])
    expect(DEFAULT_DURATION_FORMAT).toBe('h:mm')
  })

  it('resolveDurationFieldProperty clamps junk to the default format', () => {
    expect(resolveDurationFieldProperty({ durationFormat: 'mm:ss' }).durationFormat).toBe('mm:ss')
    expect(resolveDurationFieldProperty({ durationFormat: 'h:mm:ss' }).durationFormat).toBe('h:mm')
    expect(resolveDurationFieldProperty({}).durationFormat).toBe('h:mm')
    expect(resolveDurationFieldProperty(undefined).durationFormat).toBe('h:mm')
  })

  it('formats h:mm — truncates leftover seconds, unbounded hours, zero-padded minutes', () => {
    expect(formatDurationValue(5400, 'h:mm')).toBe('1:30')
    expect(formatDurationValue(5430, 'h:mm')).toBe('1:30') // leftover 30s truncated, never rounded up
    expect(formatDurationValue(0, 'h:mm')).toBe('0:00')
    expect(formatDurationValue(540, 'h:mm')).toBe('0:09') // 9 minutes → zero-padded
    expect(formatDurationValue(91 * 3600, 'h:mm')).toBe('91:00') // hours unbounded
  })

  it('formats mm:ss — unbounded minutes, zero-padded seconds', () => {
    expect(formatDurationValue(90, 'mm:ss')).toBe('1:30')
    expect(formatDurationValue(5, 'mm:ss')).toBe('0:05')
    expect(formatDurationValue(5400, 'mm:ss')).toBe('90:00') // 90 minutes, minutes unbounded
  })

  it('parses h:mm to seconds (round-trip with format)', () => {
    expect(durationSecondsFromInput('1:30', 'h:mm')).toBe(5400)
    expect(durationSecondsFromInput('0:09', 'h:mm')).toBe(540)
    expect(durationSecondsFromInput('25:30', 'h:mm')).toBe(25 * 3600 + 30 * 60)
  })

  it('parses mm:ss to seconds', () => {
    expect(durationSecondsFromInput('1:30', 'mm:ss')).toBe(90)
    expect(durationSecondsFromInput('90:00', 'mm:ss')).toBe(5400)
  })

  it('treats a bare number as the leading unit', () => {
    expect(durationSecondsFromInput('2', 'h:mm')).toBe(7200) // 2 hours
    expect(durationSecondsFromInput('2', 'mm:ss')).toBe(120) // 2 minutes
  })

  it('carries over a trailing value >= 60 (lenient) rather than rejecting it', () => {
    expect(durationSecondsFromInput('1:90', 'h:mm')).toBe(3600 + 90 * 60)
    expect(durationSecondsFromInput('0:75', 'mm:ss')).toBe(75)
  })

  it('returns null for empty, negative, or invalid input', () => {
    expect(durationSecondsFromInput('', 'h:mm')).toBeNull()
    expect(durationSecondsFromInput('   ', 'h:mm')).toBeNull()
    expect(durationSecondsFromInput('-1:30', 'h:mm')).toBeNull()
    expect(durationSecondsFromInput('abc', 'h:mm')).toBeNull()
    expect(durationSecondsFromInput('1:2:3', 'h:mm')).toBeNull()
  })
})

describe('duration field — display formatting', () => {
  it('formatFieldDisplay renders seconds in the field format', () => {
    expect(formatFieldDisplay({
      field: { id: 'fld_dur', name: 'Spent', type: 'duration', property: { durationFormat: 'h:mm' } },
      value: 5400,
    })).toBe('1:30')
    expect(formatFieldDisplay({
      field: { id: 'fld_dur', name: 'Lap', type: 'duration', property: { durationFormat: 'mm:ss' } },
      value: 90,
    })).toBe('1:30')
  })

  it('formatFieldDisplay defaults to h:mm when format property is absent', () => {
    expect(formatFieldDisplay({
      field: { id: 'fld_dur', name: 'Spent', type: 'duration', property: {} },
      value: 3661,
    })).toBe('1:01')
  })

  it('renders a duration cell as formatted text', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({
      render() {
        return h(MetaCellRenderer, {
          field: { id: 'fld_dur', name: 'Spent', type: 'duration', property: { durationFormat: 'h:mm' } },
          value: 5400,
        })
      },
    })
    app.mount(container)
    await flushUi()
    expect(container.textContent).toContain('1:30')
    app.unmount()
    container.remove()
  })
})

describe('duration field — cell editor parses to seconds', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('emits parsed seconds (type 1:30 → 5400) and confirms on Enter', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()
    const confirmSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaCellEditor, {
          field: { id: 'fld_dur', name: 'Spent', type: 'duration', property: { durationFormat: 'h:mm' } },
          modelValue: null,
          'onUpdate:modelValue': updateSpy,
          onConfirm: confirmSpy,
          onCancel: vi.fn(),
          onOpenLinkPicker: vi.fn(),
          onOpenPersonPicker: vi.fn(),
        })
      },
    })

    app.mount(container)
    await flushUi()

    const input = container.querySelector('input[type="text"]') as HTMLInputElement | null
    expect(input).not.toBeNull()
    input!.value = '1:30'
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushUi()

    expect(updateSpy).toHaveBeenCalledWith(5400)
    expect(confirmSpy).toHaveBeenCalledTimes(1)

    app.unmount()
    container.remove()
  })

  it('seeds the input buffer from an existing seconds value', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaCellEditor, {
          field: { id: 'fld_dur', name: 'Spent', type: 'duration', property: { durationFormat: 'mm:ss' } },
          modelValue: 90,
          'onUpdate:modelValue': vi.fn(),
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
          onOpenLinkPicker: vi.fn(),
          onOpenPersonPicker: vi.fn(),
        })
      },
    })

    app.mount(container)
    await flushUi()

    const input = container.querySelector('input[type="text"]') as HTMLInputElement | null
    expect(input).not.toBeNull()
    expect(input!.value).toBe('1:30')

    app.unmount()
    container.remove()
  })
})

describe('duration field — field manager create + reopen', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('creates a duration field with the chosen durationFormat property', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const createSpy = vi.fn()

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
    expect(Array.from(typeSelect.options).map((option) => option.value)).toContain('duration')

    nameInput.value = 'Time spent'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    typeSelect.value = 'duration'
    typeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    const formatSelect = container.querySelector('.meta-field-mgr__config .meta-field-mgr__select') as HTMLSelectElement
    expect(formatSelect).not.toBeNull()
    formatSelect.value = 'mm:ss'
    formatSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('+ Add'))
      ?.click()
    await flushUi()

    expect(createSpy).toHaveBeenCalledWith({
      sheetId: 'sheet_1',
      name: 'Time spent',
      type: 'duration',
      property: { durationFormat: 'mm:ss' },
    })

    app.unmount()
    container.remove()
  })

  it('reopening an existing duration field hydrates the stored format', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaFieldManager, {
          visible: true,
          sheetId: 'sheet_1',
          sheets: [],
          fields: [
            { id: 'fld_dur', name: 'Lap', type: 'duration', property: { durationFormat: 'mm:ss' } },
          ],
          onUpdateField: updateSpy,
        })
      },
    })

    app.mount(container)
    await flushUi()

    ;(container.querySelector('.meta-field-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await flushUi()

    const formatSelect = container.querySelector('.meta-field-mgr__config .meta-field-mgr__select') as HTMLSelectElement
    expect(formatSelect).not.toBeNull()
    expect(formatSelect.value).toBe('mm:ss')

    app.unmount()
    container.remove()
  })
})

describe('duration field — form view submits seconds', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('parses h:mm text into seconds on change', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const submitSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaFormView, {
          fields: [{ id: 'fld_dur', name: 'Spent', type: 'duration', property: { durationFormat: 'h:mm' } }],
          record: { id: 'rec_1', version: 1, data: { fld_dur: null } },
          loading: false,
          readOnly: false,
          onSubmit: submitSpy,
        })
      },
    })

    app.mount(container)
    await flushUi()

    const input = container.querySelector('input[type="text"]') as HTMLInputElement | null
    expect(input).not.toBeNull()
    input!.value = '2:15'
    input!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    const form = container.querySelector('form') as HTMLFormElement | null
    form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushUi()

    expect(submitSpy).toHaveBeenCalledTimes(1)
    const submitted = submitSpy.mock.calls[0][0] as Record<string, unknown>
    expect(submitted.fld_dur).toBe(2 * 3600 + 15 * 60)

    app.unmount()
    container.remove()
  })
})
