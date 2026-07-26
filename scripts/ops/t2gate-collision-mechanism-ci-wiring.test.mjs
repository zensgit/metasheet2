import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  REAL_DB_STEP_IDS,
  extractStepById,
  extractTestExcludeArrayBody,
  isQuotedInTestExclude,
  isSuiteWiredInRealDbStep,
  quotedExcludeEntries,
  realDbStepWholeFileArgs,
  requireExecutableRealDbStep,
  stepHasEnvDatabaseUrl,
  stepInvokesVitestIntegrationConfig,
  stepRunsOnNode20Matrix,
  wholeFileVitestArgs,
} from './ci-realdb-step-contract.mjs'

// `extractTestExcludeArrayBody` / `quotedExcludeEntries` / `isQuotedInTestExclude` originated in
// THIS file and are re-exported here (via the shared module) so any pre-existing external import
// of them from this path keeps working; #4612 gate-confirm P2-1 promoted their DEFINITIONS into
// `ci-realdb-step-contract.mjs` so `attendance-w4c2-ci-wiring.test.mjs` (and any future guard)
// can share the SAME structured parser instead of a bare substring check. This file's synthetic
// decoy coverage below is unchanged — it now exercises the imported functions rather than local
// ones, with identical behavior (verified: moved verbatim, no logic edited).
export { extractTestExcludeArrayBody, isQuotedInTestExclude, quotedExcludeEntries }

