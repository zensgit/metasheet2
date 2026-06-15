// ---------------------------------------------------------------------------
// Multitable TypeScript types — derived from OpenAPI schemas in base.yml
// ---------------------------------------------------------------------------

// --- Field types ---
export type MetaFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'dateTime'
  | 'formula'
  | 'select'
  | 'multiSelect'
  | 'link'
  | 'person'
  | 'lookup'
  | 'rollup'
  | 'attachment'
  | 'currency'
  | 'percent'
  | 'rating'
  | 'url'
  | 'email'
  | 'phone'
  | 'barcode'
  | 'qrcode'
  | 'location'
  | 'longText'
  | 'autoNumber'
  | 'createdTime'
  | 'modifiedTime'
  | 'createdBy'
  | 'modifiedBy'

export type MetaFieldCreateType = MetaFieldType

export type RowDensity = 'compact' | 'normal' | 'expanded'

// --- Core entities ---
export interface MetaBase {
  id: string
  name: string
  icon?: string | null
  color?: string | null
  ownerId?: string | null
  workspaceId?: string | null
}

export interface MetaSheet {
  id: string
  baseId?: string | null
  name: string
  description?: string | null
}

export interface MetaField {
  id: string
  name: string
  type: MetaFieldType
  property?: Record<string, unknown>
  order?: number
  required?: boolean
  // Convenience — populated by backend for select fields
  options?: Array<{ value: string; color?: string }>
}

export interface MetaView {
  id: string
  sheetId: string
  name: string
  type: string
  filterInfo?: Record<string, unknown>
  sortInfo?: Record<string, unknown>
  groupInfo?: Record<string, unknown>
  hiddenFieldIds?: string[]
  config?: Record<string, unknown>
}

// --- Conditional formatting (MF3) ---
// Mirrors `packages/core-backend/src/multitable/conditional-formatting-service.ts`.
// Backend is the canonical source — keep shapes in sync when extending.
export type ConditionalFormattingOperator =
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'eq'
  | 'neq'
  | 'between'
  | 'contains'
  | 'not_contains'
  | 'is_empty'
  | 'is_not_empty'
  | 'is_today'
  | 'is_in_last_n_days'
  | 'is_in_next_n_days'
  | 'is_overdue'
  | 'is_true'
  | 'is_false'

export interface ConditionalFormattingStyle {
  backgroundColor?: string
  textColor?: string
  applyToRow?: boolean
}

export interface ConditionalFormattingRule {
  id: string
  order: number
  fieldId: string
  operator: ConditionalFormattingOperator
  value?: unknown
  style: ConditionalFormattingStyle
  enabled: boolean
}

export const CONDITIONAL_FORMATTING_RULE_LIMIT = 20

export interface MetaRecord {
  id: string
  version: number
  data: Record<string, unknown>
  // Record-locking metadata (top-level, NOT a data field). `canUnlock` is the server-authoritative
  // per-row gate for showing the unlock action; only meaningful when `locked` is true.
  locked?: boolean
  lockedBy?: string | null
  lockedAt?: string | null
  canUnlock?: boolean
}

// --- Pagination ---
export interface MetaPage {
  offset: number
  limit: number
  total: number
  hasMore: boolean
}

// --- View data (GET /api/multitable/view) ---
export interface MetaViewData {
  id: string
  fields: MetaField[]
  rows: MetaRecord[]
  linkSummaries?: Record<string, Record<string, LinkedRecordSummary[]>>
  attachmentSummaries?: Record<string, Record<string, MetaAttachment[]>>
  view?: MetaView | null
  meta?: MetaViewMeta
  page?: MetaPage
}

export interface MetaViewMeta {
  warnings?: string[]
  computedFilterSort?: boolean
  ignoredSortFieldIds?: string[]
  ignoredFilterFieldIds?: string[]
  capabilityOrigin?: MetaCapabilityOrigin
  permissions?: MetaScopedPermissions
}

export interface MetaFieldPermission {
  visible: boolean
  readOnly: boolean
}

