<template>
  <PageShell width="default">
    <PageHeader class="approval-center__header" title="审批中心">
      <template #actions>
        <div class="approval-center__toolbar">
          <el-input
            v-model="searchText"
            placeholder="搜索审批编号或标题"
            clearable
            class="approval-center__toolbar-search"
            @clear="handleSearch"
            @keyup.enter="handleSearch"
          >
            <template #prefix>
              <el-icon><Search /></el-icon>
            </template>
          </el-input>
          <el-select
            v-model="statusFilter"
            placeholder="状态筛选"
            clearable
            class="approval-center__toolbar-select"
            @change="handleSearch"
          >
            <el-option label="待处理" value="pending" />
            <el-option label="已通过" value="approved" />
            <el-option label="已驳回" value="rejected" />
            <el-option label="已撤回" value="revoked" />
          </el-select>
          <el-select
            v-model="sourceSystemFilter"
            placeholder="来源系统"
            class="approval-center__toolbar-select"
            data-testid="approval-source-filter"
            @change="handleSourceSystemChange"
          >
            <el-option label="全部来源" value="all" />
            <el-option label="平台审批" value="platform" />
            <el-option label="PLM 审批" value="plm" />
          </el-select>
          <el-button
            v-if="canWrite"
            type="primary"
            class="approval-center__toolbar-button"
            @click="router.push({ name: 'approval-template-list' })"
          >
            发起审批
          </el-button>
        </div>
      </template>
    </PageHeader>

    <el-alert
      v-if="store.error"
      :title="store.error"
      type="error"
      show-icon
      :closable="true"
      class="approval-center__error"
      @close="store.error = null"
    >
      <template #default>
        <el-button type="primary" link @click="loadCurrentTab">重新加载</el-button>
      </template>
    </el-alert>

    <el-tabs v-model="activeTab" class="approval-center__tabs" @tab-change="handleTabChange">
      <el-tab-pane name="pending">
        <!-- Wave 2 WP3 slice 1/2: 红点 / 未读计数 — badge shows `unreadCount`
             (未读), not the total `count` (待办). Hidden when unread is zero so
             the badge never renders an empty bubble. A tooltip surfaces the
             "待办 X / 其中 Y 未读" pair so the total is still discoverable
             without muddling the primary semantic. Refreshed on mount and on
             tab switch (slice 1) plus after 全部标记已读 (slice 2). -->
        <template #label>
          <span class="approval-center__tab-label">
            <span>待我处理</span>
            <el-tooltip
              v-if="pendingBadgeCount > 0"
              :content="`待办 ${pendingTotalCount} / 其中 ${pendingBadgeCount} 未读`"
              placement="top"
            >
              <el-badge
                :value="pendingBadgeCount"
                :max="99"
                class="approval-center__tab-badge"
                data-testid="approval-pending-badge"
              />
            </el-tooltip>
          </span>
        </template>
        <!-- Wave 2 WP3 slice 2 — bulk 全部标记已读. Disabled until the server
             reports at least one unread row for the current filter so clicking
             never issues a no-op round-trip.
             T3-1 v0: batch multi-select is desktop-only — checkbox fan-out over
             an el-table selection is not a touch gesture, and the mobile action
             set (ballot Q8) is approve/reject/comment/initiate only. -->
        <div v-if="!isMobileLayout" class="approval-center__tab-toolbar">
          <!-- 操作台: batch approve/reject over the current selection. Each row still runs the
               authoritative single-instance server transition (frontend fan-out, not a bulk endpoint). -->
          <span
            v-if="selectedPending.length > 0"
            class="approval-center__selection-count"
            data-testid="approval-selection-count"
          >已选 {{ selectedPending.length }} 项</span>
          <el-button
            type="success"
            plain
            :disabled="selectedPending.length === 0 || batchRunning"
            :loading="batchRunning && batchAction === 'approve'"
            data-testid="approval-batch-approve"
            @click="handleBatchApprove"
          >
            批量通过
          </el-button>
          <el-button
            type="danger"
            plain
            :disabled="selectedPending.length === 0 || batchRunning"
            :loading="batchRunning && batchAction === 'reject'"
            data-testid="approval-batch-reject"
            @click="openBatchReject"
          >
            批量驳回
          </el-button>
          <el-button
            type="primary"
            plain
            :disabled="pendingBadgeCount <= 0"
            :loading="markingAllRead"
            data-testid="approval-mark-all-read"
            @click="handleMarkAllRead"
          >
            全部标记已读
          </el-button>
        </div>
        <div
          class="approval-center__attendance-entry"
          data-testid="attendance-approval-queue-entry"
        >
          <div class="approval-center__attendance-entry-copy">
            <strong>考勤审批</strong>
            <p>
              补卡、请假、加班审批当前在考勤模块处理，不计入平台/PLM 待办列表。
            </p>
          </div>
          <el-button type="primary" plain @click="openAttendanceApprovalQueue">
            待处理考勤审批
          </el-button>
        </div>
        <ApprovalMobileList
          v-if="isMobileLayout"
          :approvals="store.pendingApprovals"
          :loading="store.loading"
          :empty-text="mobileEmptyText.pending"
          :template-schemas="templateSchemas"
          @select="handleRowClick"
        />
        <ApprovalCenterTable
          v-else
          ref="pendingTableRef"
          :rows="store.pendingApprovals"
          :loading="store.loading"
          :empty-text="searchText ? '未找到匹配的审批' : '暂无待处理审批'"
          :summary-line-for="summaryLineFor"
          show-selection
          :selectable="isRowBatchSelectable"
          show-wait-column
          :actions-width="150"
          @row-click="handleRowClick"
          @selection-change="handlePendingSelectionChange"
        >
          <!-- B1-03 (part 1): inline approve/reject hot path — only for platform-native pending
               rows (reuses `isRowBatchSelectable`; attendance-bridged rows keep routing to the
               attendance module via row-click and never show these). @click.stop on every
               reference so opening the popconfirm / reject dialog never also navigates the row. -->
          <template #actions="{ row }">
            <template v-if="isRowBatchSelectable(row)">
              <el-popconfirm
                :title="`确认通过「${row.title}」？`"
                confirm-button-text="确认"
                cancel-button-text="取消"
                @confirm="handleInlineApprove(row)"
              >
                <template #reference>
                  <el-button
                    type="primary"
                    link
                    :loading="inlineApprovingId === row.id"
                    :disabled="inlineApprovingId !== null"
                    :data-testid="`approval-row-approve-${row.id}`"
                    @click.stop
                  >
                    通过
                  </el-button>
                </template>
              </el-popconfirm>
              <el-button
                type="danger"
                link
                :disabled="inlineApprovingId !== null"
                :data-testid="`approval-row-reject-${row.id}`"
                @click.stop="openRowReject(row)"
              >
                驳回
              </el-button>
            </template>
          </template>
        </ApprovalCenterTable>
        <el-pagination
          class="approval-center__pagination"
          background
          layout="total, prev, pager, next"
          :total="store.totalPending"
          :current-page="currentPage"
          :page-size="pageSize"
          @update:current-page="handlePageChange"
        />
      </el-tab-pane>

      <el-tab-pane label="我发起的" name="mine">
        <ApprovalMobileList
          v-if="isMobileLayout"
          :approvals="store.myApprovals"
          :loading="store.loading"
          :empty-text="mobileEmptyText.mine"
          :template-schemas="templateSchemas"
          @select="handleRowClick"
        />
        <ApprovalCenterTable
          v-else
          :rows="store.myApprovals"
          :loading="store.loading"
          :empty-text="searchText ? '未找到匹配的审批' : '暂无我发起的审批'"
          :summary-line-for="summaryLineFor"
          :actions-width="170"
          @row-click="handleRowClick"
        >
          <!-- 催办: a requester nudge to the current approver, only meaningful while the instance is
               still pending. Server-side rate-limited (1/instance/user/hour); 429 surfaces gracefully.
               B1-03: 已等待 sits right next to it — the longer a request has waited, the more it
               motivates the requester to actually click 催办. -->
          <template #actions="{ row }">
            <span v-if="row.status === 'pending'" :class="waitClass(row.createdAt)">
              已等待 {{ formatRelativeWait(row.createdAt) }}
            </span>
            <el-button
              v-if="row.status === 'pending'"
              type="primary"
              link
              :loading="remindingId === row.id"
              :disabled="remindingId !== null"
              :data-testid="`approval-urge-${row.id}`"
              @click.stop="handleUrge(row)"
            >
              催办
            </el-button>
          </template>
        </ApprovalCenterTable>
        <el-pagination
          class="approval-center__pagination"
          background
          layout="total, prev, pager, next"
          :total="store.totalMine"
          :current-page="currentPage"
          :page-size="pageSize"
          @update:current-page="handlePageChange"
        />
      </el-tab-pane>

      <el-tab-pane label="抄送我的" name="cc">
        <ApprovalMobileList
          v-if="isMobileLayout"
          :approvals="store.ccApprovals"
          :loading="store.loading"
          :empty-text="mobileEmptyText.cc"
          :template-schemas="templateSchemas"
          @select="handleRowClick"
        />
        <ApprovalCenterTable
          v-else
          :rows="store.ccApprovals"
          :loading="store.loading"
          :empty-text="searchText ? '未找到匹配的审批' : '暂无抄送我的审批'"
          :summary-line-for="summaryLineFor"
          @row-click="handleRowClick"
        />
        <el-pagination
          class="approval-center__pagination"
          background
          layout="total, prev, pager, next"
          :total="store.totalCc"
          :current-page="currentPage"
          :page-size="pageSize"
          @update:current-page="handlePageChange"
        />
      </el-tab-pane>

      <el-tab-pane label="已完成" name="completed">
        <ApprovalMobileList
          v-if="isMobileLayout"
          :approvals="store.completedApprovals"
          :loading="store.loading"
          :empty-text="mobileEmptyText.completed"
          :template-schemas="templateSchemas"
          @select="handleRowClick"
        />
        <ApprovalCenterTable
          v-else
          :rows="store.completedApprovals"
          :loading="store.loading"
          :empty-text="searchText ? '未找到匹配的审批' : '暂无已完成审批'"
          :summary-line-for="summaryLineFor"
          @row-click="handleRowClick"
        />
        <el-pagination
          class="approval-center__pagination"
          background
          layout="total, prev, pager, next"
          :total="store.totalCompleted"
          :current-page="currentPage"
          :page-size="pageSize"
          @update:current-page="handlePageChange"
        />
      </el-tab-pane>
    </el-tabs>

    <!-- Batch reject: a comment is offered (some templates require one; a per-row failure is captured
         in the manifest rather than aborting the batch). -->
    <el-dialog
      v-model="batchRejectDialogVisible"
      title="批量驳回"
      width="440px"
      data-testid="approval-batch-reject-dialog"
    >
      <p class="approval-center__batch-reject-summary">
        将驳回所选的 {{ selectedPending.length }} 项审批。
      </p>
      <el-input
        v-model="batchRejectComment"
        type="textarea"
        :rows="3"
        :placeholder="batchRejectCommentRequired ? '驳回原因（必填）' : '驳回意见（选填）'"
        data-testid="approval-batch-reject-comment"
      />
      <template #footer>
        <el-button data-testid="approval-batch-reject-cancel" @click="batchRejectDialogVisible = false">取消</el-button>
        <el-button
          type="danger"
          :loading="batchRunning"
          :disabled="batchRejectConfirmDisabled"
          data-testid="approval-batch-reject-confirm"
          @click="handleBatchReject"
        >
          确认驳回
        </el-button>
      </template>
    </el-dialog>

    <!-- B1-03 (part 1): per-row reject dialog — mirrors the batch-reject dialog's comment/policy
         gating but targets a single row (`rowRejectTarget`); kept fully separate from the batch
         dialog's own state so the two flows never cross-contaminate each other's comment/error. -->
    <el-dialog
      v-model="rowRejectDialogVisible"
      title="驳回审批"
      width="440px"
      data-testid="approval-row-reject-dialog"
    >
      <el-alert
        v-if="rowRejectError"
        type="error"
        show-icon
        :closable="false"
        :title="rowRejectError"
        data-testid="approval-row-reject-error"
        class="approval-center__row-reject-error"
      />
      <p v-if="rowRejectTarget" class="approval-center__row-reject-summary">
        确认驳回「{{ rowRejectTarget.title }}」？
      </p>
      <el-input
        v-model="rowRejectComment"
        type="textarea"
        :rows="3"
        :placeholder="rowRejectCommentRequired ? '驳回原因（必填）' : '驳回意见（选填）'"
        data-testid="approval-row-reject-comment"
      />
      <template #footer>
        <el-button data-testid="approval-row-reject-cancel" @click="rowRejectDialogVisible = false">取消</el-button>
        <el-button
          type="danger"
          :loading="rowRejectSubmitting"
          :disabled="rowRejectConfirmDisabled"
          data-testid="approval-row-reject-confirm"
          @click="submitRowReject"
        >
          确认驳回
        </el-button>
      </template>
    </el-dialog>

    <!-- B1-03 (part 3): batch failure manifest — replaces the old collapsed toast whenever at
         least one row fails, so the operator sees WHICH rows failed and WHY, then can retry just
         the failed subset (same action + comment) without re-selecting anything. -->
    <el-dialog
      v-model="batchResultDialogVisible"
      title="批量处理结果"
      width="480px"
      data-testid="approval-batch-result-dialog"
    >
      <p class="approval-center__batch-result-summary">
        <template v-if="batchSucceededCount > 0">成功 {{ batchSucceededCount }} 项，失败 {{ batchFailureRows.length }} 项：</template>
        <template v-else>全部 {{ batchFailureRows.length }} 项处理失败：</template>
      </p>
      <ul class="approval-center__batch-result-list">
        <li
          v-for="row in batchFailureRows"
          :key="row.id"
          class="approval-center__batch-result-item"
        >
          <div class="approval-center__batch-result-item-title">{{ row.requestNo }} · {{ row.title }}</div>
          <div class="approval-center__batch-result-item-message">{{ row.message }}</div>
        </li>
      </ul>
      <template #footer>
        <el-button data-testid="approval-batch-result-close" @click="batchResultDialogVisible = false">关闭</el-button>
        <el-button
          type="primary"
          :loading="batchRunning"
          data-testid="approval-batch-retry"
          @click="retryBatchFailures"
        >
          重试失败项
        </el-button>
      </template>
    </el-dialog>
  </PageShell>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Search } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import type { UnifiedApprovalDTO, ApprovalStatus } from '../../types/approval'
