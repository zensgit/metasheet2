<template>
  <div class="approval-department-picker" data-testid="approval-department-picker">
    <div class="approval-department-picker__mode" :aria-label="t.modeGroupLabel" role="group">
      <button
        type="button"
        :aria-pressed="!browseMode"
        :disabled="disabled"
        data-testid="approval-department-search-mode"
        @click="browseMode = false"
      >
        {{ t.modeSearch }}
      </button>
      <button
        type="button"
        :aria-pressed="browseMode"
        :disabled="disabled"
        data-testid="approval-department-tree-mode"
        @click="openTreeBrowse"
      >
        {{ t.modeBrowse }}
      </button>
    </div>

    <el-select
      v-if="!browseMode"
      :model-value="selectedIds"
      :multiple="selection === 'multi'"
      filterable
      remote
      clearable
      :remote-method="handleSearch"
      :loading="loading"
      :disabled="disabled"
      :placeholder="effectivePlaceholder"
      :aria-label="effectiveAriaLabel"
      data-testid="approval-department-search"
      @update:model-value="onSelect"
      @visible-change="onVisibleChange"
    >
      <el-option
        v-for="(option, index) in displayOptions"
        :key="option.id"
        :label="optionLabel(option, index)"
        :value="option.id"
        :disabled="isUnidentifiable(option) || isAtLimit(option.id)"
      />
    </el-select>

    <div v-else class="approval-department-picker__tree" data-testid="approval-department-tree">
      <div class="approval-department-picker__tree-header">
        <button
          v-if="browseStack.length > 0"
          type="button"
          :disabled="disabled || browseLoading"
          :aria-label="t.browseUpLabel"
          @click="browseUp"
        >
          {{ t.browseUp }}
        </button>
        <span>{{ browseStack[browseStack.length - 1]?.name || (isZh ? '全部部门' : 'All departments') }}</span>
      </div>
      <p v-if="browseLoading" role="status">{{ t.loading }}</p>
      <p v-else-if="browseOptions.length === 0" class="approval-department-picker__empty">{{ t.empty }}</p>
      <ul v-else class="approval-department-picker__tree-list">
        <li v-for="(option, index) in browseOptions" :key="option.id">
          <button
            type="button"
            :disabled="disabled || isUnidentifiable(option) || isAtLimit(option.id)"
            :aria-pressed="isSelected(option.id)"
            @click="toggleDepartment(option.id)"
          >
            {{ optionLabel(option, index) }}
          </button>
          <button
            v-if="option.hasChildren"
            type="button"
            :disabled="disabled"
            :aria-label="isZh ? `浏览${option.name}下级部门` : `Browse sub-departments of ${option.name}`"
            @click="browseInto(option)"
          >
            {{ t.browseChildren }}
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { DEPARTMENT_PICKER_EN, DEPARTMENT_PICKER_ZH } from './approvalPickerLabels'
import {
  searchApprovalDirectoryDepartments,
  type ApprovalDirectoryDepartment,
} from '../api'

export interface ApprovalDepartmentValue {
  id: string
  name?: string
  fullPath?: string
}

const props = withDefaults(defineProps<{
  modelValue?: ApprovalDepartmentValue[] | null
  selection?: 'single' | 'multi'
  display?: 'leaf_only' | 'full_path'
  maxSelections?: number
  defaultMode?: 'requester_department' | 'designated'
  defaultDepartmentIds?: string[]
  placeholder?: string
  ariaLabel?: string
  disabled?: boolean
}>(), {
  modelValue: () => [],
  selection: 'single',
  display: 'leaf_only',
  maxSelections: undefined,
  defaultMode: undefined,
  defaultDepartmentIds: () => [],
  placeholder: undefined,
  ariaLabel: undefined,
  disabled: false,
})

// O-8 / F8-1: picker chrome follows the shell locale; a host-supplied placeholder / aria-label
// still wins (the host localizes its own copy), otherwise the picker's own default is used.
const { isZh } = useLocale()
const t = computed(() => (isZh.value ? DEPARTMENT_PICKER_ZH : DEPARTMENT_PICKER_EN))
const effectivePlaceholder = computed(() => props.placeholder ?? t.value.defaultPlaceholder)
const effectiveAriaLabel = computed(() => props.ariaLabel ?? t.value.defaultAriaLabel)

const emit = defineEmits<{
  (event: 'update:modelValue', value: Array<{ id: string }>): void
}>()

const fetchedOptions = ref<ApprovalDirectoryDepartment[]>([])
const loading = ref(false)
const browseMode = ref(false)
const browseLoading = ref(false)
const browseOptions = ref<ApprovalDirectoryDepartment[]>([])
const browseStack = ref<Array<{ id: string; name: string }>>([])
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let searchGeneration = 0
let browseGeneration = 0
let defaultApplied = false

const selectedIds = computed(() => {
  const ids = (props.modelValue ?? []).map((entry) => entry.id).filter(Boolean)
  return props.selection === 'multi' ? ids : ids[0] ?? null
})

