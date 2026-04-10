import { describe, expect, it } from 'vitest'

import {
  listAutomationRules,
  upsertAutomationRules,
  type AutomationRegistryQueryFn,
} from '../../src/services/PluginAutomationRegistryService'

type RegistryRow = {
  tenant_id: string
  plugin_id: string
  app_id: string
  project_id: string
  template_id: string
  rule_id: string
  trigger_json: string
  conditions_json: string
  actions_json: string
  enabled: boolean
}

function createQuery(): AutomationRegistryQueryFn {
  const rows: RegistryRow[] = []
  return async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (normalized.startsWith('INSERT INTO plugin_automation_rule_registry')) {
      const [
        tenantId,
        pluginId,
        appId,
        projectId,
        templateId,
        ruleId,
        triggerJson,
        conditionsJson,
        actionsJson,
        enabled,
      ] = params as [string, string, string, string, string, string, string, string, string, boolean]
      const existing = rows.find((row) =>
        row.tenant_id === tenantId &&
        row.plugin_id === pluginId &&
        row.app_id === appId &&
        row.project_id === projectId &&
        row.rule_id === ruleId)
      if (existing) {
        existing.template_id = templateId
        existing.trigger_json = triggerJson
        existing.conditions_json = conditionsJson
        existing.actions_json = actionsJson
        existing.enabled = enabled
      } else {
        rows.push({
          tenant_id: tenantId,
          plugin_id: pluginId,
          app_id: appId,
          project_id: projectId,
          template_id: templateId,
          rule_id: ruleId,
          trigger_json: triggerJson,
          conditions_json: conditionsJson,
          actions_json: actionsJson,
          enabled,
        })
      }
      return { rows: [] }
    }

    if (normalized.startsWith('UPDATE plugin_automation_rule_registry')) {
      if (normalized.includes('rule_id <> ALL')) {
        const [tenantId, pluginId, appId, projectId, keepRuleIds] = params as [
          string,
          string,
          string,
          string,
          string[],
        ]
        for (const row of rows) {
          if (
            row.tenant_id === tenantId &&
            row.plugin_id === pluginId &&
            row.app_id === appId &&
            row.project_id === projectId &&
            !keepRuleIds.includes(row.rule_id)
          ) {
            row.enabled = false
          }
        }
      } else {
        const [tenantId, pluginId, appId, projectId] = params as [string, string, string, string]
        for (const row of rows) {
          if (
            row.tenant_id === tenantId &&
            row.plugin_id === pluginId &&
            row.app_id === appId &&
            row.project_id === projectId
          ) {
            row.enabled = false
          }
        }
      }
      return { rows: [] }
    }

    if (normalized.startsWith('SELECT rule_id, trigger_json, conditions_json, actions_json, enabled')) {
      const [tenantId, pluginId, appId, projectId] = params as [string, string, string, string]
      return {
        rows: rows
          .filter((row) =>
            row.tenant_id === tenantId &&
            row.plugin_id === pluginId &&
            row.app_id === appId &&
            row.project_id === projectId)
          .sort((a, b) => a.rule_id.localeCompare(b.rule_id)),
      }
    }

    throw new Error(`Unexpected SQL in automation registry test: ${normalized}`)
  }
}

