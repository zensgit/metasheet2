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
 * Two further skip-green bypasses were reproduced by the owner against the id-anchored contract
 * and are closed here (round 3):
 *
 *   4. `DATABASE_URL: ''` — an empty (or whitespace-only, or empty-quoted) value is a PRESENT YAML
 *      key, so a "key exists" pin greened it, yet an empty DATABASE_URL makes every
 *      `describeIfDatabase` suite skip: exactly the skip-green pin (b) exists to stop.
 *   5. a DECOY COMMAND LINE inside the same `run:` script (`echo vitest --config
 *      vitest.integration.config.ts`) satisfying the config pin while the REAL suite invocation
 *      runs under the default config — because the config token and the file arguments were
 *      matched across the whole step body rather than within ONE actual vitest command.
 *
 * THE OWNER CONTRACT this module implements: locate the step by its EXACT stable `id:` (never by
 * title), and for the located step pin ALL FOUR of
 *
 *   (a) `if: matrix.node-version == '20.x'`   — it runs in the required 20.x leg
 *   (b) an `env.DATABASE_URL` key on the step with a NON-EMPTY value — the DB-gated suites do not
 *       skip-green (`''`, `""`, `"   "` and a bare key are all rejected)
 *   (c) a REAL vitest invocation in the run script uses `--config vitest.integration.config.ts`
 *       (not the default config); the executed binary is resolved per command, so `echo vitest …`
 *       or any other non-vitest binary is not an invocation
 *   (d) the named suite file is a WHOLE-FILE argument of THAT SAME invocation — (c) and (d) are
 *       joint, so a config flag in one command and the file in another cannot combine
 *
 * By owner ruling this SHARED module supersedes the earlier per-file-duplication house style: the
 * `*-ci-wiring.test.mjs` guards import it instead of each carrying a private `namedStepBody()`.
 * The module has no CI step of its own — it is exercised in the required no-DB `test` job by all
 * fifteen sibling guards (each already wired to its own `node --test` step), and its mutation
 * (synthetic) coverage lives in `t2gate-collision-mechanism-ci-wiring.test.mjs`, which is likewise
 * already wired. No workflow step was added or modified for it.
 *
 * Parsing note: block scalars (`run: |`) are masked out of the YAML-key surface, so an `if:` /
 * `id:` / `env:` token appearing inside a shell script cannot anchor or satisfy a pin. Conversely
 * pins (c)/(d) parse ONLY the `run:` script text, split into individual shell commands, and resolve
 * the binary each command executes — so YAML titles, comments and non-vitest commands are inert.
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
 * Strip one layer of matching surrounding quotes and trailing inline comment from a scalar YAML
 * value, then trim. `''` / `""` / `"   "` all collapse to the empty string.
 *
 * @param {string} raw
 * @returns {string}
 */
