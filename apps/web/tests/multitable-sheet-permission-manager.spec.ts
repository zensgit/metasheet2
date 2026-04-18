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
  }
  onUpdated?: () => void
}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(MetaSheetPermissionManager, {
    visible: true,
    sheetId: 'sheet_orders',
    client: props.client,
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
})
