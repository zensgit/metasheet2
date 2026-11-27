import { sql, type Kysely } from 'kysely'

// The acknowledgement audit is append-only. A null value on older rows selects the historical default.
export const YIDA_ACK_BUSINESS_TIMEZONE_UP_SQL = `
ALTER TABLE integration_yida_delivery_audit
  ADD COLUMN IF NOT EXISTS ack_time_zone text,
  DROP CONSTRAINT IF EXISTS integration_yida_ack_time_zone_shape,
  ADD CONSTRAINT integration_yida_ack_time_zone_shape
    CHECK (ack_time_zone IS NULL OR (event = 'acknowledgement' AND length(ack_time_zone) BETWEEN 1 AND 128));
`

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(YIDA_ACK_BUSINESS_TIMEZONE_UP_SQL).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $ack_zone_down$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = to_regclass('integration_yida_delivery_audit')
          AND attname = 'ack_time_zone' AND NOT attisdropped
      ) THEN
        IF EXISTS (SELECT 1 FROM integration_yida_delivery_audit WHERE ack_time_zone IS NOT NULL) THEN
          RAISE EXCEPTION 'YIDA_ACK_BUSINESS_TIMEZONE_ROWS_PRESENT' USING ERRCODE = '55000';
        END IF;
        ALTER TABLE integration_yida_delivery_audit DROP COLUMN ack_time_zone;
      END IF;
    END;
    $ack_zone_down$;
  `.execute(db)
}
