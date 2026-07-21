import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  REAL_DB_STEP_IDS,
  extractStepById,
  isSuiteWiredInRealDbStep,
  realDbStepWholeFileArgs,
  requireExecutableRealDbStep,
  stepHasEnvDatabaseUrl,
  stepInvokesVitestIntegrationConfig,
  stepRunsOnNode20Matrix,
  wholeFileVitestArgs,
} from './ci-realdb-step-contract.mjs'

// T2-Gate CI two-point wiring contract. The collision-mechanism suite is the CI-provable half of
// the §3.4 two-corp question: the (provider, external_key) unique index, the bare-unionId
// derivation, and the wholesale second-corp sync failure signature (closed classifications:
// duplicate_key_detected + expected_constraint_detected — never raw error_message in operator
// evidence; see t2gate-runbook-values-free-contract.test.mjs, co-run by the same no-DB CI step).
//
// Two load-bearing placements (both must hold or CI can stay green while the suite never runs):
//   (1) exact quoted path inside the real `test.exclude` array of vitest.config.ts
//       (a comment / coverage.exclude / nested exclude / free-text hit is NOT enough)
//   (2) the suite is a whole-file vitest arg of the real-DB step located by its EXACT stable
//       `id:` — and that step is EXECUTABLE: `if: matrix.node-version == '20.x'`, a real
//       `env.DATABASE_URL` with a NON-EMPTY value, and a REAL vitest invocation under
//       `--config vitest.integration.config.ts` that carries the suite path as its OWN argument
//       (pins (c) and (d) are judged on the same command, so a decoy line cannot supply either)
//
// THIS FILE ALSO HOSTS the shared helper's synthetic mutation coverage (owner ruling on #4496).
// `scripts/ops/ci-realdb-step-contract.mjs` is imported by all fifteen `*-ci-wiring.test.mjs`
// guards, each already wired to its own `node --test` step in the required no-DB `test` job — so
// the helper's real-workflow path runs in CI fifteen times over. Its MUTATION coverage needs a CI
// home too; it lives here rather than in a new file so that no `plugin-tests.yml` step had to be
// added or modified (that file is shared with every other lane; this PR's only workflow change is
// the two `id:` lines). The synthetics feed the helper CRAFTED workflow strings, so they cannot rot
// with the real file.
//
// Helpers parse source structure — mere whole-file filename / keyword search is insufficient.
// Runs in the gating no-DB test job.
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const FILE = 'tests/integration/directory-account-external-key-collision-mechanism.db.test.ts'
const STEP_ID = REAL_DB_STEP_IDS.approval
const VITEST_CFG = join(repoRoot, 'packages/core-backend/vitest.config.ts')
const WORKFLOW = join(repoRoot, '.github/workflows/plugin-tests.yml')

// ---------------------------------------------------------------------------
// vitest.config.ts source parsers (exported for synthetic mutation coverage)
// ---------------------------------------------------------------------------

/**
 * Strip // line comments and "..." / '...' string literals so brace scanning
 * does not trip on braces inside comments/strings. Good enough for vitest config.
 * @param {string} src
 * @returns {string} same length; non-code regions replaced with spaces
 */
function maskCommentsAndStrings(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    // line comment
    if (src[i] === '/' && src[i + 1] === '/') {
      out += '  '
      i += 2
      while (i < src.length && src[i] !== '\n') {
        out += ' '
        i += 1
      }
      continue
    }
    // block comment
    if (src[i] === '/' && src[i + 1] === '*') {
      out += '  '
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i += 1
      }
      if (i < src.length) {
        out += '  '
        i += 2
      }
      continue
    }
    // single- or double-quoted string (no template literals needed for exclude arrays)
    if (src[i] === "'" || src[i] === '"') {
      const q = src[i]
      out += ' '
      i += 1
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\' && i + 1 < src.length) {
          out += '  '
          i += 2
          continue
        }
        out += src[i] === '\n' ? '\n' : ' '
        i += 1
      }
      if (i < src.length) {
        out += ' '
        i += 1
      }
      continue
    }
    out += src[i]
    i += 1
  }
  return out
}

/**
 * Body of the direct `test.exclude: [ ... ]` array only — property of the `test` object
 * at brace depth 1. Nested `coverage.exclude` (or any later/deeper exclude) is ignored.
 * @param {string} src
 * @returns {string | null} raw array body, or null if no direct test.exclude
 */
