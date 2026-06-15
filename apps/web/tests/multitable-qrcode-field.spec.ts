import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaCellEditor from '../src/multitable/components/cells/MetaCellEditor.vue'
import MetaCellRenderer from '../src/multitable/components/cells/MetaCellRenderer.vue'
import MetaFieldManager from '../src/multitable/components/MetaFieldManager.vue'
import MetaFormView from '../src/multitable/components/MetaFormView.vue'
import MetaRecordDrawer from '../src/multitable/components/MetaRecordDrawer.vue'
import { qrMatrixFromText, qrSvgFromText } from '../src/multitable/utils/qr-code'

async function flushUi(cycles = 3) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('qr-code encoder adapter', () => {
  it('encodes text into a non-trivial square module matrix of a valid QR size', () => {
    const matrix = qrMatrixFromText('https://metasheet.example/r/1', 'medium')
    // Square.
    expect(matrix.length).toBeGreaterThan(0)
    expect(matrix.every((row) => row.length === matrix.length)).toBe(true)
    // Version 1..40 ⇒ side length 21..177 in steps of 4 (4*ver + 17).
    const side = matrix.length
    expect(side).toBeGreaterThanOrEqual(21)
    expect((side - 21) % 4).toBe(0)
    // A real symbol has both dark and light modules (not all-true/all-false).
    const dark = matrix.flat().filter(Boolean).length
    expect(dark).toBeGreaterThan(0)
    expect(dark).toBeLessThan(side * side)
    // Finder pattern: top-left module is dark for QR codes.
    expect(matrix[0][0]).toBe(true)
  })

  it('renders an <svg> for a value and null for empty input', () => {
    const svg = qrSvgFromText('hello', { size: 80 })
    expect(svg).toContain('<svg')
    expect(svg).toContain('<path')
    expect(qrSvgFromText('')).toBeNull()
    expect(qrSvgFromText('   ')).toBeNull()
  })
})

describe('qrcode field UI', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('renders a QR svg in the grid cell for a value, and nothing for empty', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h('div', [
          h(MetaCellRenderer, {
            field: { id: 'fld_qr', name: 'QR', type: 'qrcode' },
            value: 'https://metasheet.example/r/1',
          }),
          h(MetaCellRenderer, {
            field: { id: 'fld_qr_empty', name: 'QR', type: 'qrcode' },
            value: '',
          }),
        ])
      },
    })

    app.mount(container)
    await flushUi()

    const svgs = container.querySelectorAll('.meta-cell-renderer__qrcode svg')
    expect(svgs.length).toBe(1)
    // Empty value renders the empty fallback, no svg.
    expect(container.querySelectorAll('.meta-cell-renderer__qrcode-empty').length).toBe(1)

    app.unmount()
    container.remove()
  })

  it('uses a text-backed cell editor for qrcode values', async () => {
    const updateSpy = vi.fn()
    const confirmSpy = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaCellEditor, {
          field: { id: 'fld_qr', name: 'QR', type: 'qrcode' },
          modelValue: 'https://metasheet.example/r/1',
          'onUpdate:modelValue': updateSpy,
          onConfirm: confirmSpy,
          onCancel: vi.fn(),
          onOpenLinkPicker: vi.fn(),
        })
      },
    })

    app.mount(container)
    await flushUi()

    const input = container.querySelector('input[placeholder="Enter text or URL for QR code"]') as HTMLInputElement | null
    expect(input?.type).toBe('text')
    input!.value = 'https://example.com/x'
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushUi()

    expect(updateSpy).toHaveBeenCalledWith('https://example.com/x')
    expect(confirmSpy).toHaveBeenCalledTimes(1)

    app.unmount()
    container.remove()
  })

  it('creates qrcode fields from the field manager without configurable property', async () => {
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
    expect(Array.from(typeSelect.options).map((option) => option.value)).toContain('qrcode')

    nameInput.value = 'QR'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    typeSelect.value = 'qrcode'
    typeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('+ Add'))
      ?.click()
    await flushUi()

    expect(createSpy).toHaveBeenCalledWith({
      sheetId: 'sheet_1',
      name: 'QR',
      type: 'qrcode',
    })

    app.unmount()
    container.remove()
  })

  it('submits qrcode values from form view', async () => {
    const submitSpy = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaFormView, {
          fields: [{ id: 'fld_qr', name: 'QR', type: 'qrcode' }],
          record: { id: 'rec_1', version: 1, data: { fld_qr: 'OLD' } },
          loading: false,
          readOnly: false,
          onSubmit: submitSpy,
          onOpenLinkPicker: vi.fn(),
        })
      },
    })

    app.mount(container)
    await flushUi()

    const input = container.querySelector('#field_fld_qr') as HTMLInputElement | null
    expect(input?.placeholder).toBe('Enter text or URL for QR code')
    input!.value = 'https://example.com/new'
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    container.querySelector('form')?.dispatchEvent(new Event('submit'))
    await flushUi()

    expect(submitSpy).toHaveBeenCalledWith({ fld_qr: 'https://example.com/new' })

    app.unmount()
    container.remove()
  })

  it('edits the source string and shows a QR preview in the record drawer', async () => {
    const patchSpy = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaRecordDrawer, {
          visible: true,
          record: { id: 'rec_1', version: 1, data: { fld_qr: 'https://metasheet.example/r/1' } },
          fields: [{ id: 'fld_qr', name: 'QR', type: 'qrcode' }],
          canEdit: true,
          canComment: false,
          canDelete: false,
          onPatch: patchSpy,
        })
      },
    })

    app.mount(container)
    await flushUi()

    // QR preview rendered for the stored value.
    expect(container.querySelector('.meta-record-drawer__qrcode svg')).not.toBeNull()

    // Editable text input patches the source string.
    const input = container.querySelector('#drawer_field_fld_qr') as HTMLInputElement | null
    expect(input?.placeholder).toBe('Enter text or URL for QR code')
    input!.value = 'https://example.com/drawer'
    input!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    expect(patchSpy).toHaveBeenCalledWith('fld_qr', 'https://example.com/drawer')

    app.unmount()
    container.remove()
  })
})
