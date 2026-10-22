/**
 * Attendance settlement coordination — capacity contract (implementation lock §3.6).
 *
 * Pure derivation of the per-process quota sizes from the main pool size. Nothing here reads the
 * environment or runs at import time: the caller passes the pool size and any explicit overrides,
 * and the startup check that will one day reject a bad configuration is NOT wired in P1-1 (§3.6
 * "启动校验（随启用列车，不在 P1-1）"). `validateSettlementCoordinationCapacityV1` only reports.
 */

export interface SettlementCoordinationCapacityV1 {
  /** `DB_POOL_MAX` of the process. */
  readonly poolMax: number
  /** EXCL: exclusive side, borrow → release, both waits included. */
  readonly exclusiveSlots: number
  /** SCAN: the scanner, serial, not configurable. */
  readonly scanSlots: 1
  /** LONG: long-transaction entries (appendix D); per org the limit is fixed at 1. */
  readonly longTxnSlots: number
  readonly orgLongTxnSlots: 1
  /** RESERVED: connections this line never occupies (lower bound 4). */
  readonly reservedConnections: number
  /** TXN: short-transaction coordination units. */
  readonly txnSlots: number
  /** ORG_TXN: short-transaction units of one org. */
  readonly orgTxnSlots: number
}

export interface SettlementCoordinationCapacityInputV1 {
  readonly poolMax: number
  readonly exclusiveSlots?: number
  readonly longTxnSlots?: number
  readonly reservedConnections?: number
  readonly txnSlots?: number
  readonly orgTxnSlots?: number
}

export const SETTLEMENT_COORDINATION_DEFAULT_EXCLUSIVE_SLOTS = 2
export const SETTLEMENT_COORDINATION_SCAN_SLOTS = 1
export const SETTLEMENT_COORDINATION_DEFAULT_RESERVED_CONNECTIONS = 4
export const SETTLEMENT_COORDINATION_MIN_RESERVED_CONNECTIONS = 4

/**
 * Defaults (pool 20): EXCL 2, SCAN 1, LONG 2 (1 when the pool is below 16), RESERVED 4,
 * TXN = pool − EXCL − SCAN − LONG − RESERVED (11), ORG_TXN = ⌈TXN / 2⌉ (6). Explicit values win
 * over derived ones; validation is separate and only reports.
 */
export function deriveSettlementCoordinationCapacityV1(input: SettlementCoordinationCapacityInputV1): SettlementCoordinationCapacityV1 {
  const poolMax = input.poolMax
  const exclusiveSlots = input.exclusiveSlots ?? SETTLEMENT_COORDINATION_DEFAULT_EXCLUSIVE_SLOTS
  const longTxnSlots = input.longTxnSlots ?? (poolMax >= 16 ? 2 : 1)
  const reservedConnections = input.reservedConnections ?? SETTLEMENT_COORDINATION_DEFAULT_RESERVED_CONNECTIONS
  const txnSlots = input.txnSlots ?? poolMax - exclusiveSlots - SETTLEMENT_COORDINATION_SCAN_SLOTS - longTxnSlots - reservedConnections
  const orgTxnSlots = input.orgTxnSlots ?? Math.ceil(txnSlots / 2)
  return Object.freeze({
    poolMax,
    exclusiveSlots,
    scanSlots: SETTLEMENT_COORDINATION_SCAN_SLOTS,
    longTxnSlots,
    orgLongTxnSlots: 1,
    reservedConnections,
    txnSlots,
    orgTxnSlots,
  })
}

/** The §3.6 startup conditions, as a list of violations (empty when valid). Never throws. */
export function validateSettlementCoordinationCapacityV1(capacity: SettlementCoordinationCapacityV1): string[] {
  const problems: string[] = []
  const positive: Array<[string, number]> = [
    ['poolMax', capacity.poolMax],
    ['exclusiveSlots', capacity.exclusiveSlots],
    ['longTxnSlots', capacity.longTxnSlots],
    ['reservedConnections', capacity.reservedConnections],
    ['txnSlots', capacity.txnSlots],
    ['orgTxnSlots', capacity.orgTxnSlots],
  ]
  for (const [name, value] of positive) {
    if (!Number.isSafeInteger(value) || value < 1) problems.push(`${name} must be a positive integer (got ${String(value)})`)
  }
  if (capacity.reservedConnections < SETTLEMENT_COORDINATION_MIN_RESERVED_CONNECTIONS) problems.push('reservedConnections must be at least 4')
  if (capacity.txnSlots < 2) problems.push('txnSlots must be at least 2')
  if (capacity.orgTxnSlots > capacity.txnSlots) problems.push('orgTxnSlots must not exceed txnSlots')
  const total = capacity.exclusiveSlots + capacity.scanSlots + capacity.longTxnSlots + capacity.txnSlots + capacity.reservedConnections
  if (total > capacity.poolMax) problems.push(`EXCL + SCAN + LONG + TXN + RESERVED (${total}) exceeds poolMax (${capacity.poolMax})`)
  return problems
}
