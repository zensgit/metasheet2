-- 047_create_event_bus_tables.sql
-- Event Bus System for Plugin Communication and System Events

-- 1. Event Types Registry
CREATE TABLE IF NOT EXISTS event_types (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  event_name TEXT NOT NULL UNIQUE,

  -- Event Details
  category TEXT NOT NULL CHECK (category IN (
    'system', 'plugin', 'user', 'data', 'workflow',
    'security', 'notification', 'integration', 'audit'
  )),
  description TEXT,

  -- Schema
  payload_schema JSONB, -- JSON Schema for validation
  metadata_schema JSONB,

  -- Configuration
  is_async BOOLEAN DEFAULT false,
  is_persistent BOOLEAN DEFAULT true,
  is_transactional BOOLEAN DEFAULT false,

  -- Retry Policy
  max_retries INTEGER DEFAULT 3,
  retry_delay_ms INTEGER DEFAULT 1000,
  retry_backoff_multiplier NUMERIC DEFAULT 2.0,

  -- TTL
  ttl_seconds INTEGER, -- Event expiration

  -- State
  is_active BOOLEAN DEFAULT true,
  is_system BOOLEAN DEFAULT false, -- System events can't be modified

  -- Metadata
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_types_category ON event_types(category);
CREATE INDEX IF NOT EXISTS idx_event_types_active ON event_types(is_active);

-- 2. Event Subscriptions
CREATE TABLE IF NOT EXISTS event_subscriptions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  subscriber_id TEXT NOT NULL, -- Plugin ID or Service ID
  subscriber_type TEXT NOT NULL CHECK (subscriber_type IN (
    'plugin', 'service', 'workflow', 'webhook', 'function'
  )),

  -- Event Pattern
  event_pattern TEXT NOT NULL, -- Can use wildcards like 'user.*' or 'data.*.created'
  event_types TEXT[], -- Specific event types to subscribe

  -- Filter
  filter_expression JSONB, -- JSONPath or custom filter

  -- Handler
  handler_type TEXT NOT NULL CHECK (handler_type IN (
    'function', 'http', 'queue', 'webhook', 'plugin_method'
  )),
  handler_config JSONB NOT NULL, -- Handler-specific configuration

  -- Execution
  priority INTEGER DEFAULT 0, -- Higher priority runs first
  is_sequential BOOLEAN DEFAULT false, -- Must complete before next
  timeout_ms INTEGER DEFAULT 30000,

  -- Transformation
  transform_enabled BOOLEAN DEFAULT false,
  transform_template TEXT, -- Template for transforming event data

  -- State
  is_active BOOLEAN DEFAULT true,
  is_paused BOOLEAN DEFAULT false,

  -- Statistics
  total_events_received BIGINT DEFAULT 0,
  total_events_processed BIGINT DEFAULT 0,
  total_events_failed BIGINT DEFAULT 0,
  last_event_at TIMESTAMPTZ,

  -- Metadata
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_subscriber ON event_subscriptions(subscriber_id, subscriber_type);
CREATE INDEX IF NOT EXISTS idx_subscriptions_pattern ON event_subscriptions(event_pattern);
CREATE INDEX IF NOT EXISTS idx_subscriptions_active ON event_subscriptions(is_active, is_paused);
CREATE INDEX IF NOT EXISTS idx_subscriptions_priority ON event_subscriptions(priority DESC);

-- 3. Event Store (Persistent Events)
CREATE TABLE IF NOT EXISTS event_store (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,

  -- Event Info
  event_name TEXT NOT NULL,
  event_version TEXT DEFAULT '1.0.0',

  -- Source
  source_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  correlation_id TEXT, -- For tracking related events
  causation_id TEXT, -- Event that caused this event

  -- Data
  payload JSONB NOT NULL,
  metadata JSONB DEFAULT '{}',

  -- Timing
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Processing
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'processing', 'processed', 'failed', 'expired', 'archived'
  )),
  processed_at TIMESTAMPTZ,

  -- Error Tracking
  error_count INTEGER DEFAULT 0,
  last_error TEXT,

  -- TTL
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_event_store_name ON event_store(event_name, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_store_source ON event_store(source_id, source_type);
CREATE INDEX IF NOT EXISTS idx_event_store_correlation ON event_store(correlation_id);
CREATE INDEX IF NOT EXISTS idx_event_store_status ON event_store(status, occurred_at);
CREATE INDEX IF NOT EXISTS idx_event_store_expires ON event_store(expires_at) WHERE expires_at IS NOT NULL;

-- 4. Event Handlers
CREATE TABLE IF NOT EXISTS event_handlers (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  subscription_id TEXT NOT NULL REFERENCES event_subscriptions(id) ON DELETE CASCADE,

  -- Handler Details
  name TEXT NOT NULL,
  description TEXT,

  -- Implementation
  handler_function TEXT, -- Function name or code
  handler_module TEXT, -- Module path
  handler_class TEXT, -- Class name if applicable

  -- Dependencies
  required_plugins TEXT[],
  required_services TEXT[],

  -- Configuration
  config JSONB DEFAULT '{}',
  environment_vars JSONB DEFAULT '{}',

  -- Execution Context
  run_as_user TEXT,
  max_concurrency INTEGER DEFAULT 1,

  -- State
  is_active BOOLEAN DEFAULT true,
  last_executed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_handlers_subscription ON event_handlers(subscription_id);
CREATE INDEX IF NOT EXISTS idx_handlers_active ON event_handlers(is_active);

-- 5. Event Processing Queue
CREATE TABLE IF NOT EXISTS event_queue (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL REFERENCES event_subscriptions(id) ON DELETE CASCADE,

  -- Queue Info
  queue_name TEXT DEFAULT 'default',
  priority INTEGER DEFAULT 0,

  -- Processing
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'processing', 'completed', 'failed', 'cancelled', 'timeout'
  )),

  -- Scheduling
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  -- Worker
  worker_id TEXT,

  -- Retry
  attempt_count INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  next_retry_at TIMESTAMPTZ,

  -- Error
  error_message TEXT,
  error_stack TEXT,

  -- Result
  result JSONB
);