export interface MetaViewPermission {
  canAccess: boolean
  canConfigure: boolean
  canDelete: boolean
}

export interface MetaRowActions {
  canEdit: boolean
  canDelete: boolean
  canComment: boolean
}

export interface MetaScopedPermissions {
  fieldPermissions?: Record<string, MetaFieldPermission>
  viewPermissions?: Record<string, MetaViewPermission>
  rowActions?: MetaRowActions
  rowActionOverrides?: Record<string, MetaRowActions>
}

// --- Context (GET /api/multitable/context) ---
export interface MetaContext {
  base?: MetaBase | null
  sheet?: MetaSheet | null
  sheets: MetaSheet[]
  views: MetaView[]
  capabilities: MetaCapabilities
  capabilityOrigin?: MetaCapabilityOrigin
  fieldPermissions?: Record<string, MetaFieldPermission>
  viewPermissions?: Record<string, MetaViewPermission>
}

// --- Record context (GET /api/multitable/records/:recordId) ---
export interface MetaRecordContext {
  sheet: MetaSheet
  view?: MetaView | null
  fields: MetaField[]
  record: MetaRecord
  capabilities: MetaCapabilities
  capabilityOrigin?: MetaCapabilityOrigin
  fieldPermissions?: Record<string, MetaFieldPermission>
  viewPermissions?: Record<string, MetaViewPermission>
  rowActions?: MetaRowActions
  commentsScope: MetaCommentsScope
  linkSummaries?: Record<string, LinkedRecordSummary[]>
  attachmentSummaries?: Record<string, MetaAttachment[]>
}

export type MetaRecordRevisionAction = 'create' | 'update' | 'delete'

export interface MetaRecordRevision {
  id: string
  sheetId: string
  recordId: string
  version: number
  action: MetaRecordRevisionAction
  source: string
  actorId: string | null
  changedFieldIds: string[]
  patch: Record<string, unknown>
  snapshot: Record<string, unknown> | null
  createdAt: string
}

export interface MetaRecordSubscription {
  id: string
  sheetId: string
  recordId: string
  userId: string
  createdAt: string
  updatedAt: string
}

export interface MetaRecordSubscriptionStatus {
  subscribed: boolean
  subscription: MetaRecordSubscription | null
  items?: MetaRecordSubscription[]
}

export type MetaRecordSubscriptionNotificationType = 'record.updated' | 'comment.created'

export interface MetaRecordSubscriptionNotification {
  id: string
  sheetId: string
  recordId: string
  userId: string
  eventType: MetaRecordSubscriptionNotificationType
  actorId: string | null
  revisionId: string | null
  commentId: string | null
  createdAt: string
  readAt: string | null
}

// --- Form context (GET /api/multitable/form-context) ---
export interface MetaFormContext {
  mode: 'form'
  readOnly: boolean
  submitPath: string
  sheet: MetaSheet
  view?: MetaView | null
  fields: MetaField[]
  capabilities: MetaCapabilities
  capabilityOrigin?: MetaCapabilityOrigin
  fieldPermissions?: Record<string, MetaFieldPermission>
  viewPermissions?: Record<string, MetaViewPermission>
  rowActions?: MetaRowActions
  record?: MetaRecord | null
  commentsScope?: MetaCommentsScope | null
  attachmentSummaries?: Record<string, MetaAttachment[]>
}

// --- Capabilities ---
export interface MetaCapabilities {
  canRead: boolean
  canCreateRecord: boolean
  canEditRecord: boolean
  canDeleteRecord: boolean
  canManageFields: boolean
  canManageSheetAccess: boolean
  canManageViews: boolean
  canComment: boolean
  canManageAutomation: boolean
  canExport: boolean
}

export interface YjsPresenceUser {
  id: string
  fieldIds: string[]
}

export interface YjsRecordPresence {
  recordId: string
  activeCount: number
  users: YjsPresenceUser[]
}

export interface MetaCapabilityOrigin {
  source: 'admin' | 'global-rbac' | 'sheet-grant' | 'sheet-scope'
  hasSheetAssignments: boolean
}

