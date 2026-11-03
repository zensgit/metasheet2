// scenario-b-replay-verify.yml — trigger-path + execution wiring contract (#5931 review F2-F4 follow-up).
//
// The two replay suites (scenario-b-replay.test.mjs, scenario-b-replay-contract.test.mjs) are only a
// guard if CI runs them, and CI only runs them when one of the workflow's hand-typed `paths` matches the
// change. The contract suite reaches far outside scripts/ops: it requires the REAL
// plugins/plugin-integration-core/lib/http-routes.cjs (whose require closure spans ~100 lib files), the
// real read-source-config store, and the synthetic BOM fixture. Edit only one of those and, without a
// matching `paths` entry, the lane that promises to catch the regression never starts.
//
// This guard does not trust a second hand-typed list. It DERIVES the dependency set:
//   1. from the test sources — every `path.join/resolve(<known dir var>, '<literal>', ...)` and every
//      relative `from './x.mjs'` import, replayed the same way the sources build them;
//   2. then the real require closure of every derived .cjs, read back from require.cache;
// and feeds each repo file through an evaluation of the workflow's own glob patterns, for BOTH the
// pull_request and push lists. It also asserts the jobs really execute both suites (and this file).
import assert from 'node:assert/strict'
import { existsSync, readFileSync as readFileSyncRaw, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml')

// CRLF-normalised reads so a Windows checkout (core.autocrlf=true) and a CI checkout agree.
function readText(file) {
  return readFileSyncRaw(file, 'utf8').replace(/\r\n/g, '\n')
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'scenario-b-replay-verify.yml')
const SUITES = Object.freeze([
  'scripts/ops/scenario-b-replay.test.mjs',
  'scripts/ops/scenario-b-replay-contract.test.mjs',
])
const SELF = 'scripts/ops/scenario-b-replay-ci-wiring.test.mjs'

function repoRelative(absolute) {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join('/')
}

function isFile(absolute) {
  return existsSync(absolute) && statSync(absolute).isFile()
}

function literalsOf(argText) {
  // Only pure string-literal argument lists are replayable; anything else is not a static path.
  const stripped = argText.replace(/'[^']*'/g, '').replace(/[\s,]/g, '')
  if (stripped.length !== 0) return null
  return [...argText.matchAll(/'([^']*)'/g)].map((m) => m[1])
}

/**
 * Replays a test source's own path arithmetic. Known roots: HERE (the source's directory). Every
 * `const NAME = path.resolve|join(BASE, 'lit', ...)` with a known BASE defines a new root, in source
 * order; every `path.join|resolve(BASE, 'lit', ...)` that lands on a FILE is a dependency. Relative
 * ESM imports are dependencies too.
 */
function directDepsOf(relativeSource) {
  const absoluteSource = path.join(REPO_ROOT, relativeSource)
  const source = readText(absoluteSource)
  const roots = new Map([['HERE', path.dirname(absoluteSource)]])
  for (const m of source.matchAll(/const\s+(\w+)\s*=\s*path\.(?:resolve|join)\(\s*(\w+)\s*,([^)]*)\)/g)) {
    const base = roots.get(m[2])
    const lits = literalsOf(m[3])
    if (base && lits) roots.set(m[1], path.resolve(base, ...lits))
  }
  const deps = new Set()
  for (const m of source.matchAll(/path\.(?:resolve|join)\(\s*(\w+)\s*,([^)]*)\)/g)) {
    const base = roots.get(m[1])
    const lits = literalsOf(m[2])
    if (!base || !lits) continue
    const target = path.resolve(base, ...lits)
    if (isFile(target)) deps.add(repoRelative(target))
  }
  for (const m of source.matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)) {
    deps.add(repoRelative(path.resolve(path.dirname(absoluteSource), m[1])))
  }
  return deps
}

function derivedDependencies() {
  const direct = new Set()
  for (const suite of SUITES) {
    direct.add(suite)
    for (const dep of directDepsOf(suite)) direct.add(dep)
  }
  // Extend with the real require closure of every derived CommonJS dependency.
  const closure = new Set(direct)
  for (const dep of direct) {
    if (!dep.endsWith('.cjs')) continue
    require(path.join(REPO_ROOT, dep))
  }
  for (const loaded of Object.keys(require.cache)) {
    const rel = repoRelative(loaded)
    if (rel.startsWith('..') || rel.split('/').includes('node_modules')) continue
    closure.add(rel)
  }
  return { direct, closure }
}

