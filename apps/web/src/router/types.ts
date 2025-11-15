/**
 * Vue Router Type Definitions
 *
 * Purpose: Type-safe route parameters and metadata
 * Benefits:
 * - Type-safe route navigation
 * - Compile-time route validation
 * - IDE autocomplete for route names and params
 * - Clear route contracts
 *
 * Usage:
 * ```typescript
 * import { useRouter } from 'vue-router'
 * import type { AppRouteNames, AppRouteParams } from './types'
 *
 * const router = useRouter()
 *
 * // Type-safe navigation
 * router.push({
 *   name: 'spreadsheet-detail', // autocomplete available
 *   params: { id: '123' } // type checked
 * })
 *
 * // Type-safe params access
 * const route = useRoute<'spreadsheet-detail'>()
 * const id: string = route.params.id // typed as string
 * ```
 */

import type { RouteLocationNormalized, RouteRecordRaw } from 'vue-router'

/**
 * Route Names Constants
 * Add all route names here for type safety
 * Using const assertion for erasableSyntaxOnly compatibility
 */
export const AppRouteNames = {
  // Auth routes
  LOGIN: 'login',
  REGISTER: 'register',
  FORGOT_PASSWORD: 'forgot-password',
  RESET_PASSWORD: 'reset-password',

  // Dashboard routes
  DASHBOARD: 'dashboard',
  HOME: 'home',

  // Spreadsheet routes
  SPREADSHEET_LIST: 'spreadsheet-list',
  SPREADSHEET_DETAIL: 'spreadsheet-detail',
  SPREADSHEET_CREATE: 'spreadsheet-create',
  SPREADSHEET_EDIT: 'spreadsheet-edit',

  // Workflow routes
  WORKFLOW_LIST: 'workflow-list',
  WORKFLOW_DETAIL: 'workflow-detail',
  WORKFLOW_CREATE: 'workflow-create',
  WORKFLOW_DESIGNER: 'workflow-designer',
  WORKFLOW_EXECUTION: 'workflow-execution',

  // Approval routes
  APPROVAL_LIST: 'approval-list',
  APPROVAL_DETAIL: 'approval-detail',
  APPROVAL_CREATE: 'approval-create',
  APPROVAL_PENDING: 'approval-pending',
  APPROVAL_HISTORY: 'approval-history',

  // User routes
  USER_PROFILE: 'user-profile',
  USER_SETTINGS: 'user-settings',
  USER_MANAGEMENT: 'user-management',

  // Permission routes
  PERMISSION_MANAGEMENT: 'permission-management',
  ROLE_MANAGEMENT: 'role-management',

  // Admin routes
  ADMIN_DASHBOARD: 'admin-dashboard',
  ADMIN_SETTINGS: 'admin-settings',
  ADMIN_LOGS: 'admin-logs',

  // Error routes
  NOT_FOUND: 'not-found',
  FORBIDDEN: 'forbidden',
  SERVER_ERROR: 'server-error'
} as const

/**
 * Route Names Type
 * Extract the type from the const object
 */
export type AppRouteNamesType = typeof AppRouteNames[keyof typeof AppRouteNames]

/**
 * Route Parameter Types
 * Define params for each route using string literal keys for type safety
 */
export interface AppRouteParams {
  // Auth routes
  'reset-password': { token: string }

  // Spreadsheet routes
  'spreadsheet-detail': { id: string }
  'spreadsheet-edit': { id: string }

  // Workflow routes
  'workflow-detail': { id: string }
  'workflow-designer': { id?: string } // optional for create mode
  'workflow-execution': { executionId: string }

  // Approval routes
  'approval-detail': { id: string }

  // User routes
  'user-profile': { id?: string } // optional, defaults to current user

  // Routes without params
  'login': Record<string, never>
  'register': Record<string, never>
  'forgot-password': Record<string, never>
  'dashboard': Record<string, never>
  'home': Record<string, never>
  'spreadsheet-list': Record<string, never>
  'spreadsheet-create': Record<string, never>
  'workflow-list': Record<string, never>
  'workflow-create': Record<string, never>
  'approval-list': Record<string, never>
  'approval-create': Record<string, never>
  'approval-pending': Record<string, never>
  'approval-history': Record<string, never>
  'user-settings': Record<string, never>
  'user-management': Record<string, never>
  'permission-management': Record<string, never>
  'role-management': Record<string, never>
  'admin-dashboard': Record<string, never>
  'admin-settings': Record<string, never>
  'admin-logs': Record<string, never>
  'not-found': Record<string, never>
  'forbidden': Record<string, never>
  'server-error': Record<string, never>
}

