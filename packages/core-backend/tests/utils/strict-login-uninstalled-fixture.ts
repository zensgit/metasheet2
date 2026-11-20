/** Never-installed unit fixture only; unrelated queries remain owned by each suite. */
export function strictLoginUninstalledRows(sql: string): Record<string, unknown>[] | undefined {
  const statement = sql.replace(/\s+/g, ' ').trim()
  if (statement === 'SELECT candidate.nspname AS schema_name FROM pg_catalog.unnest(pg_catalog.current_schemas(false)) WITH ORDINALITY AS candidate(nspname, ord) ORDER BY candidate.ord') {
    return [{ schema_name: 'strict_login_uninstalled_fixture' }]
  }
  if (statement === 'SELECT 1 AS present FROM "strict_login_uninstalled_fixture"."kysely_migration" WHERE name = $1 LIMIT 1') {
    return []
  }
  if (
    statement.startsWith("SELECT 'table'::text AS kind, c.relname::text AS name FROM pg_catalog.pg_class c ")
    && ['function', 'trigger', 'check', 'index', 'column', 'named'].every((kind) => statement.includes(`UNION ALL SELECT '${kind}'::text AS kind, `))
    && statement.endsWith('WHERE n.nspname = $1 AND c.relname = ANY($2::text[])')
  ) {
    return []
  }
  return undefined
}
