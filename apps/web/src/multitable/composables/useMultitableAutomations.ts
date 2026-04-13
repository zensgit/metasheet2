import { ref } from 'vue'
import type { AutomationRule } from '../types'
import { MultitableApiClient, multitableClient } from '../api/client'

export function useMultitableAutomations(client?: MultitableApiClient) {
  const api = client ?? multitableClient
  const rules = ref<AutomationRule[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function loadRules(sheetId: string): Promise<void> {
    loading.value = true
    error.value = null
    try {
      rules.value = await api.listAutomationRules(sheetId)
    } catch (e: any) {
      error.value = e.message ?? 'Failed to load automation rules'
    } finally {
      loading.value = false
    }
  }

  async function createRule(
    sheetId: string,
    rule: Omit<AutomationRule, 'id' | 'sheetId' | 'enabled' | 'createdAt' | 'updatedAt' | 'createdBy'>,
  ): Promise<void> {
    error.value = null
    try {
      const created = await api.createAutomationRule(sheetId, rule)
      rules.value = [created, ...rules.value]
    } catch (e: any) {
      error.value = e.message ?? 'Failed to create automation rule'
      throw e
    }
  }

  async function updateRule(sheetId: string, ruleId: string, updates: Partial<AutomationRule>): Promise<void> {
    error.value = null
    try {
      await api.updateAutomationRule(sheetId, ruleId, updates)
      const idx = rules.value.findIndex((r) => r.id === ruleId)
      if (idx >= 0) {
        rules.value[idx] = { ...rules.value[idx], ...updates }
      }
    } catch (e: any) {
      error.value = e.message ?? 'Failed to update automation rule'
      throw e
    }
  }

  async function deleteRule(sheetId: string, ruleId: string): Promise<void> {
    error.value = null
    try {
      await api.deleteAutomationRule(sheetId, ruleId)
      rules.value = rules.value.filter((r) => r.id !== ruleId)
    } catch (e: any) {
      error.value = e.message ?? 'Failed to delete automation rule'
      throw e
    }
  }

  async function toggleRule(sheetId: string, ruleId: string, enabled: boolean): Promise<void> {
    await updateRule(sheetId, ruleId, { enabled })
  }

  return { rules, loading, error, loadRules, createRule, updateRule, deleteRule, toggleRule }
}
