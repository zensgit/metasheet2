<template>
  <AttendanceView
    mode="admin"
    :initial-section-id="initialSectionId"
    :route-group-context="routeGroupContext"
    @clear-section="emit('clear-section')"
  />
</template>

<script setup lang="ts">
import AttendanceView from '../AttendanceView.vue'
import type { AttendanceGroupRouteStep, AttendanceGroupRouteSurface } from '../../router/attendanceGroupContextRoute'
import type { AttendanceAuthorizedGroup } from './useAttendanceGroupRouteContext'

const emit = defineEmits<{
  (event: 'clear-section'): void
}>()

withDefaults(defineProps<{
  initialSectionId?: string
  routeGroupContext?: {
    group: AttendanceAuthorizedGroup
    step: AttendanceGroupRouteStep
    surface: AttendanceGroupRouteSurface | null
    returnTo: string
  } | null
}>(), {
  initialSectionId: '',
  routeGroupContext: null,
})
</script>