export type MetaSheetPermissionAccessLevel = 'read' | 'write' | 'write-own' | 'admin'
export type MetaSheetPermissionSubjectType = 'user' | 'role' | 'member-group'

export interface MetaSheetPermissionEntry {
  subjectType: MetaSheetPermissionSubjectType
  subjectId: string
  accessLevel: MetaSheetPermissionAccessLevel
  permissions: string[]
  label: string
  subtitle?: string | null
  isActive: boolean
}

export interface MetaSheetPermissionCandidate {
  subjectType: MetaSheetPermissionSubjectType
  subjectId: string
  label: string
  subtitle?: string | null
  isActive: boolean
  accessLevel?: MetaSheetPermissionAccessLevel | null
  dingtalkBound?: boolean | null
  dingtalkGrantEnabled?: boolean | null
  dingtalkPersonDeliveryAvailable?: boolean | null
}

export interface MetaFieldPermissionEntry {
  fieldId: string
  subjectType: MetaSheetPermissionSubjectType
  subjectId: string
  subjectLabel?: string
  subjectSubtitle?: string | null
  isActive?: boolean
  visible: boolean
  readOnly: boolean
}

export interface MetaViewPermissionEntry {
  viewId: string
  subjectType: MetaSheetPermissionSubjectType
  subjectId: string
  subjectLabel?: string
  subjectSubtitle?: string | null
  isActive?: boolean
  permission: string
}

// --- Comments ---
export interface MetaCommentsScope {
  targetType: string
  targetId: string
  baseId?: string | null
  sheetId?: string | null
  viewId?: string | null
  recordId?: string | null
  targetFieldId?: string | null
  containerType: string
  containerId: string
}

export interface MetaCommentMentionSuggestion {
  id: string
  label: string
  subtitle?: string
}

export interface MultitableComment {
  id: string
  containerId: string
  targetId: string
  spreadsheetId?: string
  rowId?: string
  fieldId?: string | null
  targetFieldId?: string | null
  parentId?: string
  mentions: string[]
  authorId: string
  authorName?: string
  content: string
  resolved: boolean
  createdAt: string
  updatedAt?: string
}

export interface MultitableCommentPresenceSummary {
  containerId: string
  targetId: string
  spreadsheetId?: string
  rowId?: string
  unresolvedCount: number
  fieldCounts: Record<string, number>
  mentionedCount: number
  mentionedFieldCounts: Record<string, number>
}

export interface CommentMentionSummaryItem {
  rowId: string
  mentionedCount: number
  unreadCount: number
  mentionedFieldIds: string[]
}

export interface CommentMentionSummary {
  spreadsheetId: string
  unresolvedMentionCount: number
  unreadMentionCount: number
  mentionedRecordCount: number
  unreadRecordCount: number
  items: CommentMentionSummaryItem[]
}

export interface MultitableCommentInboxItem extends MultitableComment {
  unread: boolean
  mentioned: boolean
  baseId?: string | null
  sheetId?: string | null
  viewId?: string | null
  recordId?: string | null
}

export type MetaCommentInboxItem = MultitableCommentInboxItem

export interface MultitableCommentInboxPage {
  items: MultitableCommentInboxItem[]
  total: number
  limit: number
  offset: number
}

export interface MultitableSheetPresenceUser {
  id: string
}

export interface MultitableSheetPresence {
  sheetId: string
  activeCount: number
  users: MultitableSheetPresenceUser[]
}

// --- Link records ---
export interface LinkedRecordSummary {
  id: string
  display: string
}

export interface LinkFieldRef {
  id: string
  name: string
  type: string
}

export interface LinkOptionsData {
  field: LinkFieldRef
  targetSheet: MetaSheet
  selected: LinkedRecordSummary[]
  records: LinkedRecordSummary[]
  page: MetaPage
}

// --- Patch ---
export interface CellChange {
  recordId: string
  fieldId: string
  value?: unknown
  expectedVersion?: number
}

export interface RecordVersion {
  recordId: string
  version: number
}

