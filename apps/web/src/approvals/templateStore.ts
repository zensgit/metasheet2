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
import { readAuthSessionSignature } from '../composables/authPrincipal'

/**
 * What one `loadTemplates()` call did to the shared slots, told to its own caller.
 *
 * `applied` — this answer IS the current one and is now in `templates`/`total`.
 * `failed`  — this answer is the current one and it failed; `error` holds its message.
 * `superseded` — a newer read, or a different session, owns the slots now; this call wrote
 *   NOTHING. A caller that renders "the rows are current again" must treat this exactly like
 *   `failed`: it learned nothing about the context it asked about.
 */
export type ApprovalTemplateListOutcome = 'applied' | 'failed' | 'superseded'

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
  // ── Request algebra for the shared LIST slots ───────────────────────────────────────────────
  //
  // `templates` / `total` / `error` / `loading` are ONE slot each for the whole app, and every
  // concurrent list read used to write all of them unconditionally on every exit. Two overlapping
  // reads therefore resolved by arrival order rather than by issue order: the older answer could
  // overwrite the newer rows, post its own error over the newer read's success, and clear the
  // newer read's `loading` before that read had answered. A caller could not even ask "did MY read
  // succeed?" — it could only look at a shared `error` slot that any other read may have written.
  //
  // Every read now takes a generation and stamps itself with the session signature it was issued
  // under, and each of the three exits is gated:
  //   • success / failure write the CONTENT slots only while this read is still the latest one AND
  //     still the session's — a read issued before a sign-out or an organization switch answers a
  //     question about a context this app has left, and its answer (including its failure) is not
  //     an answer about the current one.
  //   • `loading` is released on GENERATION alone, deliberately. It is a one-bit slot owned by the
  //     newest read: if a newer read exists it will clear it, and if none does this read must clear
  //     it even though the session has changed — otherwise a sign-out (or any switch that issues no
  //     successor read) leaves the spinner up with nothing left alive to take it down.
  //
  // The return value is how a caller learns which of the three happened to ITS read, instead of
  // inferring it from a slot it does not own.
  let listGeneration = 0

  async function loadTemplates(query?: TemplateListQuery): Promise<ApprovalTemplateListOutcome> {
    const generation = ++listGeneration
    const signature = readAuthSessionSignature()
    const isLatest = () => generation === listGeneration
    const isCurrent = () => isLatest() && signature === readAuthSessionSignature()
    loading.value = true
    error.value = null
    try {
      const result = await listTemplates(query)
      if (!isCurrent()) return 'superseded'
      templates.value = result.data
      total.value = result.total
      return 'applied'
    } catch (e: any) {
      if (!isCurrent()) return 'superseded'
      error.value = e.message ?? '加载审批表单列表失败'
      return 'failed'
    } finally {
      if (isLatest()) loading.value = false
    }
  }

  async function loadTemplate(id: string) {
    loading.value = true
    error.value = null
    try {
      activeTemplate.value = await getTemplate(id)
    } catch (e: any) {
      error.value = e.message ?? '加载审批表单详情失败'
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
      error.value = e.message ?? '加载表单版本失败'
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