describe('PluginAutomationRegistryService', () => {
  it('upserts and lists rules by plugin/app/project scope', async () => {
    const query = createQuery()

    const first = await upsertAutomationRules(query, {
      tenantId: 'tenant_42',
      pluginId: 'plugin-after-sales',
      appId: 'after-sales',
      projectId: 'tenant_42:after-sales',
      templateId: 'after-sales-default',
      rules: [
        {
          id: 'ticket-triage',
          trigger: { event: 'ticket.created' },
          conditions: [],
          actions: [{ type: 'assign' }],
          enabled: true,
        },
      ],
    })

    expect(first).toEqual([
      {
        id: 'ticket-triage',
        trigger: { event: 'ticket.created' },
        conditions: [],
        actions: [{ type: 'assign' }],
        enabled: true,
      },
    ])

    await upsertAutomationRules(query, {
      tenantId: 'tenant_42',
      pluginId: 'plugin-after-sales',
      appId: 'after-sales',
      projectId: 'tenant_42:after-sales',
      templateId: 'after-sales-default',
      rules: [
        {
          id: 'ticket-triage',
          trigger: { event: 'ticket.created' },
          conditions: [],
          actions: [{ type: 'assign' }, { type: 'sendNotification', topic: 'after-sales.ticket.assigned' }],
          enabled: false,
        },
      ],
    })

    const listed = await listAutomationRules(query, {
      tenantId: 'tenant_42',
      pluginId: 'plugin-after-sales',
      appId: 'after-sales',
      projectId: 'tenant_42:after-sales',
    })

    expect(listed).toEqual([
      {
        id: 'ticket-triage',
        trigger: { event: 'ticket.created' },
        conditions: [],
        actions: [{ type: 'assign' }, { type: 'sendNotification', topic: 'after-sales.ticket.assigned' }],
        enabled: false,
      },
    ])
  })

  it('retires omitted rules instead of leaving them enabled', async () => {
    const query = createQuery()

    await upsertAutomationRules(query, {
      tenantId: 'tenant_42',
      pluginId: 'plugin-after-sales',
      appId: 'after-sales',
      projectId: 'tenant_42:after-sales',
      templateId: 'after-sales-default',
      rules: [
        {
          id: 'ticket-triage',
          trigger: { event: 'ticket.created' },
          conditions: [],
          actions: [{ type: 'assign' }],
          enabled: true,
        },
        {
          id: 'refund-approval',
          trigger: { event: 'ticket.refundRequested' },
          conditions: [],
          actions: [{ type: 'submitApproval' }],
          enabled: true,
        },
      ],
    })

    const listed = await upsertAutomationRules(query, {
      tenantId: 'tenant_42',
      pluginId: 'plugin-after-sales',
      appId: 'after-sales',
      projectId: 'tenant_42:after-sales',
      templateId: 'after-sales-default',
      rules: [
        {
          id: 'ticket-triage',
          trigger: { event: 'ticket.created' },
          conditions: [],
          actions: [{ type: 'assign' }],
          enabled: true,
        },
      ],
    })

    expect(listed).toEqual([
      {
        id: 'refund-approval',
        trigger: { event: 'ticket.refundRequested' },
        conditions: [],
        actions: [{ type: 'submitApproval' }],
        enabled: false,
      },
      {
        id: 'ticket-triage',
        trigger: { event: 'ticket.created' },
        conditions: [],
        actions: [{ type: 'assign' }],
        enabled: true,
      },
    ])
  })

  it('retires all scoped rules when reinstall sync provides an empty rule set', async () => {
    const query = createQuery()

    await upsertAutomationRules(query, {
      tenantId: 'tenant_42',
      pluginId: 'plugin-after-sales',
      appId: 'after-sales',
      projectId: 'tenant_42:after-sales',
      templateId: 'after-sales-default',
      rules: [
        {
          id: 'ticket-triage',
          trigger: { event: 'ticket.created' },
          conditions: [],
          actions: [{ type: 'assign' }],
          enabled: true,
        },
      ],
    })

    const listed = await upsertAutomationRules(query, {
      tenantId: 'tenant_42',
      pluginId: 'plugin-after-sales',
      appId: 'after-sales',
      projectId: 'tenant_42:after-sales',
      templateId: 'after-sales-default',
      rules: [],
    })

    expect(listed).toEqual([
      {
        id: 'ticket-triage',
        trigger: { event: 'ticket.created' },
        conditions: [],
        actions: [{ type: 'assign' }],
        enabled: false,
      },
    ])
  })
})
