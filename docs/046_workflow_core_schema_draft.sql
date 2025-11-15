-- 046_workflow_core.sql Schema Draft
-- Purpose: Token-based workflow execution (Camunda-style)
-- Status: Draft for review before P1 implementation

-- Workflow Definitions (BPMN/DAG storage)
CREATE TABLE IF NOT EXISTS workflow_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  version INT NOT NULL DEFAULT 1,
  bpmn_json JSONB,          -- BPMN 2.0 JSON representation
  dag_json JSONB,           -- Alternative: DAG representation
  triggers JSONB,           -- [{ type: 'record_change', config: {...} }]
  metadata JSONB DEFAULT '{}',
  created_by VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  status VARCHAR(50) DEFAULT 'draft', -- draft/active/archived
  UNIQUE(name, version)
);

-- Workflow Instances (runtime execution state)
CREATE TABLE IF NOT EXISTS workflow_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id UUID NOT NULL REFERENCES workflow_definitions(id),
  definition_version INT NOT NULL,
  status VARCHAR(50) NOT NULL, -- running/completed/failed/cancelled
  input_data JSONB,            -- Initial trigger data
  output_data JSONB,           -- Final results
  context JSONB DEFAULT '{}',  -- Execution context (variables)
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  started_by VARCHAR(100),
  error_message TEXT,
  retry_count INT DEFAULT 0
);

-- Workflow Tokens (Petri-net style token propagation)
CREATE TABLE IF NOT EXISTS workflow_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id UUID NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  node_id VARCHAR(200) NOT NULL,    -- BPMN node ID
  node_type VARCHAR(50) NOT NULL,   -- task/gateway/event
  status VARCHAR(50) NOT NULL,      -- active/consumed/cancelled/waiting
  payload JSONB,                    -- Data carried by token
  parent_token_id UUID REFERENCES workflow_tokens(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  consumed_at TIMESTAMPTZ,
  INDEX idx_token_instance_status (instance_id, status),
  INDEX idx_token_node (node_id)
);

-- Workflow Incidents (errors and compensations)
CREATE TABLE IF NOT EXISTS workflow_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id UUID NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  token_id UUID REFERENCES workflow_tokens(id),
  node_id VARCHAR(200) NOT NULL,
  incident_type VARCHAR(50) NOT NULL, -- execution_error/timeout/validation_failed
  error_message TEXT,
  error_details JSONB,
  status VARCHAR(50) DEFAULT 'open', -- open/resolved/ignored
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by VARCHAR(100),
  compensation_action JSONB,         -- Rollback/retry configuration
  INDEX idx_incident_instance (instance_id),
  INDEX idx_incident_status (status)
);

-- Example workflow_definitions entry (Purchase Approval)
INSERT INTO workflow_definitions (name, version, bpmn_json, triggers, status) VALUES (
  'purchase_approval',
  1,
  '{
    "nodes": [
      { "id": "start", "type": "startEvent" },
      { "id": "approve_task", "type": "userTask", "assignee": "manager" },
      { "id": "notify_result", "type": "serviceTask", "implementation": "email" },
      { "id": "end", "type": "endEvent" }
    ],
    "edges": [
      { "source": "start", "target": "approve_task" },
      { "source": "approve_task", "target": "notify_result" },
      { "source": "notify_result", "target": "end" }
    ]
  }'::jsonb,
  '[{ "type": "record_change", "table": "purchase_orders", "field": "status", "condition": "submitted" }]'::jsonb,
  'active'
) ON CONFLICT (name, version) DO NOTHING;
