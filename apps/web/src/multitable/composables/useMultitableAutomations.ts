import { ref } from 'vue'
import type { AutomationRule } from '../types'
import { MultitableApiClient, multitableClient } from '../api/client'
import { useLocale } from '../../composables/useLocale'
import { automationLabel } from '../utils/meta-automation-labels'

export function useMultitableAutomations(client?: MultitableApiClient) {
  const api = client ?? multitableClient
  const { isZh } = useLocale()
  const rules = ref<AutomationRule[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  function errorMessage(e: any, fallbackKey: Parameters<typeof automationLabel>[0]): string {
    return e?.message ?? automationLabel(fallbackKey, isZh.value)
  }

  async function loadRules(sheetId: string): Promise<void> {
    loading.value = true
    error.value = null
    try {
      rules.value = await api.listAutomationRules(sheetId)
    } catch (e: any) {
      error.value = errorMessage(e, 'error.loadRules')
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
      error.value = errorMessage(e, 'error.createRule')
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
      error.value = errorMessage(e, 'error.updateRule')
      throw e
    }
  }

  async function deleteRule(sheetId: string, ruleId: string): Promise<void> {
    error.value = null
    try {
      await api.deleteAutomationRule(sheetId, ruleId)
      rules.value = rules.value.filter((r) => r.id !== ruleId)
    } catch (e: any) {
      error.value = errorMessage(e, 'error.deleteRule')
      throw e
    }
  }

  /**
   * #6155: after a failed toggle, show what the SERVER stored instead of what the panel assumed — a refusal
   * stored nothing, but a request that failed in transit may have been stored. Quiet on purpose: no `loading`
   * (the list must not blink away) and `error` is left alone (it carries the server's sentence). If the
   * re-read fails too, the local copy stays.
   */
  async function resyncRulesAfterFailedWrite(sheetId: string): Promise<void> {
    try {
      rules.value = await api.listAutomationRules(sheetId)
    } catch {
      // keep the local copy; `error` already says why the write failed
    }
  }

  async function toggleRule(sheetId: string, ruleId: string, enabled: boolean): Promise<void> {
    try {
      await updateRule(sheetId, ruleId, { enabled })
    } catch (e) {
      await resyncRulesAfterFailedWrite(sheetId)
      throw e
    }
  }

  return { rules, loading, error, loadRules, createRule, updateRule, deleteRule, toggleRule }
}
