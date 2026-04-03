<template>
  <AttendanceView mode="reports" :initial-section-id="initialSectionId" />
</template>

<script setup lang="ts">
import AttendanceView from '../AttendanceView.vue'

withDefaults(defineProps<{
  initialSectionId?: string
}>(), {
  initialSectionId: '',
})
</script>