// Minimal evaluator for the glob shapes this workflow uses: literal segments, `*` within a segment,
// trailing `**` spanning segments (GitHub Actions `paths` filter semantics for those shapes).
function pathGlobToRegExp(pattern) {
  let out = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*') {
      i += 1
      if (pattern[i + 1] === '/') i += 1
      out += '[\\s\\S]*'
    } else if (c === '*') {
      out += '[^/]*'
    } else if (c === '?') {
      out += '[^/]'
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`)
}

function pathsMatch(patterns, file) {
  return patterns.some((pattern) => pathGlobToRegExp(pattern).test(file))
}

function uncovered(workflow, files) {
  const out = []
  for (const list of ['pull_request', 'push']) {
    const patterns = workflow.on && workflow.on[list] && workflow.on[list].paths
    assert.ok(Array.isArray(patterns) && patterns.length > 0, `${list}.paths must be a non-empty list`)
    for (const file of files) if (!pathsMatch(patterns, file)) out.push(`${list}: ${file}`)
  }
  return out
}

// Every `node --test <files...>` command in any job step, as a flat list of the files it runs.
function executedTestFiles(workflow) {
  const files = new Set()
  for (const job of Object.values(workflow.jobs || {})) {
    for (const step of job.steps || []) {
      if (typeof step.run !== 'string') continue
      for (const line of step.run.split('\n')) {
        const m = line.trim().match(/^node\s+--test\s+(.+)$/)
        if (!m) continue
        for (const token of m[1].split(/\s+/)) if (!token.startsWith('-')) files.add(token)
      }
    }
  }
  return files
}

function missingExecutions(workflow) {
  const ran = executedTestFiles(workflow)
  return [...SUITES, SELF].filter((file) => !ran.has(file))
}

const loadWorkflow = (text = readText(WORKFLOW_PATH)) => yaml.load(text)

test('derivation is not vacuous: the known direct dependencies of both suites are found', () => {
  const { direct, closure } = derivedDependencies()
  for (const known of [
    'scripts/ops/scenario-b-replay.mjs',
    'plugins/plugin-integration-core/lib/stock-preparation-target-provisioning.cjs',
    'plugins/plugin-integration-core/lib/http-routes.cjs',
    'plugins/plugin-integration-core/lib/read-source-config-store.cjs',
    'plugins/plugin-integration-core/lib/adapters/data-source-sql-readonly-source-adapter.cjs',
    'plugins/plugin-integration-core/lib/stock-preparation-snapshot-reads.cjs',
    'plugins/plugin-integration-core/fixtures/scenario-b-synthetic-bom/scenario-b-synthetic-bom.cjs',
  ]) {
    assert.ok(direct.has(known), `expected derived direct dependency ${known}`)
  }
  // http-routes alone pulls in dozens of lib files; a collapsed closure would make the next test vacuous.
  assert.ok(closure.size > 50, `require closure unexpectedly small: ${closure.size}`)
})

test('both trigger path lists cover every repo file the two suites load (direct + require closure)', () => {
  const { closure } = derivedDependencies()
  assert.deepEqual(uncovered(loadWorkflow(), [...closure].sort()), [])
})

test('both trigger path lists cover the workflow itself and this wiring test', () => {
  assert.deepEqual(uncovered(loadWorkflow(), ['.github/workflows/scenario-b-replay-verify.yml', SELF]), [])
})

test('the filter stays a filter: an unrelated file matches neither list', () => {
  assert.deepEqual(uncovered(loadWorkflow(), ['docs/unrelated.md', 'apps/web/src/main.ts']).length, 4)
})

test('jobs really execute both replay suites and this wiring test with node --test', () => {
  assert.deepEqual(missingExecutions(loadWorkflow()), [])
})

test('the coverage check bites: deleting one paths entry (in memory) leaves dependencies uncovered', () => {
  const source = readText(WORKFLOW_PATH)
  const { closure } = derivedDependencies()
  for (const entry of [
    "      - 'plugins/plugin-integration-core/lib/**'\n",
    "      - 'plugins/plugin-integration-core/fixtures/scenario-b-synthetic-bom/**'\n",
    "      - 'scripts/ops/scenario-b-replay*.mjs'\n",
  ]) {
    assert.equal(source.split(entry).length - 1, 2, `mutation anchor must appear once per list: ${entry.trim()}`)
    const doctored = source.split(entry).join('')
    const missing = uncovered(loadWorkflow(doctored), [...closure])
    assert.ok(missing.some((m) => m.startsWith('pull_request: ')), `removing ${entry.trim()} must uncover a pull_request dependency`)
    assert.ok(missing.some((m) => m.startsWith('push: ')), `removing ${entry.trim()} must uncover a push dependency`)
  }
})

test('the execution check bites: dropping a suite from the run line (in memory) is detected', () => {
  const source = readText(WORKFLOW_PATH)
  const anchor = ' scripts/ops/scenario-b-replay-contract.test.mjs\n'
  assert.equal(source.split(anchor).length - 1, 1, 'mutation anchor not found')
  const doctored = source.replace(anchor, '\n')
  assert.deepEqual(missingExecutions(loadWorkflow(doctored)), ['scripts/ops/scenario-b-replay-contract.test.mjs'])
})
