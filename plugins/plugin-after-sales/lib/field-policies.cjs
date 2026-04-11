'use strict'

const { DEFAULT_FIELD_POLICIES } = require('./blueprint.cjs')

const FIELD_POLICY_OBJECT_ID = 'serviceTicket'
const FIELD_POLICY_FIELD_NAME = 'refundAmount'

const DEFAULT_EFFECTIVE_POLICY = Object.freeze({
  visibility: 'hidden',
  editability: 'readonly',
})

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

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
      [FIELD_POLICY_OBJECT_ID]: {
        [FIELD_POLICY_FIELD_NAME]: effectivePolicy,
      },
    },
  }
}

function normalizeVisibility(value) {
  return value === 'visible' ? 'visible' : 'hidden'
}

function normalizeEditability(visibility, value) {
  if (visibility === 'hidden') {
    return 'readonly'
  }
  return value === 'editable' ? 'editable' : 'readonly'
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
      visibility: normalizeVisibility(row.visibility),
      editability: normalizeEditability(normalizeVisibility(row.visibility), row.editability),
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

function mergeFieldPolicyRows(defaultPolicies, registryRows) {
  const mergedByRole = new Map(
    (Array.isArray(defaultPolicies) ? defaultPolicies : []).map((policy) => [
      policy.roleSlug,
      {
        roleSlug: policy.roleSlug,
        visibility: normalizeVisibility(policy.visibility),
        editability: normalizeEditability(
          normalizeVisibility(policy.visibility),
          policy.editability,
        ),
      },
    ]),
  )

  for (const row of Array.isArray(registryRows) ? registryRows : []) {
    if (!row || typeof row.roleSlug !== 'string' || !row.roleSlug.trim()) continue
    const visibility = normalizeVisibility(row.visibility)
    mergedByRole.set(row.roleSlug, {
      roleSlug: row.roleSlug,
      visibility,
      editability: normalizeEditability(visibility, row.editability),
    })
  }

  return Array.from(mergedByRole.values())
}

function buildFieldPolicyRoleMatrix(defaultRoles, defaultPolicies, registryRows) {
  const mergedRows = mergeFieldPolicyRows(defaultPolicies, registryRows)
  const mergedByRole = new Map(mergedRows.map((row) => [row.roleSlug, row]))

  return (Array.isArray(defaultRoles) ? defaultRoles : []).map((role) => {
    const fallback = mergedByRole.get(role.slug) || DEFAULT_EFFECTIVE_POLICY
    return {
      roleSlug: typeof role.slug === 'string' ? role.slug : '',
      roleLabel: typeof role.label === 'string' && role.label.trim() ? role.label.trim() : String(role.slug || ''),
      visibility: fallback.visibility,
      editability: fallback.editability,
    }
  }).filter((role) => role.roleSlug)
}

function createValidationError(message, details) {
  const error = new Error(message)
  error.code = 'VALIDATION_FAILED'
  if (details && typeof details === 'object') {
    error.details = details
  }
  return error
}

function buildFieldPolicyUpdateMatrix(defaultRoles, defaultPolicies, submittedRoles) {
  const expectedRoles = Array.isArray(defaultRoles) ? defaultRoles : []
  const expectedRoleSlugs = expectedRoles
    .map((role) => (typeof role.slug === 'string' ? role.slug.trim() : ''))
    .filter(Boolean)
  const submitted = Array.isArray(submittedRoles) ? submittedRoles : []
  const submittedByRole = new Map()

  for (const row of submitted) {
    const roleSlug = typeof row.roleSlug === 'string' ? row.roleSlug.trim() : ''
    if (!roleSlug) {
      throw createValidationError('field policy updates must include a non-empty roleSlug')
    }
    if (submittedByRole.has(roleSlug)) {
      throw createValidationError(`field policy role(${roleSlug}) is duplicated`)
    }

    const visibility = normalizeVisibility(row.visibility)
    if (row.visibility !== 'visible' && row.visibility !== 'hidden') {
      throw createValidationError(`field policy role(${roleSlug}).visibility is invalid`)
    }
    if (row.editability !== 'editable' && row.editability !== 'readonly') {
      throw createValidationError(`field policy role(${roleSlug}).editability is invalid`)
    }

    submittedByRole.set(roleSlug, {
      roleSlug,
      visibility,
      editability: normalizeEditability(visibility, row.editability),
    })
  }

  const actualRoleSlugs = Array.from(submittedByRole.keys()).sort()
  const sortedExpectedRoleSlugs = [...expectedRoleSlugs].sort()
  if (
    actualRoleSlugs.length !== sortedExpectedRoleSlugs.length
    || actualRoleSlugs.some((roleSlug, index) => roleSlug !== sortedExpectedRoleSlugs[index])
  ) {
    throw createValidationError(
      'field policies must include every default role exactly once',
      { expectedRoleSlugs: sortedExpectedRoleSlugs },
    )
  }

  const basePolicies = Array.isArray(defaultPolicies)
    ? defaultPolicies
        .filter((policy) => policy && policy.objectId === FIELD_POLICY_OBJECT_ID && policy.field === FIELD_POLICY_FIELD_NAME)
        .map((policy) => ({
          roleSlug: policy.roleSlug,
          visibility: policy.visibility,
          editability: policy.editability,
        }))
    : listDefaultFieldPolicies(FIELD_POLICY_OBJECT_ID, FIELD_POLICY_FIELD_NAME)
  const mergedByRole = new Map(
    mergeFieldPolicyRows(basePolicies, [])
      .map((policy) => [policy.roleSlug, policy]),
  )

  return {
    roles: expectedRoles.map((role) => clone(role)),
    fieldPolicies: expectedRoles.map((role) => {
      const submittedRow = submittedByRole.get(role.slug)
      const fallbackRow = mergedByRole.get(role.slug) || DEFAULT_EFFECTIVE_POLICY
      const visibility = submittedRow ? submittedRow.visibility : fallbackRow.visibility
      const editability = submittedRow ? submittedRow.editability : fallbackRow.editability

      return {
        objectId: FIELD_POLICY_OBJECT_ID,
        field: FIELD_POLICY_FIELD_NAME,
        roleSlug: role.slug,
        visibility,
        editability,
      }
    }),
  }
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
    objectId: FIELD_POLICY_OBJECT_ID,
    fieldName: FIELD_POLICY_FIELD_NAME,
  })
  const candidateRows = mergeFieldPolicyRows(
    listDefaultFieldPolicies(FIELD_POLICY_OBJECT_ID, FIELD_POLICY_FIELD_NAME),
    registryRows,
  )
  const matchingRows = candidateRows.filter((row) => roleSlugs.includes(row.roleSlug))

  return buildFieldPolicyResponse(input.projectId, mergeEffectivePolicy(matchingRows))
}

module.exports = {
  DEFAULT_EFFECTIVE_POLICY,
  FIELD_POLICY_FIELD_NAME,
  FIELD_POLICY_OBJECT_ID,
  buildFieldPolicyRoleMatrix,
  buildFieldPolicyResponse,
  buildFieldPolicyUpdateMatrix,
  listDefaultFieldPolicies,
  listRegistryFieldPolicies,
  mergeEffectivePolicy,
  resolveFieldPolicyRoleSlugs,
  resolveFieldPoliciesForUser,
}
