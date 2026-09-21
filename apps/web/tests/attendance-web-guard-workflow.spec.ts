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
  // KNOWN CEILING (GATE-5086 NIT-R10): this proves the token is TEXT the runner receives, not that
  // vitest receives it as an argument. An inert line such as `echo <token> is covered elsewhere`
  // inside the block, with the token dropped from the vitest command, stays green. Closing that
  // means parsing the shell command's argv after `vitest run`, which is materially more machinery
  // and itself defeatable (&&, subshells, variable expansion) — so the boundary is documented here
  // rather than chased. Do not read a green here as proof that vitest runs the spec.
  //
  // A `#` INSIDE a block scalar is literal content, not a YAML comment, so the parser keeps it —
  // but the runner's shell treats it as a comment and vitest never receives it (GATE-5086 NIT-R8:
  // dropping a token and adding `# also covers <token>` inside the block left the pin GREEN).
  // Parsing fixes scalar bounds and real YAML comments; this strip fixes shell comments. Both.
  return run
    .split('\n')
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n')
}

/**
 * The required lane's `exec npx vitest run …` as ONE logical command line.
 *
 * Q8 (2026-09-21): that invocation is no longer a single physical line — it is one token per line,
 * backslash-continued and alphabetised, so that concurrent spec-adding branches stop conflicting
 * pairwise on one 11 KB line. A `line.startsWith('exec npx vitest run ')` parse now matches only
 * the header, whose sole "token" is the continuation backslash, and would report every attendance
 * spec below as unregistered. So: strip whole-line `#` comments (the script carries a lot of prose
 * naming files it does NOT run), join continuations, then take the exec line.
 *
 * Asserted-not-assumed: this throws rather than returning '' if the shape is not what it claims, so
 * a future rewrite cannot quietly turn the `toContain` checks below into assertions about ''.
 */
interface LogicalLine {
  line: string
  /** 1-indexed physical line number the logical line STARTS at (before backslash-folding). */
  lineNumber: number
}

/**
 * ALL logical lines of the script, in order, each paired with the physical line number it starts
 * at: strip whole-line `#` comments, then join backslash continuations. This is the ONE fold —
 * `requiredLaneExecCommand()` below and the "nothing survives past exec" assertion both build on
 * it, rather than each carrying their own drift-prone copy of the same three rules.
 *
 * A blank physical line (not a comment, no trailing backslash) folds into its own zero-token
 * logical line rather than disappearing — load-bearing for the assertion below, which must tell
 * "an empty line after exec" (fine) apart from "nothing after exec" (also fine) without confusing
 * either with "a dead token block after exec" (not fine): all three parse to different shapes only
 * if blank lines survive the fold as visible, empty entries.
 */
function logicalLinesWithLineNumbers(script: string): LogicalLine[] {
  // BASH-CORRECT FOLD ORDER (P2-2 fix, independent gate finding 2026-09-22 —
  // `impl-gate-shape-guard-no-trailing-line-20260922.md`; canonical writeup and empirical bash -x
  // transcript live in packages/core-backend/tests/unit/required-web-lane-registration-shape.test.ts's
  // PARSING CONTRACT doc comment, which this function now matches). The PREVIOUS version stripped
  // whole-line `#` comments BEFORE folding continuations — backwards from bash, which removes
  // `\<newline>` pairs before it ever looks for a comment. A `#`-prefixed physical line landing
  // INSIDE a continuation block does not vanish under real bash; it starts a comment that
  // terminates the logical command right there (even when that comment's own physical line ends
  // in `\`), and the NEXT physical line starts a brand-new logical line. A `#`-prefixed physical
  // line OUTSIDE any continuation is still fully invisible, same as before.
  const result: LogicalLine[] = []
  let buf: string | null = null
  let bufStart = -1
  const physical = script.split('\n')
  for (let i = 0; i < physical.length; i++) {
    const line = physical[i].replace(/\r$/, '')
    const isCommentLine = /^\s*#/.test(line)
    if (buf === null) {
      if (isCommentLine) continue
      bufStart = i + 1
      const trimmedRight = line.replace(/\s+$/, '')
      const continued = trimmedRight.endsWith('\\')
      const body = continued ? trimmedRight.slice(0, -1).trim() : trimmedRight.trim()
      if (continued) {
        buf = body
      } else {
        result.push({ line: body, lineNumber: bufStart })
      }
      continue
    }
    if (isCommentLine) {
      result.push({ line: buf, lineNumber: bufStart })
      buf = null
      continue
    }
    const trimmedRight = line.replace(/\s+$/, '')
    const continued = trimmedRight.endsWith('\\')
    const body = continued ? trimmedRight.slice(0, -1).trim() : trimmedRight.trim()
    buf = `${buf} ${body}`.trim()
    if (!continued) {
      result.push({ line: buf, lineNumber: bufStart })
      buf = null
    }
  }
  if (buf !== null) result.push({ line: buf, lineNumber: bufStart })
  return result
}