export interface PatchFailure {
  recordId: string
  code: string
  message: string
  serverVersion?: number
}

export interface PatchResult {
  updated: RecordVersion[]
  failed?: PatchFailure[]
  records?: Array<{ recordId: string; data: Record<string, unknown> }>
  linkSummaries?: Record<string, Record<string, LinkedRecordSummary[]>>
  attachmentSummaries?: Record<string, Record<string, MetaAttachment[]>>
  relatedRecords?: Array<{ sheetId: string; recordId: string; data: Record<string, unknown> }>
}

// --- Form submit ---
export interface FormSubmitResult {
  mode: 'create' | 'update'
  record: MetaRecord
  commentsScope: MetaCommentsScope
  attachmentSummaries?: Record<string, MetaAttachment[]>
}

// --- Record summary ---
export interface RecordSummaryPage {
  records: LinkedRecordSummary[]
  displayMap: Record<string, string>
  page: MetaPage
}

// --- Template library ---
export interface MetaTemplateField {
  id: string
  name: string
  type: MetaFieldType
  order?: number
  options?: string[]
  property?: Record<string, unknown>
  description?: string
}

export interface MetaTemplateView {
  id: string
  name: string
  type: string
  groupByFieldId?: string
  dateFieldId?: string
  titleFieldId?: string
  hiddenFieldIds?: string[]
  config?: Record<string, unknown>
}

export interface MetaTemplateSheet {
  id: string
  name: string
  description?: string | null
  fields: MetaTemplateField[]
  views: MetaTemplateView[]
}

export interface MetaTemplate {
  id: string
  name: string
  description: string
  category: string
  icon: string
  color: string
  sheets: MetaTemplateSheet[]
}

export interface InstallTemplateInput {
  baseName?: string
  workspaceId?: string
}

export interface InstallTemplateResult {
  template: MetaTemplate
  base: MetaBase
  sheets: MetaSheet[]
  fields: MetaField[]
  views: MetaView[]
}

// S2 — POST /templates/:id/dry-run (design 20260611 §2.1). Zero-write install
// simulation: wouldCreate ids derive through the same generator path install
// uses but are illustrative, NOT a promise of the ids a later install creates.
export type TemplateDryRunConflictKind =
  | 'base_exists'
  | 'sheet_exists'
  | 'view_exists'
  // Plan-level self-collision inside a (mis-authored) template (review
  // 2026-06-11 F1) — derived sheet/field/view ids duplicate each other.
  | 'template_duplicate_id'

export interface TemplateDryRunConflict {
  severity: 'error'
  kind: TemplateDryRunConflictKind
  id: string
  name: string
  /** English + stable kind; localize by kind (formula dry-run convention). */
  message: string
}

export interface TemplateDryRunWouldCreate {
  base: { id: string; name: string }
  sheets: Array<{ id: string; name: string; fieldCount: number; viewCount: number }>
  fields: Array<{ id: string; sheetId: string; name: string; type: string }>
  views: Array<{ id: string; sheetId: string; name: string; type: string }>
}

export interface TemplateDryRunResult {
  templateId: string
  wouldCreate: TemplateDryRunWouldCreate
  conflicts: TemplateDryRunConflict[]
  installable: boolean
}

// --- Input types ---
export interface CreateBaseInput {
  id?: string
  name: string
  icon?: string
  color?: string
  ownerId?: string
  workspaceId?: string
}

export interface CreateSheetInput {
  id?: string
  baseId?: string
  name: string
  description?: string
  seed?: boolean
}

export interface CreateFieldInput {
  id?: string
  sheetId: string
  name: string
  type?: string
  property?: Record<string, unknown>
  order?: number
}

export interface MetaPreparedPersonField {
  targetSheet: MetaSheet
  fieldProperty: Record<string, unknown>
}

export interface UpdateFieldInput {
  name?: string
  type?: string
  property?: Record<string, unknown>
  order?: number
}

