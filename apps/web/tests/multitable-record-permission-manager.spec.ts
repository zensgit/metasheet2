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
  listSheetPermissions?: ReturnType<typeof vi.fn>
  listSheetPermissionCandidates?: ReturnType<typeof vi.fn>
  updateRecordPermission?: ReturnType<typeof vi.fn>
  deleteRecordPermission?: ReturnType<typeof vi.fn>
}) {
  return {
    listRecordPermissions: overrides?.listRecordPermissions ?? vi.fn().mockResolvedValue([]),
    listSheetPermissions: overrides?.listSheetPermissions ?? vi.fn().mockResolvedValue({ items: [] }),
    listSheetPermissionCandidates: overrides?.listSheetPermissionCandidates ?? vi.fn().mockResolvedValue({ items: [], total: 0, limit: 20, query: '' }),
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
          label: 'Alice',
          subtitle: 'alice@example.com',
          isActive: true,
          createdAt: '2026-01-01T00:00:00Z',
        },
        {
          id: 'perm_2',
          sheetId: 'sheet_1',
          recordId: 'record_1',
          subjectType: 'role',
          subjectId: 'role_ops',
          accessLevel: 'read',
          label: 'Ops Reviewers',
          subtitle: 'Operations review role',
          isActive: true,
        },
      ]),
    })

    mountManager({ client })
    await flushUi()

    expect(client.listRecordPermissions).toHaveBeenCalledWith('sheet_1', 'record_1')
    expect(container!.querySelector('[data-record-permission-entry="perm_1"]')).not.toBeNull()
    expect(container!.querySelector('[data-record-permission-entry="perm_2"]')).not.toBeNull()
    expect(container!.textContent).toContain('Alice')
    expect(container!.textContent).toContain('alice@example.com')
    expect(container!.textContent).toContain('Ops Reviewers')
  })

  it('grants record access from sheet subjects without raw subject-id input', async () => {
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
            label: 'Bob',
            subtitle: 'bob@example.com',
            isActive: true,
          },
        ]),
      listSheetPermissions: vi.fn().mockResolvedValue({
        items: [
          {
            subjectType: 'user',
            subjectId: 'user_bob',
            accessLevel: 'read',
            permissions: ['spreadsheet:read'],
            label: 'Bob',
            subtitle: 'bob@example.com',
            isActive: true,
          },
        ],
      }),
    })
    const updatedSpy = vi.fn()

    mountManager({ client, onUpdated: updatedSpy })
    await flushUi()

    const candidateRow = container!.querySelector('[data-record-permission-candidate="user:user_bob"]')!
    const accessSelect = candidateRow.querySelector('select') as HTMLSelectElement
    accessSelect.value = 'write'
    accessSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    const grantBtn = candidateRow.querySelector('.meta-record-perm__action--primary') as HTMLButtonElement
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
            label: 'North Region',
            subtitle: 'Regional operations',
            isActive: true,
          },
        ]),
      listSheetPermissions: vi.fn().mockResolvedValue({
        items: [
          {
            subjectType: 'member-group',
            subjectId: '4df0f2f2-8bc1-4d89-9c47-2746bde6bc4d',
            accessLevel: 'read',
            permissions: ['spreadsheet:read'],
            label: 'North Region',
            subtitle: 'Regional operations',
            isActive: true,
          },
        ],
      }),
    })
    const updatedSpy = vi.fn()

    mountManager({ client, onUpdated: updatedSpy })
    await flushUi()

    const candidateRow = container!.querySelector('[data-record-permission-candidate="member-group:4df0f2f2-8bc1-4d89-9c47-2746bde6bc4d"]')!
    expect(candidateRow.textContent).toContain('North Region')
    expect(candidateRow.textContent).toContain('Member group')
    const grantBtn = candidateRow.querySelector('.meta-record-perm__action--primary') as HTMLButtonElement
    grantBtn.click()
    await flushUi()

    expect(client.updateRecordPermission).toHaveBeenCalledWith('sheet_1', 'record_1', 'member-group', '4df0f2f2-8bc1-4d89-9c47-2746bde6bc4d', 'read')
    expect(updatedSpy).toHaveBeenCalledTimes(1)
  })

  it('surfaces inactive users in current record access and candidate results', async () => {
    const client = makeClient({
      listRecordPermissions: vi.fn().mockResolvedValue([
        {
          id: 'perm_inactive',
          sheetId: 'sheet_1',
          recordId: 'record_1',
          subjectType: 'user',
          subjectId: 'user_inactive',
          accessLevel: 'read',
          label: 'Morgan',
          subtitle: 'morgan@example.com',
          isActive: false,
        },
      ]),
      listSheetPermissions: vi.fn().mockResolvedValue({
        items: [
          {
            subjectType: 'user',
            subjectId: 'user_candidate_inactive',
            accessLevel: 'read',
            permissions: ['spreadsheet:read'],
            label: 'Taylor',
            subtitle: 'taylor@example.com',
            isActive: false,
          },
        ],
      }),
    })

    mountManager({ client })
    await flushUi()

    const inactiveEntry = container!.querySelector('[data-record-permission-entry="perm_inactive"]')!
    const inactiveCandidate = container!.querySelector('[data-record-permission-candidate="user:user_candidate_inactive"]')!
    expect(inactiveEntry.textContent).toContain('Inactive user')
    expect(inactiveEntry.textContent).toContain('Cleanup only')
    expect(inactiveCandidate.textContent).toContain('Inactive user')
    expect(inactiveCandidate.textContent).toContain('Grant blocked')
    expect((inactiveEntry.querySelector('.meta-record-perm__select') as HTMLSelectElement).disabled).toBe(true)
    expect((inactiveEntry.querySelector('.meta-record-perm__action') as HTMLButtonElement).disabled).toBe(true)
    expect((inactiveEntry.querySelector('.meta-record-perm__action--danger') as HTMLButtonElement).disabled).toBe(false)
    expect((inactiveCandidate.querySelector('.meta-record-perm__select') as HTMLSelectElement).disabled).toBe(true)
    expect((inactiveCandidate.querySelector('.meta-record-perm__action--primary') as HTMLButtonElement).disabled).toBe(true)
  })

  it('searches across sheet subjects and global candidates when granting record access', async () => {
    const client = makeClient({
      listSheetPermissions: vi.fn().mockResolvedValue({
        items: [
          {
            subjectType: 'member-group',
            subjectId: 'group_north',
            accessLevel: 'read',
            permissions: ['spreadsheet:read'],
            label: 'North Region',
            subtitle: 'Regional operations',
            isActive: true,
          },
        ],
      }),
      listSheetPermissionCandidates: vi.fn().mockResolvedValue({
        items: [
          {
            subjectType: 'role',
            subjectId: 'role_ops',
            label: 'Ops Reviewers',
            subtitle: 'Operations review role',
            isActive: true,
            accessLevel: null,
          },
        ],
        total: 1,
        limit: 20,
        query: 'north',
      }),
    })

    mountManager({ client })
    await flushUi()

    const searchInput = container!.querySelector('[data-record-permission-search]') as HTMLInputElement
    searchInput.value = 'north'
    searchInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    expect(client.listSheetPermissionCandidates).toHaveBeenLastCalledWith('sheet_1', { q: 'north', limit: 20 })
    expect(container!.querySelector('[data-record-permission-candidate="member-group:group_north"]')).not.toBeNull()
    expect(container!.querySelector('[data-record-permission-candidate="role:role_ops"]')).toBeNull()
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
