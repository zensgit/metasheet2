import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'

/** Synthetic prerequisites only. Callers apply the actual read-execution
 * migration afterwards; none of its constraints/triggers are reproduced here.
 * This helper must only run in the caller's already-owned random test schema.
 */
export async function createAutomationReadExecutionLogSchema(query: Queryable): Promise<void> {
  await query.query(`CREATE TABLE multitable_automation_executions (
    id text PRIMARY KEY, rule_id text NOT NULL, triggered_by text NOT NULL DEFAULT 'event',
    triggered_at timestamptz NOT NULL DEFAULT now(), status text NOT NULL DEFAULT 'running',
    steps jsonb NOT NULL DEFAULT '[]', error text, duration integer,
    created_at timestamptz NOT NULL DEFAULT now(), sheet_id text, trigger_event jsonb,
    rule_snapshot jsonb, finished_at timestamptz, schema_version integer NOT NULL DEFAULT 1,
    rerun_of_execution_id text, initiated_by text, rule_action_fingerprint text
  )`)
}

/** Test-owner reset only, never a production bypass. Production guards stay
 * enabled before returning, and no existing/public/deployment schema qualifies.
 */
export async function resetAutomationReadExecutionLinks(query: Queryable, ownedReset?: () => Promise<void>): Promise<void> {
  await resetOwnedHistory(query, ['integration_automation_read_executions', 'integration_automation_read_record_activations'], ownedReset)
}

/** SA-06V fixtures without execution-audit tables still apply the real purpose
 * migration. Its immutable activation rows need the same owned-schema reset. */
export async function resetAutomationReadRecordActivations(query: Queryable, ownedReset: () => Promise<void>): Promise<void> {
  await resetOwnedHistory(query, ['integration_automation_read_record_activations'], ownedReset)
}

async function resetOwnedHistory(query: Queryable, names: string[], ownedReset?: () => Promise<void>): Promise<void> {
  const row = (await query.query('SELECT current_schema() AS owned_schema')).rows[0]
  if (typeof row?.owned_schema !== 'string'
    || !/^(?:automation_read_[a-z_]+|automation_authority|audit)_[a-f0-9]{16}$/u.test(row.owned_schema)) {
    throw new Error('UNOWNED_AUTOMATION_READ_TEST_SCHEMA')
  }
  const tables = names.map(name => '"' + row.owned_schema + '".' + name)
  const disabled: string[] = []
  try {
    for (const table of tables) {
      await query.query('ALTER TABLE ' + table + ' DISABLE TRIGGER USER')
      disabled.push(table)
    }
    // A parent request TRUNCATE must name the child link in the same statement
    // even when empty; callers may put their owned whole-fixture reset here.
    if (ownedReset) await ownedReset()
    else await query.query('TRUNCATE ' + tables.join(','))
  }
  finally { for (const table of disabled.reverse()) await query.query('ALTER TABLE ' + table + ' ENABLE TRIGGER USER') }
}
