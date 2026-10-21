import { sql, type Kysely } from 'kysely'
import { AUTOMATION_ACTION_TYPES_WITH_INTEGRATION_READ_PREVIEW } from './zzzz20261001133000_add_automation_read_preview_action'

export const AUTOMATION_ACTION_TYPES_WITH_AUTHORIZED_YIDA = [
  ...AUTOMATION_ACTION_TYPES_WITH_INTEGRATION_READ_PREVIEW, 'integration_yida_send_authorized',
] as const
const quoted = (values: readonly string[]) => values.map(value => `'${value}'`).join(', ')
const signature = 'pg_catalog.text, pg_catalog.jsonb, pg_catalog.jsonb, pg_catalog.text, pg_catalog.text, pg_catalog.jsonb, pg_catalog.jsonb'

// Migration-owned expressions only. Traverse executable nodes, not arbitrary
// type-looking data; the dormant legacy pair remains covered too.
function nodes(type: string, config: string, actions: string): string {
  return `WITH RECURSIVE action_nodes(node) AS (
    (SELECT pg_catalog.jsonb_build_object('type', ${type}, 'config', ${config})
      UNION ALL SELECT a.value FROM pg_catalog.jsonb_array_elements(CASE
        WHEN pg_catalog.jsonb_typeof(${actions})='array' THEN ${actions} ELSE '[]'::pg_catalog.jsonb END) a(value))
    UNION ALL SELECT child.node FROM action_nodes parent CROSS JOIN LATERAL (
      SELECT a.value AS node FROM pg_catalog.jsonb_array_elements(CASE
        WHEN parent.node->>'type' IN ('condition_branch','parallel_branch')
          AND pg_catalog.jsonb_typeof(parent.node#>'{config,branches}')='array'
        THEN parent.node#>'{config,branches}' ELSE '[]'::pg_catalog.jsonb END) branch(value)
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(CASE
        WHEN pg_catalog.jsonb_typeof(branch.value->'actions')='array' THEN branch.value->'actions' ELSE '[]'::pg_catalog.jsonb END) a(value)
      UNION ALL SELECT a.value AS node FROM pg_catalog.jsonb_array_elements(CASE
        WHEN parent.node->>'type'='condition_branch' AND pg_catalog.jsonb_typeof(parent.node#>'{config,defaultBranch,actions}')='array'
        THEN parent.node#>'{config,defaultBranch,actions}' ELSE '[]'::pg_catalog.jsonb END) a(value)
    ) child
  ) SELECT 1 FROM action_nodes WHERE node->>'type'='integration_yida_send_authorized'`
}
/** Final-row authoring protection only: no grant, principal, sender or scheduler.
 * The old read-action constraint is deliberately retained unchanged. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`DO $migration$
    DECLARE rule_table pg_catalog.regclass := 'automation_rules'::pg_catalog.regclass; rule_schema pg_catalog.text;
    BEGIN
      EXECUTE pg_catalog.format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE',rule_table);
      SELECT n.nspname INTO STRICT rule_schema FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=rule_table;
      EXECUTE pg_catalog.format($definition$
        CREATE OR REPLACE FUNCTION %I.automation_yida_authorized_row_valid(
          p_type pg_catalog.text,p_config pg_catalog.jsonb,p_actions pg_catalog.jsonb,p_mode pg_catalog.text,
          p_trigger pg_catalog.text,p_trigger_config pg_catalog.jsonb,p_conditions pg_catalog.jsonb
        ) RETURNS pg_catalog.bool LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $function$
          SELECT CASE WHEN p_type='integration_yida_send_authorized' THEN COALESCE(
            pg_catalog.jsonb_typeof(p_config)='object'
            AND pg_catalog.jsonb_typeof(p_config->'authorizationSlot')='string'
            AND p_config=pg_catalog.jsonb_build_object('authorizationSlot',p_config->'authorizationSlot')
            AND pg_catalog.char_length(p_config->>'authorizationSlot') BETWEEN 1 AND 128
            AND p_config->>'authorizationSlot'=pg_catalog.btrim(p_config->>'authorizationSlot')
            AND (p_config->>'authorizationSlot') !~ '[[:cntrl:]]'
            AND (p_actions IS NULL OR p_actions='null'::pg_catalog.jsonb OR p_actions='[]'::pg_catalog.jsonb
              OR p_actions=pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('type','integration_yida_send_authorized','config',p_config)))
            AND (p_mode IS NULL OR p_mode='legacy') AND p_trigger='schedule.interval'
            AND (p_conditions IS NULL OR p_conditions='null'::pg_catalog.jsonb OR p_conditions='[]'::pg_catalog.jsonb)
            AND pg_catalog.jsonb_typeof(p_trigger_config)='object'
            AND p_trigger_config=pg_catalog.jsonb_build_object('intervalMs',p_trigger_config->'intervalMs')
            AND CASE WHEN pg_catalog.jsonb_typeof(p_trigger_config->'intervalMs')='number' THEN
              (p_trigger_config->>'intervalMs')::pg_catalog.numeric BETWEEN 1000 AND 2147483647
              AND pg_catalog.trunc((p_trigger_config->>'intervalMs')::pg_catalog.numeric)=(p_trigger_config->>'intervalMs')::pg_catalog.numeric
              ELSE FALSE END, FALSE)
          ELSE NOT EXISTS (${nodes('p_type', 'p_config', 'p_actions')}) END
        $function$
      $definition$,rule_schema);
      EXECUTE pg_catalog.format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS chk_automation_action_type',rule_table);
      EXECUTE pg_catalog.format($constraint$ALTER TABLE %s ADD CONSTRAINT chk_automation_action_type CHECK (action_type IN (${quoted(AUTOMATION_ACTION_TYPES_WITH_AUTHORIZED_YIDA)}))$constraint$,rule_table);
      EXECUTE pg_catalog.format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS chk_automation_yida_authorized_shape',rule_table);
      EXECUTE pg_catalog.format('ALTER TABLE %s ADD CONSTRAINT chk_automation_yida_authorized_shape CHECK (%I.automation_yida_authorized_row_valid(action_type,action_config,actions,execution_mode,trigger_type,trigger_config,conditions) IS TRUE)',rule_table,rule_schema);
    END $migration$`).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`DO $migration$
    DECLARE rule_table pg_catalog.regclass := 'automation_rules'::pg_catalog.regclass; rule_schema pg_catalog.text;
      in_use pg_catalog.bool; grant_table pg_catalog.regclass;
    BEGIN
      EXECUTE pg_catalog.format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE',rule_table);
      SELECT n.nspname INTO STRICT rule_schema FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=rule_table;
      EXECUTE pg_catalog.format($guard$ SELECT EXISTS (SELECT 1 FROM %s r WHERE EXISTS (${nodes('r.action_type', 'r.action_config', 'r.actions')})) $guard$,rule_table) INTO in_use;
      IF in_use THEN RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='AUTOMATION_YIDA_ACTION_IN_USE'; END IF;
      grant_table := pg_catalog.to_regclass(pg_catalog.format('%I.integration_yida_auto_grants',rule_schema));
      IF grant_table IS NOT NULL THEN
        EXECUTE pg_catalog.format('LOCK TABLE %s IN SHARE MODE',grant_table);
        EXECUTE pg_catalog.format('SELECT EXISTS (SELECT 1 FROM %s)',grant_table) INTO in_use;
        IF in_use THEN RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='AUTOMATION_YIDA_ACTION_HAS_GRANT_HISTORY'; END IF;
      END IF;
      EXECUTE pg_catalog.format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS chk_automation_yida_authorized_shape',rule_table);
      EXECUTE pg_catalog.format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS chk_automation_action_type',rule_table);
      EXECUTE pg_catalog.format($constraint$ALTER TABLE %s ADD CONSTRAINT chk_automation_action_type CHECK (action_type IN (${quoted(AUTOMATION_ACTION_TYPES_WITH_INTEGRATION_READ_PREVIEW)}))$constraint$,rule_table);
      EXECUTE pg_catalog.format('DROP FUNCTION IF EXISTS %I.automation_yida_authorized_row_valid(${signature})',rule_schema);
    END $migration$`).execute(db)
}
