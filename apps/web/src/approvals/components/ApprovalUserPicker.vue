<template>
  <el-select
    :model-value="modelValue ?? undefined"
    filterable
    remote
    clearable
    :remote-method="handleSearch"
    :loading="loading"
    :disabled="disabled"
    :placeholder="placeholder"
    data-testid="approval-user-picker"
    style="width: 100%"
    @update:model-value="onSelect"
    @visible-change="onVisibleChange"
  >
    <el-option
      v-for="(option, index) in displayOptions"
      :key="option.id"
      :label="optionLabel(option, index)"
      :value="option.id"
    />
  </el-select>
</template>

<script setup lang="ts">
// B3-04 D-2 — the ONE reusable participant picker for real approval actors, replacing the
// hardcoded 李四/王五/赵六/张三 fake option lists that previously shipped in the transfer /
// add-sign / fill-form user field / delegation delegatee surfaces (a production correctness
// defect — those ids were never real users). Hits the D-1 participant directory endpoint
// (GET /api/approvals/directory/users, #3664) via `searchApprovalDirectoryUsers`, which any
// approval participant can reach (approvals:read|write|act union), not just a template author.
//
// Modeled on the AUTHOR picker (TemplateAuthoringView's `approval-step-user-picker`, backed by
// `useApprovalDirectory`): same filterable+remote+remote-method el-select shape, same
// `visible-change` re-search-on-open, same "name · email" label fallback-to-id formatting. This
// component is deliberately simpler (no composable, no ensure-visible-after-page reconciliation)
// since it is single-select and none of its 4 call sites currently need to preserve a
// prior-page selection across a re-search — the `initialOption` prop covers the one case that
// legitimately needs a pre-existing label (a preselected id with a known display name).
//
// Kept dumb/pure: no store coupling, no side effects beyond the directory fetch. Emits the
// picked id via standard v-model (`update:modelValue`) plus a richer `select` event carrying the
// full { id, name, email } option — the latter lets a caller that manages its OWN list (e.g. the
// add-sign "repeated pick" chips) show a friendly label without a second lookup.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { searchApprovalDirectoryUsers, type ApprovalDirectoryUser } from '../api'

export type ApprovalUserPickerOption = ApprovalDirectoryUser

const props = withDefaults(defineProps<{
  modelValue?: string | null
  placeholder?: string
  disabled?: boolean
  /** Seeds a display label for a pre-existing modelValue before/without a matching fetched page (edit/preselected case). */
  initialOption?: ApprovalUserPickerOption | null
}>(), {
  modelValue: null,
  placeholder: '搜索用户名 / 邮箱 / ID',
  disabled: false,
  initialOption: null,
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: string | null): void
  (e: 'select', option: ApprovalUserPickerOption | null): void
}>()

const fetchedOptions = ref<ApprovalUserPickerOption[]>([])
const loading = ref(false)
let debounceTimer: ReturnType<typeof setTimeout> | null = null

// Keeps `initialOption` visible even after a search page that doesn't happen to include its id —
// without this, a preselected value would render as a blank/id-only chip once any search runs.
const displayOptions = computed<ApprovalUserPickerOption[]>(() => {
  const initial = props.initialOption
  if (!initial || !initial.id || fetchedOptions.value.some((option) => option.id === initial.id)) {
    return fetchedOptions.value
  }
  return [initial, ...fetchedOptions.value]
})

// raw-id-exposure-fix (20260819) follow-up: this used to fall back to the raw directory
// `option.id` whenever `option.name` was blank/absent — the exact shape `searchApprovalDirectoryUsers`
// (api.ts) produces for a real backend record with a missing/non-string `name` (defaulted to `''`,
// not omitted). Two of this component's own call sites (ApprovalDetailView's 转交/加签 pickers)
// override the default placeholder with text that does NOT advertise id-based search, so a raw id
// rendered here was a plain leak on those flows, not a documented/expected search affordance.
// Falls back to the same values-free, per-list ordinal (`成员 N`) convention already used by
// `assignmentDisplayLabel`/`reducibleAssignees`/`assigneeLabel` — distinguishable across options,
// never the id. The `email` suffix (when present) is unaffected: it is real directory metadata,
// not a values-free placeholder, and search-by-id still works server-side regardless of what the
// option TEXT renders as.
function optionLabel(option: ApprovalUserPickerOption, index: number): string {
  const primary = option.name?.trim() || `成员 ${index + 1}`
  const email = option.email?.trim()
  return email ? `${primary} · ${email}` : primary
}

async function runSearch(query: string): Promise<void> {
  loading.value = true
  try {
    fetchedOptions.value = await searchApprovalDirectoryUsers(query)
  } catch {
    // Defensive belt-and-suspenders: searchApprovalDirectoryUsers already never throws (it
    // resolves to [] on any failure internally) — this catch only guards a misbehaving mock/DI
    // in tests from ever reaching the caller.
    fetchedOptions.value = []
  } finally {
    loading.value = false
  }
}

// ~300ms debounce on typed queries (matches MetaPersonPicker/MetaLinkPicker's established
// setTimeout convention in this codebase) — the initial page (onMounted) and the
// re-search-on-open (visible-change) below run immediately, undebounced.
function handleSearch(query: string): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    void runSearch(query)
  }, 300)
}

function onVisibleChange(visible: boolean): void {
  if (visible) void runSearch('')
}

function onSelect(value: unknown): void {
  const id = typeof value === 'string' && value.length > 0 ? value : null
  emit('update:modelValue', id)
  emit('select', id ? displayOptions.value.find((option) => option.id === id) ?? null : null)
}

onMounted(() => {
  void runSearch('')
})

onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer)
})
</script>
