<template>
  <div class="link-picker">
    <!-- Selected items display -->
    <div class="link-picker__selected" @click="toggleDropdown">
      <div v-if="selectedItems.length === 0" class="link-picker__placeholder">
        {{ placeholder }}
      </div>
      <div v-else class="link-picker__tags">
        <span
          v-for="item in selectedItems"
          :key="item.id"
          class="link-picker__tag"
        >
          {{ item.display || item.id }}
          <button
            v-if="!readonly"
            class="link-picker__tag-remove"
            type="button"
            @click.stop="removeItem(item.id)"
          >
            &times;
          </button>
        </span>
      </div>
      <span v-if="!readonly" class="link-picker__arrow">&#9662;</span>
    </div>

    <!-- Dropdown -->
    <Teleport to="body">
      <div
        v-if="isOpen && !readonly"
        ref="dropdownRef"
        class="link-picker__dropdown"
        :style="dropdownStyle"
      >
        <!-- Search input -->
        <div class="link-picker__search-wrapper">
          <input
            ref="searchInputRef"
            v-model="searchQuery"
            type="text"
            class="link-picker__search"
            :placeholder="searchPlaceholder"
            @input="handleSearchDebounced"
          />
        </div>

        <!-- Options list -->
        <div class="link-picker__options" @scroll="handleScroll">
          <div v-if="loading" class="link-picker__loading">Loading...</div>
          <div v-else-if="options.length === 0" class="link-picker__empty">
            {{ searchQuery ? 'No matching records' : 'No records available' }}
          </div>
          <template v-else>
            <div
              v-for="option in options"
              :key="option.id"
              class="link-picker__option"
              :class="{
                'link-picker__option--selected': isSelected(option.id),
              }"
              @click="toggleOption(option)"
            >
              <span v-if="multiple" class="link-picker__checkbox">
                {{ isSelected(option.id) ? '&#9745;' : '&#9744;' }}
              </span>
              <span class="link-picker__option-label">
                {{ option.display || option.id }}
              </span>
            </div>
          </template>
          <div v-if="hasMore && !loading" class="link-picker__load-more">
            <button type="button" @click="loadMore">Load more...</button>
          </div>
        </div>

        <!-- Actions for multi-select -->
        <div v-if="multiple" class="link-picker__actions">
          <button type="button" class="link-picker__btn" @click="clearSelection">
            Clear
          </button>
          <button type="button" class="link-picker__btn link-picker__btn--primary" @click="confirmSelection">
            OK
          </button>
        </div>
      </div>
    </Teleport>

    <!-- Click outside overlay -->
    <div
      v-if="isOpen && !readonly"
      class="link-picker__overlay"
      @click="closeDropdown"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { apiFetch } from '../utils/api'

export interface LinkOption {
  id: string
  display: string
}

interface Props {
  /** Currently selected record IDs */
  modelValue: string[]
  /** The foreign sheet to load records from */
  foreignSheetId: string
  /** Optional display field ID for showing record names */
  displayFieldId?: string | null
  /** Whether multiple selection is allowed */
  multiple?: boolean
  /** Placeholder text */
  placeholder?: string
  /** Search input placeholder */
  searchPlaceholder?: string
  /** Whether the picker is read-only */
  readonly?: boolean
  /** API prefix (default: /api/univer-meta) */
  apiPrefix?: string
}

const props = withDefaults(defineProps<Props>(), {
  multiple: false,
  placeholder: 'Select record...',
  searchPlaceholder: 'Search...',
  readonly: false,
  apiPrefix: '/api/univer-meta',
  displayFieldId: null,
})

export interface LinkChangePayload {
  ids: string[]
  displays: string[]
}

const emit = defineEmits<{
  'update:modelValue': [value: string[]]
  change: [payload: LinkChangePayload]
}>()

