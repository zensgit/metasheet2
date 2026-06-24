// T9-R1: field create/update/delete now append a meta_config_revisions row in the SAME transaction. Mock route
// tests whose queryHandler throws on unrecognized SQL must accept that insert as a no-op so the route doesn't 500.
// Shared so the no-op lives in ONE place across the mock route tests.
export type ConfigRevisionMockResult = { rows: never[]; rowCount: number }

// Match ONLY the T9-R1 insert — not an accidental SELECT/UPDATE/DELETE on the table, which a future mock route test
// might legitimately want to handle itself rather than have silently swallowed.
export function configRevisionNoop(sql: string): ConfigRevisionMockResult | null {
  return /^\s*INSERT\s+INTO\s+meta_config_revisions\b/i.test(sql) ? { rows: [], rowCount: 0 } : null
}
