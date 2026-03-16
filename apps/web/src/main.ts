/**
 * Vue Application Entry Point
 */
import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import App from './App.vue'
import { useAuth } from './composables/useAuth'
import { useFeatureFlags } from './stores/featureFlags'

const coreRoutes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: () => import('./views/HomeRedirect.vue'),
    meta: { title: 'Home', hideNavbar: true }
  },
  {
    path: '/login',
    name: 'login',
    component: () => import('./views/LoginView.vue'),
    meta: { title: 'Login', hideNavbar: true, requiresAuth: false }
  },
  {
    path: '/accept-invite',
    name: 'accept-invite',
    component: () => import('./views/AcceptInviteView.vue'),
    meta: { title: 'Accept Invite', hideNavbar: true, requiresAuth: false }
  },
]

const workbenchRoutes: RouteRecordRaw[] = [
  {
    path: '/grid',
    name: 'grid',
    component: () => import('./views/GridView.vue'),
    meta: { title: 'Grid View' }
  },
  {
    path: '/kanban',
    name: 'kanban',
    component: () => import('./views/KanbanView.vue'),
    meta: { title: 'Kanban View' }
  },
  {
    path: '/calendar',
    name: 'calendar',
    component: () => import('./views/CalendarView.vue'),
    meta: { title: 'Calendar View' }
  },
  {
    path: '/gallery',
    name: 'gallery',
    component: () => import('./views/GalleryView.vue'),
    meta: { title: 'Gallery View' }
  },
  {
    path: '/form',
    name: 'form',
    component: () => import('./views/FormView.vue'),
    meta: { title: 'Form View' }
  },
]

const attendanceRoutes: RouteRecordRaw[] = [
  {
    path: '/attendance',
    name: 'attendance',
    component: () => import('./views/attendance/AttendanceExperienceView.vue'),
    meta: { title: 'Attendance', requiredFeature: 'attendance' }
  },
]

const dataRoutes: RouteRecordRaw[] = [
  {
    path: '/spreadsheets',
    name: 'spreadsheet-list',
    component: () => import('./views/SpreadsheetsView.vue'),
    meta: { title: 'Spreadsheets' }
  },
  {
    path: '/spreadsheets/:id',
    name: 'spreadsheet-detail',
    component: () => import('./views/SpreadsheetDetailView.vue'),
    meta: { title: 'Spreadsheet' }
  },
  {
    path: '/workflows',
    name: 'workflow-list',
    component: () => import('./views/WorkflowHubView.vue'),
    meta: { title: 'Workflows', requiredFeature: 'workflow' }
  },
  {
    path: '/workflows/designer/:id?',
    name: 'workflow-designer',
    component: () => import('./views/WorkflowDesigner.vue'),
    meta: { title: 'Workflow Designer', requiredFeature: 'workflow' }
  },
  {
    path: '/approvals',
    name: 'approval-list',
    component: () => import('./views/ApprovalInboxView.vue'),
    meta: { title: 'Approvals' }
  },
]

const plmRoutes: RouteRecordRaw[] = [
  {
    path: '/plm',
    name: 'plm',
    component: () => import('./views/PlmProductView.vue'),
    meta: { title: 'PLM' }
  },
  {
    path: '/plm/audit',
    name: 'plm-audit',
    component: () => import('./views/PlmAuditView.vue'),
    meta: { title: 'PLM Audit' }
  },
]

const adminRoutes: RouteRecordRaw[] = [
  {
    path: '/admin/users',
    name: 'user-management',
    component: () => import('./views/UserManagementView.vue'),
    meta: { title: 'User Management' }
  },
  {
    path: '/settings',
    name: 'user-settings',
    component: () => import('./views/SessionCenterView.vue'),
    meta: { title: 'My Sessions' }
  },
  {
    path: '/admin/roles',
    name: 'role-management',
    component: () => import('./views/RoleManagementView.vue'),
    meta: { title: 'Role Management' }
  },
  {
    path: '/admin/permissions',
    name: 'permission-management',
    component: () => import('./views/PermissionManagementView.vue'),
    meta: { title: 'Permission Management' }
  },
  {
    path: '/admin/audit',
    name: 'admin-audit',
    component: () => import('./views/AdminAuditView.vue'),
    meta: { title: 'Admin Audit' }
  },
  {
    path: '/admin/plugins',
    name: 'plugin-manager',
    component: () => import('./views/PluginManagerView.vue'),
    meta: { title: 'Plugins', requiredFeature: 'attendanceAdmin' }
  },
]

const fallbackRoutes: RouteRecordRaw[] = [
  {
    path: '/p/:plugin/:viewId',
    name: 'plugin-view',
    component: () => import('./views/PluginViewHost.vue'),
    meta: { title: 'Plugin' }
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    redirect: '/',
  }
]

const routes: RouteRecordRaw[] = [
  ...coreRoutes,
  ...workbenchRoutes,
  ...attendanceRoutes,
  ...dataRoutes,
  ...plmRoutes,
  ...adminRoutes,
  ...fallbackRoutes,
]

// Create router
const router = createRouter({
  history: createWebHistory(),
  routes
})

// Navigation guard for page title
router.beforeEach(async (to, _from, next) => {
  const title = to.meta?.title
  if (title) {
    document.title = `${title} - MetaSheet`
  } else {
    document.title = 'MetaSheet'
  }

  const auth = useAuth()
  const flags = useFeatureFlags()
  const requiresAuth = to.meta?.requiresAuth !== false
  const isLoginRoute = to.name === 'login'
  const currentToken = auth.getToken()

  if (isLoginRoute) {
    if (currentToken) {
      const session = await auth.bootstrapSession()
      if (session.ok) {
        try {
          await flags.loadProductFeatures()
        } catch {
          // Fallback to a stable shell route when features are temporarily unavailable.
        }
        return next(flags.resolveHomePath())
      }
    }
    return next()
  }

  if (requiresAuth) {
    const ensuredToken = currentToken || await auth.ensureToken()
    if (!ensuredToken) {
      const redirect = typeof to.fullPath === 'string' && to.fullPath.length > 0 ? to.fullPath : '/attendance'
      return next({
        name: 'login',
        query: {
          redirect,
        },
      })
    }

    const session = await auth.bootstrapSession()
    if (!session.ok) {
      const redirect = typeof to.fullPath === 'string' && to.fullPath.length > 0 ? to.fullPath : '/attendance'
      return next({
        name: 'login',
        query: {
          redirect,
        },
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
        '/settings',
      ])
      const path = String(to.path || '')
      if (!allowed.has(path)) {
        return next('/attendance')
      }
    }

    if (typeof flags.isPlmWorkbenchFocused === 'function' && flags.isPlmWorkbenchFocused()) {
      const path = String(to.path || '')
      const allowedPrefixes = ['/plm', '/workflows', '/approvals']
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
const app = createApp(App)

app.use(router)

app.mount('#app')
