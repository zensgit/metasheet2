-- 049_create_bpmn_workflow_tables.sql
-- BPMN 2.0 Workflow Engine Tables

-- 1. Process Definitions (BPMN Process Templates)
CREATE TABLE IF NOT EXISTS bpmn_process_definitions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  bpmn_xml TEXT NOT NULL,
  diagram_json JSONB,
  category TEXT,
  tenant_id TEXT,
  deployment_id TEXT,
  resource_name TEXT,
  has_start_form BOOLEAN DEFAULT false,
  is_suspended BOOLEAN DEFAULT false,
  is_executable BOOLEAN DEFAULT true,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT unique_process_key_version UNIQUE (key, version, tenant_id)
);

-- 2. Process Instances (Running Workflows)
CREATE TABLE IF NOT EXISTS bpmn_process_instances (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  process_definition_id TEXT NOT NULL REFERENCES bpmn_process_definitions(id),
  process_definition_key TEXT NOT NULL,
  business_key TEXT,
  name TEXT,
  parent_id TEXT REFERENCES bpmn_process_instances(id),
  super_execution_id TEXT,
  root_process_instance_id TEXT,

  -- State
  state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'SUSPENDED', 'COMPLETED', 'EXTERNALLY_TERMINATED', 'INTERNALLY_TERMINATED')),
  suspension_state INTEGER DEFAULT 1,

  -- Variables
  variables JSONB DEFAULT '{}',

  -- Timing
  start_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  end_time TIMESTAMPTZ,
  duration_ms BIGINT,

  -- User context
  start_user_id TEXT,
  tenant_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_process_instances_definition ON bpmn_process_instances (process_definition_id);
CREATE INDEX IF NOT EXISTS idx_process_instances_state ON bpmn_process_instances (state);
CREATE INDEX IF NOT EXISTS idx_process_instances_business_key ON bpmn_process_instances (business_key);

-- 3. Activity Instances (Task Executions)
CREATE TABLE IF NOT EXISTS bpmn_activity_instances (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  process_instance_id TEXT NOT NULL REFERENCES bpmn_process_instances(id) ON DELETE CASCADE,
  process_definition_id TEXT NOT NULL REFERENCES bpmn_process_definitions(id),
  activity_id TEXT NOT NULL,
  activity_name TEXT,
  activity_type TEXT NOT NULL,
  execution_id TEXT,
  task_id TEXT,

  -- State
  state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'COMPLETED', 'CANCELLED', 'FAILED')),

  -- Timing
  start_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  end_time TIMESTAMPTZ,
  duration_ms BIGINT,

  -- Loop characteristics
  loop_counter INTEGER DEFAULT 0,
  nr_of_instances INTEGER,
  nr_of_completed_instances INTEGER DEFAULT 0,
  nr_of_active_instances INTEGER DEFAULT 0,

  -- Error handling
  incident_id TEXT,
  incident_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_activity_instances_process ON bpmn_activity_instances (process_instance_id);
CREATE INDEX IF NOT EXISTS idx_activity_instances_state ON bpmn_activity_instances (state);

