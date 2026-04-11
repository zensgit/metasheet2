import { describe, expect, it, vi } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fieldPolicies = require('../../../../plugins/plugin-after-sales/lib/field-policies.cjs') as {
  DEFAULT_EFFECTIVE_POLICY: {
    visibility: string
    editability: string
  }
  buildFieldPolicyRoleMatrix: (
    defaultRoles: Array<{ slug: string; label: string; permissions: string[] }>,
    defaultPolicies: Array<{
      objectId: string
      field: string
      roleSlug: string
      visibility: string
      editability: string
    }>,
    registryRows: Array<{ roleSlug: string; visibility: string; editability: string }>,
  ) => Array<{
    roleSlug: string
    roleLabel: string
    visibility: string
    editability: string
  }>
  buildFieldPolicyUpdateMatrix: (
    defaultRoles: Array<{ slug: string; label: string; permissions: string[] }>,
    defaultPolicies: Array<{
      objectId: string
      field: string
      roleSlug: string
      visibility: string
      editability: string
    }>,
    submittedRoles: Array<{ roleSlug: string; visibility: string; editability: string }>,
  ) => {
    roles: Array<{ slug: string; label: string; permissions: string[] }>
    fieldPolicies: Array<{
      objectId: string
      field: string
      roleSlug: string
      visibility: string
      editability: string
    }>
  }
  resolveFieldPolicyRoleSlugs: (user: Record<string, unknown> | null | undefined) => string[]
  resolveFieldPoliciesForUser: (
    database: { query: (sql: string, params?: unknown[]) => Promise<unknown[] | { rows: unknown[] }> },
    input: {
      tenantId: string
      pluginId: string
      appId: string
      projectId: string
      roleSlugs: string[]
    },
  ) => Promise<{
    projectId: string
    fields: {
      serviceTicket: {
        refundAmount: {
          visibility: string
          editability: string
        }
      }
    }
  }>
}

function createDatabase(rows: Array<Record<string, unknown>>) {
  const query = vi.fn(async () => rows)
  return { query }
}

const DEFAULT_ROLES = [
  { slug: 'admin', label: '管理员', permissions: ['after_sales:admin'] },
  { slug: 'finance', label: '财务', permissions: ['after_sales:approve'] },
  { slug: 'viewer', label: '只读', permissions: ['after_sales:read'] },
]

const DEFAULT_FIELD_POLICIES = [
  { objectId: 'serviceTicket', field: 'refundAmount', roleSlug: 'admin', visibility: 'visible', editability: 'editable' },
  { objectId: 'serviceTicket', field: 'refundAmount', roleSlug: 'finance', visibility: 'visible', editability: 'editable' },
  { objectId: 'serviceTicket', field: 'refundAmount', roleSlug: 'viewer', visibility: 'hidden', editability: 'readonly' },
]

