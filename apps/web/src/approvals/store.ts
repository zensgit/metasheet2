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
  // Instance whose LAST detail load is known to have failed, or null when the last one succeeded /
  // none has finished yet. `error` cannot answer this: it is also written by `loadHistory`, by
  // `executeAction` and by every list loader, so a rejected timeline fetch or a rejected verb would
  // be indistinguishable from "the instance on screen could not be re-read". Written ONLY by
  // `loadDetail`. Consumers that must not act on an instance whose last refresh failed read this
  // one (round 3, B12).
  //
  // Round 4 (B15) — LIFECYCLE. This latch and the reader-facing banner are ONE fact, so the latch
  // is what the banner is derived from (see `ApprovalDetailView`), not the other way round. It is
  // therefore NOT cleared when a load merely starts:
  //
  //   * a load for ANOTHER instance drops it (the switch — the latch is per instance);
  //   * a successful settle for the instance it names drops it (the instance HAS been re-read);
  //   * a reload of the SAME instance keeps it for as long as that reload is outstanding, so the
  //     explanation and its 重新加载 stay on screen while the retry runs rather than blinking out.
  //
  // It follows that no OTHER writer of the shared `error` string can strand the refusal: round 3
  // cleared the latch on every load start, so `loadHistory`'s start, `executeAction`'s start, the
  // alert's own dismiss and every list loader could each null `error` while the latch stayed set —
  // controls disabled with nothing on screen saying so and no in-page retry. Deriving the banner
  // from the latch makes that unreachable by construction, for the whole population of `error`
  // writers rather than for an enumerated four.
  const detailErrorInstanceId = ref<string | null>(null)
  // Bumped every time `executeAction` publishes its OWN response into `activeApproval`, together
  // with the instance it published for. A detail read that was already in flight at that moment may
  // have reached the server BEFORE the action committed, so it must not overwrite the result the
  // reader has already been told succeeded (round 3, B8 — the reverse settle order of the same
  // race). Plain `let`s: nothing renders them and they must not be reactive dependencies.
  let actionPublishSeq = 0
  let actionPublishInstanceId: string | null = null

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
    // Round 3 (B8): remember where the action publication counter stood when this read was ISSUED,
    // so the settle path below can tell whether an action for this same instance published its own
    // response while the read was outstanding.
    const actionSeqAtIssue = actionPublishSeq
    if (activeApproval.value && activeApproval.value.id !== id) activeApproval.value = null
    detailLoading.value = true
    loading.value = true
    error.value = null
    // Round 4 (B15): the read-only latch is per INSTANCE, so only a load for a different instance
    // drops it here — a reload of the instance it names keeps it until that reload SUCCEEDS (see
    // the settle path below). This one comparison covers both switch shapes: the reader navigating
    // (`activeApproval` cleared just above) and a latch left over from a failed first-ever load,
    // which names an instance that was never displayed at all.
    if (detailErrorInstanceId.value !== id) detailErrorInstanceId.value = null
    try {
      const result = await getApproval(id)
      // Superseded by a newer load: discard rather than overwrite the newer instance's state.
      if (generation !== detailGeneration) return
      // Round 4 (B15): this instance HAS now been re-read, so the refusal is released — BEFORE the
      // action-authority return below, which is about which ROW wins, not about whether the read
      // succeeded. Releasing it after that return would let a latch set before the verb survive a
      // successful read, leaving the page read-only with no failing request left to explain it.
      detailErrorInstanceId.value = null
      // An action for THIS instance published its own response while this read was in flight. The
      // read is not necessarily older in wall-clock terms, but it is the only one of the two that
      // may have been served BEFORE the action committed, and the reader has already been shown
      // that the action succeeded — so the action's response stays. Falls through to `finally`, so
      // this load still clears the in-flight flags it owns. Same-instance only: a read for another
      // instance cannot be racing this instance's action (the switch clear + the publication guard
      // in `executeAction` already keep those apart).
      if (actionPublishSeq !== actionSeqAtIssue && actionPublishInstanceId === id) return
      activeApproval.value = result
    } catch (e: any) {
      if (generation !== detailGeneration) return
      // Only ANOTHER instance is dropped here — never the one this load was for (see the doc above).
      if (activeApproval.value && activeApproval.value.id !== id) activeApproval.value = null
      error.value = e.message ?? '加载审批详情失败'
      // Round 3 (B12): record WHICH instance could not be re-read, so the view can refuse write
      // verbs against data whose last refresh is known to have failed without having to guess from
      // the shared `error` string.
      detailErrorInstanceId.value = id
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

  /**
   * Dispatch a write verb for ONE instance.
   *
   * The request itself and its return value (success OR throw) are untouched — the caller always
   * gets the result or the rejection and can render it in its own dialog. What is scoped is every
   * write into the store's SHARED slots: `activeApproval`, `error` and `loading`.
   *
   * Round 3 (B8) replaces the DATA guard's predicate. It used to be the detail request generation
   * captured before the await, which answers "has any detail load started since?" — a question with
   * the wrong shape. A refresh of the SAME instance started while the verb was in flight (the
   * reader clicking 重新加载 over a failed timeline fetch is the reachable one) took a newer
   * generation, so the verb's own response — the freshest fact about that instance in the whole
   * page — was discarded, leaving a success announcement over pre-action data. The predicate is now
   * the INSTANCE: publish iff the instance still displayed is the one this verb acted on.
   *
   *   * same-id refresh in flight  → still displayed → the verb's result IS published (the defect);
   *   * cross-instance switch      → `loadDetail` cleared the slot synchronously, or the incoming
   *                                  instance is in it → not displayed → discarded silently;
   *   * nothing displayed at all   → not displayed → discarded (there is no page to publish onto,
   *                                  and this is the same state a switch leaves behind).
   *
   * The ORDER between a same-id refresh and the verb no longer decides the outcome either: a read
   * that was already in flight when this publication happened is refused by `loadDetail` (see
   * `actionPublishSeq` there), so the action's own response wins whichever settles last. That is the
   * rule for two same-instance writers: **an action's own response is authoritative over any detail
   * read concurrent with it**, because it is the only one of the two guaranteed to have been served
   * after the action committed.
   *
   * Round 4 (B16) — the FAILURE path, stated as a grid rather than as one sentence, because the
   * rule above is enforced per branch and not everywhere the sentence reads as if it were:
   *
   *   |                  | the concurrent read SUCCEEDS            | the concurrent read FAILS          |
   *   |------------------|-----------------------------------------|------------------------------------|
   *   | verb SUCCEEDED   | enforced — `loadDetail`'s success branch | NOT enforced — the read's own      |
   *   |                  | defers to the published row             | failure still writes `error` +     |
   *   |                  | (`actionPublishSeq`)                    | the read-only latch over it        |
   *   | verb FAILED      | enforced — the failure is surfaced iff  | both write; the read's failure is  |
   *   |                  | the acted instance is still displayed;  | about the READ and legitimately    |
   *   |                  | a read ALREADY IN FLIGHT cannot erase   | latches the instance read-only     |
   *   |                  | it (a later-ISSUED one does; see below) |                                    |
   *
   * Cell (succeeded × read fails) is a KNOWN residual, deliberately not closed in this round.
   *
   * The failure path's own two halves, both pinned in `approval-store-detail-generation.spec.ts`:
   *
   *   * SURFACED IFF STILL DISPLAYED — `error` is written under exactly the predicate the success
   *     branch publishes under (`actedInstanceStillDisplayed()`), never a looser one, so a verb
   *     that rejects after the reader has moved on raises nothing on the instance now on screen.
   *     The view applies the same rule to its own announcements (`stillActingOn` → `dialogError`).
   *   * NOT SWALLOWED, NOT RESURRECTED — a read CONCURRENT with the failure cannot erase it: reads
   *     clear `error` only at their START, which for a read that was already in flight necessarily
   *     precedes the failure, and no settle path of `loadDetail` clears `error` afterwards. This is
   *     deliberately about concurrency and not about all reads: a read ISSUED AFTER the failure DOES
   *     clear the string — that is `retryLoad`'s own semantics, the reader having asked for a
   *     reload — and what survives such a read is the read-only latch, which is now what the banner
   *     and its retry are derived from (B15). And a failure that was refused because the page had
   *     moved on is never replayed: nothing retains it, so navigating back to the acted instance
   *     re-reads it with a clean error surface.
   *
   * `loading` keeps the GENERATION predicate: that flag is about request ownership, not about which
   * instance is on screen. A newer `loadDetail` owns it once it has taken a generation and clears it
   * in its own `finally`, so skipping here cannot strand it.
   */
  async function executeAction(id: string, req: ApprovalActionRequest): Promise<UnifiedApprovalDTO> {
    loading.value = true
    error.value = null
    const generation = detailGeneration
    const actedInstanceStillDisplayed = () => activeApproval.value?.id === id
    try {
      const result = await dispatchAction(id, req)
      if (actedInstanceStillDisplayed()) {
        actionPublishSeq += 1
        actionPublishInstanceId = id
        activeApproval.value = result
      }
      return result
    } catch (e: any) {
      if (actedInstanceStillDisplayed()) error.value = e.message ?? '执行审批操作失败'
      throw e
    } finally {
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
    detailErrorInstanceId,
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
