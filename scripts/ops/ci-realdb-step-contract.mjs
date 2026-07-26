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
 * THE OWNER CONTRACT: locate the step by its EXACT stable `id:` (never by title), and for the
 * located step pin ALL FOUR of
 *
 *   (a) `if: matrix.node-version == '20.x'`   — it runs in the required 20.x leg
 *   (b) an `env.DATABASE_URL` key on the step whose value is a LITERAL PostgreSQL URL — the
 *       DB-gated suites do not skip-green (owner ruling 2026-07-21, round 6). Two refusals:
 *       - NO Actions expression anywhere in the value (any occurrence of `${{`): at runtime
 *         GitHub resolves a missing secret/context to the EMPTY string, so
 *         `${{ secrets.DOES_NOT_EXIST }}` reads as non-empty text here while DATABASE_URL is ''
 *         in the job and every describeIfDatabase suite skips green (owner-reproduced bypass).
 *         Mixed literal+expression (`postgresql://user:${{ secrets.PW }}@host/db`) is refused
 *         too: the guard runs pre-install and cannot evaluate expressions, so it cannot prove
 *         the expression part resolves to anything at all.
 *       - the remaining literal must be scheme-anchored (`postgres://` / `postgresql://`, see
 *         LITERAL_POSTGRES_URL_RE) — `true`, `1`, `file.txt` are non-empty text but not a DB
 *         URL. Empty in ANY spelling thereby stays rejected as before: `''`, `""`, `"   "`, a
 *         bare key, `~`, `null`, `!!str` with no content, an anchored/aliased empty string
 *         (`&a ""` / `*a`), and a block scalar (`|` / `>` + chomping/indent indicators) with an
 *         empty or whitespace-only body — the parser resolves them all to '' or null.
 *   (c) a REAL vitest invocation in the run script uses `--config vitest.integration.config.ts`
 *       (not the default config); the executed binary is resolved per command, so `echo vitest …`
 *       or any other non-vitest binary is not an invocation
 *   (d) the named suite file is a WHOLE-FILE argument of THAT SAME invocation — (c) and (d) are
 *       joint, so a config flag in one command and the file in another cannot combine
 *
 * HOW THE YAML IS READ (owner ruling, round 5 — 2026-07-21, binding)
 * ------------------------------------------------------------------
 * Rounds 1–4 read the workflow with a hand-rolled text masker (regex step discovery over a
 * blanked-scalar view of the raw lines). Successive gates kept finding NEW YAML SPELLINGS that
 * defeated it — `"run": |` / `'run': |` (quoted keys), `run : |` (spaced key), bare sequence-item
 * block scalars (`- |`), `!!str` / `~` / `null` / `&a ""` empty values — because a text masker
 * re-implements the YAML grammar one spelling at a time. The owner ruled that chasing spellings is
 * the wrong shape: this module now feeds the workflow to a REAL YAML parser and reads the four
 * pins off the parsed structure (`jobs` → job → `steps[]` → step keys). There is no masking, no
 * regex step discovery, and no per-spelling special case left: any spelling of a scalar is just a
 * scalar value after parsing, so shell text can never be read as YAML structure, and any spelling
 * of an empty value is just `''`/`null`.
 *
 * WHY python3 + PyYAML AND NOT js-yaml: these guards execute in the required no-DB `test` job
 * BEFORE `pnpm install` (deliberately — see the "fails the required `test` check fast, before the
 * pnpm install/build" comment in plugin-tests.yml), so no npm package is importable at that point.
 * The GitHub `ubuntu-latest` runner's system `python3` ships PyYAML (the `test` job does not use
 * setup-python, so `python3` is the distro interpreter); the bridge is FAIL-CLOSED regardless: a
 * missing interpreter, a missing PyYAML, or a YAML parse error all throw — with distinguishable
 * `PYYAML_MISSING:` / `YAML_PARSE_ERROR:` prefixes — and every guard goes red. A workflow PyYAML
 * cannot parse is also a workflow GitHub will not run, so a parse failure is never a green path.
 *
 * PyYAML notes, both fail-closed or irrelevant here:
 *   - duplicate mapping keys: PyYAML keeps the LAST one. GitHub rejects a workflow file with
 *     duplicate keys outright (the run errors before any job starts), so a duplicate-key spelling
 *     cannot pass CI at all — whichever copy the bridge reports is moot.
 *   - YAML 1.1 booleans (`on:` parses as `true`): only `jobs` is read; keys are stringified in the
 *     bridge so the JSON hand-off never drops them.
 *
 * By owner ruling this SHARED module supersedes the earlier per-file-duplication house style: the
 * `*-ci-wiring.test.mjs` guards import it instead of each carrying a private `namedStepBody()`.
 * The module has no CI step of its own — it is exercised in the required no-DB `test` job by all
 * fifteen sibling guards (each already wired to its own `node --test` step), and its mutation
 * (synthetic) coverage lives in `t2gate-collision-mechanism-ci-wiring.test.mjs`, which is likewise
 * already wired. No workflow step was added or modified for it.
 */

