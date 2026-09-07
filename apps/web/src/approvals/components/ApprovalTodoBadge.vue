<template>
  <span
    v-if="pendingCount > 0"
    class="approval-todo-badge"
    data-testid="approval-todo-badge"
    role="status"
    :aria-label="label"
    :title="label"
  >{{ displayCount }}</span>
</template>

<script setup lang="ts">
// P1b slice 1 — the app-level 待办 badge for the top-nav 审批中心 entry.
//
// WHAT IT REUSES, and what it deliberately does NOT do:
//   * The count is the SAME server-owned pending count the 审批中心 header already renders
//     (`getPendingCount` → GET /api/approvals/pending-count, and the `approval:counts-updated`
//     socket push via `useApprovalCountsRealtime`). It is the total 待办 `count`, the figure
//     ApprovalCenterView.vue shows beside 待办 — NOT the `unreadCount` its 未读 chip shows.
//   * It writes NOTHING. In particular it does not create or write a notification-inbox record:
//     the inbox is a multitable record-subscription model and approval tasks do not belong in it.
//   * It NEVER reloads a list. The existing no-auto-reload discipline (ApprovalCenterView's
//     G-B2-11 pill: a realtime push moves the count, never the rows) is preserved here by
//     construction — this component owns one number and renders it; it has no list to reload and
//     no router navigation of its own.
//
// The label is passed in by the caller rather than resolved here, so the nav keeps ONE i18n table
// (App.vue's `navLabels`) instead of growing a second one. The label carries no values — it names
// the surface ("待办审批" / "Pending approvals"); the badge text is the count alone.
import { computed, onMounted, ref } from 'vue'
import { getPendingCount } from '../api'
import { useApprovalCountsRealtime, type ApprovalCountsUpdatedPayload } from '../useApprovalCountsRealtime'

const props = withDefaults(defineProps<{
  label: string
  /** Counts above this render as `<overflowAt>+` so the nav pill cannot grow without bound. */
  overflowAt?: number
}>(), {
  overflowAt: 99,
})

const pendingCount = ref(0)

function applyCount(value: unknown): void {
  pendingCount.value = typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0
}

const displayCount = computed(() => (
  pendingCount.value > props.overflowAt ? `${props.overflowAt}+` : String(pendingCount.value)
))

// Same scoping rule ApprovalCenterView.handleRealtimeCountsUpdated uses: prefer the per-source
// bucket for the scope being displayed, fall back to the payload root. The nav badge is unscoped,
// so its bucket is 'all'.
function handleCountsUpdated(payload: ApprovalCountsUpdatedPayload): void {
  const scoped = payload.countsBySourceSystem?.all ?? payload
  applyCount(scoped.count)
}

useApprovalCountsRealtime({ onCountsUpdated: handleCountsUpdated })

async function refresh(): Promise<void> {
  try {
    const result = await getPendingCount('all')
    applyCount(result.count)
  } catch {
    // Decorative surface: a failed count must never surface an error in the shell chrome.
    // Falling back to 0 hides the badge rather than rendering a stale or invented figure.
    applyCount(0)
  }
}

onMounted(() => {
  void refresh()
})

defineExpose({ refresh })
</script>

<style scoped>
.approval-todo-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--el-color-danger);
  color: var(--el-color-white);
  font-size: 12px;
  line-height: 1;
  font-weight: 600;
}
</style>
