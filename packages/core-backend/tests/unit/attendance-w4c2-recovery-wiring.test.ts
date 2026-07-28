import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pluginSource = readFileSync(
  new URL('../../../../plugins/plugin-attendance/index.cjs', import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n')

describe('W4C-2 scheduled-run recovery wiring', () => {
  it('registers the env-gated sweep with a plugin context rebuild for the exact scanned run', () => {
    const registration = pluginSource.match(
      /w4ScheduledRunSweepRunOnce = \(\) => attendanceW4SegmentCalculationPort\.sweepScheduledRuns\(\{[\s\S]*?\n\s*\}\)/,
    )?.[0]

    expect(registration).toBeDefined()
    expect(registration).toContain('recoverCandidate: (candidate) => runAutoAbsenceForOrgDate')
    expect(registration).toContain('skipDedup: true')
    expect(registration).toContain('w4Boundary: w4LiveScheduledBoundary')
    expect(registration).toContain('initiator: candidate.initiator')
    expect(registration).toContain('recoveryRunId: candidate.runId')
    expect(pluginSource).toContain(
      'if (recoveryRunId === null && calendarOverrides.length === 0 && holiday && holiday.isWorkingDay === false)',
    )
  })

  it('routes recovery through the dedicated exact-run boundary instead of ordinary create-or-resume', () => {
    expect(pluginSource).toContain('w4Boundary.recoverScheduledRun({ ...boundaryInput, runId: recoveryRunId })')
    expect(pluginSource).toContain('w4Boundary.executeScheduledRun({ ...boundaryInput, adminActorId })')
  })

  it('defers process-local dedup to the posture-aware boundary', () => {
    expect(pluginSource).toContain('const legacyDedupHit = !skipDedup && key === lastAutoAbsenceKey')
    expect(pluginSource).toContain('if (!w4Boundary && legacyDedupHit)')
    expect(pluginSource).toContain('legacyDedupHit,')
    expect(pluginSource).toContain("outcome.kind === 'legacy_dedup'")
    expect(pluginSource).not.toContain('if (!skipDedup && key === lastAutoAbsenceKey)')
  })
})
