import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// T2-Gate CI two-point wiring contract. The collision-mechanism suite is the CI-provable half of
// the §3.4 two-corp question: the (provider, external_key) unique index, the bare-unionId
// derivation, and the wholesale second-corp sync failure signature (closed classifications:
// duplicate_key_detected + expected_constraint_detected — never raw error_message in operator
// evidence; see t2gate-runbook-values-free-contract.test.mjs, co-run by the same no-DB CI step).
//
// Two load-bearing placements (both must hold or CI can stay green while the suite never runs):
//   (1) exact quoted path inside the real `test.exclude` array of vitest.config.ts
//       (a comment / coverage.exclude / nested exclude / free-text hit is NOT enough)
//   (2) whole-file vitest arg inside the named "Run approval real-DB integration..." step that
//       has a real env.DATABASE_URL key and a real run line invoking vitest with
//       vitest.integration.config.ts (comment-only decoys do not count)
//
// Helpers parse source structure — mere whole-file filename / keyword search is insufficient.
// Runs in the gating no-DB test job.
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const FILE = 'tests/integration/directory-account-external-key-collision-mechanism.db.test.ts'
const REAL_DB_STEP = 'Run approval real-DB integration'
const VITEST_CFG = join(repoRoot, 'packages/core-backend/vitest.config.ts')
const WORKFLOW = join(repoRoot, '.github/workflows/plugin-tests.yml')

// ---------------------------------------------------------------------------
// Source parsers (exported for synthetic mutation coverage)
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

/**
 * Body of the first workflow step whose name contains `nameNeedle`, from the line after
 * `- name:` through (not including) the next same-indent `- name:`.
 * @param {string} wf
 * @param {string} nameNeedle
 * @returns {string}
 */
export function namedStepBody(wf, nameNeedle) {
  const lines = wf.split('\n')
  let start = -1
  let indent = ''
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)- name:\s*(.*)$/)
    if (m && m[2].includes(nameNeedle)) {
      start = i
      indent = m[1]
      break
    }
  }
  assert.ok(start >= 0, `workflow step whose name includes ${JSON.stringify(nameNeedle)} not found`)
  const body = []
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)- name:\s*/)
    if (m && m[1] === indent) break
    body.push(lines[i])
  }
  return body.join('\n')
}

/**
 * True iff the step body has a real YAML `env:` mapping child with a `DATABASE_URL:` key.
 * Comment lines and free-text mentions do not count.
 * @param {string} stepBody
 */
export function stepHasEnvDatabaseUrl(stepBody) {
  const lines = stepBody.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const envM = /^(\s*)env:\s*$/.exec(lines[i])
    if (!envM) continue
    const envIndent = envM[1].length
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue
      const indent = (line.match(/^(\s*)/) || ['', ''])[1].length
      if (indent <= envIndent) break
      // Real key under env: — not a comment.
      if (/^\s*DATABASE_URL:\s*\S/.test(line)) return true
    }
  }
  return false
}

/**
 * True iff the step body has a non-comment run command line that invokes `vitest`
 * with `--config vitest.integration.config.ts` (order-tolerant enough for the real
 * `pnpm ... exec vitest --config vitest.integration.config.ts run \` line).
 * Free-text / comment mentions do not count.
 * @param {string} stepBody
 */
