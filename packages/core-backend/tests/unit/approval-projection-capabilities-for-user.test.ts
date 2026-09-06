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
import { deriveElearningProjectionSheetId } from '../../src/multitable/elearning-projection-constants'
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
    const query = mkQuery(false)
    const res = await resolveSheetCapabilitiesForUser(query, 'S', 'u1')
    expect(res.capabilities.canRead).toBe(true)
    expect(query.mock.calls.some(([sql]) => (
      String(sql).includes('FROM elearning_stats_multitable_sheets')
    ))).toBe(false)
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

describe('e-learning aggregate projection capability guard', () => {
  const orgId = 'org-elearning-stats'
  const sheetId = deriveElearningProjectionSheetId(orgId)

  function projectionQuery(member: boolean, validSystemKind = true) {
    return vi.fn(async (sql: string) => {
      if (sql.includes("to_jsonb(sheet) ->> 'system_kind'")) {
        return { rows: validSystemKind ? [{ id: sheetId }] : [] }
      }
      if (sql.includes('FROM elearning_stats_multitable_sheets')) {
        return { rows: [{ org_id: orgId, sheet_id: sheetId }] }
      }
      if (sql.includes('FROM user_orgs')) return { rows: member ? [{ '?column?': 1 }] : [] }
      return { rows: [] }
    }) as never
  }

  it('gives a same-org e-learning admin read/export/view access but no write surface', async () => {
    vi.mocked(isAdmin).mockResolvedValue(false)
    vi.mocked(listUserPermissions).mockResolvedValue(['elearning:admin'])
    const result = await resolveSheetCapabilitiesForUser(
      projectionQuery(true),
      sheetId,
      'elearning-admin',
    )
    expect(result.capabilities).toMatchObject({
      canRead: true,
      canExport: true,
      canManageViews: true,
      canCreateRecord: false,
      canEditRecord: false,
      canDeleteRecord: false,
      canManageFields: false,
      canManageSheetAccess: false,
      canComment: false,
      canManageAutomation: false,
      canSendNotification: false,
    })
  })

  it('fails closed for a cross-org e-learning admin and clamps platform admins to read-only', async () => {
    vi.mocked(isAdmin).mockResolvedValue(false)
    vi.mocked(listUserPermissions).mockResolvedValue(['elearning:admin'])
    const denied = await resolveSheetCapabilitiesForUser(
      projectionQuery(false),
      sheetId,
      'cross-org-admin',
    )
    expect(denied.capabilities.canRead).toBe(false)
    expect(denied.capabilities.canManageViews).toBe(false)

    vi.mocked(isAdmin).mockResolvedValue(true)
    vi.mocked(listUserPermissions).mockResolvedValue([])
    const platformAdmin = await resolveSheetCapabilitiesForUser(
      projectionQuery(false),
      sheetId,
      'platform-admin',
    )
    expect(platformAdmin.capabilities.canRead).toBe(true)
    expect(platformAdmin.capabilities.canExport).toBe(true)
    expect(platformAdmin.capabilities.canManageViews).toBe(true)
    expect(platformAdmin.capabilities.canEditRecord).toBe(false)
    expect(platformAdmin.capabilities.canManageFields).toBe(false)

    const drifted = await resolveSheetCapabilitiesForUser(
      projectionQuery(true, false),
      sheetId,
      'platform-admin',
    )
    expect(drifted.capabilities.canRead).toBe(false)
    expect(drifted.capabilities.canManageViews).toBe(false)
  })

  it('reserves projection-shaped sheet ids and denies an unmapped candidate without treating ordinary ids as candidates', async () => {
    vi.mocked(isAdmin).mockResolvedValue(false)
    vi.mocked(listUserPermissions).mockResolvedValue(['elearning:admin', 'multitable:read'])
    const query = vi.fn(async () => ({ rows: [] }))
    const result = await resolveSheetCapabilitiesForUser(
      query as never,
      sheetId,
      'elearning-admin',
    )
    expect(result.capabilities.canRead).toBe(false)
    expect(result.capabilities.canExport).toBe(false)
    expect(query.mock.calls.some(([sql]) => (
      String(sql).includes('FROM elearning_stats_multitable_sheets')
    ))).toBe(true)
  })
})
