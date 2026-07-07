<template>
  <el-table
    ref="tableRef"
    v-loading="loading"
    :data="rows"
    size="default"
    class="ms-w-100pct"
    max-height="560"
    stripe
    highlight-current-row
    :row-key="showSelection ? resolveRowKey : undefined"
    @row-click="$emit('row-click', $event)"
    @selection-change="$emit('selection-change', $event)"
  >
    <el-table-column
      v-if="showSelection"
      type="selection"
      width="44"
      :selectable="selectable"
    />
    <el-table-column prop="requestNo" label="审批编号" width="180" />
    <el-table-column label="标题" min-width="200">
      <!-- B2-01: key-field summary — a muted second line under the title so common items are
           decidable without opening (see useApprovalListFieldSummary.ts, owned by the parent
           view and passed down here as a resolved `summaryLineFor(row)` function since its
           template-schema cache is shared across all four tabs). -->
      <template #default="{ row }: { row: UnifiedApprovalDTO }">
        {{ row.title }}
        <div
          v-if="summaryLineFor(row)"
          class="approval-center__row-summary"
          :title="summaryLineFor(row)"
        >
          {{ summaryLineFor(row) }}
        </div>
      </template>
    </el-table-column>
    <el-table-column label="发起人" width="120">
      <template #default="{ row }: { row: UnifiedApprovalDTO }">
        {{ row.requester?.name ?? '-' }}
      </template>
    </el-table-column>
    <el-table-column label="状态" width="100">
      <template #default="{ row }: { row: UnifiedApprovalDTO }">
        <StatusTag domain="approvalInstance" :status="row.status" />
      </template>
    </el-table-column>
    <el-table-column label="发起时间" width="180">
      <template #default="{ row }: { row: UnifiedApprovalDTO }">
        {{ formatDate(row.createdAt) }}
      </template>
    </el-table-column>
    <!-- B1-03 (part 2): 已等待 aging — glanceable severity (>3d warn / >7d urgent), pending-tab
         only. The 第 X/Y 步 sub-line only renders when both numbers are present. -->
    <el-table-column v-if="showWaitColumn" label="已等待" width="140">
      <template #default="{ row }: { row: UnifiedApprovalDTO }">
        <span :class="waitClass(row.createdAt)">{{ formatRelativeWait(row.createdAt) }}</span>
        <div
          v-if="row.currentStep != null && row.totalSteps != null"
          class="approval-center__wait-progress"
        >
          第 {{ row.currentStep }}/{{ row.totalSteps }} 步
        </div>
      </template>
    </el-table-column>
    <!-- Per-tab action column content differs materially (pending: inline approve/reject;
         mine: 已等待 hint + 催办; cc/completed: none) so the parent supplies it via slot rather
         than four boolean props; omitting the slot omits the column entirely (cc/completed). -->
    <el-table-column v-if="$slots.actions" label="操作" :width="actionsWidth" fixed="right">
      <template #default="{ row }: { row: UnifiedApprovalDTO }">
        <slot name="actions" :row="row" />
      </template>
    </el-table-column>
    <template #empty>
      <el-empty :description="emptyText" :image-size="100" />
    </template>
  </el-table>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { UnifiedApprovalDTO } from '../../types/approval'
import { formatRelativeWait, waitSeverity } from '../../approvals/relativeWait'
import StatusTag from '../../components/status/StatusTag.vue'

// UF-5 (ui-foundation-design-lock-20260706.md §6): the shared table body behind ApprovalCenterView's
// four tabs (待我处理/我发起的/抄送我的/已完成), which previously each hand-rolled the same
// ~90-line `<el-table>` block (编号/标题/发起人/状态/发起时间/操作 columns) with copy-paste drift
// risk. Column set here is the UNION of what the four originals rendered; per-tab visibility is
// gated ONLY where the originals genuinely differed:
//   - selection column + row-key + `selection-change` — pending only (batch approve/reject)
//   - 已等待 column — pending only (mine's own 已等待 hint lives inside its `actions` slot content)
//   - 操作 column — pending (approve/reject) and mine (催办) supply an `actions` slot; cc/completed
//     supply none, so the column itself does not render (mirrors the originals having NO 操作
//     column at all on those two tabs)
// Presentation-only: every data-testid, handler, and event lives in the parent's slot content /
// prop wiring, unchanged.
withDefaults(
  defineProps<{
    rows: UnifiedApprovalDTO[]
    loading: boolean
    emptyText: string
    /** Renders the selection column + enables `row-key`; pending tab only. */
    showSelection?: boolean
    /** `:selectable` predicate for the selection column (only consulted when `showSelection`). */
    selectable?: (row: UnifiedApprovalDTO) => boolean
    /** Renders the 已等待 aging column; pending tab only. */
    showWaitColumn?: boolean
    /** Width of the 操作 column when the `actions` slot is supplied (pending 150 / mine 170). */
    actionsWidth?: string | number
    /** Shared row-summary lookup owned by the parent (see useApprovalListFieldSummary.ts). */
    summaryLineFor: (row: UnifiedApprovalDTO) => string
  }>(),
  {
    showSelection: false,
    selectable: undefined,
    showWaitColumn: false,
    actionsWidth: 150,
  },
)

defineEmits<{
  (e: 'row-click', row: UnifiedApprovalDTO): void
  (e: 'selection-change', rows: UnifiedApprovalDTO[]): void
}>()

const tableRef = ref<{ clearSelection: () => void } | null>(null)

// Only ever bound when `showSelection` is true (the other three tabs never had a `row-key`
// attribute on their `<el-table>` at all).
function resolveRowKey(row: UnifiedApprovalDTO): string {
  return row.id
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleString('zh-CN')
}

// B1-03: 已等待 aging severity class — shared by the 已等待 column above.
function waitClass(createdAt: string): string {
  return `approval-center__wait approval-center__wait--${waitSeverity(createdAt)}`
}

// Exposed so the parent's existing `pendingTableRef.value?.clearSelection()` guard keeps working
// unchanged against this wrapper (the parent still only attaches its ref to the pending tab's
// instance of this component).
defineExpose({
  clearSelection: () => {
    if (typeof tableRef.value?.clearSelection === 'function') {
      tableRef.value.clearSelection()
    }
  },
})
</script>

<style scoped>
/* B2-01: key-field summary line — muted, single-line, ellipsis-truncated so a long value never
   wraps the row or blows out the column width; the full text stays reachable via the native
   `:title` tooltip. */
.approval-center__row-summary {
  margin-top: 2px;
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  color: var(--el-text-color-secondary);
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

.approval-center__wait-progress {
  margin-top: 2px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
