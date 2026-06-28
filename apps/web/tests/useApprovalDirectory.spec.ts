import { describe, expect, it, vi } from 'vitest'
import { useApprovalDirectory } from '../src/approvals/useApprovalDirectory'

function jsonResponse(body: unknown, init: { status?: number; ok?: boolean } = {}): Response {
  const status = init.status ?? 200
  return {
    ok: init.ok ?? (status >= 200 && status < 300),
    status,
    json: async () => body,
  } as unknown as Response
}

describe('useApprovalDirectory', () => {
  it('searchUsers hits the approval directory endpoint with q + limit and parses the bare {users} shape', async () => {
    const apiFetch = vi.fn().mockResolvedValue(
      jsonResponse({ users: [{ id: 'u1', name: 'Alice', email: 'alice@example.com' }] }),
    )
    const dir = useApprovalDirectory({ apiFetch })

    await dir.searchUsers(' alice ')

    expect(apiFetch).toHaveBeenCalledTimes(1)
    const calledPath = apiFetch.mock.calls[0]?.[0] as string
    expect(calledPath).toContain('/api/approval-templates/directory/users?')
    expect(calledPath).toContain('q=alice')
    expect(calledPath).toContain('limit=20')
    // bare {users}, NOT data.data.items — assert the unwrapping path is the bare one.
    expect(dir.users.value).toEqual([{ id: 'u1', name: 'Alice', email: 'alice@example.com' }])
    expect(dir.usersLoading.value).toBe(false)
    expect(dir.statusMessage.value).toBe('')
  })

  it('searchUsers without a query omits q but still sends limit', async () => {
    const apiFetch = vi.fn().mockResolvedValue(jsonResponse({ users: [] }))
    const dir = useApprovalDirectory({ apiFetch })

    await dir.searchUsers('')

    const calledPath = apiFetch.mock.calls[0]?.[0] as string
    expect(calledPath).not.toContain('q=')
    expect(calledPath).toContain('limit=20')
  })

  it('searchUsers drops malformed user entries (no id) and coerces missing fields', async () => {
    const apiFetch = vi.fn().mockResolvedValue(
      jsonResponse({ users: [{ id: 'u1' }, { name: 'no-id' }, null, { id: 'u2', name: 'Bob', email: 'b@x.io' }] }),
    )
    const dir = useApprovalDirectory({ apiFetch })

    await dir.searchUsers('x')

    expect(dir.users.value).toEqual([
      { id: 'u1', name: '', email: '' },
      { id: 'u2', name: 'Bob', email: 'b@x.io' },
    ])
  })

  it('loadRoles parses the bare {roles} shape', async () => {
    const apiFetch = vi.fn().mockResolvedValue(
      jsonResponse({ roles: [{ id: 'r1', name: '审批员' }, { id: 'r2', name: '' }] }),
    )
    const dir = useApprovalDirectory({ apiFetch })

    await dir.loadRoles()

    expect(apiFetch).toHaveBeenCalledWith('/api/approval-templates/directory/roles')
    expect(dir.roles.value).toEqual([{ id: 'r1', name: '审批员' }, { id: 'r2', name: '' }])
    expect(dir.rolesLoading.value).toBe(false)
  })

  it('403 on searchUsers sets a permission status message and clears the array', async () => {
    const apiFetch = vi.fn().mockResolvedValue(jsonResponse({}, { status: 403, ok: false }))
    const dir = useApprovalDirectory({ apiFetch })
    dir.users.value = [{ id: 'stale', name: 'x', email: '' }]

    await dir.searchUsers('x')

    expect(dir.users.value).toEqual([])
    expect(dir.statusMessage.value).toContain('approval-templates:manage')
  })

  it('403 on loadRoles sets a permission status message and clears the array', async () => {
    const apiFetch = vi.fn().mockResolvedValue(jsonResponse({}, { status: 403, ok: false }))
    const dir = useApprovalDirectory({ apiFetch })
    dir.roles.value = [{ id: 'stale', name: 'x' }]

    await dir.loadRoles()

    expect(dir.roles.value).toEqual([])
    expect(dir.statusMessage.value).toContain('approval-templates:manage')
  })

  // RA-1b CURATED-VOCABULARY: the dedicated formula-role picker hits the CURATED endpoint and is kept
  // strictly separate from loadRoles / `roles` (the static_role approver picker, which lists ALL roles).
  it('loadFormulaRoles hits the CURATED /formula-roles endpoint and parses the bare {roles} shape', async () => {
    const apiFetch = vi.fn().mockResolvedValue(
      jsonResponse({ roles: [{ id: 'finance_approver', name: '财务审批' }, { id: 'r2', name: '' }] }),
    )
    const dir = useApprovalDirectory({ apiFetch })

    await dir.loadFormulaRoles()

    expect(apiFetch).toHaveBeenCalledWith('/api/approval-templates/directory/formula-roles')
    expect(dir.formulaRoles.value).toEqual([{ id: 'finance_approver', name: '财务审批' }, { id: 'r2', name: '' }])
    expect(dir.formulaRolesLoading.value).toBe(false)
  })

  it('loadFormulaRoles and loadRoles hit DIFFERENT endpoints and fill SEPARATE refs (curated vs static_role)', async () => {
    const apiFetch = vi.fn().mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith('/formula-roles')
          ? jsonResponse({ roles: [{ id: 'finance_approver', name: '财务审批' }] })
          : jsonResponse({ roles: [{ id: 'finance_approver', name: '财务审批' }, { id: 'admin', name: '系统管理员' }] }),
      ),
    )
    const dir = useApprovalDirectory({ apiFetch })

    await dir.loadRoles()
    await dir.loadFormulaRoles()

    // static_role picker keeps ALL roles (incl. admin); the curated formula picker excludes it.
    expect(dir.roles.value.map((r) => r.id)).toEqual(['finance_approver', 'admin'])
    expect(dir.formulaRoles.value.map((r) => r.id)).toEqual(['finance_approver'])
  })

  it('403 on loadFormulaRoles sets a permission status message and clears the curated array', async () => {
    const apiFetch = vi.fn().mockResolvedValue(jsonResponse({}, { status: 403, ok: false }))
    const dir = useApprovalDirectory({ apiFetch })
    dir.formulaRoles.value = [{ id: 'stale', name: 'x' }]

    await dir.loadFormulaRoles()

    expect(dir.formulaRoles.value).toEqual([])
    expect(dir.statusMessage.value).toContain('approval-templates:manage')
  })

  it('ensureUserOptionVisible prepends a synthetic option for an id missing from the page, no-op when present', () => {
    const apiFetch = vi.fn()
    const dir = useApprovalDirectory({ apiFetch })
    dir.users.value = [{ id: 'u1', name: 'Alice', email: 'a@x.io' }]

    dir.ensureUserOptionVisible('unknown-id')
    expect(dir.users.value[0]).toEqual({ id: 'unknown-id', name: '', email: '' })
    expect(dir.users.value).toHaveLength(2)

    // already present -> no duplicate
    dir.ensureUserOptionVisible('u1')
    expect(dir.users.value.filter((u) => u.id === 'u1')).toHaveLength(1)
    // blank id -> no-op
    dir.ensureUserOptionVisible('   ')
    expect(dir.users.value).toHaveLength(2)
  })

  it('ensureRoleOptionVisible prepends a synthetic option for an id missing from the page, no-op when present', () => {
    const apiFetch = vi.fn()
    const dir = useApprovalDirectory({ apiFetch })
    dir.roles.value = [{ id: 'r1', name: '审批员' }]

    dir.ensureRoleOptionVisible('legacy-role')
    expect(dir.roles.value[0]).toEqual({ id: 'legacy-role', name: '' })

    dir.ensureRoleOptionVisible('r1')
    expect(dir.roles.value.filter((r) => r.id === 'r1')).toHaveLength(1)
  })

  it('formatUserLabel falls back name -> id and appends email; formatRoleLabel name -> id', () => {
    const apiFetch = vi.fn()
    const dir = useApprovalDirectory({ apiFetch })

    expect(dir.formatUserLabel({ id: 'u1', name: 'Alice', email: 'a@x.io' })).toBe('Alice · a@x.io')
    expect(dir.formatUserLabel({ id: 'u2', name: '', email: '' })).toBe('u2')
    expect(dir.formatUserLabel({ id: 'u3', name: 'Bob', email: '' })).toBe('Bob')
    expect(dir.formatRoleLabel({ id: 'r1', name: '审批员' })).toBe('审批员')
    expect(dir.formatRoleLabel({ id: 'r2', name: '' })).toBe('r2')
  })
})
