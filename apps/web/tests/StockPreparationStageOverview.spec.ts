import { describe, expect, it } from 'vitest'
import {
  classifyDetailStageStatus,
  classifyProvisionStatus,
  deriveRecommendedNextStep,
  type StockPreparationStageMetric,
} from '../src/services/integration/stockPreparation/stageOverview'

// Stock Preparation UI humanization H1/H2 (H0 plane-boundary design-lock #4202). Pure, network-free
// unit tests for the stage-status classifier + the deterministic recommended-next-step rule. No
// mounting, no apiFetch mocks — every input/output here is a count/enum/boolean (values-free by
// construction), so these are ordinary function-level tests.

describe('classifyDetailStageStatus', () => {
  it('is forbidden when the read is denied, regardless of any counts', () => {
    expect(classifyDetailStageStatus({ count: 5, blockingCount: 2, forbidden: true, errored: false })).toBe('forbidden')
  })

  it('is unknown when the read errored for a non-permission reason', () => {
    expect(classifyDetailStageStatus({ count: null, blockingCount: null, forbidden: false, errored: true })).toBe('unknown')
  })

  it('is unknown when the count is null even without an explicit errored flag', () => {
    expect(classifyDetailStageStatus({ count: null, blockingCount: null, forbidden: false, errored: false })).toBe('unknown')
  })

  it('is not_started when the count is exactly zero', () => {
    expect(classifyDetailStageStatus({ count: 0, blockingCount: null, forbidden: false, errored: false })).toBe('not_started')
  })

  it('is blocked when the count is positive and blockingCount is positive', () => {
    expect(classifyDetailStageStatus({ count: 3, blockingCount: 1, forbidden: false, errored: false })).toBe('blocked')
  })

  it('is clear when the count is positive and blockingCount is zero', () => {
    expect(classifyDetailStageStatus({ count: 3, blockingCount: 0, forbidden: false, errored: false })).toBe('clear')
  })

  it('is clear when the count is positive and blockingCount is null (no such concept for the stage)', () => {
    expect(classifyDetailStageStatus({ count: 3, blockingCount: null, forbidden: false, errored: false })).toBe('clear')
  })

  it('forbidden takes priority over a zero count', () => {
    expect(classifyDetailStageStatus({ count: 0, blockingCount: null, forbidden: true, errored: false })).toBe('forbidden')
  })
})

describe('classifyProvisionStatus', () => {
  it('is not_started when no projects have been synced yet', () => {
    expect(classifyProvisionStatus({ projectCount: 0, hasSelection: false })).toBe('not_started')
  })

  it('is not_started even if hasSelection were somehow true with zero projects', () => {
    expect(classifyProvisionStatus({ projectCount: 0, hasSelection: true })).toBe('not_started')
  })

  it('is pending when projects exist but none is selected', () => {
    expect(classifyProvisionStatus({ projectCount: 3, hasSelection: false })).toBe('pending')
  })

  it('is clear once a project is selected', () => {
    expect(classifyProvisionStatus({ projectCount: 3, hasSelection: true })).toBe('clear')
  })
})

// Helper to build a full 5-stage detail array with sane defaults, overridable per test.
function buildStages(overrides: Partial<Record<StockPreparationStageMetric['key'], Partial<StockPreparationStageMetric>>> = {}): StockPreparationStageMetric[] {
  const base: Record<StockPreparationStageMetric['key'], StockPreparationStageMetric> = {
    provision: { key: 'provision', status: 'clear', count: 1, blockingCount: null },
    sync: { key: 'sync', status: 'clear', count: 2, blockingCount: 0 },
    map: { key: 'map', status: 'clear', count: 5, blockingCount: 0, caveat: 'tenant_wide' },
    unit: { key: 'unit', status: 'clear', count: 0, blockingCount: 0 },
    generate: { key: 'generate', status: 'clear', count: 4, blockingCount: 0 },
    exception: { key: 'exception', status: 'clear', count: 1, blockingCount: 0, caveat: 'display_only' },
  }
  for (const key of Object.keys(overrides) as Array<StockPreparationStageMetric['key']>) {
    base[key] = { ...base[key], ...overrides[key] }
  }
  return Object.values(base)
}