function requiredLaneExecCommand(script: string): string {
  const execLines = logicalLinesWithLineNumbers(script)
    .map(entry => entry.line)
    .filter(line => /^exec\s+npx\s+vitest\s+run\b/.test(line))
  if (execLines.length !== 1) {
    throw new Error(`run-required-web-tests.sh must have exactly one exec vitest invocation, found ${execLines.length}`)
  }
  return execLines[0]
}

describe('attendance web guard workflow contract', () => {
  it('parses the required lane as one exec logical line, not one physical line', () => {
    // Pins the parsing contract the assertion below depends on, and shows why it changed: the
    // physical-line form yields nothing usable against the current file.
    const required = readFileSync(resolve(process.cwd(), 'scripts/run-required-web-tests.sh'), 'utf8')
    const command = requiredLaneExecCommand(required)
    expect(command.split(/\s+/).length).toBeGreaterThan(300)

    const physical = required.split('\n').find(line => line.startsWith('exec npx vitest run ')) ?? ''
    expect(physical.slice('exec npx vitest run '.length).trim()).toBe('\\')
  })

  /**
   * GATE-5086 follow-up (2026-09-22, independent verification `verify-exec-deadblock-fix-*.md`):
   * four rebased branches each left a SECOND, headerless copy of the required-lane token list —
   * byte-identical to the live block, minus the `exec npx vitest run \` line that makes it live —
   * physically sitting right after the real one. Because it has no `exec` header, it satisfied the
   * "exactly one exec logical line" test above AND every other consumer of this file (the
   * core-backend shape guard included) while registering zero of its tokens with any CI job: dead
   * weight today, a silent black hole for the next token appended to the wrong copy tomorrow.
   *
   * MOVED (2026-09-22, independent gate finding `impl-gate-shape-guard-no-trailing-line-20260922.md`,
   * P2-1): the "has no non-empty logical line anywhere after the required lane exec block"
   * assertion that used to live HERE has been relocated to
   * packages/core-backend/tests/unit/required-web-lane-registration-shape.test.ts, which is the
   * ALWAYS-ON copy — collected by the required, path-filter-free `test (20.x)` / `test (18.x)`
   * context on every PR. This file is collected only by `attendance-web-guard.yml`, and that
   * workflow's changed-file classifier (push `paths` AND the PR `case` block) has zero entries
   * under `apps/web/scripts/**` — a PR shaped exactly like the incident fix commits this file's
   * header describes (each touching only `run-required-web-tests.sh`) would classify
   * `relevant=false` and this spec would not run at all, so a dead block reintroduced by a rebase
   * would silently pass a second time. `requiredLaneExecCommand()` below still depends on
   * `logicalLinesWithLineNumbers()`, so that fold was fixed in place for P2-2 (bash-order comment
   * handling — see its doc comment) even though the trailing-line assertion itself moved out.
   * The always-on copy is authoritative for that invariant; this file keeps its OTHER,
   * `attendance-web-guard.yml`-specific assertions (targeted-run wiring, classifier coverage,
   * session-spec parity) below.
   */

  it('runs makeup regressions in both unit gates and the dedicated browser lane', () => {
    const required = readFileSync(resolve(process.cwd(), 'scripts/run-required-web-tests.sh'), 'utf8')
    const requiredCommand = requiredLaneExecCommand(required)
    for (const spec of ['attendanceEmployeeMakeupRequestCard', 'attendanceEmployeeLeaveRequestCard', 'attendance-selfservice-dashboard']) {
      expect(requiredCommand.split(/\s+/)).toContain(spec)
      expect(targetedRunCommand(workflow).split(/\s+/)).toContain(spec)
    }
    const doc = loadYaml(workflow) as { jobs: Record<string, { steps: Array<{ name?: string; run?: string; if?: string }> }> }
    const steps = Object.values(doc.jobs).flatMap(job => job.steps)
    const browser = steps.find(step => step.name === 'Verify makeup request in real AttendanceView at desktop and mobile sizes')
    expect(browser?.run).toBe('pnpm --filter @metasheet/web exec playwright test --config playwright.attendance-makeup.config.ts')
    expect(browser?.if).toBe("steps.changes.outputs.relevant == 'true'")
    for (const path of ['apps/web/verification/attendance-makeup-request*', 'apps/web/playwright.attendance-makeup.config.ts']) {
      expect(workflow.split(path)).toHaveLength(3)
    }
  })

  const sessionSpecs = ['useAuth', 'useSessionOrg', 'AttendanceSessionOrgSwitcher', 'useAttendanceSessionGuard']
  const sessionSources = [
    'composables/authPrincipal.ts', 'composables/useAuth.ts', 'composables/useSessionOrg.ts',
    'composables/useAttendanceSessionGuard.ts', 'utils/api.ts', 'utils/explicitSessionOrg.ts',
    'services/attendance/effectiveCalendar.ts', 'services/attendance/teamAvailability.ts',
  ].map(path => `apps/web/src/${path}`)

  it.each([...sessionSources, ...sessionSpecs.map(spec => `apps/web/tests/${spec}.spec.ts`), 'apps/web/tests/api.spec.ts'])(
    'selects explicit session change in both push and PR classifiers: %s', path => {
      const doc = loadYaml(workflow) as { on: { push: { paths: string[] } } }
      expect(doc.on.push.paths).toContain(path)
      const cases = workflow.match(/case "\$path" in([\s\S]*?)\)\s*relevant=true/)?.[1]
      expect(cases).toBeTruthy()
      expect(cases!.split(/\|\\?\s*/).map(value => value.trim())).toContain(path)
    },
  )

  /**
   * THE MODULE THAT MADE THIS LANE RED MUST SELECT THIS LANE (refuter finding).
   *
   * `src/utils/delete-fallback.ts` is imported by `utils/api.ts`, i.e. it is in the module graph of
   * every harness this lane boots — and on 2026-09-18 a change to it (its directory, then) took the
   * makeup browser step 6/6 red. The stock-prep lane got a classifier entry for it in the same PR
   * and this lane did not, so a later PR touching only that module would classify relevant=false,
   * skip `playwright test --config playwright.attendance-makeup.config.ts` altogether, and land the
   * red on an unrelated attendance PR afterwards. Both wiring points, same as the session sources.
   */
  it('selects the DELETE-transport fallback module in both push and PR classifiers', () => {
    const path = 'apps/web/src/utils/delete-fallback.ts'
    const doc = loadYaml(workflow) as { on: { push: { paths: string[] } } }
    expect(doc.on.push.paths).toContain(path)
    const cases = workflow.match(/case "\$path" in([\s\S]*?)\)\s*relevant=true/)?.[1]
    expect(cases).toBeTruthy()
    expect(cases!.split(/\|\\?\s*/).map(value => value.trim())).toContain(path)
    // The lane it unlocks is the one that went red — assert it is still gated on the classifier and
    // is the browser step, so this pin cannot be satisfied by a lane that no longer runs Playwright.
    // Select the step that EXECUTES playwright, not merely one whose text contains the config path:
    // the classifier step's own `run` lists `apps/web/playwright.attendance-makeup.config.ts` as a
    // path pattern, so a `includes('playwright.attendance-makeup.config.ts')` search finds THAT step
    // first — it has no `if:` at all, and the assertion read `undefined`.
    const steps = Object.values((loadYaml(workflow) as { jobs: Record<string, { steps?: Array<{ name?: string; run?: string; if?: string }> }> }).jobs)
      .flatMap(job => job.steps ?? [])
    const browser = steps.filter(step => /playwright test --config playwright\.attendance-makeup\.config\.ts/.test(step.run ?? ''))
    expect(browser).toHaveLength(1)
    expect(browser[0].if).toBe("steps.changes.outputs.relevant == 'true'")
  })

  it.each(sessionSpecs)('executes the exact session spec in domain and required commands: %s', spec => {
    const doc = loadYaml(workflow) as { jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }> }
    const step = Object.values(doc.jobs).flatMap(job => job.steps)
      .find(item => item.name === 'Run explicit attendance session specs')
    expect(step?.run).toMatch(/^pnpm --filter @metasheet\/web exec vitest run /)
    expect(step!.run!.trim().split(/\s+/)).toContain(`tests/${spec}.spec.ts`)
    const required = readFileSync(resolve(process.cwd(), 'scripts/run-required-web-tests.sh'), 'utf8')
    const command = required.split('\n').find(line => /^npx vitest run tests\/useAuth\.spec\.ts /.test(line))
    expect(command).toBeTruthy()
    expect(command!.split(/\s+/)).toContain(`tests/${spec}.spec.ts`)
  })

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
    // Bound concurrent AttendanceView transforms without removing any regression specs.
    const args = targetedRunCommand(workflow).trim().split(/\s+/)
    expect(args).toContain('--maxWorkers=2')
    expect(args).toContain('--minWorkers=1')
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
      // Was a whole-file `toContain(' ${spec}')` — the weakest form, and the origin of the original
      // false negative (a token named in the workflow's own prose satisfied it). Same parsed
      // command as the test below, so all eight tokens are now pinned the same way (GATE-5086 §5).
      expect(targetedRunCommand(workflow)).toMatch(new RegExp(`(?:^|\\s)${spec}(?:\\s|$)`))
    }
  })

  // GATE-5086 (P3-8): mutation M9 dropped `attendanceFeatureOverride` from this workflow's
  // targeted `vitest run` list and this file's OTHER contract tests all stayed green — none of
  // them enumerate the fix-1/fix-2 navigability-audit tokens specifically, only the
  // group-context-route family above. Mirrors that test's shape for the three tokens a silent
  // drop would otherwise leave uncovered.
  //
  // The check itself lives in `targetedRunCommand()` above — see its doc comment for why this is
  // parsed rather than sliced out of the file text.
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

  it('keeps attendance-admin tenant-boundary specs in the classifier and targeted run list', () => {
    const targetedRun = targetedRunCommand(workflow)
    for (const spec of [
      'attendanceUserPickerEndpoint',
      'attendanceAdminEndpointCompatibility',
      'useAttendanceAdminProvisioning',
      'useAttendanceAdminUsers',
    ]) {
      expect(workflow.match(new RegExp(`apps/web/tests/${spec}\\.spec\\.ts`, 'g'))).toHaveLength(2)
      expect(targetedRun).toMatch(new RegExp(`(?:^|\\s)${spec}(?:\\s|$)`))
    }
  })

  it('keeps attendance task-home badge and group-access specs in the classifier and targeted run list', () => {
    const targetedRun = targetedRunCommand(workflow)
    for (const spec of [
      'attendanceAdminTaskHomeStatus',
      'attendanceAdminTaskHomeAccess',
    ]) {
      expect(workflow.match(new RegExp(`apps/web/tests/${spec}\\.spec\\.ts`, 'g'))).toHaveLength(2)
      expect(targetedRun).toMatch(new RegExp(`(?:^|\\s)${spec}(?:\\s|$)`))
    }
  })

  it('keeps employee 常用 icon specs in the classifier and targeted run list', () => {
    const targetedRun = targetedRunCommand(workflow)
    for (const spec of [
      'attendanceEmployeeQuickActionIcons',
      'attendanceEmployeeWorkspaceCommonIcons',
      'attendanceEmployeeWorkspacePresentation',
      'useAttendanceAdminConfig',
      'attendanceOverviewRequestReveal',
      'attendanceEmployeeMakeupRequestCard',
    ]) {
      expect(workflow.match(new RegExp(`apps/web/tests/${spec}\\.spec\\.ts`, 'g'))).toHaveLength(2)
      expect(targetedRun).toMatch(new RegExp(`(?:^|\\s)${spec}(?:\\s|$)`))
    }
  })
})