/**
 * Route Query Types
 * Define query parameters for each route using string literal keys
 */
export interface AppRouteQuery {
  // Spreadsheet list filters
  'spreadsheet-list': {
    search?: string
    owner?: string
    sortBy?: 'name' | 'createdAt' | 'updatedAt'
    sortOrder?: 'asc' | 'desc'
    page?: string
    pageSize?: string
  }

  // Workflow list filters
  'workflow-list': {
    search?: string
    status?: 'active' | 'inactive'
    sortBy?: 'name' | 'createdAt'
    sortOrder?: 'asc' | 'desc'
  }

  // Approval list filters
  'approval-list': {
    status?: 'pending' | 'approved' | 'rejected'
    search?: string
    sortBy?: 'createdAt' | 'updatedAt'
    sortOrder?: 'asc' | 'desc'
  }

  // Login redirect
  'login': {
    redirect?: string
  }

  // Default (no query params) - index signature for untyped routes
  [key: string]: Record<string, string | string[] | undefined>
}

/**
 * Route Meta Types
 * Define metadata for each route
 */
export interface RouteMeta {
  // Page title
  title?: string

  // Auth requirements
  requiresAuth?: boolean
  requiresGuest?: boolean

  // Permission requirements
  permissions?: string[]
  roles?: string[]

  // Layout settings
  layout?: 'default' | 'empty' | 'admin'
  hideNavbar?: boolean
  hideSidebar?: boolean

  // Breadcrumb settings
  breadcrumb?: BreadcrumbItem[]
  hideBreadcrumb?: boolean

  // Other metadata
  icon?: string
  keepAlive?: boolean
  transition?: string
}

/**
 * Breadcrumb Item
 */
export interface BreadcrumbItem {
  text: string
  to?: string | { name: string }
  icon?: string
}

/**
 * Typed Route Record
 */
export interface TypedRouteRecord<Name extends AppRouteNamesType = AppRouteNamesType>
  extends Omit<RouteRecordRaw, 'name' | 'meta'> {
  name: Name
  meta?: RouteMeta
}

/**
 * Typed Route Location
 */
export interface TypedRouteLocation<Name extends AppRouteNamesType = AppRouteNamesType>
  extends Omit<RouteLocationNormalized, 'name' | 'params' | 'meta'> {
  name: Name
  params: Name extends keyof AppRouteParams ? AppRouteParams[Name] : Record<string, string>
  query: Record<string, string | string[]>
  meta: Required<RouteMeta>
}

/**
 * Navigation Options
 */
export interface NavigationOptions<Name extends AppRouteNamesType = AppRouteNamesType> {
  name: Name
  params?: AppRouteParams[Name]
  query?: Partial<AppRouteQuery[Name]>
  hash?: string
  replace?: boolean
}

/**
 * Route Guard Context
 */
export interface RouteGuardContext<Name extends AppRouteNamesType = AppRouteNamesType> {
  to: TypedRouteLocation<Name>
  from: TypedRouteLocation
  next: (
    location?:
      | boolean
      | string
      | {
          name: AppRouteNamesType
          params?: Record<string, any>
          query?: Record<string, any>
        }
  ) => void
}

/**
 * Helper type to extract params from route name
 */
export type RouteParams<Name extends AppRouteNamesType> = Name extends keyof AppRouteParams ? AppRouteParams[Name] : never

/**
 * Helper type to extract query from route name
 */
export type RouteQuery<Name extends AppRouteNamesType> = Name extends keyof AppRouteQuery ? AppRouteQuery[Name] : never

/**
 * Helper type for route navigation
 */
export type RouteNavigation<Name extends AppRouteNamesType> = {
  name: Name
} & (Name extends keyof AppRouteParams
  ? keyof AppRouteParams[Name] extends never
    ? { params?: never }
    : { params: AppRouteParams[Name] }
  : { params?: never }) &
  (Name extends keyof AppRouteQuery
    ? keyof AppRouteQuery[Name] extends never
      ? { query?: never }
      : { query?: Partial<AppRouteQuery[Name]> }
    : { query?: never })

/**
 * Route definition helper
 */
