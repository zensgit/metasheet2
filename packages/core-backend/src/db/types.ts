/**
 * Complete Kysely Database Type Definitions
 * Includes all core tables for MetaSheet V2
 */

import type { ColumnType, Generated, JSONColumnType } from 'kysely'

// Helper types for common patterns
type UUID = string
type Timestamp = ColumnType<Date, Date | string, Date | string>
type Json = JSONColumnType<any>

// ============================================
// WORKFLOW ENGINE TABLES
// ============================================

export interface WorkflowDefinitionsTable {
  id: Generated<UUID>
  name: string
  version: string
  type: 'BPMN' | 'DAG' | 'STATE_MACHINE'
  definition: Json
  status: 'DRAFT' | 'ACTIVE' | 'DEPRECATED'
  variables_schema: Json | null
  settings: Json
  created_by: UUID | null
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

export interface WorkflowInstancesTable {
  id: Generated<UUID>
  definition_id: UUID
  parent_instance_id: UUID | null
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'SUSPENDED'
  variables: Json
  context: Json
  error: string | null
  started_at: Timestamp | null
  completed_at: Timestamp | null
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

export interface WorkflowTokensTable {
  id: Generated<UUID>
  instance_id: UUID
  node_id: string
  token_type: 'EXECUTION' | 'WAIT' | 'COMPENSATE'
  status: 'ACTIVE' | 'CONSUMED' | 'CANCELLED'
  parent_token_id: UUID | null
  variables: Json
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
  consumed_at: Timestamp | null
}

export interface WorkflowIncidentsTable {
  id: Generated<UUID>
  instance_id: UUID
  token_id: UUID | null
  incident_type: 'ERROR' | 'TIMEOUT' | 'COMPENSATION_FAILED' | 'VALIDATION_ERROR' | 'SYSTEM_ERROR'
  severity: 'WARNING' | 'ERROR' | 'CRITICAL'
  node_id: string | null
  error_code: string | null
  error_message: string | null
  stack_trace: string | null
  incident_data: Json
  resolution_status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'IGNORED'
  resolved_by: UUID | null
  resolved_at: Timestamp | null
  resolution_notes: string | null
  retry_count: number
  max_retries: number
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

// ============================================
// UNIFIED DATA MODEL TABLES
// ============================================

export interface TablesTable {
  id: Generated<UUID>
  workspace_id: UUID
  name: string
  display_name: string | null
  description: string | null
  icon: string | null
  color: string | null
  table_type: 'STANDARD' | 'EXTERNAL' | 'MATERIALIZED' | 'VIRTUAL'
  source_config: Json
  fields: Json
  primary_key: string
  indexes: Json
  row_count: bigint
  storage_size: bigint
  last_modified: Timestamp
  features: Json
  created_by: UUID | null
  created_at: Generated<Timestamp>
  updated_by: UUID | null
  updated_at: Generated<Timestamp>
  deleted_at: Timestamp | null
}

export interface ViewsTable {
  id: Generated<UUID>
  table_id: UUID | null
  type: 'grid' | 'kanban' | 'gantt' | 'form' | 'calendar' | 'gallery'
  name: string
  config: Json
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

export interface ViewStatesTable {
  id: Generated<UUID>
  view_id: UUID
  user_id: UUID
  state_data: Json
  filters: Json
  sorts: Json
  hidden_fields: Json
  field_widths: Json
  row_height: 'small' | 'medium' | 'large'
  view_settings: Json
  cursor_position: Json | null
  scroll_position: Json | null
  version: number
  is_default: boolean
  is_shared: boolean
  shared_with: Json
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
  last_accessed: Timestamp
}

// ============================================
// USER & AUTH TABLES
// ============================================

export interface UsersTable {
  id: Generated<UUID>
  username: string
  email: string | null
  password_hash: string | null
  full_name: string | null
  avatar_url: string | null
  status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED'
  settings: Json
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
  deleted_at: Timestamp | null
}

export interface RolesTable {
  id: Generated<UUID>
  name: string
  display_name: string | null
  description: string | null
  permissions: Json
  is_system: boolean
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

export interface UserRolesTable {
  id: Generated<UUID>
  user_id: UUID
  role_id: UUID
  granted_by: UUID | null
  granted_at: Generated<Timestamp>
}

// ============================================
// SPREADSHEET TABLES
// ============================================

export interface SpreadsheetsTable {
  id: Generated<UUID>
  name: string
  description: string | null
  owner_id: UUID | null
  workspace_id: UUID | null
  is_template: boolean
  template_id: UUID | null
  settings: Json
  metadata: Json
  created_by: UUID | null
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
  deleted_at: Timestamp | null
}

export interface SheetsTable {
  id: Generated<UUID>
  spreadsheet_id: UUID
  name: string
  order_index: number
  row_count: number
  column_count: number
  frozen_rows: number
  frozen_columns: number
  hidden_rows: Json
  hidden_columns: Json
  row_heights: Json
  column_widths: Json
  config: Json
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

export interface CellsTable {
  id: Generated<UUID>
  sheet_id: UUID
  row_index: number
  column_index: number
  cell_ref: string
  value: string | null
  display_value: string | null
  data_type: string
  formula: string | null
  formula_result: Json | null
  format: Json
  validation: Json
  metadata: Json
  locked: boolean
  comment: string | null
  updated_by: UUID | null
  updated_at: Generated<Timestamp>
}

// ============================================
// EXTERNAL DATA SOURCE TABLES
// ============================================

export interface DataSourcesTable {
  id: Generated<UUID>
  name: string
  type: 'POSTGRES' | 'MYSQL' | 'MONGODB' | 'HTTP' | 'REDIS' | 'ELASTICSEARCH' | 'S3'
  connection_config: Json
  status: 'ACTIVE' | 'INACTIVE' | 'ERROR'
  last_connected: Timestamp | null
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

export interface DataSourceCredentialsTable {
  id: Generated<UUID>
  data_source_id: UUID
  credential_type: 'PASSWORD' | 'API_KEY' | 'OAUTH' | 'CERTIFICATE' | 'SSH_KEY' | 'BEARER_TOKEN'
  encrypted_value: string
  encryption_key_id: string
  oauth_provider: string | null
  oauth_scopes: Json
  refresh_token: string | null
  token_expiry: Timestamp | null
  cert_fingerprint: string | null
  cert_expiry: Timestamp | null
  created_by: UUID | null
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
  last_used: Timestamp | null
  expires_at: Timestamp | null
}

export interface ExternalTablesTable {
  id: Generated<UUID>
  table_id: UUID | null
  data_source_id: UUID
  external_schema: string | null
  external_table: string
  external_primary_key: string | null
  sync_mode: 'LAZY' | 'EAGER' | 'SCHEDULED' | 'REALTIME'
  sync_interval: number | null
  last_sync: Timestamp | null
  next_sync: Timestamp | null
  field_mappings: Json
  transform_rules: Json
  query_hints: Json
  cache_ttl: number
  max_cache_size: bigint
  total_rows: bigint | null
  sync_duration_ms: bigint | null
  error_count: number
  last_error: string | null
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

// ============================================
// PLUGIN SYSTEM TABLES
// ============================================

export interface PluginsTable {
  id: Generated<UUID>
  name: string
  display_name: string | null
  type: 'VIEW' | 'WORKFLOW' | 'DATA_SOURCE' | 'SCRIPT' | 'INTEGRATION'
  status: 'INSTALLED' | 'ACTIVE' | 'INACTIVE' | 'ERROR'
  version: string
  config: Json
  capabilities: Json
  metadata: Json
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

export interface PluginManifestsTable {
  id: Generated<UUID>
  plugin_id: UUID
  version: string
  name: string
  display_name: string | null
  description: string | null
  author: Json
  homepage: string | null
  repository: string | null
  entry_point: string
  engine_version: string
  dependencies: Json
  peer_dependencies: Json
  capabilities: Json
  required_permissions: Json
  migrations: Json
  routes: Json
  hooks: Json
  views: Json
  commands: Json
  config_schema: Json
  default_config: Json
  install_script: string | null
  uninstall_script: string | null
  upgrade_script: string | null
  published_at: Timestamp | null
  checksum: string | null
  signature: string | null
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

export interface PluginDependenciesTable {
  id: Generated<UUID>
  plugin_id: UUID
  depends_on_id: UUID
  version_constraint: string | null
  dependency_type: 'RUNTIME' | 'PEER' | 'OPTIONAL' | 'DEV'
  created_at: Generated<Timestamp>
}

// ============================================
// SCRIPT EXECUTION TABLES
// ============================================

export interface ScriptExecutionsTable {
  id: Generated<UUID>
  script_id: UUID | null
  script_type: 'INLINE' | 'STORED' | 'PLUGIN' | 'WORKFLOW'
  script_language: 'JAVASCRIPT' | 'PYTHON' | 'SQL' | 'TYPESCRIPT'
  context_type: string | null
  context_id: UUID | null
  user_id: UUID | null
  script_content: string | null
  script_hash: string | null
  status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'ERROR' | 'TIMEOUT' | 'CANCELLED'
  started_at: Timestamp | null
  completed_at: Timestamp | null
  duration_ms: bigint | null
  cpu_time_ms: bigint | null
  memory_peak_mb: number | null
  io_reads: bigint | null
  io_writes: bigint | null
  result: Json | null
  error_message: string | null
  stack_trace: string | null
  logs: string[] | null
  sandbox_id: string | null
  sandbox_version: string | null
  security_context: Json
  created_at: Generated<Timestamp>
}

// ============================================
// TEMPLATE SYSTEM TABLES
// ============================================

export interface TemplatesTable {
  id: Generated<UUID>
  name: string
  slug: string
  category: string
  subcategory: string | null
  description: string | null
  preview_url: string | null
  thumbnail_url: string | null
  template_type: 'TABLE' | 'WORKFLOW' | 'VIEW' | 'APP' | 'PLUGIN' | 'DASHBOARD'
  template_data: Json
  tags: string[] | null
  features: string[] | null
  industries: string[] | null
  use_cases: string[] | null
  install_count: number
  rating_avg: number | null
  rating_count: number
  author_id: UUID | null
  is_official: boolean
  is_featured: boolean
  published_at: Timestamp | null
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

// ============================================
// AUDIT & MONITORING TABLES
// ============================================

export interface AuditLogsTable {
  id: Generated<UUID>
  entity_type: string
  entity_id: string | null
  action: string
  user_id: UUID | null
  details: Json
  ip_address: string | null
  user_agent: string | null
  created_at: Generated<Timestamp>
}

export interface AuditSignaturesTable {
  id: Generated<UUID>
  audit_log_id: UUID
  signature_type: 'HMAC' | 'RSA' | 'ECDSA' | 'ED25519'
  signature_value: string
  signing_key_id: string
  previous_signature_id: UUID | null
  chain_hash: string | null
  verified_at: Timestamp | null
  verified_by: string | null
  verification_status: string | null
  created_at: Generated<Timestamp>
}

export interface QueryCacheTable {
  id: Generated<UUID>
  query_hash: string
  query_type: 'VIEW' | 'AGGREGATION' | 'REPORT'
  table_id: UUID | null
  view_id: UUID | null
  user_id: UUID | null
  params_hash: string | null
  result_data: Json
  result_count: number | null
  created_at: Generated<Timestamp>
  expires_at: Timestamp
  invalidated_at: Timestamp | null
  hit_count: number
  last_accessed: Timestamp | null
  size_bytes: bigint | null
}

// ============================================
// SNAPSHOT SYSTEM TABLES
// ============================================

export interface SnapshotsTable {
  id: Generated<UUID>
  view_id: UUID
  name: string
  description: string | null
  version: number
  created_by: UUID
  snapshot_type: 'manual' | 'auto' | 'pre_migration'
  metadata: Json
  is_locked: boolean
  parent_snapshot_id: UUID | null
  created_at: Generated<Timestamp>
  expires_at: Timestamp | null
  // Sprint 2: Snapshot Protection
  tags: string[]
  protection_level: 'normal' | 'protected' | 'critical'
  release_channel: 'stable' | 'canary' | 'beta' | 'experimental' | null
}

export interface SnapshotItemsTable {
  id: Generated<UUID>
  snapshot_id: UUID
  item_type: string
  item_id: UUID
  data: Json
  checksum: string | null
  created_at: Generated<Timestamp>
}

export interface SnapshotRestoreLogTable {
  id: Generated<UUID>
  snapshot_id: UUID
  view_id: UUID
  restored_by: UUID
  restore_type: 'full' | 'partial' | 'selective'
  items_restored: number
  status: 'success' | 'failed' | 'partial'
  error_message: string | null
  metadata: Json
  created_at: Generated<Timestamp>
}

export interface ProtectionRulesTable {
  id: Generated<UUID>
  rule_name: string
  description: string | null
  target_type: 'snapshot' | 'plugin' | 'schema' | 'workflow'
  conditions: Json
  effects: Json
  priority: number
  is_active: boolean
  version: number
  created_by: UUID
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
  last_evaluated_at: Timestamp | null
  evaluation_count: number
}

export interface RuleExecutionLogTable {
  id: Generated<UUID>
  rule_id: UUID
  rule_version: number
  entity_type: string
  entity_id: UUID
  operation: string
  matched: boolean
  effect_applied: Json | null
  execution_time_ms: number | null
  executed_at: Generated<Timestamp>
}

// ============================================
// APPROVAL SYSTEM TABLES
// ============================================

export interface ApprovalInstancesTable {
  id: Generated<UUID>
  approval_id: string
  form_id: string | null
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'
  form_data: Json
  current_step: number
  total_steps: number
  created_by: UUID | null
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
  completed_at: Timestamp | null
}

export interface ApprovalRecordsTable {
  id: Generated<UUID>
  instance_id: UUID
  step_number: number
  approver_id: UUID
  action: 'APPROVED' | 'REJECTED' | 'RETURNED'
  comments: string | null
  signature: string | null
  approved_at: Timestamp | null
  created_at: Generated<Timestamp>
}

// ============================================
// OTHER EXISTING TABLES
// ============================================

export interface FormulasTable {
  id: Generated<UUID>
  cell_id: UUID
  sheet_id: UUID
  formula_text: string
  parsed_ast: Json
  dependencies: Json
  dependents: Json
  calculation_order: number | null
  is_volatile: boolean
  last_calculated_at: Timestamp | null
  error_message: string | null
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

export interface CellVersionsTable {
  id: Generated<UUID>
  cell_id: UUID
  sheet_id: UUID
  version_number: number
  value: string | null
  formula: string | null
  format: Json
  changed_by: UUID | null
  change_type: string | null
  change_summary: string | null
  created_at: Generated<Timestamp>
}

export interface NamedRangesTable {
  id: Generated<UUID>
  spreadsheet_id: UUID
  sheet_id: UUID | null
  name: string
  range: string
  description: string | null
  created_by: UUID | null
  created_at: Generated<Timestamp>
}

export interface FilesTable {
  id: Generated<UUID>
  filename: string
  original_name: string
  mime_type: string
  size: bigint
  storage_path: string
  entity_type: string | null
  entity_id: UUID | null
  uploaded_by: UUID | null
  metadata: Json
  created_at: Generated<Timestamp>
}

export interface SpreadsheetPermissionsTable {
  id: Generated<UUID>
  spreadsheet_id: UUID
  user_id: UUID | null
  role_id: UUID | null
  permission_type: 'VIEW' | 'EDIT' | 'ADMIN'
  granted_by: UUID | null
  granted_at: Generated<Timestamp>
}

export interface PluginKVTable {
  id: Generated<UUID>
  plugin_id: string
  key: string
  value: Json
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
  expires_at: Timestamp | null
  metadata: Json
}

// ============================================
// BPMN WORKFLOW ENGINE TABLES (Phase 2)
// ============================================

export interface BpmnProcessDefinitionsTable {
  id: Generated<UUID>
  key: string
  name: string
  description: string | null
  version: number
  bpmn_xml: string
  diagram_json: Json | null
  category: string | null
  tenant_id: string | null
  deployment_id: string | null
  resource_name: string | null
  has_start_form: boolean
  is_suspended: boolean
  is_executable: boolean
  created_by: string
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

export interface BpmnProcessInstancesTable {
  id: Generated<UUID>
  process_definition_id: string
  process_definition_key: string
  business_key: string | null
  name: string | null
  parent_id: string | null
  super_execution_id: string | null
  root_process_instance_id: string | null
  state: 'ACTIVE' | 'SUSPENDED' | 'COMPLETED' | 'EXTERNALLY_TERMINATED' | 'INTERNALLY_TERMINATED'
  suspension_state: number
  variables: Json
  start_time: Generated<Timestamp>
  end_time: Timestamp | null
  duration_ms: bigint | null
  start_user_id: string | null
  tenant_id: string | null
}

export interface BpmnActivityInstancesTable {
  id: Generated<UUID>
  process_instance_id: string
  process_definition_id: string
  activity_id: string
  activity_name: string | null
  activity_type: string
  execution_id: string | null
  task_id: string | null
  state: 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'FAILED'
  start_time: Generated<Timestamp>
  end_time: Timestamp | null
  duration_ms: bigint | null
  loop_counter: number
  nr_of_instances: number | null
  nr_of_completed_instances: number
  nr_of_active_instances: number
  incident_id: string | null
  incident_message: string | null
}

export interface BpmnUserTasksTable {
  id: Generated<UUID>
  process_instance_id: string
  process_definition_id: string
  activity_instance_id: string | null
  task_definition_key: string
  name: string
  description: string | null
  assignee: string | null
  owner: string | null
  candidate_users: string[] | null
  candidate_groups: string[] | null
  priority: number
  due_date: Timestamp | null
  follow_up_date: Timestamp | null
  form_key: string | null
  form_data: Json | null
  state: 'CREATED' | 'READY' | 'RESERVED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'SUSPENDED'
  suspension_state: number
  delegation_state: 'PENDING' | 'RESOLVED' | null
  created_at: Generated<Timestamp>
  claimed_at: Timestamp | null
  completed_at: Timestamp | null
  variables: Json
}

export interface BpmnTimerJobsTable {
  id: Generated<UUID>
  process_instance_id: string | null
  process_definition_id: string | null
  activity_id: string | null
  job_type: 'timer' | 'message' | 'signal' | 'async'
  timer_type: 'duration' | 'date' | 'cycle' | null
  timer_value: string | null
  due_time: Timestamp
  lock_expiry_time: Timestamp | null
  lock_owner: string | null
  retries: number
  state: 'WAITING' | 'LOCKED' | 'COMPLETED' | 'FAILED'
  exception_message: string | null
  exception_stack_trace: string | null
  job_configuration: Json | null
  created_at: Generated<Timestamp>
}

export interface BpmnMessageEventsTable {
  id: Generated<UUID>
  message_name: string
  correlation_key: string | null
  process_instance_id: string | null
  execution_id: string | null
  payload: Json | null
  variables: Json | null
  state: 'PENDING' | 'RECEIVED' | 'CONSUMED'
  created_at: Generated<Timestamp>
  received_at: Timestamp | null
  consumed_at: Timestamp | null
  ttl: number | null
}

export interface BpmnSignalEventsTable {
  id: Generated<UUID>
  signal_name: string
  execution_id: string | null
  process_instance_id: string | null
  variables: Json | null
  is_broadcast: boolean
  tenant_id: string | null
  state: 'TRIGGERED' | 'CAUGHT'
  created_at: Generated<Timestamp>
  caught_at: Timestamp | null
}

export interface BpmnVariablesTable {
  id: Generated<UUID>
  name: string
  type: string
  value: string | null
  json_value: Json | null
  process_instance_id: string | null
  execution_id: string | null
  task_id: string | null
  is_transient: boolean
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

export interface BpmnIncidentsTable {
  id: Generated<UUID>
  incident_type: 'failedJob' | 'failedExternalTask' | 'unhandledError'
  incident_message: string | null
  process_instance_id: string | null
  process_definition_id: string | null
  activity_id: string | null
  execution_id: string | null
  job_id: string | null
  error_message: string | null
  stack_trace: string | null
  state: 'OPEN' | 'RESOLVED'
  resolved_at: Timestamp | null
  resolved_by: string | null
  created_at: Generated<Timestamp>
}

export interface BpmnAuditLogTable {
  id: Generated<bigint>
  event_type: string
  process_instance_id: string | null
  activity_id: string | null
  task_id: string | null
  user_id: string | null
  old_value: Json | null
  new_value: Json | null
  timestamp: Generated<Timestamp>
  tenant_id: string | null
}

export interface BpmnDeploymentsTable {
  id: Generated<UUID>
  name: string
  deployment_time: Generated<Timestamp>
  source: string | null
  tenant_id: string | null
  resources: Json | null
  deployed_by: string
}

export interface BpmnExternalTasksTable {
  id: Generated<UUID>
  topic_name: string
  worker_id: string | null
  process_instance_id: string | null
  process_definition_id: string | null
  activity_id: string | null
  activity_instance_id: string | null
  execution_id: string | null
  lock_expiry_time: Timestamp | null
  suspension_state: number
  retries: number
  error_message: string | null
  error_details: string | null
  priority: bigint
  variables: Json
  created_at: Generated<Timestamp>
}

// ============================================
// EVENT BUS SYSTEM TABLES (Phase 1)
// ============================================

export interface EventTypesTable {
  id: Generated<UUID>
  event_name: string
  version: string
  payload_schema: Json | null
  description: string | null
  is_system: boolean
  retention_days: number
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

export interface EventSubscriptionsTable {
  id: Generated<UUID>
  subscriber_id: string
  event_pattern: string
  handler_config: Json
  filter_expression: Json | null
  retry_policy: Json
  priority: number
  is_active: boolean
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

export interface EventStoreTable {
  id: Generated<UUID>
  event_id: string
  event_name: string
  event_version: string
  payload: Json
  source_id: string | null
  source_type: string | null
  correlation_id: string | null
  causation_id: string | null
  metadata: Json
  published_at: Generated<Timestamp>
  partition_key: string | null
  sequence_number: bigint | null
}

export interface EventDeliveriesTable {
  id: Generated<UUID>
  event_id: string
  subscription_id: string
  subscriber_id: string
  attempt_number: number
  status: 'PENDING' | 'DELIVERED' | 'FAILED' | 'DEAD_LETTER'
  error_message: string | null
  delivered_at: Timestamp | null
  retry_at: Timestamp | null
  created_at: Generated<Timestamp>
}

export interface EventReplaysTable {
  id: Generated<UUID>
  replay_name: string
  event_pattern: string
  start_time: Timestamp
  end_time: Timestamp
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED'
  events_processed: number
  events_total: number
  created_by: string
  created_at: Generated<Timestamp>
  completed_at: Timestamp | null
}

export interface EventAggregatesTable {
  id: Generated<UUID>
  event_name: string
  window_type: 'MINUTE' | 'HOUR' | 'DAY'
  window_start: Timestamp
  window_end: Timestamp
  count: number
  unique_sources: number
  error_count: number
  avg_payload_size: number
  metadata: Json
  created_at: Generated<Timestamp>
}

export interface PluginEventPermissionsTable {
  id: Generated<UUID>
  plugin_id: string
  event_name: string
  permission_type: 'PUBLISH' | 'SUBSCRIBE'
  is_granted: boolean
  granted_by: string
  granted_at: Generated<Timestamp>
}

export interface DeadLetterEventsTable {
  id: Generated<UUID>
  event_id: string
  subscription_id: string
  subscriber_id: string
  event_data: Json
  failure_count: number
  last_error: string
  moved_to_dlq_at: Generated<Timestamp>
  resolved_at: Timestamp | null
  resolved_by: string | null
}

// ============================================
// COMPLETE DATABASE SCHEMA
// ============================================

export interface Database {
  // Workflow engine
  workflow_definitions: WorkflowDefinitionsTable
  workflow_instances: WorkflowInstancesTable
  workflow_tokens: WorkflowTokensTable
  workflow_incidents: WorkflowIncidentsTable

