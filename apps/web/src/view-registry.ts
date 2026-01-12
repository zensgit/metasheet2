type ViewLoader = () => Promise<unknown>

const viewLoaders: Record<string, ViewLoader> = {
  GridView: () => import('./views/GridView.vue'),
  KanbanView: () => import('./views/KanbanView.vue'),
  CalendarView: () => import('./views/CalendarView.vue'),
  GalleryView: () => import('./views/GalleryView.vue'),
  FormView: () => import('./views/FormView.vue'),
  AttendanceView: () => import('./views/AttendanceView.vue'),
  PlmProductView: () => import('./views/PlmProductView.vue'),
}

export function getViewLoader(name: string): ViewLoader | undefined {
  return viewLoaders[name]
}
