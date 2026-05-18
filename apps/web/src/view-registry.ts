type ViewLoader = () => Promise<unknown>

const viewLoaders: Record<string, ViewLoader> = {
  KanbanView: () => import('./views/KanbanView.vue'),
  CalendarView: () => import('./views/CalendarView.vue'),
  GalleryView: () => import('./views/GalleryView.vue'),
  FormView: () => import('./views/FormView.vue'),
  AttendanceView: () => import('./views/AttendanceView.vue'),
  AfterSalesView: () => import('./views/AfterSalesView.vue'),
  PlmProductView: () => import('./views/PlmProductView.vue'),
}

export function getViewLoader(name: string): ViewLoader | undefined {
  return viewLoaders[name]
}
