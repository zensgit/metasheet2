<template>
  <!--
    FWB-0 Layer 2 P2-4: Element Plus dialog primitive provides Escape, focus trap,
    and focus restoration. Token-only CSS (UF-6). Initial focus → search input on open.
  -->
  <el-dialog
    :model-value="visible"
    title="选择关联记录"
    width="480px"
    append-to-body
    destroy-on-close
    close-on-click-modal
    close-on-press-escape
    class="approval-record-link-picker-dialog"
    data-testid="approval-record-link-picker"
    aria-label="选择关联记录"
    @close="emit('close')"
    @opened="onDialogOpened"
  >
    <div class="approval-record-link-picker" data-testid="approval-record-link-picker-panel">
      <div class="approval-record-link-picker__search">
        <input
          ref="searchInputRef"
          v-model="search"
          class="approval-record-link-picker__input"
          type="search"
          placeholder="搜索显示名称"
          data-testid="approval-record-link-picker-search"
          @input="onSearch"
        />
      </div>
      <div class="approval-record-link-picker__body">
        <div v-if="loading" class="approval-record-link-picker__loading" data-testid="approval-record-link-picker-loading">
          加载中…
        </div>
        <div
          v-else-if="errorMessage"
          class="approval-record-link-picker__error"
          data-testid="approval-record-link-picker-error"
        >
          {{ errorMessage }}
        </div>
        <label
          v-for="rec in records"
          :key="rec.id"
          class="approval-record-link-picker__item"
          data-testid="approval-record-link-picker-item"
        >
          <input
            type="radio"
            name="approval-record-link-pick"
            :checked="selectedId === rec.id"
            @change="selectedId = rec.id"
          />
          <!-- Display is always a human label from the server — never a raw id. -->
          <span data-testid="approval-record-link-picker-item-label">{{ rec.display }}</span>
        </label>
        <div
          v-if="!loading && !errorMessage && records.length === 0"
          class="approval-record-link-picker__empty"
          data-testid="approval-record-link-picker-empty"
        >
          暂无可用记录
        </div>
        <button
          v-if="!loading && !errorMessage && hasMore"
          type="button"
          class="approval-record-link-picker__load-more"
          data-testid="approval-record-link-picker-load-more"
          @click="loadMore"
        >
          加载更多
        </button>
      </div>
    </div>
    <template #footer>
      <div class="approval-record-link-picker__footer">
        <button
          type="button"
          class="approval-record-link-picker__btn"
          data-testid="approval-record-link-picker-cancel"
          @click="emit('close')"
        >
          取消
        </button>
        <button
          type="button"
          class="approval-record-link-picker__btn approval-record-link-picker__btn--primary"
          data-testid="approval-record-link-picker-confirm"
          :disabled="!canConfirm"
          @click="onConfirm"
        >
          确认
        </button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { ElDialog } from 'element-plus'
import {
  listApprovalRecordLinkOptions,
  type ApprovalRecordLinkOption,
} from '../api'
import { RECORD_LINK_SELECTED_GENERIC } from '../recordLinkField'

const props = defineProps<{
  visible: boolean
  baseId: string
  sheetId: string
  currentRecordId?: string | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'confirm', payload: { recordId: string; display: string }): void
}>()

const search = ref('')
const records = ref<ApprovalRecordLinkOption[]>([])
const loading = ref(false)
const errorMessage = ref('')
const selectedId = ref<string | null>(null)
/**
 * Desired pin from currentRecordId on open/re-pin. Never treated as a confirmed selection
 * until the loaded option set for the *current* target proves the id belongs there.
 */
const desiredRecordId = ref<string | null>(null)
const page = ref({ offset: 0, limit: 20, total: 0, hasMore: false })
const hasMore = computed(() => page.value.hasMore)
const searchInputRef = ref<HTMLInputElement | null>(null)
/** Monotonic generation: only the latest in-flight request may commit records/page/error/loading. */
let loadGeneration = 0
let debounceTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Confirm only when not loading and selectedId is present in the currently loaded options
 * for this target — never a bare currentRecordId carried across re-pin / mid-flight.
 */
const canConfirm = computed(() => {
  if (loading.value) return false
  const id = typeof selectedId.value === 'string' ? selectedId.value.trim() : ''
  if (!id) return false
  return records.value.some((r) => r.id === id)
})

/** Drop a pending search debounce so it cannot fire after close / pin change / unmount. */
function clearPendingSearchDebounce() {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
}

/**
 * Invalidate every in-flight load and normalize loading. Used on close and unmount so a
 * later reopen (or a timer that somehow still fires) cannot race the new session.
 */
function invalidateInFlightLoads() {
  loadGeneration += 1
  loading.value = false
}

/** Apply desiredRecordId only when it appears in the loaded options for the current target. */
function reconcileSelectionWithLoadedOptions() {
  const desired = desiredRecordId.value
  if (!desired) {
    // Drop any selection that is not among current options (e.g. after search emptied the page).
    if (selectedId.value && !records.value.some((r) => r.id === selectedId.value)) {
      selectedId.value = null
    }
    return
  }
  if (records.value.some((r) => r.id === desired)) {
    selectedId.value = desired
  } else {
    // Target options do not prove membership — do not keep a cross-target stale id.
    selectedId.value = null
  }
}

watch(
  () => [props.visible, props.baseId, props.sheetId] as const,
  async ([visible]) => {
    // Always clear the pending debounce BEFORE close return or open/pin reset. Repro:
    // type → close → reopen <300ms: an uncleared timer would fire loadRecords, bump
    // generation, and supersede the reopen load.
    clearPendingSearchDebounce()
    if (!visible) {
      invalidateInFlightLoads()
      return
    }
    // Target change / open: never carry selectedId across until the new option set proves it.
    // Repro: repin while visible with old currentRecordId → confirm mid-load would emit the
    // old record under the new base/sheet.
    selectedId.value = null
    desiredRecordId.value = props.currentRecordId?.trim() || null
    search.value = ''
    page.value = { offset: 0, limit: 20, total: 0, hasMore: false }
    records.value = []
    errorMessage.value = ''
    loading.value = true
    await loadRecords(true)
  },
  { immediate: true },
)

