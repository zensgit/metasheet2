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
import SpreadsheetsView from './views/SpreadsheetsView.vue'
import SpreadsheetDetailView from './views/SpreadsheetDetailView.vue'
import PluginManagerView from './views/PluginManagerView.vue'
import PluginViewHost from './views/PluginViewHost.vue'
import AttendanceExperienceView from './views/attendance/AttendanceExperienceView.vue'
import HomeRedirect from './views/HomeRedirect.vue'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: HomeRedirect,
    meta: { title: 'Home', hideNavbar: true }
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
    component: AttendanceExperienceView,
    meta: { title: 'Attendance', requiredFeature: 'attendance' }
  },
  {
    path: '/p/:plugin/:viewId',
    name: 'plugin-view',
    component: PluginViewHost,
    meta: { title: 'Plugin' }
  },
  {
    path: '/spreadsheets',
    name: 'spreadsheet-list',
    component: SpreadsheetsView,
    meta: { title: 'Spreadsheets' }
  },
  {
    path: '/spreadsheets/:id',
    name: 'spreadsheet-detail',
    component: SpreadsheetDetailView,
    meta: { title: 'Spreadsheet' }
  },
  {
    path: '/plm',
    name: 'plm',
    component: PlmProductView,
    meta: { title: 'PLM' }
  },
  {
    path: '/admin/plugins',
    name: 'plugin-manager',
    component: PluginManagerView,
    meta: { title: 'Plugins', requiredFeature: 'attendanceAdmin' }
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
router.beforeEach(async (to, from, next) => {
  const title = to.meta?.title
  if (title) {
    document.title = `${title} - MetaSheet`
  } else {
    document.title = 'MetaSheet'
  }

  // Product capability guard + attendance focused mode restriction.
  try {
    const mod = await import('./stores/featureFlags')
    const { useFeatureFlags } = mod
    const flags = useFeatureFlags()
    await flags.loadProductFeatures()

    const required = to.meta?.requiredFeature
    const requiredFeature =
      required === 'attendance' ||
      required === 'workflow' ||
      required === 'attendanceAdmin' ||
      required === 'attendanceImport'
        ? required
        : null

    if (requiredFeature && !flags.hasFeature(requiredFeature)) {
      return next(flags.resolveHomePath())
    }

    if (flags.isAttendanceFocused()) {
      const allowed = new Set<string>([
        '/attendance',
        '/p/plugin-attendance/attendance',
      ])
      const path = String(to.path || '')
      if (!allowed.has(path)) {
        return next('/attendance')
      }
    }
  } catch {
    // If guard fails (network/offline), don't block navigation.
  }
  next()
})

// Create and mount app
const app = createApp(App)

app.use(router)

app.mount('#app')