export interface CreateViewInput {
  id?: string
  sheetId: string
  name: string
  type?: string
  filterInfo?: Record<string, unknown>
  sortInfo?: Record<string, unknown>
  groupInfo?: Record<string, unknown>
  hiddenFieldIds?: string[]
  config?: Record<string, unknown>
}

export interface UpdateViewInput {
  name?: string
  type?: string
  filterInfo?: Record<string, unknown>
  sortInfo?: Record<string, unknown>
  groupInfo?: Record<string, unknown>
  hiddenFieldIds?: string[]
  config?: Record<string, unknown>
}

export interface CreateRecordInput {
  viewId?: string
  sheetId?: string
  data?: Record<string, unknown>
}

export interface PatchRecordsInput {
  viewId?: string
  sheetId?: string
  partialSuccess?: boolean
  changes: CellChange[]
}

export interface FormSubmitInput {
  recordId?: string
  expectedVersion?: number
  publicToken?: string
  data: Record<string, unknown>
}

// --- Attachments ---
export interface MetaAttachment {
  id: string
  filename: string
  mimeType: string
  size: number
  url: string
  thumbnailUrl?: string | null
  uploadedAt: string
}

export interface MetaAttachmentUploadContext {
  sheetId?: string
  recordId?: string
  fieldId?: string
}

export type MetaAttachmentUploadFn = (
  file: File,
  context?: MetaAttachmentUploadContext,
) => Promise<MetaAttachment>

export type MetaAttachmentDeleteFn = (
  attachmentId: string,
  context?: MetaAttachmentUploadContext,
) => Promise<void>

// --- Timeline config ---
export interface TimelineConfig {
  startFieldId: string
  endFieldId: string
  zoom: 'day' | 'week' | 'month'
}

export interface MetaGalleryViewConfig {
  titleFieldId?: string | null
  coverFieldId?: string | null
  fieldIds?: string[]
  columns?: number
  cardSize?: 'small' | 'medium' | 'large'
}

export interface MetaCalendarViewConfig {
  dateFieldId?: string | null
  endDateFieldId?: string | null
  titleFieldId?: string | null
  defaultView?: 'month' | 'week' | 'day'
  weekStartsOn?: number
}

export interface MetaKanbanViewConfig {
  groupFieldId?: string | null
  cardFieldIds?: string[]
}

export interface MetaTimelineViewConfig {
  startFieldId?: string | null
  endFieldId?: string | null
  labelFieldId?: string | null
  zoom?: 'day' | 'week' | 'month'
}

export interface MetaGanttViewConfig {
  startFieldId?: string | null
  endFieldId?: string | null
  titleFieldId?: string | null
  progressFieldId?: string | null
  groupFieldId?: string | null
  dependencyFieldId?: string | null
  zoom?: 'day' | 'week' | 'month'
}

export interface MetaHierarchyViewConfig {
  parentFieldId?: string | null
  titleFieldId?: string | null
  defaultExpandDepth?: number
  orphanMode?: 'root' | 'hidden'
}

// --- Record-level permissions ---
export type RecordPermissionAccessLevel = 'read' | 'write' | 'admin'
export type RecordPermissionSubjectType = 'user' | 'role' | 'member-group'

export interface RecordPermissionEntry {
  id: string
  sheetId: string
  recordId: string
  subjectType: RecordPermissionSubjectType
  subjectId: string
  accessLevel: RecordPermissionAccessLevel
  label: string
  subtitle?: string | null
  isActive: boolean
  createdAt?: string
  createdBy?: string
}

// --- Automation rules (V1 engine) ---
export type AutomationTriggerType =
  | 'record.created'
  | 'record.updated'
  | 'record.deleted'
  | 'field.value_changed'
  | 'schedule.cron'
  | 'schedule.interval'
  | 'webhook.received'
  // Legacy aliases
  | 'field.changed'

export type ConditionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'greater_than'
  | 'less_than'
  | 'greater_or_equal'
  | 'less_or_equal'
  | 'is_empty'
  | 'is_not_empty'
  | 'in'
  | 'not_in'

export interface AutomationCondition {
  fieldId: string
  operator: ConditionOperator
  value?: unknown
}

