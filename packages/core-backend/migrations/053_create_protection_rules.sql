-- Migration: 053_create_protection_rules.sql
-- Purpose: Add protection_rules and rule_execution_log tables for Sprint 2 rule engine
-- Mirrors Kysely TS migration 20251117000002_create_protection_rules.ts for raw SQL runner.

CREATE TABLE IF NOT EXISTS protection_rules (
  id TEXT PRIMARY KEY,
  rule_name TEXT UNIQUE NOT NULL,
  description TEXT,
  target_type TEXT NOT NULL DEFAULT 'snapshot',
  conditions JSONB NOT NULL,
  effects JSONB NOT NULL,
  priority INT NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  version INT NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_evaluated_at TIMESTAMPTZ,
  evaluation_count INT NOT NULL DEFAULT 0,
  CONSTRAINT chk_target_type CHECK (target_type IN ('snapshot','plugin','schema','workflow'))
);

CREATE INDEX IF NOT EXISTS idx_protection_rules_active ON protection_rules(is_active, priority DESC);
CREATE INDEX IF NOT EXISTS idx_protection_rules_target ON protection_rules(target_type);
CREATE INDEX IF NOT EXISTS idx_protection_rules_created_by ON protection_rules(created_by);
CREATE INDEX IF NOT EXISTS idx_protection_rules_conditions ON protection_rules USING GIN(conditions);

CREATE TABLE IF NOT EXISTS rule_execution_log (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  rule_version INT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  matched BOOLEAN NOT NULL,
  effect_applied JSONB,
  execution_time_ms INT,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rule_execution_log_rule ON rule_execution_log(rule_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_rule_execution_log_entity ON rule_execution_log(entity_type, entity_id);

