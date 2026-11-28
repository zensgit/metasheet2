import { sql, type Kysely } from 'kysely'

// The provider stores jobs and approvals in the shared host KV. Freeze the same ownership
// fields the collector recognizes. Other plugins skip the trigger function completely.
const plugin = 'plugin-integration-core'
const background = 'stock-preparation:large-bom:background:'
const checkpoint = 'stock-preparation:large-bom:apply:'
const trial = 'stock-preparation:dry-run-job:'
const token = 'integration:table-action:dry-run-token:'
const receipt = 'integration:stock-prep:refresh-read-receipt:'
const reminder = 'stockPrepManualRows:lastPull:v1:'
const policy = 'integration:table-action:conflict-policies:'
const functionName = 'public.stock_prep_project_delete_runtime_write'

function project(tenant: string, no: string) {
  return `'runtime-project:[' || to_json(${tenant})::text || ',' || to_json(${no})::text || ']'`
}

function fence(row: 'OLD' | 'NEW') {
  const key = row + '.key'
  const value = row + '.value'
  const tenant = `(${value}->>'tenantId')`
  const match = (prefix: string) => `starts_with(${key}, '${prefix}')`
  return `IF ${row}.plugin = '${plugin}' THEN
    CASE
      WHEN ${match(background)} THEN
        keys := ARRAY['sheet:' || (${value}#>>'{actionSnapshot,target,sheetId}'), ${project(tenant, `(${value}#>>'{parameters,projectNo}')`)}];
      WHEN ${match(checkpoint)} THEN
        -- The producer's primary key is (plugin, background:tenant:workspace:action:job).
        -- A forged sheet on a checkpoint cannot hide a real target parent.
        SELECT ARRAY['sheet:' || (p.value#>>'{actionSnapshot,target,sheetId}'),
          ${project("(p.value->>'tenantId')", "(p.value#>>'{parameters,projectNo}')")}]
          INTO keys FROM public.plugin_kv p WHERE p.plugin = '${plugin}'
          AND p.key = '${background}' || ${tenant} || ':' || (${value}->>'workspaceId')
            || ':' || (${value}->>'actionId') || ':' || (${value}->>'sourceJobId');
        keys := array_append(keys, 'sheet:' || (${value}#>>'{target,sheetId}'));
      WHEN ${match(trial)} THEN
        keys := ARRAY['trial-target:' || (${value}->>'targetKey')];
      WHEN ${match(token)} THEN
        keys := ARRAY['trial-token-sheet:' || (${value}->>'writeScope'),
          'trial-token:' || (${value}->>'writeScope') || ':' || (${value}->>'parametersHash')];
      WHEN ${match(receipt)} THEN
        keys := ARRAY[${project(tenant, `(${value}->>'projectNo')`)}];
      WHEN ${match(reminder)} THEN
        keys := ARRAY['sheet:' || substr(${key}, ${reminder.length + 1})];
      WHEN ${match(policy)} THEN
        keys := ARRAY['policy:' || ${key}, 'policy-fp:' || (${value}->>'targetScopeFingerprint')];
      ELSE keys := NULL;
    END CASE;
    IF keys IS NOT NULL THEN PERFORM public.stock_prep_project_delete_fence(keys, true); END IF;
  END IF;`
}

const events = [
  ['insert', `NEW.plugin = '${plugin}'`],
  ['delete', `OLD.plugin = '${plugin}'`],
  ['update', `OLD.plugin = '${plugin}' OR NEW.plugin = '${plugin}'`],
] as const

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp SET row_security = off AS $fn$
    DECLARE keys text[];
    BEGIN
      IF TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME <> 'plugin_kv' THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'invalid project fence trigger context';
      END IF;
      IF TG_OP <> 'INSERT' THEN ${fence('OLD')} END IF;
      IF TG_OP <> 'DELETE' THEN ${fence('NEW')} RETURN NEW; END IF;
      RETURN OLD;
    END $fn$`).execute(db)
  await sql.raw(`REVOKE ALL ON FUNCTION ${functionName}() FROM PUBLIC`).execute(db)
  for (const [event, condition] of events) {
    await sql.raw(`CREATE TRIGGER stock_prep_project_delete_kv_${event} BEFORE ${event} ON public.plugin_kv
      FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION ${functionName}()`).execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const [event] of events) await sql.raw(`DROP TRIGGER stock_prep_project_delete_kv_${event} ON public.plugin_kv`).execute(db)
  await sql.raw(`DROP FUNCTION ${functionName}()`).execute(db)
}