function scalarYamlValue(raw) {
  let v = raw.trim()
  const quoted = /^(['"])([\s\S]*)\1\s*(?:#.*)?$/.exec(v)
  if (quoted) return quoted[2].trim()
  // Unquoted scalar: an inline `# ...` comment needs a preceding space to start a comment.
  v = v.replace(/\s+#.*$/, '')
  return v.trim()
}

/**
 * Pin (b): the step has a real YAML `env:` mapping child with a `DATABASE_URL:` key carrying a
 * NON-EMPTY value. Comment lines and free-text mentions do not count, and neither does an empty
 * value: `DATABASE_URL: ''` (owner repro), `""`, `"   "` or a bare `DATABASE_URL:` all leave the
 * variable unset/empty at runtime, so every describeIfDatabase suite skips green — the very
 * bypass this pin exists to stop.
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
      const dbM = /^\s*DATABASE_URL:(.*)$/.exec(line)
      if (dbM && scalarYamlValue(dbM[1]) !== '') return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Run-script command parsing (pins (c)+(d) are checked on ONE real vitest command)
// ---------------------------------------------------------------------------

/**
 * Concatenated shell text of the step's `run:` values (block scalar `run: |` content, or an inline
 * `run: <cmd>`). Everything outside `run:` (names, comments, other YAML keys) is dropped, so only
 * text that a runner would actually execute is parsed.
 *
 * @param {string[]} bodyLines raw (unmasked) step body lines
 * @returns {string[]}
 */
function runScriptLines(bodyLines) {
  const out = []
  for (let i = 0; i < bodyLines.length; i++) {
    const block = /^(\s*)run:\s*[|>][-+]?\d*\s*$/.exec(bodyLines[i])
    if (block) {
      const keyIndent = block[1].length
      for (let j = i + 1; j < bodyLines.length; j++) {
        const line = bodyLines[j]
        if (/^\s*$/.test(line)) {
          out.push('')
          continue
        }
        const indent = (line.match(/^(\s*)/) || ['', ''])[1].length
        if (indent <= keyIndent) {
          i = j - 1
          break
        }
        out.push(line)
        i = j
      }
      continue
    }
    const inline = /^\s*run:\s+(\S.*)$/.exec(bodyLines[i])
    if (inline) out.push(inline[1])
  }
  return out
}

/**
 * Tokenize one logical shell line into words and control operators, honouring single/double quotes
 * and backslash escapes. A `#` that starts a word begins a comment (rest of line dropped). `;`,
 * `&&`, `||`, `|` and a standalone `&` are emitted as separators.
 *
 * @param {string} str
 * @returns {{ type: 'word' | 'op', value: string }[]}
 */
function shellTokens(str) {
  const tokens = []
  let cur = ''
  let started = false
  const flush = () => {
    if (started) tokens.push({ type: 'word', value: cur })
    cur = ''
    started = false
  }
  let i = 0
  while (i < str.length) {
    const ch = str[i]
    if (ch === '\\' && i + 1 < str.length) {
      cur += str[i + 1]
      started = true
      i += 2
      continue
    }
    if (ch === "'") {
      started = true
      i += 1
      while (i < str.length && str[i] !== "'") cur += str[i++]
      i += 1
      continue
    }
    if (ch === '"') {
      started = true
      i += 1
      while (i < str.length && str[i] !== '"') {
        if (str[i] === '\\' && i + 1 < str.length) {
          cur += str[i + 1]
          i += 2
          continue
        }
        cur += str[i++]
      }
      i += 1
      continue
    }
    if (/\s/.test(ch)) {
      flush()
      i += 1
      continue
    }
    if (ch === '#' && !started) break
    if (ch === ';' || ch === '|' || ch === '&') {
      const double = str[i + 1] === ch && (ch === '|' || ch === '&')
      // `2>&1` is a redirection, not a background operator: a single `&` glued to more text
      // (and not preceded by whitespace at word start) must not truncate the command.
      if (!double && ch === '&' && started) {
        cur += ch
        i += 1
        continue
      }
      flush()
      tokens.push({ type: 'op', value: double ? ch + ch : ch })
      i += double ? 2 : 1
      continue
    }
    cur += ch
    started = true
    i += 1
  }
  flush()
  return tokens
}

/** Package runners that can front a `vitest` binary. */
const RUNNER_BINARIES = new Set(['pnpm', 'pnpx', 'npm', 'npx', 'yarn', 'bun', 'bunx', 'corepack'])
/** Runner subcommands that precede the real binary. */
const RUNNER_SUBCOMMANDS = new Set(['exec', 'dlx', 'x'])
/** Runner flags that consume the following token as their value. */
const RUNNER_VALUE_FLAGS = new Set(['--filter', '-F', '-C', '--dir', '--prefix', '--package', '-p'])

/** @param {string} token */
function isVitestBinary(token) {
  return /(?:^|\/)vitest(?:\.[cm]?js)?$/.test(token)
}

/**
 * Resolve the binary a command actually executes and return its argument list — or null when the
 * executed binary is not `vitest`. `echo vitest --config …`, `pnpm exec echo vitest …`,
 * `: "${DATABASE_URL:?…}"` and `npm run some-script` all resolve to a non-vitest binary and are
 * therefore NOT vitest invocations.
 *
 * @param {string[]} words
 * @returns {string[] | null}
 */
function vitestArgsOfCommand(words) {
  let i = 0
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1 // leading VAR=val
  if (i >= words.length) return null
  if (isVitestBinary(words[i])) return words.slice(i + 1)
  if (!RUNNER_BINARIES.has(words[i].replace(/^.*\//, ''))) return null
  i += 1
  let sawSubcommand = false
  while (i < words.length) {
    const token = words[i]
    if (isVitestBinary(token)) return words.slice(i + 1)
    if (token.startsWith('-')) {
      i += RUNNER_VALUE_FLAGS.has(token) ? 2 : 1
      continue
    }
    if (!sawSubcommand && RUNNER_SUBCOMMANDS.has(token)) {
      sawSubcommand = true
      i += 1
      continue
    }
    return null // some other binary / script name — cannot prove vitest runs
  }
  return null
}

/** @param {string[]} args */
function argsUseIntegrationConfig(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    let value = null
    if (arg === '--config' || arg === '-c') value = args[i + 1]
    else if (arg.startsWith('--config=')) value = arg.slice('--config='.length)
    if (value == null) continue
    if (/(?:^|\/)vitest\.integration\.config\.[tj]s$/.test(value)) return true
  }
  return false
}

/**
 * Every REAL vitest invocation in the step's `run:` script, with its own argument list. Full-line
 * `#` comments are dropped BEFORE `\` continuations are joined (bash ends a comment at the
 * newline), then each logical line is split on `;` / `&&` / `||` / `|` / `&` so each command is
 * judged by the binary IT executes.
 *
 * @param {{ body: string }} step
 * @returns {{ args: string[], usesIntegrationConfig: boolean, wholeFileArgs: string[] }[]}
 */
export function vitestInvocations(step) {
  const script = runScriptLines(step.body.split('\n')).filter((line) => !/^\s*#/.test(line))
  const logical = []
  let pending = null
  for (const line of script) {
    const continued = /\\\s*$/.test(line)
    const text = continued ? line.replace(/\\\s*$/, ' ') : line
    pending = pending === null ? text : pending + text
    if (!continued) {
      logical.push(pending)
      pending = null
    }
  }
  if (pending !== null) logical.push(pending)

  const invocations = []
  for (const line of logical) {
    let words = []
    const commands = []
    for (const token of shellTokens(line)) {
      if (token.type === 'op') {
        commands.push(words)
        words = []
        continue
      }
      words.push(token.value)
    }
    commands.push(words)
    for (const command of commands) {
      const args = vitestArgsOfCommand(command)
      if (args == null) continue
      invocations.push({
        args,
        usesIntegrationConfig: argsUseIntegrationConfig(args),
        wholeFileArgs: args.filter((a) => /^tests\/integration\/\S+\.(?:test|spec)\.[tj]sx?$/.test(a)),
      })
    }
  }
  return invocations
}

/**
 * Pin (c): at least one REAL vitest invocation in the run script uses
 * `--config vitest.integration.config.ts`. The default `vitest.config.ts` excludes every DB-gated
 * suite, so running under it is a silent no-op — and a decoy line such as
 * `echo vitest --config vitest.integration.config.ts` executes `echo`, not vitest, so it does not
 * satisfy the pin (owner repro).
 *
 * @param {{ body: string }} step
 */
export function stepInvokesVitestIntegrationConfig(step) {
  return vitestInvocations(step).some((inv) => inv.usesIntegrationConfig)
}

/**
 * Ordered whole-file vitest path args (`tests/integration/foo.db.test.ts`) of the invocations that
 * ACTUALLY run under `vitest.integration.config.ts`. Files listed on a different command (default
 * config, `echo`, a comment) are not reported, which makes pins (c) and (d) joint: the config flag
 * and the suite argument must belong to the same real vitest command.
 *
 * @param {{ body: string }} step
 * @returns {string[]}
 */
export function wholeFileVitestArgs(step) {
  return vitestInvocations(step)
    .filter((inv) => inv.usesIntegrationConfig)
    .flatMap((inv) => inv.wholeFileArgs)
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
      `real-DB step id "${stepId}" must have env.DATABASE_URL as a real YAML key (not a comment) ` +
        `with a NON-EMPTY value ('' / "" / whitespace-only do not count) — otherwise every ` +
        `describeIfDatabase suite in it skips green`,
    )
  }
  if (!stepInvokesVitestIntegrationConfig(step)) {
    throw new Error(
      `real-DB step id "${stepId}" must run a REAL vitest command with ` +
        `--config vitest.integration.config.ts (the executed binary must be vitest — an ` +
        `\`echo vitest --config …\` decoy does not count) — the default vitest.config.ts excludes ` +
        `these DB-gated suites, so they would not run`,
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
