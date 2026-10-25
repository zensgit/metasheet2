<template>
  <label class="attendance__field" :class="{ 'attendance__field--full': fullWidth }" :for="inputId">
    <span>{{ label }}</span>
    <div class="attendance__user-picker" :class="{ 'attendance__user-picker--typeahead': typeahead }">
      <div class="attendance__user-picker-controls">
        <input
          v-if="typeahead"
          :id="inputId"
          :value="typeaheadInputValue"
          :disabled="disabled"
          :placeholder="searchPlaceholderText"
          :name="name"
          type="search"
          autocomplete="off"
          @input="onTypeaheadInput"
          @focus="onTypeaheadFocus"
          @blur="onTypeaheadBlur"
          @keyup.enter="onSearchEnter()"
        />
        <input
          v-else
          :id="inputId"
          v-model.trim="searchQuery"
          :disabled="disabled"
          :placeholder="searchPlaceholderText"
          :name="name"
          type="search"
          autocomplete="off"
          @keyup.enter="onSearchEnter()"
        />
        <button class="attendance__btn" type="button" :disabled="disabled || loading" @click="searchNow()">
          {{ loading ? tr('Loading...', '加载中...') : tr('Search users', '搜索用户') }}
        </button>
      </div>
      <ul
        v-if="typeahead && (menuUsers.length > 0 || showTypeaheadEmpty)"
        class="attendance__user-picker-menu"
        data-attendance-user-picker-menu
      >
        <li v-for="user in menuUsers" :key="user.id">
          <button type="button" :disabled="disabled" @mousedown.prevent @click="selectUser(user.id)">
            <span>{{ pickerLabel(user) }}</span>
            <span v-if="!personLabel(user) && !isRetainedPersonnelValue(user)" class="attendance__user-picker-id">ID: {{ user.id }}</span>
          </button>
        </li>
        <li v-if="showTypeaheadEmpty" class="attendance__user-picker-empty" data-attendance-search-empty>
          {{ tr('No matches', '搜索不到') }}
        </li>
      </ul>
      <small v-if="typeahead && modelValue && !selectedVisibleLabel && !typeaheadEditing" class="attendance__field-hint">
        {{ tr('Employee selected', '已选择员工') }}
      </small>
      <select :value="modelValue" :disabled="disabled || loading" @change="handleChange">
        <option value="">{{ tr('Select user', '选择用户') }}</option>
        <option v-for="user in displayUsers" :key="user.id" :value="user.id">
          {{ typeahead ? pickerLabel(user) : formatUserLabel(user) }}
        </option>
      </select>
    </div>
    <small v-if="helpText" class="attendance__field-hint">{{ helpText }}</small>
    <small v-if="statusMessage" class="attendance__field-hint attendance__field-hint--error">{{ statusMessage }}</small>
  </label>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAttendanceAdminUsers, type AttendanceAdminUserSearchItem } from './useAttendanceAdminUsers'
import { useAttendanceSessionGuard } from '../../composables/useAttendanceSessionGuard'
import { apiFetch } from '../../utils/api'
import { attendancePersonnelName, isRetainedPersonnelValue } from './attendancePersonnelIdentity'

type Translate = (en: string, zh: string) => string

