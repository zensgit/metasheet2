import type { Component } from 'vue'
import AttendanceExperienceView from '../views/attendance/AttendanceExperienceView.vue'

export const viewRegistry: Record<string, Component> = {
  AttendanceView: AttendanceExperienceView,
}