CREATE INDEX IF NOT EXISTS idx_queue_status ON event_queue(status, scheduled_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_queue_subscription ON event_queue(subscription_id);
CREATE INDEX IF NOT EXISTS idx_queue_event ON event_queue(event_id);
CREATE INDEX IF NOT EXISTS idx_queue_retry ON event_queue(next_retry_at) WHERE status = 'failed' AND attempt_count < max_attempts;

-- 6. Event Delivery Log
CREATE TABLE IF NOT EXISTS event_deliveries (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,

  -- Delivery Info
  delivery_id TEXT NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,

  -- Attempt
  attempt_number INTEGER NOT NULL DEFAULT 1,

  -- Response
  status_code INTEGER,
  response_body TEXT,
  response_headers JSONB,

  -- Timing
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER,

  -- Status
  success BOOLEAN NOT NULL,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_deliveries_event ON event_deliveries(event_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_subscription ON event_deliveries(subscription_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_success ON event_deliveries(success, completed_at);

-- 7. Event Aggregates (for analytics)
CREATE TABLE IF NOT EXISTS event_aggregates (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,

  -- Dimensions
  event_name TEXT NOT NULL,
  source_type TEXT,

  -- Time Window
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  window_type TEXT NOT NULL CHECK (window_type IN ('minute', 'hour', 'day', 'week', 'month')),

  -- Counts
  event_count BIGINT DEFAULT 0,
  unique_sources INTEGER DEFAULT 0,

  -- Processing Metrics
  processed_count BIGINT DEFAULT 0,
  failed_count BIGINT DEFAULT 0,
  retry_count BIGINT DEFAULT 0,

  -- Performance
  avg_processing_time_ms NUMERIC,
  min_processing_time_ms NUMERIC,
  max_processing_time_ms NUMERIC,
  p50_processing_time_ms NUMERIC,
  p95_processing_time_ms NUMERIC,
  p99_processing_time_ms NUMERIC,

  -- Success Rate
  success_rate NUMERIC GENERATED ALWAYS AS (
    CASE WHEN processed_count > 0
    THEN ((processed_count - failed_count)::NUMERIC / processed_count::NUMERIC) * 100
    ELSE 0 END
  ) STORED,

  CONSTRAINT unique_aggregate UNIQUE (event_name, source_type, window_start, window_type)
);

CREATE INDEX IF NOT EXISTS idx_aggregates_window ON event_aggregates(window_start, window_end);
CREATE INDEX IF NOT EXISTS idx_aggregates_event ON event_aggregates(event_name);

-- 8. Dead Letter Queue
CREATE TABLE IF NOT EXISTS event_dead_letters (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL,
  subscription_id TEXT,

  -- Original Event
  event_name TEXT NOT NULL,
  event_data JSONB NOT NULL,

  -- Failure Info
  failure_reason TEXT NOT NULL,
  failure_count INTEGER DEFAULT 1,
  first_failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Error Details
  error_type TEXT,
  error_message TEXT,
  error_stack TEXT,

  -- Recovery
  can_retry BOOLEAN DEFAULT true,
  retry_after TIMESTAMPTZ,

  -- Status
  status TEXT NOT NULL DEFAULT 'failed' CHECK (status IN (
    'failed', 'retrying', 'recovered', 'discarded'
  )),
  recovered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_dead_letters_status ON event_dead_letters(status);
CREATE INDEX IF NOT EXISTS idx_dead_letters_event ON event_dead_letters(event_id);
CREATE INDEX IF NOT EXISTS idx_dead_letters_retry ON event_dead_letters(retry_after) WHERE can_retry = true;

-- 9. Event Replay Log
CREATE TABLE IF NOT EXISTS event_replays (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,

  -- Replay Scope
  replay_type TEXT NOT NULL CHECK (replay_type IN (
    'single_event', 'time_range', 'subscription', 'pattern'
  )),

  -- Criteria
  event_ids TEXT[],
  event_pattern TEXT,
  time_range_start TIMESTAMPTZ,
  time_range_end TIMESTAMPTZ,
  subscription_ids TEXT[],

  -- Execution
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'running', 'completed', 'failed', 'cancelled'
  )),

  -- Progress
  total_events INTEGER,
  replayed_events INTEGER DEFAULT 0,
  failed_events INTEGER DEFAULT 0,

  -- Timing
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  -- Metadata
  initiated_by TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_replays_status ON event_replays(status);
CREATE INDEX IF NOT EXISTS idx_replays_created ON event_replays(created_at DESC);

-- 10. Plugin Event Permissions
CREATE TABLE IF NOT EXISTS plugin_event_permissions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  plugin_id TEXT NOT NULL,

  -- Permissions
  can_emit TEXT[], -- Event patterns this plugin can emit
  can_subscribe TEXT[], -- Event patterns this plugin can subscribe to

  -- Restrictions
  max_events_per_minute INTEGER DEFAULT 1000,
  max_subscriptions INTEGER DEFAULT 100,
  max_event_size_kb INTEGER DEFAULT 100,

  -- Quotas
  events_emitted_today BIGINT DEFAULT 0,
  events_received_today BIGINT DEFAULT 0,
  quota_reset_at TIMESTAMPTZ,

  -- State
  is_active BOOLEAN DEFAULT true,
  is_suspended BOOLEAN DEFAULT false,
  suspended_reason TEXT,

  -- Metadata
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT unique_plugin_permissions UNIQUE (plugin_id)
);

CREATE INDEX IF NOT EXISTS idx_plugin_permissions_active ON plugin_event_permissions(is_active, is_suspended);

-- Functions and Triggers

-- Validate event against schema
CREATE OR REPLACE FUNCTION validate_event_schema(
  p_event_name TEXT,
  p_payload JSONB
) RETURNS BOOLEAN AS $$
DECLARE
  v_schema JSONB;
BEGIN
  SELECT payload_schema INTO v_schema
  FROM event_types
  WHERE event_name = p_event_name AND is_active = true;

  IF v_schema IS NULL THEN
    RETURN true; -- No schema defined, allow
  END IF;

  -- Simplified validation - in production use json-schema validator
  RETURN true;
END;
$$ LANGUAGE plpgsql;

-- Process event subscriptions
CREATE OR REPLACE FUNCTION process_event_subscriptions()
RETURNS TRIGGER AS $$
DECLARE
  v_subscription RECORD;
  v_matches BOOLEAN;
BEGIN
  -- Find matching subscriptions
  FOR v_subscription IN
    SELECT * FROM event_subscriptions
    WHERE is_active = true
      AND is_paused = false
      AND (
        event_pattern = NEW.event_name
        OR NEW.event_name LIKE REPLACE(event_pattern, '*', '%')
        OR event_pattern = '*'
      )
    ORDER BY priority DESC
  LOOP
    -- Check filter
    v_matches := true;
    IF v_subscription.filter_expression IS NOT NULL THEN
      -- Apply filter (simplified)
      v_matches := true; -- Would apply JSONPath filter
    END IF;

    IF v_matches THEN
      -- Queue for processing
      INSERT INTO event_queue (
        event_id, subscription_id, priority,
        scheduled_at, max_attempts
      ) VALUES (
        NEW.event_id, v_subscription.id, v_subscription.priority,
        NOW(), 3
      );

      -- Update subscription stats
      UPDATE event_subscriptions
      SET
        total_events_received = total_events_received + 1,
        last_event_at = NOW()
      WHERE id = v_subscription.id;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER process_subscriptions_on_event
  AFTER INSERT ON event_store
  FOR EACH ROW
  WHEN (NEW.status = 'pending')
  EXECUTE FUNCTION process_event_subscriptions();

-- Update event aggregates
CREATE OR REPLACE FUNCTION update_event_aggregates()
RETURNS TRIGGER AS $$
DECLARE
  v_window_start TIMESTAMPTZ;
  v_window_type TEXT := 'hour';
BEGIN
  v_window_start := date_trunc('hour', NEW.occurred_at);

  INSERT INTO event_aggregates (
    event_name, source_type,
    window_start, window_end, window_type,
    event_count
  ) VALUES (
    NEW.event_name, NEW.source_type,
    v_window_start, v_window_start + INTERVAL '1 hour', v_window_type,
    1
  )
  ON CONFLICT (event_name, source_type, window_start, window_type)
  DO UPDATE SET
    event_count = event_aggregates.event_count + 1;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_aggregates_on_event
  AFTER INSERT ON event_store
  FOR EACH ROW
  EXECUTE FUNCTION update_event_aggregates();

-- Handle failed events
CREATE OR REPLACE FUNCTION handle_failed_event()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'failed' AND OLD.status != 'failed' THEN
    -- Check if should go to dead letter queue
    IF NEW.attempt_count >= NEW.max_attempts THEN
      INSERT INTO event_dead_letters (
        event_id, subscription_id,
        event_name, event_data,
        failure_reason, failure_count,
        error_message
      )
      SELECT
        e.event_id, NEW.subscription_id,
        e.event_name, e.payload,
        'Max retries exceeded', NEW.attempt_count,
        NEW.error_message
      FROM event_store e
      WHERE e.event_id = NEW.event_id;
    ELSE
      -- Schedule retry
      UPDATE event_queue
      SET
        next_retry_at = NOW() + INTERVAL '1 minute' * POWER(2, NEW.attempt_count),
        status = 'pending'
      WHERE id = NEW.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER handle_failed_events_trigger
  AFTER UPDATE ON event_queue
  FOR EACH ROW
  WHEN (NEW.status = 'failed')
  EXECUTE FUNCTION handle_failed_event();

-- Clean up old events
CREATE OR REPLACE FUNCTION cleanup_old_events()
RETURNS void AS $$
BEGIN
  -- Archive processed events older than 30 days
  UPDATE event_store
  SET status = 'archived'
  WHERE status = 'processed'
    AND processed_at < NOW() - INTERVAL '30 days';

  -- Delete archived events older than 90 days
  DELETE FROM event_store
  WHERE status = 'archived'
    AND processed_at < NOW() - INTERVAL '90 days';

  -- Delete old delivery logs
  DELETE FROM event_deliveries
  WHERE completed_at < NOW() - INTERVAL '7 days';

  -- Clean dead letter queue
  DELETE FROM event_dead_letters
  WHERE status = 'discarded'
    AND last_failed_at < NOW() - INTERVAL '30 days';

  -- Clean old aggregates
  DELETE FROM event_aggregates
  WHERE window_end < NOW() - INTERVAL '90 days';
END;
$$ LANGUAGE plpgsql;

-- Reset daily quotas
CREATE OR REPLACE FUNCTION reset_plugin_quotas()
RETURNS void AS $$
BEGIN
  UPDATE plugin_event_permissions
  SET
    events_emitted_today = 0,
    events_received_today = 0,
    quota_reset_at = date_trunc('day', NOW() + INTERVAL '1 day')
  WHERE quota_reset_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- Comments
COMMENT ON TABLE event_types IS 'Registry of all event types in the system';
COMMENT ON TABLE event_subscriptions IS 'Event subscriptions for plugins and services';
COMMENT ON TABLE event_store IS 'Persistent store for all events';
COMMENT ON TABLE event_handlers IS 'Handler implementations for subscriptions';
COMMENT ON TABLE event_queue IS 'Queue for event processing';
COMMENT ON TABLE event_deliveries IS 'Log of event delivery attempts';
COMMENT ON TABLE event_aggregates IS 'Aggregated event metrics';
COMMENT ON TABLE event_dead_letters IS 'Failed events that could not be processed';
COMMENT ON TABLE event_replays IS 'Event replay operations';
COMMENT ON TABLE plugin_event_permissions IS 'Plugin permissions for event operations';