export function extractTestExcludeArrayBody(src) {
  const masked = maskCommentsAndStrings(src)
  const testKey = /\btest\s*:\s*\{/.exec(masked)
  if (!testKey) return null
  // Position of the `{` that opens the test object.
  const openBrace = masked.indexOf('{', testKey.index + testKey[0].length - 1)
  if (openBrace < 0) return null

  let depth = 1
  let i = openBrace + 1
  while (i < masked.length && depth > 0) {
    const ch = masked[i]
    if (ch === '{') {
      depth += 1
      i += 1
      continue
    }
    if (ch === '}') {
      depth -= 1
      i += 1
      continue
    }
    // Direct property of `test` only (depth === 1).
    if (depth === 1) {
      const rest = masked.slice(i)
      const m = /^(exclude\s*:\s*\[)/.exec(rest)
      if (m) {
        const bracketOpen = i + m[1].length - 1 // index of `[`
        let bDepth = 0
        for (let j = bracketOpen; j < masked.length; j++) {
          if (masked[j] === '[') bDepth += 1
          else if (masked[j] === ']') {
            bDepth -= 1
            if (bDepth === 0) {
              // Slice the ORIGINAL source so quoted entries stay intact.
              return src.slice(bracketOpen + 1, j)
            }
          }
        }
        return null
      }
    }
    i += 1
  }
  return null
}

/**
 * Quoted string entries in an exclude-array body. Strips // line comments first so a
 * decoy path that only appears in a comment is NOT counted as an exclude entry.
 * @param {string} arrayBody
 * @returns {string[]}
 */
export function quotedExcludeEntries(arrayBody) {
  const noLineComments = arrayBody
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
  const entries = []
  const re = /'([^']+)'|"([^"]+)"/g
  let m
  while ((m = re.exec(noLineComments)) !== null) {
    entries.push(m[1] ?? m[2])
  }
  return entries
}

/** @param {string} src @param {string} file */
export function isQuotedInTestExclude(src, file) {
  const body = extractTestExcludeArrayBody(src)
  if (body == null) return false
  return quotedExcludeEntries(body).includes(file)
}

// ---------------------------------------------------------------------------
// Repo contracts (real sources)
// ---------------------------------------------------------------------------

test('vitest.config.ts quotes the T2-Gate collision-mechanism suite inside test.exclude', () => {
  const cfg = readFileSync(VITEST_CFG, 'utf8')
  assert.ok(
    isQuotedInTestExclude(cfg, FILE),
    `test.exclude must contain the exact quoted entry '${FILE}' ` +
      `(a comment / coverage.exclude / free-text hit is not placement)`,
  )
})

test('plugin-tests.yml runs the suite as a whole file in the id-located, executable approval real-DB step', () => {
  const wf = readFileSync(WORKFLOW, 'utf8')
  assert.ok(
    isSuiteWiredInRealDbStep(wf, STEP_ID, FILE),
    `plugin-tests.yml real-DB step id "${STEP_ID}" (if 20.x + env.DATABASE_URL + ` +
      `vitest.integration.config.ts) must list ${FILE} as a whole-file vitest arg`,
  )
  // Negative: multitable real-DB must not be the (sole) placement.
  assert.equal(
    realDbStepWholeFileArgs(wf, REAL_DB_STEP_IDS.multitable).includes(FILE),
    false,
    `${FILE} must not be wired into the multitable real-DB step`,
  )
})

test('both real-DB steps in plugin-tests.yml carry their stable ids and satisfy all four pins', () => {
  const wf = readFileSync(WORKFLOW, 'utf8')
  for (const id of Object.values(REAL_DB_STEP_IDS)) {
    const step = requireExecutableRealDbStep(wf, id)
    assert.equal(stepRunsOnNode20Matrix(step), true, `${id}: pin (a) if 20.x`)
    assert.equal(stepHasEnvDatabaseUrl(step), true, `${id}: pin (b) env.DATABASE_URL`)
    assert.equal(stepInvokesVitestIntegrationConfig(step), true, `${id}: pin (c) integration config`)
    assert.ok(wholeFileVitestArgs(step).length > 0, `${id}: pin (d) whole-file suite args`)
  }
})