// Two-point wiring contract for the real-DB multi-corp directory-key suite. The historical filename
// is retained to avoid silently dropping its required-gate placement.
//
// Two load-bearing placements (both must hold or CI can stay green while the suite never runs):
//   (1) exact quoted path inside the real `test.exclude` array of vitest.config.ts
//       (a comment / coverage.exclude / nested exclude / free-text hit is NOT enough)
//   (2) the suite is a whole-file vitest arg of the real-DB step located by its EXACT stable
//       `id:` — and that step is EXECUTABLE: `if: matrix.node-version == '20.x'`, a real
//       `env.DATABASE_URL` whose value is a LITERAL PostgreSQL URL (no `${{ … }}` expressions —
//       a missing secret/context resolves to '' at runtime ⇒ skip-green), and a REAL vitest invocation under
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
// vitest.config.ts source parsers: `maskCommentsAndStrings` / `extractTestExcludeArrayBody` /
// `quotedExcludeEntries` / `isQuotedInTestExclude` now LIVE in `./ci-realdb-step-contract.mjs`
// (#4612 gate-confirm P2-1 promotion — see the import block above and the re-export note there).
// This file keeps their synthetic decoy coverage below; the definitions are shared, not local.
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
  //
  // Round 5 adds the four EMPTY-VALUE SPELLINGS the owner named when ruling that spelling-chasing
  // must end (`!!str`, `~`, `null`, `&a ""`), plus an alias to an anchored empty string: after a
  // real YAML parse they are all just '' or null, so no per-spelling code exists to get wrong.
  for (const value of ["''", '""', '"   "', "'  '", '', '!!str', '~', 'null', '&a ""']) {
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
  // Alias spelling: the empty string arrives via an anchor on a SIBLING key. The parser resolves
  // the alias, so the value is '' just the same.
  const aliased = craftWorkflow({
    envLines: ['        env:', "          DECOY: &empty ''", '          DATABASE_URL: *empty'],
  })
  assert.equal(stepHasEnvDatabaseUrl(extractStepById(aliased, STEP_ID)), false, 'aliased empty string')
  assert.throws(() => isSuiteWiredInRealDbStep(aliased, STEP_ID, FILE), /env\.DATABASE_URL/)
  // Positive control: the pin is not "reject every env value" — a real URL in any spelling still
  // passes, including tagged (`!!str <url>`), anchored (`&db <url>`) and aliased non-empty forms.
  for (const value of [
    'postgresql://postgres@localhost:5432/metasheet_test',
    "'postgresql://postgres@localhost:5432/metasheet_test'",
    'postgresql://postgres@localhost:5432/metasheet_test # real DB',
    '!!str postgresql://postgres@localhost:5432/metasheet_test',
    '&db postgresql://postgres@localhost:5432/metasheet_test',
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
  // Round-4 gate finding N1: `DATABASE_URL: |` / `>` is a PRESENT key whose VALUE is the empty
  // string when the block body is empty or whitespace-only. A reader that does not resolve block
  // scalars takes the literal indicator (`|`) for a non-empty value and greens — while at runtime
  // DATABASE_URL is empty and every describeIfDatabase suite skips. Same skip-green class as
  // `DATABASE_URL: ''`, reached through a different YAML spelling; the real parser resolves every
  // header/chomping/indent combination to '' without per-spelling code.
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
  // Round-4 gate finding N2, generalized by the round-5 owner ruling: text written inside a `run:`
  // VALUE is scalar content, never YAML structure — so a `- name:` / `id:` pair spelled there must
  // not be discovered as a step, IN ANY SPELLING OF THE `run` KEY OR VALUE. The hand-rolled masker
  // was defeated by one new spelling per round (`"run": |`, `'run': |`, `run : |`, bare `- |`);
  // after a real YAML parse every spelling collapses to "the value is a string", so the phantom
  // class is closed structurally rather than per spelling. Every carrier below is VALID YAML that
  // once minted (or would have minted) a phantom step.
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
    'multi-line double-quoted scalar': ['        run: "echo', ...phantomBody, '          "'],
    'double-quoted run key (`"run": |`)': ['        "run": |', ...phantomBody],
    "single-quoted run key (`'run': |`)": ["        'run': |", ...phantomBody],
    'spaced run key (`run : |`)': ['        run : |', ...phantomBody],
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

  // Bare sequence-item block scalar (`- |`): the steps LIST ITEM is itself a scalar whose content
  // spells a phantom step. The parser yields a string item — not a mapping — so it can never carry
  // an id. (GitHub would reject such a step anyway; the point is the guard must not GREEN on it.)
  const bareItem = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - |',
    '        - name: phantom real-DB step',
    `          id: ${STEP_ID}`,
    "          if: matrix.node-version == '20.x'",
    '          env:',
    '            DATABASE_URL: postgresql://postgres@localhost:5432/metasheet_test',
    '          run: |',
    `            pnpm exec vitest --config vitest.integration.config.ts run ${FILE}`,
    '      - name: Next step',
    '        run: echo ok',
  ].join('\n')
  assert.ok(bareItem.includes(`id: ${STEP_ID}`) && bareItem.includes(FILE))
  assert.equal(
    extractStepById(bareItem, STEP_ID),
    null,
    'a bare `- |` list item is a string, not a step — its content must not anchor',
  )
  assert.throws(
    () => isSuiteWiredInRealDbStep(bareItem, STEP_ID, FILE),
    /not found in plugin-tests\.yml|located by exact/,
  )

  // Multi-line PLAIN scalar (`run: echo` + indented phantom lines): NOT valid YAML — PyYAML rejects
  // it ("mapping values are not allowed here"), and GitHub's own parser rejects the same file, so
  // this spelling cannot even reach a runner. The guard must fail CLOSED on it, never green: under
  // the round-4 masker this exact text minted a phantom step and PASSED.
  const invalidPlain = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - name: Innocuous prep step',
    '        run: echo',
    ...phantomBody,
    '      - name: Next step',
    '        run: echo ok',
  ].join('\n')
  assert.ok(invalidPlain.includes(`id: ${STEP_ID}`) && invalidPlain.includes(FILE))
  assert.throws(
    () => extractStepById(invalidPlain, STEP_ID),
    /failing CLOSED.*YAML_PARSE_ERROR/s,
    'invalid YAML must fail the guard closed, not green it',
  )
  assert.throws(() => isSuiteWiredInRealDbStep(invalidPlain, STEP_ID, FILE), /failing CLOSED/)

  // Positive control 1: parsing scalars as scalars must not swallow the REAL steps around them.
  // The genuine id step declared after the heredoc still resolves and satisfies all four pins —
  // the fix is "don't parse shell as YAML", not "stop finding steps".
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

  // Positive control 2: the quoted/spaced KEY spellings are legitimate YAML for a REAL step too.
  // A genuine step written entirely with quoted keys must still satisfy all four pins — the parser
  // reads structure, so key spelling neither mints phantoms nor hides real steps.
  const quotedKeysReal = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - "name": Run approval real-DB integration (directory endpoints)',
    `        'id': ${STEP_ID}`,
    '        "if": matrix.node-version == \'20.x\'',
    '        env :',
    '          "DATABASE_URL": postgresql://postgres@localhost:5432/metasheet_test',
    '        "run": |',
    `          pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \\`,
    `            ${FILE} \\`,
    '            --reporter=dot',
    '      - name: Next step',
    '        run: echo ok',
  ].join('\n')
  const quotedStep = extractStepById(quotedKeysReal, STEP_ID)
  assert.notEqual(quotedStep, null, 'quoted-key spelling of a real step is still located by id')
  assert.equal(stepRunsOnNode20Matrix(quotedStep), true)
  assert.equal(stepHasEnvDatabaseUrl(quotedStep), true)
  assert.equal(stepInvokesVitestIntegrationConfig(quotedStep), true)
  assert.equal(isSuiteWiredInRealDbStep(quotedKeysReal, STEP_ID, FILE), true)
})

