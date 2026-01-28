import type { ColumnType, Generated, JSONColumnType } from 'kysely'

/**
 * Timestamp type aliases for Kysely columns
 * - CreatedAt: Timestamp set on insert, not updatable
 * - UpdatedAt: Timestamp that can be updated
 * - NullableTimestamp: Optional timestamp that can be updated
 */
export type CreatedAt = ColumnType<Date, string | undefined, never>
export type UpdatedAt = ColumnType<Date, string | undefined, Date | string>
export type NullableTimestamp = ColumnType<Date, string | undefined, Date | string | null> | null
type JsonObjectColumn = JSONColumnType<Record<string, unknown> | null, Record<string, unknown> | null, Record<string, unknown> | null>

export interface Database {
  // Core tables
  users: UsersTable
  user_orgs: UserOrgsTable
  cells: CellsTable
  formulas: FormulasTable
  spreadsheets: SpreadsheetsTable
  sheets: SheetsTable
  cell_versions: CellVersionsTable
  named_ranges: NamedRangesTable
  tables: TablesTable
  // Data source tables
  data_sources: DataSourcesTable
  external_tables: ExternalTablesTable
  data_source_credentials: DataSourceCredentialsTable
  // System tables
  system_configs: SystemConfigsTable
  // Snapshot & Protection tables
  snapshots: SnapshotsTable
  snapshot_items: SnapshotItemsTable
  protection_rules: ProtectionRulesTable
  rule_execution_log: RuleExecutionLogTable
  views: ViewsTable
  view_states: ViewStatesTable
  table_rows: TableRowsTable
  snapshot_restore_log: SnapshotRestoreLogTable
  change_requests: ChangeRequestsTable
  change_approvals: ChangeApprovalsTable
  change_history: ChangeHistoryTable
  schema_snapshots: SchemaSnapshotsTable
  dead_letter_queue: DeadLetterQueueTable
  // Event tables
  event_subscriptions: EventSubscriptionsTable
  event_types: EventTypesTable
  event_replays: EventReplaysTable
  event_aggregates: EventAggregatesTable
  plugin_event_permissions: PluginEventPermissionsTable
  event_store: EventStoreTable
  event_deliveries: EventDeliveriesTable
  // BPMN tables
  bpmn_process_definitions: BpmnProcessDefinitionsTable
  bpmn_process_instances: BpmnProcessInstancesTable
  bpmn_activity_instances: BpmnActivityInstancesTable
  bpmn_user_tasks: BpmnUserTasksTable
  bpmn_message_events: BpmnMessageEventsTable
  bpmn_signal_events: BpmnSignalEventsTable
  bpmn_variables: BpmnVariablesTable
  bpmn_incidents: BpmnIncidentsTable
  bpmn_external_tasks: BpmnExternalTasksTable
  bpmn_timer_jobs: BpmnTimerJobsTable
  // Workflow tables
  workflow_definitions: WorkflowDefinitionsTable
  workflow_instances: WorkflowInstancesTable
  workflow_tokens: WorkflowTokensTable
  workflow_incidents: WorkflowIncidentsTable
  // Attendance tables
  attendance_events: AttendanceEventsTable
  attendance_records: AttendanceRecordsTable
  attendance_requests: AttendanceRequestsTable
  attendance_rules: AttendanceRulesTable
  attendance_shifts: AttendanceShiftsTable
  attendance_shift_assignments: AttendanceShiftAssignmentsTable
  attendance_holidays: AttendanceHolidaysTable
  attendance_leave_types: AttendanceLeaveTypesTable
  attendance_overtime_rules: AttendanceOvertimeRulesTable
  attendance_approval_flows: AttendanceApprovalFlowsTable
  attendance_rotation_rules: AttendanceRotationRulesTable
  attendance_rotation_assignments: AttendanceRotationAssignmentsTable
  attendance_rule_sets: AttendanceRuleSetsTable
  attendance_payroll_templates: AttendancePayrollTemplatesTable
  attendance_payroll_cycles: AttendancePayrollCyclesTable
  // Meta tables
  meta_sheets: MetaSheetsTable
  meta_fields: MetaFieldsTable
  meta_views: MetaViewsTable
  meta_records: MetaRecordsTable
  meta_links: MetaLinksTable
  meta_comments: MetaCommentsTable
  meta_dashboards: MetaDashboardsTable
  meta_widgets: MetaWidgetsTable
}

