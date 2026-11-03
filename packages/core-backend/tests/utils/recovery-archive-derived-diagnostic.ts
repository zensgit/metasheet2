const codes = [
  '55P03', '40P01', '40001', '57014', '23505', '23503', '23514', '25P02',
  '08006', '08003', '53300', '42P01', '42703', '22003', '22001',
  'RECOVERY_DERIVED_SCOPE_CHANGED', 'RECOVERY_DERIVED_AUTHORITY_UNAVAILABLE',
] as const

export type ArchiveDerivedFailureCode = typeof codes[number] | 'other' | 'none'

export interface ArchiveDerivedNonCompletion {
  attempt: number
  tick: number
  effectOrdinal: number
  jobMatch: boolean
  outcome: 'false' | 'throw' | 'job_mismatch'
  code: ArchiveDerivedFailureCode
  laterCompleted: boolean
}

/** Test IPC admits only named codes, never error messages, values, accessors or inherited fields. */
export function archiveDerivedFailureCode(error: unknown): ArchiveDerivedFailureCode {
  if (!error || typeof error !== 'object') return 'other'
  try {
    for (const key of ['code', 'message']) {
      const value: unknown = Object.getOwnPropertyDescriptor(error, key)?.value
      if (typeof value === 'string' && (codes as readonly string[]).includes(value)) {
        return value as ArchiveDerivedFailureCode
      }
    }
  } catch {
    // Observing an unusual thrown object must not replace the original processor failure.
  }
  return 'other'
}