import { useApprovalStore } from '../../approvals/store'
import { useApprovalPermissions } from '../../approvals/permissions'
import { dispatchAction, getPendingCount, markAllApprovalsRead, remindApproval } from '../../approvals/api'
import { runApprovalBatchAction, type ApprovalBatchActionResult } from '../../approvals/useApprovalBatchActions'
import { useApprovalCountsRealtime, type ApprovalCountsUpdatedPayload } from '../../approvals/useApprovalCountsRealtime'
import { useApprovalListFieldSummary } from '../../approvals/useApprovalListFieldSummary'
import { useFeatureFlags } from '../../stores/featureFlags'
import { useMobileViewport } from '../../composables/useMobileViewport'
import { useLocale } from '../../composables/useLocale'
import { formatRelativeWait, waitSeverity } from '../../approvals/relativeWait'
import ApprovalMobileList from './ApprovalMobileList.vue'
import ApprovalCenterTable from './ApprovalCenterTable.vue'
import PageShell from '../../components/layout/PageShell.vue'
import PageHeader from '../../components/layout/PageHeader.vue'

const router = useRouter()
const store = useApprovalStore()
const { canWrite } = useApprovalPermissions()

// B2-01 (待办列表关键字段摘要) — lazy per-templateId FormSchema cache + row summary-line lookup,
// shared by the desktop table below (all four tabs) and ApprovalMobileList (passed the raw
// `templateSchemas` cache as a prop). See `useApprovalListFieldSummary.ts` for the full rationale
// (live-template substitute for the list DTO's missing frozen formSchema, the live-label drift
// tradeoff, and the session-scoped negative caching on fetch failure).
const { schemas: templateSchemas, ensureLoadedForRows, summaryLineFor } = useApprovalListFieldSummary()
const allVisibleApprovals = computed<UnifiedApprovalDTO[]>(() => [
  ...store.pendingApprovals,
  ...store.myApprovals,
  ...store.ccApprovals,
  ...store.completedApprovals,
])
// `immediate: true` covers the case where a tab's data is already populated at setup time (e.g.
// a fresh mount whose store was pre-loaded); every subsequent load (tab switch/page/search/filter)
// re-fires this because `allVisibleApprovals` recomputes to a new array reference.
watch(allVisibleApprovals, (rows) => {
  void ensureLoadedForRows(rows)
}, { immediate: true })