export type AutomationConditionNode = AutomationCondition | ConditionGroup

export interface ConditionGroup {
  conjunction?: 'AND' | 'OR'
  logic?: 'and' | 'or'
  conditions: AutomationConditionNode[]
}

export type AutomationActionType =
  | 'update_record'
  | 'create_record'
  | 'send_webhook'
  | 'send_notification'
  | 'send_email'
  | 'send_dingtalk_group_message'
  | 'send_dingtalk_person_message'
  | 'lock_record'
  | 'wait_for_callback'
  | 'condition_branch'
  | 'parallel_branch'
  // Legacy aliases
  | 'notify'
  | 'update_field'

export interface AutomationTrigger {
  type: AutomationTriggerType
  config: Record<string, unknown>
}

export interface AutomationAction {
  type: AutomationActionType
  config: Record<string, unknown>
}

export interface AutomationRule {
  id: string
  sheetId: string
  name: string
  triggerType: AutomationTriggerType
  triggerConfig: Record<string, unknown>
  trigger?: AutomationTrigger
  conditions?: ConditionGroup
  actions?: AutomationAction[]
  actionType: AutomationActionType
  actionConfig: Record<string, unknown>
  enabled: boolean
  // A6-1 opt-in: 'workflow_job_v1' persists a per-action WorkflowJob plane; null/'legacy' = off.
  executionMode?: string | null
  createdAt?: string
  updatedAt?: string
  createdBy?: string
}

export interface AutomationStepResult {
  actionType: AutomationActionType
  status: 'success' | 'failed' | 'skipped'
  output?: unknown
  error?: string
  durationMs?: number
}

export interface AutomationExecution {
  id: string
  ruleId: string
  status: 'success' | 'failed' | 'skipped'
  /**
   * Source / actor that fired the rule. Backend column `triggered_by`
   * (see `multitable_automation_executions` migration). Common values
   * include `event`, `scheduler`, `manual`, or a username when invoked
   * interactively.
   */
  triggeredBy: string
  /**
   * ISO timestamp when the execution started. Backend column
   * `triggered_at`.
   */
  triggeredAt: string
  completedAt?: string
  /**
   * Execution duration in milliseconds. Backend column `duration` is
   * already stored in ms; UI no longer carries a separate `durationMs`
   * alias to avoid the field-name drift that previously left the
   * column blank in `MetaAutomationLogViewer`.
   */
  duration?: number
  steps?: AutomationStepResult[]
  error?: string
}

/**
 * Converged workflow-job status (C1 contract). The A2 read-only runs API emits
 * these at the read boundary (e.g. legacy `success` → `resolved`); the legacy
 * `multitable_automation_executions.status` storage is unchanged.
 */
export type WorkflowJobStatus =
  | 'queued'
  | 'running'
  | 'suspended'
  | 'resolved'
  | 'failed'
  | 'skipped'
  | 'rejected'
  | 'errored'

/** One step of a run, mapped to the C1 WorkflowJob view by the A2 read boundary. */
export interface AutomationRunStepView {
  id: string
  executionId: string
  stepKey: string
  status: WorkflowJobStatus
  upstreamJobId: string | null
  result?: unknown
  error?: string
  /** A6-2: present iff status === 'suspended' — the C1 suspend descriptor. The resume token is
   * admin-detail-only (the runs detail uses it for the Resume action; never shown in the list). */
  suspend?: { reason: string; resumeToken: string }
}

/**
 * A run as returned by the A2 read-only runs API
 * (`GET /api/multitable/automation-executions` + `/:id`, admin-only). Status is
 * the C1 vocabulary; `statusLegacy` keeps the stored value for diagnosis.
 * `triggerEvent` / `ruleSnapshot` are detail-only (omitted in the list view).
 */
export interface AutomationRunView {
  id: string
  ruleId: string
  sheetId: string | null
  status: WorkflowJobStatus
  statusLegacy: string
  triggeredBy: string
  triggeredAt: string
  finishedAt: string | null
  duration: number | null
  error: string | null
  schemaVersion: number | null
  steps: AutomationRunStepView[]
  triggerEvent?: unknown
  ruleSnapshot?: unknown
}

