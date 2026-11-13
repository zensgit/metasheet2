<template>
  <AttendanceView
    mode="admin"
    :initial-section-id="initialSectionId"
    :route-group-context="routeGroupContext"
    :group-stage-request="groupStageRequest"
    @clear-section="emit('clear-section')"
    @open-group-route="emit('open-group-route', $event)"
  />
</template>

<script setup lang="ts">
import AttendanceView from '../AttendanceView.vue'
import type { AttendanceGroupRouteStep, AttendanceGroupRouteSurface } from '../../router/attendanceGroupContextRoute'
import type { AttendanceAuthorizedGroup } from './useAttendanceGroupRouteContext'
import type { AttendanceGroupEffectivePolicyStageActionV1 } from './attendanceGroupEffectivePolicyLabels'

const emit = defineEmits<{
  (event: 'clear-section'): void
  (event: 'open-group-route', target: {
    groupId: string
    step: AttendanceGroupRouteStep
    surface: AttendanceGroupRouteSurface | null
  }): void
}>()

withDefaults(defineProps<{
  initialSectionId?: string
  groupStageRequest?: AttendanceGroupEffectivePolicyStageActionV1 | null
  routeGroupContext?: {
    group: AttendanceAuthorizedGroup
    step: AttendanceGroupRouteStep
    surface: AttendanceGroupRouteSurface | null
    returnTo: string
  } | null
}>(), {
  initialSectionId: '',
  groupStageRequest: null,
  routeGroupContext: null,
})
</script>
