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
  // B3-01 (我已处理 5th tab): every instance the actor has ANY approval_records row for, ANY status.
  const processedApprovals = ref<UnifiedApprovalDTO[]>([])
  const activeApproval = ref<UnifiedApprovalDTO | null>(null)
  const history = ref<UnifiedApprovalHistoryDTO[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const totalPending = ref(0)
  const totalMine = ref(0)
  const totalCc = ref(0)
  const totalCompleted = ref(0)
  const totalProcessed = ref(0)

  // ---------------------------------------------------------------------------
  // Detail/history request generations (instance consistency, 2026-09-06)
  // ---------------------------------------------------------------------------
  // `loadDetail`/`loadHistory` are re-entrant: a detail→detail navigation starts a second request
  // while the first is still in flight, and responses can settle in either order. Without a
  // generation, whichever response lands LAST wins, so a slow request for the outgoing instance can
  // overwrite the freshly-loaded incoming one — the store then holds an instance the page is no
  // longer on. Each loader takes the next generation before it awaits and writes state ONLY while
  // it is still the newest one; a superseded response is discarded entirely (state, error and the
  // loading flag alike). Plain `let` counters rather than refs: nothing renders them, and they must
  // not be reactive dependencies of anything.
  let detailGeneration = 0
  let historyGeneration = 0
  // Instance the rows currently in `history` were loaded for, so a switch can drop them before the
  // new request settles (the detail equivalent reads `activeApproval.value.id` directly).
  let historyInstanceId: string | null = null
  // Detail-scoped in-flight flag. `loading` is shared with the list loaders AND `loadHistory`, so it
  // cannot answer "is THIS instance's detail still loading" — whichever of the two parallel detail
  // page requests finishes first clears it. Consumers that must not act on a half-loaded instance
  // read this one.
  const detailLoading = ref(false)

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

  async function loadProcessed(query?: Omit<ApprovalListQuery, 'tab'>) {
    loading.value = true
    error.value = null
    try {
      const result = await listApprovals({ ...query, tab: 'processed' })
      processedApprovals.value = result.data
      totalProcessed.value = result.total
    } catch (e: any) {
      error.value = e.message ?? '加载我已处理的审批失败'
    } finally {
      loading.value = false
    }
  }

  /**
   * Load one instance's detail into `activeApproval`.
   *
   * Instance consistency (2026-09-06): switching instances drops the outgoing detail SYNCHRONOUSLY,
   * before the new request is even sent, so nothing can render (or act on) the previous instance
   * while the next one is loading. A same-id reload keeps the current detail on screen — that is the
   * refresh case (retry, post-action refresh), not a switch. A failed load never leaves ANOTHER
   * instance's data under this instance's route.
   *
   * The failure branch is deliberately CROSS-INSTANCE ONLY (round 2). Clearing unconditionally was
   * wider than the rule it was meant to express: the cross-instance case is already handled by the
   * synchronous switch clear above (the slot is empty by the time the request is even sent), so the
   * unconditional clear's only observable effect was the SAME-id case — a retry or a post-action
   * refresh of the instance on screen hitting a transient error blanked a correctly-displayed page
   * to 未找到该审批. The reader now keeps the instance they were reading, with the error alert (and its
   * 重新加载) above it. See the two specs named "a failed reload of the SAME instance …".
   */
  async function loadDetail(id: string) {
    const generation = (detailGeneration += 1)
    if (activeApproval.value && activeApproval.value.id !== id) activeApproval.value = null
    detailLoading.value = true
    loading.value = true
    error.value = null
    try {
      const result = await getApproval(id)
      // Superseded by a newer load: discard rather than overwrite the newer instance's state.
      if (generation !== detailGeneration) return
      activeApproval.value = result
    } catch (e: any) {
      if (generation !== detailGeneration) return
      // Only ANOTHER instance is dropped here — never the one this load was for (see the doc above).
      if (activeApproval.value && activeApproval.value.id !== id) activeApproval.value = null
      error.value = e.message ?? '加载审批详情失败'
    } finally {
      if (generation === detailGeneration) {
        detailLoading.value = false
        loading.value = false
      }
    }
  }

  /**
   * Same generation discipline as `loadDetail`, on its own counter: the timeline is rendered beside
   * the detail, so a slow response for the outgoing instance must not repopulate it (or raise that
   * instance's error) once the page has moved on.
   *
   * Deliberately asymmetric with `loadDetail` on ONE point: a failure here does NOT clear the rows.
   * The detail is what actions are gated on, so its identity has to be re-established by every load;
   * the timeline is display-only and already instance-scoped by the switch clear above, and dropping
   * its rows on a failure would empty a timeline the reader has just added to whenever the
   * post-action refresh (`submitAction` → `loadHistory`) hits a transient error.
   *
   * Round 2: the timeline belongs to the instance that is DISPLAYED. A refresh for a DIFFERENT
   * instance — the post-verb `loadHistory(id)` of an action whose response arrived after the page
   * had already moved on — is refused outright rather than allowed to take the newest generation:
   * taking it would empty the displayed instance's timeline synchronously and then repopulate it
   * with the outgoing instance's rows. The predicate is the store's OWN state (`activeApproval`),
   * never the route: routing is the view's concern and must not be imported here. It is inert on
   * every legitimate path — a switch runs `loadDetail` first, whose synchronous clear empties the
   * slot, a same-id refresh compares equal, and a first load has no instance yet.
   *
   * It therefore DEPENDS on every DTO published into `activeApproval` carrying the id it was fetched
   * or dispatched for. That is the same assumption the view's action gate already rests on
   * (`displayedInstanceId === routeInstanceId` would fail too, disabling every control), and the
   * server holds it up: both `ApprovalProductService.dispatchAction` and
   * `ApprovalBridgeService.dispatchAction` return `getApproval(id, …)` for the id they were called
   * with, mapped by `toUnifiedApprovalDTO` as `id: row.id`. The pin for it is the post-verb refresh
   * test in `approval-store-detail-generation.spec.ts`; if that contract ever changes, the timeline
   * would go stale SILENTLY, which is why it is written down here rather than left to the fixture.
   */
  async function loadHistory(id: string) {
    const displayed = activeApproval.value
    if (displayed && displayed.id !== id) return
    const generation = (historyGeneration += 1)
    if (historyInstanceId !== id) history.value = []
    historyInstanceId = id
    loading.value = true
    error.value = null
    try {
      const result = await getApprovalHistory(id)
      if (generation !== historyGeneration) return
      history.value = result
    } catch (e: any) {
      if (generation !== historyGeneration) return
      error.value = e.message ?? '加载审批历史失败'
    } finally {
      if (generation === historyGeneration) loading.value = false
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
    // The request itself and its return value (success OR throw) are untouched — the caller always
    // gets the result or the rejection and can render it in its own dialog. What IS generation-
    // scoped is every write into the store's SHARED slots: `activeApproval`, `error` and `loading`.
    // An action started for one instance that settles after the page has moved to another must not
    // publish its (now foreign) DTO as the active detail, must not raise that instance's failure as
    // the page-level error banner on the instance now on screen, and must not clear the in-flight
    // flag a newer detail load is relying on. Round 2 added the `error`/`loading` halves; the
    // `activeApproval` half shipped in round 1.
    const generation = detailGeneration
    try {
      const result = await dispatchAction(id, req)
      if (generation === detailGeneration) activeApproval.value = result
      return result
    } catch (e: any) {
      if (generation === detailGeneration) error.value = e.message ?? '执行审批操作失败'
      throw e
    } finally {
      // A newer `loadDetail` owns `loading` once it has taken a generation, and clears it in its own
      // `finally` — so skipping here cannot strand the flag.
      if (generation === detailGeneration) loading.value = false
    }
  }

  return {
    // State
    approvals,
    pendingApprovals,
    myApprovals,
    ccApprovals,
    completedApprovals,
    processedApprovals,
    activeApproval,
    history,
    loading,
    detailLoading,
    error,
    totalPending,
    totalMine,
    totalCc,
    totalCompleted,
    totalProcessed,
    // Getters
    pendingCount,
    approvalById,
    // Actions
    loadPending,
    loadMine,
    loadCc,
    loadCompleted,
    loadProcessed,
    loadDetail,
    loadHistory,
    submitApproval,
    executeAction,
  }
})
