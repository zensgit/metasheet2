import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'event_subscriptions'
          AND column_name = 'id'
          AND udt_name = 'uuid'
      ) THEN
        EXECUTE 'ALTER TABLE event_subscriptions ALTER COLUMN id DROP DEFAULT';
        EXECUTE 'ALTER TABLE event_subscriptions ALTER COLUMN id TYPE text USING id::text';
        EXECUTE $cmd$ALTER TABLE event_subscriptions ALTER COLUMN id SET DEFAULT gen_random_uuid()::text$cmd$;
      END IF;
    END
    $$;
  `.execute(db)

  await sql`
    ALTER TABLE event_subscriptions
    ADD COLUMN IF NOT EXISTS subscriber_type text,
    ADD COLUMN IF NOT EXISTS event_types text[],
    ADD COLUMN IF NOT EXISTS handler_type text,
    ADD COLUMN IF NOT EXISTS is_sequential boolean,
    ADD COLUMN IF NOT EXISTS timeout_ms integer,
    ADD COLUMN IF NOT EXISTS transform_enabled boolean,
    ADD COLUMN IF NOT EXISTS transform_template text,
    ADD COLUMN IF NOT EXISTS total_events_received bigint,
    ADD COLUMN IF NOT EXISTS total_events_processed bigint,
    ADD COLUMN IF NOT EXISTS total_events_failed bigint,
    ADD COLUMN IF NOT EXISTS last_event_at timestamptz
  `.execute(db)

  await sql`
    UPDATE event_subscriptions
    SET
      subscriber_type = COALESCE(subscriber_type, 'service'),
      handler_type = COALESCE(handler_type, 'function'),
      is_sequential = COALESCE(is_sequential, false),
      timeout_ms = COALESCE(timeout_ms, 30000),
      transform_enabled = COALESCE(transform_enabled, false),
      total_events_received = COALESCE(total_events_received, 0),
      total_events_processed = COALESCE(total_events_processed, 0),
      total_events_failed = COALESCE(total_events_failed, 0)
    WHERE
      subscriber_type IS NULL
      OR handler_type IS NULL
      OR is_sequential IS NULL
      OR timeout_ms IS NULL
      OR transform_enabled IS NULL
      OR total_events_received IS NULL
      OR total_events_processed IS NULL
      OR total_events_failed IS NULL
  `.execute(db)

  await sql`
    ALTER TABLE event_subscriptions
    ALTER COLUMN subscriber_type SET DEFAULT 'service',
    ALTER COLUMN subscriber_type SET NOT NULL,
    ALTER COLUMN handler_type SET DEFAULT 'function',
    ALTER COLUMN handler_type SET NOT NULL,
    ALTER COLUMN is_sequential SET DEFAULT false,
    ALTER COLUMN is_sequential SET NOT NULL,
    ALTER COLUMN timeout_ms SET DEFAULT 30000,
    ALTER COLUMN timeout_ms SET NOT NULL,
    ALTER COLUMN transform_enabled SET DEFAULT false,
    ALTER COLUMN transform_enabled SET NOT NULL,
    ALTER COLUMN total_events_received SET DEFAULT 0,
    ALTER COLUMN total_events_received SET NOT NULL,
    ALTER COLUMN total_events_processed SET DEFAULT 0,
    ALTER COLUMN total_events_processed SET NOT NULL,
    ALTER COLUMN total_events_failed SET DEFAULT 0,
    ALTER COLUMN total_events_failed SET NOT NULL
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_subscriptions_subscriber ON event_subscriptions(subscriber_id, subscriber_type)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_subscriptions_priority_desc ON event_subscriptions(priority DESC)
  `.execute(db)

  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'event_replays'
          AND column_name = 'id'
          AND udt_name = 'uuid'
      ) THEN
        EXECUTE 'ALTER TABLE event_replays ALTER COLUMN id DROP DEFAULT';
        EXECUTE 'ALTER TABLE event_replays ALTER COLUMN id TYPE text USING id::text';
        EXECUTE $cmd$ALTER TABLE event_replays ALTER COLUMN id SET DEFAULT gen_random_uuid()::text$cmd$;
      END IF;
    END
    $$;
  `.execute(db)

  await sql`
    ALTER TABLE event_replays
    ADD COLUMN IF NOT EXISTS replay_type text,
    ADD COLUMN IF NOT EXISTS event_ids text[],
    ADD COLUMN IF NOT EXISTS time_range_start timestamptz,
    ADD COLUMN IF NOT EXISTS time_range_end timestamptz,
    ADD COLUMN IF NOT EXISTS subscription_ids text[],
    ADD COLUMN IF NOT EXISTS initiated_by text,
    ADD COLUMN IF NOT EXISTS reason text,
    ADD COLUMN IF NOT EXISTS started_at timestamptz
  `.execute(db)

  await sql`
    DO $$
    DECLARE
      has_replay_name boolean;
      has_event_pattern boolean;
      has_start_time boolean;
      has_end_time boolean;
      has_created_by boolean;
    BEGIN
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'event_replays'
          AND column_name = 'replay_name'
      ) INTO has_replay_name;

      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'event_replays'
          AND column_name = 'event_pattern'
      ) INTO has_event_pattern;

      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'event_replays'
          AND column_name = 'start_time'
      ) INTO has_start_time;

      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'event_replays'
          AND column_name = 'end_time'
      ) INTO has_end_time;

      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'event_replays'
          AND column_name = 'created_by'
      ) INTO has_created_by;

      EXECUTE format(
        'UPDATE event_replays
         SET replay_type = COALESCE(replay_type, CASE
           WHEN %1$L AND %2$L THEN ''time_range''
           WHEN %1$L THEN ''pattern''
           WHEN event_ids IS NOT NULL THEN ''single_event''
           ELSE ''time_range''
         END),
         time_range_start = COALESCE(time_range_start, %3$s),
         time_range_end = COALESCE(time_range_end, %4$s),
         initiated_by = COALESCE(initiated_by, %5$s, ''system''),
         reason = COALESCE(reason, %6$s, ''Legacy replay'')
         WHERE replay_type IS NULL
           OR initiated_by IS NULL
           OR reason IS NULL
           OR time_range_start IS NULL
           OR time_range_end IS NULL',
        has_event_pattern,
        has_start_time OR has_end_time,
        CASE WHEN has_start_time THEN 'start_time' ELSE 'NULL' END,
        CASE WHEN has_end_time THEN 'end_time' ELSE 'NULL' END,
        CASE WHEN has_created_by THEN 'created_by' ELSE 'NULL' END,
        CASE WHEN has_replay_name THEN 'replay_name' ELSE 'NULL' END
      );

      IF has_replay_name THEN
        EXECUTE $cmd$ALTER TABLE event_replays ALTER COLUMN replay_name SET DEFAULT 'Legacy replay'$cmd$;
      END IF;

      IF has_created_by THEN
        EXECUTE $cmd$ALTER TABLE event_replays ALTER COLUMN created_by SET DEFAULT 'system'$cmd$;
      END IF;

      IF has_event_pattern THEN
        EXECUTE 'ALTER TABLE event_replays ALTER COLUMN event_pattern DROP NOT NULL';
      END IF;

      IF has_start_time THEN
        EXECUTE 'ALTER TABLE event_replays ALTER COLUMN start_time DROP NOT NULL';
      END IF;

      IF has_end_time THEN
        EXECUTE 'ALTER TABLE event_replays ALTER COLUMN end_time DROP NOT NULL';
      END IF;
    END
    $$;
  `.execute(db)

  await sql`
    ALTER TABLE event_replays
    ALTER COLUMN replay_type SET DEFAULT 'time_range',
    ALTER COLUMN replay_type SET NOT NULL,
    ALTER COLUMN initiated_by SET DEFAULT 'system',
    ALTER COLUMN initiated_by SET NOT NULL,
    ALTER COLUMN reason SET DEFAULT 'Legacy replay',
    ALTER COLUMN reason SET NOT NULL
  `.execute(db)

  await sql`
    ALTER TABLE event_store
    ADD COLUMN IF NOT EXISTS occurred_at timestamptz,
    ADD COLUMN IF NOT EXISTS received_at timestamptz,
    ADD COLUMN IF NOT EXISTS processed_at timestamptz,
    ADD COLUMN IF NOT EXISTS status text,
    ADD COLUMN IF NOT EXISTS expires_at timestamptz
  `.execute(db)

  await sql`
    DO $$
    DECLARE
      has_published_at boolean;
    BEGIN
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'event_store'
          AND column_name = 'published_at'
      ) INTO has_published_at;

      IF has_published_at THEN
        EXECUTE $sql$
          UPDATE event_store
          SET
            occurred_at = COALESCE(occurred_at, published_at, NOW()),
            received_at = COALESCE(received_at, published_at, occurred_at, NOW()),
            status = COALESCE(
              status,
              CASE WHEN processed_at IS NOT NULL THEN 'processed' ELSE 'pending' END
            )
          WHERE occurred_at IS NULL OR received_at IS NULL OR status IS NULL
        $sql$;
      ELSE
        EXECUTE $sql$
          UPDATE event_store
          SET
            occurred_at = COALESCE(occurred_at, NOW()),
            received_at = COALESCE(received_at, occurred_at, NOW()),
            status = COALESCE(
              status,
              CASE WHEN processed_at IS NOT NULL THEN 'processed' ELSE 'pending' END
            )
          WHERE occurred_at IS NULL OR received_at IS NULL OR status IS NULL
        $sql$;
      END IF;
    END
    $$;
  `.execute(db)

  await sql`
    ALTER TABLE event_store
    ALTER COLUMN occurred_at SET DEFAULT NOW(),
    ALTER COLUMN occurred_at SET NOT NULL,
    ALTER COLUMN received_at SET DEFAULT NOW(),
    ALTER COLUMN received_at SET NOT NULL,
    ALTER COLUMN status SET DEFAULT 'pending',
    ALTER COLUMN status SET NOT NULL
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_event_store_status ON event_store(status, occurred_at)
  `.execute(db)

  await sql`
    ALTER TABLE event_deliveries
    ADD COLUMN IF NOT EXISTS started_at timestamptz,
    ADD COLUMN IF NOT EXISTS completed_at timestamptz,
    ADD COLUMN IF NOT EXISTS duration_ms integer,
    ADD COLUMN IF NOT EXISTS success boolean,
    ADD COLUMN IF NOT EXISTS error_message text
  `.execute(db)

  await sql`
    DO $$
    DECLARE
      has_delivered_at boolean;
      has_created_at boolean;
      has_status boolean;
    BEGIN
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'event_deliveries'
          AND column_name = 'delivered_at'
      ) INTO has_delivered_at;

      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'event_deliveries'
          AND column_name = 'created_at'
      ) INTO has_created_at;

      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'event_deliveries'
          AND column_name = 'status'
      ) INTO has_status;

      IF has_delivered_at AND has_created_at AND has_status THEN
        EXECUTE $sql$
          UPDATE event_deliveries
          SET
            started_at = COALESCE(started_at, delivered_at, created_at, NOW()),
            completed_at = COALESCE(completed_at, delivered_at),
            duration_ms = COALESCE(duration_ms, 0),
            success = COALESCE(
              success,
              CASE
                WHEN status IN ('success', 'completed', 'delivered', 'processed') THEN true
                WHEN status IN ('failed', 'error', 'expired') THEN false
                ELSE false
              END
            )
          WHERE started_at IS NULL OR duration_ms IS NULL OR success IS NULL
        $sql$;
      ELSIF has_status THEN
        EXECUTE $sql$
          UPDATE event_deliveries
          SET
            started_at = COALESCE(started_at, NOW()),
            duration_ms = COALESCE(duration_ms, 0),
            success = COALESCE(
              success,
              CASE
                WHEN status IN ('success', 'completed', 'delivered', 'processed') THEN true
                WHEN status IN ('failed', 'error', 'expired') THEN false
                ELSE false
              END
            )
          WHERE started_at IS NULL OR duration_ms IS NULL OR success IS NULL
        $sql$;
      ELSE
        EXECUTE $sql$
          UPDATE event_deliveries
          SET
            started_at = COALESCE(started_at, NOW()),
            duration_ms = COALESCE(duration_ms, 0),
            success = COALESCE(success, false)
          WHERE started_at IS NULL OR duration_ms IS NULL OR success IS NULL
        $sql$;
      END IF;
    END
    $$;
  `.execute(db)

  await sql`
    ALTER TABLE event_deliveries
    ALTER COLUMN started_at SET DEFAULT NOW(),
    ALTER COLUMN started_at SET NOT NULL,
    ALTER COLUMN duration_ms SET DEFAULT 0,
    ALTER COLUMN duration_ms SET NOT NULL,
    ALTER COLUMN success SET DEFAULT false,
    ALTER COLUMN success SET NOT NULL
  `.execute(db)

  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'event_deliveries'
          AND column_name = 'subscriber_id'
      ) THEN
        EXECUTE 'ALTER TABLE event_deliveries ALTER COLUMN subscriber_id DROP NOT NULL';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'event_deliveries'
          AND column_name = 'status'
      ) THEN
        EXECUTE $cmd$ALTER TABLE event_deliveries ALTER COLUMN status SET DEFAULT 'completed'$cmd$;
      END IF;
    END
    $$;
  `.execute(db)
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // Forward-only alignment migration. Existing deployments may already rely on the added runtime columns.
}
