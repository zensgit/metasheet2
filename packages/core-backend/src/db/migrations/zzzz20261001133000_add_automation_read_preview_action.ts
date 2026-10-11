import { sql, type Kysely } from 'kysely'
import { AUTOMATION_ACTION_TYPES_WITH_FWB } from './zzzz20260720120000_add_write_approval_form_values_automation_action'

export const AUTOMATION_ACTION_TYPES_WITH_INTEGRATION_READ_PREVIEW = [
  ...AUTOMATION_ACTION_TYPES_WITH_FWB,
  'integration_read_preview',
] as const

const signature = 'pg_catalog.text, pg_catalog.jsonb, pg_catalog.jsonb, pg_catalog.text, pg_catalog.text'
const quoted = (values: readonly string[]) => values.map(value => `'${value}'`).join(', ')

/** All interpolated expressions are migration-owned SQL identifiers. Traverse
 * action nodes only, never arbitrary user configuration/type fields. Include
 * the legacy root even when actions is present: a dormant branch cannot retain
 * a read node for a later reactivation. The same traversal guards rollback. */
function readNodes(actionType: string, config: string, actions: string): string {
  return `
    WITH RECURSIVE action_nodes(node) AS (
      (
        SELECT pg_catalog.jsonb_build_object('type', ${actionType}, 'config', ${config})
        UNION ALL
        SELECT a.value FROM pg_catalog.jsonb_array_elements(
          CASE WHEN pg_catalog.jsonb_typeof(${actions}) = 'array' THEN ${actions} ELSE '[]'::pg_catalog.jsonb END
        ) AS a(value)
      )
      UNION ALL
      SELECT child.node FROM action_nodes AS parent
      CROSS JOIN LATERAL (
        SELECT a.value AS node
        FROM pg_catalog.jsonb_array_elements(CASE
          WHEN parent.node->>'type' IN ('condition_branch', 'parallel_branch')
            AND pg_catalog.jsonb_typeof(parent.node#>'{config,branches}') = 'array'
          THEN parent.node#>'{config,branches}' ELSE '[]'::pg_catalog.jsonb END) AS branch(value)
        CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(CASE
          WHEN pg_catalog.jsonb_typeof(branch.value->'actions') = 'array'
          THEN branch.value->'actions' ELSE '[]'::pg_catalog.jsonb END) AS a(value)
        UNION ALL
        SELECT a.value AS node
        FROM pg_catalog.jsonb_array_elements(CASE
          WHEN parent.node->>'type' = 'condition_branch'
            AND pg_catalog.jsonb_typeof(parent.node#>'{config,defaultBranch,actions}') = 'array'
          THEN parent.node#>'{config,defaultBranch,actions}' ELSE '[]'::pg_catalog.jsonb END) AS a(value)
      ) AS child
    )
    SELECT 1 FROM action_nodes WHERE node->>'type' = 'integration_read_preview'
  `
}