import { spawnSync } from 'node:child_process'

/**
 * Stable `id:` values of the real-DB steps in .github/workflows/plugin-tests.yml that share
 * THIS module's `requireExecutableRealDbStep` four-pin contract (all four pins, including
 * `if: matrix.node-version == '20.x'`, hold for both entries).
 *
 * DELIBERATELY DOES NOT include the third real-DB step, "Run attendance integration tests"
 * (id `attendance-real-db-integration`, added #4612 gate4 round 4, P3-4): that step runs
 * UNCONDITIONALLY on both matrix legs (no `if:` pin at all) rather than being restricted to
 * 20.x, so it does not satisfy pin (a) as this module defines it. `t2gate-collision-mechanism-
 * ci-wiring.test.mjs` iterates `Object.values(REAL_DB_STEP_IDS)` and asserts the FULL four-pin
 * contract (including 20.x-only) on every entry — adding `attendance` here once made that
 * existing, already-wired guard fail for a step that was never meant to satisfy that pin (caught
 * by running the full `scripts/ops/*-ci-wiring.test.mjs` sibling suite before landing, #4612
 * gate4 round 4). The attendance step's own id is instead a local constant in
 * `attendance-w4c2-ci-wiring.test.mjs`, which composes its own (looser, "unconditional-or-20.x")
 * equivalent of pin (a) from the lower-level exports below instead of this frozen allowlist.
 */
export const REAL_DB_STEP_IDS = Object.freeze({
  approval: 'approval-real-db-integration',
  multitable: 'multitable-real-db-integration',
})

// ---------------------------------------------------------------------------
// YAML parse bridge (python3 + PyYAML → JSON), fail-closed
// ---------------------------------------------------------------------------

/**
 * The whole bridge: stdin = YAML text, stdout = JSON document. Distinguishable failures:
 * exit 3 `PYYAML_MISSING:` (interpreter has no yaml module), exit 4 `YAML_PARSE_ERROR:`
 * (the text is not valid YAML). Keys are stringified because YAML 1.1 scalars like `on`
 * parse to booleans, which json.dump would otherwise coerce ambiguously; values json.dump
 * cannot encode (e.g. timestamps) fall back to str().
 */
const PY_YAML_TO_JSON = [
  'import json, sys',
  'try:',
  '    import yaml',
  'except Exception as exc:',
  "    sys.stderr.write('PYYAML_MISSING: %r' % (exc,))",
  '    sys.exit(3)',
  'try:',
  '    doc = yaml.safe_load(sys.stdin.read())',
  'except Exception as exc:',
  "    sys.stderr.write('YAML_PARSE_ERROR: %r' % (exc,))",
  '    sys.exit(4)',
  'def jsonable(node):',
  '    if isinstance(node, dict):',
  '        return {str(key): jsonable(value) for key, value in node.items()}',
  '    if isinstance(node, list):',
  '        return [jsonable(value) for value in node]',
  '    return node',
  'json.dump(jsonable(doc), sys.stdout, default=str)',
].join('\n')

/** One parse per distinct workflow text per process (guards re-read the same file repeatedly). */
const parseCache = new Map()

/**
 * Parse YAML text into a plain JS document via the PyYAML bridge. Throws — fails CLOSED — when
 * python3 cannot be spawned, PyYAML is absent, or the text is not valid YAML. A guard that cannot
 * parse the workflow must go red, never silently green.
 *
 * @param {string} wf
 * @returns {unknown}
 */
