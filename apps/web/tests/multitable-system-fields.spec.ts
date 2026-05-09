import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaCellEditor from '../src/multitable/components/cells/MetaCellEditor.vue'
import MetaCellRenderer from '../src/multitable/components/cells/MetaCellRenderer.vue'
import MetaFieldManager from '../src/multitable/components/MetaFieldManager.vue'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import { formatFieldDisplay } from '../src/multitable/utils/field-display'

async function flushUi(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('multitable system fields', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('formats system time and actor fields through the shared display formatter', () => {
    const createdTime = formatFieldDisplay({
      field: { id: 'fld_created_at', name: 'Created at', type: 'createdTime' },
      value: '2026-04-30T08:15:00.000Z',
    })
    const createdBy = formatFieldDisplay({
      field: { id: 'fld_created_by', name: 'Created by', type: 'createdBy' },
      value: 'user_1',
    })

    expect(createdTime).toContain('2026')
    expect(createdTime).not.toBe('2026-04-30T08:15:00.000Z')
    expect(createdBy).toBe('user_1')
  })

  it('formats autoNumber fields with prefix and zero padding', () => {
    expect(formatFieldDisplay({
      field: {
        id: 'fld_auto',
        name: 'No.',
        type: 'autoNumber',
        property: { prefix: 'INV-', digits: 4 },
      },
      value: 42,
    })).toBe('INV-0042')

    expect(formatFieldDisplay({
      field: {
        id: 'fld_auto',
        name: 'No.',
        type: 'autoNumber',
        property: { prefix: '', digits: 0 },
      },
      value: 42,
    })).toBe('42')
  })

  it('renders system fields with the system cell branch', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaCellRenderer, {
          field: { id: 'fld_modified_at', name: 'Modified at', type: 'modifiedTime' },
          value: '2026-04-30T09:00:00.000Z',
        })
      },
    })

    app.mount(container)
    await flushUi()

    const systemValue = container.querySelector('.meta-cell-renderer__system')
    expect(systemValue).not.toBeNull()
    expect(systemValue?.textContent).toContain('2026')

    app.unmount()
    container.remove()
  })

  it('keeps system fields readonly even if the cell editor is mounted directly', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaCellEditor, {
          field: { id: 'fld_created_at', name: 'Created at', type: 'createdTime' },
          modelValue: '2026-04-30T08:15:00.000Z',
        })
      },
    })

    app.mount(container)
    await flushUi()

    expect(container.querySelector('input, textarea, select, button')).toBeNull()
    expect(container.querySelector('.meta-cell-editor__readonly')?.textContent).toContain('2026')

    app.unmount()
    container.remove()
  })

  it('does not enter grid edit mode for system fields', async () => {
    const patchSpy = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaGridTable, {
          rows: [
            {
              id: 'rec_1',
              version: 3,
              data: {
                fld_created_at: '2026-04-30T08:15:00.000Z',
              },
            },
          ],
          visibleFields: [
            { id: 'fld_created_at', name: 'Created at', type: 'createdTime' },
          ],
          sortRules: [],
          loading: false,
          currentPage: 1,
          totalPages: 1,
          startIndex: 0,
          canEdit: true,
          onPatchCell: patchSpy,
        })
      },
    })

    app.mount(container)
    await flushUi()

    const cell = container.querySelector('td[aria-label="Created at"]') as HTMLTableCellElement | null
    expect(cell).not.toBeNull()
    cell!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await flushUi()

    expect(container.querySelector('.meta-cell-editor')).toBeNull()
    expect(container.querySelector('.meta-cell-renderer__system')?.textContent).toContain('2026')
    expect(patchSpy).not.toHaveBeenCalled()

    app.unmount()
    container.remove()
  })

  it('creates system fields from the field manager without configurable property', async () => {
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
    expect(Array.from(typeSelect.options).map((option) => option.value)).toEqual(expect.arrayContaining([
      'createdTime',
      'modifiedTime',
      'createdBy',
      'modifiedBy',
      'autoNumber',
    ]))

    nameInput.value = 'Created at'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    typeSelect.value = 'createdTime'
    typeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    expect(container.textContent).toContain('Created time is generated')

    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('+ Add'))
      ?.click()
    await flushUi()

    expect(createSpy).toHaveBeenCalledWith({
      sheetId: 'sheet_1',
      name: 'Created at',
      type: 'createdTime',
    })

    app.unmount()
    container.remove()
  })

  it('creates autoNumber fields with generation config as read-only system fields', async () => {
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

    nameInput.value = 'No.'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    typeSelect.value = 'autoNumber'
    typeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    expect(container.textContent).toContain('Auto number is generated')

    const configInputs = Array.from(container.querySelectorAll('.meta-field-mgr__config .meta-field-mgr__input')) as HTMLInputElement[]
    expect(configInputs).toHaveLength(3)
    configInputs[0].value = 'INV-'
    configInputs[0].dispatchEvent(new Event('input', { bubbles: true }))
    configInputs[1].value = '4'
    configInputs[1].dispatchEvent(new Event('input', { bubbles: true }))
    configInputs[2].value = '100'
    configInputs[2].dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('+ Add'))
      ?.click()
    await flushUi()

    expect(createSpy).toHaveBeenCalledWith({
      sheetId: 'sheet_1',
      name: 'No.',
      type: 'autoNumber',
      property: {
        prefix: 'INV-',
        digits: 4,
        start: 100,
        startAt: 100,
      },
    })

    app.unmount()
    container.remove()
  })
})