export function stepInvokesVitestIntegrationConfig(stepBody) {
  for (const line of stepBody.split('\n')) {
    if (/^\s*#/.test(line)) continue
    // Strip trailing shell comments for the match surface.
    const code = line.replace(/(^|[^\\])#.*$/, '$1')
    if (!/\bvitest\b/.test(code)) continue
    if (/--config\s+vitest\.integration\.config\.ts\b/.test(code)) return true
  }
  return false
}

/**
 * Ordered whole-file vitest path args in a step body
 * (`tests/integration/foo.db.test.ts` with optional trailing `\`).
 * Comment lines ignored.
 * @param {string} stepBody
 * @returns {string[]}
 */
export function wholeFileVitestArgs(stepBody) {
  const files = []
  for (const line of stepBody.split('\n')) {
    if (/^\s*#/.test(line)) continue
    const m = line.match(/^\s+(tests\/integration\/\S+\.(?:test|spec)\.[tj]sx?)\s*(?:\\)?\s*$/)
    if (m) files.push(m[1])
  }
  return files
}

/**
 * True iff `file` is a whole-file vitest arg inside the named real-DB step that also
 * has a real env.DATABASE_URL key and a real vitest --config vitest.integration.config.ts run line.
 * @param {string} wf
 * @param {string} file
 * @param {string} [stepNeedle]
 */
export function isWholeFileInApprovalRealDbStep(wf, file, stepNeedle = REAL_DB_STEP) {
  const step = namedStepBody(wf, stepNeedle)
  assert.ok(
    stepHasEnvDatabaseUrl(step),
    `${stepNeedle} step must have env.DATABASE_URL (real YAML key, not a comment/decoy)`,
  )
  assert.ok(
    stepInvokesVitestIntegrationConfig(step),
    `${stepNeedle} step must run vitest with --config vitest.integration.config.ts ` +
      `(real command line, not a comment/decoy)`,
  )
  return wholeFileVitestArgs(step).includes(file)
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

test('plugin-tests.yml runs the suite as a whole file in the approval real-DB step (DATABASE_URL + integration config)', () => {
  const wf = readFileSync(WORKFLOW, 'utf8')
  assert.ok(
    isWholeFileInApprovalRealDbStep(wf, FILE),
    `plugin-tests.yml step "${REAL_DB_STEP}" (with env.DATABASE_URL + vitest.integration.config.ts) ` +
      `must list ${FILE} as a whole-file vitest arg`,
  )
  // Negative: multitable real-DB must not be the (sole) placement.
  const multi = namedStepBody(wf, 'Run multitable real-DB integration')
  assert.equal(
    wholeFileVitestArgs(multi).includes(FILE),
    false,
    `${FILE} must not be wired into the multitable real-DB step`,
  )
})

// ---------------------------------------------------------------------------
// Synthetic / mutation guards (in-memory) — prove parsers, not whole-file search
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

test('synthetic: wrong-step relocation (multitable only) fails the approval real-DB placement check', () => {
  const wf = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - name: Run multitable real-DB integration',
    '        env:',
    '          DATABASE_URL: postgresql://postgres@localhost:5432/metasheet_test',
    '        run: |',
    '          pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \\',
    `            ${FILE} \\`,
    '            --reporter=dot',
    '      - name: Run approval real-DB integration (directory endpoints)',
    '        env:',
    '          DATABASE_URL: postgresql://postgres@localhost:5432/metasheet_test',
    '        run: |',
    '          pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \\',
    '            tests/integration/other.db.test.ts \\',
    '            --reporter=dot',
    '      - name: Next step',
    '        run: echo ok',
  ].join('\n')
  assert.ok(wf.includes(FILE))
  assert.equal(
    isWholeFileInApprovalRealDbStep(wf, FILE),
    false,
    'file present only under multitable real-DB must not satisfy approval real-DB placement',
  )
  assert.equal(
    wholeFileVitestArgs(namedStepBody(wf, 'Run multitable real-DB integration')).includes(FILE),
    true,
    'control: multitable step does list the file',
  )
})

test('synthetic: approval real-DB step without env.DATABASE_URL fails even if the file is listed', () => {
  const wf = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - name: Run approval real-DB integration (directory endpoints)',
    '        run: |',
    '          pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \\',
    `            ${FILE} \\`,
    '            --reporter=dot',
    '      - name: Next step',
    '        run: echo ok',
  ].join('\n')
  assert.throws(
    () => isWholeFileInApprovalRealDbStep(wf, FILE),
    /env\.DATABASE_URL|DATABASE_URL/,
    'missing env.DATABASE_URL must red the real-DB placement check',
  )
})

test('synthetic: comment-only DATABASE_URL / vitest.integration.config decoys fail step placement', () => {
  // Keywords appear only in comments — old /\bDATABASE_URL\b/ search would green.
  const commentOnly = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - name: Run approval real-DB integration (directory endpoints)',
    '        # env:',
    '        #   DATABASE_URL: postgresql://postgres@localhost:5432/metasheet_test',
    '        run: |',
    '          # pnpm exec vitest --config vitest.integration.config.ts run \\',
    `          echo "mention ${FILE} DATABASE_URL vitest.integration.config.ts"`,
    '      - name: Next step',
    '        run: echo ok',
  ].join('\n')
  assert.ok(commentOnly.includes('DATABASE_URL'))
  assert.ok(commentOnly.includes('vitest.integration.config.ts'))
  assert.throws(
    () => isWholeFileInApprovalRealDbStep(commentOnly, FILE),
    /env\.DATABASE_URL|DATABASE_URL/,
    'comment-only DATABASE_URL must red',
  )

  // env.DATABASE_URL present, but vitest config only in a comment.
  const configCommentOnly = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - name: Run approval real-DB integration (directory endpoints)',
    '        env:',
    '          DATABASE_URL: postgresql://postgres@localhost:5432/metasheet_test',
    '        run: |',
    '          # pnpm exec vitest --config vitest.integration.config.ts run',
    '          echo hi',
    `            ${FILE} \\`,
    '      - name: Next step',
    '        run: echo ok',
  ].join('\n')
  assert.throws(
    () => isWholeFileInApprovalRealDbStep(configCommentOnly, FILE),
    /vitest\.integration\.config/,
    'comment-only vitest.integration.config.ts must red',
  )

  // Real env key + real vitest line, but FILE only under another step — still false for FILE.
  const noFile = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - name: Run approval real-DB integration (directory endpoints)',
    '        env:',
    '          DATABASE_URL: postgresql://postgres@localhost:5432/metasheet_test',
    '        run: |',
    '          pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \\',
    '            tests/integration/other.db.test.ts \\',
    '            --reporter=dot',
    '      - name: Next step',
    '        run: echo ok',
  ].join('\n')
  assert.equal(isWholeFileInApprovalRealDbStep(noFile, FILE), false)
})

test('synthetic positive: file inside named approval real-DB step with env.DATABASE_URL + vitest integration config passes', () => {
  const wf = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - name: Run approval real-DB integration (directory endpoints)',
    '        env:',
    '          DATABASE_URL: postgresql://postgres@localhost:5432/metasheet_test',
    '        run: |',
    '          : "${DATABASE_URL:?DATABASE_URL is required}"',
    '          pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \\',
    `            ${FILE} \\`,
    '            --reporter=dot',
    '      - name: Next step',
    '        run: echo ok',
  ].join('\n')
  assert.equal(isWholeFileInApprovalRealDbStep(wf, FILE), true)
  assert.equal(stepHasEnvDatabaseUrl(namedStepBody(wf, REAL_DB_STEP)), true)
  assert.equal(stepInvokesVitestIntegrationConfig(namedStepBody(wf, REAL_DB_STEP)), true)
})