describe('after-sales field policy helper', () => {
  it('resolves role slugs from claims and infers admin from permission claims', () => {
    expect(
      fieldPolicies.resolveFieldPolicyRoleSlugs({
        role: 'finance',
        roles: ['supervisor'],
        perms: ['after_sales:admin'],
      }),
    ).toEqual(['finance', 'supervisor', 'admin'])
  })

  it('returns the single-role registry policy when one role matches', async () => {
    const database = createDatabase([
      { role_slug: 'finance', visibility: 'visible', editability: 'editable' },
      { role_slug: 'viewer', visibility: 'hidden', editability: 'readonly' },
    ])

    const result = await fieldPolicies.resolveFieldPoliciesForUser(database, {
      tenantId: 'tenant_42',
      pluginId: 'plugin-after-sales',
      appId: 'after-sales',
      projectId: 'tenant_42:after-sales',
      roleSlugs: ['finance'],
    })

    expect(result).toEqual({
      projectId: 'tenant_42:after-sales',
      fields: {
        serviceTicket: {
          refundAmount: {
            visibility: 'visible',
            editability: 'editable',
          },
        },
      },
    })
  })

  it('uses the most permissive merge when multiple roles match', async () => {
    const database = createDatabase([
      { role_slug: 'supervisor', visibility: 'visible', editability: 'readonly' },
      { role_slug: 'finance', visibility: 'visible', editability: 'editable' },
      { role_slug: 'viewer', visibility: 'hidden', editability: 'readonly' },
    ])

    const result = await fieldPolicies.resolveFieldPoliciesForUser(database, {
      tenantId: 'tenant_42',
      pluginId: 'plugin-after-sales',
      appId: 'after-sales',
      projectId: 'tenant_42:after-sales',
      roleSlugs: ['viewer', 'supervisor', 'finance'],
    })

    expect(result.fields.serviceTicket.refundAmount).toEqual({
      visibility: 'visible',
      editability: 'editable',
    })
  })

  it('falls back to blueprint defaults when no registry rows exist', async () => {
    const database = createDatabase([])

    const result = await fieldPolicies.resolveFieldPoliciesForUser(database, {
      tenantId: 'tenant_42',
      pluginId: 'plugin-after-sales',
      appId: 'after-sales',
      projectId: 'tenant_42:after-sales',
      roleSlugs: ['supervisor'],
    })

    expect(result.fields.serviceTicket.refundAmount).toEqual({
      visibility: 'visible',
      editability: 'readonly',
    })
  })

  it('returns the conservative default when no matching role policy exists', async () => {
    const database = createDatabase([
      { role_slug: 'finance', visibility: 'visible', editability: 'editable' },
    ])

    const result = await fieldPolicies.resolveFieldPoliciesForUser(database, {
      tenantId: 'tenant_42',
      pluginId: 'plugin-after-sales',
      appId: 'after-sales',
      projectId: 'tenant_42:after-sales',
      roleSlugs: ['viewer'],
    })

    expect(result.fields.serviceTicket.refundAmount).toEqual(fieldPolicies.DEFAULT_EFFECTIVE_POLICY)
  })

  it('builds a role matrix by overlaying registry rows onto blueprint defaults', () => {
    expect(
      fieldPolicies.buildFieldPolicyRoleMatrix(
        DEFAULT_ROLES,
        DEFAULT_FIELD_POLICIES,
        [{ roleSlug: 'finance', visibility: 'hidden', editability: 'editable' }],
      ),
    ).toEqual([
      { roleSlug: 'admin', roleLabel: '管理员', visibility: 'visible', editability: 'editable' },
      { roleSlug: 'finance', roleLabel: '财务', visibility: 'hidden', editability: 'readonly' },
      { roleSlug: 'viewer', roleLabel: '只读', visibility: 'hidden', editability: 'readonly' },
    ])
  })

  it('builds a full replacement update matrix and coerces hidden rows to readonly', () => {
    expect(
      fieldPolicies.buildFieldPolicyUpdateMatrix(
        DEFAULT_ROLES,
        DEFAULT_FIELD_POLICIES,
        [
          { roleSlug: 'admin', visibility: 'visible', editability: 'editable' },
          { roleSlug: 'finance', visibility: 'hidden', editability: 'editable' },
          { roleSlug: 'viewer', visibility: 'hidden', editability: 'readonly' },
        ],
      ),
    ).toEqual({
      roles: DEFAULT_ROLES,
      fieldPolicies: [
        {
          objectId: 'serviceTicket',
          field: 'refundAmount',
          roleSlug: 'admin',
          visibility: 'visible',
          editability: 'editable',
        },
        {
          objectId: 'serviceTicket',
          field: 'refundAmount',
          roleSlug: 'finance',
          visibility: 'hidden',
          editability: 'readonly',
        },
        {
          objectId: 'serviceTicket',
          field: 'refundAmount',
          roleSlug: 'viewer',
          visibility: 'hidden',
          editability: 'readonly',
        },
      ],
    })
  })

  it('rejects field policy updates that omit a default role', () => {
    expect(() =>
      fieldPolicies.buildFieldPolicyUpdateMatrix(
        DEFAULT_ROLES,
        DEFAULT_FIELD_POLICIES,
        [
          { roleSlug: 'admin', visibility: 'visible', editability: 'editable' },
          { roleSlug: 'finance', visibility: 'visible', editability: 'editable' },
        ],
      )).toThrow('field policies must include every default role exactly once')
  })
})
