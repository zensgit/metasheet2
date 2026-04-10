import { describe, expect, it, vi } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fieldPolicies = require('../../../../plugins/plugin-after-sales/lib/field-policies.cjs') as {
  DEFAULT_EFFECTIVE_POLICY: {
    visibility: string
    editability: string
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
})