export interface AutomationStats {
  total: number
  success: number
  failed: number
  skipped: number
  /**
   * Average execution duration across all matching executions, in
   * milliseconds. Backend service alias `avg_duration` → `avgDuration`.
   * UI no longer reads a separate `avgDurationMs` alias.
   */
  avgDuration: number
}

// --- Charts ---
// S3: area / funnel / gauge are render-layer additions — the backend aggregates them through the
// same grouped {label,value} pipeline as bar/line/pie (no per-type aggregation math).
// r12: scatter is the one NON-grouped type — a per-record x/y projection (xValue/yValue per dataPoint),
// not a grouped aggregation. It uses x/y/color/sizeFieldId on the dataSource (ignores groupBy/aggregation).
export type ChartType = 'bar' | 'line' | 'pie' | 'number' | 'table' | 'area' | 'funnel' | 'gauge' | 'scatter'

export type AggregationFunction = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'count_distinct'

export interface ChartAggregation {
  function: AggregationFunction
  fieldId?: string
}

export interface ChartDataSource {
  sheetId: string
  groupByFieldId?: string
  // v2-d: split each groupBy category into bar series (grouped or stacked — see displayConfig.barMode).
  // Honored only for a bar chart with a primary groupByFieldId; stacked mode additionally requires an
  // additive aggregation (sum/count), grouped mode accepts any. Inert/rejected otherwise.
  seriesByFieldId?: string
  dateFieldId?: string
  dateGrouping?: 'day' | 'week' | 'month' | 'quarter' | 'year'
  aggregation: ChartAggregation
  // r12 scatter (discriminant — meaningful only when chartType === 'scatter'). x/y are both required
  // numeric fields; color sets the per-point category (label); size sets the per-point bubble size.
  // Scatter ignores groupByFieldId / aggregation / seriesByFieldId / dateFieldId.
  xFieldId?: string
  yFieldId?: string
  colorFieldId?: string
  sizeFieldId?: string
}

export interface ChartDisplayConfig {
  title?: string
  showLegend?: boolean
  showValues?: boolean
  colorScheme?: string
  prefix?: string
  suffix?: string
  orientation?: 'horizontal' | 'vertical'
  // v2-c single-series render variant: 'donut' (pie + inner radius) / 'area' (line + areaStyle).
  // Only honored for the matching chartType (pie/line); inert otherwise.
  variant?: 'donut' | 'area'
  // v2-d-b1: bar series layout when seriesByFieldId is set. 'stacked' (default) | 'grouped'
  // (side-by-side; allows non-additive aggregations). Inert unless seriesByFieldId is set on a bar chart.
  barMode?: 'stacked' | 'grouped'
}

export interface ChartConfig {
  id: string
  sheetId: string
  name: string
  chartType: ChartType
  dataSource: ChartDataSource
  displayConfig?: ChartDisplayConfig
  createdAt?: string
  updatedAt?: string
}

export interface ChartCreateInput {
  name: string
  chartType: ChartType
  dataSource: ChartDataSource
  displayConfig?: ChartDisplayConfig
}

export interface ChartDataPoint {
  label: string
  value: number
  color?: string
  // r12 scatter: a per-record point carries its own x/y (+ optional size). Optional so grouped types
  // stay unchanged; only scatter dataPoints populate them. `label` then holds the optional color category.
  xValue?: number
  yValue?: number
  size?: number
}

// v2-d: a bar series (grouped or stacked). `data` is dense + aligned positionally to ChartData.dataPoints.
export interface ChartSeries {
  name: string
  data: number[]
}

export interface ChartData {
  chartType: ChartType
  dataPoints: ChartDataPoint[]
  // v2-d: present for a bar chart with a series split (grouped or stacked); dataPoints/total are
  // unaffected by its presence (in non-additive grouped mode, Σ series ≠ dataPoints).
  series?: ChartSeries[]
  total?: number
  metadata?: Record<string, unknown>
}

