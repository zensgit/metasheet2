/**
 * Pinia Store Type Definitions
 *
 * Purpose: Centralized type definitions for all Pinia stores
 * Benefits:
 * - Type-safe store state access
 * - Improved IDE autocomplete
 * - Easier refactoring and maintenance
 * - Clear store contracts
 *
 * Usage:
 * ```typescript
 * import { defineStore } from 'pinia'
 * import type { UserState, UserGetters, UserActions } from './types'
 *
 * export const useUserStore = defineStore<'user', UserState, UserGetters, UserActions>('user', {
 *   state: (): UserState => ({
 *     currentUser: null,
 *     isAuthenticated: false
 *   }),
 *   getters: {
 *     userName: (state) => state.currentUser?.name || 'Guest'
 *   },
 *   actions: {
 *     async login(credentials) {
 *       // implementation
 *     }
 *   }
 * })
 * ```
 */

/**
 * User Store Types
 */
export interface UserState {
  currentUser: User | null
  isAuthenticated: boolean
  permissions: string[]
  roles: string[]
  token: string | null
  tokenExpiry: number | null
}

export interface UserGetters {
  userName: (state: UserState) => string
  userEmail: (state: UserState) => string | undefined
  hasPermission: (state: UserState) => (permission: string) => boolean
  hasRole: (state: UserState) => (role: string) => boolean
  isTokenValid: (state: UserState) => boolean
}

export interface UserActions {
  login(credentials: LoginCredentials): Promise<void>
  logout(): Promise<void>
  refreshToken(): Promise<void>
  updateProfile(data: Partial<User>): Promise<void>
  loadPermissions(): Promise<void>
}

/**
 * Spreadsheet Store Types
 */
export interface SpreadsheetState {
  activeSheet: Spreadsheet | null
  sheets: Spreadsheet[]
  loading: boolean
  error: string | null
  unsavedChanges: boolean
  lastSaved: Date | null
}

export interface SpreadsheetGetters {
  hasUnsavedChanges: (state: SpreadsheetState) => boolean
  activeSheetId: (state: SpreadsheetState) => string | null
  sheetById: (state: SpreadsheetState) => (id: string) => Spreadsheet | undefined
  sheetCount: (state: SpreadsheetState) => number
}

export interface SpreadsheetActions {
  loadSheet(id: string): Promise<void>
  loadSheets(): Promise<void>
  createSheet(data: CreateSpreadsheetRequest): Promise<Spreadsheet>
  updateSheet(id: string, data: UpdateSpreadsheetRequest): Promise<void>
  deleteSheet(id: string): Promise<void>
  saveChanges(): Promise<void>
  discardChanges(): void
  setActiveSheet(sheet: Spreadsheet | null): void
}

/**
 * Workflow Store Types
 */
export interface WorkflowState {
  workflows: Workflow[]
  activeWorkflow: Workflow | null
  executions: WorkflowExecution[]
  loading: boolean
  error: string | null
}

export interface WorkflowGetters {
  activeWorkflows: (state: WorkflowState) => Workflow[]
  workflowById: (state: WorkflowState) => (id: string) => Workflow | undefined
  recentExecutions: (state: WorkflowState) => WorkflowExecution[]
  executionsByWorkflow: (state: WorkflowState) => (workflowId: string) => WorkflowExecution[]
}

export interface WorkflowActions {
  loadWorkflows(): Promise<void>
  loadWorkflow(id: string): Promise<void>
  createWorkflow(data: CreateWorkflowRequest): Promise<Workflow>
  updateWorkflow(id: string, data: UpdateWorkflowRequest): Promise<void>
  deleteWorkflow(id: string): Promise<void>
  executeWorkflow(id: string, input?: any): Promise<WorkflowExecution>
  loadExecutions(workflowId?: string): Promise<void>
  cancelExecution(executionId: string): Promise<void>
}

/**
 * Approval Store Types
 */
export interface ApprovalState {
  approvals: Approval[]
  pendingApprovals: Approval[]
  myApprovals: Approval[]
  loading: boolean
  error: string | null
}

export interface ApprovalGetters {
  pendingCount: (state: ApprovalState) => number
  approvalById: (state: ApprovalState) => (id: string) => Approval | undefined
  approvalsByStatus: (state: ApprovalState) => (status: ApprovalStatus) => Approval[]
  myPendingApprovals: (state: ApprovalState) => Approval[]
}

