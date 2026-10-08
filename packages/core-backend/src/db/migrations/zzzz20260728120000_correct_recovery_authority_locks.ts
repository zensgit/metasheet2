import type { Kysely } from 'kysely'

import {
  dropRecoveryAuthorityTriggers,
  installRecoveryAuthorityTriggers,
} from './zzzz20260721121000_add_recovery_authority_locks'

/**
 * Corrective replay for environments that installed the earlier blocking per-subject triggers.
 * The replacement is shared-writer/exclusive-recovery, fail-fast, and remains disabled until the
 * separately authorized recovery enablement ladder activates the complete trigger set.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await installRecoveryAuthorityTriggers(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await dropRecoveryAuthorityTriggers(db)
}