const initialOptions = computed<ApprovalDirectoryDepartment[]>(() => (
  (props.modelValue ?? []).flatMap((entry) => {
    const name = entry.name?.trim() ?? ''
    const fullPath = entry.fullPath?.trim() || name
    return entry.id
      ? [{ id: entry.id, name, fullPath, hasChildren: false }]
      : []
  })
))

const displayOptions = computed<ApprovalDirectoryDepartment[]>(() => {
  const options = [...fetchedOptions.value]
  for (const initial of initialOptions.value) {
    if (!options.some((option) => option.id === initial.id)) options.unshift(initial)
  }
  return options
})

function optionLabel(option: ApprovalDirectoryDepartment, index: number): string {
  const label = props.display === 'full_path' ? option.fullPath.trim() : option.name.trim()
  return label || (isZh.value ? `部门 ${index + 1}` : `Department ${index + 1}`)
}

function isUnidentifiable(option: ApprovalDirectoryDepartment): boolean {
  return !(props.display === 'full_path' ? option.fullPath.trim() : option.name.trim())
}

function isAtLimit(id: string): boolean {
  if (props.selection !== 'multi' || typeof props.maxSelections !== 'number') return false
  const ids = (props.modelValue ?? []).map((entry) => entry.id)
  return ids.length >= props.maxSelections && !ids.includes(id)
}

async function runSearch(query: string): Promise<void> {
  const generation = ++searchGeneration
  loading.value = true
  try {
    const result = await searchApprovalDirectoryDepartments(query)
    if (generation !== searchGeneration) return
    fetchedOptions.value = result.departments
    if (!defaultApplied && (props.modelValue ?? []).length === 0) {
      defaultApplied = true
      const defaultIds = props.defaultMode === 'requester_department'
        ? result.requesterDepartmentId ? [result.requesterDepartmentId] : []
        : props.defaultMode === 'designated'
          ? props.defaultDepartmentIds
          : []
      if (defaultIds.length > 0) onSelect(defaultIds)
    }
  } finally {
    if (generation === searchGeneration) loading.value = false
  }
}

function handleSearch(query: string): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => void runSearch(query), 300)
}

function onVisibleChange(visible: boolean): void {
  if (visible) void runSearch('')
}

function onSelect(value: unknown): void {
  const ids = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : typeof value === 'string' && value.length > 0
      ? [value]
      : []
  const bounded = props.selection === 'single'
    ? ids.slice(0, 1)
    : typeof props.maxSelections === 'number'
      ? ids.slice(0, props.maxSelections)
      : ids
  emit('update:modelValue', bounded.map((id) => ({ id })))
}

function isSelected(id: string): boolean {
  return (props.modelValue ?? []).some((entry) => entry.id === id)
}

function toggleDepartment(id: string): void {
  if (props.selection === 'single') {
    onSelect(isSelected(id) ? [] : id)
    return
  }
  const ids = (props.modelValue ?? []).map((entry) => entry.id)
  onSelect(ids.includes(id) ? ids.filter((entry) => entry !== id) : [...ids, id])
}

async function loadTree(parentId: string | null): Promise<void> {
  const generation = ++browseGeneration
  browseLoading.value = true
  try {
    const result = await searchApprovalDirectoryDepartments('', 50, parentId)
    if (generation === browseGeneration) browseOptions.value = result.departments
  } finally {
    if (generation === browseGeneration) browseLoading.value = false
  }
}

function openTreeBrowse(): void {
  browseMode.value = true
  browseStack.value = []
  void loadTree(null)
}

function browseInto(option: ApprovalDirectoryDepartment): void {
  browseStack.value.push({ id: option.id, name: option.name })
  void loadTree(option.id)
}

function browseUp(): void {
  browseStack.value.pop()
  void loadTree(browseStack.value[browseStack.value.length - 1]?.id ?? null)
}

onMounted(() => void runSearch(''))

onBeforeUnmount(() => {
  searchGeneration += 1
  browseGeneration += 1
  if (debounceTimer) clearTimeout(debounceTimer)
})
</script>

<style scoped>
.approval-department-picker {
  width: 100%;
}

.approval-department-picker__mode {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.approval-department-picker__mode button[aria-pressed='true'] {
  color: var(--el-color-primary);
  border-color: var(--el-color-primary);
}

.approval-department-picker__tree {
  border: 1px solid var(--el-border-color);
  padding: 8px;
}

.approval-department-picker__tree-header,
.approval-department-picker__tree-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.approval-department-picker__tree-list {
  list-style: none;
  padding: 0;
  margin: 8px 0 0;
}

.approval-department-picker__tree-list li + li {
  margin-top: 4px;
}

.approval-department-picker__tree-list li > button:first-child {
  flex: 1;
  min-width: 0;
  text-align: left;
}

.approval-department-picker__empty {
  color: var(--el-text-color-secondary);
}
</style>
