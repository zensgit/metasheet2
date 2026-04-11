/**
 * Approval Template Pinia Store
 *
 * Manages approval template state: list, detail, and versions.
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  ApprovalTemplateListItemDTO,
  ApprovalTemplateDetailDTO,
  ApprovalTemplateVersionDetailDTO,
} from '../types/approval'
import {
  listTemplates,
  getTemplate,
  getTemplateVersion,
} from './api'
import type { TemplateListQuery } from './api'

export const useApprovalTemplateStore = defineStore('approvalTemplate', () => {
  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const templates = ref<ApprovalTemplateListItemDTO[]>([])
  const activeTemplate = ref<ApprovalTemplateDetailDTO | null>(null)
  const activeVersion = ref<ApprovalTemplateVersionDetailDTO | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const total = ref(0)

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  async function loadTemplates(query?: TemplateListQuery) {
    loading.value = true
    error.value = null
    try {
      const result = await listTemplates(query)
      templates.value = result.data
      total.value = result.total
    } catch (e: any) {
      error.value = e.message ?? '加载审批模板列表失败'
    } finally {
      loading.value = false
    }
  }

  async function loadTemplate(id: string) {
    loading.value = true
    error.value = null
    try {
      activeTemplate.value = await getTemplate(id)
    } catch (e: any) {
      error.value = e.message ?? '加载审批模板详情失败'
    } finally {
      loading.value = false
    }
  }

  async function loadVersion(templateId: string, versionId: string) {
    loading.value = true
    error.value = null
    try {
      activeVersion.value = await getTemplateVersion(templateId, versionId)
    } catch (e: any) {
      error.value = e.message ?? '加载模板版本失败'
    } finally {
      loading.value = false
    }
  }

  return {
    // State
    templates,
    activeTemplate,
    activeVersion,
    loading,
    error,
    total,
    // Actions
    loadTemplates,
    loadTemplate,
    loadVersion,
  }
})
