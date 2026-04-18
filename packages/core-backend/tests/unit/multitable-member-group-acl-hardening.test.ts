import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

describe('multitable member-group ACL hardening', () => {
  it('returns member-group sheet scope when only member-group grants exist', async () => {
    const { loadSheetPermissionScopeMap } = await import('../../src/multitable/sheet-capabilities')

    const scopeMap = await loadSheetPermissionScopeMap(
      async () => ({
        rows: [
          { sheet_id: 'sheet_ops', perm_code: 'spreadsheet:read', subject_type: 'member-group' },
          { sheet_id: 'sheet_ops', perm_code: 'spreadsheet:write', subject_type: 'member-group' },
        ],
      }),
      ['sheet_ops'],
      'user_ops_1',
    )

    expect(scopeMap.get('sheet_ops')).toEqual({
      hasAssignments: true,
      canRead: true,
      canWrite: true,
      canWriteOwn: false,
      canAdmin: false,
    })
  })

  it('returns empty scope map for known missing-table compatibility cases', async () => {
    const { loadSheetPermissionScopeMap } = await import('../../src/multitable/sheet-capabilities')

    const scopeMap = await loadSheetPermissionScopeMap(
      async () => {
        const error = new Error('relation "platform_member_group_members" does not exist') as Error & { code: string }
        error.code = '42P01'
        throw error
      },
      ['sheet_ops'],
      'user_ops_1',
    )

    expect(scopeMap.size).toBe(0)
  })

  it('rethrows non-compatibility database errors from sheet scope loading', async () => {
    const { loadSheetPermissionScopeMap } = await import('../../src/multitable/sheet-capabilities')

    const failure = new Error('permission denied for table spreadsheet_permissions')

    await expect(
      loadSheetPermissionScopeMap(
        async () => {
          throw failure
        },
        ['sheet_ops'],
        'user_ops_1',
      ),
    ).rejects.toBe(failure)
  })

  it('widens spreadsheet permission subject constraints in the member-group migration', async () => {
    const currentFile = fileURLToPath(import.meta.url)
    const migrationPath = path.resolve(
      path.dirname(currentFile),
      '../../src/db/migrations/zzzz20260418143000_allow_member_group_multitable_permission_subjects.ts',
    )

    const source = await readFile(migrationPath, 'utf8')

    expect(source).toContain('ALTER TABLE spreadsheet_permissions')
    expect(source).toContain("CHECK (subject_type IN ('user', 'role', 'member-group'))")
    expect(source).toContain("DELETE FROM spreadsheet_permissions")
    expect(source).toContain("CHECK (subject_type IN ('user', 'role'))")
  })
})