// ---------------------------------------------------------------------------
// vitest.config.ts synthetic / mutation guards (in-memory)
// ---------------------------------------------------------------------------

test('synthetic: path only in a comment outside the exclude array does not count as excluded', () => {
  const decoy = [
    "export default defineConfig({",
    '  test: {',
    '    // decoy mention only: ' + `'${FILE}'`,
    '    exclude: [',
    "      '**/node_modules/**',",
    "      'tests/integration/other.db.test.ts',",
    '    ],',
    '  },',
    '})',
  ].join('\n')
  assert.ok(decoy.includes(`'${FILE}'`), 'decoy source still mentions the path')
  assert.equal(
    isQuotedInTestExclude(decoy, FILE),
    false,
    'comment-only / outside-array decoy must not satisfy test.exclude placement',
  )
})

test('synthetic: path only inside coverage.exclude (with a sibling empty top-level exclude) does not count', () => {
  // Path lives only under coverage.exclude; top-level test.exclude exists but without FILE.
  const decoy = [
    "export default defineConfig({",
    '  test: {',
    '    exclude: [',
    "      '**/node_modules/**',",
    '    ],',
    '    coverage: {',
    '      exclude: [',
    `        '${FILE}',`,
    '      ],',
    '    },',
    '  },',
    '})',
  ].join('\n')
  assert.ok(decoy.includes(`'${FILE}'`))
  assert.equal(
    isQuotedInTestExclude(decoy, FILE),
    false,
    'coverage.exclude decoy must not satisfy test.exclude placement',
  )
})

test('synthetic: no top-level test.exclude — coverage.exclude-only must NOT false-green', () => {
  // Exact Codex repro: first exclude after test: is nested coverage.exclude.
  // Prior parser took that first exclude and greened; depth-1 parse must red.
  const decoy = [
    'export default defineConfig({',
    '  test: {',
    '    coverage: {',
    '      exclude: [',
    `        '${FILE}',`,
    '      ],',
    '    },',
    '  },',
    '});',
  ].join('\n')
  assert.ok(decoy.includes(`'${FILE}'`), 'repro source still mentions the path')
  assert.equal(
    extractTestExcludeArrayBody(decoy),
    null,
    'no direct test.exclude property → extract must return null (not coverage.exclude)',
  )
  assert.equal(
    isQuotedInTestExclude(decoy, FILE),
    false,
    'coverage-only / no-top-level-exclude must not satisfy test.exclude placement',
  )
})

test('synthetic positive: exact quoted entry inside direct test.exclude passes', () => {
  const ok = [
    "export default defineConfig({",
    '  test: {',
    '    exclude: [',
    "      '**/node_modules/**',",
    `      '${FILE}',`,
    '    ],',
    '    coverage: {',
    '      exclude: [',
    "        'tests/**',",
    '      ],',
    '    },',
    '  },',
    '})',
  ].join('\n')
  assert.equal(isQuotedInTestExclude(ok, FILE), true)
  // Sibling coverage.exclude path must not be confused with the direct entry.
  assert.equal(isQuotedInTestExclude(ok, 'tests/**'), false)
})

// ---------------------------------------------------------------------------
// SHARED HELPER synthetic / mutation guards (ci-realdb-step-contract.mjs)
//
// Each mutation below is one of the green bypasses the owner ruled must RED. The helper is fed a
// CRAFTED workflow string (never the real file), so this coverage cannot rot.
// ---------------------------------------------------------------------------

const NODE20_IF = "        if: matrix.node-version == '20.x'"
const DB_ENV = [
  '        env:',
  '          DATABASE_URL: postgresql://postgres@localhost:5432/metasheet_test',
]

/**
 * Craft a one-real-DB-step workflow. Every knob corresponds to one pin of the owner contract, so a
 * mutation is expressed by changing exactly one knob.
 */
