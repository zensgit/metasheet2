import { describe, expect, it } from 'vitest'
import {
  MONITORING_DEFAULT_PAGE_SIZE,
  MONITORING_MAX_LIMIT,
  MONITORING_MAX_OFFSET,
  buildDeadLetterRequestParams,
  buildRunsRequestParams,
  countDeadLettersForRun,
  createMonitoringQueryState,
  createMonitoringResponseGate,
  groupDeadLettersByErrorCode,
  hasNextMonitoringPage,
  hasPreviousMonitoringPage,
  hasRunningRun,
  monitoringPageNumber,
  nextMonitoringPage,
  normalizeMonitoringQueryState,
  previousMonitoringPage,
  resolveMonitoringPipelineId,
  withMonitoringDeadLetterStatus,
  withMonitoringPageSize,
  withMonitoringPipelineId,
  withMonitoringPipelineScope,
  withMonitoringRunStatus,
} from '../src/services/integration/monitoringQuery'
import type { IntegrationDeadLetter, IntegrationPipelineRun } from '../src/services/integration/workbench'

// G34 (docs/development/integration-monitoring-reach-design-20260910.md). These tests pin the
// module against what the BACKEND actually accepts today — see the file header for the routes:
// pipelineId is optional, status is a closed set per list, limit ≤ 500, offset ≤ 10000, and NO
// total is returned, so paging can only be "the page came back full".
const SCOPE = { tenantId: 'default', workspaceId: null }