// State
const isOpen = ref(false)
const loading = ref(false)
const searchQuery = ref('')
const options = ref<LinkOption[]>([])
const selectedItems = ref<LinkOption[]>([])
const hasMore = ref(false)
const offset = ref(0)
const total = ref(0)
const triggerRef = ref<HTMLDivElement | null>(null)
const dropdownRef = ref<HTMLDivElement | null>(null)
const searchInputRef = ref<HTMLInputElement | null>(null)
// Cache displayMap from API for efficient id->display lookup
const displayMapCache = ref<Record<string, string>>({})
const recordsCache = new Map<string, { records: LinkOption[]; total: number; hasMore: boolean; displayMap: Record<string, string> }>()

// Debounce timer
let searchTimer: number | null = null

// Dropdown positioning
const dropdownStyle = ref<{ top: string; left: string; width: string }>({
  top: '0px',
  left: '0px',
  width: '300px',
})

// Load records from API
async function loadRecords(reset = false) {
  if (!props.foreignSheetId) return

  if (reset) {
    offset.value = 0
    options.value = []
  }

  loading.value = true

  try {
    const cacheKey = [
      props.foreignSheetId,
      props.displayFieldId ?? '',
      searchQuery.value.trim(),
      String(offset.value),
    ].join('|')
    const cached = recordsCache.get(cacheKey)
    if (cached) {
      if (reset) {
        options.value = cached.records
      } else {
        options.value = [...options.value, ...cached.records]
      }
      total.value = cached.total
      hasMore.value = cached.hasMore
      if (Object.keys(cached.displayMap).length > 0) {
        displayMapCache.value = { ...displayMapCache.value, ...cached.displayMap }
      }
      return
    }

    const params = new URLSearchParams({
      sheetId: props.foreignSheetId,
      limit: '50',
      offset: String(offset.value),
    })
    if (props.displayFieldId) {
      params.set('displayFieldId', props.displayFieldId)
    }
    if (searchQuery.value) {
      params.set('search', searchQuery.value)
    }

    const res = await apiFetch(`${props.apiPrefix}/records-summary?${params.toString()}`)
    const json = await res.json()

    if (json.ok && json.data) {
      const newRecords = json.data.records as LinkOption[]
      if (reset) {
        options.value = newRecords
      } else {
        options.value = [...options.value, ...newRecords]
      }
      total.value = json.data.page?.total ?? 0
      hasMore.value = json.data.page?.hasMore ?? false
      // Merge displayMap into cache for efficient lookup
      if (json.data.displayMap) {
        displayMapCache.value = { ...displayMapCache.value, ...json.data.displayMap }
      }
      recordsCache.set(cacheKey, {
        records: newRecords,
        total: total.value,
        hasMore: hasMore.value,
        displayMap: json.data.displayMap ?? {},
      })
    }
  } catch (err) {
    console.error('[LinkPicker] Failed to load records:', err)
  } finally {
    loading.value = false
  }
}

// Load selected item details
async function loadSelectedItems() {
  if (props.modelValue.length === 0) {
    selectedItems.value = []
    return
  }

  // First try to resolve from cache and options
  const found: LinkOption[] = []
  const missing: string[] = []

  for (const id of props.modelValue) {
    // Check displayMap cache first
    if (displayMapCache.value[id] !== undefined) {
      found.push({ id, display: displayMapCache.value[id] })
    } else {
      // Check options list
      const existing = options.value.find((o) => o.id === id)
      if (existing) {
        found.push(existing)
      } else {
        missing.push(id)
      }
    }
  }

  // If we have missing items, fetch displayMap from API
  if (missing.length > 0 && props.foreignSheetId) {
    try {
      const params = new URLSearchParams({
        sheetId: props.foreignSheetId,
        limit: '1000', // Load more to find selected items
      })
      if (props.displayFieldId) {
        params.set('displayFieldId', props.displayFieldId)
      }

      const res = await apiFetch(`${props.apiPrefix}/records-summary?${params.toString()}`)
      const json = await res.json()

      if (json.ok && json.data) {
        // Merge displayMap into cache
        if (json.data.displayMap) {
          displayMapCache.value = { ...displayMapCache.value, ...json.data.displayMap }
        }
        // Resolve missing items from displayMap
        for (const id of missing) {
          const display = displayMapCache.value[id] ?? id
          found.push({ id, display })
        }
      }
    } catch (err) {
      // Fall back to using IDs as display
      for (const id of missing) {
        found.push({ id, display: id })
      }
    }
  }

  // Sort to match modelValue order
  selectedItems.value = props.modelValue.map(
    (id) => found.find((f) => f.id === id) ?? { id, display: displayMapCache.value[id] ?? id }
  )
}