export interface ApprovalActions {
  loadApprovals(): Promise<void>
  loadMyApprovals(): Promise<void>
  createApproval(data: CreateApprovalRequest): Promise<Approval>
  approveRequest(id: string, comment?: string): Promise<void>
  rejectRequest(id: string, reason: string): Promise<void>
  cancelApproval(id: string): Promise<void>
  loadApprovalHistory(id: string): Promise<ApprovalHistory[]>
}

/**
 * Notification Store Types
 */
export interface NotificationState {
  notifications: Notification[]
  unreadCount: number
  loading: boolean
}

export interface NotificationGetters {
  unreadNotifications: (state: NotificationState) => Notification[]
  notificationById: (state: NotificationState) => (id: string) => Notification | undefined
  hasUnread: (state: NotificationState) => boolean
}

export interface NotificationActions {
  loadNotifications(): Promise<void>
  markAsRead(id: string): Promise<void>
  markAllAsRead(): Promise<void>
  deleteNotification(id: string): Promise<void>
  clearAll(): Promise<void>
}

/**
 * App Store Types (Global UI State)
 */
export interface AppState {
  sidebarCollapsed: boolean
  theme: 'light' | 'dark' | 'auto'
  locale: string
  loading: boolean
  globalError: string | null
}

export interface AppGetters {
  effectiveTheme: (state: AppState) => 'light' | 'dark'
  isLoading: (state: AppState) => boolean
  hasError: (state: AppState) => boolean
}

export interface AppActions {
  toggleSidebar(): void
  setTheme(theme: 'light' | 'dark' | 'auto'): void
  setLocale(locale: string): void
  setLoading(loading: boolean): void
  setGlobalError(error: string | null): void
  clearError(): void
}

/**
 * Common Entity Types
 */
export interface User {
  id: string
  name: string
  email: string
  avatar?: string
  department?: string
  role: string
  createdAt: Date
  updatedAt: Date
}

export interface Spreadsheet {
  id: string
  name: string
  description?: string
  ownerId: string
  data: any // x-data-spreadsheet format
  permissions: Permission[]
  createdAt: Date
  updatedAt: Date
}

export interface Workflow {
  id: string
  name: string
  description?: string
  definition: any // BPMN definition
  status: 'active' | 'inactive'
  createdBy: string
  createdAt: Date
  updatedAt: Date
}

export interface WorkflowExecution {
  id: string
  workflowId: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  input?: any
  output?: any
  error?: string
  startedAt: Date
  completedAt?: Date
}

export interface Approval {
  id: string
  title: string
  description?: string
  status: ApprovalStatus
  requesterId: string
  approverId?: string
  createdAt: Date
  updatedAt: Date
  decidedAt?: Date
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'

export interface ApprovalHistory {
  id: string
  approvalId: string
  action: 'created' | 'approved' | 'rejected' | 'cancelled'
  userId: string
  comment?: string
  timestamp: Date
}

export interface Notification {
  id: string
  type: 'info' | 'success' | 'warning' | 'error'
  title: string
  message: string
  read: boolean
  link?: string
  createdAt: Date
}

export interface Permission {
  resource: string
  action: 'read' | 'write' | 'delete' | 'admin'
  granted: boolean
}

/**
 * Request/Response Types
 */
export interface LoginCredentials {
  email: string
  password: string
  remember?: boolean
}

export interface CreateSpreadsheetRequest {
  name: string
  description?: string
  templateId?: string
}

export interface UpdateSpreadsheetRequest {
  name?: string
  description?: string
  data?: any
}

export interface CreateWorkflowRequest {
  name: string
  description?: string
  definition: any
}

export interface UpdateWorkflowRequest {
  name?: string
  description?: string
  definition?: any
  status?: 'active' | 'inactive'
}

export interface CreateApprovalRequest {
  title: string
  description?: string
  approverId: string
  metadata?: any
}

/**
 * Store Helper Types
 */
export type StoreState<S> = () => S
export type StoreGetters<S, G> = {
  [K in keyof G]: (state: S, getters: G) => G[K]
}
export type StoreActions<A> = {
  [K in keyof A]: A[K]
}

/**
 * Type-safe store composition helper
 */
export interface TypedStore<S, G, A> {
  $id: string
  $state: S
  $getters: G
  $actions: A
}

/**
 * Store module definition helper
 */
export interface StoreModule<Id extends string, S, G, A> {
  id: Id
  state: StoreState<S>
  getters?: Partial<StoreGetters<S, G>>
  actions?: Partial<StoreActions<A>>
}