function parseYamlDocument(wf) {
  if (parseCache.has(wf)) return parseCache.get(wf)
  const res = spawnSync('python3', ['-c', PY_YAML_TO_JSON], {
    input: wf,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  })
  if (res.error) {
    throw new Error(
      `real-DB step contract: failing CLOSED — python3 could not be spawned for the YAML parse ` +
        `(${res.error.message}). These guards run before pnpm install in the required test job, ` +
        `so the system python3 + PyYAML is the YAML parser they depend on.`,
    )
  }
  if (res.status !== 0) {
    throw new Error(
      `real-DB step contract: failing CLOSED — the PyYAML bridge exited ${res.status}: ` +
        `${(res.stderr || '').trim() || '(no stderr)'}`,
    )
  }
  let doc
  try {
    doc = JSON.parse(res.stdout)
  } catch (err) {
    throw new Error(
      `real-DB step contract: failing CLOSED — the PyYAML bridge emitted unparseable JSON: ${err.message}`,
    )
  }
  parseCache.set(wf, doc)
  return doc
}

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// Step location + pins (a)/(b), read off the parsed structure
// ---------------------------------------------------------------------------

/**
 * The workflow step carrying the EXACT `id: <stepId>` key. Jobs are scanned in document order and
 * within each job the `steps` array in order; the FIRST match wins (the "same id in an EARLIER
 * job" residual is accepted by owner stop-line). Title text is never consulted, so a name-prefix
 * decoy cannot anchor here; and because the lookup walks PARSED structure, text inside any scalar
 * value — a `run:` script in any spelling, a heredoc, a bare `- |` list item — is just a string
 * and can never be discovered as a step.
 *
 * @param {string} wf raw workflow YAML
 * @param {string} stepId exact id value
 * @returns {Record<string, unknown> | null} the parsed step mapping, or null when no such step
 *   exists. Throws (fail-closed) when the text is not valid YAML at all.
 */
export function extractStepById(wf, stepId) {
  const doc = parseYamlDocument(wf)
  if (!isPlainObject(doc) || !isPlainObject(doc.jobs)) return null
  for (const jobName of Object.keys(doc.jobs)) {
    const job = doc.jobs[jobName]
    if (!isPlainObject(job) || !Array.isArray(job.steps)) continue
    for (const step of job.steps) {
      if (isPlainObject(step) && step.id === stepId) return step
    }
  }
  return null
}

/**
 * Pin (a): the step is conditioned on the required 20.x matrix leg. A missing `if:`, `if: false`
 * (a YAML boolean, not a string), `'18.x'`, or any other expression all return false.
 *
 * @param {Record<string, unknown>} step parsed step mapping
 */
