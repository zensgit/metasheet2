/**
 * Attendance settlement coordination — the in-flight ledger and its self-check (§3.6 "一致性自检").
 *
 * Coordination units are registered when they enter the coordinator and removed when they leave,
 * independently of the quota permits they take and give back; connects abandoned by a lost race are
 * kept on a separate tab until they settle. The self-check compares, per quota class, the permits
 * the quota has handed out with in-flight units plus abandoned connects: more permits than that is a
 * leak. (Counting "units that still hold a permit" as in-flight would make the check compare a
 * number with itself, which is exactly the mutation L-06′(a) guards against.)
 *
 * The ledger also refuses overlapping resources: a unit never holds two attempts' resources at once.
 */
import type { SettlementCoordinationQuotaClassV1, SettlementCoordinationQuotaSnapshotV1 } from './settlement-coordination-quota'

interface UnitEntry {
  readonly quotaClass: SettlementCoordinationQuotaClassV1
  holdsLease: boolean
  holdsClient: boolean
}

export interface SettlementCoordinationLedgerSnapshotV1 {
  readonly inFlight: Readonly<Record<SettlementCoordinationQuotaClassV1, number>>
  readonly abandoned: Readonly<Record<SettlementCoordinationQuotaClassV1, number>>
  readonly holding: ReadonlyArray<Readonly<{ quotaClass: SettlementCoordinationQuotaClassV1; lease: boolean; client: boolean }>>
}

export class SettlementCoordinationLedgerV1 {
  readonly #units = new Map<symbol, UnitEntry>()
  readonly #abandoned: Record<SettlementCoordinationQuotaClassV1, number> = { short: 0, long: 0 }

  enter(unit: symbol, quotaClass: SettlementCoordinationQuotaClassV1): void {
    if (this.#units.has(unit)) throw new Error('coordination unit entered twice')
    this.#units.set(unit, { quotaClass, holdsLease: false, holdsClient: false })
  }

  /** Leaves the coordinator. A unit that still holds resources is a programming error. */
  exit(unit: symbol): void {
    const entry = this.#units.get(unit)
    if (!entry) return
    this.#units.delete(unit)
    if (entry.holdsLease || entry.holdsClient) throw new Error('coordination unit left while still holding resources')
  }

  takeLease(unit: symbol): void {
    const entry = this.#entry(unit)
    if (entry.holdsLease) throw new Error('coordination unit already holds a quota lease (overlapping attempts)')
    entry.holdsLease = true
  }

  dropLease(unit: symbol): void {
    this.#entry(unit).holdsLease = false
  }

  takeClient(unit: symbol): void {
    const entry = this.#entry(unit)
    if (entry.holdsClient) throw new Error('coordination unit already holds a connection (overlapping attempts)')
    entry.holdsClient = true
  }

  dropClient(unit: symbol): void {
    this.#entry(unit).holdsClient = false
  }

  /** A connect lost its race: its quota stays out until `settled` is called. */
  abandonConnect(quotaClass: SettlementCoordinationQuotaClassV1): () => void {
    this.#abandoned[quotaClass] += 1
    let settled = false
    return () => {
      if (settled) return
      settled = true
      this.#abandoned[quotaClass] -= 1
    }
  }

  snapshot(): SettlementCoordinationLedgerSnapshotV1 {
    const inFlight: Record<SettlementCoordinationQuotaClassV1, number> = { short: 0, long: 0 }
    const holding: Array<{ quotaClass: SettlementCoordinationQuotaClassV1; lease: boolean; client: boolean }> = []
    for (const entry of this.#units.values()) {
      inFlight[entry.quotaClass] += 1
      if (entry.holdsLease || entry.holdsClient) holding.push({ quotaClass: entry.quotaClass, lease: entry.holdsLease, client: entry.holdsClient })
    }
    return { inFlight, abandoned: { ...this.#abandoned }, holding }
  }

  /** Per quota class: alarms when more global permits are out than in-flight units plus abandoned connects. */
  selfCheck(quota: SettlementCoordinationQuotaSnapshotV1): string[] {
    const { inFlight, abandoned } = this.snapshot()
    const alarms: string[] = []
    for (const quotaClass of ['short', 'long'] as const) {
      const held = quota.global[quotaClass].held
      if (held > inFlight[quotaClass] + abandoned[quotaClass]) {
        alarms.push(`${quotaClass}: ${held} permits held but ${inFlight[quotaClass]} units in flight and ${abandoned[quotaClass]} connects abandoned`)
      }
    }
    return alarms
  }

  #entry(unit: symbol): UnitEntry {
    const entry = this.#units.get(unit)
    if (!entry) throw new Error('coordination unit is not in the ledger')
    return entry
  }
}
