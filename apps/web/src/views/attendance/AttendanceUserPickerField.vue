<template>
  <label class="attendance__field" :class="{ 'attendance__field--full': fullWidth }" :for="inputId">
    <span>{{ label }}</span>
    <div class="attendance__user-picker">
      <div class="attendance__user-picker-controls">
        <input
          :id="inputId"
          v-model.trim="searchQuery"
          :disabled="disabled"
          :placeholder="searchPlaceholderText"
          :name="name"
          type="search"
          @keyup.enter="void loadUsers()"
        />
        <button class="attendance__btn" type="button" :disabled="disabled || loading" @click="void loadUsers()">
          {{ loading ? tr('Loading...', '加载中...') : tr('Search users', '搜索用户') }}
        </button>
      </div>
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
import { computed, onMounted } from 'vue'
import { useAttendanceAdminUsers } from './useAttendanceAdminUsers'

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
  inputId?: string
}>(), {
  disabled: false,
  fullWidth: false,
  inputId: undefined,
  name: '',
  searchPlaceholder: '',
  helpText: '',
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const {
  formatUserLabel,
  loading,
  loadUsers,
  searchQuery,
  statusMessage,
  users,
} = useAttendanceAdminUsers({ tr: props.tr })

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

const inputId = computed(() => props.inputId || `${props.name || 'attendance-user-picker'}-${props.label.replace(/\s+/g, '-').toLowerCase()}`)
const searchPlaceholderText = computed(() => props.searchPlaceholder || props.tr('Search by email, name, or user ID', '按邮箱、姓名或用户 ID 搜索'))

function handleChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  emit('update:modelValue', value)
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

.attendance__user-picker-controls input {
  flex: 1 1 220px;
  min-width: 180px;
}

.attendance__user-picker select {
  width: 100%;
}

.attendance__field-hint {
  color: #666;
  font-size: 12px;
}

.attendance__field-hint--error {
  color: #c62828;
}
</style>