export function defineRoute<Name extends AppRouteNamesType>(
  config: TypedRouteRecord<Name>
): TypedRouteRecord<Name> {
  return config
}

/**
 * Navigation helper with type safety
 */
export function createTypedNavigation<Name extends AppRouteNamesType>(
  name: Name,
  params?: AppRouteParams[Name],
  query?: Partial<AppRouteQuery[Name]>
): NavigationOptions<Name> {
  return {
    name,
    params,
    query
  } as NavigationOptions<Name>
}

/**
 * Route constants for common paths
 */
export const ROUTE_PATHS = {
  // Auth
  LOGIN: '/login',
  REGISTER: '/register',
  FORGOT_PASSWORD: '/forgot-password',
  RESET_PASSWORD: '/reset-password/:token',

  // Dashboard
  DASHBOARD: '/dashboard',
  HOME: '/',

  // Spreadsheet
  SPREADSHEET_LIST: '/spreadsheets',
  SPREADSHEET_DETAIL: '/spreadsheets/:id',
  SPREADSHEET_CREATE: '/spreadsheets/create',
  SPREADSHEET_EDIT: '/spreadsheets/:id/edit',

  // Workflow
  WORKFLOW_LIST: '/workflows',
  WORKFLOW_DETAIL: '/workflows/:id',
  WORKFLOW_CREATE: '/workflows/create',
  WORKFLOW_DESIGNER: '/workflows/designer/:id?',
  WORKFLOW_EXECUTION: '/workflows/executions/:executionId',

  // Approval
  APPROVAL_LIST: '/approvals',
  APPROVAL_DETAIL: '/approvals/:id',
  APPROVAL_CREATE: '/approvals/create',
  APPROVAL_PENDING: '/approvals/pending',
  APPROVAL_HISTORY: '/approvals/history',

  // User
  USER_PROFILE: '/profile/:id?',
  USER_SETTINGS: '/settings',
  USER_MANAGEMENT: '/admin/users',

  // Permission
  PERMISSION_MANAGEMENT: '/admin/permissions',
  ROLE_MANAGEMENT: '/admin/roles',

  // Admin
  ADMIN_DASHBOARD: '/admin',
  ADMIN_SETTINGS: '/admin/settings',
  ADMIN_LOGS: '/admin/logs',

  // Error
  NOT_FOUND: '/:pathMatch(.*)*',
  FORBIDDEN: '/403',
  SERVER_ERROR: '/500'
} as const

/**
 * Route guard helpers
 */
export const RouteGuards = {
  /**
   * Check if user is authenticated
   */
  requiresAuth: (to: TypedRouteLocation, from: TypedRouteLocation) => {
    const token = localStorage.getItem('auth_token')
    if (!token && to.meta.requiresAuth) {
      return { name: AppRouteNames.LOGIN, query: { redirect: to.fullPath } }
    }
    return true
  },

  /**
   * Check if user is guest (not authenticated)
   */
  requiresGuest: (to: TypedRouteLocation, from: TypedRouteLocation) => {
    const token = localStorage.getItem('auth_token')
    if (token && to.meta.requiresGuest) {
      return { name: AppRouteNames.DASHBOARD }
    }
    return true
  },

  /**
   * Check if user has required permissions
   */
  requiresPermissions: (to: TypedRouteLocation, from: TypedRouteLocation) => {
    const requiredPermissions = to.meta.permissions || []
    if (requiredPermissions.length === 0) return true

    // Get user permissions from store or localStorage
    const userPermissionsStr = localStorage.getItem('user_permissions')
    const userPermissions = userPermissionsStr ? JSON.parse(userPermissionsStr) : []

    const hasPermission = requiredPermissions.every((permission) =>
      userPermissions.includes(permission)
    )

    if (!hasPermission) {
      return { name: AppRouteNames.FORBIDDEN }
    }

    return true
  },

  /**
   * Check if user has required roles
   */
  requiresRoles: (to: TypedRouteLocation, from: TypedRouteLocation) => {
    const requiredRoles = to.meta.roles || []
    if (requiredRoles.length === 0) return true

    // Get user roles from store or localStorage
    const userRolesStr = localStorage.getItem('user_roles')
    const userRoles = userRolesStr ? JSON.parse(userRolesStr) : []

    const hasRole = requiredRoles.some((role) => userRoles.includes(role))

    if (!hasRole) {
      return { name: AppRouteNames.FORBIDDEN }
    }

    return true
  }
}