export interface SnapshotsTable {
  id: Generated<string>
  view_id: string
  name: string
  description: string | null
  version: number
  created_by: string
  snapshot_type: string
  metadata: JSONColumnType<Record<string, unknown>>
  is_locked: boolean
  parent_snapshot_id: string | null
  created_at: CreatedAt
  expires_at: NullableTimestamp
  tags: string[] | null
  protection_level: 'normal' | 'protected' | 'critical' | null
  release_channel: 'stable' | 'canary' | 'beta' | 'experimental' | null
  change_type: string | null
}

export interface SnapshotItemsTable {
  id: Generated<string>
  snapshot_id: string
  item_type: string
  item_id: string
  data: string // JSON string
  checksum: string | null
  created_at: CreatedAt
}

export interface ProtectionRulesTable {
  id: string
  rule_name: string
  description: string | null
  target_type: 'snapshot' | 'plugin' | 'schema' | 'workflow'
  conditions: JSONColumnType<Record<string, unknown> | null>
  effects: JSONColumnType<Record<string, unknown> | null>
  priority: number
  is_active: boolean
  version: number
  created_by: string
  created_at: CreatedAt
  updated_at: UpdatedAt
  last_evaluated_at: NullableTimestamp
  evaluation_count: number
}

export interface RuleExecutionLogTable {
  id: string
  rule_id: string
  rule_version: number
  entity_type: string
  entity_id: string
  operation: string
  matched: boolean
  effect_applied: JSONColumnType<Record<string, unknown> | null>
  execution_time_ms: number
  executed_at: CreatedAt
}