// T3-1 v0 — mobile approval surface (ballot Q10/Q11). The layout switches to the
// touch-first card list ONLY when the tenant/user has opted in via the
// `approvalMobile` feature flag AND the viewport is narrow. The flag is loaded
// once by the app shell (main.ts / App.vue); this view reads it reactively and
// never triggers a load, so with the flag OFF the desktop table path is
// unchanged for every viewport.
const { hasFeature } = useFeatureFlags()
const { isMobile } = useMobileViewport()
const isMobileLayout = computed(() => hasFeature('approvalMobile') && isMobile.value)

// i18n follow-up (ballot T3-1 build-contract must-fix): the mobile card
// list's per-tab empty-state copy shipped in #3517 as hardcoded Chinese
// literals. Localize via the app's established `useLocale()` / `isZh`
// pattern instead of a hardcoded string per tab.
const { isZh } = useLocale()
const mobileEmptyText = computed(() => {
  if (isZh.value) {
    return {
      pending: searchText.value ? '未找到匹配的审批' : '暂无待处理审批',
      mine: searchText.value ? '未找到匹配的审批' : '暂无我发起的审批',
      cc: searchText.value ? '未找到匹配的审批' : '暂无抄送我的审批',
      completed: searchText.value ? '未找到匹配的审批' : '暂无已完成审批',
    }
  }
  return {
    pending: searchText.value ? 'No matching approvals found' : 'No pending approvals',
    mine: searchText.value ? 'No matching approvals found' : 'No approvals initiated by you',
    cc: searchText.value ? 'No matching approvals found' : 'No approvals cc’d to you',
    completed: searchText.value ? 'No matching approvals found' : 'No completed approvals',
  }
})

