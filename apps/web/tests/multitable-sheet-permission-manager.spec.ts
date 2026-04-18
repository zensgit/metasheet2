import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import MetaSheetPermissionManager from '../src/multitable/components/MetaSheetPermissionManager.vue'

let app: VueApp | null = null
let container: HTMLDivElement | null = null

async function flushUi(cycles = 4) {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function mountManager(props: {
  client: {
    listSheetPermissions: ReturnType<typeof vi.fn>
    listSheetPermissionCandidates: ReturnType<typeof vi.fn>
    updateSheetPermission: ReturnType<typeof vi.fn>
    updateFieldPermission?: ReturnType<typeof vi.fn>
    updateViewPermission?: ReturnType<typeof vi.fn>
  }
  onUpdated?: () => void
  fields?: Array<{ id: string; name: string; type: string; property?: Record<string, unknown>; order?: number; options?: unknown[] }>
  views?: Array<{ id: string; name: string; type?: string; sheetId?: string }>
  fieldPermissionEntries?: Array<any>
  viewPermissionEntries?: Array<any>
}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(MetaSheetPermissionManager, {
    visible: true,
    sheetId: 'sheet_orders',
    client: props.client,
    fields: props.fields ?? [],
    views: props.views ?? [],
    fieldPermissionEntries: props.fieldPermissionEntries ?? [],
    viewPermissionEntries: props.viewPermissionEntries ?? [],
    onClose: () => {},
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

describe('MetaSheetPermissionManager', () => {
  it('loads entries and filters active users out of candidate results', async () => {
    const client = {
      listSheetPermissions: vi.fn().mockResolvedValue({
        items: [
          {
            subjectType: 'user',
            subjectId: 'user_1',
            accessLevel: 'write',
            permissions: ['spreadsheet.read', 'spreadsheet.write'],
            label: 'Alex',
            subtitle: 'alex@example.com',
            isActive: true,
          },
          {
            subjectType: 'role',
            subjectId: 'role_ops',
            accessLevel: 'admin',
            permissions: ['spreadsheet.admin'],
            label: 'Ops Reviewers',
            subtitle: 'role_ops',
            isActive: true,
          },
        ],
      }),
      listSheetPermissionCandidates: vi.fn().mockResolvedValue({
        items: [
          { subjectType: 'user', subjectId: 'user_1', label: 'Alex', subtitle: 'alex@example.com', isActive: true, accessLevel: 'write' },
          { subjectType: 'user', subjectId: 'user_2', label: 'Jamie', subtitle: 'jamie@example.com', isActive: true, accessLevel: null },
          { subjectType: 'role', subjectId: 'role_ops', label: 'Ops Reviewers', subtitle: 'role_ops', isActive: true, accessLevel: 'admin' },
          { subjectType: 'role', subjectId: 'role_ops_writer', label: 'Ops Writers', subtitle: 'role_ops_writer', isActive: true, accessLevel: null },
        ],
      }),
      updateSheetPermission: vi.fn().mockResolvedValue({}),
      updateFieldPermission: vi.fn().mockResolvedValue({}),
      updateViewPermission: vi.fn().mockResolvedValue({}),
    }

    mountManager({ client })
    await flushUi()

    expect(client.listSheetPermissions).toHaveBeenCalledWith('sheet_orders')
    expect(client.listSheetPermissionCandidates).toHaveBeenCalledWith('sheet_orders', { q: undefined, limit: 12 })
    expect(container!.textContent).toContain('Override sheet-level access for eligible people, member groups, or roles. Admin includes sharing and sheet deletion. Write-own remains user-only.')
    expect(container!.querySelector('[data-sheet-permission-entry="user:user_1"]')).not.toBeNull()
    expect(container!.querySelector('[data-sheet-permission-entry="role:role_ops"]')).not.toBeNull()
    expect(container!.querySelector('[data-sheet-permission-candidate="user:user_1"]')).toBeNull()
    expect(container!.querySelector('[data-sheet-permission-candidate="role:role_ops"]')).toBeNull()
    expect(container!.querySelector('[data-sheet-permission-candidate="user:user_2"]')).not.toBeNull()
    expect(container!.querySelector('[data-sheet-permission-candidate="role:role_ops_writer"]')).not.toBeNull()
    expect((container!.querySelector('[data-sheet-permission-candidate="user:user_2"] .meta-sheet-perm__action--primary') as HTMLButtonElement).textContent)
      .toContain('Apply')
    expect((container!.querySelector('[data-sheet-permission-candidate="role:role_ops_writer"] .meta-sheet-perm__action--primary') as HTMLButtonElement).textContent)
      .toContain('Apply')
  })

  it('updates role-based sheet access for a candidate and keeps admin available while omitting write-own', async () => {
    const updatedSpy = vi.fn()
    const client = {
      listSheetPermissions: vi.fn()
        .mockResolvedValueOnce({ items: [] })
        .mockResolvedValueOnce({
          items: [
            {
              subjectType: 'role',
              subjectId: 'role_ops_writer',
              accessLevel: 'write',
              permissions: ['spreadsheet.read', 'spreadsheet.write'],
              label: 'Ops Writers',
              subtitle: 'role_ops_writer',
              isActive: true,
            },
          ],
        }),
      listSheetPermissionCandidates: vi.fn()
        .mockResolvedValueOnce({
          items: [
            { subjectType: 'role', subjectId: 'role_ops_writer', label: 'Ops Writers', subtitle: 'role_ops_writer', isActive: true, accessLevel: null },
          ],
        })
        .mockResolvedValueOnce({
          items: [
            { subjectType: 'role', subjectId: 'role_ops_writer', label: 'Ops Writers', subtitle: 'role_ops_writer', isActive: true, accessLevel: 'write' },
          ],
        }),
      updateSheetPermission: vi.fn().mockResolvedValue({}),
      updateFieldPermission: vi.fn().mockResolvedValue({}),
      updateViewPermission: vi.fn().mockResolvedValue({}),
    }

    mountManager({ client, onUpdated: updatedSpy })
    await flushUi()

    const select = container!.querySelector('[data-sheet-permission-candidate="role:role_ops_writer"] .meta-sheet-perm__select') as HTMLSelectElement
    const optionValues = Array.from(select.options).map((option) => option.value)
    expect(optionValues).toEqual(['read', 'write', 'admin'])
    select.value = 'write'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    ;(container!.querySelector('[data-sheet-permission-candidate="role:role_ops_writer"] .meta-sheet-perm__action--primary') as HTMLButtonElement).click()
    await flushUi()

    expect(client.updateSheetPermission).toHaveBeenCalledWith('sheet_orders', 'role', 'role_ops_writer', 'write')
    expect(updatedSpy).toHaveBeenCalledTimes(1)
    expect(container!.querySelector('[data-sheet-permission-entry="role:role_ops_writer"]')).not.toBeNull()
    expect(container!.querySelector('[data-sheet-permission-candidate="role:role_ops_writer"]')).toBeNull()
  })

  it('renders member-group candidates and applies sheet access without write-own', async () => {
    const updatedSpy = vi.fn()
    const client = {
      listSheetPermissions: vi.fn()
        .mockResolvedValueOnce({ items: [] })
        .mockResolvedValueOnce({
          items: [
            {
              subjectType: 'member-group',
              subjectId: '3e9c4bc7-13c2-4d12-8b52-9f0d62045d3c',
              accessLevel: 'write',
              permissions: ['spreadsheet:write'],
              label: 'North Region',
              subtitle: '12 members',
              isActive: true,
            },
          ],
        }),
      listSheetPermissionCandidates: vi.fn()
        .mockResolvedValueOnce({
          items: [
            {
              subjectType: 'member-group',
              subjectId: '3e9c4bc7-13c2-4d12-8b52-9f0d62045d3c',
              label: 'North Region',
              subtitle: '12 members',
              isActive: true,
              accessLevel: null,
            },
          ],
        })
        .mockResolvedValueOnce({
          items: [
            {
              subjectType: 'member-group',
              subjectId: '3e9c4bc7-13c2-4d12-8b52-9f0d62045d3c',
              label: 'North Region',
              subtitle: '12 members',
              isActive: true,
              accessLevel: 'write',
            },
          ],
        }),
      updateSheetPermission: vi.fn().mockResolvedValue({}),
      updateFieldPermission: vi.fn().mockResolvedValue({}),
      updateViewPermission: vi.fn().mockResolvedValue({}),
    }

    mountManager({ client, onUpdated: updatedSpy })
    await flushUi()

    const select = container!.querySelector('[data-sheet-permission-candidate="member-group:3e9c4bc7-13c2-4d12-8b52-9f0d62045d3c"] .meta-sheet-perm__select') as HTMLSelectElement
    const optionValues = Array.from(select.options).map((option) => option.value)
    expect(optionValues).toEqual(['read', 'write', 'admin'])
    select.value = 'write'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    ;(container!.querySelector('[data-sheet-permission-candidate="member-group:3e9c4bc7-13c2-4d12-8b52-9f0d62045d3c"] .meta-sheet-perm__action--primary') as HTMLButtonElement).click()
    await flushUi()

    expect(client.updateSheetPermission).toHaveBeenCalledWith('sheet_orders', 'member-group', '3e9c4bc7-13c2-4d12-8b52-9f0d62045d3c', 'write')
    expect(updatedSpy).toHaveBeenCalledTimes(1)
    expect(container!.querySelector('[data-sheet-permission-entry="member-group:3e9c4bc7-13c2-4d12-8b52-9f0d62045d3c"]')).not.toBeNull()
  })

  it('clears field defaults by removing overrides and shows orphan field overrides', async () => {
    const updatedSpy = vi.fn()
    const client = {
      listSheetPermissions: vi.fn().mockResolvedValue({
        items: [
          {
            subjectType: 'user',
            subjectId: 'user_alex',
            accessLevel: 'write',
            permissions: ['spreadsheet:write'],
            label: 'Alex',
            subtitle: 'alex@example.com',
            isActive: true,
          },
        ],
      }),
      listSheetPermissionCandidates: vi.fn().mockResolvedValue({ items: [] }),
      updateSheetPermission: vi.fn().mockResolvedValue({}),
      updateFieldPermission: vi.fn().mockResolvedValue({}),
      updateViewPermission: vi.fn().mockResolvedValue({}),
    }

    mountManager({
      client,
      onUpdated: updatedSpy,
      fields: [
        { id: 'fld_title', name: 'Title', type: 'string', property: {}, order: 0, options: [] },
      ],
      fieldPermissionEntries: [
        {
          fieldId: 'fld_title',
          subjectType: 'user',
          subjectId: 'user_alex',
          subjectLabel: 'Alex',
          subjectSubtitle: 'alex@example.com',
          visible: false,
          readOnly: false,
          isActive: true,
        },
        {
          fieldId: 'fld_title',
          subjectType: 'member-group',
          subjectId: 'group_north',
          subjectLabel: 'North Region',
          subjectSubtitle: 'Regional operations',
          visible: true,
          readOnly: true,
          isActive: true,
        },
      ],
    })
    await flushUi()

    const tabs = Array.from(container!.querySelectorAll('[role="tab"]'))
    const fieldTab = tabs.find((tab) => tab.textContent?.includes('Field Permissions')) as HTMLElement
    fieldTab.click()
    await flushUi()

    const activeRow = container!.querySelector('[data-field-permission-row="fld_title:user:user_alex"]')!
    const activeSelect = activeRow.querySelector('select') as HTMLSelectElement
    activeSelect.value = 'default'
    activeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    ;(activeRow.querySelector('.meta-sheet-perm__action--primary') as HTMLButtonElement).click()
    await flushUi()

    expect(client.updateFieldPermission).toHaveBeenCalledWith('sheet_orders', 'fld_title', 'user', 'user_alex', { remove: true })
    expect(updatedSpy).toHaveBeenCalledTimes(1)

    const orphanRow = container!.querySelector('[data-field-permission-orphan-row="fld_title:member-group:group_north"]')!
    expect(orphanRow.textContent).toContain('North Region')
    expect(orphanRow.textContent).toContain('No current sheet access')

    ;(orphanRow.querySelector('.meta-sheet-perm__action--danger') as HTMLButtonElement).click()
    await flushUi()

    expect(client.updateFieldPermission).toHaveBeenLastCalledWith('sheet_orders', 'fld_title', 'member-group', 'group_north', { remove: true })
    expect(updatedSpy).toHaveBeenCalledTimes(2)
  })

  it('shows orphan view overrides and clears them', async () => {
    const updatedSpy = vi.fn()
    const client = {
      listSheetPermissions: vi.fn().mockResolvedValue({
        items: [
          {
            subjectType: 'user',
            subjectId: 'user_alex',
            accessLevel: 'write',
            permissions: ['spreadsheet:write'],
            label: 'Alex',
            subtitle: 'alex@example.com',
            isActive: true,
          },
        ],
      }),
      listSheetPermissionCandidates: vi.fn().mockResolvedValue({ items: [] }),
      updateSheetPermission: vi.fn().mockResolvedValue({}),
      updateFieldPermission: vi.fn().mockResolvedValue({}),
      updateViewPermission: vi.fn().mockResolvedValue({}),
    }

    mountManager({
      client,
      onUpdated: updatedSpy,
      views: [
        { id: 'view_grid', name: 'Grid View', type: 'grid', sheetId: 'sheet_orders' },
      ],
      viewPermissionEntries: [
        {
          viewId: 'view_grid',
          subjectType: 'member-group',
          subjectId: 'group_north',
          subjectLabel: 'North Region',
          subjectSubtitle: 'Regional operations',
          permission: 'admin',
          isActive: true,
        },
      ],
    })
    await flushUi()

    const tabs = Array.from(container!.querySelectorAll('[role="tab"]'))
    const viewTab = tabs.find((tab) => tab.textContent?.includes('View Permissions')) as HTMLElement
    viewTab.click()
    await flushUi()

    const orphanRow = container!.querySelector('[data-view-permission-orphan-row="view_grid:member-group:group_north"]')!
    expect(orphanRow.textContent).toContain('North Region')
    expect(orphanRow.textContent).toContain('Admin')

    ;(orphanRow.querySelector('.meta-sheet-perm__action--danger') as HTMLButtonElement).click()
    await flushUi()

    expect(client.updateViewPermission).toHaveBeenCalledWith('view_grid', 'member-group', 'group_north', 'none')
    expect(updatedSpy).toHaveBeenCalledTimes(1)
  })

  it('shows subject override summaries and clears downstream overrides for a sheet subject', async () => {
    const updatedSpy = vi.fn()
    const client = {
      listSheetPermissions: vi.fn().mockResolvedValue({
        items: [
          {
            subjectType: 'member-group',
            subjectId: 'group_north',
            accessLevel: 'write',
            permissions: ['spreadsheet:write'],
            label: 'North Region',
            subtitle: 'Regional operations',
            isActive: true,
          },
        ],
      }),
      listSheetPermissionCandidates: vi.fn().mockResolvedValue({ items: [] }),
      updateSheetPermission: vi.fn().mockResolvedValue({}),
      updateFieldPermission: vi.fn().mockResolvedValue({}),
      updateViewPermission: vi.fn().mockResolvedValue({}),
    }

    mountManager({
      client,
      onUpdated: updatedSpy,
      fields: [
        { id: 'fld_title', name: 'Title', type: 'string', property: {}, order: 0, options: [] },
        { id: 'fld_owner', name: 'Owner', type: 'string', property: {}, order: 1, options: [] },
      ],
      views: [
        { id: 'view_grid', name: 'Grid View', type: 'grid', sheetId: 'sheet_orders' },
      ],
      fieldPermissionEntries: [
        {
          fieldId: 'fld_title',
          subjectType: 'member-group',
          subjectId: 'group_north',
          subjectLabel: 'North Region',
          subjectSubtitle: 'Regional operations',
          visible: true,
          readOnly: true,
          isActive: true,
        },
        {
          fieldId: 'fld_owner',
          subjectType: 'member-group',
          subjectId: 'group_north',
          subjectLabel: 'North Region',
          subjectSubtitle: 'Regional operations',
          visible: false,
          readOnly: false,
          isActive: true,
        },
      ],
      viewPermissionEntries: [
        {
          viewId: 'view_grid',
          subjectType: 'member-group',
          subjectId: 'group_north',
          subjectLabel: 'North Region',
          subjectSubtitle: 'Regional operations',
          permission: 'admin',
          isActive: true,
        },
      ],
    })
    await flushUi()

    const sheetRow = container!.querySelector('[data-sheet-permission-entry="member-group:group_north"]')!
    expect(sheetRow.textContent).toContain('2 field overrides')
    expect(sheetRow.textContent).toContain('1 view override')

    ;(container!.querySelector('[data-sheet-permission-clear-overrides="member-group:group_north"]') as HTMLButtonElement).click()
    await flushUi()

    expect(client.updateFieldPermission).toHaveBeenCalledTimes(2)
    expect(client.updateFieldPermission).toHaveBeenNthCalledWith(1, 'sheet_orders', 'fld_title', 'member-group', 'group_north', { remove: true })
    expect(client.updateFieldPermission).toHaveBeenNthCalledWith(2, 'sheet_orders', 'fld_owner', 'member-group', 'group_north', { remove: true })
    expect(client.updateViewPermission).toHaveBeenCalledWith('view_grid', 'member-group', 'group_north', 'none')
    expect(updatedSpy).toHaveBeenCalledTimes(1)
  })

  it('applies a field template to all fields for a member-group subject', async () => {
    const updatedSpy = vi.fn()
    const client = {
      listSheetPermissions: vi.fn().mockResolvedValue({
        items: [
          {
            subjectType: 'member-group',
            subjectId: 'group_north',
            accessLevel: 'write',
            permissions: ['spreadsheet:write'],
            label: 'North Region',
            subtitle: 'Regional operations',
            isActive: true,
          },
        ],
      }),
      listSheetPermissionCandidates: vi.fn().mockResolvedValue({ items: [] }),
      updateSheetPermission: vi.fn().mockResolvedValue({}),
      updateFieldPermission: vi.fn().mockResolvedValue({}),
      updateViewPermission: vi.fn().mockResolvedValue({}),
    }

    mountManager({
      client,
      onUpdated: updatedSpy,
      fields: [
        { id: 'fld_title', name: 'Title', type: 'string', property: {}, order: 0, options: [] },
        { id: 'fld_owner', name: 'Owner', type: 'string', property: {}, order: 1, options: [] },
      ],
    })
    await flushUi()

    const tabs = Array.from(container!.querySelectorAll('[role="tab"]'))
    const fieldTab = tabs.find((tab) => tab.textContent?.includes('Field Permissions')) as HTMLElement
    fieldTab.click()
    await flushUi()

    const templateRow = container!.querySelector('[data-field-permission-template="member-group:group_north"]')!
    const select = templateRow.querySelector('select') as HTMLSelectElement
    select.value = 'readonly'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    ;(templateRow.querySelector('.meta-sheet-perm__action--primary') as HTMLButtonElement).click()
    await flushUi()

    expect(client.updateFieldPermission).toHaveBeenCalledTimes(2)
    expect(client.updateFieldPermission).toHaveBeenNthCalledWith(1, 'sheet_orders', 'fld_title', 'member-group', 'group_north', { visible: true, readOnly: true })
    expect(client.updateFieldPermission).toHaveBeenNthCalledWith(2, 'sheet_orders', 'fld_owner', 'member-group', 'group_north', { visible: true, readOnly: true })
    expect(updatedSpy).toHaveBeenCalledTimes(1)
  })

  it('applies a view template to all views for a member-group subject', async () => {
    const updatedSpy = vi.fn()
    const client = {
      listSheetPermissions: vi.fn().mockResolvedValue({
        items: [
          {
            subjectType: 'member-group',
            subjectId: 'group_north',
            accessLevel: 'write',
            permissions: ['spreadsheet:write'],
            label: 'North Region',
            subtitle: 'Regional operations',
            isActive: true,
          },
        ],
      }),
      listSheetPermissionCandidates: vi.fn().mockResolvedValue({ items: [] }),
      updateSheetPermission: vi.fn().mockResolvedValue({}),
      updateFieldPermission: vi.fn().mockResolvedValue({}),
      updateViewPermission: vi.fn().mockResolvedValue({}),
    }

    mountManager({
      client,
      onUpdated: updatedSpy,
      views: [
        { id: 'view_grid', name: 'Grid View', type: 'grid', sheetId: 'sheet_orders' },
        { id: 'view_board', name: 'Board View', type: 'board', sheetId: 'sheet_orders' },
      ],
    })
    await flushUi()

    const tabs = Array.from(container!.querySelectorAll('[role="tab"]'))
    const viewTab = tabs.find((tab) => tab.textContent?.includes('View Permissions')) as HTMLElement
    viewTab.click()
    await flushUi()

    const templateRow = container!.querySelector('[data-view-permission-template="member-group:group_north"]')!
    const select = templateRow.querySelector('select') as HTMLSelectElement
    select.value = 'admin'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    ;(templateRow.querySelector('.meta-sheet-perm__action--primary') as HTMLButtonElement).click()
    await flushUi()

    expect(client.updateViewPermission).toHaveBeenCalledTimes(2)
    expect(client.updateViewPermission).toHaveBeenNthCalledWith(1, 'view_grid', 'member-group', 'group_north', 'admin')
    expect(client.updateViewPermission).toHaveBeenNthCalledWith(2, 'view_board', 'member-group', 'group_north', 'admin')
    expect(updatedSpy).toHaveBeenCalledTimes(1)
  })
})
