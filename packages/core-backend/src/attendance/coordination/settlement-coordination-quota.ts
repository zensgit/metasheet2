/**
 * Attendance settlement coordination — the two-level connection quota (§3.2 step 1, §3.6).
 *
 * Every attempt takes its org quota first and the global quota second, and gives them back in the
 * opposite order (global, then org). Both levels are first-come-first-served (`CoordinationSemaphoreV1`).
 * While a unit waits for the global quota it holds only its org quota; a cancelled global wait
 * returns the org permit before the error propagates. Short and long transactions use separate
 * quotas: TXN / ORG_TXN for short units, LONG / 1-per-org for long ones. The exclusive side and the
 * scanner have their own quotas and do not come through here.
 *
 * Per-org semaphores exist only while someone holds or waits for them, so the map does not grow
 * with every org ever seen. Nothing here is created at import time.
 */
import type { SettlementCoordinationCapacityV1 } from './settlement-coordination-capacity'
import type { CoordinationAcquireOptionsV1, CoordinationPermitV1 } from './settlement-coordination-semaphore'
import { CoordinationSemaphoreV1 } from './settlement-coordination-semaphore'

export type SettlementCoordinationQuotaClassV1 = 'short' | 'long'

export interface SettlementCoordinationQuotaLeaseV1 {
  readonly org: string
  readonly quotaClass: SettlementCoordinationQuotaClassV1
  /** Whether either level made the unit queue (an immediate grant is not a wait, §3.2 step 10). */
  readonly queued: boolean
  /** Global first, then org. A second call is a programming error and throws. */
  release(): void
}

export interface SettlementCoordinationQuotaSnapshotV1 {
  readonly global: Readonly<Record<SettlementCoordinationQuotaClassV1, { held: number; waiting: number }>>
  /** Only orgs that currently hold or wait for a permit. */
  readonly orgs: ReadonlyArray<Readonly<{ org: string; quotaClass: SettlementCoordinationQuotaClassV1; held: number; waiting: number }>>
}

export class SettlementCoordinationQuotaV1 {
  readonly #capacity: SettlementCoordinationCapacityV1
  readonly #global: Record<SettlementCoordinationQuotaClassV1, CoordinationSemaphoreV1>
  readonly #orgs = new Map<string, { org: string; quotaClass: SettlementCoordinationQuotaClassV1; semaphore: CoordinationSemaphoreV1 }>()

  constructor(capacity: SettlementCoordinationCapacityV1) {
    this.#capacity = capacity
    this.#global = {
      short: new CoordinationSemaphoreV1(capacity.txnSlots),
      long: new CoordinationSemaphoreV1(capacity.longTxnSlots),
    }
  }

  async acquire(
    org: string,
    quotaClass: SettlementCoordinationQuotaClassV1,
    options: CoordinationAcquireOptionsV1,
  ): Promise<SettlementCoordinationQuotaLeaseV1> {
    const key = `${quotaClass}\u0000${org}`
    const entry = this.#orgEntry(key, org, quotaClass)
    let orgPermit: CoordinationPermitV1
    try {
      orgPermit = await entry.semaphore.acquire(options)
    } catch (error) {
      this.#forgetIfIdle(key)
      throw error
    }
    let globalPermit: CoordinationPermitV1
    try {
      globalPermit = await this.#global[quotaClass].acquire(options)
    } catch (error) {
      orgPermit.release()
      this.#forgetIfIdle(key)
      throw error
    }
    let released = false
    return Object.freeze({
      org,
      quotaClass,
      queued: orgPermit.queued || globalPermit.queued,
      release: () => {
        if (released) throw new Error('coordination quota lease released twice')
        released = true
        globalPermit.release()
        orgPermit.release()
        this.#forgetIfIdle(key)
      },
    })
  }

  snapshot(): SettlementCoordinationQuotaSnapshotV1 {
    return {
      global: {
        short: { held: this.#global.short.held, waiting: this.#global.short.waiting },
        long: { held: this.#global.long.held, waiting: this.#global.long.waiting },
      },
      orgs: [...this.#orgs.values()].map(({ org, quotaClass, semaphore }) => ({
        org,
        quotaClass,
        held: semaphore.held,
        waiting: semaphore.waiting,
      })),
    }
  }

  #orgEntry(key: string, org: string, quotaClass: SettlementCoordinationQuotaClassV1) {
    let entry = this.#orgs.get(key)
    if (!entry) {
      const permits = quotaClass === 'short' ? this.#capacity.orgTxnSlots : this.#capacity.orgLongTxnSlots
      entry = { org, quotaClass, semaphore: new CoordinationSemaphoreV1(permits) }
      this.#orgs.set(key, entry)
    }
    return entry
  }

  #forgetIfIdle(key: string): void {
    const entry = this.#orgs.get(key)
    if (entry && entry.semaphore.held === 0 && entry.semaphore.waiting === 0) this.#orgs.delete(key)
  }
}