describe('deriveRecommendedNextStep', () => {
  it('recommends selecting a project first, before anything else', () => {
    const step = deriveRecommendedNextStep({ hasProject: false, adminDetailAvailable: true, stages: buildStages() })
    expect(step).toEqual({ kind: 'select_project', reason: 'no_project_selected' })
  })

  it('recommends select_project even when adminDetailAvailable is false and no project is chosen', () => {
    const step = deriveRecommendedNextStep({ hasProject: false, adminDetailAvailable: false })
    expect(step.kind).toBe('select_project')
  })

  describe('tier 2 (admin detail available)', () => {
    it('recommends sync when sync has a positive blockingCount (incomplete batches)', () => {
      const stages = buildStages({ sync: { blockingCount: 2 } })
      const step = deriveRecommendedNextStep({ hasProject: true, adminDetailAvailable: true, stages })
      expect(step).toEqual({ kind: 'go_to_stage', stage: 'sync', reason: 'sync_incomplete_batches', count: 2 })
    })

    it('recommends map when only map is blocked', () => {
      const stages = buildStages({ map: { blockingCount: 4 } })
      const step = deriveRecommendedNextStep({ hasProject: true, adminDetailAvailable: true, stages })
      expect(step).toEqual({ kind: 'go_to_stage', stage: 'map', reason: 'mapping_pending_tenant_wide', count: 4 })
    })

    it('recommends unit when only unit is blocked', () => {
      const stages = buildStages({ unit: { blockingCount: 3 } })
      const step = deriveRecommendedNextStep({ hasProject: true, adminDetailAvailable: true, stages })
      expect(step).toEqual({ kind: 'go_to_stage', stage: 'unit', reason: 'unit_pending_lines', count: 3 })
    })

    it('recommends exception when only exception is blocked', () => {
      const stages = buildStages({ exception: { blockingCount: 1 } })
      const step = deriveRecommendedNextStep({ hasProject: true, adminDetailAvailable: true, stages })
      expect(step).toEqual({ kind: 'go_to_stage', stage: 'exception', reason: 'exception_unresolved_blocking', count: 1 })
    })

    it('prioritizes sync over map when both are blocked (pipeline-causal order)', () => {
      const stages = buildStages({ sync: { blockingCount: 1 }, map: { blockingCount: 9 } })
      const step = deriveRecommendedNextStep({ hasProject: true, adminDetailAvailable: true, stages })
      expect(step.stage).toBe('sync')
    })

    it('prioritizes map over unit when both are blocked', () => {
      const stages = buildStages({ map: { blockingCount: 1 }, unit: { blockingCount: 9 } })
      const step = deriveRecommendedNextStep({ hasProject: true, adminDetailAvailable: true, stages })
      expect(step.stage).toBe('map')
    })

    it('prioritizes unit over exception when both are blocked', () => {
      const stages = buildStages({ unit: { blockingCount: 1 }, exception: { blockingCount: 9 } })
      const step = deriveRecommendedNextStep({ hasProject: true, adminDetailAvailable: true, stages })
      expect(step.stage).toBe('unit')
    })

    it('recommends generate when nothing upstream is blocked and generate has never run (count 0)', () => {
      const stages = buildStages({ generate: { count: 0 } })
      const step = deriveRecommendedNextStep({ hasProject: true, adminDetailAvailable: true, stages })
      expect(step).toEqual({ kind: 'go_to_stage', stage: 'generate', reason: 'generate_not_run', count: 0 })
    })

    it('recommends all_clear when nothing is blocked and generate already has lines', () => {
      const step = deriveRecommendedNextStep({ hasProject: true, adminDetailAvailable: true, stages: buildStages() })
      expect(step).toEqual({ kind: 'all_clear', reason: 'all_clear' })
    })

    it('skips a stage missing from the array instead of throwing', () => {
      const stages = buildStages().filter((stage) => stage.key !== 'sync')
      const step = deriveRecommendedNextStep({ hasProject: true, adminDetailAvailable: true, stages })
      expect(step).toEqual({ kind: 'all_clear', reason: 'all_clear' })
    })

    it('treats a null blockingCount on a KNOWN stage (no such concept) as not blocking', () => {
      // status stays 'clear' — a known stage that simply has no blocking concept, NOT a failed read.
      const stages = buildStages({ sync: { blockingCount: null, status: 'clear', count: 2 } })
      const step = deriveRecommendedNextStep({ hasProject: true, adminDetailAvailable: true, stages })
      expect(step).toEqual({ kind: 'all_clear', reason: 'all_clear' })
    })

    // #4207 stricter terminal semantics (owner review 2026-07-13): a FAILED detail read classifies its
    // stage 'unknown'. When a detail read is unknown and nothing loaded is blocked, the derivation must
    // return an EXPLICIT detail_unavailable — NOT a bare tier-1 all_clear ("no blocking items" off a failed
    // read), NOT admin_required (adminDetailAvailable is true — it is not a permission problem), and clean
    // OR actionable tier-1 signals must NOT override it (the operator is told the picture is partial, not
    // reassuringly empty).
    it('returns an explicit detail_unavailable (never all_clear / admin_required / tier-1) when a detail read is unknown', () => {
      const stages = buildStages({
        sync: { status: 'unknown', count: null, blockingCount: null },
        map: { status: 'unknown', count: null, blockingCount: null },
        unit: { status: 'unknown', count: null, blockingCount: null },
        generate: { status: 'unknown', count: null, blockingCount: null },
        exception: { status: 'unknown', count: null, blockingCount: null },
      })
      const incomplete = { kind: 'detail_unavailable', reason: 'detail_read_incomplete' }
      // No project signals: an unknown detail read is NOT a permission problem → detail_read_incomplete.
      expect(deriveRecommendedNextStep({ hasProject: true, adminDetailAvailable: true, stages })).toEqual(incomplete)
      // CLEAN tier-1 signals must NOT manufacture a reassuring all_clear off a failed detail read.
      expect(deriveRecommendedNextStep({
        hasProject: true, adminDetailAvailable: true, stages,
        projectSignals: { snapshotBatchCount: 2, openExceptionCount: 0, readyLineCount: 0, heldLineCount: 0 },
      })).toEqual(incomplete)
      // Even ACTIONABLE tier-1 signals (open exceptions) do not override the honest "detail incomplete"
      // state — the detail read is what failed, and its truth is unknown, not "handle these exceptions".
      expect(deriveRecommendedNextStep({
        hasProject: true, adminDetailAvailable: true, stages,
        projectSignals: { snapshotBatchCount: 2, openExceptionCount: 4, readyLineCount: 0, heldLineCount: 0 },
      })).toEqual(incomplete)
    })

    // A PARTIAL unknown (one stage failed, the rest loaded clean, none blocked) is still detail_unavailable —
    // we cannot claim all_clear while any stage's truth is unknown.
    it('returns detail_unavailable when ONE detail stage is unknown and no loaded stage is blocked', () => {
      const stages = buildStages({ exception: { status: 'unknown', count: null, blockingCount: null } })
      const step = deriveRecommendedNextStep({
        hasProject: true, adminDetailAvailable: true, stages,
        projectSignals: { snapshotBatchCount: 2, openExceptionCount: 0, readyLineCount: 4, heldLineCount: 0 },
      })
      expect(step).toEqual({ kind: 'detail_unavailable', reason: 'detail_read_incomplete' })
    })

    // #4207 re-review 2026-07-12: a PARTIAL detail failure must still surface a blocker that DID load.
    // sync loaded with a real blocker, exception's read failed (unknown). adminDetailAvailable is true
    // (it is `detailStages !== null && !detailForbidden`, not "all five succeeded"), and the tier-1
    // per-project signals are CLEAN — so gating the whole tier-2 walk on !detailUnknown would drop the
    // loaded sync blocker and fall to a tier-1 all_clear. The blocker walk must run regardless of a
    // sibling stage being unknown; only the "nothing pending" terminal is deferred.
    it('surfaces a LOADED blocker even when a sibling detail stage is unknown (clean tier-1 would hide it)', () => {
      const stages = buildStages({
        sync: { status: 'blocked', count: 3, blockingCount: 3 },
        exception: { status: 'unknown', count: null, blockingCount: null },
      })
      const step = deriveRecommendedNextStep({
        hasProject: true, adminDetailAvailable: true, stages,
        // CLEAN signals: batches exist, nothing open/held — tier-1 alone would say all_clear.
        projectSignals: { snapshotBatchCount: 2, openExceptionCount: 0, readyLineCount: 4, heldLineCount: 0 },
      })
      expect(step).toEqual({ kind: 'go_to_stage', stage: 'sync', reason: 'sync_incomplete_batches', count: 3 })
    })
  })

  describe('tier 1 fallback (admin detail unavailable — non-admin operator or errored reads)', () => {
    it('falls back to admin_required when even the project signals are missing', () => {
      const step = deriveRecommendedNextStep({ hasProject: true, adminDetailAvailable: false })
      expect(step).toEqual({ kind: 'admin_required', reason: 'admin_permission_required' })
    })

    it('recommends the exception tab when the project has open exceptions', () => {
      const step = deriveRecommendedNextStep({
        hasProject: true,
        adminDetailAvailable: false,
        projectSignals: { snapshotBatchCount: 2, openExceptionCount: 3, readyLineCount: 1, heldLineCount: 0 },
      })
      expect(step).toEqual({ kind: 'go_to_stage', stage: 'exception', reason: 'project_open_exceptions', count: 3 })
    })

    it('recommends the generate tab when there are held lines and no open exceptions', () => {
      const step = deriveRecommendedNextStep({
        hasProject: true,
        adminDetailAvailable: false,
        projectSignals: { snapshotBatchCount: 2, openExceptionCount: 0, readyLineCount: 1, heldLineCount: 2 },
      })
      expect(step).toEqual({ kind: 'go_to_stage', stage: 'generate', reason: 'project_held_lines', count: 2 })
    })

    it('recommends the sync tab when there is no snapshot batch yet', () => {
      const step = deriveRecommendedNextStep({
        hasProject: true,
        adminDetailAvailable: false,
        projectSignals: { snapshotBatchCount: 0, openExceptionCount: 0, readyLineCount: 0, heldLineCount: 0 },
      })
      expect(step).toEqual({ kind: 'go_to_stage', stage: 'sync', reason: 'project_no_snapshot_yet', count: 0 })
    })

    it('recommends all_clear when every tier-1 signal is quiet', () => {
      const step = deriveRecommendedNextStep({
        hasProject: true,
        adminDetailAvailable: false,
        projectSignals: { snapshotBatchCount: 2, openExceptionCount: 0, readyLineCount: 3, heldLineCount: 0 },
      })
      expect(step).toEqual({ kind: 'all_clear', reason: 'all_clear' })
    })

    it('prioritizes open exceptions over held lines', () => {
      const step = deriveRecommendedNextStep({
        hasProject: true,
        adminDetailAvailable: false,
        projectSignals: { snapshotBatchCount: 2, openExceptionCount: 1, readyLineCount: 0, heldLineCount: 5 },
      })
      expect(step.reason).toBe('project_open_exceptions')
    })
  })
})
