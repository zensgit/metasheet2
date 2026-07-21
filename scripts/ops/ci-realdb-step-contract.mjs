/**
 * Shared CI real-DB step contract helper (owner ruling on #4496, P2).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The per-lane `*-ci-wiring.test.mjs` guards used to locate their real-DB step by a long
 * `- name:` prefix and then assert MEMBERSHIP of a suite path in that step body. Membership is
 * not EXECUTABILITY: three mutations kept every guard green while the real-DB suites never ran.
 *
 *   1. `if: matrix.node-version == '20.x'` flipped to `'18.x'` (or `false`) — the step never runs
 *      in the required `test (20.x)` leg, so nothing executes.
 *   2. the step's `env.DATABASE_URL` removed — every suite is `describeIfDatabase`-guarded, so the
 *      run silently skips (skip-green).
 *   3. an EARLIER decoy step whose name merely CONTAINS the same prefix
 *      (`- name: Run approval real-DB integration (decoy prep)`) carrying the payload while the
 *      real step is gutted — title-prefix anchoring binds to the decoy.
 *
 * THE OWNER CONTRACT this module implements: locate the step by its EXACT stable `id:` (never by
 * title), and for the located step pin ALL FOUR of
 *
 *   (a) `if: matrix.node-version == '20.x'`   — it runs in the required 20.x leg
 *   (b) an `env.DATABASE_URL` key on the step — the DB-gated suites do not skip-green
 *   (c) the run command uses `--config vitest.integration.config.ts` (not the default config)
 *   (d) the named suite file is a WHOLE-FILE argument of that run command
 *
 * By owner ruling this SHARED module supersedes the earlier per-file-duplication house style: the
 * `*-ci-wiring.test.mjs` guards import it instead of each carrying a private `namedStepBody()`.
 * The module has no CI step of its own — it is exercised in the required no-DB `test` job by all
 * fifteen sibling guards (each already wired to its own `node --test` step), and its mutation
 * (synthetic) coverage lives in `t2gate-collision-mechanism-ci-wiring.test.mjs`, which is likewise
 * already wired. No workflow step was added or modified for it.
 *
 * Parsing note: block scalars (`run: |`) are masked out of the YAML-key surface, so an `if:` /
 * `id:` / `env:` token appearing inside a shell script cannot anchor or satisfy a pin.
 */

/** Stable `id:` values of the two real-DB steps in .github/workflows/plugin-tests.yml. */
export const REAL_DB_STEP_IDS = Object.freeze({
  approval: 'approval-real-db-integration',
  multitable: 'multitable-real-db-integration',
})

/**
 * Split a workflow into YAML sequence-item blocks (candidate steps).
 * Each block runs from its `- ` line through (not including) the next line at the same or
 * shallower indent that starts a new sequence item or a new mapping key.
 *
 * @param {string} wf
 * @returns {{ indent: number, start: number, lines: string[] }[]}
 */
function sequenceItemBlocks(wf) {
  const lines = wf.split('\n')
  const blocks = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)-\s+\S/)
    if (!m) continue
    const indent = m[1].length
    const body = []
    let j = i + 1
    for (; j < lines.length; j++) {
      const line = lines[j]
      if (/^\s*$/.test(line)) {
        body.push(line)
        continue
      }
      const lead = (line.match(/^(\s*)/) || ['', ''])[1].length
      if (lead <= indent) break
      body.push(line)
    }
    blocks.push({ indent, start: i, lines: body })
  }
  return blocks
}

/**
 * Blank out block-scalar content (`key: |`, `key: >`, with optional chomping indicators) so shell
 * text inside `run:` cannot be mistaken for YAML keys. Line count is preserved.
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
function maskBlockScalars(lines) {
  const out = []
  let scalarIndent = null
  for (const line of lines) {
    if (scalarIndent !== null) {
      const lead = (line.match(/^(\s*)/) || ['', ''])[1].length
      if (/^\s*$/.test(line) || lead > scalarIndent) {
        out.push('')
        continue
      }
      scalarIndent = null
    }
    const m = line.match(/^(\s*)[\w.-]+:\s*[|>][-+]?\d*\s*$/)
    if (m) {
      scalarIndent = m[1].length
      out.push(line)
      continue
    }
    out.push(line)
  }
  return out
}

/**
 * Extract the workflow step carrying the EXACT `id: <stepId>` key, as a step child key
 * (indent === item indent + 2) outside any block scalar. Title text is never consulted, so a
 * name-prefix decoy cannot anchor here.
 *
 * @param {string} wf raw workflow YAML
 * @param {string} stepId exact id value
 * @returns {{ id: string, body: string, yamlBody: string } | null} null when no such step exists
 */
export function extractStepById(wf, stepId) {
  for (const block of sequenceItemBlocks(wf)) {
    const masked = maskBlockScalars(block.lines)
    const childIndent = block.indent + 2
    const idRe = new RegExp(`^\\s{${childIndent}}id:\\s*['"]?${escapeRe(stepId)}['"]?\\s*$`)
    if (!masked.some((line) => idRe.test(line))) continue
    return { id: stepId, body: block.lines.join('\n'), yamlBody: masked.join('\n') }
  }
  return null
}

