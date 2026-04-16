<script setup lang="ts">
import { computed } from 'vue'
import type { YjsPresenceUser } from '../types'

const props = withDefaults(defineProps<{
  users: YjsPresenceUser[]
  currentUserId?: string | null
  fieldId?: string | null
  label?: string
}>(), {
  currentUserId: null,
  fieldId: null,
  label: 'Collaborating now',
})

const filteredUsers = computed(() => {
  const normalizedFieldId = props.fieldId?.trim() || null
  return props.users.filter((user) => {
    if (user.id === props.currentUserId) return false
    if (!normalizedFieldId) return true
    return user.fieldIds.includes(normalizedFieldId)
  })
})

const summary = computed(() => {
  const users = filteredUsers.value
  if (users.length === 0) return ''
  if (users.length === 1) return users[0]?.id ?? ''
  if (users.length === 2) return `${users[0]?.id}, ${users[1]?.id}`
  return `${users[0]?.id}, ${users[1]?.id} +${users.length - 2}`
})
</script>

<template>
  <div
    v-if="filteredUsers.length > 0"
    class="mt-yjs-presence-chip"
    :title="`${label}: ${filteredUsers.map((user) => user.id).join(', ')}`"
  >
    <span class="mt-yjs-presence-chip__dot" aria-hidden="true" />
    <span class="mt-yjs-presence-chip__label">{{ label }}</span>
    <span class="mt-yjs-presence-chip__users">{{ summary }}</span>
  </div>
</template>

<style scoped>
.mt-yjs-presence-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(14, 116, 144, 0.12);
  color: #155e75;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.2;
}

.mt-yjs-presence-chip__dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: currentColor;
  opacity: 0.8;
}

.mt-yjs-presence-chip__label {
  white-space: nowrap;
}

.mt-yjs-presence-chip__users {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
