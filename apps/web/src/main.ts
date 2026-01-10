/**
 * Vue Application Entry Point
 */
import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import App from './App.vue'
import { AppRouteNames, ROUTE_PATHS, RouteGuards } from './router/types'

// Import views
import GridView from './views/GridView.vue'
import KanbanView from './views/KanbanView.vue'
import CalendarView from './views/CalendarView.vue'
import GalleryView from './views/GalleryView.vue'
import FormView from './views/FormView.vue'
import PlmProductView from './views/PlmProductView.vue'
import AttendanceView from './views/AttendanceView.vue'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    redirect: '/grid'
  },
  {
    path: '/grid',
    name: 'grid',
    component: GridView,
    meta: { title: 'Grid View' }
  },
  {
    path: '/kanban',
    name: 'kanban',
    component: KanbanView,
    meta: { title: 'Kanban View' }
  },
  {
    path: '/calendar',
    name: 'calendar',
    component: CalendarView,
    meta: { title: 'Calendar View' }
  },
  {
    path: '/gallery',
    name: 'gallery',
    component: GalleryView,
    meta: { title: 'Gallery View' }
  },
  {
    path: '/form',
    name: 'form',
    component: FormView,
    meta: { title: 'Form View' }
  },
  {
    path: '/attendance',
    name: 'attendance',
    component: AttendanceView,
    meta: { title: 'Attendance' }
  },
  {
    path: '/plm',
    name: 'plm',
    component: PlmProductView,
    meta: { title: 'PLM View' }
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    redirect: '/'
  }
]

// Create router
const router = createRouter({
  history: createWebHistory(),
  routes
})

// Navigation guard for page title
router.beforeEach((to, from, next) => {
  const title = to.meta?.title
  if (title) {
    document.title = `${title} - MetaSheet`
  } else {
    document.title = 'MetaSheet'
  }
  next()
})

// Create and mount app
const app = createApp(App)

app.use(router)

app.mount('#app')