// ── 操作台: batch approve/reject over the pending selection ────────────────
const pendingTableRef = ref<{ clearSelection: () => void } | null>(null)
const selectedPending = ref<UnifiedApprovalDTO[]>([])
const batchRunning = ref(false)
const batchAction = ref<'approve' | 'reject' | null>(null)
const batchRejectDialogVisible = ref(false)
const batchRejectComment = ref('')
const remindingId = ref<string | null>(null)

// B1-03: 已等待 aging severity class — the 我发起的 tab's inline hint next to 催办 (same
// warn/urgent palette as ApprovalCenterTable's own internal 已等待 column, kept separate since
// this one lives in this view's `actions` slot content rather than the shared table body).
function waitClass(createdAt: string): string {
  return `approval-center__wait approval-center__wait--${waitSeverity(createdAt)}`
}

// Only platform-native pending rows are batch-actionable here; attendance-backed approvals live in the
// attendance module (their row-click routes away), so excluding them keeps the batch honest.
function isRowBatchSelectable(row: UnifiedApprovalDTO): boolean {
  return row.status === 'pending' && !isAttendanceApproval(row)
}

function handlePendingSelectionChange(rows: UnifiedApprovalDTO[]): void {
  selectedPending.value = rows.filter(isRowBatchSelectable)
}

