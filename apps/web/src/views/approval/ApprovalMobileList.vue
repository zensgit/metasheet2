<template>
  <div class="approval-mobile-list" data-testid="approval-mobile-list">
    <div
      v-if="loading"
      class="approval-mobile-list__loading"
      data-testid="approval-mobile-loading"
    >
      {{ t.loading }}
    </div>
    <div
      v-else-if="approvals.length === 0"
      class="approval-mobile-list__empty"
      data-testid="approval-mobile-empty"
    >
      {{ resolvedEmptyText }}
    </div>
    <button
      v-for="row in approvals"
      v-else
      :key="row.id"
      type="button"
      class="approval-mobile-list__card"
      data-testid="approval-mobile-card"
      :data-approval-id="row.id"
      @click="$emit('select', row)"
    >
      <div class="approval-mobile-list__card-top">
        <span class="approval-mobile-list__title">{{ row.title ?? t.titleFallback }}</span>
        <span
          class="approval-mobile-list__status"
          :class="`approval-mobile-list__status--${statusTagType(row.status)}`"
          :data-status="row.status"
        >
          {{ statusLabel(row.status) }}
        </span>
      </div>
      <div class="approval-mobile-list__meta">
        <span class="approval-mobile-list__request-no">{{ row.requestNo ?? '-' }}</span>
        <span class="approval-mobile-list__requester">{{ row.requester?.name ?? '-' }}</span>
      </div>
      <!-- B2-01: key-field summary — same muted glance line as the desktop table's title column,
           built from the LIVE template schema cache the parent passes down (see
           useApprovalListFieldSummary.ts for the live-label drift caveat). Absent for rows with no
           templateId or no cached schema yet. -->
      <div
        v-if="rowSummaryLine(row)"
        class="approval-mobile-list__summary"
        :title="rowSummaryLine(row)"
      >
        {{ rowSummaryLine(row) }}
      </div>
      <div
        class="approval-mobile-list__date"
        :class="`approval-mobile-list__date--${waitSeverity(row.createdAt)}`"
        :title="formatDate(row.createdAt)"
      >
        已等待 {{ formatRelativeWait(row.createdAt) }}
      </div>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { FormSchema, UnifiedApprovalDTO } from '../../types/approval'
import { useLocale } from '../../composables/useLocale'
import { formatRelativeWait, waitSeverity } from '../../approvals/relativeWait'
import { resolveRowSummaryLine } from '../../approvals/useApprovalListFieldSummary'

// T3-1 v0 — dedicated touch-first list card (ballot Q10). Replaces the desktop
// `el-table` (fixed column widths + horizontal scroll + tiny row-click targets)
// with full-width tappable cards. Kept free of Element Plus so it stays touch
// sized and trivially mountable in tests.
//
// i18n follow-up (ballot T3-1 build-contract must-fix — "all user-facing
// labels via i18n"): the shipped v0 (#3517) hardcoded these as Chinese-only
// literals. This mirrors the app's established `useLocale()` / `isZh` pattern
// (see ApprovalInboxView.vue, useNotificationInbox.ts) instead of introducing
// a new i18n mechanism.
const props = withDefaults(
  defineProps<{
    approvals: UnifiedApprovalDTO[]
    loading?: boolean
    emptyText?: string
    // B2-01 (待办列表关键字段摘要) — live-template schema cache keyed by templateId, owned by the
    // parent (ApprovalCenterView's useApprovalListFieldSummary). This component never fetches, it
    // only formats whatever is already cached; a templateId with no entry yet (not fetched / still
    // in flight / fetch failed) or a row with no templateId simply renders no summary line.
    templateSchemas?: Map<string, FormSchema>
  }>(),
  {
    loading: false,
    emptyText: undefined,
    templateSchemas: () => new Map(),
  },
)

defineEmits<{
  (event: 'select', row: UnifiedApprovalDTO): void
}>()

const { isZh } = useLocale()

const t = computed(() => (isZh.value
  ? {
      loading: '加载中…',
      empty: '暂无审批',
      titleFallback: '审批申请',
      status: {
        pending: '待处理',
        approved: '已通过',
        rejected: '已驳回',
        revoked: '已撤回',
        cancelled: '已取消',
      } as Record<string, string>,
      dateLocale: 'zh-CN',
    }
  : {
      loading: 'Loading…',
      empty: 'No approvals',
      titleFallback: 'Approval request',
      status: {
        pending: 'Pending',
        approved: 'Approved',
        rejected: 'Rejected',
        revoked: 'Revoked',
        cancelled: 'Cancelled',
      } as Record<string, string>,
      dateLocale: 'en-US',
    }
))

// `emptyText` stays an explicit override from the caller (e.g. a "no search
// matches" message); when the caller does not supply one, fall back to the
// localized default rather than a hardcoded literal.
const resolvedEmptyText = computed(() => props.emptyText ?? t.value.empty)

function statusTagType(status: string): string {
  const map: Record<string, string> = {
    pending: 'warning',
    approved: 'success',
    rejected: 'danger',
    revoked: 'info',
    cancelled: 'info',
  }
  return map[status] ?? 'info'
}

function statusLabel(status: string): string {
  return t.value.status[status] ?? status
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleString(t.value.dateLocale)
}

// B2-01: same row-summary glue the desktop table uses, resolved against the `templateSchemas`
// cache the parent owns and passes down as a prop.
function rowSummaryLine(row: UnifiedApprovalDTO): string {
  return resolveRowSummaryLine(props.templateSchemas, row)
}
</script>

<style scoped>
.approval-mobile-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.approval-mobile-list__loading,
.approval-mobile-list__empty {
  padding: 32px 16px;
  text-align: center;
  color: var(--el-text-color-secondary, #909399);
  font-size: 14px;
}

.approval-mobile-list__card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  text-align: left;
  background: #fff;
  border: 1px solid var(--el-border-color-lighter, #e4e7ed);
  border-radius: 10px;
  padding: 14px 16px;
  cursor: pointer;
  /* Touch target floor — comfortably above the 44px accessibility minimum. */
  min-height: 72px;
}

.approval-mobile-list__card:active {
  background: var(--el-fill-color-light, #f5f7fa);
}

.approval-mobile-list__card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.approval-mobile-list__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary, #303133);
  line-height: 1.4;
}

.approval-mobile-list__status {
  flex-shrink: 0;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--el-fill-color-light, #f5f7fa);
  color: var(--el-text-color-secondary, #909399);
}

.approval-mobile-list__status--warning {
  background: #fdf6ec;
  color: #e6a23c;
}

.approval-mobile-list__status--success {
  background: #f0f9eb;
  color: #67c23a;
}

.approval-mobile-list__status--danger {
  background: #fef0f0;
  color: #f56c6c;
}

.approval-mobile-list__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  color: var(--el-text-color-regular, #606266);
}

/* B2-01: key-field summary line — muted, single-line, ellipsis-truncated (mirrors the desktop
   table's `.approval-center__row-summary`); the full text stays reachable via the native `:title`
   tooltip. */
.approval-mobile-list__summary {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  color: var(--el-text-color-secondary, #909399);
}

.approval-mobile-list__date {
  font-size: 12px;
  color: var(--el-text-color-secondary, #909399);
}

/* B1-03: 已等待 aging severity — same warn/urgent palette as the desktop table. */
.approval-mobile-list__date--warn {
  color: #e6a23c;
}

.approval-mobile-list__date--urgent {
  color: #f56c6c;
}
</style>
