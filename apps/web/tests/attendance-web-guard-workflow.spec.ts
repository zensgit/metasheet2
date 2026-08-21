import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const workflowPath = resolve(process.cwd(), '../../.github/workflows/attendance-web-guard.yml')
const workflow = readFileSync(workflowPath, 'utf8')

describe('attendance web guard workflow contract', () => {
  it('creates one stable check for every pull request', () => {
    const pullRequestStart = workflow.indexOf('\n  pull_request:')
    const pushStart = workflow.indexOf('\n  push:', pullRequestStart)
    expect(pullRequestStart).toBeGreaterThan(-1)
    expect(pushStart).toBeGreaterThan(pullRequestStart)
    expect(workflow.slice(pullRequestStart, pushStart)).toBe('\n  pull_request:')
    expect(workflow).toContain('name: Report success for unrelated changes')
    expect(workflow).toContain("if: steps.changes.outputs.relevant == 'false'")
  })

  it('keeps this contract spec in the classifier and targeted run list', () => {
    const stepStart = workflow.indexOf('      - name: Run attendance web guard specs (targeted)')
    const nextStepStart = workflow.indexOf('\n      - name:', stepStart + 1)
    const targetedStep = workflow.slice(stepStart, nextStepStart === -1 ? undefined : nextStepStart)
    expect(stepStart).toBeGreaterThan(-1)
    expect(workflow.match(/apps\/web\/tests\/attendance-web-guard-workflow\.spec\.ts/g)).toHaveLength(2)
    expect(workflow).toContain(' attendance-web-guard-workflow.spec --reporter=dot')
    expect(workflow).toContain("if: steps.changes.outputs.relevant == 'true'")
    expect(targetedStep).toContain('NODE_OPTIONS: --max-old-space-size=8192')
    expect(workflow.match(/NODE_OPTIONS: --max-old-space-size=8192/g)).toHaveLength(1)
  })

  it('keeps the group-context route host proof in the classifier and targeted run list', () => {
    expect(workflow.match(/apps\/web\/src\/router\/attendanceGroupContextRoute\.ts/g)).toHaveLength(2)
    for (const spec of [
      'attendance-experience-mobile-zh',
      'attendanceGroupContextRoute',
      'attendanceGroupContextHost',
      'attendanceGroupRouteHydration',
      'attendance-group-context-history',
    ]) {
      expect(workflow.match(new RegExp(`apps/web/tests/${spec}\\.spec\\.ts`, 'g'))).toHaveLength(2)
      expect(workflow).toContain(` ${spec}`)
    }
  })

  // GATE-5086 (P3-8): mutation M9 dropped `attendanceFeatureOverride` from this workflow's
  // targeted `vitest run` list and this file's OTHER contract tests all stayed green — none of
  // them enumerate the fix-1/fix-2 navigability-audit tokens specifically, only the
  // group-context-route family above. Mirrors that test's shape for the three tokens a silent
  // drop would otherwise leave uncovered.
  //
  // NOTE: unlike the group-context-route test above, this one does NOT use a bare
  // `workflow.toContain(' ${spec}')` check on the whole file — these three token names also
  // appear, with a leading space, in this workflow's own explanatory prose comment near the top
  // ("... specs land here: attendanceCapabilityUnavailable.spec.ts ..."), which would make that
  // check pass even with the token deleted from the run list (confirmed: re-running mutation M9
  // against a `toContain`-only version of this test left it GREEN). Scope the check to the
  // extracted "Run attendance web guard specs (targeted)" step body instead, with a whitespace
  // boundary so it cannot match as a substring of a different token in either direction.
  it('keeps the fix 1/fix 2 navigability-audit specs in the classifier and targeted run list', () => {
    expect(workflow.match(/apps\/web\/src\/stores\/featureFlags\.ts/g)).toHaveLength(2)
    const stepStart = workflow.indexOf('      - name: Run attendance web guard specs (targeted)')
    const nextStepStart = workflow.indexOf('\n      - name:', stepStart + 1)
    const targetedStep = workflow.slice(stepStart, nextStepStart === -1 ? undefined : nextStepStart)
    expect(stepStart).toBeGreaterThan(-1)
    for (const spec of [
      'attendanceCapabilityUnavailable',
      'attendanceRequestReviewEntitlement',
      'attendanceFeatureOverride',
    ]) {
      expect(workflow.match(new RegExp(`apps/web/tests/${spec}\\.spec\\.ts`, 'g'))).toHaveLength(2)
      expect(targetedStep).toMatch(new RegExp(`(?:^|\\s)${spec}(?:\\s|$)`))
    }
  })
})