describe('monitoringQuery — request params', () => {
  it('keeps the pre-G34 first screen byte-identical (current pipeline, no run status, limit 5, no offset)', () => {
    const state = createMonitoringQueryState()
    expect(state.pageSize).toBe(MONITORING_DEFAULT_PAGE_SIZE)
    expect(buildRunsRequestParams(state, SCOPE, 'pipe_1')).toEqual({
      tenantId: 'default',
      workspaceId: null,
      pipelineId: 'pipe_1',
      limit: 5,
    })
    // Dead letters keep their 'open' default.
    expect(buildDeadLetterRequestParams(state, SCOPE, 'pipe_1')).toEqual({
      tenantId: 'default',
      workspaceId: null,
      pipelineId: 'pipe_1',
      status: 'open',
      limit: 5,
    })
  })

  it('OMITS pipelineId entirely for a cross-pipeline read (scope=all, or current/custom with no id)', () => {
    const all = withMonitoringPipelineScope(createMonitoringQueryState(), 'all')
    // Even with a saved pipeline available, 'all' must not send it.
    expect(buildRunsRequestParams(all, SCOPE, 'pipe_1')).not.toHaveProperty('pipelineId')
    expect(buildDeadLetterRequestParams(all, SCOPE, 'pipe_1')).not.toHaveProperty('pipelineId')

    // No saved pipeline: the pre-G34 code threw here; now it degrades to cross-pipeline.
    const current = createMonitoringQueryState()
    expect(buildRunsRequestParams(current, SCOPE, '')).not.toHaveProperty('pipelineId')
    expect(resolveMonitoringPipelineId(current, '   ')).toBe('')

    // Blank custom id behaves like 'all' rather than sending `pipelineId=`.
    const blankCustom = withMonitoringPipelineId(withMonitoringPipelineScope(current, 'custom'), '   ')
    expect(buildRunsRequestParams(blankCustom, SCOPE, 'pipe_1')).not.toHaveProperty('pipelineId')
  })

  it('sends the typed pipelineId for scope=custom and never the workbench fallback', () => {
    const custom = withMonitoringPipelineId(withMonitoringPipelineScope(createMonitoringQueryState(), 'custom'), ' pipe_other ')
    expect(buildRunsRequestParams(custom, SCOPE, 'pipe_1').pipelineId).toBe('pipe_other')
  })

  it('forwards only backend-valid statuses and drops unknown ones instead of provoking a 400', () => {
    const failed = withMonitoringRunStatus(createMonitoringQueryState(), 'failed')
    expect(buildRunsRequestParams(failed, SCOPE, 'pipe_1').status).toBe('failed')
    // Dead-letter status is a DIFFERENT closed set: a run status must not leak into it.
    const bogus = withMonitoringDeadLetterStatus(createMonitoringQueryState(), 'failed')
    expect(bogus.deadLetterStatus).toBe('')
    expect(buildDeadLetterRequestParams(bogus, SCOPE, 'pipe_1')).not.toHaveProperty('status')
    // ...and vice versa.
    expect(withMonitoringRunStatus(createMonitoringQueryState(), 'open').runStatus).toBe('')
    expect(withMonitoringDeadLetterStatus(createMonitoringQueryState(), 'replayed').deadLetterStatus).toBe('replayed')
  })

  it('keeps the two lists on separate status filters in a single build', () => {
    const state = withMonitoringDeadLetterStatus(
      withMonitoringRunStatus(createMonitoringQueryState(), 'running'),
      'discarded',
    )
    expect(buildRunsRequestParams(state, SCOPE, 'pipe_1').status).toBe('running')
    expect(buildDeadLetterRequestParams(state, SCOPE, 'pipe_1').status).toBe('discarded')
  })

  it('clamps limit to the backend cap and never emits offset=0', () => {
    const huge = withMonitoringPageSize(createMonitoringQueryState(), 5000)
    expect(huge.pageSize).toBe(MONITORING_MAX_LIMIT)
    expect(buildRunsRequestParams(huge, SCOPE, 'pipe_1').limit).toBe(MONITORING_MAX_LIMIT)
    // 0 is falsy for the query-string builder's drop rule ONLY for ''/null/undefined, so an
    // explicit 0 would show up as `offset=0` in every first-page URL.
    expect(buildRunsRequestParams(createMonitoringQueryState(), SCOPE, 'pipe_1')).not.toHaveProperty('offset')
    expect(buildRunsRequestParams(createMonitoringQueryState({ offset: 20 }), SCOPE, 'pipe_1').offset).toBe(20)
  })

  it('normalizes junk (NaN / negative / unknown scope) instead of forwarding it', () => {
    const normalized = normalizeMonitoringQueryState({
      pipelineScope: 'nonsense' as never,
      pageSize: Number.NaN,
      offset: -50,
      runStatus: 'DROP TABLE',
      deadLetterStatus: 'nope',
    })
    expect(normalized).toEqual({
      pipelineScope: 'current',
      pipelineId: '',
      runStatus: '',
      deadLetterStatus: '',
      pageSize: MONITORING_DEFAULT_PAGE_SIZE,
      offset: 0,
    })
    expect(normalizeMonitoringQueryState({ offset: 999999 }).offset).toBe(MONITORING_MAX_OFFSET)
    expect(normalizeMonitoringQueryState({ pageSize: 0 }).pageSize).toBe(1)
  })
})

describe('monitoringQuery — paging without a server total', () => {
  it('offers a next page only when the page came back FULL (no total exists)', () => {
    const state = createMonitoringQueryState({ pageSize: 5 })
    expect(hasNextMonitoringPage(state, 4)).toBe(false)
    expect(hasNextMonitoringPage(state, 5)).toBe(true)
    expect(hasNextMonitoringPage(state, 0)).toBe(false)
    // A short page must not advance even if asked to.
    expect(nextMonitoringPage(state, 4).offset).toBe(0)
    expect(nextMonitoringPage(state, 5).offset).toBe(5)
  })

  it('refuses to page past the backend offset cap', () => {
    const atCap = createMonitoringQueryState({ pageSize: 5, offset: MONITORING_MAX_OFFSET })
    expect(hasNextMonitoringPage(atCap, 5)).toBe(false)
    expect(nextMonitoringPage(atCap, 5).offset).toBe(MONITORING_MAX_OFFSET)
    const oneBefore = createMonitoringQueryState({ pageSize: 5, offset: MONITORING_MAX_OFFSET - 5 })
    expect(hasNextMonitoringPage(oneBefore, 5)).toBe(true)
  })

  it('walks back to the first page and stops there', () => {
    const page3 = createMonitoringQueryState({ pageSize: 20, offset: 40 })
    expect(hasPreviousMonitoringPage(page3)).toBe(true)
    expect(monitoringPageNumber(page3)).toBe(3)
    const page2 = previousMonitoringPage(page3)
    expect(page2.offset).toBe(20)
    const page1 = previousMonitoringPage(page2)
    expect(page1.offset).toBe(0)
    expect(hasPreviousMonitoringPage(page1)).toBe(false)
    expect(previousMonitoringPage(page1).offset).toBe(0)
  })

  it('resets the cursor on EVERY filter change (a stale offset would hide the new filter first rows)', () => {
    const paged = createMonitoringQueryState({ pageSize: 20, offset: 60 })
    expect(withMonitoringRunStatus(paged, 'failed').offset).toBe(0)
    expect(withMonitoringDeadLetterStatus(paged, 'replayed').offset).toBe(0)
    expect(withMonitoringPipelineScope(paged, 'all').offset).toBe(0)
    expect(withMonitoringPipelineId(paged, 'pipe_x').offset).toBe(0)
    expect(withMonitoringPageSize(paged, 50).offset).toBe(0)
  })

  it('is immutable — every transition returns a new state', () => {
    const state = createMonitoringQueryState()
    const next = withMonitoringRunStatus(state, 'failed')
    expect(next).not.toBe(state)
    expect(state.runStatus).toBe('')
  })
})

