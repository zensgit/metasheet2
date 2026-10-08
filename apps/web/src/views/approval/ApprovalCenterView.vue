<template>
  <PageShell width="wide">
    <PageHeader
      class="approval-center__header"
      :title="t.title"
      :subtitle="t.subtitle"
    >
      <template #meta>
        <span class="approval-center__stat">
          <span>{{ t.statPending }}</span>
          <strong>{{ pendingTotalCount }}</strong>
        </span>
        <span class="approval-center__stat approval-center__stat--unread">
          <span>{{ t.statUnread }}</span>
          <strong>{{ pendingBadgeCount }}</strong>
        </span>
        <span v-if="activeFilterCount > 0" class="approval-center__filter-summary">
          {{ filterSummaryText }}
        </span>
      </template>
      <template #actions>
        <el-button
          v-if="canWrite"
          type="primary"
          class="approval-center__create-button"
          @click="router.push({ name: 'approval-template-list' })"
        >
          {{ t.create }}
        </el-button>
      </template>
    </PageHeader>

    <section class="approval-center__filters" :aria-label="t.filtersLabel">
      <div class="approval-center__filters-primary">
          <el-input
            v-model="searchText"
            :placeholder="t.searchPlaceholder"
            clearable
            class="approval-center__toolbar-search"
            data-testid="approval-search-input"
            @clear="handleSearch"
            @keyup.enter="handleSearch"
          >
            <template #prefix>
              <el-icon><Search /></el-icon>
            </template>
          </el-input>
          <el-select
            v-model="sourceSystemFilter"
            :placeholder="t.sourcePlaceholder"
            class="approval-center__toolbar-select"
            data-testid="approval-source-filter"
            @change="handleSourceSystemChange"
          >
            <el-option :label="t.sourceAll" value="all" />
            <el-option :label="t.sourcePlatform" value="platform" />
            <el-option :label="t.sourcePlm" value="plm" />
          </el-select>
          <el-button
            class="approval-center__filter-toggle"
            :type="filtersExpanded ? 'primary' : 'default'"
            :plain="filtersExpanded"
            data-testid="approval-more-filters"
            @click="filtersExpanded = !filtersExpanded"
          >
            {{ filtersExpanded ? t.filtersCollapse : t.filtersExpand }}
            <span v-if="advancedFilterCount > 0" class="approval-center__filter-count">
              {{ advancedFilterCount }}
            </span>
          </el-button>
          <!-- F3-E1: server-side CSV export of the list on screen (current tab + applied filters).
               Desktop chrome only, like the batch toolbar below: the mobile action set (ballot Q8)
               is approve/reject/comment/initiate. Disabled for the PLM source, which the server
               refuses for CSV; the reason is the visible hint line right under this row, not a
               hover-only tooltip (a disabled button does not fire one). -->
          <el-button
            v-if="!isMobileLayout"
            class="approval-center__export-button"
            :disabled="exportDisabled"
            :loading="exporting"
            aria-describedby="approval-center-export-hint"
            data-testid="approval-export-csv"
            @click="handleExportCsv"
          >
            {{ exportCopy.button }}
          </el-button>
      </div>
      <p
        v-if="!isMobileLayout"
        id="approval-center-export-hint"
        class="approval-center__export-hint"
        data-testid="approval-export-hint"
      >
        {{ exportPlmBlocked ? exportCopy.plmBlocked : exportCopy.scopeHint }}
      </p>
      <p
        v-if="!isMobileLayout && exportNotice"
        class="approval-center__export-notice"
        :class="`approval-center__export-notice--${exportNotice.tone}`"
        :role="exportNotice.tone === 'error' ? 'alert' : 'status'"
        :data-export-outcome="exportNotice.kind"
        data-testid="approval-export-notice"
      >
        {{ exportNotice.text }}
      </p>

      <div v-show="filtersExpanded" class="approval-center__filters-advanced">
          <el-select
            v-model="statusFilter"
            :placeholder="t.statusPlaceholder"
            clearable
            class="approval-center__toolbar-select"
            @change="handleSearch"
          >
            <el-option :label="t.statusPending" value="pending" />
            <el-option :label="t.statusApproved" value="approved" />
            <el-option :label="t.statusRejected" value="rejected" />
            <el-option :label="t.statusRevoked" value="revoked" />
          </el-select>
          <!-- B3-03 (模板/时间筛选): additive filters composing with the existing status/source
               filters above — templateId + a created-at window, mirroring the backend's own
               GET /api/approvals query params. Also the landing point for the metrics dashboard's
               看板钻取 deep links (see ApprovalMetricsView.vue), which pre-fill these two on mount
               via the route query (see `applyDeepLinkFilters` below). -->
          <el-select
            v-model="templateFilter"
            :placeholder="t.templatePlaceholder"
            clearable
            filterable
            class="approval-center__toolbar-select approval-center__toolbar-select--wide"
            data-testid="approval-template-filter"
            @change="handleSearch"
          >
            <el-option
              v-for="tpl in templateOptions"
              :key="tpl.id"
              :label="tpl.name"
              :value="tpl.id"
            />
          </el-select>
          <el-date-picker
            v-model="createdRange"
            type="daterange"
            unlink-panels
            :range-separator="t.rangeSeparator"
            :start-placeholder="t.rangeStartPlaceholder"
            :end-placeholder="t.rangeEndPlaceholder"
            value-format="YYYY-MM-DD"
            class="approval-center__toolbar-daterange"
            data-testid="approval-created-range-filter"
            @change="handleSearch"
          />
          <el-button
            text
            class="approval-center__clear-filters"
            :disabled="activeFilterCount === 0"
            data-testid="approval-clear-filters"
            @click="clearFilters"
          >
            {{ t.clearFilters }}
          </el-button>
      </div>
    </section>

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
        <el-button type="primary" link @click="loadCurrentTab">{{ t.reload }}</el-button>
      </template>
    </el-alert>

    <!-- UI-7 (approval-parity-master-design-lock-20260817.md §4 UI-7): desktop master-detail
         layout. `approval-center__split` is rendered UNCONDITIONALLY at every width — the pane
         itself only ever renders at `masterDetailEnabled` widths (>= ~1440px) with a live
         selection, but the wrapper's `display: flex` still applies at every narrower width and on
         mobile (P1-01 fix: it is NOT a no-op div there — see the CSS comment below for why that
         assumption caused a real-browser layout regression, and .approval-center__tabs's own rule
         for the fix). -->
    <div class="approval-center__split" :class="{ 'approval-center__split--active': showDetailPane }">
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
            <span>{{ t.tabPending }}</span>
            <el-tooltip
              v-if="pendingBadgeCount > 0"
              :content="pendingBadgeTooltip"
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
        <!-- G-B2-11 (新待办到达刷新 pill): the badge above can go stale relative to the list below
             it (badge 5 / list 3) once new pending items land server-side after the list was last
             loaded. We deliberately do NOT auto-refresh the list when that happens — a silent
             reload would clear the operator's in-progress 批量通过/批量驳回 selection with no
             warning. Instead this pill only appears here (待我处理 only) once `newTodoPill.visible`
             flips true, and reloads solely on the operator's own click. See
             src/approvals/newTodoPill.ts for the count-vs-loaded-rows pitfall this avoids. -->
        <button
          v-if="newTodoPill.visible"
          type="button"
          class="approval-center__new-todo-pill"
          data-testid="approval-new-todo-pill"
          @click="handleNewTodoPillClick"
        >
          {{ newTodoPillText }}
        </button>
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
          >{{ selectionCountText }}</span>
          <el-button
            type="success"
            plain
            :disabled="selectedPending.length === 0 || batchRunning"
            :loading="batchRunning && batchAction === 'approve'"
            data-testid="approval-batch-approve"
            @click="handleBatchApprove"
          >
            {{ t.batchApprove }}
          </el-button>
          <el-button
            type="danger"
            plain
            :disabled="selectedPending.length === 0 || batchRunning"
            :loading="batchRunning && batchAction === 'reject'"
            data-testid="approval-batch-reject"
            @click="openBatchReject"
          >
            {{ t.batchReject }}
          </el-button>
          <el-button
            type="primary"
            plain
            :disabled="pendingBadgeCount <= 0"
            :loading="markingAllRead"
            data-testid="approval-mark-all-read"
            @click="handleMarkAllRead"
          >
            {{ t.markAllRead }}
          </el-button>
        </div>
        <div
          class="approval-center__attendance-entry"
          data-testid="attendance-approval-queue-entry"
        >
          <div class="approval-center__attendance-entry-copy">
            <strong>{{ t.attendanceTitle }}</strong>
            <p>
              {{ t.attendanceBody }}
            </p>
          </div>
          <el-button type="primary" plain @click="openAttendanceApprovalQueue">
            {{ t.attendanceOpen }}
          </el-button>
        </div>
        <ApprovalMobileList
          v-if="isMobileLayout"
          :approvals="store.pendingApprovals"
          :loading="store.loading"
          :empty-text="tabEmptyText.pending"
          :template-schemas="templateSchemas"
          @select="handleRowClick"
        />
        <div v-else-if="isFirstPaintLoading(store.pendingApprovals)" class="approval-center__skeleton" data-testid="pending-skeleton">
          <el-skeleton :rows="5" animated />
        </div>
        <ApprovalCenterTable
          v-else
          ref="pendingTableRef"
          :rows="store.pendingApprovals"
          :loading="store.loading"
          :empty-text="tabEmptyText.pending"
          :summary-line-for="summaryLineFor"
          :selected-row-id="masterDetailEnabled && activeTab === 'pending' ? selectedApprovalId : null"
          show-selection
          :selectable="isRowBatchSelectable"
          show-wait-column
          show-unread-dot
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
                :title="inlineApproveConfirmTitle(row.title)"
                :confirm-button-text="t.confirm"
                :cancel-button-text="t.cancel"
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
                    {{ t.approve }}
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
                {{ t.reject }}
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

      <el-tab-pane :label="t.tabMine" name="mine">
        <ApprovalMobileList
          v-if="isMobileLayout"
          :approvals="store.myApprovals"
          :loading="store.loading"
          :empty-text="tabEmptyText.mine"
          :template-schemas="templateSchemas"
          @select="handleRowClick"
        />
        <div v-else-if="isFirstPaintLoading(store.myApprovals)" class="approval-center__skeleton" data-testid="mine-skeleton">
          <el-skeleton :rows="5" animated />
        </div>
        <ApprovalCenterTable
          v-else
          :rows="store.myApprovals"
          :loading="store.loading"
          :empty-text="tabEmptyText.mine"
          :summary-line-for="summaryLineFor"
          :selected-row-id="masterDetailEnabled && activeTab === 'mine' ? selectedApprovalId : null"
          :actions-width="170"
          @row-click="handleRowClick"
        >
          <!-- 催办: a requester nudge to the current approver, only meaningful while the instance is
               still pending. Server-side rate-limited (1/instance/user/hour); 429 surfaces gracefully.
               B1-03: 已等待 sits right next to it — the longer a request has waited, the more it
               motivates the requester to actually click 催办. -->
          <template #actions="{ row }">
            <span v-if="row.status === 'pending'" :class="waitClass(row.createdAt)">
              {{ waitingPhrase(formatRelativeWait(row.createdAt, isZh), isZh) }}
            </span>
            <el-button
              v-if="row.status === 'pending'"
              type="primary"
              link
              :loading="urgeState(row.id).loading"
              :disabled="urgeState(row.id).disabled"
              :title="urgeState(row.id).title"
              :data-testid="`approval-urge-${row.id}`"
              @click.stop="handleUrge(row)"
            >
              {{ urgeState(row.id).label }}
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

      <el-tab-pane :label="t.tabCc" name="cc">
        <ApprovalMobileList
          v-if="isMobileLayout"
          :approvals="store.ccApprovals"
          :loading="store.loading"
          :empty-text="tabEmptyText.cc"
          :template-schemas="templateSchemas"
          @select="handleRowClick"
        />
        <div v-else-if="isFirstPaintLoading(store.ccApprovals)" class="approval-center__skeleton" data-testid="cc-skeleton">
          <el-skeleton :rows="5" animated />
        </div>
        <ApprovalCenterTable
          v-else
          :rows="store.ccApprovals"
          :loading="store.loading"
          :empty-text="tabEmptyText.cc"
          :summary-line-for="summaryLineFor"
          :selected-row-id="masterDetailEnabled && activeTab === 'cc' ? selectedApprovalId : null"
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

      <el-tab-pane :label="t.tabCompleted" name="completed">
        <ApprovalMobileList
          v-if="isMobileLayout"
          :approvals="store.completedApprovals"
          :loading="store.loading"
          :empty-text="tabEmptyText.completed"
          :template-schemas="templateSchemas"
          @select="handleRowClick"
        />
        <div v-else-if="isFirstPaintLoading(store.completedApprovals)" class="approval-center__skeleton" data-testid="completed-skeleton">
          <el-skeleton :rows="5" animated />
        </div>
        <ApprovalCenterTable
          v-else
          :rows="store.completedApprovals"
          :loading="store.loading"
          :empty-text="tabEmptyText.completed"
          :summary-line-for="summaryLineFor"
          :selected-row-id="masterDetailEnabled && activeTab === 'completed' ? selectedApprovalId : null"
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

      <!-- B3-01 (我已处理): every instance the actor recorded an ANY-status action on — a reverse
           lookup, distinct from 已完成 (which is scoped to non-pending instances only). Shares the
           same read-only table shape as 抄送我的/已完成 (no selection/wait/actions column: the
           actor already acted, there is nothing left to do here). -->
      <el-tab-pane :label="t.tabProcessed" name="processed">
        <ApprovalMobileList
          v-if="isMobileLayout"
          :approvals="store.processedApprovals"
          :loading="store.loading"
          :empty-text="tabEmptyText.processed"
          :template-schemas="templateSchemas"
          @select="handleRowClick"
        />
        <div v-else-if="isFirstPaintLoading(store.processedApprovals)" class="approval-center__skeleton" data-testid="processed-skeleton">
          <el-skeleton :rows="5" animated />
        </div>
        <ApprovalCenterTable
          v-else
          :rows="store.processedApprovals"
          :loading="store.loading"
          :empty-text="tabEmptyText.processed"
          :summary-line-for="summaryLineFor"
          :selected-row-id="masterDetailEnabled && activeTab === 'processed' ? selectedApprovalId : null"
          @row-click="handleRowClick"
        />
        <el-pagination
          class="approval-center__pagination"
          background
          layout="total, prev, pager, next"
          :total="store.totalProcessed"
          :current-page="currentPage"
          :page-size="pageSize"
          @update:current-page="handlePageChange"
        />
      </el-tab-pane>
    </el-tabs>

    <ApprovalCenterDetailPane
      v-if="showDetailPane"
      :row="paneDisplayRow!"
      :detail="paneApproval"
      :detail-loading="paneLoading"
      :detail-error="paneError"
      :summary-line="paneSummaryLine"
      :show-quick-actions="paneShowQuickActions"
      :approve-loading="paneApproveLoading"
      :actions-disabled="paneActionsDisabled"
      @quick-approve="handleInlineApprove"
      @quick-reject="openRowReject"
      @open-full-detail="navigateToApprovalDetail"
      @close="closeDetailPane"
    />
    </div>

    <!-- Batch reject: a comment is offered (some templates require one; a per-row failure is captured
         in the manifest rather than aborting the batch). -->
    <el-dialog
      v-model="batchRejectDialogVisible"
      :title="t.batchRejectTitle"
      width="440px"
      data-testid="approval-batch-reject-dialog"
    >
      <p class="approval-center__batch-reject-summary">
        {{ batchRejectSummaryText }}
      </p>
      <el-input
        v-model="batchRejectComment"
        type="textarea"
        :rows="3"
        :placeholder="batchRejectCommentRequired ? t.rejectReasonRequired : t.rejectOpinionOptional"
        data-testid="approval-batch-reject-comment"
      />
      <template #footer>
        <el-button data-testid="approval-batch-reject-cancel" @click="batchRejectDialogVisible = false">{{ t.cancel }}</el-button>
        <el-button
          type="danger"
          :loading="batchRunning"
          :disabled="batchRejectConfirmDisabled"
          data-testid="approval-batch-reject-confirm"
          @click="handleBatchReject"
        >
          {{ t.confirmReject }}
        </el-button>
      </template>
    </el-dialog>

    <!-- B1-03 (part 1): per-row reject dialog — mirrors the batch-reject dialog's comment/policy
         gating but targets a single row (`rowRejectTarget`); kept fully separate from the batch
         dialog's own state so the two flows never cross-contaminate each other's comment/error. -->
    <el-dialog
      v-model="rowRejectDialogVisible"
      :title="t.rowRejectTitle"
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
        {{ rowRejectSummaryText(rowRejectTarget.title) }}
      </p>
      <el-input
        v-model="rowRejectComment"
        type="textarea"
        :rows="3"
        :placeholder="rowRejectCommentRequired ? t.rejectReasonRequired : t.rejectOpinionOptional"
        data-testid="approval-row-reject-comment"
      />
      <template #footer>
        <el-button data-testid="approval-row-reject-cancel" @click="rowRejectDialogVisible = false">{{ t.cancel }}</el-button>
        <el-button
          type="danger"
          :loading="rowRejectSubmitting"
          :disabled="rowRejectConfirmDisabled"
          data-testid="approval-row-reject-confirm"
          @click="submitRowReject"
        >
          {{ t.confirmReject }}
        </el-button>
      </template>
    </el-dialog>

    <!-- B1-03 (part 3): batch failure manifest — replaces the old collapsed toast whenever at
         least one row fails, so the operator sees WHICH rows failed and WHY, then can retry just
         the failed subset (same action + comment) without re-selecting anything. -->
    <el-dialog
      v-model="batchResultDialogVisible"
      :title="t.batchResultTitle"
      width="480px"
      data-testid="approval-batch-result-dialog"
    >
      <p class="approval-center__batch-result-summary">
        <!-- 撤销轮: a decision the server accepted for a round other than the one confirmed on screen is
             counted on its own — it is not a failure (the row's own line says to refresh and check). -->
        {{ batchResultSummaryText }}
      </p>
      <ul class="approval-center__batch-result-list">
        <li
          v-for="row in batchFailureRows"
          :key="row.id"
          class="approval-center__batch-result-item"
          :data-batch-result-kind="row.unconfirmed ? 'unconfirmed' : 'failed'"
        >
          <div class="approval-center__batch-result-item-title">{{ row.requestNo }} · {{ row.title }}</div>
          <div class="approval-center__batch-result-item-message">{{ row.message }}</div>
        </li>
      </ul>
      <template #footer>
        <el-button data-testid="approval-batch-result-close" @click="batchResultDialogVisible = false">{{ t.close }}</el-button>
        <!-- 撤销轮: an accepted-but-unconfirmed row is not a failure, so it is never retried; with no true
             failure left the button is disabled. -->
        <el-button
          type="primary"
          :loading="batchRunning"
          :disabled="batchTrueFailureCount === 0"
          data-testid="approval-batch-retry"
          @click="retryBatchFailures"
        >
          {{ t.retryFailed }}
        </el-button>
      </template>
    </el-dialog>
  </PageShell>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { Search } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import type { UnifiedApprovalDTO, ApprovalStatus } from '../../types/approval'
import { useApprovalStore } from '../../approvals/store'
import { useApprovalPermissions } from '../../approvals/permissions'
import {
  APPROVAL_EXPORT_UNEXPECTED_RESPONSE,
  ApprovalApiError,
  dispatchAction,
  exportApprovalsCsv,
  getApproval,
  getPendingCount,
  markAllApprovalsRead,
  remindApproval,
  listTemplates,
  type ApprovalCsvExportResult,
  type ApprovalExportQuery,
} from '../../approvals/api'
import { isNetworkUnavailableError, networkUnavailableMessage } from '../../utils/networkErrors'
import { urgeButtonState } from '../../approvals/urgeButtonState'
import { runApprovalBatchAction, type ApprovalBatchActionResult } from '../../approvals/useApprovalBatchActions'
import {
  canDecideCancelRoundWith,
  dispatchApprovalDecision,
  isCancelRoundActedRoundUnconfirmed,
  isCancelRoundClientRefusal,
  isCancelRoundWorkflow,
} from '../../approvals/cancelRound'
import { useApprovalCountsRealtime, type ApprovalCountsUpdatedPayload } from '../../approvals/useApprovalCountsRealtime'
import { useApprovalListFieldSummary } from '../../approvals/useApprovalListFieldSummary'
import { ensureUserNamesResolved } from '../../approvals/directoryResolve'
import { createDetailPaneController } from '../../approvals/approvalCenterDetailPaneController'
import { newTodoPillState } from '../../approvals/newTodoPill'
import { useFeatureFlags } from '../../stores/featureFlags'
import { useMobileViewport } from '../../composables/useMobileViewport'
import { useLocale } from '../../composables/useLocale'
import { formatRelativeWait, waitingPhrase, waitSeverity } from '../../approvals/relativeWait'
import { CENTER_EN, CENTER_ZH } from './approvalCenterLabels'
import ApprovalMobileList from './ApprovalMobileList.vue'
import ApprovalCenterTable from './ApprovalCenterTable.vue'
import ApprovalCenterDetailPane from './ApprovalCenterDetailPane.vue'
import PageShell from '../../components/layout/PageShell.vue'
import PageHeader from '../../components/layout/PageHeader.vue'

const router = useRouter()
const route = useRoute()
const store = useApprovalStore()
const { canWrite, permissions: approvalAccess } = useApprovalPermissions()

// B2-01 (待办列表关键字段摘要) — lazy per-templateId FormSchema cache + row summary-line lookup,
// shared by the desktop table below (all four tabs) and ApprovalMobileList (passed the raw
// `templateSchemas` cache as a prop). See `useApprovalListFieldSummary.ts` for the full rationale
// (live-template substitute for the list DTO's missing frozen formSchema, the live-label drift
// tradeoff, and the session-scoped negative caching on fetch failure).
const { schemas: templateSchemas, ensureLoadedForRows, summaryLineFor, summaryUserIdsFor } = useApprovalListFieldSummary()
const allVisibleApprovals = computed<UnifiedApprovalDTO[]>(() => [
  ...store.pendingApprovals,
  ...store.myApprovals,
  ...store.ccApprovals,
  ...store.completedApprovals,
  ...store.processedApprovals,
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

// UI-7 (approval-parity-master-design-lock-20260817.md §4 UI-7) — desktop master-detail pane.
// Reuses the SAME matchMedia-based composable/pattern as `isMobileLayout` above (a second,
// independent call with a wide-desktop query) rather than a new ResizeObserver mechanism — see
// `useMobileViewport.ts`'s own doc comment for why a bare width query is sufficient here (the
// pane is not behind a separate feature flag; it is default behavior at wide widths only).
// Narrower widths and mobile are UNCHANGED: `masterDetailEnabled` stays false there, so
// `handleRowClick` keeps navigating exactly as it did before this slice.
const { isMobile: isWideLayout } = useMobileViewport('(min-width: 1440px)')
const masterDetailEnabled = computed(() => isWideLayout.value && !isMobileLayout.value)

// The row currently loaded into the pane, URL-stable via `?detail=<id>` so a refresh restores it
// (see the dedicated `route.query.detail` watcher below — deliberately NOT folded into the
// existing deep-link watcher, which reloads the list and would wipe the batch-approve selection on
// every row click; see that watcher's own comment for the incident this caused).
const selectedApprovalId = ref<string | null>(null)

const activeTabRows = computed<UnifiedApprovalDTO[]>(() => {
  switch (activeTab.value) {
    case 'pending': return store.pendingApprovals
    case 'mine': return store.myApprovals
    case 'cc': return store.ccApprovals
    case 'completed': return store.completedApprovals
    case 'processed': return store.processedApprovals
    default: return []
  }
})

// The selection's row from the currently-loaded page of the active tab (zero-cost — already
// fetched for the table). May be `null` if the id is not on the current page (e.g. a stale
// `?detail=` restored before the list finishes loading, or the row since paged/filtered away);
// `paneDisplayRow` below falls back to the single-fetch detail in that case.
const selectedRow = computed<UnifiedApprovalDTO | null>(() => {
  const id = selectedApprovalId.value
  if (!id) return null
  return activeTabRows.value.find((row) => row.id === id) ?? null
})

// ── Single-fetch detail (getApproval — the SAME data-client call ApprovalDetailView uses,
// reused directly rather than via `store.loadDetail`, which would flash `store.loading` — the
// SAME flag ApprovalCenterTable's `v-loading` binds — on every row selection, and would clobber
// `store.activeApproval` out from under ApprovalDetailView). See
// `approvalCenterDetailPaneController.ts` for the generation-counter cancel/replace-on-reselection
// race guard (mirrors `routePreviewController.ts`).
const paneApproval = ref<UnifiedApprovalDTO | null>(null)
const paneLoading = ref(false)
const paneError = ref('')
// Wrapped in a closure (never `getApproval` passed directly) so the api-module property read is
// deferred to the moment `.select()` actually runs (gated behind `masterDetailEnabled &&
// selectedApprovalId`, both false/null on every narrower-than-wide-desktop mount) rather than at
// setup(). This matters for tests: several pre-existing approval-center* specs stub
// `../../approvals/api` with an explicit export list that omits `getApproval` (they never open the
// pane), and Vitest's mocked-module proxy throws on an eager read of a name the mock never listed.
const paneController = createDetailPaneController((id: string) => getApproval(id), (patch) => {
  if ('approval' in patch) paneApproval.value = patch.approval ?? null
  if (patch.loading !== undefined) paneLoading.value = patch.loading
  if (patch.error !== undefined) paneError.value = patch.error
}, () => isZh.value)

// Prefers the already-known list row (zero cost, immediate paint); falls back to the fetched
// detail once available so the pane still renders after the id has paged/filtered off-screen or
// on a fresh refresh before the list has loaded.
const paneDisplayRow = computed<UnifiedApprovalDTO | null>(() => selectedRow.value ?? paneApproval.value)
const showDetailPane = computed(() => masterDetailEnabled.value && !!selectedApprovalId.value && !!paneDisplayRow.value)

// Mirrors the row actions' own gate exactly (§ B1-03 `isRowBatchSelectable`) — pending tab,
// platform-native rows only.
const paneShowQuickActions = computed(() => {
  const row = paneDisplayRow.value
  return activeTab.value === 'pending' && !!row && isRowBatchSelectable(row)
})
const paneSummaryLine = computed(() => (paneDisplayRow.value ? summaryLineFor(paneDisplayRow.value) : ''))
// Test report 2026-10-08 T4b (gate r1 P3-4): the pane's row is not always a list row. A `?detail=`
// deep link to an instance that is not on the loaded page renders the single-fetch `paneApproval`,
// which `allVisibleApprovals` (and so `ensureLoadedForRows`' resolve) never sees, so its summary's
// 人员 ids were never queued. This reads the pane row against the CACHED schema only: it re-fires when
// a list row sharing the template loads that schema after the pane opened, and it never fetches a
// template for the pane (the B2-01 summary stays cache-only).
watch(
  () => summaryUserIdsFor(paneDisplayRow.value),
  (ids) => ensureUserNamesResolved(ids),
  { immediate: true },
)
// Reuses the EXACT same shared gate the row-level inline approve button already reads
// (`inlineApprovingId`) — never a second, independently-tracked loading flag. This is also the
// mechanism that makes a "pane bypasses the shared handler" mutation mechanically detectable: if
// the pane ever dispatched its own action instead of calling `handleInlineApprove`, this gate
// would never flip and every OTHER row's approve button would stay clickable while the pane's own
// request is in flight.
const paneApproveLoading = computed(() => inlineApprovingId.value !== null && inlineApprovingId.value === selectedApprovalId.value)
const paneActionsDisabled = computed(() => inlineApprovingId.value !== null)

function selectApprovalRow(id: string): void {
  selectedApprovalId.value = id
  if (route.query.detail !== id) {
    router.replace({ query: { ...route.query, detail: id } })
  }
}

function closeDetailPane(): void {
  if (!selectedApprovalId.value) return
  selectedApprovalId.value = null
  const rest: Record<string, unknown> = { ...route.query }
  delete rest.detail
  router.replace({ query: rest as Record<string, string> })
}

function navigateToApprovalDetail(row: UnifiedApprovalDTO): void {
  router.push({ name: 'approval-detail', params: { id: row.id } })
}

// P2-03 fix: an Element Plus overlay (select dropdown / date-picker panel / any teleported
// `.el-popper`) is "open" when its popper node exists in the DOM and is not hidden — Element Plus
// toggles both `display: none` (v-show) and `aria-hidden="true"` on close, so checking either is
// sufficient and neither is a false-negative-prone signal on its own. Heuristic chosen because
// there is no existing codebase precedent for this check (verified: no other `.el-popper` query
// exists in apps/web/src) — it mirrors Element Plus's own internal close-state contract instead of
// inventing a new one.
function hasOpenElPopper(): boolean {
  const poppers = document.querySelectorAll<HTMLElement>('.el-popper')
  for (const popper of poppers) {
    if (popper.getAttribute('aria-hidden') === 'true') continue
    if (popper.style.display === 'none') continue
    return true
  }
  return false
}

// Keyboard: Esc closes the pane, Up/Down move the selection — only while the pane is actually
// open, and never while a reject/batch-result dialog is open (its own textarea needs Up/Down for
// cursor movement, and Esc must close IT, not the pane underneath). The editable-target check is
// hoisted above the Escape branch (P2-03 fix) — previously it only guarded Arrow keys, so Escape
// from a focused filter input (or any other INPUT/TEXTAREA/SELECT) silently closed the pane
// underneath it too. The `.el-popper` check catches the remaining case where the open overlay's
// own reference element is not one of those three tags (e.g. a non-filterable el-select trigger).
function handleDetailPaneKeydown(event: KeyboardEvent): void {
  if (!masterDetailEnabled.value || !selectedApprovalId.value) return
  if (batchRejectDialogVisible.value || rowRejectDialogVisible.value || batchResultDialogVisible.value) return
  const target = event.target as HTMLElement | null
  if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
  if (event.key === 'Escape') {
    if (hasOpenElPopper()) return
    event.preventDefault()
    closeDetailPane()
    return
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const rows = activeTabRows.value
  const idx = rows.findIndex((row) => row.id === selectedApprovalId.value)
  if (idx === -1) return
  const nextIdx = event.key === 'ArrowDown' ? idx + 1 : idx - 1
  if (nextIdx < 0 || nextIdx >= rows.length) return
  event.preventDefault()
  selectApprovalRow(rows[nextIdx]!.id)
}

// i18n follow-up (ballot T3-1 build-contract must-fix): the mobile card list's per-tab
// empty-state copy shipped in #3517 as hardcoded Chinese literals. Localize via the app's
// established `useLocale()` / `isZh` pattern instead of a hardcoded string per tab.
//
// Report item O-8 (approval UI locale consistency): this computed was ONLY wired into the
// mobile `<ApprovalMobileList>` empty-text prop below — the desktop `<ApprovalCenterTable>`'s
// `:empty-text` for the very same five tabs stayed an unconditional Chinese literal, so an
// operator on a desktop browser (the majority case) saw Chinese here regardless of locale even
// though the mobile-layout path was already correct. Renamed (was `mobileEmptyText`) and reused
// for both paths — one source, not two copies that can drift again.
const { isZh } = useLocale()
// O-8 / F8-1: the rest of this view's chrome reads the same locale through approvalCenterLabels.ts
// (flat strings) and the small interpolating helpers below (counts / titles).
const t = computed(() => (isZh.value ? CENTER_ZH : CENTER_EN))
const filterSummaryText = computed(() => (isZh.value ? `已启用 ${activeFilterCount.value} 项筛选` : `${activeFilterCount.value} filter(s) active`))
const pendingBadgeTooltip = computed(() => (isZh.value ? `待办 ${pendingTotalCount.value} / 其中 ${pendingBadgeCount.value} 未读` : `${pendingTotalCount.value} to-do / ${pendingBadgeCount.value} unread`))
const newTodoPillText = computed(() => (isZh.value ? `${newTodoPill.value.delta} 条新待办 · 点击刷新` : `${newTodoPill.value.delta} new to-do(s) · click to refresh`))
const selectionCountText = computed(() => (isZh.value ? `已选 ${selectedPending.value.length} 项` : `${selectedPending.value.length} selected`))
const batchRejectSummaryText = computed(() => (isZh.value ? `将驳回所选的 ${selectedPending.value.length} 项审批。` : `The ${selectedPending.value.length} selected approval(s) will be rejected.`))
function inlineApproveConfirmTitle(title: string | null): string {
  return isZh.value ? `确认通过「${title}」？` : `Approve "${title}"?`
}
function rowRejectSummaryText(title: string | null): string {
  return isZh.value ? `确认驳回「${title}」？` : `Reject "${title}"?`
}
function batchDoneToast(action: 'approve' | 'reject', count: number): string {
  if (action === 'approve') return isZh.value ? `已通过 ${count} 项` : `Approved ${count} item(s)`
  return isZh.value ? `已驳回 ${count} 项` : `Rejected ${count} item(s)`
}
function urgeRetryAfterToast(minutes: number): string {
  return isZh.value ? `催办过于频繁，请 ${minutes} 分钟后再试` : `Too many reminders. Try again in ${minutes} min.`
}
function markedReadToast(count: number): string {
  return isZh.value ? `已标记 ${count} 条为已读` : `Marked ${count} as read`
}
const tabEmptyText = computed(() => {
  if (isZh.value) {
    return {
      pending: searchText.value ? '未找到匹配的审批' : '暂无待处理审批',
      mine: searchText.value ? '未找到匹配的审批' : '暂无我发起的审批',
      cc: searchText.value ? '未找到匹配的审批' : '暂无抄送我的审批',
      completed: searchText.value ? '未找到匹配的审批' : '暂无已完成审批',
      processed: searchText.value ? '未找到匹配的审批' : '暂无已处理审批',
    }
  }
  return {
    pending: searchText.value ? 'No matching approvals found' : 'No pending approvals',
    mine: searchText.value ? 'No matching approvals found' : 'No approvals initiated by you',
    cc: searchText.value ? 'No matching approvals found' : 'No approvals cc’d to you',
    completed: searchText.value ? 'No matching approvals found' : 'No completed approvals',
    processed: searchText.value ? 'No matching approvals found' : 'No approvals you have processed',
  }
})

// ── 操作台: batch approve/reject over the pending selection ────────────────
const pendingTableRef = ref<{ clearSelection: () => void } | null>(null)
const selectedPending = ref<UnifiedApprovalDTO[]>([])
const batchRunning = ref(false)
const batchAction = ref<'approve' | 'reject' | null>(null)
const batchRejectDialogVisible = ref(false)
const batchRejectComment = ref('')
// G-B2-12: 催办 is gated PER ROW (a nudge on one request must not freeze every other row's button).
// `remindingIds` = this row's own request is in flight; `remindedIds` = session memory of rows
// already nudged. Both are reactive Sets; see urgeButtonState for the precedence + why the memory
// is deliberately not persisted.
const remindingIds = ref<Set<string>>(new Set())
const remindedIds = ref<Set<string>>(new Set())

function urgeState(rowId: string) {
  return urgeButtonState(rowId, remindingIds.value, remindedIds.value, isZh.value)
}

// B1-03: 已等待 aging severity class — the 我发起的 tab's inline hint next to 催办 (same
// warn/urgent palette as ApprovalCenterTable's own internal 已等待 column, kept separate since
// this one lives in this view's `actions` slot content rather than the shared table body).
function waitClass(createdAt: string): string {
  return `approval-center__wait approval-center__wait--${waitSeverity(createdAt)}`
}

// Only platform-native pending rows are batch-actionable here; attendance-backed approvals live in the
// attendance module (their row-click routes away), so excluding them keeps the batch honest.
// Lock-3 §2.2: a 办理 (handler) task is NOT an approval task — it has no member 同意/拒绝 decision (an
// approve/reject would 409). Exclude it from the approve/reject action surface entirely so no inert
// control is offered (M7). This gate feeds the checkbox `:selectable`, the inline 通过/驳回 (`v-if`),
// and the batch selection (`rows.filter(isRowBatchSelectable)`), so all three surfaces are covered.
// The handler row stays VISIBLE (informational); the member 办理 surface itself is P5.
function isHandlerNodeRow(row: UnifiedApprovalDTO): boolean {
  return row.currentNodeType === 'handler'
}
// 撤销轮 rows decide through the attendance route, so their approve / reject affordances (inline,
// pane, batch) follow the grant that route checks (`canDecideCancelRoundWith`) — the same predicate
// the detail view uses. Display only; the route remains the authority.
function isRowBatchSelectable(row: UnifiedApprovalDTO): boolean {
  return row.status === 'pending' && !isAttendanceApproval(row) && !isHandlerNodeRow(row)
    && (!isCancelRoundWorkflow(row) || canDecideCancelRoundWith(approvalAccess?.value))
}

// UF-8 (design-lock §3.6 "状态 = 首屏骨架屏"): first paint only — `store.loading` is a single
// shared flag across all 4 tabs, so this checks the ACTIVE tab's own row list. Once any data has
// arrived (or the tab was already loaded), a subsequent refresh keeps the existing `v-loading`
// spinner-over-table behavior (ApprovalCenterTable), never re-showing the skeleton.
function isFirstPaintLoading(rows: UnifiedApprovalDTO[]): boolean {
  return store.loading && rows.length === 0
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
  /** 撤销轮: accepted by the server, but not confirmed to be the round on screen — not a failure. */
  unconfirmed: boolean
}
const batchResultDialogVisible = ref(false)
const batchFailureRows = ref<ApprovalBatchFailureRow[]>([])
const batchSucceededCount = ref(0)
const batchUnconfirmedCount = computed(() => batchFailureRows.value.filter((row) => row.unconfirmed).length)
const batchTrueFailureCount = computed(() => batchFailureRows.value.length - batchUnconfirmedCount.value)
// O-8 / F8-1: the batch-result summary line, one locale at a time (was three inline templates).
const batchResultSummaryText = computed(() => {
  const succeeded = batchSucceededCount.value
  const unconfirmed = batchUnconfirmedCount.value
  const failed = batchTrueFailureCount.value
  const total = batchFailureRows.value.length
  if (unconfirmed > 0) {
    return isZh.value
      ? `成功 ${succeeded} 项，已提交但未能确认 ${unconfirmed} 项，失败 ${failed} 项：`
      : `${succeeded} succeeded, ${unconfirmed} submitted but not confirmed, ${failed} failed:`
  }
  if (succeeded > 0) return isZh.value ? `成功 ${succeeded} 项，失败 ${total} 项：` : `${succeeded} succeeded, ${total} failed:`
  return isZh.value ? `全部 ${total} 项处理失败：` : `All ${total} item(s) failed:`
})
const lastBatchAction = ref<'approve' | 'reject'>('approve')
const lastBatchComment = ref('')
let batchRowSnapshot = new Map<string, UnifiedApprovalDTO>()

function buildFailureRows(
  failed: ApprovalBatchActionResult['failed'],
  unconfirmedIds: ReadonlySet<string>,
): ApprovalBatchFailureRow[] {
  return failed.map(({ id, message }) => {
    const row = batchRowSnapshot.get(id)
    return {
      id,
      title: row?.title ?? id,
      requestNo: row?.requestNo ?? '-',
      message,
      unconfirmed: unconfirmedIds.has(id),
    }
  })
}

async function dispatchBatchAndHandleResult(
  ids: string[],
  action: 'approve' | 'reject',
  comment: string,
  // 撤销轮: accepted-but-unconfirmed rows from the previous pass — not re-sent, kept in the manifest.
  carriedUnconfirmed: ApprovalBatchFailureRow[] = [],
): Promise<void> {
  const trimmed = comment.trim()
  const unconfirmedIds = new Set<string>()
  const result = await runApprovalBatchAction(
    ids,
    () => (trimmed ? { action, comment: trimmed } : { action }),
    // 撤销轮 rows decide through the attendance route (approvals/cancelRound.ts); the snapshot taken
    // at launch carries each row's workflowKey / businessKey for that decision. Every id comes from
    // that snapshot, so a missing entry is refused — it is never re-sent as a generic decision.
    async (id, req) => {
      const row = batchRowSnapshot.get(id)
      if (!row) throw new Error(t.value.actionFailedRefresh)
      try {
        return await dispatchApprovalDecision(row, req, dispatchAction)
      } catch (error) {
        // accepted but not confirmed to be this row's round: still listed, counted apart from failures
        if (isCancelRoundActedRoundUnconfirmed(error)) unconfirmedIds.add(id)
        throw error
      }
    },
  )
  if (result.failed.length === 0 && carriedUnconfirmed.length === 0) {
    ElMessage.success(batchDoneToast(action, result.succeeded.length))
    batchResultDialogVisible.value = false
    batchFailureRows.value = []
  } else {
    // B1-03: any failure now opens the manifest dialog instead of a toast (whether partial or
    // total); only the all-success path above keeps today's light toast.
    lastBatchAction.value = action
    lastBatchComment.value = comment
    batchSucceededCount.value = result.succeeded.length
    batchFailureRows.value = [...carriedUnconfirmed, ...buildFailureRows(result.failed, unconfirmedIds)]
    batchResultDialogVisible.value = true
  }
  clearPendingSelection()
  loadCurrentTab()
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
// 撤销轮: a row the server accepted but the page could not confirm is not a failure — it is not
// re-sent, and it stays in the manifest (with its own "refresh and check" line) after the retry.
async function retryBatchFailures(): Promise<void> {
  if (batchRunning.value) return
  const ids = batchFailureRows.value.filter((row) => !row.unconfirmed).map((row) => row.id)
  if (ids.length === 0) return
  const carried = batchFailureRows.value.filter((row) => row.unconfirmed)
  batchRunning.value = true
  batchAction.value = lastBatchAction.value
  try {
    await dispatchBatchAndHandleResult(ids, lastBatchAction.value, lastBatchComment.value, carried)
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
// Lock-5 §1.3 / gate CR-3 — PARTIAL here, and the scope of that is stated precisely (gate finding
// P3-2 on #4983 corrected an earlier over-broad claim). The LIST DTO deliberately stays
// byte-identical (no `nodeOperations` on it), so this row-level predicate keeps reading the instance
// policy literal, which for every pre-Lock-5 instance and every instance whose node declares nothing
// resolves to exactly today's answer.
//
// On the REJECT side that is conservative-never-permissive: a row whose NODE says `'never'` is still
// surfaced as "comment required", the engine then accepts the bare reject, so this dialog can ask for
// a comment the server would not have demanded but never skips one it requires.
//
// The APPROVE side is NOT covered by that reasoning and must not be described as if it were:
// `handleBatchApprove` sends `comment: ''`, so at a node with `commentRequired:'always'` every
// selected row is refused 400 `APPROVAL_COMMENT_REQUIRED` and lands in the failure manifest with the
// server's message. That is FAIL-LOUD, not a silent skip — no decision is recorded and the operator
// sees each failure — but it is a real usability gap, not a conservative default.
//
// Closing either side needs the effective value on the LIST read, which is a separate slice (it
// would change the shared `toUnifiedDTO` the list path uses). Disclosed rather than silently
// divergent.
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
// request is in flight, so a slow request can't be raced by mashing a different row. This global
// gate is deliberate HERE and NOT shared with 催办 (G-B2-12): approve/reject MUTATES an approval,
// so racing two rows is a correctness hazard, whereas 催办 is a server-rate-limited nudge and is
// gated per row.
const inlineApprovingId = ref<string | null>(null)

async function handleInlineApprove(row: UnifiedApprovalDTO): Promise<void> {
  if (inlineApprovingId.value) return
  inlineApprovingId.value = row.id
  try {
    await dispatchApprovalDecision(row, { action: 'approve' }, dispatchAction)
    ElMessage.success(t.value.toastApproved)
    loadCurrentTab()
  } catch (error) {
    ElMessage.error(error instanceof Error && error.message ? error.message : t.value.actionFailedRetry)
    // 撤销轮: the row was not (or could not be confirmed as) the leave's pending round — reload the list.
    if (isCancelRoundClientRefusal(error)) loadCurrentTab()
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
// Lock-5 §1.3 / CR-3 — same LIST-path limit as the batch predicate above: no `nodeOperations` on
// the list DTO, so this stays on the instance literal. Conservative, never permissive (see above).
const rowRejectCommentRequired = computed(() => rowRejectTarget.value?.policy?.rejectCommentRequired !== false)
const rowRejectConfirmDisabled = computed(() => rowRejectCommentRequired.value && !rowRejectComment.value.trim())

async function submitRowReject(): Promise<void> {
  if (rowRejectConfirmDisabled.value || !rowRejectTarget.value) return
  const target = rowRejectTarget.value
  const trimmed = rowRejectComment.value.trim()
  rowRejectSubmitting.value = true
  rowRejectError.value = null
  try {
    await dispatchApprovalDecision(target, trimmed ? { action: 'reject', comment: trimmed } : { action: 'reject' }, dispatchAction)
    ElMessage.success(t.value.toastRejected)
    rowRejectDialogVisible.value = false
    loadCurrentTab()
  } catch (error) {
    // Mirrors B1-04's dialog-scoped inline error: keep the dialog open with the server's own
    // reason instead of a toast, so the typed comment is never lost on a retry-in-place.
    rowRejectError.value = error instanceof Error && error.message ? error.message : t.value.actionFailedRetry
    if (isCancelRoundClientRefusal(error)) loadCurrentTab()
  } finally {
    rowRejectSubmitting.value = false
  }
}

async function handleUrge(row: UnifiedApprovalDTO): Promise<void> {
  // Only this row's own state gates it — other rows may be nudged concurrently.
  if (remindingIds.value.has(row.id) || remindedIds.value.has(row.id)) return
  remindingIds.value.add(row.id)
  try {
    const result = await remindApproval(row.id)
    if (result.ok) {
      remindedIds.value.add(row.id)
      ElMessage.success(t.value.urgeSent)
    } else if (result.status === 429) {
      // 429 means the server's hourly window already holds a nudge for this instance+user, so the
      // row genuinely IS 已催办 — recording it stops the user re-clicking into the same rejection.
      remindedIds.value.add(row.id)
      const retry = result.error.retryAfterSeconds
      ElMessage.warning(retry ? urgeRetryAfterToast(Math.ceil(retry / 60)) : t.value.urgeTooFrequent)
    } else {
      ElMessage.error(result.error.message || t.value.urgeFailed)
    }
  } catch {
    ElMessage.error(t.value.urgeFailed)
  } finally {
    remindingIds.value.delete(row.id)
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

// G-B2-11: `resnapshot` ties a fresh server count to "the list was just (re)loaded" — see
// `pendingCountAtLoad` below. Only call sites that ALSO reload the pending list (or are the very
// first load) pass this; a bare badge poll must never move the baseline the pill compares against.
async function refreshPendingBadgeCount(options?: { resnapshot?: boolean }): Promise<void> {
  try {
    const result = await getPendingCount(sourceSystemFilter.value)
    applyPendingBadgeCount(result.count, result.unreadCount)
    if (options?.resnapshot) {
      pendingCountAtLoad.value = result.count
    }
  } catch {
    // Badge is decorative — do not surface errors here; the tab itself
    // surfaces list-load failures via `store.error`.
    pendingBadgeCount.value = 0
    pendingTotalCount.value = 0
  }
}

function handleRealtimeCountsUpdated(payload: ApprovalCountsUpdatedPayload): void {
  const scopedCounts = payload.countsBySourceSystem?.[sourceSystemFilter.value] ?? payload
  // Deliberately NOT resnapshotted: a realtime push updates the live count (and can therefore
  // surface the G-B2-11 pill below) without ever moving `pendingCountAtLoad` — the whole point of
  // the pill is to notice this push happened while the list itself sat unrefreshed.
  applyPendingBadgeCount(scopedCounts.count, scopedCounts.unreadCount)
}

useApprovalCountsRealtime({
  onCountsUpdated: handleRealtimeCountsUpdated,
})

// G-B2-11 (新待办到达刷新 pill) — see src/approvals/newTodoPill.ts for the full design rationale.
// `pendingCountAtLoad` is a snapshot of the server's pending `count`, taken at the moment the
// pending list was last explicitly (re)loaded (mount / tab switch / source-system change / batch
// action reload / the pill's own click). `null` until the very first load completes, so the pill
// can never render before there is a baseline to compare against.
//
// This is intentionally compared against `pendingTotalCount` (the server's authoritative total),
// NEVER against `store.pendingApprovals.length` (rows loaded on the current page) — the list is
// paged, so "server total > rows on this page" would be true forever and misreport ordinary paging
// as new arrivals.
const pendingCountAtLoad = ref<number | null>(null)
const newTodoPill = computed(() => newTodoPillState({
  activeTab: activeTab.value,
  pendingCountAtLoad: pendingCountAtLoad.value,
  currentPendingCount: pendingTotalCount.value,
}))

// Deliberately NOT an automatic refresh: silently reloading the list out from under the operator
// would clear whatever rows they currently have checked in the 批量通过/批量驳回 multi-select
// (`selectedPending`) with no explanation. The pill only reloads when the operator clicks it.
function handleNewTodoPillClick(): void {
  clearPendingSelection()
  loadCurrentTab()
}

// Wave 2 WP3 slice 2 — bulk 全部标记已读. Honours the current sourceSystem tab
// so the button's effect matches the tooltip the user is looking at.
const markingAllRead = ref(false)
async function handleMarkAllRead(): Promise<void> {
  if (markingAllRead.value) return
  markingAllRead.value = true
  try {
    const result = await markAllApprovalsRead(sourceSystemFilter.value)
    ElMessage.success(result.markedCount > 0
      ? markedReadToast(result.markedCount)
      : t.value.markAllReadNone)
    await refreshPendingBadgeCount()
  } catch {
    ElMessage.error(t.value.markAllReadFailed)
  } finally {
    markingAllRead.value = false
  }
}

const activeTab = ref<'pending' | 'mine' | 'cc' | 'completed' | 'processed'>('pending')
const searchText = ref('')
const statusFilter = ref<ApprovalStatus | ''>('')
// Wave 2 WP2: source filter driving the `sourceSystem` query param on /api/approvals.
// Default 'all' surfaces the unified feed; switching narrows to platform or PLM-mirrored rows.
const sourceSystemFilter = ref<'all' | 'platform' | 'plm'>('all')
// B3-03 (模板/时间筛选): `templateId` + a created-at window, additive alongside the filters above.
const templateFilter = ref('')
const templateOptions = ref<Array<{ id: string; name: string }>>([])
const createdRange = ref<[string, string] | null>(null)
const filtersExpanded = ref(false)
const currentPage = ref(1)
const pageSize = ref(10)
const attendanceRequestsSection = 'attendance-overview-requests'

const advancedFilterCount = computed(() => [
  statusFilter.value,
  templateFilter.value,
  createdRange.value,
].filter(Boolean).length)

const activeFilterCount = computed(() => [
  searchText.value.trim(),
  sourceSystemFilter.value === 'all' ? '' : sourceSystemFilter.value,
  statusFilter.value,
  templateFilter.value,
  createdRange.value,
].filter(Boolean).length)

// B3-03: `createdRange` holds plain `YYYY-MM-DD` day boundaries from the picker (or a deep link);
// widen to inclusive day-start/day-end ISO timestamps for the server, the same convention
// ApprovalMetricsView's own since/until range already uses.
const createdFromQuery = computed(() => (createdRange.value?.[0] ? `${createdRange.value[0]}T00:00:00Z` : undefined))
const createdToQuery = computed(() => (createdRange.value?.[1] ? `${createdRange.value[1]}T23:59:59Z` : undefined))

// ---------------------------------------------------------------------------
// F3-E1: 导出 CSV
// ---------------------------------------------------------------------------
// What the list on screen was LAST LOADED with: the tab plus its filters, no paging. Written only
// by `loadCurrentTab()` — the one place every list reload passes through — so an export always asks
// the server for the feed the user is looking at. Reading the filter refs live would not: the
// search box, for one, reaches the list only on Enter / clear, so a half-typed term would narrow
// the export to something the list is not showing.
const appliedListFilters = ref<ApprovalExportQuery | null>(null)

// The server refuses `format=csv` for the PLM source (400); the button is disabled up front so the
// user gets the reason before clicking rather than an error after.
const exportPlmBlocked = computed(() => appliedListFilters.value?.sourceSystem === 'plm')
const exportDisabled = computed(() => exportPlmBlocked.value || appliedListFilters.value === null)
const exporting = ref(false)

// The outcome is stored as DATA (kind + the numbers the server reported), never as finished text,
// so the notice follows a runtime locale switch like every other string in `exportCopy`.
type ApprovalExportOutcome =
  | { kind: 'complete'; rowCount: number }
  | { kind: 'capped'; rowCount: number | null; rowLimit: number | null }
  // The export headers could not be read. NOT the same as "complete": the file may be cut short
  // and this page has no way to tell, so it says exactly that.
  | { kind: 'unknown' }
  | { kind: 'failed'; reason: 'plm' | 'unexpected' | 'forbidden' | 'network' | 'status' | 'other'; status?: number }
const exportOutcome = ref<ApprovalExportOutcome | null>(null)

// Same construct as `tabEmptyText` above (an `isZh` branch returning a table) — the only copy this
// slice adds; the rest of this view's hardcoded chrome is converted separately.
const exportCopy = computed(() => {
  if (isZh.value) {
    return {
      button: '导出 CSV',
      scopeHint: '导出当前标签页与已应用筛选下、你可以打开详情的审批；PLM 来源的审批不在导出范围内。单次导出有行数上限，导出行数可能少于列表显示的总数。',
      plmBlocked: 'PLM 来源的审批不支持导出 CSV。请把来源筛选切换为全部来源或平台审批后再导出。',
      complete: (rows: number) => (rows === 0
        ? '没有可导出的审批，已下载的文件只包含表头。'
        : `已导出 ${rows} 行。`),
      capped: (rows: number | null, limit: number | null) => [
        rows === null ? '文件已下载，但不完整：' : `已导出 ${rows} 行，但文件不完整：`,
        limit === null ? '符合条件的审批超过了单次导出的行数上限。' : `符合条件的审批超过了单次导出上限（${limit} 行）。`,
        '请缩小筛选范围后分批导出。',
      ].join(''),
      unknown: '文件已下载，但未能读取服务器返回的行数与截断标记，无法确认文件是否完整。',
      failedForbidden: '导出失败：当前账号没有导出审批的权限。',
      failedUnexpected: '导出失败：服务器没有返回 CSV 文件，未保存任何内容。',
      failedStatus: (status: number) => `导出失败（HTTP ${status}），未保存任何内容，请稍后重试。`,
      failedOther: '导出失败，未保存任何内容，请稍后重试。',
    }
  }
  return {
    button: 'Export CSV',
    scopeHint: 'Exports the approvals in the current tab and applied filters that you can open; PLM-sourced approvals are not included. Each export has a row limit, so the file may hold fewer rows than the total the list shows.',
    plmBlocked: 'PLM-sourced approvals cannot be exported to CSV. Switch the source filter to all sources or platform approvals to export.',
    complete: (rows: number) => (rows === 0
      ? 'Nothing to export: the downloaded file contains the header row only.'
      : `Exported ${rows} ${rows === 1 ? 'row' : 'rows'}.`),
    capped: (rows: number | null, limit: number | null) => [
      rows === null ? 'The file was downloaded but is incomplete: ' : `Exported ${rows} ${rows === 1 ? 'row' : 'rows'}, but the file is incomplete: `,
      limit === null ? 'the matching approvals exceed the per-export row limit. ' : `the matching approvals exceed the per-export limit of ${limit} rows. `,
      'Narrow the filters and export in batches.',
    ].join(''),
    unknown: 'The file was downloaded, but the row count and truncation flag returned by the server could not be read, so it cannot be confirmed that the file is complete.',
    failedForbidden: 'Export failed: this account is not allowed to export approvals.',
    failedUnexpected: 'Export failed: the server did not return a CSV file. Nothing was saved.',
    failedStatus: (status: number) => `Export failed (HTTP ${status}). Nothing was saved; please try again later.`,
    failedOther: 'Export failed. Nothing was saved; please try again later.',
  }
})

const exportNotice = computed<{ kind: ApprovalExportOutcome['kind']; tone: 'success' | 'warning' | 'error'; text: string } | null>(() => {
  const outcome = exportOutcome.value
  if (!outcome) return null
  const copy = exportCopy.value
  switch (outcome.kind) {
    case 'complete':
      return { kind: outcome.kind, tone: 'success', text: copy.complete(outcome.rowCount) }
    case 'capped':
      return { kind: outcome.kind, tone: 'warning', text: copy.capped(outcome.rowCount, outcome.rowLimit) }
    case 'unknown':
      return { kind: outcome.kind, tone: 'warning', text: copy.unknown }
    case 'failed': {
      const text = outcome.reason === 'plm' ? copy.plmBlocked
        : outcome.reason === 'unexpected' ? copy.failedUnexpected
        : outcome.reason === 'forbidden' ? copy.failedForbidden
        : outcome.reason === 'network' ? networkUnavailableMessage(isZh.value)
        : outcome.reason === 'status' && outcome.status !== undefined ? copy.failedStatus(outcome.status)
        : copy.failedOther
      return { kind: outcome.kind, tone: 'error', text }
    }
  }
  return null
})

function exportOutcomeOf(result: ApprovalCsvExportResult): ApprovalExportOutcome {
  if (result.capped === true) {
    return { kind: 'capped', rowCount: result.rowCount, rowLimit: result.rowLimit ?? result.rowCap }
  }
  if (result.capped === false && result.rowCount !== null) {
    return { kind: 'complete', rowCount: result.rowCount }
  }
  return { kind: 'unknown' }
}

function exportFailureOf(error: unknown): ApprovalExportOutcome {
  if (isNetworkUnavailableError(error)) return { kind: 'failed', reason: 'network' }
  if (error instanceof ApprovalApiError) {
    if (error.code === APPROVAL_EXPORT_UNEXPECTED_RESPONSE) return { kind: 'failed', reason: 'unexpected' }
    if (error.code === 'APPROVAL_EXPORT_SOURCE_SYSTEM_UNSUPPORTED') return { kind: 'failed', reason: 'plm' }
    if (error.status === 403) return { kind: 'failed', reason: 'forbidden' }
    return { kind: 'failed', reason: 'status', status: error.status }
  }
  return { kind: 'failed', reason: 'other' }
}

// Hands the browser the server's bytes under the server's file name. The Blob is the one
// `exportApprovalsCsv` returned — this view never builds, filters or re-encodes CSV itself.
function saveExportFile(blob: Blob, fileName: string): void {
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = fileName
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
}

async function handleExportCsv(): Promise<void> {
  const filters = appliedListFilters.value
  if (exporting.value || !filters || filters.sourceSystem === 'plm') return
  exporting.value = true
  exportOutcome.value = null
  // The result line describes the feed this click exported. If the list moved to another feed
  // while the request was in flight, `loadCurrentTab()` has already dropped the line and replaced
  // the snapshot object, so the late result is not posted under a list it does not describe. The
  // file itself is still saved: it is exactly what was asked for at click time.
  const stillSameFeed = () => appliedListFilters.value === filters
  try {
    const result = await exportApprovalsCsv(filters)
    saveExportFile(result.blob, result.fileName)
    if (stillSameFeed()) exportOutcome.value = exportOutcomeOf(result)
  } catch (error) {
    if (stillSameFeed()) exportOutcome.value = exportFailureOf(error)
  } finally {
    exporting.value = false
  }
}

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
// P2-04 fix: the URL-restore select watcher below (`watch([selectedApprovalId, masterDetailEnabled],
// ..., { immediate: true })`) already fires the pane's single fetch synchronously during setup() —
// BEFORE onMounted runs — whenever a fresh mount carries `?detail=<id>` at wide width. Without this
// flag, `loadCurrentTab()`'s own pane-refresh block (needed for every SUBSEQUENT reload, including a
// pane-triggered 通过/驳回) would redundantly re-fetch on that very first onMounted() call too,
// producing 2 fetches instead of 1.
let isInitialTabLoad = true

function loadCurrentTab() {
  const filters = {
    search: searchText.value || undefined,
    status: (statusFilter.value || undefined) as ApprovalStatus | undefined,
    sourceSystem: sourceSystemFilter.value,
    templateId: templateFilter.value || undefined,
    createdFrom: createdFromQuery.value,
    createdTo: createdToQuery.value,
  }
  const query = {
    ...filters,
    page: currentPage.value,
    pageSize: pageSize.value,
  }
  // F3-E1: the export button reads this snapshot, so it exports what THIS load asked for. A result
  // notice describes one export of one feed; once the feed on screen is a different one (another
  // tab or filter set — a page change is not), the notice would describe a file the list no longer
  // matches, so it is dropped. The snapshot object is replaced only in that case, so its identity
  // changes exactly when the feed does — `handleExportCsv` relies on that to tell whether a late
  // result still belongs to the list on screen (a page change or same-feed reload keeps it).
  const nextAppliedFilters: ApprovalExportQuery = { ...filters, tab: activeTab.value }
  if (JSON.stringify(nextAppliedFilters) !== JSON.stringify(appliedListFilters.value)) {
    exportOutcome.value = null
    appliedListFilters.value = nextAppliedFilters
  }
  switch (activeTab.value) {
    case 'pending': store.loadPending(query); break
    case 'mine': store.loadMine(query); break
    case 'cc': store.loadCc(query); break
    case 'completed': store.loadCompleted(query); break
    case 'processed': store.loadProcessed(query); break
  }
  // G-B2-11: EVERY list reload re-baselines the pill, from the ONE place every reload passes
  // through. Hanging this off individual call sites is precisely what let handleSearch() and
  // handlePageChange() skip it — leaving a pill still urging "N 条新待办 · 点击刷新" for todos the
  // reload had already fetched. A choke point cannot be forgotten by the next call site.
  void refreshPendingBadgeCount({ resnapshot: true })
  // UI-7: this is also the ONE place every list reload passes through — including a pane-triggered
  // 通过/驳回 (`handleInlineApprove`/`submitRowReject` both call `loadCurrentTab()` on success), and
  // filter/page/search changes. Re-run the pane's single-fetch detail here so an open pane never
  // keeps showing a stale current-node/pending-approver snapshot (or a stale 通过/驳回 affordance)
  // after the very reload that changed it. A no-op whenever the pane is not open.
  if (!isInitialTabLoad && selectedApprovalId.value && masterDetailEnabled.value) {
    void paneController.select(selectedApprovalId.value)
  }
  isInitialTabLoad = false
}

function handleTabChange() {
  currentPage.value = 1
  clearPendingSelection()
  // UI-7: the pane's selection belongs to the tab it was opened from — switching tabs closes it
  // (also drops a stale `?detail=` from the URL) rather than leaving a phantom selection whose row
  // id likely does not even exist in the newly-active tab's rows.
  closeDetailPane()
  // loadCurrentTab() refreshes the badge and re-baselines the G-B2-11 pill (see its choke point).
  loadCurrentTab()
}

function handleSearch() {
  currentPage.value = 1
  clearPendingSelection()
  loadCurrentTab()
}

function clearFilters() {
  searchText.value = ''
  statusFilter.value = ''
  sourceSystemFilter.value = 'all'
  templateFilter.value = ''
  createdRange.value = null
  currentPage.value = 1
  clearPendingSelection()
  loadCurrentTab()
}

function handleSourceSystemChange() {
  currentPage.value = 1
  clearPendingSelection()
  // The source-system switch changes what `count` even means (a different scope); the reload's
  // own re-baseline inside loadCurrentTab() handles it.
  loadCurrentTab()
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
  // UI-7: wide desktop only — select into the master-detail pane instead of navigating away.
  // Narrower widths and mobile are UNCHANGED: `masterDetailEnabled` is false there, so this falls
  // straight through to the existing navigation, exactly as before this slice.
  if (masterDetailEnabled.value) {
    selectApprovalRow(row.id)
    return
  }
  navigateToApprovalDetail(row)
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

// B3-03 (看板钻取): ApprovalMetricsView's KPI tiles / per-template rows deep-link here with
// `?templateId=...&createdFrom=...&createdTo=...`. Pre-fill the filter bar from those query
// params BEFORE the first load, so the very first request already carries them (matches the
// "钻取到已过滤好的列表" contract — no extra click needed). `createdFrom`/`createdTo` are full
// ISO timestamps; the date-range picker only understands day boundaries, so only the date
// portion is used to repopulate it — the resulting createdFrom/createdTo the picker's own
// `@change`/query-building path derives are the SAME day-start/day-end convention either way.
//
// This is a full SYNC, not a merge: at every deep-link entry point (mount + the params-nav
// watcher below) the route query is the source of truth — a key that is absent CLEARS its
// filter. Otherwise navigating from a filtered drill-down to the bare 审批中心 menu entry
// (query {}) would silently keep serving the old template/date-scoped list under an
// unfiltered-looking URL.
//
// UI-7 NOTE: `?detail=<id>` (the master-detail pane's own URL-stable selection, see
// `selectApprovalRow`/`closeDetailPane`) is a SEPARATE query key this function never reads. The
// watcher right below it is scoped to exactly the three keys this function DOES read — see that
// watcher's own comment for why.
function applyDeepLinkFilters(): void {
  const rawTemplateId = route.query.templateId
  templateFilter.value = typeof rawTemplateId === 'string' ? rawTemplateId : ''
  const rawCreatedFrom = route.query.createdFrom
  const rawCreatedTo = route.query.createdTo
  const fromDate = typeof rawCreatedFrom === 'string' && rawCreatedFrom ? rawCreatedFrom.slice(0, 10) : ''
  const toDate = typeof rawCreatedTo === 'string' && rawCreatedTo ? rawCreatedTo.slice(0, 10) : ''
  createdRange.value = fromDate && toDate ? [fromDate, toDate] : null
  filtersExpanded.value = Boolean(templateFilter.value || createdRange.value)
}

// B3-03: params-only navigation to /approvals (e.g. a second 看板钻取 link clicked while this
// view is already mounted, or an in-app push carrying a different query) REUSES this component
// instance — onMounted never re-runs, so without this watcher the new query would be silently
// ignored. Re-sync the filter bar from the query and explicitly reload from page 1. The
// route-name guard keeps the watcher inert while navigating AWAY (the global `route` object
// mutates to the target route before this instance unmounts).
// UI-7 fix: this used to watch the WHOLE `route.query` object (a single getter returning the
// object itself). Every `router.replace` that changes ONLY `?detail=<id>` (a row selection) still
// creates a new `query` object identity, so that form re-fired this watcher on every single row
// click — reloading the list from page 1 and wiping the pending-tab batch-approve selection out
// from under the operator. Vue's MULTI-source watch form below tracks each of the three keys this
// callback actually reads as an INDEPENDENT primitive dependency, so it only fires when one of
// THEM changes — `detail` changing alone leaves this inert, exactly as intended.
watch(
  [
    () => route.query.templateId,
    () => route.query.createdFrom,
    () => route.query.createdTo,
  ],
  () => {
    if (route.name !== 'approval-list') return
    applyDeepLinkFilters()
    currentPage.value = 1
    clearPendingSelection()
    loadCurrentTab()
  },
)

// UI-7: the pane's own URL-stable selection — deliberately a SEPARATE watcher scoped to only the
// `detail` key (see the watcher above for why folding it in there would reload the list on every
// selection). `immediate: true` also restores the selection from a fresh page load/refresh.
// Guarded to a genuine value change so `selectApprovalRow`/`closeDetailPane`'s own
// `router.replace` calls (which already set `selectedApprovalId` first) do not redundantly re-fire
// the pane fetch a second time.
watch(
  () => route.query.detail,
  (rawId) => {
    const next = typeof rawId === 'string' && rawId ? rawId : null
    if (next === selectedApprovalId.value) return
    selectedApprovalId.value = next
  },
  { immediate: true },
)

// UI-7: fires the single detail fetch on selection (and on enabling — e.g. resizing into wide
// layout with a URL-restored selection already pending), cancels/clears on deselect or narrowing
// back below the wide threshold. `{ immediate: true }` covers the initial mount state.
watch(
  [selectedApprovalId, masterDetailEnabled],
  ([id, enabled]) => {
    if (enabled && id) {
      void paneController.select(id)
    } else {
      paneController.clear()
    }
  },
  { immediate: true },
)

// B2-04-style id→name lookup so the filter dropdown shows readable template names rather than
// raw ids. Best-effort: a failed fetch just leaves the select empty (no crash, no blocking the
// rest of the page — mirrors ApprovalMetricsView's own `loadTemplateNames`).
async function loadTemplateOptions(): Promise<void> {
  try {
    const { data } = await listTemplates({ pageSize: 200 })
    templateOptions.value = data.map((tpl) => ({ id: tpl.id, name: tpl.name }))
  } catch {
    templateOptions.value = []
  }
}

onMounted(() => {
  applyDeepLinkFilters()
  // The first load establishes the pill's initial baseline (no delta possible against itself).
  loadCurrentTab()
  void loadTemplateOptions()
  window.addEventListener('keydown', handleDetailPaneKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleDetailPaneKeydown)
})
</script>

<style scoped>
/* UF-8 (design-lock §3.6): first-paint skeleton for the pending/mine/cc/completed tabs — only
   shown while `store.loading` is true AND the active tab has no rows yet (see
   `isFirstPaintLoading`); a later refresh with data already on screen keeps the existing
   ApprovalCenterTable `v-loading` spinner-over-table behavior untouched. */
.approval-center__skeleton {
  padding: var(--ms-space-4) 0;
}

.approval-center__header {
  margin-bottom: var(--ms-space-4);
}

.approval-center__stat,
.approval-center__filter-summary {
  display: inline-flex;
  align-items: center;
  gap: var(--ms-space-2);
  min-height: 28px;
  padding: var(--ms-space-1) var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 999px;
  background: var(--ms-bg-card);
  color: var(--ms-text-2);
  font-size: 13px;
}

.approval-center__stat strong {
  color: var(--ms-text-1);
  font-size: 15px;
}

.approval-center__stat--unread strong {
  color: var(--ms-color-danger);
}

.approval-center__filter-summary {
  background: var(--el-color-primary-light-9);
  border-color: var(--el-color-primary-light-7);
  color: var(--ms-color-primary);
}

.approval-center__filters {
  display: grid;
  gap: var(--ms-space-3);
  margin-bottom: var(--ms-space-4);
  padding: var(--ms-space-4);
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-lg);
  background: var(--ms-bg-card);
  box-shadow: var(--ms-shadow-card);
}

.approval-center__filters-primary,
.approval-center__filters-advanced {
  display: flex;
  align-items: center;
  gap: var(--ms-space-3);
  flex-wrap: wrap;
}

.approval-center__filters-advanced {
  padding-top: var(--ms-space-3);
  border-top: 1px solid var(--ms-border-light);
}

.approval-center__filter-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  margin-left: var(--ms-space-1);
  padding: 0 var(--ms-space-1);
  border-radius: 999px;
  background: var(--el-color-primary-light-8);
  color: var(--ms-color-primary);
  font-size: 12px;
  font-weight: 600;
}

.approval-center__toolbar-search {
  width: 240px;
}

.approval-center__toolbar-select {
  width: 140px;
}

/* B3-03: template filter is wider than the fixed-option selects above (template names run
   longer than status/source enum labels); the date-range picker keeps Element Plus's own width. */
.approval-center__toolbar-select--wide {
  width: 180px;
}

.approval-center__toolbar-daterange {
  width: 260px;
}

/* F3-E1: the export hint / result lines are rows of the filter card's own grid (`gap` above), so
   they need no margin of their own. */
.approval-center__export-hint,
.approval-center__export-notice {
  margin: 0;
  color: var(--ms-text-2);
  font-size: 12px;
  line-height: 1.6;
}

.approval-center__export-notice {
  font-size: 13px;
}

.approval-center__export-notice--success {
  color: var(--ms-color-success);
}

.approval-center__export-notice--warning {
  color: var(--ms-color-warning);
}

.approval-center__export-notice--error {
  color: var(--ms-color-danger);
}

.approval-center__error {
  margin-bottom: var(--ms-space-4);
}

/* UI-7 (approval-parity-master-design-lock-20260817.md §4 UI-7): desktop master-detail split.
   RENDERED UNCONDITIONALLY (no `v-if`) at every width — `display: flex` therefore applies even
   when the pane itself does not render (every narrower-than-wide-desktop width, every mobile
   render). This is NOT inert: a flex container changes its single implicit child's sizing from
   block (`width: 100%` of the container by default) to flex-item (`flex: 0 1 auto`, i.e.
   fit-content, unless told otherwise) — see .approval-center__tabs's own rule immediately below
   for the fix (P1-01: this exact false "it's a no-op div elsewhere" assumption caused a real,
   measured layout regression at every viewport width, invisible to jsdom). */
.approval-center__split {
  display: flex;
  align-items: flex-start;
  gap: var(--ms-space-4);
}

/* Unconditional: `.approval-center__split` is `display: flex` at every width (open or closed
   pane), so the tabs must be told to stretch the row at every width too. Gating this behind
   `--active` (pre-fix) left the closed-pane state — the default at every width, and the *only*
   state below 1440px and on mobile — as a fit-content flex item instead of a container-stretched
   one, collapsing the whole approval center. Verified via real-Chromium cold-layout measurement
   at 1600/1440/1366/1024/768/390: this restores merge-base widths exactly and eliminates 390px
   overflow. See apps/web/tests/approval-center-master-detail.spec.ts's "P1-01 CSS source pin"
   describe block for the source-pin regression guard (jsdom cannot measure real layout — the
   guard only pins that this rule stays unconditional in source; the actual proof is the
   real-Chromium measurement above, see the PR body's browser-harness backlog note). */
.approval-center__tabs {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 480px;
  padding: 0 var(--ms-space-4) var(--ms-space-4);
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-lg);
  background: var(--ms-bg-card);
  box-shadow: var(--ms-shadow-card);
}

.approval-center__tabs :deep(.el-tabs__header) {
  margin-bottom: var(--ms-space-4);
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

/* G-B2-11: 新待办到达刷新 pill — a deliberately clickable, un-missable affordance (not a passive
   badge) since it is the ONLY way this new count ever reaches the list; there is no auto-refresh. */
.approval-center__new-todo-pill {
  display: inline-flex;
  align-items: center;
  margin-bottom: 12px;
  padding: 4px 12px;
  border: 1px solid var(--el-color-primary-light-5);
  border-radius: 999px;
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-size: 13px;
  line-height: 1.6;
  cursor: pointer;
}

.approval-center__new-todo-pill:hover {
  border-color: var(--el-color-primary);
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
  color: var(--ms-text-2);
  font-size: 13px;
}

.approval-center__batch-reject-summary {
  margin: 0 0 12px;
  color: var(--ms-text-2);
  font-size: 14px;
}

/* B1-03: 已等待 aging severity — normal inherits the surrounding text color; warn/urgent escalate. */
.approval-center__wait {
  display: inline-block;
  margin-right: 8px;
  font-size: 13px;
  color: var(--el-text-color-regular);
}

.approval-center__wait--warn {
  color: var(--el-color-warning);
}

.approval-center__wait--urgent {
  color: var(--el-color-danger);
}

.approval-center__row-reject-summary {
  margin: 0 0 12px;
  color: var(--ms-text-2);
  font-size: 14px;
}

.approval-center__row-reject-error {
  margin-bottom: 12px;
}

.approval-center__batch-result-summary {
  margin: 0 0 12px;
  color: var(--ms-text-2);
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
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.approval-center__batch-result-item:last-child {
  border-bottom: none;
}

.approval-center__batch-result-item-title {
  font-size: 14px;
  color: var(--el-text-color-primary);
}

.approval-center__batch-result-item-message {
  margin-top: 2px;
  font-size: 13px;
  color: var(--el-color-danger);
}

.approval-center__attendance-entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
  margin-bottom: 12px;
  border: 1px solid var(--el-color-primary-light-8);
  border-radius: 8px;
  background: var(--el-color-primary-light-9);
}

.approval-center__attendance-entry-copy {
  display: grid;
  gap: 4px;
}

.approval-center__attendance-entry-copy strong {
  color: var(--ms-text-1);
  font-size: 14px;
}

.approval-center__attendance-entry-copy p {
  margin: 0;
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.5;
}

@media (max-width: 1100px) {
  .approval-center__toolbar-search {
    flex: 1 1 320px;
  }

  .approval-center__toolbar-daterange {
    flex: 1 1 260px;
  }
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
  .approval-center__filters {
    padding: var(--ms-space-3);
  }

  .approval-center__filters-primary,
  .approval-center__filters-advanced {
    gap: var(--ms-space-2);
  }

  /* UF-5: these three classes previously carried the fixed desktop widths as inline `style=`
     attributes, which forced the `!important` overrides below (an inline style always wins over
     a plain class rule). Now that the width lives in a class rule of ordinary specificity, this
     media-query rule (declared later in the cascade) overrides it without `!important`. */
  .approval-center__toolbar-search,
  .approval-center__toolbar-select,
  .approval-center__toolbar-daterange,
  .approval-center__filter-toggle,
  .approval-center__clear-filters,
  .approval-center__export-button,
  .approval-center__create-button {
    width: 100%;
  }

  .approval-center__tabs {
    padding: 0 var(--ms-space-3) var(--ms-space-3);
  }

  .approval-center__pagination {
    justify-content: center;
  }
}
</style>
