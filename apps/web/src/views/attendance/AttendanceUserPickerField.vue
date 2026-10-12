<template>
  <label class="attendance__field" :class="{ 'attendance__field--full': fullWidth }" :for="inputId">
    <span>{{ label }}</span>
    <div class="attendance__user-picker" :class="{ 'attendance__user-picker--typeahead': typeahead }">
      <div class="attendance__user-picker-controls">
        <input
          :id="inputId"
          v-model.trim="searchQuery"
          :disabled="disabled"
          :placeholder="searchPlaceholderText"
          :name="name"
          type="search"
          autocomplete="off"
          @keyup.enter="void loadUsers()"
        />
        <button class="attendance__btn" type="button" :disabled="disabled || loading" @click="void loadUsers()">
          {{ loading ? tr('Loading...', '加载中...') : tr('Search users', '搜索用户') }}
        </button>
      </div>
      <ul v-if="typeahead && menuUsers.length > 0" class="attendance__user-picker-menu">
        <li v-for="user in menuUsers" :key="user.id">
          <button type="button" :disabled="disabled" @click="selectUser(user.id)">
            {{ formatUserLabel(user) }}
          </button>
        </li>
      </ul>
      <small v-if="typeahead && modelValue" class="attendance__field-hint">
        {{ tr('Selected', '已选') }}: {{ primaryLabel(modelValue) || modelValue }}
      </small>
      <select :value="modelValue" :disabled="disabled || loading" @change="handleChange">
        <option value="">{{ tr('Select user', '选择用户') }}</option>
        <option v-for="user in displayUsers" :key="user.id" :value="user.id">
          {{ formatUserLabel(user) }}
        </option>
      </select>
    </div>
    <small v-if="helpText" class="attendance__field-hint">{{ helpText }}</small>
    <small v-if="statusMessage" class="attendance__field-hint attendance__field-hint--error">{{ statusMessage }}</small>
  </label>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useAttendanceAdminUsers } from './useAttendanceAdminUsers'
import { useAttendanceSessionGuard } from '../../composables/useAttendanceSessionGuard'
import { apiFetch } from '../../utils/api'

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

function primaryLabel(userId: string): string {
  const selectedId = userId.trim()
  if (!selectedId) return ''
  const user = users.value.find((item) => item.id === selectedId)
  if (!user) return ''
  const name = user.name?.trim() || ''
  if (name) return name
  const email = typeof user.email === 'string' ? user.email.trim() : ''
  if (email && email !== selectedId) return email
  return ''
}

function selectUser(userId: string) {
  emit('update:modelValue', userId)
  emit('update:displayName', primaryLabel(userId))
  if (props.typeahead) searchQuery.value = ''
}

function handleChange(event: Event) {
  selectUser((event.target as HTMLSelectElement).value)
}

watch(users, () => {
  emit('update:displayName', primaryLabel(props.modelValue))
})

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

.attendance__field-hint {
  color: #666;
  font-size: 12px;
}

.attendance__field-hint--error {
  color: #c62828;
}
</style>
