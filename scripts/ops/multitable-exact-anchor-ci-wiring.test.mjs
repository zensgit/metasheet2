import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// W0 L6-b CI two-point wiring contract. The exact-anchor authority suite is DATABASE_URL-gated and
// must have BOTH (1) a vitest.config.ts exclusion so the no-DB lane cannot skip-green it and (2) a
// whole-file entry in plugin-tests.yml's multitable real-DB step. Removing either point must fail CI.
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const FILES = [
  'tests/integration/multitable-exact-anchor-recovery-realdb.test.ts',
  'tests/integration/multitable-exact-anchor-recovery-plan-realdb.test.ts',
]
const REAL_DB_STEP = 'Run multitable real-DB integration'

function maskCommentsAndStrings(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    if (src[i] === '/' && src[i + 1] === '/') {
      out += '  '
      i += 2
      while (i < src.length && src[i] !== '\n') {
        out += ' '
        i++
      }
      continue
    }
    if (src[i] === '/' && src[i + 1] === '*') {
      out += '  '
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      if (i < src.length) {
        out += '  '
        i += 2
      }
      continue
    }
    if (src[i] === "'" || src[i] === '"') {
      const quote = src[i]
      out += ' '
      i++
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) {
          out += '  '
          i += 2
          continue
        }
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      if (i < src.length) {
        out += ' '
        i++
      }
      continue
    }
    out += src[i]
    i++
  }
  return out
}

function testExcludeEntries(src) {
  const masked = maskCommentsAndStrings(src)
  const testKey = /\btest\s*:\s*\{/.exec(masked)
  assert.ok(testKey, 'vitest config must contain a test object')
  const openBrace = masked.indexOf('{', testKey.index + testKey[0].length - 1)
  let depth = 1
  for (let i = openBrace + 1; i < masked.length && depth > 0; i++) {
    if (masked[i] === '{') depth++
    else if (masked[i] === '}') depth--
    else if (depth === 1) {
      const match = /^(exclude\s*:\s*\[)/.exec(masked.slice(i))
      if (!match) continue
      const arrayStart = i + match[1].length - 1
      let arrayDepth = 0
      for (let j = arrayStart; j < masked.length; j++) {
        if (masked[j] === '[') arrayDepth++
        else if (masked[j] === ']' && --arrayDepth === 0) {
          const body = src
            .slice(arrayStart + 1, j)
            .split('\n')
            .map((line) => line.replace(/\/\/.*$/, ''))
            .join('\n')
          return [...body.matchAll(/'([^']+)'|"([^"]+)"/g)].map(
            (entry) => entry[1] ?? entry[2],
          )
        }
      }
    }
  }
  return []
}

function namedStepBody(workflow, nameNeedle) {
  const lines = workflow.split('\n')
  let start = -1
  let indent = ''
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(\s*)- name:\s*(.*)$/)
    if (match && match[2].includes(nameNeedle)) {
      start = i
      indent = match[1]
      break
    }
  }
  assert.ok(
    start >= 0,
    `workflow step containing ${JSON.stringify(nameNeedle)} not found`,
  )
  const body = []
  for (let i = start + 1; i < lines.length; i++) {
    const match = lines[i].match(/^(\s*)- name:\s*/)
    if (match && match[1] === indent) break
    body.push(lines[i])
  }
  return body.join('\n')
}

function stepHasEnvKey(stepBody, key) {
  const lines = stepBody.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const env = /^(\s*)env:\s*$/.exec(lines[i])
    if (!env) continue
    const envIndent = env[1].length
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*(?:#.*)?$/.test(lines[j])) continue
      const indent = lines[j].match(/^(\s*)/)[1].length
      if (indent <= envIndent) break
      if (new RegExp(`^\\s*${key}:\\s*\\S`).test(lines[j])) return true
    }
  }
  return false
}

function wholeFileVitestArgs(stepBody) {
  return stepBody.split('\n').flatMap((line) => {
    if (/^\s*#/.test(line)) return []
    const match = line.match(
      /^\s+(tests\/integration\/\S+\.(?:test|spec)\.[tj]sx?)\s*(?:\\)?\s*$/,
    )
    return match ? [match[1]] : []
  })
}

for (const file of FILES) {
  test(`vitest.config.ts excludes ${file} from the no-DB job`, () => {
    const config = readFileSync(
      join(repoRoot, 'packages/core-backend/vitest.config.ts'),
      'utf8',
    )
    assert.ok(
      testExcludeEntries(config).includes(file),
      `test.exclude must contain the exact entry ${file}`,
    )
  })

  test(`plugin-tests.yml runs ${file} as a whole file with real Postgres`, () => {
    const workflow = readFileSync(
      join(repoRoot, '.github/workflows/plugin-tests.yml'),
      'utf8',
    )
    const step = namedStepBody(workflow, REAL_DB_STEP)
    assert.ok(
      stepHasEnvKey(step, 'DATABASE_URL'),
      `${REAL_DB_STEP} must define DATABASE_URL`,
    )
    assert.ok(
      stepHasEnvKey(step, 'METASHEET_REAL_DB_TEST_STEP'),
      `${REAL_DB_STEP} must set the fail-not-skip marker`,
    )
    assert.match(
      step,
      /\bvitest\b[^\n]*--config\s+vitest\.integration\.config\.ts\b/,
    )
    assert.ok(
      wholeFileVitestArgs(step).includes(file),
      `${REAL_DB_STEP} must run ${file} as a whole-file argument`,
    )
  })
}

test('placement parsers reject comment-only and wrong-step decoys', () => {
  const file = FILES[1]
  const configDecoy = `export default defineConfig({ test: { // '${file}'\nexclude: ['other.test.ts'] } })`
  assert.equal(testExcludeEntries(configDecoy).includes(file), false)

  const workflowDecoy = [
    'steps:',
    `  # ${file}`,
    '  - name: Run some other integration',
    '    env:',
    '      DATABASE_URL: postgresql://example',
    '      METASHEET_REAL_DB_TEST_STEP: 1',
    '    run: |',
    '      pnpm exec vitest --config vitest.integration.config.ts run \\',
    `        ${file} \\`,
    `  - name: ${REAL_DB_STEP}`,
    '    run: echo no-db',
  ].join('\n')
  const realStep = namedStepBody(workflowDecoy, REAL_DB_STEP)
  assert.equal(stepHasEnvKey(realStep, 'DATABASE_URL'), false)
  assert.equal(wholeFileVitestArgs(realStep).includes(file), false)
})
