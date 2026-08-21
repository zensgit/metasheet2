import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { load as loadYaml } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const workflowPath = resolve(process.cwd(), '../../.github/workflows/attendance-web-guard.yml')
const workflow = readFileSync(workflowPath, 'utf8')

const TARGETED_STEP_NAME = 'Run attendance web guard specs (targeted)'

/**
 * The `run:` command of the targeted step, obtained by PARSING the workflow rather than slicing it.
 *
 * History (GATE-5086): a text-based version of this check was defeated at three successive levels —
 * whole-file `toContain` (the token also appears in the workflow's own prose comment), then the
 * step block (a `#` comment inside the step satisfied it), then the step block with `#` stripped
 * (trailing YAML after the last step landed in the unbounded slice). Narrowing a fourth time would
 * invite a fifth. The parser already knows where a scalar ends and what a comment is, so ask it:
 * `run` is exactly the text the runner executes, with no comments and no neighbouring YAML.
 */
function targetedRunCommand(source: string): string {
  const doc = loadYaml(source) as {
    jobs?: Record<string, { steps?: Array<{ name?: string; run?: string }> }>
  }
  const steps = Object.values(doc?.jobs ?? {}).flatMap((job) => job?.steps ?? [])
  const matches = steps.filter((step) => step?.name === TARGETED_STEP_NAME)
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one "${TARGETED_STEP_NAME}" step, found ${matches.length}`,
    )
  }
  const run = matches[0]?.run
  if (typeof run !== 'string' || run.trim().length === 0) {
    throw new Error(`"${TARGETED_STEP_NAME}" step has no run command`)
  }
  return run
}

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
    const targetedRun = targetedRunCommand(workflow)
    for (const spec of [
      'attendanceCapabilityUnavailable',
      'attendanceRequestReviewEntitlement',
      'attendanceFeatureOverride',
    ]) {
      expect(workflow.match(new RegExp(`apps/web/tests/${spec}\\.spec\\.ts`, 'g'))).toHaveLength(2)
      expect(targetedRun).toMatch(new RegExp(`(?:^|\\s)${spec}(?:\\s|$)`))
    }
  })
})
