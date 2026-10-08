/**
 * P2 durable-delivery P1 #2 — producer REPLACE seam (the flag-ON suppression is the load-bearing guard).
 *
 * The design decision (FWB0 lock §Layer-1 lines 318-324): flag ON ⇒ the durable same-txn enqueue REPLACES the
 * legacy post-commit emit. These unit tests pin the two phases' flag gating with spies (no DB): flag OFF emits
 * / does not enqueue; flag ON suppresses the emit (the enqueue happened same-txn). If the suppression is ever
 * neutralized, the "flag ON suppresses" test reddens (double-delivery).
 */
import { describe, expect, test, vi } from 'vitest'

import { emitRecordEventIfLegacy, enqueueRecordEventIfDurable } from '../../src/multitable/automation-producer-emit'
import type { TransactionalQueryable } from '../../src/multitable/pg-transaction-guard'

const FLAG_ON = { AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv
const FLAG_OFF = {} as NodeJS.ProcessEnv
const payload = { sheetId: 's1', recordId: 'r1', _eventId: 'evt_1', _automationDepth: 2 }

describe('emitRecordEventIfLegacy — legacy emit fires ONLY when durable delivery is OFF', () => {
  test('flag OFF: emits the legacy event (byte-identical) and returns true', () => {
    const bus = { emit: vi.fn() }
    expect(emitRecordEventIfLegacy(bus, 'multitable.record.updated', payload, FLAG_OFF)).toBe(true)
    expect(bus.emit).toHaveBeenCalledTimes(1)
    expect(bus.emit).toHaveBeenCalledWith('multitable.record.updated', payload)
  })

  test('flag ON: SUPPRESSED — does NOT emit (the same-txn enqueue is the delivery path); returns false', () => {
    const bus = { emit: vi.fn() }
    expect(emitRecordEventIfLegacy(bus, 'multitable.record.updated', payload, FLAG_ON)).toBe(false)
    expect(bus.emit).not.toHaveBeenCalled() // keep-both would double-deliver the non-idempotent webhook sink
  })
})

describe('enqueueRecordEventIfDurable — same-txn enqueue ONLY when durable delivery is ON', () => {
  test('flag OFF: no-op — never touches the transaction handle, returns false', async () => {
    const trx = { isTransaction: true as const, query: vi.fn() } as unknown as TransactionalQueryable & { query: ReturnType<typeof vi.fn> }
    expect(await enqueueRecordEventIfDurable(trx, 'multitable.record.updated', payload, FLAG_OFF)).toBe(false)
    expect((trx as unknown as { query: ReturnType<typeof vi.fn> }).query).not.toHaveBeenCalled()
  })
})
