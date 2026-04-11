'use strict'

const {
  FIELD_POLICY_FIELD_NAME,
  FIELD_POLICY_OBJECT_ID,
  buildFieldPolicyRoleMatrix,
  buildFieldPolicyUpdateMatrix,
  listRegistryFieldPolicies,
} = require('./field-policies.cjs')

function titleizeIdentifier(value) {
  return String(value || '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function createValidationError(message, details) {
  const error = new Error(message)
  error.code = 'VALIDATION_FAILED'
  if (details && typeof details === 'object') {
    error.details = details
  }
  return error
}

function buildWorkflowNameMap(manifest) {
  const workflows = Array.isArray(manifest && manifest.workflows) ? manifest.workflows : []
  return new Map(
    workflows
      .filter((workflow) => workflow && typeof workflow.id === 'string' && workflow.id.trim())
      .map((workflow) => [workflow.id.trim(), typeof workflow.name === 'string' && workflow.name.trim()
        ? workflow.name.trim()
        : titleizeIdentifier(workflow.id)]),
  )
}

function buildDefaultAutomationEntries(blueprint, manifest) {
  const workflowNames = buildWorkflowNameMap(manifest)
  const automations = Array.isArray(blueprint && blueprint.automations) ? blueprint.automations : []

  return automations.map((rule) => ({
    id: typeof rule.id === 'string' ? rule.id : '',
    name: workflowNames.get(rule.id) || titleizeIdentifier(rule.id),
    triggerEvent:
      rule &&
      rule.trigger &&
      typeof rule.trigger === 'object' &&
      typeof rule.trigger.event === 'string'
        ? rule.trigger.event
        : '',
    enabled: rule && rule.enabled !== false,
  }))
}

function overlayAutomationEntries(defaultEntries, registryRules) {
  const enabledById = new Map()
  for (const rule of Array.isArray(registryRules) ? registryRules : []) {
    if (!rule || typeof rule.id !== 'string' || !rule.id.trim()) continue
    enabledById.set(rule.id.trim(), rule.enabled !== false)
  }

  return defaultEntries.map((entry) => ({
    ...entry,
    enabled: enabledById.has(entry.id) ? enabledById.get(entry.id) : entry.enabled,
  }))
}

function normalizeAutomationUpdates(defaultEntries, submittedAutomations) {
  const expectedRuleIds = defaultEntries.map((entry) => entry.id)
  const updates = Array.isArray(submittedAutomations) ? submittedAutomations : []
  const updatesById = new Map()

  for (const update of updates) {
    const id = update && typeof update.id === 'string' ? update.id.trim() : ''
    if (!id) {
      throw createValidationError('automation updates must include a non-empty id')
    }
    if (typeof update.enabled !== 'boolean') {
      throw createValidationError(`automation(${id}).enabled must be boolean`)
    }
    if (updatesById.has(id)) {
      throw createValidationError(`automation(${id}) is duplicated`)
    }
    updatesById.set(id, update.enabled)
  }

  const actualRuleIds = Array.from(updatesById.keys()).sort()
  const sortedExpectedRuleIds = [...expectedRuleIds].sort()
  if (
    actualRuleIds.length !== sortedExpectedRuleIds.length
    || actualRuleIds.some((ruleId, index) => ruleId !== sortedExpectedRuleIds[index])
  ) {
    throw createValidationError(
      'automations must include every default rule exactly once',
      { expectedRuleIds: sortedExpectedRuleIds },
    )
  }

  return defaultEntries.map((entry) => ({
    id: entry.id,
    enabled: updatesById.get(entry.id),
  }))
}

async function loadRuntimeAdminState(input) {
  const {
    database,
    automationRegistry,
    blueprint,
    manifest,
    tenantId,
    pluginId,
    appId,
    projectId,
  } = input || {}

  if (!database || typeof database.query !== 'function') {
    throw new Error('database.query is required for runtime admin')
  }
  if (!automationRegistry || typeof automationRegistry.listRules !== 'function') {
    throw new Error('automationRegistry.listRules is required for runtime admin')
  }

  const defaultAutomationEntries = buildDefaultAutomationEntries(blueprint, manifest)
  const registryRules = await automationRegistry.listRules({
    tenantId,
    pluginId,
    appId,
    projectId,
  })
  const registryFieldPolicies = await listRegistryFieldPolicies(database, {
    tenantId,
    pluginId,
    appId,
    projectId,
    objectId: FIELD_POLICY_OBJECT_ID,
    fieldName: FIELD_POLICY_FIELD_NAME,
  })

  return {
    projectId,
    automations: overlayAutomationEntries(defaultAutomationEntries, registryRules),
    fieldPolicies: {
      objectId: FIELD_POLICY_OBJECT_ID,
      field: FIELD_POLICY_FIELD_NAME,
      roles: buildFieldPolicyRoleMatrix(
        Array.isArray(blueprint && blueprint.roles) ? blueprint.roles : [],
        Array.isArray(blueprint && blueprint.fieldPolicies) ? blueprint.fieldPolicies : [],
        registryFieldPolicies,
      ),
    },
  }
}

function buildAutomationUpdateRules(blueprint, manifest, submittedAutomations) {
  const defaultAutomationEntries = buildDefaultAutomationEntries(blueprint, manifest)
  const normalizedUpdates = normalizeAutomationUpdates(defaultAutomationEntries, submittedAutomations)
  const updatesById = new Map(normalizedUpdates.map((update) => [update.id, update.enabled]))

  return (Array.isArray(blueprint && blueprint.automations) ? blueprint.automations : []).map((rule) => ({
    ...clone(rule),
    enabled: updatesById.get(rule.id),
  }))
}

function buildFieldPolicyUpdatePayload(blueprint, submittedRoles) {
  return buildFieldPolicyUpdateMatrix(
    Array.isArray(blueprint && blueprint.roles) ? blueprint.roles : [],
    Array.isArray(blueprint && blueprint.fieldPolicies) ? blueprint.fieldPolicies : [],
    submittedRoles,
  )
}

module.exports = {
  buildAutomationUpdateRules,
  buildFieldPolicyUpdatePayload,
  loadRuntimeAdminState,
}