function craftWorkflow({
  ifLines = [NODE20_IF],
  envLines = DB_ENV,
  config = 'vitest.integration.config.ts',
  file = FILE,
  stepId = STEP_ID,
  withIdStep = true,
  withPrefixDecoy = false,
  runPrefixLines = [],
  runSuffixLines = [],
} = {}) {
  const payload = [
    ...ifLines,
    ...envLines,
    '        run: |',
    '          : "${DATABASE_URL:?DATABASE_URL is required}"',
    ...runPrefixLines,
    `          pnpm --filter @metasheet/core-backend exec vitest --config ${config} run \\`,
    `            ${file} \\`,
    '            --reporter=dot',
    ...runSuffixLines,
  ]
  const lines = ['jobs:', '  test:', '    steps:']
  // The decoy is placed EARLIER, exactly as the reproduced bypass did.
  if (withPrefixDecoy) {
    lines.push('      - name: Run approval real-DB integration (decoy prep)', ...payload)
  }
  if (withIdStep) {
    lines.push(
      '      - name: Run approval real-DB integration (directory endpoints)',
      `        id: ${stepId}`,
      ...payload,
    )
  }
  lines.push('      - name: Next step', '        run: echo ok')
  return lines.join('\n')
}

test('synthetic POSITIVE: the crafted well-formed workflow satisfies all four pins', () => {
  const wf = craftWorkflow()
  const step = requireExecutableRealDbStep(wf, STEP_ID)
  assert.equal(stepRunsOnNode20Matrix(step), true)
  assert.equal(stepHasEnvDatabaseUrl(step), true)
  assert.equal(stepInvokesVitestIntegrationConfig(step), true)
  assert.equal(isSuiteWiredInRealDbStep(wf, STEP_ID, FILE), true)
})

test('synthetic MUTATION 1: name-prefix decoy carrying the payload while the id step is gone must RED', () => {
  // Reproduced bypass #3: an earlier step whose name merely CONTAINS "Run approval real-DB
  // integration" holds env + integration config + the file arg, and the real step is gutted/absent.
  // Title-prefix anchoring bound to the decoy and stayed green; id-anchoring finds nothing.
  const wf = craftWorkflow({ withPrefixDecoy: true, withIdStep: false })
  assert.ok(wf.includes('Run approval real-DB integration'), 'decoy still carries the title prefix')
  assert.ok(wf.includes(FILE), 'decoy still lists the suite path')
  assert.equal(extractStepById(wf, STEP_ID), null, 'no step carries the exact id')
  assert.throws(
    () => isSuiteWiredInRealDbStep(wf, STEP_ID, FILE),
    /not found in plugin-tests\.yml|located by exact/,
    'a name-prefix decoy must not be able to stand in for the id-located step',
  )
})

test('synthetic CONTROL: a name-prefix decoy alongside a healthy id step is simply ignored', () => {
  // Positive control for MUTATION 1: id-anchoring is decoy-INSENSITIVE, so the presence of a decoy
  // is not itself a failure. Without this control MUTATION 1 could pass for the wrong reason.
  const wf = craftWorkflow({ withPrefixDecoy: true, withIdStep: true })
  assert.equal(isSuiteWiredInRealDbStep(wf, STEP_ID, FILE), true)
})

test('synthetic MUTATION 2: non-20.x / false step condition must RED', () => {
  // Reproduced bypass #1: the step never runs in the required `test (20.x)` leg.
  for (const mutated of [
    ["        if: matrix.node-version == '18.x'", /if: matrix\.node-version == '20\.x'|20\.x/],
    ['        if: false', /if: matrix\.node-version == '20\.x'|20\.x/],
    [null, /if: matrix\.node-version == '20\.x'|20\.x/], // `if:` removed entirely
  ]) {
    const [ifLine, sig] = mutated
    const wf = craftWorkflow({ ifLines: ifLine === null ? [] : [ifLine] })
    assert.ok(wf.includes(FILE), 'the suite path is still listed — membership alone must not pass')
    const step = extractStepById(wf, STEP_ID)
    assert.notEqual(step, null, 'the id step still exists; only its condition was mutated')
    assert.equal(stepRunsOnNode20Matrix(step), false)
    assert.throws(() => isSuiteWiredInRealDbStep(wf, STEP_ID, FILE), sig, `if=${ifLine}`)
  }
})

test('synthetic MUTATION 3: env.DATABASE_URL removed must RED', () => {
  // Reproduced bypass #2: describeIfDatabase makes every suite skip green without a DB URL.
  const wf = craftWorkflow({ envLines: [] })
  assert.ok(wf.includes(FILE), 'the suite path is still listed')
  assert.equal(stepHasEnvDatabaseUrl(extractStepById(wf, STEP_ID)), false)
  assert.throws(
    () => isSuiteWiredInRealDbStep(wf, STEP_ID, FILE),
    /env\.DATABASE_URL/,
    'a step without env.DATABASE_URL must not satisfy the contract',
  )
})

