/**
 * Vue Application Entry Point
 */
import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import App from './App.vue'
import { AppRouteNames, ROUTE_PATHS } from './router/types'
import { useAuth } from './composables/useAuth'
import { useFeatureFlags } from './stores/featureFlags'
import { resolvePostLoginRedirect } from './utils/navigation'

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
import DingTalkAuthCallbackView from './views/DingTalkAuthCallbackView.vue'
import AcceptInviteView from './views/AcceptInviteView.vue'
import UserManagementView from './views/UserManagementView.vue'
import SessionCenterView from './views/SessionCenterView.vue'
import RoleManagementView from './views/RoleManagementView.vue'
import PermissionManagementView from './views/PermissionManagementView.vue'
import AdminAuditView from './views/AdminAuditView.vue'
import DirectoryManagementView from './views/DirectoryManagementView.vue'
import WorkflowDesigner from './views/WorkflowDesigner.vue'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: HomeRedirect,
    meta: { title: 'Home', hideNavbar: true, requiresAuth: true },
  },
  {
    path: ROUTE_PATHS.LOGIN,
    name: AppRouteNames.LOGIN,
    component: LoginView,
    meta: { title: 'Sign In', hideNavbar: true, requiresGuest: true },
  },
  {
    path: ROUTE_PATHS.DINGTALK_AUTH_CALLBACK,
    name: AppRouteNames.DINGTALK_AUTH_CALLBACK,
    component: DingTalkAuthCallbackView,
    meta: { title: 'DingTalk Callback', hideNavbar: true, requiresAuth: false },
  },
  {
    path: '/accept-invite',
    name: 'accept-invite',
    component: AcceptInviteView,
    meta: { title: 'Accept Invite', hideNavbar: true, requiresAuth: false },
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
    path: '/workflows/designer/:id?',
    name: 'workflow-designer',
    component: WorkflowDesigner,
    meta: { title: 'Workflow Designer', requiredFeature: 'workflow' }
  },
  {
    path: '/plm',
    name: 'plm',
    component: PlmProductView,
    meta: { title: 'PLM' }
  },
  {
    path: '/admin/users',
    name: 'user-management',
    component: UserManagementView,
    meta: { title: 'User Management' }
  },
  {
    path: '/settings',
    name: 'user-settings',
    component: SessionCenterView,
    meta: { title: 'My Sessions' }
  },
  {
    path: '/admin/roles',
    name: 'role-management',
    component: RoleManagementView,
    meta: { title: 'Role Management' }
  },
  {
    path: '/admin/permissions',
    name: 'permission-management',
    component: PermissionManagementView,
    meta: { title: 'Permission Management' }
  },
  {
    path: ROUTE_PATHS.ADMIN_DIRECTORY,
    name: AppRouteNames.ADMIN_DIRECTORY,
    component: DirectoryManagementView,
    meta: { title: 'Directory Sync', layout: 'admin', requiredFeature: 'platformAdmin' }
  },
  {
    path: '/admin/audit',
    name: 'admin-audit',
    component: AdminAuditView,
    meta: { title: 'Admin Audit' }
  },
  {
    path: '/admin/plugins',
    name: 'plugin-manager',
    component: PluginManagerView,
    meta: { title: 'Plugins', requiredFeature: 'attendanceAdmin' }
  },
  {
    path: '/p/:plugin/:viewId',
    name: 'plugin-view',
    component: PluginViewHost,
    meta: { title: 'Plugin', requiresAuth: true },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    redirect: '/',
  }
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

  const resolveHomeRedirect = async (): Promise<string> => {
    let fallbackPath = '/attendance'
    try {
      await flags.loadProductFeatures(false, { skipSessionProbe: true })
      fallbackPath = flags.resolveHomePath()
    } catch {
      // Fall back to the attendance shell route when feature detection is unavailable.
    }
    return fallbackPath
  }

  if (isLoginRoute) {
    if (currentToken) {
      const session = await auth.bootstrapSession()
      if (session.ok) {
        try {
          await flags.loadProductFeatures()
        } catch {
          // Fallback to a stable shell route when features are temporarily unavailable.
        }
        return next(resolvePostLoginRedirect(to.query?.redirect, flags.resolveHomePath()))
      }
    }
    return next()
  }

  if (requiresAuth) {
    const ensuredToken = currentToken || await auth.ensureToken()
    if (!ensuredToken) {
      const redirect = resolvePostLoginRedirect(
        typeof to.fullPath === 'string' && to.fullPath.length > 0 ? to.fullPath : '',
        await resolveHomeRedirect(),
      )
      return next({
        name: 'login',
        query: {
          redirect,
        },
      })
    }

    const session = await auth.bootstrapSession()
    if (!session.ok) {
      const redirect = resolvePostLoginRedirect(
        typeof to.fullPath === 'string' && to.fullPath.length > 0 ? to.fullPath : '',
        await resolveHomeRedirect(),
      )
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
      required === 'platformAdmin' ||
      required === 'attendanceAdmin' ||
      required === 'attendanceImport'
        ? required
        : null

    if (requiredFeature && !flags.hasFeature(requiredFeature)) {
      return next(flags.resolveHomePath())
    }

    if (flags.isAttendanceFocused()) {
      const path = String(to.path || '')
      if (!flags.isPathAllowedInAttendanceFocus(path)) {
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

app.use(ElementPlus)
app.use(router)

app.mount('#app')