describe('monitoringQuery — client-side aggregates the backend does not provide', () => {
  const deadLetters = [
    { errorCode: 'VALIDATION_FAILED', runId: 'run_a' },
    { errorCode: 'K3_SAVE_FAILED', runId: 'run_a' },
    { errorCode: 'VALIDATION_FAILED', runId: 'run_b' },
    { errorCode: '', runId: 'run_b' },
  ] as IntegrationDeadLetter[]

  it('groups dead letters by errorCode, count desc then code asc', () => {
    expect(groupDeadLettersByErrorCode(deadLetters)).toEqual([
      { errorCode: 'VALIDATION_FAILED', count: 2 },
      { errorCode: 'K3_SAVE_FAILED', count: 1 },
      { errorCode: 'UNKNOWN', count: 1 },
    ])
    expect(groupDeadLettersByErrorCode([])).toEqual([])
  })

  it('counts a run dead letters within the loaded page only', () => {
    expect(countDeadLettersForRun(deadLetters, 'run_a')).toBe(2)
    expect(countDeadLettersForRun(deadLetters, 'run_missing')).toBe(0)
    expect(countDeadLettersForRun(deadLetters, '')).toBe(0)
  })

  it('detects a running run (the only status that can still change)', () => {
    const runs = [{ status: 'succeeded' }, { status: 'running' }] as IntegrationPipelineRun[]
    expect(hasRunningRun(runs)).toBe(true)
    expect(hasRunningRun([{ status: 'partial' }] as IntegrationPipelineRun[])).toBe(false)
    expect(hasRunningRun([])).toBe(false)
  })
})

describe('monitoringQuery — response gate', () => {
  it('drops a slow EARLIER response so it cannot repaint a newer page', async () => {
    const gate = createMonitoringResponseGate()
    let painted = 'initial'

    // Two overlapping reads, resolving out of order: the page-1 read (slow) lands AFTER the
    // page-2 read. Without the gate the screen ends up showing page 1 under a page-2 cursor.
    async function read(label: string, delayTicks: number): Promise<void> {
      const ticket = gate.issue()
      for (let i = 0; i < delayTicks; i += 1) await Promise.resolve()
      if (!gate.isCurrent(ticket)) return
      painted = label
    }

    const slowFirst = read('page-1', 4)
    const fastSecond = read('page-2', 0)
    await Promise.all([slowFirst, fastSecond])
    expect(painted).toBe('page-2')
  })

  it('keeps the newest ticket current and invalidates every earlier one', () => {
    const gate = createMonitoringResponseGate()
    const first = gate.issue()
    expect(gate.isCurrent(first)).toBe(true)
    const second = gate.issue()
    expect(gate.isCurrent(first)).toBe(false)
    expect(gate.isCurrent(second)).toBe(true)
  })
})
