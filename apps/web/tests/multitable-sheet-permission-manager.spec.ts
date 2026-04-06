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
            userId: 'user_1',
            accessLevel: 'write',
            permissions: ['spreadsheet.read', 'spreadsheet.write'],
            name: 'Alex',
            email: 'alex@example.com',
            isActive: true,
          },
        ],
      }),
      listSheetPermissionCandidates: vi.fn().mockResolvedValue({
        items: [
          { id: 'user_1', label: 'Alex', subtitle: 'alex@example.com', isActive: true, accessLevel: 'write' },
          { id: 'user_2', label: 'Jamie', subtitle: 'jamie@example.com', isActive: true, accessLevel: null },
        ],
      }),
      updateSheetPermission: vi.fn().mockResolvedValue({}),
    }

    mountManager({ client })
    await flushUi()

    expect(client.listSheetPermissions).toHaveBeenCalledWith('sheet_orders')
    expect(client.listSheetPermissionCandidates).toHaveBeenCalledWith('sheet_orders', { q: undefined, limit: 12 })
    expect(container!.querySelector('[data-sheet-permission-entry="user_1"]')).not.toBeNull()
    expect(container!.querySelector('[data-sheet-permission-candidate="user_1"]')).toBeNull()
    expect(container!.querySelector('[data-sheet-permission-candidate="user_2"]')).not.toBeNull()
  })

  it('updates sheet access for a candidate and emits updated', async () => {
    const updatedSpy = vi.fn()
    const client = {
      listSheetPermissions: vi.fn()
        .mockResolvedValueOnce({ items: [] })
        .mockResolvedValueOnce({
          items: [
            {
              userId: 'user_2',
              accessLevel: 'write-own',
              permissions: ['spreadsheet.read', 'spreadsheet.write.own'],
              name: 'Jamie',
              email: 'jamie@example.com',
              isActive: true,
            },
          ],
        }),
      listSheetPermissionCandidates: vi.fn()
        .mockResolvedValueOnce({
          items: [
            { id: 'user_2', label: 'Jamie', subtitle: 'jamie@example.com', isActive: true, accessLevel: null },
          ],
        })
        .mockResolvedValueOnce({
          items: [
            { id: 'user_2', label: 'Jamie', subtitle: 'jamie@example.com', isActive: true, accessLevel: 'write-own' },
          ],
        }),
      updateSheetPermission: vi.fn().mockResolvedValue({}),
    }

    mountManager({ client, onUpdated: updatedSpy })
    await flushUi()

    const select = container!.querySelector('[data-sheet-permission-candidate="user_2"] .meta-sheet-perm__select') as HTMLSelectElement
    select.value = 'write-own'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    ;(container!.querySelector('[data-sheet-permission-candidate="user_2"] .meta-sheet-perm__action--primary') as HTMLButtonElement).click()
    await flushUi()

    expect(client.updateSheetPermission).toHaveBeenCalledWith('sheet_orders', 'user_2', 'write-own')
    expect(updatedSpy).toHaveBeenCalledTimes(1)
    expect(container!.querySelector('[data-sheet-permission-entry="user_2"]')).not.toBeNull()
  })
})
