import type { Component } from 'vue'
import { defineAsyncComponent } from 'vue'
import KanbanView from '../views/KanbanView.vue'
import CalendarView from '../views/CalendarView.vue'
import GalleryView from '../views/GalleryView.vue'
import FormView from '../views/FormView.vue'
// Lazy: a static import here would pull bpmn-js into the entry chunk.
const WorkflowDesignerView = defineAsyncComponent(() => import('../views/WorkflowDesigner.vue'))

// Async on purpose: this registry is imported by statically-routed hosts, so a
// static import here would pull the attendance monolith back into the entry
// chunk and defeat the route-level code split in router/appRoutes.ts.
const AttendanceExperienceView = defineAsyncComponent(() => import('../views/attendance/AttendanceExperienceView.vue'))

export const viewRegistry: Record<string, Component> = {
  AttendanceView: AttendanceExperienceView,
  KanbanView,
  CalendarView,
  GalleryView,
  FormView,
  WorkflowDesignerView,
}

const viewIdRegistry: Record<string, Component> = {
  attendance: AttendanceExperienceView,
  kanban: KanbanView,
  calendar: CalendarView,
  gallery: GalleryView,
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
