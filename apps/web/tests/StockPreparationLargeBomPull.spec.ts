import { describe, expect, it, vi } from 'vitest'

// 大 BOM 后台通道 — the RUN. Mirrors StockPreparationProjectSync.spec.ts's shape: an injected API
// double, no fetch, no DOM. This is the fix for the audit's second dead-end — a `large_bom_bounded`
// SKIP used to be the end of the story; this module drives the background channel that already
// existed server-side (stock-preparation-large-bom-jobs.cjs) but nothing on the operator surface
// ever called.
//
// The guarantees this suite exists to keep RED-witnessable:
//
//   L-1 A `large_bom_bounded` run transitions through queued -> expanding -> (plan) -> applying and
//       renders progress at every tick, ending in `done` with rows landed.
//   L-2 A post-expansion plan holding rows for a person routes to `confirm_required` and NEVER calls
//       the apply-job-start route — exactly projectSync.ts's "never auto-accept a hold" rule, applied
//       to the large-BOM plan instead of the small one.
//   L-3 A failed terminal state at ANY stage renders through a CLAMPED error code, never a raw one.
//   L-4 POLLING STOPS ON TERMINAL STATES: the tick budgets are real bounds, not decoration, and no
//       stage calls `wait` or the API again once a terminal status lands.

import {
  StockPreparationProjectSyncCallError,
  largeBomApplyCountsOf,
  largeBomExpansionPercent,
  runStockPreparationLargeBomPull,
  type StockPreparationLargeBomApplyJob,
  type StockPreparationLargeBomExpansionJob,
  type StockPreparationLargeBomJobApi,
  type StockPreparationLargeBomPullState,
} from '../src/services/integration/stockPreparation/largeBomPull'

const PROJECT_NO = 'P2026-777'

function instantWait(): (ms: number) => Promise<void> {
  return vi.fn().mockResolvedValue(undefined)
}

function expansionJob(overrides: Partial<StockPreparationLargeBomExpansionJob> = {}): StockPreparationLargeBomExpansionJob {
  return {
    jobId: 'large-bom-expansion-1',
    status: 'queued',
    authoritative: false,
    ...overrides,
  }
}

function applyJob(overrides: Partial<StockPreparationLargeBomApplyJob> = {}): StockPreparationLargeBomApplyJob {
  return {
    jobId: 'large-bom-apply-1',
    status: 'queued',
    counts: { created: 0, updated: 0, inactive: 0, skipped: 0, held: 0, failed: 0 },
    ...overrides,
  }
}

/** A double whose `runExpansion` needs exactly `ticks` calls to reach `completed`. */
function makeApi(overrides: Partial<StockPreparationLargeBomJobApi> = {}): StockPreparationLargeBomJobApi {
  return {
    startExpansion: vi.fn().mockResolvedValue(expansionJob()),
    runExpansion: vi.fn().mockResolvedValue(expansionJob({
      status: 'completed',
      authoritative: true,
      progress: { rowsExpanded: 4000, readCount: 4200, frontierRemaining: 0, completedChunks: 1 },
      budgets: { maxRows: 5000, maxPages: 50, maxReadCount: 6000, maxElapsedMs: 60000, maxDepth: 20, maxArtifactChunks: 1 },
    })),
    planExpansion: vi.fn().mockResolvedValue(expansionJob({
      status: 'completed',
      authoritative: true,
      evidence: { plan: { counts: { add: 400, update: 100, skip: 50, inactive: 0, manual_confirm: 0 } } },
    })),
    startApply: vi.fn().mockResolvedValue(applyJob()),
    runApplyChunk: vi.fn().mockResolvedValue(applyJob({
      status: 'succeeded',
      counts: { created: 400, updated: 100, inactive: 0, skipped: 50, held: 0, failed: 0 },
    })),
    ...overrides,
  } as StockPreparationLargeBomJobApi
}

