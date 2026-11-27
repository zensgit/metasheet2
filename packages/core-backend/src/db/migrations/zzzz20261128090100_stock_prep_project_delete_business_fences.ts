import { sql, type Kysely } from 'kysely'

// Frozen schema of the ledgers inventoried for stock-preparation project deletion. Writers
// take shared transaction locks for their projected OLD and NEW ownership, including parent
// rows named by logical references without FKs. No backup, source BOM or detail is serialized.
type ParentReference = [column: string, parent: string, jsonPath?: string]
type Ledger = { writeKey?: boolean, parents?: ParentReference[] }
const ledgers: Record<string, Ledger> = {
  sheet_repair_claim: { parents: [['run_id', 'sheet_repair_run']] },
  sheet_repair_run: { writeKey: true, parents: [['source_run_id', 'sheet_repair_run']] },
  refresh_execution_intent: { writeKey: true, parents: [['execution_id', 'refresh_execution']] },
  pull_batch_execution: { parents: [['batch_id', 'pull_batch'], ['refresh_execution_id', 'refresh_execution']] },
  pull_batch: {},
  pull_batch_sheet: {},
  reviewed_cell: { writeKey: true, parents: [['change_plan_id', 'change_plan']] },
  change_plan: {
    writeKey: true,
    parents: [
      ['execution_id', 'refresh_execution'], ['superseded_by', 'change_plan'], ['recovered_from_change_plan_id', 'change_plan'],
      ['absorbed_change_plan_ids', 'change_plan', '$[*]'], ['hold_ids', 'refresh_hold', '$[*]'],
      ['continuation_ids', 'continuation', '$[*]'],
    ],
  },
  refresh_hold: { writeKey: true, parents: [['continuation_id', 'continuation']] },
  refresh_state: { writeKey: true, parents: [['settled_execution_id', 'refresh_execution']] },
  refresh_execution: {
    writeKey: true,
    parents: [
      ['refresh_binding', 'change_plan', '$.changePlanId'],
      ['refresh_binding', 'continuation', '$.continuations[*].id'],
    ],
  },
  continuation_member: { writeKey: true, parents: [['continuation_id', 'continuation']] },
  continuation: { writeKey: true, parents: [['executed_execution_id', 'refresh_execution']] },
  component_ruling: {},
}
const opaque: Record<string, [key: string, column: string]> = {
  pack_installs: ['pack', 'object_id'],
  confirmation_reconcile_lease: ['lease', 'scope_key'],
  project_write_lock: ['write', 'scope_key'],
}
const tables = [...Object.keys(ledgers), ...Object.keys(opaque), 'handoff']
const tableName = (table: string) => 'public.integration_stock_prep_' + table
const fn = (table: string) => 'public.sp_delete_business_' + table
const trigger = 'stock_prep_project_delete_business_write'

function fence(table: string, row: 'OLD' | 'NEW') {
  const tagged = (type: string, col: string) => `'${type}:' || ${row}.${col}`
  const keys: string[] = []
  if (ledgers[table]) {
    const ledger = ledgers[table]
    keys.push(`SELECT ${tagged('sheet', 'sheet_id')}`)
    if (ledger.writeKey) keys.push(`SELECT ${tagged('write', 'write_scope_key')}`)
    for (const [column, parent, path] of ledger.parents ?? []) {
      // Each lookup uses the parent's primary key. The JSON paths are those used by the
      // inventory for arrays of id strings and the structured refresh binding.
      const predicate = path
        ? `p.id IN (SELECT value #>> '{}' FROM jsonb_path_query(${row}.${column}, '${path}') AS ref(value))`
        : `p.id = ${row}.${column}`
      keys.push(`SELECT 'sheet:' || p.sheet_id FROM ${tableName(parent)} p WHERE ${predicate}`)
    }
  } else if (opaque[table]) {
    keys.push(`SELECT ${tagged(...opaque[table])}`)
  }
  // Exact JSON.stringify([tenantId, projectNo]) representation used by the project activity
  // lock. json_build_array(... )::text inserts a space and would acquire a different lock.
  const project = `'[' || to_json(${row}.tenant_id)::text || ',' || to_json(${row}.project_no)::text || ']'`
  return [
    ...(opaque[table] ? [] : [`IF NOT pg_try_advisory_xact_lock_shared(6991, hashtext(${project})) THEN
      RAISE EXCEPTION USING ERRCODE = '55P03', MESSAGE = 'stock preparation project busy'; END IF;`]),
    ...(keys.length ? [`PERFORM public.stock_prep_project_delete_fence(ARRAY(${keys.join(' UNION ALL ')}), true);`] : []),
  ].join('\n')
}

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const table of tables) {
    await sql.raw(`CREATE FUNCTION ${fn(table)}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog SET row_security = off AS $fn$
      BEGIN
        IF TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME <> 'integration_stock_prep_${table}' THEN
          RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'invalid project fence trigger context';
        END IF;
        IF TG_OP <> 'INSERT' THEN ${fence(table, 'OLD')} END IF;
        IF TG_OP <> 'DELETE' THEN ${fence(table, 'NEW')} RETURN NEW; END IF;
        RETURN OLD;
      END $fn$`).execute(db)
    // Reading the indexed parent sheet as the migration owner preserves column-only write grants.
    await sql.raw(`REVOKE ALL ON FUNCTION ${fn(table)}() FROM PUBLIC`).execute(db)
    await sql.raw(`CREATE TRIGGER ${trigger} BEFORE INSERT OR UPDATE OR DELETE ON ${tableName(table)}
      FOR EACH ROW EXECUTE FUNCTION ${fn(table)}()`).execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of tables) {
    await sql.raw(`DROP TRIGGER ${trigger} ON ${tableName(table)}`).execute(db)
    await sql.raw(`DROP FUNCTION ${fn(table)}()`).execute(db)
  }
}
