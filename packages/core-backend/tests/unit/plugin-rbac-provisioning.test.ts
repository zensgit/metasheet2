import { describe, expect, it } from 'vitest'

import { applyRoleMatrix, type RbacProvisioningQueryFn } from '../../src/services/PluginRbacProvisioningService'

function createQuery(): RbacProvisioningQueryFn {
  const permissions = new Map<string, string>()
  const roles = new Map<string, string>()
  const rolePermissions = new Set<string>()
  const fieldPolicies = new Map<string, { visibility: string; editability: string }>()

  return async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim()

    if (normalized.startsWith('INSERT INTO permissions')) {
      const [code, description] = params as [string, string]
      if (!permissions.has(code)) {
        permissions.set(code, description)
      }
      return { rows: [] }
    }

    if (normalized.startsWith('INSERT INTO roles')) {
      const [roleId, name] = params as [string, string]
      roles.set(roleId, name)
      return { rows: [] }
    }

    if (normalized.startsWith('INSERT INTO role_permissions')) {
      const [roleId, permissionCode] = params as [string, string]
      rolePermissions.add(`${roleId}:${permissionCode}`)
      return { rows: [] }
    }

    if (normalized.startsWith('INSERT INTO plugin_field_policy_registry')) {
      const [
        tenantId,
        pluginId,
        appId,
        projectId,
        objectId,
        fieldName,
        roleSlug,
        visibility,
        editability,
      ] = params as [string, string, string, string, string, string, string, string, string]
      fieldPolicies.set(
        `${tenantId}:${pluginId}:${appId}:${projectId}:${objectId}:${fieldName}:${roleSlug}`,
        { visibility, editability },
      )
      return { rows: [] }
    }

    throw new Error(`Unexpected SQL in RBAC provisioning test: ${normalized}`)
  }
}

describe('PluginRbacProvisioningService', () => {
  it('upserts role permissions and field policy rows idempotently', async () => {
    const query = createQuery()

    const matrix = {
      roles: [
        {
          slug: 'finance',
          label: '财务',
          permissions: ['after_sales:read', 'after_sales:approve'],
        },
        {
          slug: 'supervisor',
          label: '主管',
          permissions: ['after_sales:read', 'after_sales:write', 'after_sales:approve'],
        },
      ],
      fieldPolicies: [
        {
          objectId: 'serviceTicket',
          field: 'refundAmount',
          roleSlug: 'finance',
          visibility: 'visible' as const,
          editability: 'editable' as const,
        },
      ],
    }

    const first = await applyRoleMatrix(query, {
      tenantId: 'tenant_42',
      pluginId: 'plugin-after-sales',
      appId: 'after-sales',
      projectId: 'tenant_42:after-sales',
      matrix,
    })
    const second = await applyRoleMatrix(query, {
      tenantId: 'tenant_42',
      pluginId: 'plugin-after-sales',
      appId: 'after-sales',
      projectId: 'tenant_42:after-sales',
      matrix,
    })

    expect(first).toEqual({
      rolesApplied: ['finance', 'supervisor'],
      fieldPoliciesApplied: 1,
    })
    expect(second).toEqual({
      rolesApplied: ['finance', 'supervisor'],
      fieldPoliciesApplied: 1,
    })
  })
})
