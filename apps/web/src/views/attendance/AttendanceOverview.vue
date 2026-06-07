<template>
  <AttendanceView
    mode="overview"
    :initial-section-id="initialSectionId"
    :initial-request-id="initialRequestId"
  />
</template>

<script setup lang="ts">
import AttendanceView from '../AttendanceView.vue'

withDefaults(defineProps<{
  initialSectionId?: string
  initialRequestId?: string
}>(), {
  initialSectionId: '',
  initialRequestId: '',
})
</script>