test('synthetic MUTATION 4: config swapped to the default vitest.config.ts must RED', () => {
  // The default config EXCLUDES every DB-gated suite, so the run is a silent no-op.
  const wf = craftWorkflow({ config: 'vitest.config.ts' })
  assert.ok(wf.includes(FILE), 'the suite path is still listed')
  assert.equal(stepInvokesVitestIntegrationConfig(extractStepById(wf, STEP_ID)), false)
  assert.throws(
    () => isSuiteWiredInRealDbStep(wf, STEP_ID, FILE),
    /vitest\.integration\.config\.ts/,
    'the default config must not satisfy the contract',
  )
})

test('synthetic MUTATION 5: empty / whitespace-only / bare env.DATABASE_URL must RED', () => {
  // Owner repro (a) on the id-anchored contract: `DATABASE_URL: ''` is a PRESENT YAML key, so a
  // "key exists" pin greened it — but an empty DATABASE_URL makes every describeIfDatabase suite
  // skip, i.e. exactly the skip-green pin (b) exists to stop.
  for (const value of ["''", '""', '"   "', "'  '", '']) {
    const wf = craftWorkflow({ envLines: ['        env:', `          DATABASE_URL: ${value}`] })
    assert.ok(wf.includes('DATABASE_URL'), 'the env key is still present — presence alone must not pass')
    assert.ok(wf.includes(FILE), 'the suite path is still listed')
    const step = extractStepById(wf, STEP_ID)
    assert.notEqual(step, null, 'the id step still exists; only the env VALUE was mutated')
    assert.equal(stepHasEnvDatabaseUrl(step), false, `DATABASE_URL: ${value} must not count`)
    assert.throws(
      () => isSuiteWiredInRealDbStep(wf, STEP_ID, FILE),
      /env\.DATABASE_URL/,
      `DATABASE_URL: ${value} must not satisfy the contract`,
    )
  }
  // Positive control: the pin is not "reject every env value" — a real URL, and an inline-commented
  // real URL, both still pass.
  for (const value of [
    'postgresql://postgres@localhost:5432/metasheet_test',
    "'postgresql://postgres@localhost:5432/metasheet_test'",
    'postgresql://postgres@localhost:5432/metasheet_test # real DB',
  ]) {
    const ok = craftWorkflow({ envLines: ['        env:', `          DATABASE_URL: ${value}`] })
    assert.equal(stepHasEnvDatabaseUrl(extractStepById(ok, STEP_ID)), true, `value ${value}`)
    assert.equal(isSuiteWiredInRealDbStep(ok, STEP_ID, FILE), true, `value ${value}`)
  }
})

test('synthetic MUTATION 6: an echo decoy carrying the integration config while the real command uses the default config must RED', () => {
  // Owner repro (b) on the id-anchored contract: the config token and the file arguments were
  // matched across the WHOLE step body, so a decoy command line satisfied pin (c) while the only
  // real vitest invocation ran under the default config (which excludes every DB-gated suite).
  for (const decoy of [
    '          echo vitest --config vitest.integration.config.ts',
    '          echo "vitest --config vitest.integration.config.ts run"',
    '          pnpm --filter @metasheet/core-backend exec echo vitest --config vitest.integration.config.ts',
    '          # pnpm exec vitest --config vitest.integration.config.ts',
  ]) {
    const wf = craftWorkflow({ config: 'vitest.config.ts', runPrefixLines: [decoy] })
    assert.ok(
      wf.includes('vitest.integration.config.ts') && wf.includes(FILE),
      'the config token AND the suite path are both still present in the step body',
    )
    const step = extractStepById(wf, STEP_ID)
    assert.equal(stepInvokesVitestIntegrationConfig(step), false, `decoy: ${decoy.trim()}`)
    assert.deepEqual(wholeFileVitestArgs(step), [], `decoy: ${decoy.trim()}`)
    assert.throws(
      () => isSuiteWiredInRealDbStep(wf, STEP_ID, FILE),
      /vitest\.integration\.config\.ts/,
      `a non-vitest decoy command must not satisfy pin (c): ${decoy.trim()}`,
    )
  }
})

