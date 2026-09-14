import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const body = `
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.dispatch_state = 'idle' THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'NOTIFICATION_EFFECT_IMMUTABLE';
  END IF;
  IF OLD.dispatch_state = NEW.dispatch_state THEN RETURN NEW; END IF;
  IF OLD.dispatch_state = 'idle' AND NEW.dispatch_state = 'claimed' THEN RETURN NEW; END IF;
  IF OLD.dispatch_state = 'claimed' AND NEW.dispatch_state IN ('sent', 'failed') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'NOTIFICATION_EFFECT_IMMUTABLE';
END;
`.trim()

export async function up(db: Kysely<unknown>): Promise<void> {
  const present = await sql<{ present: boolean }>`SELECT EXISTS (
    SELECT 1 FROM pg_attribute WHERE attrelid = 'elearning_notification_deliveries'::regclass
      AND attname = 'dispatch_state' AND NOT attisdropped
  ) AS present`.execute(db)
  if (!present.rows[0]?.present) {
    await sql`ALTER TABLE elearning_notification_deliveries
      ADD COLUMN dispatch_state text NOT NULL DEFAULT 'idle',
      ADD CONSTRAINT elearning_notification_dispatch_state_chk
        CHECK (dispatch_state IN ('idle', 'claimed', 'sent', 'failed'))`.execute(db)
    await sql.raw(`CREATE FUNCTION elearning_notification_dispatch_guard() RETURNS trigger
      LANGUAGE plpgsql AS $f$${body}$f$`).execute(db)
    await sql`CREATE TRIGGER trg_elearning_notification_dispatch_guard
      BEFORE INSERT OR UPDATE ON elearning_notification_deliveries FOR EACH ROW
      EXECUTE FUNCTION elearning_notification_dispatch_guard()`.execute(db)
  }
  const proof = await sql<{
    not_null: boolean; typ: string; default_expr: string; check_expr: string
    prosrc: string; language: string; result: string; security: boolean
    tgtype: number; enabled: string; no_when: boolean; no_columns: boolean; function_matches: boolean
  }>`SELECT a.attnotnull AS not_null, a.atttypid::regtype::text AS typ,
      pg_get_expr(d.adbin,d.adrelid) AS default_expr,
      pg_get_constraintdef(c.oid) AS check_expr,
      p.prosrc, l.lanname AS language, p.prorettype::regtype::text AS result,
      p.prosecdef AS security, t.tgtype, t.tgenabled AS enabled,
      t.tgqual IS NULL AS no_when, t.tgattr = ''::int2vector AS no_columns,
      t.tgfoid = p.oid AS function_matches
    FROM pg_attribute a
    JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    JOIN pg_constraint c ON c.conrelid=a.attrelid AND c.conname='elearning_notification_dispatch_state_chk'
    JOIN pg_trigger t ON t.tgrelid=a.attrelid AND t.tgname='trg_elearning_notification_dispatch_guard'
    JOIN pg_proc p ON p.oid=to_regprocedure(current_schema() || '.elearning_notification_dispatch_guard()')
    JOIN pg_language l ON l.oid=p.prolang
    WHERE a.attrelid='elearning_notification_deliveries'::regclass
      AND a.attname='dispatch_state' AND NOT a.attisdropped`.execute(db)
  const row = proof.rows[0]
  if (proof.rows.length !== 1 || !row || row.not_null !== true || row.typ !== 'text'
    || row.default_expr !== "'idle'::text"
    || row.check_expr !== "CHECK ((dispatch_state = ANY (ARRAY['idle'::text, 'claimed'::text, 'sent'::text, 'failed'::text])))"
    || row.prosrc.trim() !== body || row.language !== 'plpgsql' || row.result !== 'trigger'
    || row.security !== false || row.tgtype !== 23 || row.enabled !== 'O'
    || !row.no_when || !row.no_columns || !row.function_matches) {
    throw new Error('NOTIFICATION_DISPATCH_MIGRATION_DRIFT')
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Never remove the only durable proof that an external effect may have happened.
  await sql`LOCK TABLE elearning_notification_deliveries IN ACCESS EXCLUSIVE MODE`.execute(db)
  const result = await sql<{ present: boolean }>`SELECT EXISTS (
    SELECT 1 FROM elearning_notification_deliveries WHERE dispatch_state <> 'idle'
  ) AS present`.execute(db)
  if (result.rows[0]?.present) throw new Error('NOTIFICATION_EFFECT_ROLLBACK_BLOCKED')
  await sql`DROP TRIGGER trg_elearning_notification_dispatch_guard ON elearning_notification_deliveries`.execute(db)
  await sql`DROP FUNCTION elearning_notification_dispatch_guard()`.execute(db)
  await sql`ALTER TABLE elearning_notification_deliveries DROP COLUMN dispatch_state`.execute(db)
}
