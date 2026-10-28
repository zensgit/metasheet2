<template>
  <div class="directory-picker" :data-testid="testId">
    <div class="directory-picker__chips">
      <span
        v-for="value in selected"
        :key="value"
        class="directory-picker__chip"
        :class="{ 'directory-picker__chip--unknown': isUnknown(value) }"
        :data-value="value"
        :title="readChipTitle(value)"
      >
        <span class="directory-picker__chip-label">{{ readChipLabel(value) }}</span>
        <small v-if="readChipDetail(value)" class="directory-picker__chip-detail">{{ readChipDetail(value) }}</small>
        <button
          class="directory-picker__chip-remove"
          type="button"
          :aria-label="`移除 ${readChipLabel(value)}`"
          @click="removeValue(value)"
        >
          ×
        </button>
      </span>
      <span v-if="selected.length === 0" class="directory-picker__placeholder">{{ emptySelectionText }}</span>
      <button
        class="directory-picker__toggle"
        type="button"
        :aria-expanded="open ? 'true' : 'false'"
        @click="togglePanel()"
      >
        {{ open ? '收起' : openLabel }}
      </button>
    </div>
    <div v-if="open" class="directory-picker__panel">
      <p v-if="loading && !loaded" class="directory-picker__hint">加载中...</p>
      <p v-else-if="error" class="directory-picker__hint directory-picker__hint--empty">{{ error }}</p>
      <p v-else-if="!loaded" class="directory-picker__hint">{{ notLoadedText }}</p>
      <p v-else-if="options.length === 0" class="directory-picker__hint directory-picker__hint--empty">{{ emptyText }}</p>
      <template v-else>
        <input
          v-model="query"
          class="directory-picker__search"
          type="search"
          :placeholder="searchPlaceholder"
          :aria-label="searchPlaceholder"
        />
        <ul class="directory-picker__options">
          <li v-for="option in visibleOptions" :key="option.value">
            <label class="directory-picker__option" :data-value="option.value">
              <input
                :type="multiple ? 'checkbox' : 'radio'"
                :name="multiple ? undefined : radioGroupName"
                :checked="selectedSet.has(option.value)"
                @change="toggleValue(option.value)"
              />
              <span>{{ option.label }}</span>
              <small v-if="option.detail && option.detail !== option.label">{{ option.detail }}</small>
            </label>
          </li>
        </ul>
        <p v-if="matchedOptions.length === 0" class="directory-picker__hint">没有匹配“{{ query.trim() }}”的选项</p>
        <p v-else-if="matchedOptions.length > visibleOptions.length" class="directory-picker__hint">
          还有 {{ matchedOptions.length - visibleOptions.length }} 项未显示，请输入关键字缩小范围
        </p>
      </template>
    </div>
  </div>
</template>

<script lang="ts">
let nextPickerInstanceId = 0
</script>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { DirectoryPickerOption } from '../../views/directoryConfigPickerOptions'

const props = withDefaults(defineProps<{
  selected: string[]
  options: DirectoryPickerOption[]
  unknownLabel: (value: string) => string
  multiple?: boolean
  loaded?: boolean
  loading?: boolean
  error?: string
  openLabel?: string
  searchPlaceholder?: string
  emptyText?: string
  notLoadedText?: string
  emptySelectionText?: string
  maxResults?: number
  testId?: string
}>(), {
  multiple: true,
  loaded: true,
  loading: false,
  error: '',
  openLabel: '选择',
  searchPlaceholder: '输入名称搜索',
  emptyText: '没有可选项',
  notLoadedText: '加载中...',
  emptySelectionText: '未选择',
  maxResults: 50,
  testId: undefined,
})

const emit = defineEmits<{
  (event: 'update:selected', value: string[]): void
  (event: 'open'): void
}>()

const open = ref(false)
const query = ref('')
const radioGroupName = `directory-picker-${(nextPickerInstanceId += 1)}`

// An open panel whose candidates went away (the parent cleared them after a save, or an
// integration switch dropped an in-flight load) asks for them again instead of sitting on
// "loading" with no request running. A failed load is NOT re-requested here (no retry loop);
// reopening the panel retries it.
watch(
  () => [props.loaded, props.loading, props.error] as const,
  ([loaded, loading, error]) => {
    if (open.value && !loaded && !loading && !error) emit('open')
  },
)

const optionByValue = computed(() => new Map(props.options.map((option) => [option.value, option])))
const selectedSet = computed(() => new Set(props.selected))
const matchedOptions = computed(() => {
  const normalizedQuery = query.value.trim().toLocaleLowerCase()
  if (!normalizedQuery) return props.options
  return props.options.filter((option) => (
    [option.label, option.detail, option.value, option.keywords]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase()
      .includes(normalizedQuery)
  ))
})
const visibleOptions = computed(() => matchedOptions.value.slice(0, Math.max(1, props.maxResults)))

function isUnknown(value: string): boolean {
  // Only claim "unknown" once the candidate list really loaded; a failed load shows raw values.
  return props.loaded && !props.loading && !props.error && !optionByValue.value.has(value)
}

function readChipLabel(value: string): string {
  const option = optionByValue.value.get(value)
  if (option) return option.label
  return isUnknown(value) ? props.unknownLabel(value) : value
}

function readChipDetail(value: string): string {
  const option = optionByValue.value.get(value)
  if (!option?.detail || option.detail === option.label) return ''
  return option.detail
}

function readChipTitle(value: string): string {
  const option = optionByValue.value.get(value)
  if (!option) return value
  return option.detail && option.detail !== option.label ? `${option.label} · ${option.detail}` : option.label
}

function togglePanel(): void {
  open.value = !open.value
  if (open.value) emit('open')
}

function removeValue(value: string): void {
  emit('update:selected', props.selected.filter((entry) => entry !== value))
}

function toggleValue(value: string): void {
  if (selectedSet.value.has(value)) {
    removeValue(value)
    return
  }
  emit('update:selected', props.multiple ? [...props.selected, value] : [value])
}
</script>

<style scoped>
.directory-picker {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.directory-picker__chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.directory-picker__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid #bfdbfe;
  border-radius: 999px;
  padding: 4px 6px 4px 12px;
  background: #eff6ff;
  color: #1e3a8a;
  font-size: 13px;
}

.directory-picker__chip--unknown {
  border-color: #fcd34d;
  background: #fffbeb;
  color: #92400e;
}

.directory-picker__chip-detail {
  color: #64748b;
}

.directory-picker__chip-remove {
  border: 0;
  border-radius: 999px;
  width: 20px;
  height: 20px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  line-height: 1;
}

.directory-picker__chip-remove:hover {
  background: rgba(15, 23, 42, 0.08);
}

.directory-picker__placeholder {
  color: #94a3b8;
  font-size: 13px;
}

.directory-picker__toggle {
  border: 1px solid #1d4ed8;
  border-radius: 999px;
  padding: 4px 12px;
  background: #fff;
  color: #1d4ed8;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.directory-picker__panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 10px 12px;
  background: #fff;
}

.directory-picker__search {
  border: 1px solid #cbd5e1;
  border-radius: 10px;
  padding: 8px 10px;
  font: inherit;
}

.directory-picker__options {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 240px;
  overflow-y: auto;
}

.directory-picker__option {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 4px 2px;
  cursor: pointer;
}

.directory-picker__option small {
  color: #64748b;
}

.directory-picker__hint {
  margin: 0;
  color: #64748b;
  font-size: 13px;
}

.directory-picker__hint--empty {
  color: #b45309;
}
</style>
