'use strict'

const { DEFAULT_FIELD_POLICIES } = require('./blueprint.cjs')

const DEFAULT_EFFECTIVE_POLICY = Object.freeze({
  visibility: 'hidden',
  editability: 'readonly',
})

function normalizeClaimValues(input) {
  if (Array.isArray(input)) {
    return input
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean)
  }
  if (typeof input === 'string') {
    return input
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  }
  return []
}

function resolveFieldPolicyRoleSlugs(user) {
  const roles = new Set([
    ...normalizeClaimValues(user && user.role),
    ...normalizeClaimValues(user && user.roles),
  ])

  const permissions = new Set([
    ...normalizeClaimValues(user && user.permissions),
    ...normalizeClaimValues(user && user.perms),
  ])

  if (
    permissions.has('*:*') ||
    permissions.has('admin') ||
    permissions.has('admin:all') ||
    permissions.has('after_sales:admin')
  ) {
    roles.add('admin')
  }

  return Array.from(roles)
}

function mergeEffectivePolicy(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ...DEFAULT_EFFECTIVE_POLICY }
  }

  const visibility = rows.some((row) => row && row.visibility === 'visible') ? 'visible' : 'hidden'
  const editability = rows.some((row) => row && row.editability === 'editable') ? 'editable' : 'readonly'
  return { visibility, editability }
}

function buildFieldPolicyResponse(projectId, effectivePolicy) {
  return {
    projectId,
    fields: {
      serviceTicket: {
        refundAmount: effectivePolicy,
      },
    },
  }
}

async function listRegistryFieldPolicies(database, input) {
  const result = await database.query(
    `SELECT role_slug, visibility, editability
     FROM plugin_field_policy_registry
     WHERE tenant_id = $1
       AND plugin_id = $2
       AND app_id = $3
       AND project_id = $4
       AND object_id = $5
       AND field_name = $6
     ORDER BY role_slug ASC`,
    [
      input.tenantId,
      input.pluginId,
      input.appId,
      input.projectId,
      input.objectId,
      input.fieldName,
    ],
  )

  const rows = Array.isArray(result) ? result : result && Array.isArray(result.rows) ? result.rows : []
  return rows
    .map((row) => ({
      roleSlug: typeof row.role_slug === 'string' ? row.role_slug : '',
      visibility: row.visibility === 'visible' ? 'visible' : 'hidden',
      editability: row.editability === 'editable' ? 'editable' : 'readonly',
    }))
    .filter((row) => row.roleSlug)
}

function listDefaultFieldPolicies(objectId, fieldName) {
  return DEFAULT_FIELD_POLICIES
    .filter((policy) => policy.objectId === objectId && policy.field === fieldName)
    .map((policy) => ({
      roleSlug: policy.roleSlug,
      visibility: policy.visibility,
      editability: policy.editability,
    }))
}

async function resolveFieldPoliciesForUser(database, input) {
  const roleSlugs = Array.isArray(input.roleSlugs)
    ? input.roleSlugs.filter((role) => typeof role === 'string' && role.trim()).map((role) => role.trim())
    : []
  const registryRows = await listRegistryFieldPolicies(database, {
    tenantId: input.tenantId,
    pluginId: input.pluginId,
    appId: input.appId,
    projectId: input.projectId,
    objectId: 'serviceTicket',
    fieldName: 'refundAmount',
  })

  const candidateRows = registryRows.length > 0
    ? registryRows
    : listDefaultFieldPolicies('serviceTicket', 'refundAmount')
  const matchingRows = candidateRows.filter((row) => roleSlugs.includes(row.roleSlug))

  return buildFieldPolicyResponse(input.projectId, mergeEffectivePolicy(matchingRows))
}

module.exports = {
  DEFAULT_EFFECTIVE_POLICY,
  buildFieldPolicyResponse,
  mergeEffectivePolicy,
  resolveFieldPolicyRoleSlugs,
  resolveFieldPoliciesForUser,
}
