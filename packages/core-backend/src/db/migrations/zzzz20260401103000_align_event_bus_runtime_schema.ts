import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
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
