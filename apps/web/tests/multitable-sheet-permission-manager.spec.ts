import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { useLocale } from '../src/composables/useLocale'
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
  useLocale().setLocale('en')
})

describe('MetaSheetPermissionManager', () => {
  it('preserves English sheet permission chrome as the default locale', async () => {
    const client = {
      listSheetPermissions: vi.fn().mockResolvedValue({ items: [] }),
      listSheetPermissionCandidates: vi.fn().mockResolvedValue({ items: [] }),
      updateSheetPermission: vi.fn().mockResolvedValue({}),
      updateFieldPermission: vi.fn().mockResolvedValue({}),
      updateViewPermission: vi.fn().mockResolvedValue({}),
    }

    mountManager({ client })
    await flushUi()

    const text = container!.textContent ?? ''
    expect(text).toContain('Manage Access')
    expect(text).toContain('Override sheet-level access for eligible people, member groups, or roles. Admin includes sharing and sheet deletion. Write-own remains user-only.')
    expect(text).toContain('Sheet Access')
    expect(text).toContain('Field Permissions')
    expect(text).toContain('View Permissions')
    expect(text).toContain('No sheet-specific access grants yet.')
    expect(container!.querySelector<HTMLInputElement>('[data-sheet-permission-search]')?.getAttribute('placeholder')).toBe('Search people or roles')
  })

  it('localizes sheet, field, and view permission chrome in zh-CN while preserving raw ACL data', async () => {
    useLocale().setLocale('zh-CN')
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
        ],
      }),
      listSheetPermissionCandidates: vi.fn().mockResolvedValue({
        items: [
          { subjectType: 'member-group', subjectId: 'group_north', label: 'North Region', subtitle: '12 members', isActive: true, accessLevel: null },
        ],
      }),
      updateSheetPermission: vi.fn().mockResolvedValue({}),
      updateFieldPermission: vi.fn().mockResolvedValue({}),
      updateViewPermission: vi.fn().mockResolvedValue({}),
    }

    mountManager({
      client,
      fields: [
        { id: 'fld_title', name: 'Title', type: 'string', property: {}, order: 0, options: [] },
      ],
      views: [
        { id: 'view_grid', name: 'Grid View', type: 'grid', sheetId: 'sheet_orders' },
      ],
      fieldPermissionEntries: [
        {
          fieldId: 'fld_title',
          subjectType: 'user',
          subjectId: 'user_1',
          subjectLabel: 'Alex',
          subjectSubtitle: 'alex@example.com',
          visible: true,
          readOnly: true,
          isActive: true,
        },
      ],
      viewPermissionEntries: [
        {
          viewId: 'view_grid',
          subjectType: 'user',
          subjectId: 'user_1',
          subjectLabel: 'Alex',
          subjectSubtitle: 'alex@example.com',
          permission: 'admin',
          isActive: true,
        },
      ],
    })
    await flushUi()

    let text = container!.textContent ?? ''
    expect(text).toContain('管理访问权限')
    expect(text).toContain('为可授权人员、成员组或角色覆盖表级访问权限')
    expect(text).toContain('表访问权限')
    expect(text).toContain('字段权限')
    expect(text).toContain('视图权限')
    expect(text).toContain('当前访问权限')
    expect(text).toContain('写入')
    expect(text).toContain('应用')
    expect(text).toContain('Alex')
    expect(text).toContain('alex@example.com')
    expect(text).toContain('North Region')
    expect(container!.querySelector<HTMLInputElement>('[data-sheet-permission-search]')?.getAttribute('placeholder')).toBe('搜索人员或角色')
    expect(container!.querySelector('[data-sheet-permission-entry="user:user_1"] .meta-sheet-perm__badge')?.getAttribute('data-access-level')).toBe('write')
    const sheetSelect = container!.querySelector('[data-sheet-permission-entry="user:user_1"] .meta-sheet-perm__select') as HTMLSelectElement
    expect(Array.from(sheetSelect.options).map((option) => option.value)).toEqual(['read', 'write', 'write-own', 'admin'])

    const tabs = Array.from(container!.querySelectorAll('[role="tab"]'))
    ;(tabs.find((tab) => tab.textContent?.includes('字段权限')) as HTMLElement).click()
    await flushUi()

    text = container!.textContent ?? ''
    expect(text).toContain('字段级权限')
    expect(text).toContain('批量应用到所有字段')
    expect(text).toContain('Title')
    expect(text).toContain('string')
    expect(text).toContain('只读')
    expect(container!.querySelector('[data-field-permission-row="fld_title:user:user_1"] .meta-sheet-perm__badge')?.getAttribute('data-access-level')).toBe('readonly')
    const fieldSelect = container!.querySelector('[data-field-permission-row="fld_title:user:user_1"] .meta-sheet-perm__select') as HTMLSelectElement
    expect(Array.from(fieldSelect.options).map((option) => option.value)).toEqual(['default', 'hidden', 'readonly'])

    ;(tabs.find((tab) => tab.textContent?.includes('视图权限')) as HTMLElement).click()
    await flushUi()

    text = container!.textContent ?? ''
    expect(text).toContain('视图级权限')
    expect(text).toContain('Grid View')
    expect(text).toContain('grid')
    expect(text).toContain('管理员')
    expect(container!.querySelector('[data-view-permission-row="view_grid:user:user_1"] .meta-sheet-perm__badge')?.getAttribute('data-access-level')).toBe('admin')
    const viewSelect = container!.querySelector('[data-view-permission-row="view_grid:user:user_1"] .meta-sheet-perm__select') as HTMLSelectElement
    expect(Array.from(viewSelect.options).map((option) => option.value)).toEqual(['none', 'read', 'write', 'admin'])
  })

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

  it('surfaces inactive users in sheet entries and candidate results', async () => {
    const client = {
      listSheetPermissions: vi.fn().mockResolvedValue({
        items: [
          {
            subjectType: 'user',
            subjectId: 'user_inactive',
            accessLevel: 'read',
            permissions: ['spreadsheet:read'],
            label: 'Morgan',
            subtitle: 'morgan@example.com',
            isActive: false,
          },
        ],
      }),
      listSheetPermissionCandidates: vi.fn().mockResolvedValue({
        items: [
          {
            subjectType: 'user',
            subjectId: 'user_candidate_inactive',
            label: 'Taylor',
            subtitle: 'taylor@example.com',
            isActive: false,
            accessLevel: null,
          },
        ],
      }),
      updateSheetPermission: vi.fn().mockResolvedValue({}),
      updateFieldPermission: vi.fn().mockResolvedValue({}),
      updateViewPermission: vi.fn().mockResolvedValue({}),
    }

    mountManager({
      client,
      fields: [
        { id: 'fld_title', name: 'Title', type: 'string', property: {}, order: 0, options: [] },
      ],
      views: [
        { id: 'view_grid', name: 'Grid View', type: 'grid', sheetId: 'sheet_orders' },
      ],
    })
    await flushUi()

    const inactiveEntry = container!.querySelector('[data-sheet-permission-entry="user:user_inactive"]')!
    const inactiveCandidate = container!.querySelector('[data-sheet-permission-candidate="user:user_candidate_inactive"]')!
    expect(inactiveEntry.textContent).toContain('Inactive user')
    expect(inactiveEntry.textContent).toContain('Cleanup only')
    expect(inactiveCandidate.textContent).toContain('Inactive user')
    expect(inactiveCandidate.textContent).toContain('Grant blocked')
    expect((inactiveEntry.querySelector('.meta-sheet-perm__select') as HTMLSelectElement).disabled).toBe(true)
    expect((inactiveEntry.querySelector('.meta-sheet-perm__action') as HTMLButtonElement).disabled).toBe(true)
    expect((inactiveEntry.querySelector('.meta-sheet-perm__action--danger') as HTMLButtonElement).disabled).toBe(false)
    expect((inactiveCandidate.querySelector('.meta-sheet-perm__select') as HTMLSelectElement).disabled).toBe(true)
    expect((inactiveCandidate.querySelector('.meta-sheet-perm__action--primary') as HTMLButtonElement).disabled).toBe(true)

    const tabs = Array.from(container!.querySelectorAll('[role="tab"]'))
    const fieldTab = tabs.find((tab) => tab.textContent?.includes('Field Permissions')) as HTMLElement
    fieldTab.click()
    await flushUi()

    const fieldTemplateRow = container!.querySelector('[data-field-permission-template="user:user_inactive"]')!
    const fieldRow = container!.querySelector('[data-field-permission-row="fld_title:user:user_inactive"]')!
    expect(fieldTemplateRow.textContent).toContain('Inactive user')
    expect(fieldTemplateRow.textContent).toContain('Cleanup only')
    expect(fieldRow.textContent).toContain('Inactive user')
    expect(fieldRow.textContent).toContain('Cleanup only')
    expect((fieldTemplateRow.querySelector('.meta-sheet-perm__select') as HTMLSelectElement).disabled).toBe(true)
    expect((fieldTemplateRow.querySelector('.meta-sheet-perm__action--primary') as HTMLButtonElement).disabled).toBe(true)
    expect((fieldRow.querySelector('.meta-sheet-perm__select') as HTMLSelectElement).disabled).toBe(true)
    expect((fieldRow.querySelector('.meta-sheet-perm__action--primary') as HTMLButtonElement).disabled).toBe(true)

    const viewTab = tabs.find((tab) => tab.textContent?.includes('View Permissions')) as HTMLElement
    viewTab.click()
    await flushUi()

    const viewTemplateRow = container!.querySelector('[data-view-permission-template="user:user_inactive"]')!
    const viewRow = container!.querySelector('[data-view-permission-row="view_grid:user:user_inactive"]')!
    expect(viewTemplateRow.textContent).toContain('Inactive user')
    expect(viewTemplateRow.textContent).toContain('Cleanup only')
    expect(viewRow.textContent).toContain('Inactive user')
    expect(viewRow.textContent).toContain('Cleanup only')
    expect((viewTemplateRow.querySelector('.meta-sheet-perm__select') as HTMLSelectElement).disabled).toBe(true)
    expect((viewTemplateRow.querySelector('.meta-sheet-perm__action--primary') as HTMLButtonElement).disabled).toBe(true)
    expect((viewRow.querySelector('.meta-sheet-perm__select') as HTMLSelectElement).disabled).toBe(true)
    expect((viewRow.querySelector('.meta-sheet-perm__action--primary') as HTMLButtonElement).disabled).toBe(true)
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

  it('clears all orphan field overrides for a field in one action', async () => {
    const updatedSpy = vi.fn()
    const client = {
      listSheetPermissions: vi.fn().mockResolvedValue({ items: [] }),
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
          subjectType: 'member-group',
          subjectId: 'group_north',
          subjectLabel: 'North Region',
          subjectSubtitle: 'Regional operations',
          visible: true,
          readOnly: true,
          isActive: true,
        },
        {
          fieldId: 'fld_title',
          subjectType: 'user',
          subjectId: 'user_inactive',
          subjectLabel: 'Morgan',
          subjectSubtitle: 'morgan@example.com',
          visible: false,
          readOnly: false,
          isActive: false,
        },
      ],
    })
    await flushUi()

    const tabs = Array.from(container!.querySelectorAll('[role="tab"]'))
    const fieldTab = tabs.find((tab) => tab.textContent?.includes('Field Permissions')) as HTMLElement
    fieldTab.click()
    await flushUi()

    ;(container!.querySelector('[data-field-permission-clear-orphans="fld_title"]') as HTMLButtonElement).click()
    await flushUi()

    expect(client.updateFieldPermission).toHaveBeenCalledTimes(2)
    expect(client.updateFieldPermission).toHaveBeenNthCalledWith(1, 'sheet_orders', 'fld_title', 'member-group', 'group_north', { remove: true })
    expect(client.updateFieldPermission).toHaveBeenNthCalledWith(2, 'sheet_orders', 'fld_title', 'user', 'user_inactive', { remove: true })
    expect(updatedSpy).toHaveBeenCalledTimes(1)
  })

  it('clears all orphan view overrides for a view in one action', async () => {
    const updatedSpy = vi.fn()
    const client = {
      listSheetPermissions: vi.fn().mockResolvedValue({ items: [] }),
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
        {
          viewId: 'view_grid',
          subjectType: 'user',
          subjectId: 'user_inactive',
          subjectLabel: 'Morgan',
          subjectSubtitle: 'morgan@example.com',
          permission: 'read',
          isActive: false,
        },
      ],
    })
    await flushUi()

    const tabs = Array.from(container!.querySelectorAll('[role="tab"]'))
    const viewTab = tabs.find((tab) => tab.textContent?.includes('View Permissions')) as HTMLElement
    viewTab.click()
    await flushUi()

    ;(container!.querySelector('[data-view-permission-clear-orphans="view_grid"]') as HTMLButtonElement).click()
    await flushUi()

    expect(client.updateViewPermission).toHaveBeenCalledTimes(2)
    expect(client.updateViewPermission).toHaveBeenNthCalledWith(1, 'view_grid', 'member-group', 'group_north', 'none')
    expect(client.updateViewPermission).toHaveBeenNthCalledWith(2, 'view_grid', 'user', 'user_inactive', 'none')
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

  it('copies field ACL overrides from one member group to another and clears stale target overrides', async () => {
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
          {
            subjectType: 'member-group',
            subjectId: 'group_south',
            accessLevel: 'write',
            permissions: ['spreadsheet:write'],
            label: 'South Region',
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
          subjectId: 'group_south',
          subjectLabel: 'South Region',
          subjectSubtitle: 'Regional operations',
          visible: false,
          readOnly: false,
          isActive: true,
        },
      ],
    })
    await flushUi()

    const tabs = Array.from(container!.querySelectorAll('[role="tab"]'))
    const fieldTab = tabs.find((tab) => tab.textContent?.includes('Field Permissions')) as HTMLElement
    fieldTab.click()
    await flushUi()

    const sourceSelect = container!.querySelector('[data-field-permission-copy-source="group_south"]') as HTMLSelectElement
    sourceSelect.value = 'group_north'
    sourceSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    ;(container!.querySelector('[data-field-permission-copy-action="group_south"]') as HTMLButtonElement).click()
    await flushUi()

    expect(client.updateFieldPermission).toHaveBeenCalledTimes(2)
    expect(client.updateFieldPermission).toHaveBeenNthCalledWith(1, 'sheet_orders', 'fld_title', 'member-group', 'group_south', { visible: true, readOnly: true })
    expect(client.updateFieldPermission).toHaveBeenNthCalledWith(2, 'sheet_orders', 'fld_owner', 'member-group', 'group_south', { remove: true })
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

  it('copies view ACL overrides from one member group to another and clears stale target overrides', async () => {
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
          {
            subjectType: 'member-group',
            subjectId: 'group_south',
            accessLevel: 'write',
            permissions: ['spreadsheet:write'],
            label: 'South Region',
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
        {
          viewId: 'view_board',
          subjectType: 'member-group',
          subjectId: 'group_south',
          subjectLabel: 'South Region',
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

    const sourceSelect = container!.querySelector('[data-view-permission-copy-source="group_south"]') as HTMLSelectElement
    sourceSelect.value = 'group_north'
    sourceSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    ;(container!.querySelector('[data-view-permission-copy-action="group_south"]') as HTMLButtonElement).click()
    await flushUi()

    expect(client.updateViewPermission).toHaveBeenCalledTimes(2)
    expect(client.updateViewPermission).toHaveBeenNthCalledWith(1, 'view_grid', 'member-group', 'group_south', 'admin')
    expect(client.updateViewPermission).toHaveBeenNthCalledWith(2, 'view_board', 'member-group', 'group_south', 'none')
    expect(updatedSpy).toHaveBeenCalledTimes(1)
  })

  it('copies downstream field and view ACL from one member group to another from sheet access', async () => {
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
          {
            subjectType: 'member-group',
            subjectId: 'group_south',
            accessLevel: 'write',
            permissions: ['spreadsheet:write'],
            label: 'South Region',
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
        { id: 'view_board', name: 'Board View', type: 'board', sheetId: 'sheet_orders' },
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
          subjectId: 'group_south',
          subjectLabel: 'South Region',
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
        {
          viewId: 'view_board',
          subjectType: 'member-group',
          subjectId: 'group_south',
          subjectLabel: 'South Region',
          subjectSubtitle: 'Regional operations',
          permission: 'admin',
          isActive: true,
        },
      ],
    })
    await flushUi()

    const sourceSelect = container!.querySelector('[data-sheet-permission-copy-source="group_south"]') as HTMLSelectElement
    sourceSelect.value = 'group_north'
    sourceSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    ;(container!.querySelector('[data-sheet-permission-copy-action="group_south"]') as HTMLButtonElement).click()
    await flushUi()

    expect(client.updateFieldPermission).toHaveBeenCalledTimes(2)
    expect(client.updateFieldPermission).toHaveBeenCalledWith('sheet_orders', 'fld_title', 'member-group', 'group_south', { visible: true, readOnly: true })
    expect(client.updateFieldPermission).toHaveBeenCalledWith('sheet_orders', 'fld_owner', 'member-group', 'group_south', { remove: true })
    expect(client.updateViewPermission).toHaveBeenCalledTimes(2)
    expect(client.updateViewPermission).toHaveBeenCalledWith('view_grid', 'member-group', 'group_south', 'admin')
    expect(client.updateViewPermission).toHaveBeenCalledWith('view_board', 'member-group', 'group_south', 'none')
    expect(updatedSpy).toHaveBeenCalledTimes(1)
  })

  it('surfaces inactive lifecycle badges on orphan field and view overrides', async () => {
    const client = {
      listSheetPermissions: vi.fn().mockResolvedValue({
        items: [],
      }),
      listSheetPermissionCandidates: vi.fn().mockResolvedValue({ items: [] }),
      updateSheetPermission: vi.fn().mockResolvedValue({}),
      updateFieldPermission: vi.fn().mockResolvedValue({}),
      updateViewPermission: vi.fn().mockResolvedValue({}),
    }

    mountManager({
      client,
      fields: [
        { id: 'fld_title', name: 'Title', type: 'string', property: {}, order: 0, options: [] },
      ],
      views: [
        { id: 'view_grid', name: 'Grid View', type: 'grid', sheetId: 'sheet_orders' },
      ],
      fieldPermissionEntries: [
        {
          fieldId: 'fld_title',
          subjectType: 'user',
          subjectId: 'user_inactive',
          subjectLabel: 'Morgan',
          subjectSubtitle: 'morgan@example.com',
          visible: false,
          readOnly: false,
          isActive: false,
        },
      ],
      viewPermissionEntries: [
        {
          viewId: 'view_grid',
          subjectType: 'user',
          subjectId: 'user_inactive',
          subjectLabel: 'Morgan',
          subjectSubtitle: 'morgan@example.com',
          permission: 'read',
          isActive: false,
        },
      ],
    })
    await flushUi()

    const tabs = Array.from(container!.querySelectorAll('[role="tab"]'))
    const fieldTab = tabs.find((tab) => tab.textContent?.includes('Field Permissions')) as HTMLElement
    fieldTab.click()
    await flushUi()

    const fieldOrphanRow = container!.querySelector('[data-field-permission-orphan-row="fld_title:user:user_inactive"]')!
    expect(fieldOrphanRow.textContent).toContain('Morgan')
    expect(fieldOrphanRow.textContent).toContain('Inactive user')
    expect(fieldOrphanRow.textContent).toContain('No current sheet access')

    const viewTab = tabs.find((tab) => tab.textContent?.includes('View Permissions')) as HTMLElement
    viewTab.click()
    await flushUi()

    const viewOrphanRow = container!.querySelector('[data-view-permission-orphan-row="view_grid:user:user_inactive"]')!
    expect(viewOrphanRow.textContent).toContain('Morgan')
    expect(viewOrphanRow.textContent).toContain('Inactive user')
    expect(viewOrphanRow.textContent).toContain('No current sheet access')
  })

  it('renders the #18 row-level read-deny toggle (with warning) and persists via setRowLevelReadDeny', async () => {
    useLocale().setLocale('en')
    const setRowLevelReadDeny = vi.fn().mockResolvedValue(true)
    mountManager({
      client: {
        listSheetPermissions: vi.fn().mockResolvedValue({ items: [] }),
        listSheetPermissionCandidates: vi.fn().mockResolvedValue({ items: [] }),
        updateSheetPermission: vi.fn().mockResolvedValue({}),
        updateFieldPermission: vi.fn().mockResolvedValue({}),
        updateViewPermission: vi.fn().mockResolvedValue({}),
        getRowLevelReadDeny: vi.fn().mockResolvedValue(false),
        setRowLevelReadDeny,
      } as never,
    })
    await flushUi()

    const toggle = container!.querySelector('.meta-sheet-perm__rowdeny-toggle input[type="checkbox"]') as HTMLInputElement | null
    expect(toggle).not.toBeNull()
    expect(toggle!.checked).toBe(false)
    expect(container!.querySelector('.meta-sheet-perm__rowdeny-warning')?.textContent).toContain('invisible')

    toggle!.checked = true
    toggle!.dispatchEvent(new Event('change'))
    await flushUi()
    expect(setRowLevelReadDeny).toHaveBeenCalledWith('sheet_orders', true)
  })
})
