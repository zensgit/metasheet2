import type { RouteRecordRaw } from 'vue-router'
import { AppRouteNames, ROUTE_PATHS } from './types'
import { buildMultitableRoute } from './multitableRoute'
import GridView from '../views/GridView.vue'
import KanbanView from '../views/KanbanView.vue'
import CalendarView from '../views/CalendarView.vue'
import GalleryView from '../views/GalleryView.vue'
import FormView from '../views/FormView.vue'
import PlmProductView from '../views/PlmProductView.vue'
import SpreadsheetsView from '../views/SpreadsheetsView.vue'
import SpreadsheetDetailView from '../views/SpreadsheetDetailView.vue'
import MultitableCommentInboxView from '../views/MultitableCommentInboxView.vue'
import PluginManagerView from '../views/PluginManagerView.vue'
import PluginViewHost from '../views/PluginViewHost.vue'
import AttendanceExperienceView from '../views/attendance/AttendanceExperienceView.vue'
import DingTalkAuthCallbackView from '../views/DingTalkAuthCallbackView.vue'
import HomeRedirect from '../views/HomeRedirect.vue'
import LoginView from '../views/LoginView.vue'

export const appRoutes: RouteRecordRaw[] = [
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
    path: ROUTE_PATHS.DINGTALK_AUTH_CALLBACK,
    name: AppRouteNames.DINGTALK_AUTH_CALLBACK,
    component: DingTalkAuthCallbackView,
    meta: { title: 'DingTalk Sign In', titleZh: '钉钉登录', hideNavbar: true, requiresAuth: false, requiresGuest: true }
  },
  {
    path: '/accept-invite',
    name: 'accept-invite',
    component: () => import('../views/AcceptInviteView.vue'),
    meta: { title: 'Accept Invite', hideNavbar: true, requiresAuth: false }
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
    meta: { title: 'Attendance', titleZh: '考勤', requiresAuth: true, requiredFeature: 'attendance' }
  },
  {
    path: ROUTE_PATHS.MULTITABLE_COMMENT_INBOX,
    name: AppRouteNames.MULTITABLE_COMMENT_INBOX,
    component: MultitableCommentInboxView,
    meta: { title: 'Comment Inbox', titleZh: '评论收件箱', requiresAuth: true }
  },
  {
    path: '/p/plugin-attendance/attendance',
    name: 'plugin-attendance-legacy-view',
    redirect: '/attendance',
    meta: { title: 'Attendance', titleZh: '考勤', requiresAuth: true, requiredFeature: 'attendance' },
  },
  buildMultitableRoute(() => import('../multitable/views/MultitableEmbedHost.vue')),
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
    meta: { title: 'PLM', titleZh: 'PLM', requiresAuth: true, requiredFeature: 'plm' }
  },
  {
    path: '/plm/audit',
    name: 'plm-audit',
    component: () => import('../views/PlmAuditView.vue'),
    meta: { title: 'PLM Audit', titleZh: 'PLM 审计', requiresAuth: true, requiredFeature: 'plm' }
  },
  {
    path: '/settings',
    name: 'user-settings',
    component: () => import('../views/SessionCenterView.vue'),
    meta: { title: 'My Sessions', titleZh: '我的会话', requiresAuth: true }
  },
  {
    path: '/admin/users',
    name: 'user-management',
    component: () => import('../views/UserManagementView.vue'),
    meta: { title: 'User Management', requiresAuth: true }
  },
  {
    path: '/admin/role-delegation',
    name: 'role-delegation',
    component: () => import('../views/RoleDelegationView.vue'),
    meta: { title: 'Role Delegation', titleZh: '角色委派', requiresAuth: true }
  },
  {
    path: '/admin/directory',
    name: AppRouteNames.DIRECTORY_MANAGEMENT,
    component: () => import('../views/DirectoryManagementView.vue'),
    meta: { title: 'Directory Management', titleZh: '目录同步', requiresAuth: true }
  },
  {
    path: '/admin/roles',
    name: 'role-management',
    component: () => import('../views/RoleManagementView.vue'),
    meta: { title: 'Role Management', requiresAuth: true }
  },
  {
    path: '/admin/permissions',
    name: 'permission-management',
    component: () => import('../views/PermissionManagementView.vue'),
    meta: { title: 'Permission Management', requiresAuth: true }
  },
  {
    path: '/admin/audit',
    name: 'admin-audit',
    component: () => import('../views/AdminAuditView.vue'),
    meta: { title: 'Admin Audit', requiresAuth: true }
  },
  {
    path: '/workflows',
    name: 'workflow-list',
    component: () => import('../views/WorkflowHubView.vue'),
    meta: { title: 'Workflows', titleZh: '流程', requiresAuth: true, requiredFeature: 'workflow' }
  },
  {
    path: '/workflows/designer/:id?',
    name: 'workflow-designer',
    component: () => import('../views/WorkflowDesigner.vue'),
    meta: { title: 'Workflow Designer', titleZh: '流程设计', requiresAuth: true, requiredFeature: 'workflow' }
  },
  {
    path: '/approvals',
    name: 'approval-list',
    component: () => import('../views/ApprovalInboxView.vue'),
    meta: { title: 'Approvals', titleZh: '审批中心', requiresAuth: true }
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
