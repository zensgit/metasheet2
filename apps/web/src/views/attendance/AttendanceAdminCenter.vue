<template>
  <AttendanceView
    mode="admin"
    :initial-section-id="initialSectionId"
    :route-group-context="routeGroupContext"
    :group-stage-request="groupStageRequest"
    :return-group-context="returnGroupContext"
    @clear-section="emit('clear-section')"
    @open-group-route="emit('open-group-route', $event)"
  />
</template>

<script setup lang="ts">
import AttendanceView from '../AttendanceView.vue'
import type { AttendanceGroupRouteStep, AttendanceGroupRouteSurface } from '../../router/attendanceGroupContextRoute'
import type { AttendanceAuthorizedGroup } from './useAttendanceGroupRouteContext'
import type { AttendanceGroupEffectivePolicyStageActionV1 } from './attendanceGroupEffectivePolicyLabels'
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
  groupStageRequest?: AttendanceGroupEffectivePolicyStageActionV1 | null
  returnGroupContext?: { group: AttendanceAuthorizedGroup; stage: AttendanceGroupRouteWorkflowStage } | null
  routeGroupContext?: {
    group: AttendanceAuthorizedGroup
    step: AttendanceGroupRouteStep
    surface: AttendanceGroupRouteSurface | null
    returnTo: string
  } | null
}>(), {
  initialSectionId: '',
  groupStageRequest: null,
  returnGroupContext: null,
  routeGroupContext: null,
})
</script>
