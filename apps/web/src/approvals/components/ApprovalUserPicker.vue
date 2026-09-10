<template>
  <el-select
    :model-value="modelValue ?? undefined"
    filterable
    remote
    clearable
    :multiple="multiple"
    :multiple-limit="multiple ? maxSelections ?? 0 : 0"
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
      :disabled="isUnidentifiable(option)"
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
// `visible-change` re-search-on-open and values-free display labels. This component is deliberately
// simpler than the author picker (no store coupling); `initialOption` / `initialOptions` preserve
// pre-existing single or multi selections across paged re-searches.
//
// Kept dumb/pure: no store coupling, no side effects beyond the directory fetch. Emits the
// picked id via standard v-model (`update:modelValue`) plus a richer `select` event carrying the
// full { id, name, email } option — the latter lets a caller that manages its OWN list (e.g. the
// add-sign "repeated pick" chips) show a friendly label without a second lookup.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { searchApprovalDirectoryUsers, type ApprovalDirectoryUser } from '../api'

export type ApprovalUserPickerOption = ApprovalDirectoryUser

const props = withDefaults(defineProps<{
  modelValue?: string | string[] | null
  placeholder?: string
  disabled?: boolean
  multiple?: boolean
  maxSelections?: number
  excludedUserIds?: readonly string[]
  /** Seeds a display label for a pre-existing modelValue before/without a matching fetched page (edit/preselected case). */
  initialOption?: ApprovalUserPickerOption | null
  /** Multi-select counterpart of initialOption; selected ids stay values-free before batch resolution completes. */
  initialOptions?: readonly ApprovalUserPickerOption[]
}>(), {
  modelValue: null,
  placeholder: '搜索用户名 / 邮箱 / ID',
  disabled: false,
  multiple: false,
  maxSelections: undefined,
  excludedUserIds: () => [],
  initialOption: null,
  initialOptions: () => [],
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: string | null): void
  (e: 'update:multipleModelValue', value: string[]): void
  (e: 'select', option: ApprovalUserPickerOption | null): void
}>()

const fetchedOptions = ref<ApprovalUserPickerOption[]>([])
const loading = ref(false)
let debounceTimer: ReturnType<typeof setTimeout> | null = null

// Keeps `initialOption` visible even after a search page that doesn't happen to include its id —
// without this, a preselected value would render as a blank/id-only chip once any search runs.
const displayOptions = computed<ApprovalUserPickerOption[]>(() => {
  const initial = [
    ...(props.initialOption ? [props.initialOption] : []),
    ...props.initialOptions,
  ]
  const seen = new Set(fetchedOptions.value.map((option) => option.id))
  const missing = initial.filter((option) => option.id && !seen.has(option.id))
  if (missing.length === 0) {
    return fetchedOptions.value
  }
  return [...missing, ...fetchedOptions.value]
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

// member-display-identity (2026-08-19) — owner directive: this picker backs 4+ FLOW-CHANGING
// selections (transfer / add-sign / fill-form user field / delegation delegatee), so a directory
// entry with no resolvable name must be more than relabelled with an ordinal — it must be
// UNSELECTABLE, so an admin can never hand real approval authority to an account they cannot
// identify. The directory search result already carries the freshest name truth for this id (same
// `users.name` column a separate batch resolve call would read), so no extra round trip is needed
// here — a blank `option.name` IS the unresolved signal. The current `modelValue`'s own option
// (typically surfaced via `initialOption`) is exempt: a caller must never render its OWN existing
// selection as unselectable, or the field would appear to reject its own current value.
function isUnidentifiable(option: ApprovalUserPickerOption): boolean {
  if (props.excludedUserIds.includes(option.id)) return true
  const selected = Array.isArray(props.modelValue)
    ? props.modelValue.includes(option.id)
    : option.id === props.modelValue
  if (selected) return false
  return !option.name?.trim()
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
  if (props.multiple) {
    const ids = Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      : []
    emit('update:multipleModelValue', ids)
    emit('select', null)
    return
  }
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