// Handlers
function toggleDropdown() {
  if (props.readonly) return
  if (isOpen.value) {
    closeDropdown()
  } else {
    openDropdown()
  }
}

async function openDropdown() {
  isOpen.value = true
  await nextTick()
  updateDropdownPosition()
  searchInputRef.value?.focus()
  if (options.value.length === 0) {
    loadRecords(true)
  }
}

function closeDropdown() {
  isOpen.value = false
  searchQuery.value = ''
}

function updateDropdownPosition() {
  const trigger = document.querySelector('.link-picker__selected')
  if (!trigger) return

  const rect = trigger.getBoundingClientRect()
  const viewportHeight = window.innerHeight
  const dropdownHeight = 300 // approximate

  let top = rect.bottom + 4
  if (top + dropdownHeight > viewportHeight) {
    top = rect.top - dropdownHeight - 4
  }

  dropdownStyle.value = {
    top: `${top}px`,
    left: `${rect.left}px`,
    width: `${Math.max(rect.width, 250)}px`,
  }
}

function handleSearchDebounced() {
  if (searchTimer) window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    loadRecords(true)
  }, 300)
}

function handleScroll(event: Event) {
  const target = event.target as HTMLDivElement
  if (target.scrollTop + target.clientHeight >= target.scrollHeight - 10) {
    if (hasMore.value && !loading.value) {
      loadMore()
    }
  }
}

function loadMore() {
  offset.value = options.value.length
  loadRecords(false)
}

function isSelected(id: string): boolean {
  return props.modelValue.includes(id)
}

// Build change payload with ids and displays
function buildChangePayload(ids: string[]): LinkChangePayload {
  const displays = ids.map((id) => {
    // Try cache first, then options, fallback to id
    if (displayMapCache.value[id] !== undefined) return displayMapCache.value[id]
    const opt = options.value.find((o) => o.id === id)
    return opt?.display ?? id
  })
  return { ids, displays }
}

function toggleOption(option: LinkOption) {
  // Update cache with selected option's display
  displayMapCache.value[option.id] = option.display

  if (props.multiple) {
    const newValue = isSelected(option.id)
      ? props.modelValue.filter((id) => id !== option.id)
      : [...props.modelValue, option.id]
    emit('update:modelValue', newValue)
  } else {
    // Single select: immediately select and close
    emit('update:modelValue', [option.id])
    emit('change', buildChangePayload([option.id]))
    closeDropdown()
  }
}

function removeItem(id: string) {
  const newValue = props.modelValue.filter((v) => v !== id)
  emit('update:modelValue', newValue)
  emit('change', buildChangePayload(newValue))
}

function clearSelection() {
  emit('update:modelValue', [])
}

function confirmSelection() {
  emit('change', buildChangePayload(props.modelValue))
  closeDropdown()
}

// Watch for modelValue changes
watch(
  () => props.modelValue,
  () => {
    loadSelectedItems()
  },
  { immediate: true }
)

// Watch for foreignSheetId changes
watch(
  () => [props.foreignSheetId, props.displayFieldId],
  () => {
    options.value = []
    recordsCache.clear()
    displayMapCache.value = {}
    if (isOpen.value) {
      loadRecords(true)
    }
  }
)