/** Final-row shape protection; this is not execution or source authorization.
 * One atomic DO statement keeps standalone/repeated migration calls safe too. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
    DO $migration$
    DECLARE
      rule_table pg_catalog.regclass := 'automation_rules'::pg_catalog.regclass;
      rule_schema pg_catalog.text;
    BEGIN
      EXECUTE pg_catalog.format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE', rule_table);
      SELECT n.nspname INTO STRICT rule_schema FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = rule_table;
      EXECUTE pg_catalog.format($definition$
        CREATE OR REPLACE FUNCTION %I.automation_read_preview_row_valid(
          p_action_type pg_catalog.text, p_action_config pg_catalog.jsonb, p_actions pg_catalog.jsonb,
          p_execution_mode pg_catalog.text, p_trigger_type pg_catalog.text
        ) RETURNS pg_catalog.bool
        LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog
        AS $function$
          SELECT CASE WHEN p_action_type = 'integration_read_preview' THEN COALESCE(
            pg_catalog.jsonb_typeof(p_action_config) = 'object'
            AND p_action_config->>'operation' = 'plm.stock-preparation.diff-preview.v1'
            AND pg_catalog.jsonb_typeof(p_action_config->'allowManual') = 'boolean'
            AND p_action_config = pg_catalog.jsonb_build_object(
              'operation', 'plm.stock-preparation.diff-preview.v1', 'allowManual', p_action_config->'allowManual')
            AND (p_actions IS NULL OR p_actions = 'null'::pg_catalog.jsonb OR p_actions = '[]'::pg_catalog.jsonb
              OR p_actions = pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
                'type', 'integration_read_preview', 'config', p_action_config)))
            AND (p_execution_mode IS NULL OR p_execution_mode = 'legacy')
            AND p_trigger_type IN ('schedule.cron', 'schedule.interval', 'schedule.date_field',
              'record.created', 'record.updated', 'record.deleted', 'field.value_changed'),
            FALSE
          ) ELSE NOT EXISTS (${readNodes('p_action_type', 'p_action_config', 'p_actions')}) END
        $function$
      $definition$, rule_schema);
      EXECUTE pg_catalog.format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS chk_automation_action_type', rule_table);
      EXECUTE pg_catalog.format($constraint$
        ALTER TABLE %s ADD CONSTRAINT chk_automation_action_type
          CHECK (action_type IN (${quoted(AUTOMATION_ACTION_TYPES_WITH_INTEGRATION_READ_PREVIEW)}))
      $constraint$, rule_table);
      EXECUTE pg_catalog.format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS chk_automation_read_preview_shape', rule_table);
      EXECUTE pg_catalog.format($constraint$
        ALTER TABLE %s ADD CONSTRAINT chk_automation_read_preview_shape
          CHECK (%I.automation_read_preview_row_valid(action_type, action_config, actions, execution_mode, trigger_type) IS TRUE)
      $constraint$, rule_table, rule_schema);
      EXECUTE pg_catalog.format($index$
        CREATE INDEX IF NOT EXISTS idx_automation_read_rule_owner_options
          ON %s (sheet_id, created_by, id COLLATE "C")
          WHERE enabled AND action_type = 'integration_read_preview'
      $index$, rule_table);
    END
    $migration$;
  `).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
    DO $migration$
    DECLARE
      rule_table pg_catalog.regclass := 'automation_rules'::pg_catalog.regclass;
      rule_schema pg_catalog.text;
      has_read pg_catalog.bool;
    BEGIN
      EXECUTE pg_catalog.format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE', rule_table);
      SELECT n.nspname INTO STRICT rule_schema FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = rule_table;
      -- Inline traversal also works after a prior down removed the helper. Do
      -- not delete, rewrite, or silently detach any retained read rule.
      EXECUTE pg_catalog.format($guard$
        SELECT EXISTS (SELECT 1 FROM %s AS r WHERE EXISTS (
          ${readNodes('r.action_type', 'r.action_config', 'r.actions')}
        ))
      $guard$, rule_table) INTO has_read;
      IF has_read THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_READ_PREVIEW_ACTION_IN_USE';
      END IF;
      EXECUTE pg_catalog.format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS chk_automation_read_preview_shape', rule_table);
      EXECUTE pg_catalog.format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS chk_automation_action_type', rule_table);
      EXECUTE pg_catalog.format($constraint$
        ALTER TABLE %s ADD CONSTRAINT chk_automation_action_type
          CHECK (action_type IN (${quoted(AUTOMATION_ACTION_TYPES_WITH_FWB)}))
      $constraint$, rule_table);
      EXECUTE pg_catalog.format('DROP INDEX IF EXISTS %I.idx_automation_read_rule_owner_options', rule_schema);
      EXECUTE pg_catalog.format('DROP FUNCTION IF EXISTS %I.automation_read_preview_row_valid(${signature})', rule_schema);
    END
    $migration$;
  `).execute(db)
}
