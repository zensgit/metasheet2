import { sql, type Kysely } from 'kysely'
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE plm_personal_approval_bindings (
      id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id), connection_id text NOT NULL,
      subject_id text NOT NULL, tenant_id text NOT NULL, org_id text NOT NULL, grant_id text NOT NULL,
      expires_at timestamptz NOT NULL, encrypted_grant text, generation integer NOT NULL DEFAULT 1, reconcile_cursor uuid,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(owner_id,connection_id), UNIQUE(connection_id,tenant_id,org_id,subject_id)
    );
    CREATE SEQUENCE plm_personal_task_epoch AS integer;
    CREATE TABLE plm_personal_approval_tasks (
      id uuid PRIMARY KEY, binding_id uuid NOT NULL REFERENCES plm_personal_approval_bindings(id),
      source_task_id uuid NOT NULL, source_round_id uuid NOT NULL, source_eco_id uuid NOT NULL,
      source_stage_id uuid NOT NULL, entry_epoch integer NOT NULL DEFAULT nextval('plm_personal_task_epoch') UNIQUE,
      task jsonb NOT NULL, active boolean NOT NULL DEFAULT true, seat_status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(binding_id,source_task_id,source_round_id)
    );
    ALTER TABLE dingtalk_approval_card_deliveries ALTER COLUMN instance_id DROP NOT NULL;
    ALTER TABLE dingtalk_approval_card_deliveries ADD COLUMN plm_task_id uuid REFERENCES plm_personal_approval_tasks(id);
    ALTER TABLE dingtalk_approval_card_deliveries ADD CONSTRAINT dacd_exact_source CHECK ((instance_id IS NOT NULL)::int + (plm_task_id IS NOT NULL)::int = 1);
    CREATE UNIQUE INDEX dacd_plm_task_once ON dingtalk_approval_card_deliveries(plm_task_id,entry_epoch) WHERE plm_task_id IS NOT NULL;
    CREATE TABLE plm_personal_approval_commands (
      id uuid PRIMARY KEY, delivery_id text NOT NULL UNIQUE REFERENCES dingtalk_approval_card_deliveries(id),
      task_id uuid NOT NULL REFERENCES plm_personal_approval_tasks(id), binding_id uuid NOT NULL REFERENCES plm_personal_approval_bindings(id),
      subject_id text NOT NULL, connection_id text NOT NULL, tenant_id text NOT NULL, org_id text NOT NULL,
      original_grant_id text NOT NULL, command jsonb NOT NULL, request_hash text NOT NULL,
      receipt jsonb, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','settled')),
      created_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz,
      CHECK((state='settled')=(receipt IS NOT NULL AND settled_at IS NOT NULL))
    );
    CREATE FUNCTION plm_personal_command_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' OR (to_jsonb(NEW)-'receipt'-'state'-'settled_at') IS DISTINCT FROM (to_jsonb(OLD)-'receipt'-'state'-'settled_at')
        OR (OLD.state='settled' AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'plm_command_immutable' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER plm_personal_command_immutable BEFORE UPDATE OR DELETE ON plm_personal_approval_commands FOR EACH ROW EXECUTE FUNCTION plm_personal_command_immutable();
  `.execute(db)
}
export async function down(db: Kysely<unknown>): Promise<void> {
  // Lock every table whose retained evidence or shape is affected before the check.
  // One batch keeps these locks through DROP even for an autocommit caller.
  await sql`LOCK TABLE plm_personal_approval_bindings,plm_personal_approval_tasks,
    plm_personal_approval_commands,dingtalk_approval_card_deliveries IN ACCESS EXCLUSIVE MODE NOWAIT;
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM plm_personal_approval_bindings) THEN RAISE EXCEPTION 'plm_personal_evidence_present'; END IF; END $$;
    DROP TABLE plm_personal_approval_commands; DROP FUNCTION plm_personal_command_immutable();
    ALTER TABLE dingtalk_approval_card_deliveries DROP CONSTRAINT dacd_exact_source;
    DROP INDEX dacd_plm_task_once; ALTER TABLE dingtalk_approval_card_deliveries DROP COLUMN plm_task_id;
    ALTER TABLE dingtalk_approval_card_deliveries ALTER COLUMN instance_id SET NOT NULL;
    DROP TABLE plm_personal_approval_tasks; DROP SEQUENCE plm_personal_task_epoch; DROP TABLE plm_personal_approval_bindings;`.execute(db)
}