describe('大 BOM 后台通道 — the pull run', () => {
  // ---- L-1 -------------------------------------------------------------------------------------
  it('L-1: queued -> expanding -> planning -> applying -> done, with progress rendered at every tick', async () => {
    const api = makeApi()
    const wait = instantWait()
    const seen: string[] = []
    const state = await runStockPreparationLargeBomPull(api, PROJECT_NO, {
      wait,
      onUpdate: (next) => seen.push(next.phase),
    })

    expect(state.phase).toBe('done')
    expect(state.imported).toBe(true)
    expect(state.jobId).toBe('large-bom-expansion-1')
    expect(state.applyJobId).toBe('large-bom-apply-1')
    expect(state.expansionStatus).toBe('completed')
    expect(state.applyStatus).toBe('succeeded')
    expect(state.percent).toBe(80) // 4000 / 5000
    expect(state.applyCounts).toEqual({ created: 400, updated: 100, inactive: 0, skipped: 50, held: 0, failed: 0 })
    expect(state.manualConfirmCount).toBe(0)
    expect(state.errorCode).toBeNull()

    // Every non-terminal phase actually rendered, in order, before the terminal one.
    expect(seen[0]).toBe('queued')
    expect(seen).toContain('expanding')
    expect(seen).toContain('planning')
    expect(seen).toContain('applying')
    expect(seen[seen.length - 1]).toBe('done')

    expect(api.startExpansion).toHaveBeenCalledWith(PROJECT_NO)
    expect(api.planExpansion).toHaveBeenCalledWith('large-bom-expansion-1')
    expect(api.startApply).toHaveBeenCalledWith('large-bom-expansion-1')
    expect(api.runApplyChunk).toHaveBeenCalledWith('large-bom-expansion-1', 'large-bom-apply-1')
  })

  it('L-1: a chunked apply (queued -> paused -> succeeded) renders each chunk before landing', async () => {
    const api = makeApi({
      runApplyChunk: vi.fn()
        .mockResolvedValueOnce(applyJob({ status: 'paused', counts: { created: 200, updated: 0, inactive: 0, skipped: 0, held: 0, failed: 0 } }))
        .mockResolvedValueOnce(applyJob({ status: 'succeeded', counts: { created: 400, updated: 100, inactive: 0, skipped: 50, held: 0, failed: 0 } })),
    })
    const wait = instantWait()
    const applyCountsSeen: number[] = []
    const state = await runStockPreparationLargeBomPull(api, PROJECT_NO, {
      wait,
      onUpdate: (next) => { if (next.applyCounts) applyCountsSeen.push(next.applyCounts.created) },
    })
    expect(state.phase).toBe('done')
    // startApply's initial 0, then each chunk in order — the terminal 'done' emit repeats the last
    // chunk's count rather than introducing a new one, so only the SEQUENCE up to it is pinned.
    expect(applyCountsSeen[0]).toBe(0)
    expect(applyCountsSeen).toContain(200)
    expect(applyCountsSeen[applyCountsSeen.length - 1]).toBe(400)
    expect(api.runApplyChunk).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenCalledTimes(1) // one gap, between the paused chunk and the next
  })

  it('L-1: a partial apply still lands rows and still reaches done', async () => {
    const api = makeApi({
      runApplyChunk: vi.fn().mockResolvedValue(applyJob({
        status: 'partial',
        counts: { created: 300, updated: 0, inactive: 0, skipped: 0, held: 0, failed: 20 },
      })),
    })
    const state = await runStockPreparationLargeBomPull(api, PROJECT_NO, { wait: instantWait() })
    expect(state.phase).toBe('done')
    expect(state.imported).toBe(true)
    expect(state.applyCounts).toMatchObject({ created: 300, failed: 20 })
  })

  // ---- L-2 -------------------------------------------------------------------------------------
  it('L-2: a plan holding rows for a person stops at confirm_required and NEVER starts apply', async () => {
    const api = makeApi({
      planExpansion: vi.fn().mockResolvedValue(expansionJob({
        status: 'completed',
        authoritative: true,
        evidence: { plan: { counts: { add: 10, update: 0, skip: 0, inactive: 0, manual_confirm: 7 } } },
      })),
    })
    const state = await runStockPreparationLargeBomPull(api, PROJECT_NO, { wait: instantWait() })
    expect(state.phase).toBe('confirm_required')
    expect(state.manualConfirmCount).toBe(7)
    expect(state.imported).toBe(false)
    expect(api.startApply).not.toHaveBeenCalled()
    expect(api.runApplyChunk).not.toHaveBeenCalled()
  })

  // ---- L-3 -------------------------------------------------------------------------------------
  it('L-3: an expansion that ends failed clamps its error type into a code, not a raw message', async () => {
    const api = makeApi({
      runExpansion: vi.fn().mockResolvedValue(expansionJob({
        status: 'failed',
        authoritative: false,
        evidence: { errorTypes: ['read_time_limit_exceeded'] },
      })),
    })
    const state = await runStockPreparationLargeBomPull(api, PROJECT_NO, { wait: instantWait() })
    expect(state.phase).toBe('failed')
    expect(state.errorCode).toBe('READ_TIME_LIMIT_EXCEEDED')
    expect(api.planExpansion).not.toHaveBeenCalled()
  })

  it('L-3: a transport failure on any call surfaces only its clamped code, never the response body', async () => {
    const api = makeApi({
      startApply: vi.fn().mockRejectedValue(
        new StockPreparationProjectSyncCallError(503, 'apply-jobs', { code: 'TABLE_ACTION_SOURCE_NOT_ACTIVE' }),
      ),
    })
    const state = await runStockPreparationLargeBomPull(api, PROJECT_NO, { wait: instantWait() })
    expect(state.phase).toBe('failed')
    expect(state.errorCode).toBe('TABLE_ACTION_SOURCE_NOT_ACTIVE')
  })

  it('L-3: a malformed response is its own failure, values-free', async () => {
    const api = makeApi({
      startExpansion: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(200, 'expansion-jobs', { malformed: true })),
    })
    const state = await runStockPreparationLargeBomPull(api, PROJECT_NO, { wait: instantWait() })
    expect(state.phase).toBe('failed')
    expect(state.errorCode).toBeNull()
    expect(api.runExpansion).not.toHaveBeenCalled()
  })

  it('L-3: an apply that never lands (ends failed after chunking) is a failure, not a silent done', async () => {
    const api = makeApi({
      runApplyChunk: vi.fn().mockResolvedValue(applyJob({ status: 'failed', counts: { created: 0, updated: 0, inactive: 0, skipped: 0, held: 0, failed: 500 } })),
    })
    const state = await runStockPreparationLargeBomPull(api, PROJECT_NO, { wait: instantWait() })
    expect(state.phase).toBe('failed')
    expect(state.imported).toBe(false)
  })

  // ---- L-4 -------------------------------------------------------------------------------------
  it('L-4: polling stops on terminal states — a completed expansion stops calling run() and wait()', async () => {
    const runExpansion = vi.fn()
      .mockResolvedValueOnce(expansionJob({ status: 'running', authoritative: false }))
      .mockResolvedValueOnce(expansionJob({ status: 'completed', authoritative: true, progress: {}, budgets: {} }))
    const api = makeApi({ runExpansion })
    const wait = instantWait()
    const state = await runStockPreparationLargeBomPull(api, PROJECT_NO, { wait })

    expect(state.phase).toBe('done')
    expect(runExpansion).toHaveBeenCalledTimes(2) // NOT 3, 4, ... — the loop stopped the instant `completed` landed
    // exactly one gap: between the 'running' tick and the 'completed' one. Apply's single chunk
    // lands terminal on its first call, so it contributes no further gap.
    expect(wait).toHaveBeenCalledTimes(1)
  })

  it('L-4: a job that never reaches a terminal status is bounded, not an infinite loop', async () => {
    const api = makeApi({
      runExpansion: vi.fn().mockResolvedValue(expansionJob({ status: 'running', authoritative: false })),
    })
    const wait = instantWait()
    const state = await runStockPreparationLargeBomPull(api, PROJECT_NO, { wait, maxExpansionTicks: 5 })
    expect(state.phase).toBe('failed')
    expect(api.runExpansion).toHaveBeenCalledTimes(5) // bounded — never unbounded
    expect(api.planExpansion).not.toHaveBeenCalled()
  })

  it('L-4: cancellation stops the run before its next call, with no further updates after', async () => {
    const api = makeApi({
      runExpansion: vi.fn()
        .mockResolvedValueOnce(expansionJob({ status: 'running', authoritative: false }))
        .mockResolvedValueOnce(expansionJob({ status: 'completed', authoritative: true, progress: {}, budgets: {} })),
    })
    let ticks = 0
    const updates: StockPreparationLargeBomPullState[] = []
    const state = await runStockPreparationLargeBomPull(api, PROJECT_NO, {
      wait: instantWait(),
      onUpdate: (next) => { updates.push(next); ticks += 1 },
      isCancelled: () => ticks >= 2, // bail out right after the first tick's two updates land
    })
    expect(state.phase).not.toBe('done')
    expect(state.phase).not.toBe('failed')
    expect(api.runExpansion).toHaveBeenCalledTimes(1)
    expect(api.planExpansion).not.toHaveBeenCalled()
  })
})

describe('大 BOM 后台通道 — the pure helpers', () => {
  it('largeBomExpansionPercent reads rowsExpanded/maxRows first, falls back to readCount/maxReadCount', () => {
    expect(largeBomExpansionPercent({ rowsExpanded: 250 }, { maxRows: 1000 })).toBe(25)
    expect(largeBomExpansionPercent({ readCount: 300 }, { maxReadCount: 1000 })).toBe(30)
    expect(largeBomExpansionPercent({ rowsExpanded: 250 }, {})).toBeNull()
    expect(largeBomExpansionPercent(null, null)).toBeNull()
    // never exceeds 100 even if rowsExpanded somehow overshoots the budget
    expect(largeBomExpansionPercent({ rowsExpanded: 1500 }, { maxRows: 1000 })).toBe(100)
  })

  it('largeBomApplyCountsOf defaults every gap to 0', () => {
    expect(largeBomApplyCountsOf({ created: 3 })).toEqual({ created: 3, updated: 0, inactive: 0, skipped: 0, held: 0, failed: 0 })
    expect(largeBomApplyCountsOf(undefined)).toEqual({ created: 0, updated: 0, inactive: 0, skipped: 0, held: 0, failed: 0 })
  })
})
