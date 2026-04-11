/**
 * Approval Pinia Store
 *
 * Manages approval instance state: inbox tabs, detail, history, and actions.
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type {
  UnifiedApprovalDTO,
  UnifiedApprovalHistoryDTO,
  CreateApprovalRequest,
  ApprovalActionRequest,
} from '../types/approval'
import {
  listApprovals,
  getApproval,
  getApprovalHistory,
  createApproval,
  dispatchAction,
} from './api'
import type { ApprovalListQuery } from './api'

export const useApprovalStore = defineStore('approval', () => {
  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const approvals = ref<UnifiedApprovalDTO[]>([])
  const pendingApprovals = ref<UnifiedApprovalDTO[]>([])
  const myApprovals = ref<UnifiedApprovalDTO[]>([])
  const ccApprovals = ref<UnifiedApprovalDTO[]>([])
  const completedApprovals = ref<UnifiedApprovalDTO[]>([])
  const activeApproval = ref<UnifiedApprovalDTO | null>(null)
  const history = ref<UnifiedApprovalHistoryDTO[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const totalPending = ref(0)
  const totalMine = ref(0)
  const totalCc = ref(0)
  const totalCompleted = ref(0)

  // ---------------------------------------------------------------------------
  // Getters
  // ---------------------------------------------------------------------------
  const pendingCount = computed(() => pendingApprovals.value.length)
  const approvalById = computed(() => (id: string) =>
    approvals.value.find((a) => a.id === id),
  )

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  async function loadPending(query?: Omit<ApprovalListQuery, 'tab'>) {
    loading.value = true
    error.value = null
    try {
      const result = await listApprovals({ ...query, tab: 'pending' })
      pendingApprovals.value = result.data
      totalPending.value = result.total
    } catch (e: any) {
      error.value = e.message ?? '加载待处理审批失败'
    } finally {
      loading.value = false
    }
  }

  async function loadMine(query?: Omit<ApprovalListQuery, 'tab'>) {
    loading.value = true
    error.value = null
    try {
      const result = await listApprovals({ ...query, tab: 'mine' })
      myApprovals.value = result.data
      totalMine.value = result.total
    } catch (e: any) {
      error.value = e.message ?? '加载我发起的审批失败'
    } finally {
      loading.value = false
    }
  }

  async function loadCc(query?: Omit<ApprovalListQuery, 'tab'>) {
    loading.value = true
    error.value = null
    try {
      const result = await listApprovals({ ...query, tab: 'cc' })
      ccApprovals.value = result.data
      totalCc.value = result.total
    } catch (e: any) {
      error.value = e.message ?? '加载抄送审批失败'
    } finally {
      loading.value = false
    }
  }

  async function loadCompleted(query?: Omit<ApprovalListQuery, 'tab'>) {
    loading.value = true
    error.value = null
    try {
      const result = await listApprovals({ ...query, tab: 'completed' })
      completedApprovals.value = result.data
      totalCompleted.value = result.total
    } catch (e: any) {
      error.value = e.message ?? '加载已完成审批失败'
    } finally {
      loading.value = false
    }
  }

  async function loadDetail(id: string) {
    loading.value = true
    error.value = null
    try {
      activeApproval.value = await getApproval(id)
    } catch (e: any) {
      error.value = e.message ?? '加载审批详情失败'
    } finally {
      loading.value = false
    }
  }

  async function loadHistory(id: string) {
    loading.value = true
    error.value = null
    try {
      history.value = await getApprovalHistory(id)
    } catch (e: any) {
      error.value = e.message ?? '加载审批历史失败'
    } finally {
      loading.value = false
    }
  }

  async function submitApproval(req: CreateApprovalRequest): Promise<UnifiedApprovalDTO> {
    loading.value = true
    error.value = null
    try {
      const result = await createApproval(req)
      return result
    } catch (e: any) {
      error.value = e.message ?? '提交审批失败'
      throw e
    } finally {
      loading.value = false
    }
  }

  async function executeAction(id: string, req: ApprovalActionRequest): Promise<UnifiedApprovalDTO> {
    loading.value = true
    error.value = null
    try {
      const result = await dispatchAction(id, req)
      activeApproval.value = result
      return result
    } catch (e: any) {
      error.value = e.message ?? '执行审批操作失败'
      throw e
    } finally {
      loading.value = false
    }
  }

  return {
    // State
    approvals,
    pendingApprovals,
    myApprovals,
    ccApprovals,
    completedApprovals,
    activeApproval,
    history,
    loading,
    error,
    totalPending,
    totalMine,
    totalCc,
    totalCompleted,
    // Getters
    pendingCount,
    approvalById,
    // Actions
    loadPending,
    loadMine,
    loadCc,
    loadCompleted,
    loadDetail,
    loadHistory,
    submitApproval,
    executeAction,
  }
})