// Cleanup
onUnmounted(() => {
  if (searchTimer) window.clearTimeout(searchTimer)
})
</script>

<style scoped>
.link-picker {
  position: relative;
  display: inline-block;
  width: 100%;
}

.link-picker__selected {
  display: flex;
  align-items: center;
  min-height: 32px;
  padding: 4px 8px;
  background: #fff;
  border: 1px solid #d9d9d9;
  border-radius: 4px;
  cursor: pointer;
  transition: border-color 0.2s;
}

.link-picker__selected:hover {
  border-color: #1677ff;
}

.link-picker__placeholder {
  color: #bfbfbf;
  flex: 1;
}

.link-picker__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  flex: 1;
}

.link-picker__tag {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  background: #f0f0f0;
  border-radius: 4px;
  font-size: 12px;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.link-picker__tag-remove {
  margin-left: 4px;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  color: #999;
  font-size: 14px;
  line-height: 1;
}

.link-picker__tag-remove:hover {
  color: #ff4d4f;
}

.link-picker__arrow {
  margin-left: 4px;
  color: #999;
  font-size: 10px;
}

.link-picker__overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 9998;
}

.link-picker__dropdown {
  position: fixed;
  z-index: 9999;
  background: #fff;
  border: 1px solid #d9d9d9;
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  max-height: 300px;
  display: flex;
  flex-direction: column;
}

.link-picker__search-wrapper {
  padding: 8px;
  border-bottom: 1px solid #f0f0f0;
}

.link-picker__search {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid #d9d9d9;
  border-radius: 4px;
  font-size: 13px;
  outline: none;
}

.link-picker__search:focus {
  border-color: #1677ff;
}

.link-picker__options {
  flex: 1;
  overflow-y: auto;
  max-height: 200px;
}

.link-picker__option {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.link-picker__option:hover {
  background-color: #f5f5f5;
}

.link-picker__option--selected {
  background-color: #e6f4ff;
}

.link-picker__checkbox {
  margin-right: 8px;
  font-size: 14px;
}

.link-picker__option-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.link-picker__loading,
.link-picker__empty {
  padding: 16px;
  text-align: center;
  color: #999;
  font-size: 13px;
}

.link-picker__load-more {
  padding: 8px;
  text-align: center;
}

.link-picker__load-more button {
  padding: 4px 12px;
  background: none;
  border: 1px solid #d9d9d9;
  border-radius: 4px;
  cursor: pointer;
  color: #666;
  font-size: 12px;
}

.link-picker__load-more button:hover {
  border-color: #1677ff;
  color: #1677ff;
}

.link-picker__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 8px;
  border-top: 1px solid #f0f0f0;
}

.link-picker__btn {
  padding: 4px 12px;
  border: 1px solid #d9d9d9;
  border-radius: 4px;
  background: #fff;
  cursor: pointer;
  font-size: 13px;
}

.link-picker__btn:hover {
  border-color: #1677ff;
  color: #1677ff;
}

.link-picker__btn--primary {
  background: #1677ff;
  border-color: #1677ff;
  color: #fff;
}

.link-picker__btn--primary:hover {
  background: #4096ff;
  border-color: #4096ff;
  color: #fff;
}

/* Dark mode */
@media (prefers-color-scheme: dark) {
  .link-picker__selected {
    background: #1f1f1f;
    border-color: #434343;
    color: #e0e0e0;
  }

  .link-picker__tag {
    background: #333;
    color: #e0e0e0;
  }

  .link-picker__dropdown {
    background: #1f1f1f;
    border-color: #434343;
  }

  .link-picker__search-wrapper {
    border-color: #333;
  }

  .link-picker__search {
    background: #141414;
    border-color: #434343;
    color: #e0e0e0;
  }

  .link-picker__option:hover {
    background-color: #333;
  }

  .link-picker__option--selected {
    background-color: #111d2c;
  }
}
</style>