test('synthetic MUTATION 9: an Actions-expression / non-URL-literal env.DATABASE_URL must RED', () => {
  // Owner-reproduced bypass on the round-5 contract (#4496 P2, 2026-07-21):
  // `DATABASE_URL: ${{ secrets.DOES_NOT_EXIST }}` is a non-empty STRING after the YAML parse, so
  // the "non-empty value" pin greened it — but at RUNTIME GitHub Actions resolves a missing
  // secret/context to the EMPTY string, DATABASE_URL is '' in the job, every describeIfDatabase
  // suite skips, and the run is exactly the skip-green pin (b) exists to stop. The guard executes
  // pre-install and cannot evaluate expressions, so it cannot tell a resolving expression from a
  // vanishing one: pin (b) now refuses ANY `${{` anywhere in the value (mixed literal+expression
  // included — the expression part can resolve empty/garbage just the same) and requires the
  // remaining literal to be a scheme-anchored PostgreSQL URL (`postgres://` / `postgresql://`) —
  // `true` / `1` / `file.txt` are non-empty text but not a DB URL.
  for (const value of [
    '${{ secrets.DOES_NOT_EXIST }}', // (a) the owner's verbatim reproduction
    "'${{ secrets.DOES_NOT_EXIST }}'", // (a) quoted spelling — same parsed value
    '${{secrets.X}}', // (b) no-space expression spelling
    'postgresql://user:${{ secrets.PW }}@localhost:5432/db', // (c) mixed literal+expression
    'postgresql://user:${{secrets.PW}}@localhost:5432/db', // (c) mixed, no-space — URL-shaped, so only the ${{ refusal catches it
    'true', // (d) non-URL literal — YAML boolean, not even a string
    "'true'", // (d) non-URL literal string
    '1', // (d) non-URL literal — YAML number
    'file.txt', // (d) non-URL literal text
    '${{ env.DATABASE_URL }}', // (e) expression via the env context — resolves '' when unset, like secrets
  ]) {
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
  // Positive control (unit-level): the EXACT literal both real steps carry in plugin-tests.yml is
  // accepted by the new predicate, in both official scheme spellings — the pin is "refuse what can
  // be empty at runtime", not "reject every value".
  for (const value of [
    'postgresql://postgres@localhost:5432/metasheet_test', // verbatim plugin-tests.yml value
    'postgres://postgres@localhost:5432/metasheet_test',
  ]) {
    const ok = craftWorkflow({ envLines: ['        env:', `          DATABASE_URL: ${value}`] })
    assert.equal(stepHasEnvDatabaseUrl(extractStepById(ok, STEP_ID)), true, `value ${value}`)
    assert.equal(isSuiteWiredInRealDbStep(ok, STEP_ID, FILE), true, `value ${value}`)
  }
})

test('synthetic: an `id:` token inside a run script cannot anchor the helper', () => {
  // Shell text is scalar content after the YAML parse — it must never be read as YAML keys.
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