  // Unified data model
  tables: TablesTable
  views: ViewsTable
  view_states: ViewStatesTable

  // User & auth
  users: UsersTable
  roles: RolesTable
  user_roles: UserRolesTable

  // Spreadsheet
  spreadsheets: SpreadsheetsTable
  sheets: SheetsTable
  cells: CellsTable
  formulas: FormulasTable
  cell_versions: CellVersionsTable
  named_ranges: NamedRangesTable
  spreadsheet_permissions: SpreadsheetPermissionsTable

  // External data
  data_sources: DataSourcesTable
  data_source_credentials: DataSourceCredentialsTable
  external_tables: ExternalTablesTable

  // Plugins
  plugins: PluginsTable
  plugin_manifests: PluginManifestsTable
  plugin_dependencies: PluginDependenciesTable

  // Script execution
  script_executions: ScriptExecutionsTable

  // Templates
  templates: TemplatesTable

  // Audit & monitoring
  audit_logs: AuditLogsTable
  audit_signatures: AuditSignaturesTable
  query_cache: QueryCacheTable

  // Approvals
  approval_instances: ApprovalInstancesTable
  approval_records: ApprovalRecordsTable

  // Snapshots & Protection
  snapshots: SnapshotsTable
  snapshot_items: SnapshotItemsTable
  snapshot_restore_log: SnapshotRestoreLogTable
  protection_rules: ProtectionRulesTable
  rule_execution_log: RuleExecutionLogTable

