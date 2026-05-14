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
      '/api/attendance/import/prepare',
      '/api/attendance/import/preview',
      '/api/attendance/import/commit',
      '/api/attendance/import/preview-async',
      '/api/attendance/import/commit-async',
      '/api/attendance/import/jobs/:id',
      '/api/attendance/import',
      '/api/attendance/integrations',
      '/api/attendance/integrations/:id/runs',
      '/api/attendance/integrations/:id/sync',
      '/api/attendance/import/batches',
      '/api/attendance/import/batches/:id',
      '/api/attendance/import/batches/:id/items',
      '/api/attendance/import/batches/:id/export.csv',
      '/api/attendance/import/rollback/:id',
    ].forEach(expectImportGuard)
  })
})