function clearPendingSelection(): void {
  selectedPending.value = []
  // Guard the child API: the ref may be null (tab not rendered) or, under test stubs, a component
  // without ElTable's imperative methods — never let a missing clearSelection abort navigation.
  if (typeof pendingTableRef.value?.clearSelection === 'function') {
    pendingTableRef.value.clearSelection()
  }
}

// B1-03 (part 3): batch failure manifest. A collapsed toast used to be the ceiling of feedback
// for a partial/total batch failure — the operator could see a COUNT but not which rows or why.
// `batchFailureRows` carries each failure's title/requestNo (looked up from a snapshot of the
// selected rows taken at launch, since `loadCurrentTab()` reloads the list out from under the
// original selection before the operator gets to read the dialog) plus the server's own message.
interface ApprovalBatchFailureRow {
  id: string
  title: string
  requestNo: string
  message: string
}
const batchResultDialogVisible = ref(false)
const batchFailureRows = ref<ApprovalBatchFailureRow[]>([])
const batchSucceededCount = ref(0)
const lastBatchAction = ref<'approve' | 'reject'>('approve')
const lastBatchComment = ref('')
let batchRowSnapshot = new Map<string, UnifiedApprovalDTO>()

function buildFailureRows(failed: ApprovalBatchActionResult['failed']): ApprovalBatchFailureRow[] {
  return failed.map(({ id, message }) => {
    const row = batchRowSnapshot.get(id)
    return {
      id,
      title: row?.title ?? id,
      requestNo: row?.requestNo ?? '-',
      message,
    }
  })
}

async function dispatchBatchAndHandleResult(
  ids: string[],
  action: 'approve' | 'reject',
  comment: string,
): Promise<void> {
  const trimmed = comment.trim()
  const result = await runApprovalBatchAction(
    ids,
    () => (trimmed ? { action, comment: trimmed } : { action }),
    (id, req) => dispatchAction(id, req),
  )
  if (result.failed.length === 0) {
    ElMessage.success(`已${action === 'approve' ? '通过' : '驳回'} ${result.succeeded.length} 项`)
    batchResultDialogVisible.value = false
    batchFailureRows.value = []
  } else {
    // B1-03: any failure now opens the manifest dialog instead of a toast (whether partial or
    // total); only the all-success path above keeps today's light toast.
    lastBatchAction.value = action
    lastBatchComment.value = comment
    batchSucceededCount.value = result.succeeded.length
    batchFailureRows.value = buildFailureRows(result.failed)
    batchResultDialogVisible.value = true
  }
  clearPendingSelection()
  loadCurrentTab()
  void refreshPendingBadgeCount()
}

async function runBatch(action: 'approve' | 'reject', comment: string): Promise<void> {
  const rows = selectedPending.value
  if (rows.length === 0 || batchRunning.value) return
  batchRowSnapshot = new Map(rows.map((row) => [row.id, row]))
  batchRunning.value = true
  batchAction.value = action
  try {
    await dispatchBatchAndHandleResult(rows.map((row) => row.id), action, comment)
  } finally {
    batchRunning.value = false
    batchAction.value = null
  }
}

// 「重试失败项」— re-runs the SAME action + comment over just the ids still in the manifest.
// `batchRowSnapshot` already carries these rows' title/requestNo from the original launch, so a
// still-failing row keeps its label; `dispatchBatchAndHandleResult` overwrites `batchFailureRows`
// in place with whatever is left (or closes the dialog on full success).
async function retryBatchFailures(): Promise<void> {
  if (batchRunning.value) return
  const ids = batchFailureRows.value.map((row) => row.id)
  if (ids.length === 0) return
  batchRunning.value = true
  batchAction.value = lastBatchAction.value
  try {
    await dispatchBatchAndHandleResult(ids, lastBatchAction.value, lastBatchComment.value)
  } finally {
    batchRunning.value = false
    batchAction.value = null
  }
}