test('synthetic MUTATION 6b: config on one real command + suite file on another must RED for that file', () => {
  // The same split-across-commands hole with TWO real vitest invocations: pin (c) is genuinely
  // satisfied by the first command, but FILE is only ever an argument of the default-config
  // command, so it never runs. Pins (c) and (d) must be judged on the SAME invocation.
  const wf = craftWorkflow({
    file: 'tests/integration/other.db.test.ts',
    runSuffixLines: [
      '          pnpm --filter @metasheet/core-backend exec vitest --config vitest.config.ts run \\',
      `            ${FILE} \\`,
      '            --reporter=dot',
    ],
  })
  assert.ok(wf.includes(FILE), 'FILE is still an argument of a REAL vitest command in the step')
  const step = extractStepById(wf, STEP_ID)
  // Positive control: pin (c) holds and the integration-config command's own file IS reported —
  // the miss below is joint-scoping, not a collapsed parse.
  assert.equal(stepInvokesVitestIntegrationConfig(step), true)
  assert.deepEqual(wholeFileVitestArgs(step), ['tests/integration/other.db.test.ts'])
  assert.equal(isSuiteWiredInRealDbStep(wf, STEP_ID, FILE), false)
  assert.equal(isSuiteWiredInRealDbStep(wf, STEP_ID, 'tests/integration/other.db.test.ts'), true)
})

test('synthetic MUTATION 6c: a comment interrupting the continuation detaches the suite args must RED', () => {
  // Same class as (b), found while writing the command splitter: in bash a `#` line reached while a
  // `\` continuation is open TERMINATES that command, so the lines after it are NOT arguments of the
  // vitest invocation — they are separate commands and never run. Treating them as arguments would
  // be a false-green.
  const wf = [
    'jobs:', '  test:', '    steps:',
    '      - name: Run approval real-DB integration (directory endpoints)',
    `        id: ${STEP_ID}`,
    NODE20_IF,
    ...DB_ENV,
    '        run: |',
    '          pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \\',
    '          # temporarily parked',
    `            ${FILE} \\`,
    '            --reporter=dot',
    '      - name: Next step', '        run: echo ok',
  ].join('\n')
  assert.ok(wf.includes(FILE), 'the suite path is still textually inside the run script')
  const step = extractStepById(wf, STEP_ID)
  // Positive control: pin (c) still holds — the vitest command itself is intact and real.
  assert.equal(stepInvokesVitestIntegrationConfig(step), true)
  assert.deepEqual(wholeFileVitestArgs(step), [], 'args after the interrupting comment are detached')
  assert.equal(isSuiteWiredInRealDbStep(wf, STEP_ID, FILE), false)
})

test('synthetic CONTROL: a whole-line comment before the command does NOT swallow it, even with a trailing backslash', () => {
  // The mirror of MUTATION 6c: bash ends a comment at the newline, so a `\` on a COMMENT line does
  // not continue it and the real command below stays intact. Without this control, 6c could be
  // "satisfied" by a parser that drops everything after any `#`.
  const wf = craftWorkflow({
    runPrefixLines: ['          # parked command follows \\', '          echo staging'],
  })
  const step = extractStepById(wf, STEP_ID)
  assert.equal(stepInvokesVitestIntegrationConfig(step), true)
  assert.deepEqual(wholeFileVitestArgs(step), [FILE])
  assert.equal(isSuiteWiredInRealDbStep(wf, STEP_ID, FILE), true)
})

test('synthetic CONTROL: a benign echo mentioning vitest next to the REAL integration-config command still passes', () => {
  // Positive control for MUTATION 6: the fix is "resolve the executed binary", not "reject any step
  // whose body mentions vitest twice". A logging/echo line is inert, and the real command still
  // satisfies (c)+(d) jointly. Without this control MUTATION 6 could pass by rejecting everything.
  const wf = craftWorkflow({
    runPrefixLines: [
      '          echo "about to run vitest --config vitest.integration.config.ts"',
      '          echo vitest',
    ],
  })
  const step = extractStepById(wf, STEP_ID)
  assert.equal(stepInvokesVitestIntegrationConfig(step), true)
  assert.deepEqual(wholeFileVitestArgs(step), [FILE])
  assert.equal(isSuiteWiredInRealDbStep(wf, STEP_ID, FILE), true)
})

