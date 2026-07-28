/**
 * Attachment slice ③ — drainPurgeIntents STATE-MACHINE branch goldens (§3-bis). Pure unit lane with a
 * fake db so the post-claim TS branching (done / release-to-pending / dead_letter+alert / not-found
 * terminal-success / fence-CAS) runs always-on and is mutation-provable. This tests the WORKER branch
 * logic, NOT the claim's SQL concurrency semantics (atomic UPDATE…FOR UPDATE SKIP LOCKED, starvation
 * exclusion) — those are DB behaviour, exercised by the real-DB gc test.
 */
import { describe, expect, test, vi } from 'vitest'

import { drainPurgeIntents, PURGE_MAX_ATTEMPTS } from '../../src/services/approval-attachment-gc'

type ClaimedRow = { id: string; storage_key: string; attempts: number; fence: number; status: string }

/** A fake Queryable: serves one claimed row, records the terminal UPDATE it issues. */
function fakeDb(claimed: ClaimedRow | null) {
  const updates: string[] = []
  const db = {
    query: async (sql: string) => {
      // the claim is the only statement with the SKIP LOCKED inner select (its SET is now a CASE that
      // can yield 'in_progress' OR claim-time 'dead_letter' — the fake returns whatever row we seeded).
      if (sql.includes('FOR UPDATE SKIP LOCKED')) {
        return { rows: claimed ? [claimed] : [], rowCount: claimed ? 1 : 0 }
      }
      if (sql.trimStart().startsWith('SELECT i.storage_key')) return { rows: [], rowCount: 0 } // still-referenced sweep
      // a terminal transition UPDATE (done / dead_letter / release-to-pending)
      if (sql.includes("status='done'")) updates.push('done')
      else if (sql.includes("status='dead_letter'")) updates.push('dead_letter')
      else if (sql.includes("status='pending'")) updates.push('release')
      return { rows: [], rowCount: 1 }
    },
  }
  return { db, updates }
}

const row = (over: Partial<ClaimedRow> = {}): ClaimedRow => ({ id: 'pi_1', storage_key: 'approval/2026-07/k', attempts: 1, fence: 3, status: 'in_progress', ...over })

describe('drainPurgeIntents state machine (§3-bis)', () => {
  test('deleter succeeds → intent marked done (terminal-success)', async () => {
    const { db, updates } = fakeDb(row())
    const r = await drainPurgeIntents(db, async () => true)
    expect(r.purged).toBe(1)
    expect(updates).toEqual(['done'])
  })

  test('not-found (deleter returns false) is TERMINAL-SUCCESS → done, never dead_letter', async () => {
    const { db, updates } = fakeDb(row())
    const r = await drainPurgeIntents(db, async () => false) // store: missing-is-ok, returns false
    expect(r.purged).toBe(1)
    expect(r.deadLettered).toBe(0)
    expect(updates).toEqual(['done'])
  })

  test('deleter throws with attempts REMAINING → released back to pending (not dead_letter)', async () => {
    const { db, updates } = fakeDb(row({ attempts: PURGE_MAX_ATTEMPTS - 1 }))
    const r = await drainPurgeIntents(db, async () => {
      throw new Error('transient')
    })
    expect(r.failed).toBe(1)
    expect(r.deadLettered).toBe(0)
    expect(updates).toEqual(['release'])
  })

  test('deleter throws AT the attempts cap → terminal dead_letter + values-free alert seam', async () => {
    const { db, updates } = fakeDb(row({ attempts: PURGE_MAX_ATTEMPTS }))
    const onDeadLetter = vi.fn()
    const r = await drainPurgeIntents(
      db,
      async () => {
        const e = Object.assign(new Error('permission denied /secret/path'), { code: 'EACCES' })
        throw e
      },
      { onDeadLetter },
    )
    expect(r.deadLettered).toBe(1)
    expect(r.failed).toBe(0)
    expect(updates).toEqual(['dead_letter'])
    // the alert carries a VALUES-FREE code (the error's .code), never the raw message with the path
    expect(onDeadLetter).toHaveBeenCalledWith('pi_1', 'approval/2026-07/k', 'EACCES')
  })

  // §3-bis poison AT CLAIM: the claim CASE moved an at-ceiling row straight to dead_letter — the worker
  // must report it and MUST NOT invoke the blob deleter (no attempt runs for a poisoned row).
  test('claim-time poisoned row (status dead_letter from the claim) → deleter NOT called, counted + alerted, no extra terminal write', async () => {
    const { db, updates } = fakeDb(row({ attempts: PURGE_MAX_ATTEMPTS, status: 'dead_letter' }))
    const deleter = vi.fn(async () => true)
    const onDeadLetter = vi.fn()
    const r = await drainPurgeIntents(db, deleter, { onDeadLetter })
    expect(deleter).not.toHaveBeenCalled() // the poison path never reaches the blob store
    expect(r.deadLettered).toBe(1)
    expect(r.purged).toBe(0)
    expect(r.failed).toBe(0)
    expect(updates).toEqual([]) // terminal transition happened IN the claim; no post-claim CAS write
    expect(onDeadLetter).toHaveBeenCalledWith('pi_1', 'approval/2026-07/k', 'max_attempts_exhausted')
  })

  test('no claimable intent → nothing happens', async () => {
    const { db, updates } = fakeDb(null)
    const r = await drainPurgeIntents(db, async () => true)
    expect(r).toEqual({ purged: 0, skippedStillReferenced: [], failed: 0, deadLettered: 0 })
    expect(updates).toEqual([])
  })

  test('argument bounds are validated', async () => {
    const { db } = fakeDb(null)
    await expect(drainPurgeIntents(db, async () => true, { maxAttempts: 0 })).rejects.toThrow(/maxAttempts/)
    await expect(drainPurgeIntents(db, async () => true, { leaseMs: 10 })).rejects.toThrow(/leaseMs/)
  })
})
