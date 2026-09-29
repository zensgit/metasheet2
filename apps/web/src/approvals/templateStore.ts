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
  //   • `loading` is released on the SHARED TICKET below, deliberately. It is a one-bit slot owned
  //     by the newest read of ANY kind: if a newer read exists it will clear it, and if none does
  //     this read must clear it even though the session has changed — otherwise a sign-out (or any
  //     switch that issues no successor read) leaves the spinner up with nothing left alive to take
  //     it down.
  //
  // The return value is how a caller learns which of the three happened to ITS read, instead of
  // inferring it from a slot it does not own.
  //
  // ── WHO OWNS THE SHARED SLOTS, stated accurately (round-5, gate C-7 / P3-3) ──────────────────
  //
  // `loading` and `error` are ONE slot each for the whole app and this store has THREE writers, not
  // one: `loadTemplates`, `loadTemplate` and `loadVersion`. Round 4 gave the algebra to the list
  // read only and then described `loading` as "a one-bit slot owned by the newest read" — which was
  // an assertion, not an invariant, because a per-kind counter cannot arbitrate between kinds. The
  // reachable consequence was measured, not predicted: all three sibling routes bind these slots
  // (`ApprovalNewView.vue:12,25`, `TemplateDetailView.vue:17,49,62`, `ApprovalDetailView.vue:89,103`),
  // so navigating away from the template centre with a list read still in flight let that read's
  // `finally` clear the spinner the DETAIL page was holding — `ApprovalDetailView.vue:1269` already
  // had to keep a detail-scoped flag of its own because of it.
  //
  // `loading` is therefore arbitrated by ONE ticket taken by every read of every kind, which is what
  // makes the sentence above true as written. The CONTENT slots stay per-kind on purpose:
  // `ApprovalDetailView.vue:2957,2964` issues `loadTemplate` and `loadVersion` CONCURRENTLY into
  // different slots, so arbitrating those two against each other with a single counter would throw
  // away whichever of them answered second-to-last.
  //
  // WHAT THIS DOES NOT CLOSE, said plainly rather than left for a reader to discover: `error` is
  // still written per-kind. Each writer now suppresses its own stale/foreign-session answer, but a
  // list read's failure and a detail read's failure are not arbitrated against EACH OTHER — the
  // later writer wins, as before. Closing that means either a per-surface error slot or a shared
  // ticket on `error` too, and it is outside the population round 4's gate named (two overlapping
  // `loadData()` calls on one page). It is registered here, not asserted away.
  let listGeneration = 0
  let detailGeneration = 0
  let versionGeneration = 0
  let sharedLoadingTicket = 0

  async function loadTemplates(query?: TemplateListQuery): Promise<ApprovalTemplateListOutcome> {
    const generation = ++listGeneration
    const ticket = ++sharedLoadingTicket
    const signature = readAuthSessionSignature()
    const isLatest = () => generation === listGeneration
    const ownsLoadingSlot = () => ticket === sharedLoadingTicket
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
      if (ownsLoadingSlot()) loading.value = false
    }
  }

  async function loadTemplate(id: string) {
    const generation = ++detailGeneration
    const ticket = ++sharedLoadingTicket
    const signature = readAuthSessionSignature()
    const isCurrent = () => generation === detailGeneration && signature === readAuthSessionSignature()
    const ownsLoadingSlot = () => ticket === sharedLoadingTicket
    loading.value = true
    error.value = null
    try {
      const detail = await getTemplate(id)
      if (!isCurrent()) return
      activeTemplate.value = detail
    } catch (e: any) {
      if (!isCurrent()) return
      error.value = e.message ?? '加载审批表单详情失败'
    } finally {
      if (ownsLoadingSlot()) loading.value = false
    }
  }

  async function loadVersion(templateId: string, versionId: string) {
    const generation = ++versionGeneration
    const ticket = ++sharedLoadingTicket
    const signature = readAuthSessionSignature()
    const isCurrent = () => generation === versionGeneration && signature === readAuthSessionSignature()
    const ownsLoadingSlot = () => ticket === sharedLoadingTicket
    loading.value = true
    error.value = null
    try {
      const version = await getTemplateVersion(templateId, versionId)
      if (!isCurrent()) return
      activeVersion.value = version
    } catch (e: any) {
      if (!isCurrent()) return
      error.value = e.message ?? '加载表单版本失败'
    } finally {
      if (ownsLoadingSlot()) loading.value = false
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
