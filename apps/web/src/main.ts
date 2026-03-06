/**
 * Vue Application Entry Point
 */
import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import App from './App.vue'
import { useFeatureFlags } from './stores/featureFlags'

const HomeRedirect = () => import('./views/HomeRedirect.vue')
const LoginView = () => import('./views/LoginView.vue')
const GridView = () => import('./views/GridView.vue')
const KanbanView = () => import('./views/KanbanView.vue')
const CalendarView = () => import('./views/CalendarView.vue')
const GalleryView = () => import('./views/GalleryView.vue')
const FormView = () => import('./views/FormView.vue')
const PlmProductView = () => import('./views/PlmProductView.vue')
const SpreadsheetsView = () => import('./views/SpreadsheetsView.vue')
const SpreadsheetDetailView = () => import('./views/SpreadsheetDetailView.vue')
const PluginManagerView = () => import('./views/PluginManagerView.vue')
const PluginViewHost = () => import('./views/PluginViewHost.vue')
const AttendanceExperienceView = () => import('./views/attendance/AttendanceExperienceView.vue')

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: LoginView,
    meta: { title: 'Login', hideNavbar: true }
  },
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

function readAuthToken(): string {
  if (typeof localStorage === 'undefined') return ''
  return String(localStorage.getItem('auth_token') || '').trim()
}

function resolveSafeRedirect(raw: unknown): string {
  if (typeof raw !== 'string') return '/'
  if (!raw.startsWith('/')) return '/'
  if (raw.startsWith('//')) return '/'
  return raw
}

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

  const isLoginRoute = to.path === '/login'
  const hasToken = readAuthToken().length > 0

  if (!hasToken && !isLoginRoute) {
    return next({
      path: '/login',
      query: { redirect: to.fullPath },
    })
  }

  if (hasToken && isLoginRoute) {
    const redirect = resolveSafeRedirect(to.query.redirect)
    return next(redirect)
  }

  if (isLoginRoute) return next()

  // Product capability guard + attendance focused mode restriction.
  try {
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