async function handleBatchApprove(): Promise<void> {
  await runBatch('approve', '')
}

function openBatchReject(): void {
  if (selectedPending.value.length === 0) return
  batchRejectComment.value = ''
  batchRejectDialogVisible.value = true
}

// B1-04 (宽恕型错误三件套 part 3): batch reject pre-flight. List rows already carry `policy`
// (UnifiedApprovalDTO.policy), so this mirrors the single-instance reject dialog's conservative
// default — required unless EVERY selected row's policy explicitly opts out with `false`.
const batchRejectCommentRequired = computed(() =>
  selectedPending.value.some((row) => row.policy?.rejectCommentRequired !== false),
)
const batchRejectConfirmDisabled = computed(() =>
  batchRejectCommentRequired.value && !batchRejectComment.value.trim(),
)

async function handleBatchReject(): Promise<void> {
  if (batchRejectConfirmDisabled.value) return
  await runBatch('reject', batchRejectComment.value)
  batchRejectDialogVisible.value = false
}

// ── B1-03 (part 1): inline approve/reject hot path on the pending list ─────
// `inlineApprovingId` gates every row's approve button (not just the clicked row) while a
// request is in flight — mirrors the existing `remindingId`-gates-every-催办-button convention
// below, so a slow request can't be raced by mashing a different row.
const inlineApprovingId = ref<string | null>(null)

async function handleInlineApprove(row: UnifiedApprovalDTO): Promise<void> {
  if (inlineApprovingId.value) return
  inlineApprovingId.value = row.id
  try {
    await dispatchAction(row.id, { action: 'approve' })
    ElMessage.success('审批已通过')
    loadCurrentTab()
    void refreshPendingBadgeCount()
  } catch (error) {
    ElMessage.error(error instanceof Error && error.message ? error.message : '操作失败，请重试')
  } finally {
    inlineApprovingId.value = null
  }
}

// Per-row reject dialog — deliberately its OWN state (`rowRejectTarget`/`rowRejectComment`/
// `rowRejectError`), never overloading the batch-reject dialog's refs above, so the two flows
// can never cross-contaminate each other's comment or error message.
const rowRejectDialogVisible = ref(false)
const rowRejectTarget = ref<UnifiedApprovalDTO | null>(null)
const rowRejectComment = ref('')
const rowRejectError = ref<string | null>(null)
const rowRejectSubmitting = ref(false)

function openRowReject(row: UnifiedApprovalDTO): void {
  rowRejectTarget.value = row
  rowRejectComment.value = ''
  rowRejectError.value = null
  rowRejectDialogVisible.value = true
}

// B1-04-style conservative default: required unless THIS row's policy explicitly opts out.
const rowRejectCommentRequired = computed(() => rowRejectTarget.value?.policy?.rejectCommentRequired !== false)
const rowRejectConfirmDisabled = computed(() => rowRejectCommentRequired.value && !rowRejectComment.value.trim())

async function submitRowReject(): Promise<void> {
  if (rowRejectConfirmDisabled.value || !rowRejectTarget.value) return
  const target = rowRejectTarget.value
  const trimmed = rowRejectComment.value.trim()
  rowRejectSubmitting.value = true
  rowRejectError.value = null
  try {
    await dispatchAction(target.id, trimmed ? { action: 'reject', comment: trimmed } : { action: 'reject' })
    ElMessage.success('审批已驳回')
    rowRejectDialogVisible.value = false
    loadCurrentTab()
    void refreshPendingBadgeCount()
  } catch (error) {
    // Mirrors B1-04's dialog-scoped inline error: keep the dialog open with the server's own
    // reason instead of a toast, so the typed comment is never lost on a retry-in-place.
    rowRejectError.value = error instanceof Error && error.message ? error.message : '操作失败，请重试'
  } finally {
    rowRejectSubmitting.value = false
  }
}

async function handleUrge(row: UnifiedApprovalDTO): Promise<void> {
  if (remindingId.value) return
  remindingId.value = row.id
  try {
    const result = await remindApproval(row.id)
    if (result.ok) {
      ElMessage.success('已发送催办提醒')
    } else if (result.status === 429) {
      const retry = result.error.retryAfterSeconds
      ElMessage.warning(retry ? `催办过于频繁，请 ${Math.ceil(retry / 60)} 分钟后再试` : '催办过于频繁，请稍后再试')
    } else {
      ElMessage.error(result.error.message || '催办失败，请重试')
    }
  } catch {
    ElMessage.error('催办失败，请重试')
  } finally {
    remindingId.value = null
  }
}