export function stepRunsOnNode20Matrix(step) {
  const cond = isPlainObject(step) ? step.if : undefined
  if (typeof cond !== 'string') return false
  return /^matrix\.node-version\s*==\s*['"]20\.x['"]$/.test(cond.trim())
}

/**
 * Pin (b) literal-shape test: an anchored PostgreSQL connection URL — one of the two official
 * schemes (`postgres://` / `postgresql://`), at least one non-whitespace character after the
 * scheme, nothing else (`^…$`).
 *
 * WHY SCHEME-ANCHORING IS THE RIGHT LITERAL-SHAPE TEST: this pin exists to stop skip-green, and
 * it runs pre-install on text — it cannot dial the database and it cannot evaluate expressions.
 * The strongest property it CAN prove is that the value is already, literally, a Postgres URL:
 * every working libpq/node-postgres connection string starts with one of these two schemes, and
 * none of the skip-green artifacts do — `''`, `~`, `true`, `1`, `file.txt`, or whatever an
 * unevaluated `${{ … }}` might resolve to. Anchoring both ends (with `\S+`, no internal
 * whitespace) means the URL cannot smuggle a prefix/suffix around the scheme. Deeper validation
 * (host/port/db present, credentials) would re-implement the URL grammar for no additional
 * skip-green protection: describeIfDatabase gates on truthiness only, so a malformed-but-
 * scheme-anchored literal makes the suites fail LOUDLY at connect — red, which is not this
 * pin's bypass class.
 */
const LITERAL_POSTGRES_URL_RE = /^postgres(?:ql)?:\/\/\S+$/

/**
 * Pin (b): the step has a real `env` mapping with a `DATABASE_URL` key whose PARSED value is a
 * LITERAL PostgreSQL URL (owner ruling 2026-07-21, round 6 — supersedes the round-5 "non-empty
 * string" contract, which had a skip-green bypass the owner reproduced live):
 *
 *   1. the value must be a string containing NO Actions expression — any occurrence of `${{` is
 *      refused, mixed literal+expression included. At runtime GitHub resolves a missing
 *      secret/context to the EMPTY string, so `${{ secrets.DOES_NOT_EXIST }}` is non-empty TEXT
 *      here but '' in the job: DATABASE_URL is empty, every describeIfDatabase suite skips, the
 *      run is skip-green. This guard executes pre-install and cannot evaluate expressions, so it
 *      cannot tell a resolving expression from a vanishing one — it must refuse them all. (The
 *      real workflow needs no expression: both guarded steps carry the literal
 *      `postgresql://postgres@localhost:5432/metasheet_test`.)
 *   2. after trim, the value must match LITERAL_POSTGRES_URL_RE (rationale above) — `true`, `1`,
 *      `file.txt` are non-empty text but not a DB URL; a non-string scalar (YAML `true` / `1` /
 *      `~` / `null`) can never be one.
 *
 * The parser has already resolved every spelling before this predicate runs: quoted/plain
 * scalars, block scalars (`|`/`>` + chomping/indent, empty or whitespace-only body → `''`),
 * `!!str` with no content (→ `''`), `~` / `null` / bare key (→ null), anchors and aliases
 * (`&a ""` / `*a` → `''`). Comment lines and free-text mentions were never structure to begin
 * with, and every empty spelling fails the URL shape exactly as it failed "non-empty".
 *
 * @param {Record<string, unknown>} step parsed step mapping
 */
export function stepHasEnvDatabaseUrl(step) {
  const env = isPlainObject(step) ? step.env : undefined
  if (!isPlainObject(env)) return false
  if (!Object.prototype.hasOwnProperty.call(env, 'DATABASE_URL')) return false
  const value = env.DATABASE_URL
  if (typeof value !== 'string') return false
  if (value.includes('${{')) return false
  return LITERAL_POSTGRES_URL_RE.test(value.trim())
}

// ---------------------------------------------------------------------------
// Run-script command parsing (pins (c)+(d) are checked on ONE real vitest command)
//
// This half parses SHELL, not YAML: the parsed step's `run` value is the exact script text a
// runner would hand to bash. Bash-exact comment/continuation handling and per-command binary
// resolution below are unchanged from round 4 — the owner ruling replaced the YAML reading, and
// shell-semantics gaps (`true || vitest …` never executing) remain accepted residuals.
// ---------------------------------------------------------------------------

/**
 * The step's `run:` script text, line by line. After the YAML parse this is the scalar's actual
 * content whatever its spelling was (block scalar, folded, quoted, plain — quoted/spaced key
 * forms included). A step without a string `run` has no script.
 *
 * @param {Record<string, unknown>} step parsed step mapping
 * @returns {string[]}
 */
function runScriptLines(step) {
  const run = isPlainObject(step) ? step.run : undefined
  return typeof run === 'string' ? run.split('\n') : []
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
 * Every REAL vitest invocation in the step's `run:` script, with its own argument list.
 *
 * Comment handling follows bash exactly, because both directions are exploitable:
 *   - a `#` line that STARTS a logical line is a comment and is dropped whole — a trailing `\` on a
 *     comment line does NOT continue it (bash ends the comment at the newline), so the next line
 *     stays an independent command;
 *   - a `#` line reached WHILE a `\` continuation is open is joined in, and the `#` then terminates
 *     that logical command — so the lines after it are NOT arguments of the interrupted command.
 * Each logical line is then split on `;` / `&&` / `||` / `|` / `&`, and every command is judged by
 * the binary IT executes.
 *
 * @param {Record<string, unknown>} step parsed step mapping
 * @returns {{ args: string[], usesIntegrationConfig: boolean, wholeFileArgs: string[] }[]}
 */
export function vitestInvocations(step) {
  const script = runScriptLines(step)
  const logical = []
  let pending = null
  for (const line of script) {
    if (pending === null && /^\s*#/.test(line)) continue // whole-line comment, `\` does not continue
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
 * @param {Record<string, unknown>} step parsed step mapping
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
 * @param {Record<string, unknown>} step parsed step mapping
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
 * @returns {Record<string, unknown>} the parsed step mapping
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
        `whose value is a LITERAL PostgreSQL URL (anchored postgres:// or postgresql://). ` +
        `Actions expressions are refused — any \${{ … }} anywhere in the value, mixed ` +
        `literal+expression included: a missing secret/context resolves to the EMPTY string at ` +
        `runtime, so the suites skip green while the text reads non-empty, and this guard runs ` +
        `pre-install so it cannot evaluate expressions. Empty in any spelling ('' / "" / ` +
        `whitespace-only / ~ / null / !!str / an aliased empty string / an empty block scalar) ` +
        `and non-URL literals (true / 1 / file.txt) do not count either — otherwise every ` +
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
