import type { Component } from 'vue'
import AttendanceExperienceView from '../views/attendance/AttendanceExperienceView.vue'
import KanbanView from '../views/KanbanView.vue'
import CalendarView from '../views/CalendarView.vue'
import GalleryView from '../views/GalleryView.vue'
import GridView from '../views/GridView.vue'
import FormView from '../views/FormView.vue'
import WorkflowDesignerView from '../views/WorkflowDesigner.vue'

export const viewRegistry: Record<string, Component> = {
  AttendanceView: AttendanceExperienceView,
  KanbanView,
  CalendarView,
  GalleryView,
  GridView,
  FormView,
  WorkflowDesignerView,
}

const viewIdRegistry: Record<string, Component> = {
  attendance: AttendanceExperienceView,
  kanban: KanbanView,
  calendar: CalendarView,
  gallery: GalleryView,
  grid: GridView,
  form: FormView,
  workflow: WorkflowDesignerView,
}

export function resolvePluginViewComponent(componentName?: string, viewId?: string): Component | null {
  if (componentName && viewRegistry[componentName]) {
    return viewRegistry[componentName]
  }

  if (viewId && viewIdRegistry[viewId]) {
    return viewIdRegistry[viewId]
  }

  return null
}
