import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import MetaRecordPermissionManager from '../src/multitable/components/MetaRecordPermissionManager.vue'

let app: VueApp | null = null
let container: HTMLDivElement | null = null

async function flushUi(cycles = 4) {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function makeClient(overrides?: {
  listRecordPermissions?: ReturnType<typeof vi.fn>
  updateRecordPermission?: ReturnType<typeof vi.fn>
  deleteRecordPermission?: ReturnType<typeof vi.fn>
}) {
  return {
    listRecordPermissions: overrides?.listRecordPermissions ?? vi.fn().mockResolvedValue([]),
    updateRecordPermission: overrides?.updateRecordPermission ?? vi.fn().mockResolvedValue(undefined),
    deleteRecordPermission: overrides?.deleteRecordPermission ?? vi.fn().mockResolvedValue(undefined),
  }
}

function mountManager(props: {
  client: ReturnType<typeof makeClient>
  visible?: boolean
  onUpdated?: () => void
  onClose?: () => void
}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(MetaRecordPermissionManager, {
    visible: props.visible ?? true,
    sheetId: 'sheet_1',
    recordId: 'record_1',
    client: props.client,
    onClose: props.onClose ?? (() => {}),
    onUpdated: props.onUpdated ?? (() => {}),
  })
  app.mount(container)
}

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
})

describe('MetaRecordPermissionManager', () => {
  it('renders permission list when visible', async () => {
    const client = makeClient({
      listRecordPermissions: vi.fn().mockResolvedValue([
        {
          id: 'perm_1',
          sheetId: 'sheet_1',
          recordId: 'record_1',
          subjectType: 'user',
          subjectId: 'user_alice',
          accessLevel: 'write',
          createdAt: '2026-01-01T00:00:00Z',
        },
        {
          id: 'perm_2',
          sheetId: 'sheet_1',
          recordId: 'record_1',
          subjectType: 'role',
          subjectId: 'role_ops',
          accessLevel: 'read',
        },
      ]),
    })

    mountManager({ client })
    await flushUi()

    expect(client.listRecordPermissions).toHaveBeenCalledWith('sheet_1', 'record_1')
    expect(container!.querySelector('[data-record-permission-entry="perm_1"]')).not.toBeNull()
    expect(container!.querySelector('[data-record-permission-entry="perm_2"]')).not.toBeNull()
    expect(container!.textContent).toContain('user_alice')
    expect(container!.textContent).toContain('role_ops')
  })

  it('calls API on grant', async () => {
    const client = makeClient({
      listRecordPermissions: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: 'perm_new',
            sheetId: 'sheet_1',
            recordId: 'record_1',
            subjectType: 'user',
            subjectId: 'user_bob',
            accessLevel: 'write',
          },
        ]),
    })
    const updatedSpy = vi.fn()

    mountManager({ client, onUpdated: updatedSpy })
    await flushUi()

    // Fill in the add form
    const subjectInput = container!.querySelector('[data-record-permission-subject-input]') as HTMLInputElement
    subjectInput.value = 'user_bob'
    subjectInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    // Change access level to write
    const addRow = container!.querySelector('[data-record-permission-add]')!
    const selects = addRow.querySelectorAll('select')
    const accessSelect = selects[1] as HTMLSelectElement
    accessSelect.value = 'write'
    accessSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    // Click grant
    const grantBtn = addRow.querySelector('.meta-record-perm__action--primary') as HTMLButtonElement
    grantBtn.click()
    await flushUi()

    expect(client.updateRecordPermission).toHaveBeenCalledWith('sheet_1', 'record_1', 'user', 'user_bob', 'write')
    expect(updatedSpy).toHaveBeenCalledTimes(1)
  })

  it('supports granting member-group record permissions', async () => {
    const client = makeClient({
      listRecordPermissions: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: 'perm_group',
            sheetId: 'sheet_1',
            recordId: 'record_1',
            subjectType: 'member-group',
            subjectId: '4df0f2f2-8bc1-4d89-9c47-2746bde6bc4d',
            accessLevel: 'read',
          },
        ]),
    })
    const updatedSpy = vi.fn()

    mountManager({ client, onUpdated: updatedSpy })
    await flushUi()

    const addRow = container!.querySelector('[data-record-permission-add]')!
    const selects = addRow.querySelectorAll('select')
    const subjectTypeSelect = selects[0] as HTMLSelectElement
    expect(Array.from(subjectTypeSelect.options).map((option) => option.value)).toEqual(['user', 'role', 'member-group'])
    subjectTypeSelect.value = 'member-group'
    subjectTypeSelect.dispatchEvent(new Event('change', { bubbles: true }))

    const subjectInput = container!.querySelector('[data-record-permission-subject-input]') as HTMLInputElement
    subjectInput.value = '4df0f2f2-8bc1-4d89-9c47-2746bde6bc4d'
    subjectInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    const grantBtn = addRow.querySelector('.meta-record-perm__action--primary') as HTMLButtonElement
    grantBtn.click()
    await flushUi()

    expect(client.updateRecordPermission).toHaveBeenCalledWith('sheet_1', 'record_1', 'member-group', '4df0f2f2-8bc1-4d89-9c47-2746bde6bc4d', 'read')
    expect(updatedSpy).toHaveBeenCalledTimes(1)
  })

  it('calls API on revoke', async () => {
    const client = makeClient({
      listRecordPermissions: vi.fn().mockResolvedValue([
        {
          id: 'perm_1',
          sheetId: 'sheet_1',
          recordId: 'record_1',
          subjectType: 'user',
          subjectId: 'user_alice',
          accessLevel: 'write',
        },
      ]),
    })
    const updatedSpy = vi.fn()

    mountManager({ client, onUpdated: updatedSpy })
    await flushUi()

    const entryEl = container!.querySelector('[data-record-permission-entry="perm_1"]')
    expect(entryEl).not.toBeNull()
    const removeBtn = entryEl!.querySelector('.meta-record-perm__action--danger') as HTMLButtonElement
    expect(removeBtn).not.toBeNull()
    removeBtn.click()
    await flushUi()

    expect(client.deleteRecordPermission).toHaveBeenCalledWith('sheet_1', 'record_1', 'perm_1')
    expect(updatedSpy).toHaveBeenCalledTimes(1)
  })

  it('shows loading state while fetching', async () => {
    let resolvePermissions: (val: any) => void
    const deferred = new Promise<any>((resolve) => { resolvePermissions = resolve })
    const client = makeClient({
      listRecordPermissions: vi.fn().mockReturnValue(deferred),
    })

    mountManager({ client })
    await flushUi(2)

    expect(container!.textContent).toContain('Loading permissions')

    resolvePermissions!([])
    await deferred
    await flushUi()

    expect(container!.textContent).not.toContain('Loading permissions')
    expect(container!.textContent).toContain('No record-specific permissions yet.')
  })

  it('hides when visible=false', async () => {
    const client = makeClient()

    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(MetaRecordPermissionManager, {
      visible: false,
      sheetId: 'sheet_1',
      recordId: 'record_1',
      client,
      onClose: () => {},
      onUpdated: () => {},
    })
    app.mount(container)
    await flushUi()

    expect(container!.querySelector('.meta-record-perm__overlay')).toBeNull()
  })
})