-- 4. User Tasks (Human Tasks)
CREATE TABLE IF NOT EXISTS bpmn_user_tasks (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  process_instance_id TEXT NOT NULL REFERENCES bpmn_process_instances(id) ON DELETE CASCADE,
  process_definition_id TEXT NOT NULL REFERENCES bpmn_process_definitions(id),
  activity_instance_id TEXT REFERENCES bpmn_activity_instances(id),
  task_definition_key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,

  -- Assignment
  assignee TEXT,
  owner TEXT,
  candidate_users TEXT[],
  candidate_groups TEXT[],

  -- Priority and dates
  priority INTEGER DEFAULT 50,
  due_date TIMESTAMPTZ,
  follow_up_date TIMESTAMPTZ,

  -- Form
  form_key TEXT,
  form_data JSONB,

  -- State
  state TEXT NOT NULL DEFAULT 'CREATED' CHECK (state IN ('CREATED', 'READY', 'RESERVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'SUSPENDED')),
  suspension_state INTEGER DEFAULT 1,

  -- Delegation
  delegation_state TEXT CHECK (delegation_state IN ('PENDING', 'RESOLVED')),

  -- Timing
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  -- Variables
  variables JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_user_tasks_assignee ON bpmn_user_tasks (assignee);
CREATE INDEX IF NOT EXISTS idx_user_tasks_state ON bpmn_user_tasks (state);
CREATE INDEX IF NOT EXISTS idx_user_tasks_process ON bpmn_user_tasks (process_instance_id);

-- 5. Timer Jobs (Scheduled Activities)
CREATE TABLE IF NOT EXISTS bpmn_timer_jobs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  process_instance_id TEXT REFERENCES bpmn_process_instances(id) ON DELETE CASCADE,
  process_definition_id TEXT REFERENCES bpmn_process_definitions(id),
  activity_id TEXT,
  job_type TEXT NOT NULL CHECK (job_type IN ('timer', 'message', 'signal', 'async')),

  -- Timer configuration
  timer_type TEXT CHECK (timer_type IN ('duration', 'date', 'cycle')),
  timer_value TEXT,

  -- Execution
  due_time TIMESTAMPTZ NOT NULL,
  lock_expiry_time TIMESTAMPTZ,
  lock_owner TEXT,
  retries INTEGER DEFAULT 3,

  -- State
  state TEXT NOT NULL DEFAULT 'WAITING' CHECK (state IN ('WAITING', 'LOCKED', 'COMPLETED', 'FAILED')),

  -- Error handling
  exception_message TEXT,
  exception_stack_trace TEXT,

  -- Job configuration
  job_configuration JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_timer_jobs_due ON bpmn_timer_jobs (due_time);
CREATE INDEX IF NOT EXISTS idx_timer_jobs_state ON bpmn_timer_jobs (state);

-- 6. Message Events
CREATE TABLE IF NOT EXISTS bpmn_message_events (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  message_name TEXT NOT NULL,
  correlation_key TEXT,
  process_instance_id TEXT REFERENCES bpmn_process_instances(id) ON DELETE CASCADE,
  execution_id TEXT,

  -- Message content
  payload JSONB,
  variables JSONB,

  -- State
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'RECEIVED', 'CONSUMED')),

  -- Timing
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  received_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  ttl INTEGER
);

CREATE INDEX IF NOT EXISTS idx_message_events_name ON bpmn_message_events (message_name);
CREATE INDEX IF NOT EXISTS idx_message_events_correlation ON bpmn_message_events (correlation_key);

-- 7. Signal Events
CREATE TABLE IF NOT EXISTS bpmn_signal_events (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  signal_name TEXT NOT NULL,
  execution_id TEXT,
  process_instance_id TEXT REFERENCES bpmn_process_instances(id) ON DELETE CASCADE,

  -- Signal data
  variables JSONB,

  -- Broadcast settings
  is_broadcast BOOLEAN DEFAULT false,
  tenant_id TEXT,

  -- State
  state TEXT NOT NULL DEFAULT 'TRIGGERED' CHECK (state IN ('TRIGGERED', 'CAUGHT')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  caught_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_signal_events_name ON bpmn_signal_events (signal_name);

-- 8. Variables (Process and Task Variables)
CREATE TABLE IF NOT EXISTS bpmn_variables (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  value TEXT,
  json_value JSONB,

  -- Scope
  process_instance_id TEXT REFERENCES bpmn_process_instances(id) ON DELETE CASCADE,
  execution_id TEXT,
  task_id TEXT REFERENCES bpmn_user_tasks(id) ON DELETE CASCADE,

  -- Variable metadata
  is_transient BOOLEAN DEFAULT false,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT unique_variable_scope UNIQUE (name, process_instance_id, execution_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_variables_process ON bpmn_variables (process_instance_id);
CREATE INDEX IF NOT EXISTS idx_variables_name ON bpmn_variables (name);

-- 9. Incident Management (Error Tracking)
CREATE TABLE IF NOT EXISTS bpmn_incidents (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  incident_type TEXT NOT NULL CHECK (incident_type IN ('failedJob', 'failedExternalTask', 'unhandledError')),
  incident_message TEXT,

  -- Context
  process_instance_id TEXT REFERENCES bpmn_process_instances(id) ON DELETE CASCADE,
  process_definition_id TEXT REFERENCES bpmn_process_definitions(id),
  activity_id TEXT,
  execution_id TEXT,
  job_id TEXT,

  -- Error details
  error_message TEXT,
  stack_trace TEXT,

  -- Resolution
  state TEXT NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'RESOLVED')),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incidents_state ON bpmn_incidents (state);
CREATE INDEX IF NOT EXISTS idx_incidents_process ON bpmn_incidents (process_instance_id);

-- 10. Audit Log
CREATE TABLE IF NOT EXISTS bpmn_audit_log (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  process_instance_id TEXT,
  activity_id TEXT,
  task_id TEXT,
  user_id TEXT,

  -- Event data
  old_value JSONB,
  new_value JSONB,

  -- Metadata
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tenant_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_log_process ON bpmn_audit_log (process_instance_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON bpmn_audit_log (timestamp);

-- 11. Deployment Information
CREATE TABLE IF NOT EXISTS bpmn_deployments (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL,
  deployment_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT,
  tenant_id TEXT,

  -- Resources
  resources JSONB,

  deployed_by TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deployments_time ON bpmn_deployments (deployment_time);

-- 12. External Tasks (For External Workers)
CREATE TABLE IF NOT EXISTS bpmn_external_tasks (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  topic_name TEXT NOT NULL,
  worker_id TEXT,

  -- Context
  process_instance_id TEXT REFERENCES bpmn_process_instances(id) ON DELETE CASCADE,
  process_definition_id TEXT REFERENCES bpmn_process_definitions(id),
  activity_id TEXT,
  activity_instance_id TEXT,
  execution_id TEXT,

  -- Lock
  lock_expiry_time TIMESTAMPTZ,
  suspension_state INTEGER DEFAULT 1,
  retries INTEGER DEFAULT 3,

  -- Error handling
  error_message TEXT,
  error_details TEXT,

  -- Priority
  priority BIGINT DEFAULT 0,

  -- Variables
  variables JSONB DEFAULT '{}',

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_external_tasks_topic ON bpmn_external_tasks (topic_name);
CREATE INDEX IF NOT EXISTS idx_external_tasks_lock ON bpmn_external_tasks (lock_expiry_time);

-- Functions and Triggers

-- Update timestamps
CREATE OR REPLACE FUNCTION update_bpmn_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_process_definitions_timestamp ON bpmn_process_definitions;
CREATE TRIGGER update_process_definitions_timestamp
  BEFORE UPDATE ON bpmn_process_definitions
  FOR EACH ROW EXECUTE FUNCTION update_bpmn_timestamp();

DROP TRIGGER IF EXISTS update_variables_timestamp ON bpmn_variables;
CREATE TRIGGER update_variables_timestamp
  BEFORE UPDATE ON bpmn_variables
  FOR EACH ROW EXECUTE FUNCTION update_bpmn_timestamp();

-- Calculate duration on completion
CREATE OR REPLACE FUNCTION calculate_duration()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.end_time IS NOT NULL AND NEW.start_time IS NOT NULL THEN
    NEW.duration_ms = EXTRACT(EPOCH FROM (NEW.end_time - NEW.start_time)) * 1000;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS calculate_process_duration ON bpmn_process_instances;
CREATE TRIGGER calculate_process_duration
  BEFORE UPDATE ON bpmn_process_instances
  FOR EACH ROW
  WHEN (NEW.end_time IS NOT NULL)
  EXECUTE FUNCTION calculate_duration();

DROP TRIGGER IF EXISTS calculate_activity_duration ON bpmn_activity_instances;
CREATE TRIGGER calculate_activity_duration
  BEFORE UPDATE ON bpmn_activity_instances
  FOR EACH ROW
  WHEN (NEW.end_time IS NOT NULL)
  EXECUTE FUNCTION calculate_duration();

-- Audit logging function
CREATE OR REPLACE FUNCTION bpmn_audit_trigger()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO bpmn_audit_log (event_type, process_instance_id, activity_id, task_id, user_id, old_value, new_value)
  VALUES (
    TG_OP || '_' || TG_TABLE_NAME,
    COALESCE(NEW.process_instance_id, OLD.process_instance_id),
    COALESCE(NEW.activity_id, OLD.activity_id),
    CASE
      WHEN TG_TABLE_NAME = 'bpmn_user_tasks' THEN COALESCE(NEW.id, OLD.id)
      ELSE COALESCE(NEW.task_id, OLD.task_id)
    END,
    current_setting('app.current_user', true),
    CASE WHEN TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN to_jsonb(NEW) ELSE NULL END
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Enable audit logging for key tables
DROP TRIGGER IF EXISTS audit_process_instances ON bpmn_process_instances;
CREATE TRIGGER audit_process_instances
  AFTER INSERT OR UPDATE OR DELETE ON bpmn_process_instances
  FOR EACH ROW EXECUTE FUNCTION bpmn_audit_trigger();

DROP TRIGGER IF EXISTS audit_user_tasks ON bpmn_user_tasks;
CREATE TRIGGER audit_user_tasks
  AFTER INSERT OR UPDATE OR DELETE ON bpmn_user_tasks
  FOR EACH ROW EXECUTE FUNCTION bpmn_audit_trigger();

-- Comments
COMMENT ON TABLE bpmn_process_definitions IS 'BPMN 2.0 process definitions (templates)';
COMMENT ON TABLE bpmn_process_instances IS 'Running workflow instances';
COMMENT ON TABLE bpmn_activity_instances IS 'Executed activities within process instances';
COMMENT ON TABLE bpmn_user_tasks IS 'Human tasks requiring user interaction';
COMMENT ON TABLE bpmn_timer_jobs IS 'Scheduled timer events and jobs';
COMMENT ON TABLE bpmn_message_events IS 'Message-based process communication';
COMMENT ON TABLE bpmn_signal_events IS 'Signal broadcasts between processes';
COMMENT ON TABLE bpmn_variables IS 'Process and task variables';
COMMENT ON TABLE bpmn_incidents IS 'Error and incident tracking';
COMMENT ON TABLE bpmn_audit_log IS 'Complete audit trail of all workflow actions';
COMMENT ON TABLE bpmn_deployments IS 'Process deployment history';
COMMENT ON TABLE bpmn_external_tasks IS 'Tasks for external worker processes';
