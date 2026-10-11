/** Pure acceptance judgement; importing it performs no native IO. */
export type ManualTargetScenario = 'process-crash' | 'stale-worker'
export interface ManualTargetResult {
  readonly scenario: ManualTargetScenario
  readonly generationId: string
  readonly databaseOid: string
  readonly backupDigest: string
  readonly rollbackTableCount: number
  readonly staleWorkerClaimQualified: boolean
}

export interface ManualChunkWitness {
  readonly chunk_index: number
  readonly state: string
  readonly committed_count: string | null
  readonly operation_id: string | null
}

export function qualifyManualTargetPair(
  crash: ManualTargetResult | undefined,
  stale: ManualTargetResult | undefined,
  generationId: string,
  backupDigest: string,
) {
  const qualified = crash?.scenario === 'process-crash' && stale?.scenario === 'stale-worker'
    && crash.generationId === generationId && stale.generationId === generationId
    && /^[0-9a-f]{64}$/.test(backupDigest)
    && crash.backupDigest === backupDigest && stale.backupDigest === backupDigest
    && /^[1-9][0-9]*$/.test(crash.databaseOid) && /^[1-9][0-9]*$/.test(stale.databaseOid)
    && crash.databaseOid !== stale.databaseOid
    && Number.isSafeInteger(crash.rollbackTableCount) && crash.rollbackTableCount >= 6
    && Number.isSafeInteger(stale.rollbackTableCount) && stale.rollbackTableCount >= 6
    && crash.staleWorkerClaimQualified === false && stale.staleWorkerClaimQualified === true
  return qualified
    ? { result: 'PASS' as const, staleWorkerClaimQualified: true }
    : { result: 'HOLD' as const, staleWorkerClaimQualified: false,
      holdReason: 'RECOVERY_LOCAL_BACKUP_MANUAL_SCENARIO_PAIR_UNQUALIFIED' }
}
