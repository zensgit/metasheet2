<template>
  <div class="approval-department-picker" data-testid="approval-department-picker">
    <div class="approval-department-picker__mode" role="group" aria-label="部门选择方式">
      <button
        type="button"
        :aria-pressed="!browseMode"
        :disabled="disabled"
        data-testid="approval-department-search-mode"
        @click="browseMode = false"
      >
        搜索
      </button>
      <button
        type="button"
        :aria-pressed="browseMode"
        :disabled="disabled"
        data-testid="approval-department-tree-mode"
        @click="openTreeBrowse"
      >
        浏览
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
      :placeholder="placeholder"
      :aria-label="ariaLabel"
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
          aria-label="返回上级部门"
          @click="browseUp"
        >
          返回上级
        </button>
        <span>{{ browseStack.at(-1)?.name || '全部部门' }}</span>
      </div>
      <p v-if="browseLoading" role="status">正在加载部门</p>
      <p v-else-if="browseOptions.length === 0" class="approval-department-picker__empty">暂无部门</p>
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
            :aria-label="`浏览${option.name}下级部门`"
            @click="browseInto(option)"
          >
            下级
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
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
  placeholder: '搜索并选择部门',
  ariaLabel: '选择部门',
  disabled: false,
})

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
  return label || `部门 ${index + 1}`
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
  void loadTree(browseStack.value.at(-1)?.id ?? null)
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
