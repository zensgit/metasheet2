import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { listAccessPresets } from '../../src/auth/access-presets'

const pluginSource = readFileSync(
  new URL('../../../../plugins/plugin-attendance/index.cjs', import.meta.url),
  'utf8',
)

function expectImportGuard(path: string) {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`['"]${escaped}['"],\\s*\\n\\s*withAttendanceImportPermission\\(`)
  expect(pluginSource).toMatch(pattern)
}

function expectDirectAsyncImportRoute(path: string) {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`['"]${escaped}['"],\\s*\\n\\s*async \\(req, res\\)`)
  expect(pluginSource).toMatch(pattern)
}

describe('attendance import permission wiring', () => {
  it('exposes a dedicated importer preset and keeps admins import-capable', () => {
    const presets = listAccessPresets()
    const importer = presets.find((preset) => preset.id === 'attendance-importer')
    const admin = presets.find((preset) => preset.id === 'attendance-admin')

    expect(importer?.roleId).toBe('attendance_importer')
    expect(importer?.permissions).toEqual(['attendance:read', 'attendance:import'])
    expect(admin?.permissions).toContain('attendance:import')
  })

  it('guards import operations with attendance:import or attendance:admin', () => {
    [
      '/api/attendance/import/template',
      '/api/attendance/import/template.csv',
      '/api/attendance/import/upload',
      '/api/attendance/import/upload-artifact',
      '/api/attendance/import/preview-async',
      '/api/attendance/import/commit-async',
      '/api/attendance/import/jobs/:id',
      '/api/attendance/integrations',
      '/api/attendance/integrations/:id/runs',
      '/api/attendance/integrations/:id/sync',
      '/api/attendance/import/batches',
      '/api/attendance/import/batches/:id',
      '/api/attendance/import/batches/:id/items',
      '/api/attendance/import/batches/:id/export.csv',
    ].forEach(expectImportGuard)
  })

  it('lets scheduler-scoped sync and core-owned rollback routes use direct runtime guards', () => {
    [
      '/api/attendance/import/prepare',
      '/api/attendance/import/preview',
      '/api/attendance/import/commit',
      '/api/attendance/import',
      '/api/attendance/import/rollback/:id',
    ].forEach(expectDirectAsyncImportRoute)
    expect(pluginSource).toContain('assertAttendanceImportPrepareAllowed')
    expect(pluginSource).toContain('assertAttendanceImportPreviewAllowed')
    expect(pluginSource).toContain('assertAttendanceImportCommitAllowed')
    expect(pluginSource).toContain('context?.services?.attendanceImportRollback')
    expect(pluginSource).toContain('rollbackImportBatchV1({')
  })

  it('derives rollback org only from authenticated claims, never x-org-id or a default', () => {
    const start = pluginSource.indexOf('function getAuthenticatedOrgId(req)')
    const end = pluginSource.indexOf('\n}\n', start) + 2
    const helper = pluginSource.slice(start, end)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(helper).toContain('user?.orgId ?? user?.workspaceId ?? user?.tenantId')
    expect(helper).not.toContain("req.headers['x-org-id']")
    expect(helper).not.toContain('DEFAULT_ORG_ID')
    expect(helper).toContain('return null')

    const userStart = pluginSource.indexOf('function getAuthenticatedUserId(req)')
    const userEnd = pluginSource.indexOf('\n}\n', userStart) + 2
    const userHelper = pluginSource.slice(userStart, userEnd)
    expect(userStart).toBeGreaterThanOrEqual(0)
    expect(userHelper).toContain('user?.id ?? user?.sub ?? user?.userId')
    expect(userHelper).not.toContain("req.headers['x-user-id']")
    expect(userHelper).toContain('return null')

    const subjectStart = pluginSource.indexOf('function getAuthenticatedTokenSubjectUserId(req)')
    const subjectEnd = pluginSource.indexOf('\n}\n', subjectStart) + 2
    const subjectHelper = pluginSource.slice(subjectStart, subjectEnd)
    expect(subjectStart).toBeGreaterThanOrEqual(0)
    expect(subjectHelper).toContain('user?.sub ?? user?.userId ?? user?.id')
    expect(subjectHelper).not.toContain('getAuthenticatedUserId(req)')
    expect(subjectHelper).not.toContain("req.headers['x-user-id']")
    expect(pluginSource).toContain('tokenSubjectUserId,')
    expect(pluginSource).not.toContain('tokenSubjectUserId: actorId')
  })
})
