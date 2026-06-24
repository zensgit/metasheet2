// T9-R1: field create/update/delete now append a meta_config_revisions row in the SAME transaction. Mock route
// tests whose queryHandler throws on unrecognized SQL must accept that insert as a no-op so the route doesn't 500.
// Shared so the no-op lives in ONE place across the mock route tests.
export type ConfigRevisionMockResult = { rows: never[]; rowCount: number }

export function configRevisionNoop(sql: string): ConfigRevisionMockResult | null {
  return /meta_config_revisions/i.test(sql) ? { rows: [], rowCount: 0 } : null
}