  // Files
  files: FilesTable

  // Plugin KV store
  plugin_kv: PluginKVTable

  // Minimal table rows definition for ViewService
  table_rows: {
    id: string
    table_id: string
    data: Json
    created_at: Timestamp
    updated_at: Timestamp
  }

  // BPMN Workflow Engine (Phase 2)
  bpmn_process_definitions: BpmnProcessDefinitionsTable
  bpmn_process_instances: BpmnProcessInstancesTable
  bpmn_activity_instances: BpmnActivityInstancesTable
  bpmn_user_tasks: BpmnUserTasksTable
  bpmn_timer_jobs: BpmnTimerJobsTable
  bpmn_message_events: BpmnMessageEventsTable
  bpmn_signal_events: BpmnSignalEventsTable
  bpmn_variables: BpmnVariablesTable
  bpmn_incidents: BpmnIncidentsTable
  bpmn_audit_log: BpmnAuditLogTable
  bpmn_deployments: BpmnDeploymentsTable
  bpmn_external_tasks: BpmnExternalTasksTable

  // Event Bus System (Phase 1)
  event_types: EventTypesTable
  event_subscriptions: EventSubscriptionsTable
  event_store: EventStoreTable
  event_deliveries: EventDeliveriesTable
  event_replays: EventReplaysTable
  event_aggregates: EventAggregatesTable
  plugin_event_permissions: PluginEventPermissionsTable
  dead_letter_events: DeadLetterEventsTable
}

// Export for use with Kysely
export type DB = Database
// @ts-nocheck