// --- Dashboard ---
export interface DashboardPanel {
  id: string
  chartId: string
  size: 'small' | 'medium' | 'large'
  order: number
}

export interface Dashboard {
  id: string
  sheetId: string
  name: string
  panels: DashboardPanel[]
  createdAt?: string
  updatedAt?: string
}

export interface DashboardUpdateInput {
  name?: string
  panels?: DashboardPanel[]
}

// --- Form Share ---
export interface FormShareConfig {
  enabled: boolean
  publicToken: string | null
  expiresAt: string | null
  status: 'active' | 'expired' | 'disabled'
  accessMode: 'public' | 'dingtalk' | 'dingtalk_granted'
  allowedUserIds: string[]
  allowedUsers: MetaSheetPermissionCandidate[]
  allowedMemberGroupIds: string[]
  allowedMemberGroups: MetaSheetPermissionCandidate[]
}

export interface FormShareConfigUpdate {
  enabled?: boolean
  expiresAt?: string | null
  accessMode?: 'public' | 'dingtalk' | 'dingtalk_granted'
  allowedUserIds?: string[]
  allowedMemberGroupIds?: string[]
}

// --- API Tokens ---
export interface ApiToken {
  id: string
  name: string
  prefix: string
  scopes: string[]
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
}

export interface ApiTokenCreateResult {
  token: ApiToken
  plaintext: string
}

// --- Webhooks ---
export interface Webhook {
  id: string
  name: string
  url: string
  events: string[]
  active: boolean
  secret: string | null
  failureCount: number
  maxRetries?: number
  retryBaseDelayMs?: number
  retryMaxDelayMs?: number
  createdAt: string
  updatedAt: string
}

export interface WebhookCreateInput {
  name: string
  url: string
  events: string[]
  secret?: string
  active?: boolean
  maxRetries?: number
  retryBaseDelayMs?: number
  retryMaxDelayMs?: number
}

export interface WebhookDelivery {
  id: string
  webhookId: string
  event: string
  httpStatus: number | null
  success: boolean
  retryCount: number
  timestamp: string
}

// --- DingTalk Group Destinations ---
export interface DingTalkGroupDestination {
  id: string
  name: string
  webhookUrl: string
  secret?: string
  hasSecret?: boolean
  enabled: boolean
  scope?: 'private' | 'sheet' | 'org'
  sheetId?: string
  orgId?: string
  createdBy: string
  createdAt: string
  updatedAt?: string
  lastTestedAt?: string
  lastTestStatus?: 'success' | 'failed'
  lastTestError?: string
}

export interface DingTalkGroupDestinationInput {
  name: string
  webhookUrl: string
  secret?: string
  enabled?: boolean
  scope?: 'private' | 'sheet' | 'org'
  sheetId?: string
  orgId?: string
}

export interface DingTalkGroupDelivery {
  id: string
  destinationId: string
  destinationName?: string
  sourceType: 'manual_test' | 'automation'
  subject: string
  content: string
  success: boolean
  httpStatus?: number
  responseBody?: string
  errorMessage?: string
  automationRuleId?: string
  recordId?: string
  initiatedBy?: string
  createdAt: string
  deliveredAt?: string
}

export interface DingTalkPersonDelivery {
  id: string
  localUserId: string
  dingtalkUserId?: string
  sourceType: 'manual_test' | 'automation'
  subject: string
  content: string
  success: boolean
  status?: 'success' | 'failed' | 'skipped'
  httpStatus?: number
  responseBody?: string
  errorMessage?: string
  automationRuleId?: string
  recordId?: string
  initiatedBy?: string
  createdAt: string
  deliveredAt?: string
  localUserLabel?: string
  localUserSubtitle?: string
  localUserIsActive: boolean
}

// --- Field Validation ---
export type FieldValidationRuleType = 'required' | 'minLength' | 'maxLength' | 'pattern' | 'min' | 'max' | 'enum'

export interface FieldValidationRule {
  type: FieldValidationRuleType
  value?: string | number | string[]
  message?: string
}