export interface ViewsTable {
  id: string
  table_id: string
  name: string
  type: 'grid' | 'kanban' | 'calendar' | 'gallery' | 'form' | 'gantt'
  config: JSONColumnType<Record<string, unknown> | null>
  filters: JSONColumnType<Record<string, unknown> | null>
  sort_order: number
  is_default: boolean
  created_by: string
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface ViewStatesTable {
  id: string
  view_id: string
  user_id: string
  state: JSONColumnType<Record<string, unknown> | null>
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface TableRowsTable {
  id: string
  table_id: string
  row_order: number
  data: JSONColumnType<Record<string, unknown> | null>
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface SnapshotRestoreLogTable {
  id: Generated<string>
  snapshot_id: string
  view_id: string
  restored_by: string
  restore_type: string
  items_restored: number
  status: string
  error_message: string | null
  metadata: JSONColumnType<Record<string, unknown>>
  created_at: CreatedAt
}

export interface ChangeRequestsTable {
  id: Generated<string>
  snapshot_id: string
  title: string
  description: string | null
  change_type: string
  target_environment: string
  status: string
  requested_by: string
  requested_at: CreatedAt
  approvers: string[]
  required_approvals: number
  current_approvals: number
  deployed_at: NullableTimestamp
  deployed_by: string | null
  rolled_back_at: NullableTimestamp
  rolled_back_by: string | null
  rollback_reason: string | null
  auto_generated_notes: string | null
  risk_score: number
  impact_assessment: JSONColumnType<Record<string, unknown>>
  metadata: JSONColumnType<Record<string, unknown>>
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface ChangeApprovalsTable {
  id: Generated<string>
  change_request_id: string
  approver_id: string
  decision: string
  comment: string | null
  approved_at: CreatedAt
}

export interface ChangeHistoryTable {
  id: Generated<string>
  entity_type: string
  entity_id: string
  action: string
  actor_id: string
  change_request_id: string | null
  before_state: JSONColumnType<Record<string, unknown> | null>
  after_state: JSONColumnType<Record<string, unknown> | null>
  diff_summary: string | null
  timestamp: CreatedAt
}

export interface SchemaSnapshotsTable {
  id: Generated<string>
  view_id: string
  schema_version: string
  schema_definition: JSONColumnType<Record<string, unknown> | null>
  validation_rules: JSONColumnType<Record<string, unknown> | null>
  migration_script: string | null
  rollback_script: string | null
  is_current: boolean
  created_by: string
  created_at: CreatedAt
}

export interface DeadLetterQueueTable {
  id: Generated<string>
  topic: string
  payload: JSONColumnType<Record<string, unknown> | null>
  error_message: string | null
  retry_count: number
  last_retry_at: NullableTimestamp
  status: 'pending' | 'retrying' | 'resolved' | 'ignored'
  metadata: JSONColumnType<Record<string, unknown> | null>
  created_at: CreatedAt
}

// Event Bus Tables
export interface EventSubscriptionsTable {
  id: Generated<string>
  subscriber_id: string
  subscriber_type: string
  event_pattern: string
  event_types: string[] | null
  filter_expression: string | null
  handler_type: string
  handler_config: string
  priority: number
  is_sequential: boolean
  timeout_ms: number
  transform_enabled: boolean
  transform_template: string | null
  is_active: boolean
  is_paused: boolean
  total_events_processed: number
  total_events_failed: number
  last_event_at: NullableTimestamp
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface EventTypesTable {
  id: Generated<string>
  event_name: string
  category: string
  payload_schema: string | null
  metadata_schema: string | null
  is_async: boolean
  is_persistent: boolean
  is_transactional: boolean
  max_retries: number
  retry_delay_ms: number
  ttl_seconds: number | null
  is_active: boolean
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface EventReplaysTable {
  id: Generated<string>
  replay_type: string
  event_ids: string[] | null
  event_pattern: string | null
  time_range_start: NullableTimestamp
  time_range_end: NullableTimestamp
  subscription_ids: string[] | null
  status: string
  initiated_by: string
  reason: string
  started_at: NullableTimestamp
  completed_at: NullableTimestamp
  created_at: CreatedAt
}

export interface EventAggregatesTable {
  id: Generated<string>
  event_name: string
  window_start: CreatedAt
  window_end: CreatedAt
  count: number
  avg_processing_time: number | null
  error_count: number
  created_at: CreatedAt
}

export interface PluginEventPermissionsTable {
  id: Generated<string>
  plugin_id: string
  can_emit: string[] | null
  can_subscribe: string[] | null
  max_events_per_minute: number
  max_subscriptions: number
  max_event_size_kb: number
  events_emitted_today: number
  events_received_today: number
  quota_reset_at: NullableTimestamp
  is_active: boolean
  is_suspended: boolean
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface EventStoreTable {
  id: Generated<string>
  event_id: string
  event_name: string
  event_version: string
  source_id: string
  source_type: string
  correlation_id: string | null
  causation_id: string | null
  payload: string
  metadata: string
  occurred_at: CreatedAt
  received_at: CreatedAt
  processed_at: NullableTimestamp
  status: string
  expires_at: NullableTimestamp
}

export interface EventDeliveriesTable {
  id: Generated<string>
  event_id: string
  subscription_id: string
  started_at: CreatedAt
  completed_at: UpdatedAt
  duration_ms: number
  success: boolean
  error_message: string | null
}

// BPMN Tables
export interface BpmnProcessDefinitionsTable {
  id: Generated<string>
  key: string
  name: string
  version: number
  bpmn_xml: string
  deployment_id: string | null
  is_active: boolean
  category: string | null
  tenant_id: string | null
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface BpmnProcessInstancesTable {
  id: Generated<string>
  process_definition_id: string
  process_definition_key: string
  business_key: string | null
  parent_process_instance_id: string | null
  state: string
  start_time: CreatedAt
  end_time: NullableTimestamp
  variables: JSONColumnType<Record<string, unknown>>
  tenant_id: string | null
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface BpmnActivityInstancesTable {
  id: Generated<string>
  process_instance_id: string
  activity_id: string
  activity_type: string
  state: string
  start_time: CreatedAt
  end_time: NullableTimestamp
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface BpmnUserTasksTable {
  id: Generated<string>
  process_instance_id: string
  activity_instance_id: string
  task_definition_key: string
  name: string | null
  assignee: string | null
  candidate_groups: string[] | null
  candidate_users: string[] | null
  due_date: NullableTimestamp
  follow_up_date: NullableTimestamp
  priority: number | null
  state: string
  variables: JSONColumnType<Record<string, unknown>>
  form_data: JSONColumnType<Record<string, unknown> | null, string | null, string | null>
  created_at: CreatedAt
  claimed_at: NullableTimestamp
  completed_at: NullableTimestamp
}

export interface BpmnMessageEventsTable {
  id: Generated<string>
  message_name: string
  correlation_key: string | null
  process_instance_id: string | null
  payload: JSONColumnType<Record<string, unknown>> | null
  status: string
  created_at: CreatedAt
}

export interface BpmnSignalEventsTable {
  id: Generated<string>
  signal_name: string
  process_instance_id: string | null
  payload: JSONColumnType<Record<string, unknown>> | null
  status: string
  created_at: CreatedAt
}

export interface BpmnVariablesTable {
  id: Generated<string>
  process_instance_id: string
  name: string
  value: JSONColumnType<Record<string, unknown> | null>
  type: string
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface BpmnIncidentsTable {
  id: Generated<string>
  process_instance_id: string
  activity_instance_id: string | null
  incident_type: string
  message: string
  stack_trace: string | null
  state: string
  created_at: CreatedAt
  resolved_at: NullableTimestamp
}

export interface BpmnExternalTasksTable {
  id: Generated<string>
  process_instance_id: string
  activity_instance_id: string
  topic_name: string
  worker_id: string | null
  lock_expiration_time: NullableTimestamp
  retries: number | null
  error_message: string | null
  state: string
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface BpmnTimerJobsTable {
  id: Generated<string>
  process_instance_id: string
  activity_instance_id: string | null
  timer_type: string
  due_date: UpdatedAt
  repeat_count: number | null
  repeat_interval: string | null
  state: string
  created_at: CreatedAt
  updated_at: UpdatedAt
}

// Workflow Tables
export interface WorkflowDefinitionsTable {
  id: Generated<string>
  name: string
  description: string | null
  version: number
  definition: JSONColumnType<Record<string, unknown> | null>
  is_active: boolean
  status: string
  created_by: string
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface WorkflowInstancesTable {
  id: Generated<string>
  workflow_definition_id: string
  definition_id: string
  status: string
  current_step: string | null
  variables: JSONColumnType<Record<string, unknown>>
  started_by: string
  started_at: CreatedAt
  completed_at: NullableTimestamp
  updated_at: UpdatedAt
  created_at: CreatedAt
  error_message: string | null
  error: string | null
}

export interface WorkflowTokensTable {
  id: Generated<string>
  workflow_instance_id: string
  instance_id: string
  node_id: string
  state: string
  status: string
  token_type: string
  parent_token_id: string | null
  variables: string | null
  consumed_at: NullableTimestamp
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface WorkflowIncidentsTable {
  id: Generated<string>
  workflow_instance_id: string
  instance_id: string
  token_id: string | null
  incident_type: string
  severity: string
  node_id: string | null
  error_code: string | null
  error_message: string | null
  type: string
  message: string
  stack_trace: string | null
  incident_data: JSONColumnType<Record<string, unknown> | null>
  resolution_status: string
  status: string
  resolved_by: string | null
  resolution_notes: string | null
  retry_count: number
  max_retries: number
  created_at: CreatedAt
  updated_at: UpdatedAt
  resolved_at: NullableTimestamp
}

// Meta Tables
export interface MetaSheetsTable {
  id: Generated<string>
  name: string
  description: string | null
  created_at: CreatedAt
  updated_at: UpdatedAt
  deleted_at: NullableTimestamp
}

export interface MetaFieldsTable {
  id: Generated<string>
  sheet_id: string
  name: string
  type: string
  property: JSONColumnType<Record<string, unknown> | null>
  order: number
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface MetaViewsTable {
  id: Generated<string>
  sheet_id: string
  name: string
  type: string
  filter_info: JSONColumnType<Record<string, unknown> | null>
  sort_info: JSONColumnType<Record<string, unknown> | null>
  group_info: JSONColumnType<Record<string, unknown> | null>
  hidden_field_ids: JSONColumnType<string[]>
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface MetaRecordsTable {
  id: Generated<string>
  sheet_id: string
  data: JSONColumnType<Record<string, unknown>>
  version: number
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface MetaLinksTable {
  id: Generated<string>
  field_id: string
  record_id: string
  foreign_record_id: string
  created_at: CreatedAt
}

export interface MetaCommentsTable {
  id: Generated<string>
  spreadsheet_id: string
  row_id: string
  field_id: string | null
  content: string
  author_id: string
  parent_id: string | null
  resolved: boolean
  mentions: JSONColumnType<string[]>
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface MetaDashboardsTable {
  id: Generated<string>
  name: string
  owner_id: string
  description: string | null
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface MetaWidgetsTable {
  id: Generated<string>
  dashboard_id: string
  type: string
  title: string | null
  config: JSONColumnType<Record<string, unknown> | null>
  created_at: CreatedAt
  updated_at: UpdatedAt
}

// ============================================
// Core Tables (added for type safety)
// ============================================

export interface UsersTable {
  id: Generated<string>
  email: string
  name: string | null
  password_hash: string
  role: string
  permissions: JSONColumnType<string[]>
  avatar_url: string | null
  is_active: boolean
  is_admin: boolean
  last_login_at: NullableTimestamp
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface UserOrgsTable {
  user_id: string
  org_id: string
  is_active: boolean
  created_at: CreatedAt
}

export interface TablesTable {
  id: Generated<string>
  name: string
  description: string | null
  owner_id: string | null
  workspace_id: string | null
  is_archived: boolean
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface SpreadsheetsTable {
  id: string
  name: string
  owner_id: string | null
  deleted_at: NullableTimestamp
  created_at: CreatedAt
  updated_at: UpdatedAt
  description?: string | null
  workspace_id?: string | null
  is_template?: boolean | null
  template_id?: string | null
  settings?: JSONColumnType<Record<string, unknown> | null>
  metadata?: JSONColumnType<Record<string, unknown> | null>
  created_by?: string | null
}

export interface SheetsTable {
  id: string
  spreadsheet_id: string
  name: string
  order_index: number
  row_count: number
  column_count: number
  frozen_rows?: number
  frozen_columns?: number
  hidden_rows?: JSONColumnType<number[] | null>
  hidden_columns?: JSONColumnType<number[] | null>
  row_heights?: JSONColumnType<Record<string, number> | null>
  column_widths?: JSONColumnType<Record<string, number> | null>
  config?: JSONColumnType<Record<string, unknown> | null>
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface CellsTable {
  id: Generated<string>
  sheet_id: string
  row_index: number
  column_index: number
  value: JsonObjectColumn
  data_type: string | null
  formula: string | null
  computed_value: JsonObjectColumn | null
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface FormulasTable {
  id: Generated<string>
  sheet_id: string
  cell_id: string
  expression: string
  parsed_ast: JSONColumnType<Record<string, unknown> | null>
  dependencies: string[] | null
  dependents: string[] | null
  is_valid: boolean
  error_message: string | null
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface CellVersionsTable {
  id: Generated<string>
  cell_id: string
  sheet_id: string
  version_number: number
  value: JsonObjectColumn | null
  formula: string | null
  format: JsonObjectColumn | null
  changed_by: string | null
  change_type: string | null
  change_summary: string | null
  created_at: CreatedAt
}

export interface NamedRangesTable {
  id: string
  spreadsheet_id: string
  sheet_id: string | null
  name: string
  range: string
  description: string | null
  created_by: string | null
  created_at: CreatedAt
}

// ============================================
// Data Source Tables
// ============================================

export interface DataSourcesTable {
  id: Generated<string>
  name: string
  type: string
  config: JSONColumnType<Record<string, unknown>>
  is_active: boolean
  last_sync_at: NullableTimestamp
  created_by: string
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface ExternalTablesTable {
  id: Generated<string>
  data_source_id: string
  external_name: string
  local_table_id: string | null
  schema_definition: JSONColumnType<Record<string, unknown> | null>
  sync_config: JSONColumnType<Record<string, unknown> | null>
  last_sync_at: NullableTimestamp
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface DataSourceCredentialsTable {
  id: Generated<string>
  data_source_id: string
  credential_type: string
  encrypted_value: string
  created_at: CreatedAt
  updated_at: UpdatedAt
}

// ============================================
// System Tables
// ============================================

export interface SystemConfigsTable {
  id: Generated<string>
  key: string
  value: string
  is_encrypted: boolean
  description: string | null
  created_at: CreatedAt
  updated_at: UpdatedAt
}

// ============================================
// Attendance Tables
// ============================================

export interface AttendanceEventsTable {
  id: Generated<string>
  user_id: string
  org_id: string
  work_date: ColumnType<string, string | undefined, string>
  occurred_at: UpdatedAt
  event_type: 'check_in' | 'check_out' | 'adjustment'
  source: string
  timezone: string
  location: JSONColumnType<Record<string, unknown> | null>
  meta: JSONColumnType<Record<string, unknown> | null>
  created_at: CreatedAt
}

export interface AttendanceRecordsTable {
  id: Generated<string>
  user_id: string
  org_id: string
  work_date: ColumnType<string, string | undefined, string>
  timezone: string
  first_in_at: NullableTimestamp
  last_out_at: NullableTimestamp
  work_minutes: number
  late_minutes: number
  early_leave_minutes: number
  status: 'normal' | 'late' | 'early_leave' | 'late_early' | 'partial' | 'absent' | 'adjusted' | 'off'
  is_workday: boolean
  meta: JSONColumnType<Record<string, unknown> | null>
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface AttendanceRequestsTable {
  id: Generated<string>
  user_id: string
  org_id: string
  work_date: ColumnType<string, string | undefined, string>
  request_type: 'missed_check_in' | 'missed_check_out' | 'time_correction' | 'leave' | 'overtime'
  requested_in_at: NullableTimestamp
  requested_out_at: NullableTimestamp
  reason: string | null
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  approval_instance_id: string | null
  resolved_by: string | null
  resolved_at: NullableTimestamp
  metadata: JSONColumnType<Record<string, unknown> | null>
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface AttendanceRulesTable {
  id: Generated<string>
  org_id: string
  name: string
  timezone: string
  work_start_time: string
  work_end_time: string
  late_grace_minutes: number
  early_grace_minutes: number
  rounding_minutes: number
  working_days: JSONColumnType<number[] | null>
  is_default: boolean
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface AttendanceShiftsTable {
  id: Generated<string>
  org_id: string
  name: string
  timezone: string
  work_start_time: string
  work_end_time: string
  late_grace_minutes: number
  early_grace_minutes: number
  rounding_minutes: number
  working_days: JSONColumnType<number[] | null>
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface AttendanceShiftAssignmentsTable {
  id: Generated<string>
  org_id: string
  user_id: string
  shift_id: string
  start_date: ColumnType<string, string | undefined, string>
  end_date: ColumnType<string | null, string | undefined, string | null>
  is_active: boolean
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface AttendanceHolidaysTable {
  id: Generated<string>
  org_id: string
  holiday_date: ColumnType<string, string | undefined, string>
  name: string | null
  is_working_day: boolean
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface AttendanceLeaveTypesTable {
  id: Generated<string>
  org_id: string
  code: string
  name: string
  requires_approval: boolean
  requires_attachment: boolean
  default_minutes_per_day: number
  is_active: boolean
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface AttendanceOvertimeRulesTable {
  id: Generated<string>
  org_id: string
  name: string
  min_minutes: number
  rounding_minutes: number
  max_minutes_per_day: number
  requires_approval: boolean
  is_active: boolean
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface AttendanceApprovalFlowsTable {
  id: Generated<string>
  org_id: string
  name: string
  request_type: string
  steps: JSONColumnType<Array<Record<string, unknown>> | null>
  is_active: boolean
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface AttendanceRotationRulesTable {
  id: Generated<string>
  org_id: string
  name: string
  timezone: string
  shift_sequence: JSONColumnType<string[] | null>
  is_active: boolean
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface AttendanceRotationAssignmentsTable {
  id: Generated<string>
  org_id: string
  user_id: string
  rotation_rule_id: string
  start_date: ColumnType<string, string | undefined, string>
  end_date: ColumnType<string | null, string | undefined, string | null>
  is_active: boolean
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface AttendanceRuleSetsTable {
  id: Generated<string>
  org_id: string
  name: string
  description: string | null
  version: number
  scope: string
  config: JsonObjectColumn
  is_default: boolean
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface AttendancePayrollTemplatesTable {
  id: Generated<string>
  org_id: string
  name: string
  timezone: string
  start_day: number
  end_day: number
  end_month_offset: number
  auto_generate: boolean
  config: JsonObjectColumn
  is_default: boolean
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface AttendancePayrollCyclesTable {
  id: Generated<string>
  org_id: string
  template_id: string | null
  name: string | null
  start_date: ColumnType<string, string | undefined, string>
  end_date: ColumnType<string, string | undefined, string>
  status: 'open' | 'closed' | 'archived'
  metadata: JsonObjectColumn
  created_at: CreatedAt
  updated_at: UpdatedAt
}
