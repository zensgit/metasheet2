/**
 * Targeted tests for scoped view/field permissions.
 *
 * Tests the REAL production code paths — useMultitableCapabilities composable
 * and MetaSheetPermissionManager component — not inline reimplementations.
 */
import { describe, expect, it, vi } from 'vitest'
import { ref, nextTick, createApp, defineComponent, h, type App as VueApp } from 'vue'
import { useMultitableCapabilities } from '../src/multitable/composables/useMultitableCapabilities'
import type { MetaCapabilities } from '../src/multitable/types'

// --- 1. useMultitableCapabilities: canExport fallback ---

describe('useMultitableCapabilities canExport behavior', () => {
  it('returns canExport=true for all roles', () => {
    for (const role of ['owner', 'editor', 'commenter', 'viewer'] as const) {
      const source = ref<typeof role>(role)
      const caps = useMultitableCapabilities(source)
      expect(caps.canExport.value).toBe(true)
    }
  })

  it('reads canExport from MetaCapabilities object when present', () => {
    const source = ref<MetaCapabilities>({
      canRead: true,
      canCreateRecord: false,
      canEditRecord: false,
      canDeleteRecord: false,
      canManageFields: false,
      canManageSheetAccess: false,
      canManageViews: false,
      canComment: false,
      canManageAutomation: false,
      canExport: false,
    })
    const caps = useMultitableCapabilities(source)
    expect(caps.canExport.value).toBe(false)
  })

  it('falls back canExport to canRead when field is missing from backend response', () => {
    // Simulate a backend response that does not include canExport (partial rollout)
    const incomplete = {
      canRead: true,
      canCreateRecord: false,
      canEditRecord: false,
      canDeleteRecord: false,
      canManageFields: false,
      canManageSheetAccess: false,
      canManageViews: false,
      canComment: false,
      canManageAutomation: false,
      // canExport intentionally missing
    } as MetaCapabilities
    const source = ref(incomplete)
    const caps = useMultitableCapabilities(source)
    // Should fall back to canRead=true, not undefined/false
    expect(caps.canExport.value).toBe(true)
  })

  it('falls back canExport to canRead=false when both missing', () => {
    const incomplete = {
      canRead: false,
      canCreateRecord: false,
      canEditRecord: false,
      canDeleteRecord: false,
      canManageFields: false,
      canManageSheetAccess: false,
      canManageViews: false,
      canComment: false,
      canManageAutomation: false,
    } as MetaCapabilities
    const source = ref(incomplete)
    const caps = useMultitableCapabilities(source)
    expect(caps.canExport.value).toBe(false)
  })
})

// --- 2. MetaSheetPermissionManager: tab rendering with field/view data ---

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return { ...actual, useRouter: () => ({ push: vi.fn() }), RouterLink: defineComponent({ props: ['to'], setup(_, { slots }) { return () => h('a', {}, slots.default?.()) } }) }
})

describe('MetaSheetPermissionManager field/view tabs', () => {
  let app: VueApp | null = null
  let container: HTMLDivElement | null = null

  async function flushUi() {
    await nextTick()
    await nextTick()
    await new Promise((r) => setTimeout(r, 10))
  }

  function cleanup() {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  }

  it('renders three tabs including Field Permissions and View Permissions', async () => {
    const { default: MetaSheetPermissionManager } = await import('../src/multitable/components/MetaSheetPermissionManager.vue')

    container = document.createElement('div')
    document.body.appendChild(container)

    const mockClient = {
      listSheetPermissions: vi.fn().mockResolvedValue({ items: [
        { subjectType: 'user', subjectId: 'user_1', label: 'Alice', accessLevel: 'write', isActive: true },
      ] }),
      listSheetPermissionCandidates: vi.fn().mockResolvedValue({ items: [] }),
      updateSheetPermission: vi.fn().mockResolvedValue({}),
      listFieldPermissions: vi.fn().mockResolvedValue({ items: [] }),
      updateFieldPermission: vi.fn().mockResolvedValue({}),
      listViewPermissions: vi.fn().mockResolvedValue({ items: [] }),
      updateViewPermission: vi.fn().mockResolvedValue({}),
    }

    const Host = defineComponent({
      setup() {
        return () => h(MetaSheetPermissionManager, {
          visible: true,
          sheetId: 'sheet_1',
          client: mockClient,
          fields: [
            { id: 'fld_1', name: 'Title', type: 'string', property: {}, order: 0, options: [] },
            { id: 'fld_2', name: 'Status', type: 'select', property: {}, order: 1, options: [] },
          ],
          views: [
            { id: 'view_1', name: 'Grid View', sheetId: 'sheet_1' },
            { id: 'view_2', name: 'Form View', sheetId: 'sheet_1' },
          ],
          fieldPermissionEntries: [],
          viewPermissionEntries: [],
        })
      },
    })

    app = createApp(Host)
    app.mount(container)
    await flushUi()

    const tabs = Array.from(container.querySelectorAll('[role="tab"]'))
    const tabLabels = tabs.map((t) => t.textContent?.trim())
    expect(tabLabels).toContain('Sheet Access')
    expect(tabLabels).toContain('Field Permissions')
    expect(tabLabels).toContain('View Permissions')

    // Click Field Permissions tab
    const fieldTab = tabs.find((t) => t.textContent?.includes('Field Permissions')) as HTMLElement
    fieldTab?.click()
    await flushUi()

    // Should show field names
    const fieldLabels = container.textContent ?? ''
    expect(fieldLabels).toContain('Title')
    expect(fieldLabels).toContain('Status')

    // Click View Permissions tab
    const viewTab = tabs.find((t) => t.textContent?.includes('View Permissions')) as HTMLElement
    viewTab?.click()
    await flushUi()

    // Should show view names
    const viewLabels = container.textContent ?? ''
    expect(viewLabels).toContain('Grid View')
    expect(viewLabels).toContain('Form View')

    cleanup()
  })
})
