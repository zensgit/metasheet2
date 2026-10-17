import { sql, type Kysely } from 'kysely'

/**
 * DB-owned rule incarnation/snapshot nonce for bounded Integration read grants.
 * This is neither a tenant mapping nor authorization by itself. Grant consumers
 * must separately revalidate current actor, owner, scope and every source pin.
 * Include all raw columns (including updated_at and future columns): no semantic
 * normalizer, wall-clock precision or A -> B -> A edit may resurrect a grant.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS integration_authority_revision UUID;
    UPDATE automation_rules SET integration_authority_revision = pg_catalog.gen_random_uuid()
      WHERE integration_authority_revision IS NULL;
    ALTER TABLE automation_rules
      ALTER COLUMN integration_authority_revision SET DEFAULT pg_catalog.gen_random_uuid(),
      ALTER COLUMN integration_authority_revision SET NOT NULL;

    CREATE OR REPLACE FUNCTION automation_rule_authority_revision() RETURNS TRIGGER
    LANGUAGE plpgsql SET search_path = pg_catalog AS $$
    BEGIN
      IF TG_OP = 'INSERT' OR
        (pg_catalog.to_jsonb(NEW) - 'integration_authority_revision') IS DISTINCT FROM
        (pg_catalog.to_jsonb(OLD) - 'integration_authority_revision') THEN
        NEW.integration_authority_revision := pg_catalog.gen_random_uuid();
      ELSE
        NEW.integration_authority_revision := OLD.integration_authority_revision;
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS automation_rule_authority_revision ON automation_rules;
    CREATE TRIGGER automation_rule_authority_revision BEFORE INSERT OR UPDATE ON automation_rules
      FOR EACH ROW EXECUTE FUNCTION automation_rule_authority_revision();
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Rule first is the grant writer's order too. The grants SHARE lock prevents a
  // concurrent insert between the history check and removing the rule fence.
  // Refuse for *any* retained grant (including revoked/expired), not only active
  // grants: rollback must not silently detach historical authority evidence.
  await sql`
    LOCK TABLE automation_rules IN ACCESS EXCLUSIVE MODE;
    DO $$
    DECLARE
      rule_schema TEXT;
      grant_table REGCLASS;
      has_grants BOOLEAN;
    BEGIN
      SELECT n.nspname INTO STRICT rule_schema
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE c.oid = 'automation_rules'::pg_catalog.regclass;
      grant_table := pg_catalog.to_regclass(pg_catalog.format('%I.integration_automation_read_grants', rule_schema));
      IF grant_table IS NOT NULL THEN
        EXECUTE pg_catalog.format('LOCK TABLE %s IN SHARE MODE', grant_table);
        EXECUTE pg_catalog.format('SELECT EXISTS (SELECT 1 FROM %s)', grant_table) INTO has_grants;
        IF has_grants THEN
          RAISE EXCEPTION USING ERRCODE = '55000',
            MESSAGE = 'AUTOMATION_RULE_AUTHORITY_REVISION_HAS_GRANT_HISTORY';
        END IF;
      END IF;
    END $$;
    DROP TRIGGER IF EXISTS automation_rule_authority_revision ON automation_rules;
    DROP FUNCTION IF EXISTS automation_rule_authority_revision();
    ALTER TABLE automation_rules DROP COLUMN IF EXISTS integration_authority_revision;
  `.execute(db)
}