// Wave 2 WP3 slice 1/2: server-owned pending badge. Slice 1 drove the count
// off active assignments; slice 2 flips the primary semantic to `unreadCount`
// (rows the user hasn't opened). The total `count` is preserved for the
// tooltip so "待办 X / 其中 Y 未读" stays discoverable.
const pendingBadgeCount = ref(0)
const pendingTotalCount = ref(0)
function applyPendingBadgeCount(count: number, unreadCount: number): void {
  pendingBadgeCount.value = Number.isFinite(unreadCount) ? unreadCount : 0
  pendingTotalCount.value = Number.isFinite(count) ? count : 0
}

async function refreshPendingBadgeCount(): Promise<void> {
  try {
    const result = await getPendingCount(sourceSystemFilter.value)
    applyPendingBadgeCount(result.count, result.unreadCount)
  } catch {
    // Badge is decorative — do not surface errors here; the tab itself
    // surfaces list-load failures via `store.error`.
    pendingBadgeCount.value = 0
    pendingTotalCount.value = 0
  }
}

function handleRealtimeCountsUpdated(payload: ApprovalCountsUpdatedPayload): void {
  const scopedCounts = payload.countsBySourceSystem?.[sourceSystemFilter.value] ?? payload
  applyPendingBadgeCount(scopedCounts.count, scopedCounts.unreadCount)
}

useApprovalCountsRealtime({
  onCountsUpdated: handleRealtimeCountsUpdated,
})

// Wave 2 WP3 slice 2 — bulk 全部标记已读. Honours the current sourceSystem tab
// so the button's effect matches the tooltip the user is looking at.
const markingAllRead = ref(false)
async function handleMarkAllRead(): Promise<void> {
  if (markingAllRead.value) return
  markingAllRead.value = true
  try {
    const result = await markAllApprovalsRead(sourceSystemFilter.value)
    ElMessage.success(result.markedCount > 0
      ? `已标记 ${result.markedCount} 条为已读`
      : '当前范围内无未读审批')
    await refreshPendingBadgeCount()
  } catch {
    ElMessage.error('标记已读失败，请重试')
  } finally {
    markingAllRead.value = false
  }
}

const activeTab = ref<'pending' | 'mine' | 'cc' | 'completed'>('pending')
const searchText = ref('')
const statusFilter = ref<ApprovalStatus | ''>('')
// Wave 2 WP2: source filter driving the `sourceSystem` query param on /api/approvals.
// Default 'all' surfaces the unified feed; switching narrows to platform or PLM-mirrored rows.
const sourceSystemFilter = ref<'all' | 'platform' | 'plm'>('all')
const currentPage = ref(1)
const pageSize = ref(10)
const attendanceRequestsSection = 'attendance-overview-requests'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// UF-3: status coloring/labels now come from <StatusTag domain="approvalInstance"> (see
// utils/statusDomains.ts) — the local statusTagType/statusLabel maps this file used to declare
// were one of six independent status-color implementations audited in the UI foundation
// design-lock and are removed here.
// UF-5: the per-row `发起时间` date formatter moved into ApprovalCenterTable.vue along with the
// table markup that was its only caller.

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
function loadCurrentTab() {
  const query = {
    search: searchText.value || undefined,
    status: (statusFilter.value || undefined) as ApprovalStatus | undefined,
    page: currentPage.value,
    pageSize: pageSize.value,
    sourceSystem: sourceSystemFilter.value,
  }
  switch (activeTab.value) {
    case 'pending': store.loadPending(query); break
    case 'mine': store.loadMine(query); break
    case 'cc': store.loadCc(query); break
    case 'completed': store.loadCompleted(query); break
  }
}

function handleTabChange() {
  currentPage.value = 1
  clearPendingSelection()
  loadCurrentTab()
  // Refresh badge whenever the user re-enters the 待办 tab so recent actions
  // reflect immediately.
  void refreshPendingBadgeCount()
}

function handleSearch() {
  currentPage.value = 1
  clearPendingSelection()
  loadCurrentTab()
}

function handleSourceSystemChange() {
  currentPage.value = 1
  clearPendingSelection()
  loadCurrentTab()
  void refreshPendingBadgeCount()
}

function handlePageChange(page: number) {
  currentPage.value = page
  clearPendingSelection()
  loadCurrentTab()
}

function isAttendanceApproval(row: UnifiedApprovalDTO): boolean {
  return row.workflowKey === 'attendance.request'
    || row.formSnapshot?.attendanceRequestId !== undefined
}

