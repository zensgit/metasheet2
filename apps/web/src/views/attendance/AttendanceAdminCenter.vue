<template>
  <AttendanceView
    mode="admin"
    :initial-section-id="initialSectionId"
    @clear-section="emit('clear-section')"
  />
</template>

<script setup lang="ts">
import AttendanceView from '../AttendanceView.vue'

const emit = defineEmits<{
  (event: 'clear-section'): void
}>()

withDefaults(defineProps<{
  initialSectionId?: string
}>(), {
  initialSectionId: '',
})
</script>
