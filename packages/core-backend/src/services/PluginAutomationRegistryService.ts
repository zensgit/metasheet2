import type { AutomationRuleDraft } from '../types/plugin'

export type AutomationRegistryQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export interface UpsertAutomationRulesInput {
  pluginId: string
  appId: string
  tenantId: string
  projectId: string
  templateId: string
  rules: AutomationRuleDraft[]
}

export interface ListAutomationRulesInput {
  pluginId: string
  appId: string
  tenantId: string
  projectId: string
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required`)
  }
  return value.trim()
}

function normalizeRule(rule: AutomationRuleDraft): AutomationRuleDraft {
  const id = requiredString(rule?.id, 'rule.id')
  const event = requiredString(rule?.trigger?.event, `rule(${id}).trigger.event`)
  const actions = Array.isArray(rule?.actions) ? rule.actions : []
  if (actions.length === 0) {
    throw new Error(`rule(${id}).actions must be a non-empty array`)
  }
  const conditions = Array.isArray(rule?.conditions) ? rule.conditions : []
  const rawFilter = Array.isArray(rule?.trigger?.filter) ? rule.trigger.filter : undefined

  return {
    id,
    trigger: {
      event,
      ...(rawFilter ? { filter: rawFilter } : {}),
    },
    conditions,
    actions,
    enabled: rule?.enabled !== false,
  }
}

function parseJsonColumn<T>(value: unknown, field: string): T {
  if (typeof value === 'string') {
    return JSON.parse(value) as T
  }
  if (value == null) {
    throw new Error(`registry column ${field} is null`)
  }
  return value as T
}

export async function listAutomationRules(
  query: AutomationRegistryQueryFn,
  input: ListAutomationRulesInput,
): Promise<AutomationRuleDraft[]> {
  const tenantId = requiredString(input?.tenantId, 'tenantId')
  const pluginId = requiredString(input?.pluginId, 'pluginId')
  const appId = requiredString(input?.appId, 'appId')
  const projectId = requiredString(input?.projectId, 'projectId')

  const result = await query(
    `SELECT rule_id, trigger_json, conditions_json, actions_json, enabled
     FROM plugin_automation_rule_registry
     WHERE tenant_id = $1
       AND plugin_id = $2
       AND app_id = $3
       AND project_id = $4
     ORDER BY rule_id ASC`,
    [tenantId, pluginId, appId, projectId],
  )

  return (result.rows as Array<{
    rule_id?: unknown
    trigger_json?: unknown
    conditions_json?: unknown
    actions_json?: unknown
    enabled?: unknown
  }>).map((row) => ({
    id: requiredString(row.rule_id, 'rule_id'),
    trigger: parseJsonColumn<AutomationRuleDraft['trigger']>(row.trigger_json, 'trigger_json'),
    conditions: parseJsonColumn<AutomationRuleDraft['conditions']>(row.conditions_json, 'conditions_json') || [],
    actions: parseJsonColumn<AutomationRuleDraft['actions']>(row.actions_json, 'actions_json'),
    enabled: row.enabled !== false,
  }))
}

export async function upsertAutomationRules(
  query: AutomationRegistryQueryFn,
  input: UpsertAutomationRulesInput,
): Promise<AutomationRuleDraft[]> {
  const tenantId = requiredString(input?.tenantId, 'tenantId')
  const pluginId = requiredString(input?.pluginId, 'pluginId')
  const appId = requiredString(input?.appId, 'appId')
  const projectId = requiredString(input?.projectId, 'projectId')
  const templateId = requiredString(input?.templateId, 'templateId')
  const rules = Array.isArray(input?.rules) ? input.rules.map(normalizeRule) : []

  if (rules.length > 0) {
    await query(
      `UPDATE plugin_automation_rule_registry
       SET enabled = FALSE,
           updated_at = now()
       WHERE tenant_id = $1
         AND plugin_id = $2
         AND app_id = $3
         AND project_id = $4
         AND rule_id <> ALL($5::text[])`,
      [tenantId, pluginId, appId, projectId, rules.map((rule) => rule.id)],
    )
  } else {
    await query(
      `UPDATE plugin_automation_rule_registry
       SET enabled = FALSE,
           updated_at = now()
       WHERE tenant_id = $1
         AND plugin_id = $2
         AND app_id = $3
         AND project_id = $4`,
      [tenantId, pluginId, appId, projectId],
    )
  }

  for (const rule of rules) {
    await query(
      `INSERT INTO plugin_automation_rule_registry (
         tenant_id, plugin_id, app_id, project_id, template_id, rule_id,
         trigger_json, conditions_json, actions_json, enabled
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7::jsonb, $8::jsonb, $9::jsonb, $10
       )
       ON CONFLICT (tenant_id, plugin_id, app_id, project_id, rule_id) DO UPDATE SET
         template_id = EXCLUDED.template_id,
         trigger_json = EXCLUDED.trigger_json,
         conditions_json = EXCLUDED.conditions_json,
         actions_json = EXCLUDED.actions_json,
         enabled = EXCLUDED.enabled,
         updated_at = now()`,
      [
        tenantId,
        pluginId,
        appId,
        projectId,
        templateId,
        rule.id,
        JSON.stringify(rule.trigger),
        JSON.stringify(rule.conditions || []),
        JSON.stringify(rule.actions),
        rule.enabled,
      ],
    )
  }

  return listAutomationRules(query, {
    tenantId,
    pluginId,
    appId,
    projectId,
  })
}
