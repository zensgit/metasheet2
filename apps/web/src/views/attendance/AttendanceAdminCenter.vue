<template>
  <AttendanceView
    mode="admin"
    :initial-section-id="initialSectionId"
    :route-group-context="routeGroupContext"
    :return-group-context="returnGroupContext"
    @clear-section="emit('clear-section')"
    @open-group-route="emit('open-group-route', $event)"
  />
</template>

<script setup lang="ts">
import AttendanceView from '../AttendanceView.vue'
import type { AttendanceGroupRouteStep, AttendanceGroupRouteSurface } from '../../router/attendanceGroupContextRoute'
import type { AttendanceAuthorizedGroup } from './useAttendanceGroupRouteContext'
import type { AttendanceGroupRouteWorkflowStage } from './attendanceGroupRouteHydration'

const emit = defineEmits<{
  (event: 'clear-section'): void
  (event: 'open-group-route', target: {
    groupId: string
    step: AttendanceGroupRouteStep
    surface: AttendanceGroupRouteSurface | null
    originStage?: AttendanceGroupRouteWorkflowStage
  }): void
}>()

withDefaults(defineProps<{
  initialSectionId?: string
  returnGroupContext?: { group: AttendanceAuthorizedGroup; stage: AttendanceGroupRouteWorkflowStage } | null
  routeGroupContext?: {
    group: AttendanceAuthorizedGroup
    step: AttendanceGroupRouteStep
    surface: AttendanceGroupRouteSurface | null
    returnTo: string
  } | null
}>(), {
  initialSectionId: '',
  returnGroupContext: null,
  routeGroupContext: null,
})
</script>