test('synthetic: suite relocated out of the id-located step is not membership anywhere else', () => {
  const wf = craftWorkflow({ file: 'tests/integration/other.db.test.ts' })
  assert.equal(isSuiteWiredInRealDbStep(wf, STEP_ID, FILE), false)
  // Positive control: the step is fully executable and does list a suite — the `false` above is a
  // membership miss for FILE, not a collapsed/erroring parse.
  assert.deepEqual(wholeFileVitestArgs(extractStepById(wf, STEP_ID)), [
    'tests/integration/other.db.test.ts',
  ])
})

test('synthetic: comment-only env/config decoys inside the id step must RED', () => {
  const commentOnly = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - name: Run approval real-DB integration (directory endpoints)',
    `        id: ${STEP_ID}`,
    NODE20_IF,
    '        # env:',
    '        #   DATABASE_URL: postgresql://postgres@localhost:5432/metasheet_test',
    '        run: |',
    '          # pnpm exec vitest --config vitest.integration.config.ts run \\',
    `          echo "mention ${FILE} DATABASE_URL vitest.integration.config.ts"`,
    '      - name: Next step',
    '        run: echo ok',
  ].join('\n')
  assert.ok(commentOnly.includes('DATABASE_URL') && commentOnly.includes('vitest.integration.config.ts'))
  assert.throws(() => isSuiteWiredInRealDbStep(commentOnly, STEP_ID, FILE), /env\.DATABASE_URL/)
})

test('synthetic MUTATION 7: an EMPTY block-scalar env.DATABASE_URL must RED', () => {
  // Round-4 gate finding N1 (owner acceptance criterion (a)): `DATABASE_URL: |` / `>` is a PRESENT
  // key whose VALUE is the empty string when the block body is empty or whitespace-only. A scalar
  // reader that never resolves block scalars sees the literal indicator (`|`) as the value, calls it
  // non-empty and greens — while at runtime DATABASE_URL is empty and every describeIfDatabase suite
  // skips. Same skip-green class as `DATABASE_URL: ''`, reached through a different YAML spelling.
  const headers = ['|', '>', '|-', '>-', '|+', '>2']
  for (const header of headers) {
    for (const bodyLines of [
      [], // empty block body
      ['             '], // whitespace-only block body
      ['             ', '', '             '], // several whitespace-only lines
    ]) {
      const wf = craftWorkflow({
        envLines: ['        env:', `          DATABASE_URL: ${header}`, ...bodyLines],
      })
      const label = `DATABASE_URL: ${header} + ${bodyLines.length} blank body line(s)`
      assert.ok(wf.includes('DATABASE_URL'), 'the env key is still present — presence must not pass')
      assert.ok(wf.includes(FILE), 'the suite path is still listed')
      const step = extractStepById(wf, STEP_ID)
      assert.notEqual(step, null, 'the id step still exists; only the env VALUE spelling was mutated')
      assert.equal(stepHasEnvDatabaseUrl(step), false, `${label} must not count`)
      assert.throws(
        () => isSuiteWiredInRealDbStep(wf, STEP_ID, FILE),
        /env\.DATABASE_URL/,
        `${label} must not satisfy the contract`,
      )
    }
  }
  // Positive control: the pin RESOLVES block scalars, it does not reject the block-scalar FORM.
  // A `|` / `>` value with real content is a legitimate way to write the URL and must still pass.
  for (const header of headers) {
    const ok = craftWorkflow({
      envLines: [
        '        env:',
        `          DATABASE_URL: ${header}`,
        '            postgresql://postgres@localhost:5432/metasheet_test',
      ],
    })
    assert.equal(
      stepHasEnvDatabaseUrl(extractStepById(ok, STEP_ID)),
      true,
      `block scalar ${header} WITH content must still pass`,
    )
    assert.equal(isSuiteWiredInRealDbStep(ok, STEP_ID, FILE), true, `block scalar ${header} + content`)
  }
})