function attendanceRequestIdOf(row: UnifiedApprovalDTO): string | null {
  const rawRequestId = row.formSnapshot?.attendanceRequestId
  if (rawRequestId === undefined || rawRequestId === null) return null
  const requestId = String(rawRequestId).trim()
  return requestId ? requestId : null
}

function attendanceRequestQuery(row?: UnifiedApprovalDTO): Record<string, string> {
  const query: Record<string, string> = { section: attendanceRequestsSection }
  if (!row) return query
  const requestId = attendanceRequestIdOf(row)
  if (requestId) query.requestId = requestId
  return query
}

function handleRowClick(row: UnifiedApprovalDTO) {
  if (isAttendanceApproval(row)) {
    router.push({
      name: 'attendance',
      query: attendanceRequestQuery(row),
    })
    return
  }
  router.push({ name: 'approval-detail', params: { id: row.id } })
}

function openAttendanceApprovalQueue() {
  const firstPendingAttendanceRequest = store.pendingApprovals.find(row =>
    isAttendanceApproval(row) && attendanceRequestIdOf(row) !== null,
  )
  router.push({
    name: 'attendance',
    query: attendanceRequestQuery(firstPendingAttendanceRequest),
  })
}

onMounted(() => {
  loadCurrentTab()
  void refreshPendingBadgeCount()
})
</script>

<style scoped>
.approval-center__toolbar {
  display: flex;
  align-items: center;
  gap: var(--ms-space-3);
}

.approval-center__toolbar-search {
  width: 240px;
}

.approval-center__toolbar-select {
  width: 140px;
}

.approval-center__error {
  margin-bottom: 16px;
}

.approval-center__tabs {
  margin-top: 8px;
}

.approval-center__pagination {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}

.approval-center__tab-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.approval-center__tab-badge {
  margin-left: 4px;
}

.approval-center__tab-toolbar {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.approval-center__selection-count {
  margin-right: auto;
  color: #4b5563;
  font-size: 13px;
}

.approval-center__batch-reject-summary {
  margin: 0 0 12px;
  color: #4b5563;
  font-size: 14px;
}

/* B1-03: 已等待 aging severity — normal inherits the surrounding text color; warn/urgent escalate. */
.approval-center__wait {
  display: inline-block;
  margin-right: 8px;
  font-size: 13px;
  color: #606266;
}

.approval-center__wait--warn {
  color: #e6a23c;
}

.approval-center__wait--urgent {
  color: #f56c6c;
}

.approval-center__row-reject-summary {
  margin: 0 0 12px;
  color: #4b5563;
  font-size: 14px;
}

.approval-center__row-reject-error {
  margin-bottom: 12px;
}

.approval-center__batch-result-summary {
  margin: 0 0 12px;
  color: #4b5563;
  font-size: 14px;
}

.approval-center__batch-result-list {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 280px;
  overflow-y: auto;
}

.approval-center__batch-result-item {
  padding: 8px 0;
  border-bottom: 1px solid #ebeef5;
}

.approval-center__batch-result-item:last-child {
  border-bottom: none;
}

.approval-center__batch-result-item-title {
  font-size: 14px;
  color: #303133;
}

.approval-center__batch-result-item-message {
  margin-top: 2px;
  font-size: 13px;
  color: #f56c6c;
}

.approval-center__attendance-entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
  margin-bottom: 12px;
  border: 1px solid #dbeafe;
  border-radius: 8px;
  background: #eff6ff;
}

.approval-center__attendance-entry-copy {
  display: grid;
  gap: 4px;
}

.approval-center__attendance-entry-copy strong {
  color: #1f2937;
  font-size: 14px;
}

.approval-center__attendance-entry-copy p {
  margin: 0;
  color: #4b5563;
  font-size: 13px;
  line-height: 1.5;
}

@media (max-width: 720px) {
  .approval-center__attendance-entry {
    align-items: flex-start;
    flex-direction: column;
  }
}

/* T3-1 v0 — responsive chrome. The center is only rendered as the touch-first
   card list when the `approvalMobile` flag is on, but the header/toolbar chrome
   should reflow on any narrow viewport so the search + filters never overflow
   horizontally. */
@media (max-width: 768px) {
  .approval-center__toolbar {
    flex-wrap: wrap;
    gap: var(--ms-space-2);
  }

  /* UF-5: these three classes previously carried the fixed desktop widths as inline `style=`
     attributes, which forced the `!important` overrides below (an inline style always wins over
     a plain class rule). Now that the width lives in a class rule of ordinary specificity, this
     media-query rule (declared later in the cascade) overrides it without `!important`. */
  .approval-center__toolbar-search,
  .approval-center__toolbar-select,
  .approval-center__toolbar-button {
    width: 100%;
  }

  .approval-center__pagination {
    justify-content: center;
  }
}
</style>
