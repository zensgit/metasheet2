import type { QueryFn } from './permission-service'
import { isWriterBlockState, SheetWriterBlockedError } from './canonical-sheet-fence'

/** Values-free; the worker's existing retryable-failure path preserves its owned source block. */
export class RecoveryForeignAdmissionError extends Error {
  readonly code = 'RECOVERY_FOREIGN_ADMISSION_REFUSED'
  constructor(readonly reason: 'preview-drift' | 'recovery-trust-required') {
    super(reason)
    this.name = 'RecoveryForeignAdmissionError'
  }
}

/** Selected entry only, before xid probes, discovery or any snapshot-bearing statement. */
export async function prepareRecoveryForeignAdmission(query: QueryFn): Promise<void> {
  try {
    await query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    const result = await query('SHOW transaction_isolation')
    if (result.rows.length !== 1 ||
      (result.rows[0] as { transaction_isolation?: unknown }).transaction_isolation !== 'read committed') {
      throw new RecoveryForeignAdmissionError('recovery-trust-required')
    }
  } catch {
    throw new RecoveryForeignAdmissionError('recovery-trust-required')
  }
}

/** Both sets come from the same sorted discovery, before and after the complete fence acquisition. */
export function assertRecoveryParticipantSet(first: readonly string[], current: readonly string[]): void {
  if (first.length !== current.length || first.some((id, index) => id !== current[index])) {
    throw new RecoveryForeignAdmissionError('preview-drift')
  }
}

/** Unlike the global legacy compatibility guard, selected admission requires a present known state. */
export async function assertRecoveryParticipantStates(query: QueryFn, sheetIds: readonly string[]): Promise<void> {
  for (const sheetId of sheetIds) {
    let state: unknown
    try {
      const result = await query('SELECT recovery_writer_state FROM meta_sheets WHERE id = $1', [sheetId])
      if (result.rows.length !== 1) throw new RecoveryForeignAdmissionError('recovery-trust-required')
      state = (result.rows[0] as { recovery_writer_state?: unknown }).recovery_writer_state
    } catch {
      throw new RecoveryForeignAdmissionError('recovery-trust-required')
    }
    if (isWriterBlockState(state)) throw new SheetWriterBlockedError(sheetId, state)
    if (state !== null) throw new RecoveryForeignAdmissionError('recovery-trust-required')
  }
}

export function assertRecoveryAuthorityScopeCovered(admitted: readonly string[], actual: readonly string[]): void {
  const covered = new Set(admitted)
  if (actual.some((sheetId) => !covered.has(sheetId))) {
    throw new RecoveryForeignAdmissionError('preview-drift')
  }
}
