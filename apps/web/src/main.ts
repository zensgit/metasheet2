/**
 * Vue Application Entry Point
 */
import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import App from './App.vue'
import { useAuth } from './composables/useAuth'
import { ROUTE_PATHS } from './router/types'
import { useFeatureFlags } from './stores/featureFlags'
import { normalizePostLoginRedirect, normalizePreLoginRedirect } from './utils/authRedirect'

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
import LoginView from './views/LoginView.vue'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: HomeRedirect,
    meta: { title: 'Home', hideNavbar: true, requiresAuth: true }
  },
  {
    path: ROUTE_PATHS.LOGIN,
    name: 'login',
    component: LoginView,
    meta: { title: 'Sign In', hideNavbar: true, requiresGuest: true }
  },
  {
    path: '/grid',
    name: 'grid',
    component: GridView,
    meta: { title: 'Grid View', requiresAuth: true }
  },
  {
    path: '/kanban',
    name: 'kanban',
    component: KanbanView,
    meta: { title: 'Kanban View', requiresAuth: true }
  },
  {
    path: '/calendar',
    name: 'calendar',
    component: CalendarView,
    meta: { title: 'Calendar View', requiresAuth: true }
  },
  {
    path: '/gallery',
    name: 'gallery',
    component: GalleryView,
    meta: { title: 'Gallery View', requiresAuth: true }
  },
  {
    path: '/form',
    name: 'form',
    component: FormView,
    meta: { title: 'Form View', requiresAuth: true }
  },
  {
    path: '/attendance',
    name: 'attendance',
    component: AttendanceExperienceView,
    meta: { title: 'Attendance', requiresAuth: true, requiredFeature: 'attendance' }
  },
  {
    path: '/p/:plugin/:viewId',
    name: 'plugin-view',
    component: PluginViewHost,
    meta: { title: 'Plugin', requiresAuth: true }
  },
  {
    path: '/spreadsheets',
    name: 'spreadsheet-list',
    component: SpreadsheetsView,
    meta: { title: 'Spreadsheets', requiresAuth: true }
  },
  {
    path: '/spreadsheets/:id',
    name: 'spreadsheet-detail',
    component: SpreadsheetDetailView,
    meta: { title: 'Spreadsheet', requiresAuth: true }
  },
  {
    path: '/plm',
    name: 'plm',
    component: PlmProductView,
    meta: { title: 'PLM', requiresAuth: true }
  },
  {
    path: '/workflows',
    name: 'workflow-list',
    component: () => import('./views/WorkflowHubView.vue'),
    meta: { title: 'Workflows', requiresAuth: true, requiredFeature: 'workflow' }
  },
  {
    path: '/admin/plugins',
    name: 'plugin-manager',
    component: PluginManagerView,
    meta: { title: 'Plugins', requiresAuth: true, requiredFeature: 'attendanceAdmin' }
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
router.beforeEach(async (to, _from, next) => {
  const auth = useAuth()
  const token = auth.getToken()
  const isLoginRoute = to.path === ROUTE_PATHS.LOGIN
  const requiresAuth = to.meta?.requiresAuth !== false
  const flags = useFeatureFlags()
  const title = to.meta?.title

  if (title) {
    document.title = `${title} - MetaSheet`
  } else {
    document.title = 'MetaSheet'
  }

  if (isLoginRoute) {
    if (token) {
      const session = await auth.bootstrapSession()
      if (session.ok) {
        try {
          await flags.loadProductFeatures()
        } catch {
          // Fall back to shell redirect when feature probing is temporarily unavailable.
        }
        const redirect = normalizePostLoginRedirect(to.query?.redirect)
        return next(redirect || flags.resolveHomePath())
      }
    }
    return next()
  }

  if (requiresAuth) {
    const redirect = normalizePreLoginRedirect(to.fullPath || '/attendance')
    const ensuredToken = token || await auth.ensureToken()
    if (!ensuredToken) {
      return next({
        path: ROUTE_PATHS.LOGIN,
        query: { redirect },
      })
    }

    const session = await auth.bootstrapSession()
    if (!session.ok) {
      return next({
        path: ROUTE_PATHS.LOGIN,
        query: { redirect },
      })
    }
  }

  // Product capability guard + attendance focused mode restriction.
  try {
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

    if (typeof flags.isPlmWorkbenchFocused === 'function' && flags.isPlmWorkbenchFocused()) {
      const path = String(to.path || '')
      const allowedPrefixes = ['/plm']
      const allowed = allowedPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
      if (!allowed) {
        return next('/plm')
      }
    }
  } catch {
    // If guard fails (network/offline), don't block navigation.
  }
  next()
})

// Create and mount app
async function bootstrap(): Promise<void> {
  const app = createApp(App)

  app.use(ElementPlus)
  app.use(router)

  await router.isReady()
  app.mount('#app')
}

void bootstrap()
