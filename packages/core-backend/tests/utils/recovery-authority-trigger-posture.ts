import {
  RECOVERY_AUTHORITY_TRIGGERS,
} from '../../src/db/migrations/zzzz20260721121000_add_recovery_authority_locks'

type TestQuery = (
  sql: string,
  params: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe recovery-authority identifier: ${value}`)
  }
  return `"${value}"`
}

async function setRecoveryAuthorityTriggers(
  query: TestQuery,
  enabled: boolean,
): Promise<void> {
  const action = enabled ? 'ENABLE' : 'DISABLE'
  for (const [table, trigger] of RECOVERY_AUTHORITY_TRIGGERS) {
    await query(
      `ALTER TABLE ${quoteIdentifier(table)} ${action} TRIGGER ${quoteIdentifier(trigger)}`,
      [],
    )
  }
}

export async function enableRecoveryAuthorityTriggers(
  query: TestQuery,
): Promise<void> {
  await setRecoveryAuthorityTriggers(query, true)
}

export async function disableRecoveryAuthorityTriggers(
  query: TestQuery,
): Promise<void> {
  await setRecoveryAuthorityTriggers(query, false)
}