onUnmounted(() => {
  clearPendingSearchDebounce()
  // Bump generation so any response still resolving after teardown cannot write state.
  loadGeneration += 1
})

/** Initial focus: search input after the dialog opens (Element Plus trap/Escape already active). */
async function onDialogOpened() {
  await nextTick()
  searchInputRef.value?.focus()
}

async function loadRecords(reset: boolean) {
  const generation = ++loadGeneration
  const baseId = props.baseId.trim()
  const sheetId = props.sheetId.trim()
  if (!baseId || !sheetId) {
    if (generation !== loadGeneration) return
    errorMessage.value = '目标表不可用'
    records.value = []
    selectedId.value = null
    loading.value = false
    return
  }
  loading.value = true
  if (reset) {
    errorMessage.value = ''
    // While reloading a target, selection is unproven until options arrive.
    selectedId.value = null
  }
  try {
    const nextOffset = reset ? 0 : page.value.offset
    const result = await listApprovalRecordLinkOptions({
      baseId,
      sheetId,
      search: search.value || undefined,
      limit: page.value.limit,
      offset: nextOffset,
    })
    // Stale response: a newer search / pin / load-more already owns the UI state.
    if (generation !== loadGeneration) return
    if (!result.ok) {
      // Fail closed: 403/404/empty network — no free-text / raw-id fallback.
      records.value = reset ? [] : records.value
      if (reset) selectedId.value = null
      if (result.status === 403 || result.status === 404) {
        errorMessage.value = '目标表不可用或无权访问'
      } else {
        errorMessage.value = '加载失败，请稍后重试'
      }
      page.value = { ...page.value, hasMore: false }
      return
    }
    const next = result.data.records
    records.value = reset ? next : [...records.value, ...next]
    // Advance by the requested page size (server contract), not post-sanitize length, so
    // hasMore cannot infinite-loop when client drops raw-id labels from a full page.
    page.value = {
      offset: nextOffset + result.data.page.limit,
      limit: result.data.page.limit,
      total: result.data.page.total,
      // Stop if this page produced zero safe labels (sanitize emptied it).
      hasMore: result.data.page.hasMore === true && next.length > 0,
    }
    reconcileSelectionWithLoadedOptions()
  } finally {
    if (generation === loadGeneration) {
      loading.value = false
    }
  }
}

function onSearch() {
  // Invalidate generation SYNCHRONOUSLY on input so any in-flight response from before the
  // debounce window cannot commit records/selection (even if it resolves in < 300ms).
  loadGeneration += 1
  clearPendingSearchDebounce()
  // Drop stale UI immediately — do not leave previous page selectable during debounce.
  records.value = []
  selectedId.value = null
  // Search is a new option set; do not auto-reselect previous currentRecordId under a filter.
  desiredRecordId.value = null
  errorMessage.value = ''
  page.value = { offset: 0, limit: page.value.limit, total: 0, hasMore: false }
  loading.value = true
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void loadRecords(true)
  }, 300)
}

function loadMore() {
  if (loading.value || !page.value.hasMore) return
  void loadRecords(false)
}

function onConfirm() {
  // Guard against mid-load / cross-target stale ids even if the button is forced.
  if (!canConfirm.value) return
  const id = selectedId.value?.trim()
  if (!id) return
  const match = records.value.find((r) => r.id === id)
  if (!match) return
  // Never emit a raw id as display.
  const display = match.display && match.display !== id
    ? match.display
    : RECORD_LINK_SELECTED_GENERIC
  emit('confirm', { recordId: id, display })
}
</script>

<style scoped>
/* Token-only (UF-6): no hardcoded hex/rgb. */
.approval-record-link-picker {
  display: flex;
  flex-direction: column;
  max-height: 60vh;
}
.approval-record-link-picker__search {
  padding: 0 0 8px;
}
.approval-record-link-picker__input {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--ms-border);
  border-radius: 4px;
  font-size: 13px;
  box-sizing: border-box;
  background: var(--ms-bg-card);
  color: var(--ms-text-1, inherit);
}
.approval-record-link-picker__body {
  flex: 1;
  overflow: auto;
  min-height: 120px;
}
.approval-record-link-picker__item {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 6px 0;
  cursor: pointer;
  font-size: 13px;
}
.approval-record-link-picker__loading,
.approval-record-link-picker__error,
.approval-record-link-picker__empty {
  font-size: 13px;
  color: var(--ms-text-2);
  padding: 12px 0;
}
.approval-record-link-picker__error {
  color: var(--ms-color-danger);
}
.approval-record-link-picker__load-more {
  margin-top: 8px;
  border: 1px solid var(--ms-border);
  background: var(--el-fill-color-light);
  border-radius: 4px;
  padding: 4px 10px;
  cursor: pointer;
  font-size: 12px;
  color: var(--ms-text-1, inherit);
}
.approval-record-link-picker__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.approval-record-link-picker__btn {
  border: 1px solid var(--ms-border);
  background: var(--ms-bg-card);
  border-radius: 4px;
  padding: 6px 14px;
  cursor: pointer;
  font-size: 13px;
  color: var(--ms-text-1, inherit);
}
.approval-record-link-picker__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.approval-record-link-picker__btn--primary {
  background: var(--ms-color-primary);
  border-color: var(--ms-color-primary);
  color: var(--ms-bg-card);
}
</style>