const props = withDefaults(defineProps<{
  modelValue: string
  label: string
  tr: Translate
  name?: string
  helpText?: string
  searchPlaceholder?: string
  disabled?: boolean
  fullWidth?: boolean
  typeahead?: boolean
  inputId?: string
  endpoint?: string
  orgId?: string
  globalScope?: boolean
}>(), {
  disabled: false,
  fullWidth: false,
  typeahead: false,
  inputId: undefined,
  name: '',
  searchPlaceholder: '',
  helpText: '',
  endpoint: undefined,
  orgId: undefined,
  globalScope: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'update:displayName': [value: string]
}>()

const sessionGuard = useAttendanceSessionGuard()
const {
  formatUserLabel,
  loading,
  loadUsers,
  searchQuery,
  statusMessage,
  users,
} = useAttendanceAdminUsers({
  apiFetch: sessionGuard.wrapFetch(apiFetch),
  isSessionCurrent: sessionGuard.isCurrent,
  tr: props.tr,
  endpoint: props.endpoint,
  orgId: computed(() => props.orgId),
  globalScope: computed(() => props.globalScope),
})

const displayUsers = computed(() => {
  const selectedId = props.modelValue.trim()
  if (!selectedId || users.value.some((user) => user.id === selectedId)) return users.value
  return [
    {
      id: selectedId,
      email: selectedId,
      name: null,
      role: '',
      is_active: true,
      is_admin: false,
      last_login_at: null,
      created_at: '',
    },
    ...users.value,
  ]
})

const menuUsers = computed(() => {
  if (!props.typeahead) return []
  const query = searchQuery.value.trim().toLowerCase()
  if (!query) return []
  return displayUsers.value.filter((user) => {
    const label = formatUserLabel(user).toLowerCase()
    return label.includes(query) || user.id.toLowerCase().includes(query)
  }).slice(0, 8)
})

const inputId = computed(() => props.inputId || `${props.name || 'attendance-user-picker'}-${props.label.replace(/\s+/g, '-').toLowerCase()}`)
const searchPlaceholderText = computed(() => props.searchPlaceholder || props.tr('Search by email, name, or user ID', '按邮箱、姓名或用户 ID 搜索'))
const typeaheadEditing = ref(false)
const typeaheadSearchSettled = ref(false)
let typeaheadBlurTimer: ReturnType<typeof setTimeout> | undefined
let typeaheadSeq = 0

const showTypeaheadEmpty = computed(() => (
  props.typeahead
  && searchQuery.value.trim().length > 0
  && menuUsers.value.length === 0
  && typeaheadSearchSettled.value
))

const selectedVisibleLabel = computed(() => {
  const selected = displayUsers.value.find((item) => item.id === props.modelValue.trim())
  return selected ? personLabel(selected) || formatUserLabel(selected) : ''
})
const typeaheadInputValue = computed(() => (typeaheadEditing.value ? searchQuery.value : selectedVisibleLabel.value))

function personLabel(user: AttendanceAdminUserSearchItem | null | undefined): string {
  return attendancePersonnelName(user)
}

function pickerLabel(user: AttendanceAdminUserSearchItem): string {
  if (isRetainedPersonnelValue(user)) return formatUserLabel(user)
  return personLabel(user) || props.tr('Unnamed employee', '未命名员工')
}

let typeaheadTimer: ReturnType<typeof setTimeout> | undefined

function markTypeaheadSettled(seq: number, query: string): void {
  if (seq === typeaheadSeq && searchQuery.value.trim() === query) {
    typeaheadSearchSettled.value = true
  }
}

function scheduleTypeahead(): void {
  if (!props.typeahead) return
  if (typeaheadTimer) clearTimeout(typeaheadTimer)
  const query = searchQuery.value.trim()
  if (!query) {
    typeaheadSeq += 1
    typeaheadTimer = undefined
    typeaheadSearchSettled.value = false
    return
  }
  typeaheadSearchSettled.value = false
  const seq = ++typeaheadSeq
  typeaheadTimer = setTimeout(() => {
    typeaheadTimer = undefined
    void loadUsers().finally(() => markTypeaheadSettled(seq, query))
  }, 250)
}

function searchNow(): void {
  if (typeaheadTimer) clearTimeout(typeaheadTimer)
  typeaheadTimer = undefined
  const query = searchQuery.value.trim()
  if (!props.typeahead || !query) {
    void loadUsers()
    return
  }
  typeaheadSearchSettled.value = false
  const seq = ++typeaheadSeq
  void loadUsers().finally(() => markTypeaheadSettled(seq, query))
}

function onSearchEnter(): void {
  if (props.typeahead && menuUsers.value.length === 1) {
    selectUser(menuUsers.value[0]!.id)
    return
  }
  searchNow()
}

function primaryLabel(userId: string): string {
  const selectedId = userId.trim()
  if (!selectedId) return ''
  return personLabel(users.value.find((item) => item.id === selectedId))
}

function onTypeaheadInput(event: Event): void {
  searchQuery.value = (event.target as HTMLInputElement).value
  typeaheadEditing.value = true
  scheduleTypeahead()
}

function onTypeaheadFocus(): void {
  if (typeaheadBlurTimer) clearTimeout(typeaheadBlurTimer)
  typeaheadEditing.value = true
}

function onTypeaheadBlur(): void {
  if (typeaheadBlurTimer) clearTimeout(typeaheadBlurTimer)
  typeaheadBlurTimer = setTimeout(() => {
    typeaheadBlurTimer = undefined
    typeaheadEditing.value = false
    searchQuery.value = ''
  }, 0)
}

function selectUser(userId: string) {
  if (typeaheadBlurTimer) clearTimeout(typeaheadBlurTimer)
  emit('update:modelValue', userId)
  emit('update:displayName', primaryLabel(userId))
  if (props.typeahead) {
    searchQuery.value = ''
    typeaheadEditing.value = false
  }
}

function handleChange(event: Event) {
  selectUser((event.target as HTMLSelectElement).value)
}

watch(() => props.modelValue, (id) => {
  emit('update:displayName', primaryLabel(id))
})

watch(users, () => {
  emit('update:displayName', primaryLabel(props.modelValue))
})

onMounted(() => {
  void loadUsers()
})

onBeforeUnmount(() => {
  if (typeaheadTimer) clearTimeout(typeaheadTimer)
  if (typeaheadBlurTimer) clearTimeout(typeaheadBlurTimer)
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

.attendance__user-picker-controls input {
  flex: 1 1 220px;
  min-width: 180px;
}

.attendance__user-picker select {
  width: 100%;
}

.attendance__user-picker--typeahead {
  position: relative;
}

.attendance__user-picker--typeahead .attendance__user-picker-controls button,
.attendance__user-picker--typeahead select {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.attendance__user-picker-menu {
  list-style: none;
  margin: 4px 0 0;
  padding: 4px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #fff;
  display: grid;
  gap: 2px;
}

.attendance__user-picker-menu button {
  width: 100%;
  padding: 4px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #1f2937;
  text-align: left;
  cursor: pointer;
}

.attendance__user-picker-id {
  margin-left: 6px;
  color: #98a2b3;
  font-size: 11px;
}

.attendance__user-picker-empty {
  padding: 4px 8px;
  color: #667085;
  font-size: 12px;
}

.attendance__field-hint {
  color: #666;
  font-size: 12px;
}

.attendance__field-hint--error {
  color: #c62828;
}
</style>
