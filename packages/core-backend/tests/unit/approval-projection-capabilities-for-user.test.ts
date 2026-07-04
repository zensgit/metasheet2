/**
 * A (review P1) — resolveSheetCapabilitiesForUser gates the approval projection base too.
 *
 * This resolver fronts the collab sheet-room auth + Yjs record auth + api-token capability paths
 * (index.ts / routes/api-tokens.ts), NOT just REST. Without the guard, a non-admin with global
 * multitable:read would get canRead=true on a projection sheet via collab/Yjs — the exact leak arc-A closes.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/rbac/service', () => ({ isAdmin: vi.fn(), listUserPermissions: vi.fn() }))

import { resolveSheetCapabilitiesForUser } from '../../src/multitable/sheet-capabilities'
import { isAdmin, listUserPermissions } from '../../src/rbac/service'

const mkQuery = (isProjectionSheet: boolean) =>
  vi.fn(async (sql: string) => {
    if (/FROM meta_sheets WHERE id = ANY[\s\S]*base_id/i.test(sql)) {
      return { rows: isProjectionSheet ? [{ id: 'S' }] : [] }
    }
    return { rows: [] } // scope map + everything else
  }) as never

describe('A — resolveSheetCapabilitiesForUser projection guard (collab/Yjs/api-token read path)', () => {
  it('DENIES a non-admin (multitable:read) on a projection sheet — canRead=false (RED-before: was true)', async () => {
    vi.mocked(isAdmin).mockResolvedValue(false)
    vi.mocked(listUserPermissions).mockResolvedValue(['multitable:read'])
    const res = await resolveSheetCapabilitiesForUser(mkQuery(true), 'S', 'u1')
    expect(res.capabilities.canRead).toBe(false)
  })

  it('ALLOWS the same non-admin on an ordinary (non-projection) sheet — canRead=true', async () => {
    vi.mocked(isAdmin).mockResolvedValue(false)
    vi.mocked(listUserPermissions).mockResolvedValue(['multitable:read'])
    const res = await resolveSheetCapabilitiesForUser(mkQuery(false), 'S', 'u1')
    expect(res.capabilities.canRead).toBe(true)
  })

  it('ALLOWS an admin on a projection sheet — canRead=true', async () => {
    vi.mocked(isAdmin).mockResolvedValue(true)
    vi.mocked(listUserPermissions).mockResolvedValue([])
    const res = await resolveSheetCapabilitiesForUser(mkQuery(true), 'S', 'u1')
    expect(res.capabilities.canRead).toBe(true)
  })

  it('DENIES write/manage caps for a non-admin WRITER (multitable:write + workflow) on a projection sheet', async () => {
    vi.mocked(isAdmin).mockResolvedValue(false)
    vi.mocked(listUserPermissions).mockResolvedValue(['multitable:write', 'workflow:write'])
    const res = await resolveSheetCapabilitiesForUser(mkQuery(true), 'S', 'u1')
    for (const cap of ['canRead', 'canExport', 'canCreateRecord', 'canEditRecord', 'canDeleteRecord', 'canManageFields', 'canManageSheetAccess', 'canManageViews', 'canManageAutomation', 'canSendNotification'] as const) {
      expect(res.capabilities[cap]).toBe(false)
    }
    // control: ordinary sheet keeps them
    const ok = await resolveSheetCapabilitiesForUser(mkQuery(false), 'S', 'u1')
    expect(ok.capabilities.canEditRecord).toBe(true)
    expect(ok.capabilities.canManageAutomation).toBe(true)
  })
})