test('synthetic MUTATION 8: a phantom `- name:`/`id:` step minted INSIDE a run script must not anchor', () => {
  // Round-4 gate finding N2: step discovery scanned the RAW workflow for `^\s*-\s+\S`, and block
  // scalars were masked only AFTER a candidate block had been carved out — so a `- name:` / `id:`
  // pair written inside a shell heredoc (or any `run:` body) was minted as a real step. That
  // resurrects the decoy class the id anchoring was introduced to end: the phantom carries every
  // pin, the job runs nothing but `cat`.
  //
  // Three spellings of the SAME structural mistake are covered, because closing only the heredoc
  // one leaves the class open: a `run:` value may be a block scalar, a bare multi-line PLAIN scalar,
  // or a multi-line QUOTED scalar — in all three the following indented lines are scalar CONTENT.
  const phantomBody = [
    '          - name: phantom real-DB step',
    `            id: ${STEP_ID}`,
    "            if: matrix.node-version == '20.x'",
    '            env:',
    '              DATABASE_URL: postgresql://postgres@localhost:5432/metasheet_test',
    '            run: |',
    `              pnpm exec vitest --config vitest.integration.config.ts run ${FILE}`,
  ]
  const carriers = {
    'block scalar heredoc': ['        run: |', '          cat <<EOS > /dev/null', ...phantomBody, '          EOS'],
    'multi-line plain scalar': ['        run: echo', ...phantomBody],
    'multi-line double-quoted scalar': ['        run: "echo', ...phantomBody, '          "'],
  }
  let phantom = null
  for (const [label, carrierLines] of Object.entries(carriers)) {
    const wf = [
      'jobs:',
      '  test:',
      '    steps:',
      '      - name: Innocuous prep step',
      ...carrierLines,
      '      - name: Next step',
      '        run: echo ok',
    ].join('\n')
    if (phantom === null) phantom = wf
    assert.ok(wf.includes(`id: ${STEP_ID}`), `${label}: the id text is present, inside a run VALUE`)
    assert.ok(wf.includes(FILE), `${label}: the suite path is present too`)
    assert.equal(
      extractStepById(wf, STEP_ID),
      null,
      `${label}: a sequence item minted inside a run: value must not be discovered as a step`,
    )
    assert.throws(
      () => isSuiteWiredInRealDbStep(wf, STEP_ID, FILE),
      /not found in plugin-tests\.yml|located by exact/,
      `${label}: a phantom step inside a scalar must not stand in for the id-located step`,
    )
  }

  // Positive control: masking scalar bodies BEFORE sequence detection must not swallow the REAL
  // steps that follow such a script. The genuine id step declared after the heredoc still resolves
  // and satisfies all four pins — the fix is "don't parse shell as YAML", not "stop finding steps".
  const withReal = [
    phantom.split('\n').slice(0, -2).join('\n'),
    ...craftWorkflow().split('\n').slice(3),
  ].join('\n')
  assert.equal(withReal.match(new RegExp(`id: ${STEP_ID}`, 'g')).length, 2, 'phantom + real id both present')
  const step = extractStepById(withReal, STEP_ID)
  assert.notEqual(step, null, 'the REAL id step after the heredoc is still discovered')
  assert.equal(stepRunsOnNode20Matrix(step), true)
  assert.equal(stepHasEnvDatabaseUrl(step), true)
  assert.equal(stepInvokesVitestIntegrationConfig(step), true)
  assert.equal(isSuiteWiredInRealDbStep(withReal, STEP_ID, FILE), true)
})

test('synthetic: an `id:` token inside a run script cannot anchor the helper', () => {
  // Block-scalar masking: shell text must never be read as YAML keys.
  const wf = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - name: Unrelated step',
    '        run: |',
    `          echo "id: ${STEP_ID}"`,
    `          echo "${FILE}"`,
    '      - name: Next step',
    '        run: echo ok',
  ].join('\n')
  assert.ok(wf.includes(`id: ${STEP_ID}`), 'the id text is present, but only inside a run script')
  assert.equal(extractStepById(wf, STEP_ID), null, 'run-script text must not anchor the step lookup')
})

test('the T2-Gate collision-mechanism suite file exists on disk', () => {
  // Third point: both wiring texts can stay intact while the suite is renamed/deleted — vitest
  // exits 0 on an unmatched path argument, so CI stays green and the proof never runs.
  assert.ok(
    existsSync(join(repoRoot, 'packages/core-backend', FILE)),
    `wired suite packages/core-backend/${FILE} must exist on disk`,
  )
})