/** @param {string} s */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Pin (a): the step is conditioned on the required 20.x matrix leg. `if: false`, `'18.x'`, or a
 * missing `if:` all return false. Comment lines and `run:` script text do not count.
 *
 * @param {{ yamlBody: string }} step
 */
export function stepRunsOnNode20Matrix(step) {
  return step.yamlBody
    .split('\n')
    .some((line) => /^\s*if:\s*matrix\.node-version\s*==\s*['"]20\.x['"]\s*$/.test(line))
}

/**
 * Pin (b): the step has a real YAML `env:` mapping child with a `DATABASE_URL:` key. Comment lines
 * and free-text mentions do not count. Without it every describeIfDatabase suite skips green.
 *
 * @param {{ yamlBody: string }} step
 */
export function stepHasEnvDatabaseUrl(step) {
  const lines = step.yamlBody.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const envM = /^(\s*)env:\s*$/.exec(lines[i])
    if (!envM) continue
    const envIndent = envM[1].length
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue
      const indent = (line.match(/^(\s*)/) || ['', ''])[1].length
      if (indent <= envIndent) break
      if (/^\s*DATABASE_URL:\s*\S/.test(line)) return true
    }
  }
  return false
}

/**
 * Pin (c): a non-comment run command invokes `vitest` with
 * `--config vitest.integration.config.ts`. The default `vitest.config.ts` excludes every DB-gated
 * suite, so running under it is a silent no-op.
 *
 * @param {{ body: string }} step
 */
export function stepInvokesVitestIntegrationConfig(step) {
  for (const line of step.body.split('\n')) {
    if (/^\s*#/.test(line)) continue
    const code = line.replace(/(^|[^\\])#.*$/, '$1')
    if (!/\bvitest\b/.test(code)) continue
    if (/--config\s+vitest\.integration\.config\.ts\b/.test(code)) return true
  }
  return false
}

/**
 * Ordered whole-file vitest path args in the step's run command
 * (`tests/integration/foo.db.test.ts`, optional trailing `\`). Comment lines ignored.
 *
 * @param {{ body: string }} step
 * @returns {string[]}
 */
export function wholeFileVitestArgs(step) {
  const files = []
  for (const line of step.body.split('\n')) {
    if (/^\s*#/.test(line)) continue
    const m = line.match(/^\s+(tests\/integration\/\S+\.(?:test|spec)\.[tj]sx?)\s*(?:\\)?\s*$/)
    if (m) files.push(m[1])
  }
  return files
}

/**
 * Locate the step by exact id and pin the three EXECUTABILITY properties (a)(b)(c).
 * Throws with a specific message on any failure.
 *
 * @param {string} wf
 * @param {string} stepId
 * @returns {{ id: string, body: string, yamlBody: string }}
 */
export function requireExecutableRealDbStep(wf, stepId) {
  const step = extractStepById(wf, stepId)
  if (step == null) {
    throw new Error(
      `real-DB step id "${stepId}" not found in plugin-tests.yml — steps are located by exact ` +
        `id, never by name prefix (a name-prefix decoy must not be able to stand in for it)`,
    )
  }
  if (!stepRunsOnNode20Matrix(step)) {
    throw new Error(
      `real-DB step id "${stepId}" must carry if: matrix.node-version == '20.x' — otherwise it ` +
        `never runs in the required test (20.x) leg and the suites silently do not execute`,
    )
  }
  if (!stepHasEnvDatabaseUrl(step)) {
    throw new Error(
      `real-DB step id "${stepId}" must have env.DATABASE_URL (a real YAML key, not a comment) — ` +
        `otherwise every describeIfDatabase suite in it skips green`,
    )
  }
  if (!stepInvokesVitestIntegrationConfig(step)) {
    throw new Error(
      `real-DB step id "${stepId}" must run vitest with --config vitest.integration.config.ts — ` +
        `the default vitest.config.ts excludes these DB-gated suites, so they would not run`,
    )
  }
  return step
}

/**
 * Full four-pin contract: the step located by exact id is executable (a)(b)(c) AND lists `file`
 * as a whole-file vitest argument (d). Throws on (a)(b)(c); returns a boolean for (d) so callers
 * can attach their own message.
 *
 * @param {string} wf
 * @param {string} stepId
 * @param {string} file suite path relative to packages/core-backend
 * @returns {boolean}
 */
export function isSuiteWiredInRealDbStep(wf, stepId, file) {
  const step = requireExecutableRealDbStep(wf, stepId)
  return wholeFileVitestArgs(step).includes(file)
}

/**
 * Whole-file args of the step with this id, for NEGATIVE placement assertions ("must not also be
 * wired into the other real-DB step"). Requires the step to exist and be executable, so a negative
 * assertion cannot pass merely because the other step was deleted or disabled.
 *
 * @param {string} wf
 * @param {string} stepId
 * @returns {string[]}
 */
export function realDbStepWholeFileArgs(wf, stepId) {
  return wholeFileVitestArgs(requireExecutableRealDbStep(wf, stepId))
}
