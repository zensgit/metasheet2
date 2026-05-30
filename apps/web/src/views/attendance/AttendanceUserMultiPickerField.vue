<template>
  <label class="attendance__field attendance__field--full" :for="inputId">
    <span>{{ label }}</span>
    <div class="attendance__user-picker" :data-attendance-user-multi-picker="pickerName">
      <div class="attendance__user-picker-controls">
        <input
          :id="inputId"
          v-model.trim="searchQuery"
          :disabled="disabled"
          :placeholder="searchPlaceholderText"
          :name="name"
          type="search"
          @keyup.enter.prevent="void loadUsers()"
        />
        <button
          class="attendance__btn"
          type="button"
          :disabled="disabled || loading"
          :data-attendance-user-multi-picker-search="pickerName"
          @click="void loadUsers()"
        >
          {{ loading ? tr('Loading...', '加载中...') : tr('Search users', '搜索用户') }}
        </button>
      </div>
      <div class="attendance__user-picker-controls">
        <select
          v-model="draftId"
          :disabled="disabled || loading"
          :data-attendance-user-multi-picker-select="pickerName"
        >
          <option value="">{{ tr('Select a user to add', '选择要添加的用户') }}</option>
          <option v-for="user in addableUsers" :key="user.id" :value="user.id">{{ formatUserLabel(user) }}</option>
        </select>
        <button
          class="attendance__btn"
          type="button"
          :disabled="disabled || !draftId"
          :data-attendance-user-multi-picker-add="pickerName"
          @click="addDraft"
        >
          {{ tr('Add', '添加') }}
        </button>
      </div>
      <ul
        v-if="modelValue.length"
        class="attendance__chip-list"
        :data-attendance-user-multi-picker-chips="pickerName"
      >
        <li v-for="id in modelValue" :key="id" class="attendance__chip" :data-chip-id="id">
          <span>{{ chipLabel(id) }}</span>
          <button
            type="button"
            class="attendance__chip-remove"
            :aria-label="tr('Remove', '移除')"
            :data-attendance-user-multi-picker-remove="id"
            @click="removeId(id)"
          >×</button>
        </li>
      </ul>
      <small v-if="statusMessage" class="attendance__field-hint attendance__field-hint--error">{{ statusMessage }}</small>
    </div>
    <small v-if="helpText" class="attendance__field-hint">{{ helpText }}</small>
  </label>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useAttendanceAdminUsers } from './useAttendanceAdminUsers'

type Translate = (en: string, zh: string) => string

const props = withDefaults(defineProps<{
  modelValue: string[]
  label: string
  tr: Translate
  name?: string
  helpText?: string
  searchPlaceholder?: string
  disabled?: boolean
  inputId?: string
}>(), {
  disabled: false,
  inputId: undefined,
  name: '',
  searchPlaceholder: '',
  helpText: '',
})

const emit = defineEmits<{
  'update:modelValue': [value: string[]]
}>()

const { formatUserLabel, loading, loadUsers, searchQuery, statusMessage, users } = useAttendanceAdminUsers({ tr: props.tr })

const draftId = ref('')
// Display label captured when an id is added, so a chip keeps reading as a name even after a
// later search swaps out the results list. The wire value is always the bare id array.
const labelById = reactive<Record<string, string>>({})

const pickerName = computed(() => props.name || 'users')
const addableUsers = computed(() => users.value.filter((user) => !props.modelValue.includes(user.id)))
const inputId = computed(() => props.inputId || `${props.name || 'attendance-user-multi-picker'}-${props.label.replace(/\s+/g, '-').toLowerCase()}`)
const searchPlaceholderText = computed(() => props.searchPlaceholder || props.tr('Search by email, name, or user ID', '按邮箱、姓名或用户 ID 搜索'))

function chipLabel(id: string): string {
  // Prefer the label captured at add-time; otherwise resolve from the loaded directory (covers
  // ids hydrated externally, e.g. an edit prefill); fall back to the bare id.
  if (labelById[id]) return labelById[id]
  const known = users.value.find((user) => user.id === id)
  return known ? formatUserLabel(known) : id
}

function addDraft(): void {
  const id = draftId.value.trim()
  draftId.value = ''
  if (!id || props.modelValue.includes(id)) return
  const picked = users.value.find((user) => user.id === id)
  if (picked) labelById[id] = formatUserLabel(picked)
  emit('update:modelValue', [...props.modelValue, id])
}

function removeId(id: string): void {
  emit('update:modelValue', props.modelValue.filter((value) => value !== id))
}

onMounted(() => {
  void loadUsers()
})
</script>

<style scoped>
.attendance__user-picker {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.attendance__user-picker-controls {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.attendance__user-picker-controls input,
.attendance__user-picker-controls select {
  flex: 1 1 220px;
  min-width: 180px;
}

.attendance__chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  list-style: none;
  padding: 0;
  margin: 0;
}

.attendance__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  border-radius: 12px;
  background: #eef2ff;
  font-size: 13px;
}

.attendance__chip-remove {
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  color: #666;
  padding: 0;
}

.attendance__chip-remove:hover {
  color: #c62828;
}

.attendance__field-hint {
  color: #666;
  font-size: 12px;
}

.attendance__field-hint--error {
  color: #c62828;
}
</style>
