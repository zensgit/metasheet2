// ops-sql-pack-verify.yml — trigger-path wiring contract (#5926 review F5).
//
// The workflow's pull_request/push `paths` filters are a hand-typed list. That list is right for
// each SQL pack's OWN directory (`scripts/ops/<pack>/**`), but at least one pack's verify suite
// reaches OUTSIDE its own directory: `live-id-fk-validate-pack.test.mjs` reads
// `packages/core-backend/src/db/migrations/zzzz20260920120000_data_source_live_id_binding_lock.ts`
// directly (its own `MIGRATION_TS` constant) to assert `verify/migration-5896-up.sql` still
// reproduces every `sql\`…\`` statement of that migration's `up()`. Edit ONLY the migration and,
// without that file in `paths`, the lane that promises to catch the drift never runs.
//
// This guard does not hand-type that dependency either (a second hand-typed list is exactly as
// forgeable as the first): it DERIVES it, mechanically, from each pack's verify test source —
// the same `PACK -> REPO` escape-and-join shape the source itself uses — then feeds every
// derived path through a real evaluation of the workflow's own glob patterns. A dependency that
// grows without a matching `paths` entry is a failing test, not a comment.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync as readFileSyncRaw, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml')

// Every source this guard parses is read through this wrapper so a Windows checkout
// (`core.autocrlf=true`) reading CRLF cannot desync `\n`-oriented regexes from a CI checkout
// reading LF — the same normalization `multitable-d2-archive-ci-wiring.test.mjs` documents.
function readFileSync(path) {
  return readFileSyncRaw(path, 'utf8').replace(/\r\n/g, '\n')
}

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const workflowPath = join(repoRoot, '.github', 'workflows', 'ops-sql-pack-verify.yml')

const PACKS = ['readonly-inventory-20260916', 'live-id-fk-validate-20260920']

function repoRelative(absolutePath) {
  return relative(repoRoot, absolutePath).split(sep).join('/')
}

function verifyTestFiles(packName) {
  const verifyDir = join(repoRoot, 'scripts', 'ops', packName, 'verify')
  return readdirSync(verifyDir)
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => join(verifyDir, name))
}

/**
 * Derive the set of repo-relative files a pack's verify test(s) read from OUTSIDE the pack's own
 * directory, by mechanically replaying the same `path.resolve(PACK, '..', '..', '..')` /
 * `path.join(<that var>, '<literal>')` shape `live-id-fk-validate-pack.test.mjs` uses to build
 * `MIGRATION_TS`. This is a derivation, not a hand-typed list: a new such escape, or a changed
 * literal, changes the derived set without anyone editing this guard.
 *
 * `PACK` in each test file is `scripts/ops/<packName>` (`path.resolve(HERE, '..')` where `HERE`
 * is the test file's own `verify/` directory) — this function locates the same directory from
 * the outside rather than re-deriving it, since both must agree for the escape arithmetic below
 * to mean the same thing it means inside the test file.
 */
function externalReadsOf(testFilePath) {
  const source = readFileSync(testFilePath)
  const packDir = resolve(dirname(dirname(testFilePath))) // .../verify/.. == PACK

  // const <NAME> = path.resolve(PACK, '..', '..', '..')   (whitespace/newline tolerant)
  const escapeVarPattern =
    /const\s+(\w+)\s*=\s*path\.resolve\(\s*PACK\s*,\s*'\.\.'\s*,\s*'\.\.'\s*,\s*'\.\.'\s*\)/g
  const escapeVars = new Set()
  for (const m of source.matchAll(escapeVarPattern)) escapeVars.add(m[1])

  const externalPaths = new Set()
  for (const varName of escapeVars) {
    // path.join(<varName>, 'literal/relative/path.ext', ...more literals...) — tolerant of the
    // multi-line call `live-id-fk-validate-pack.test.mjs` actually uses.
    const joinPattern = new RegExp(`path\\.join\\(\\s*${varName}\\s*,([\\s\\S]{0,600}?)\\)`, 'g')
    for (const m of source.matchAll(joinPattern)) {
      const literals = [...m[1].matchAll(/'([^']+)'/g)].map((lit) => lit[1])
      if (literals.length === 0) continue
      const relativePath = literals.join('/')
      const absolute = resolve(packDir, '..', '..', '..', relativePath)
      // Sanity: the escape must actually land outside PACK — otherwise this isn't the
      // "reaches outside its own directory" case this guard exists for, and treating it as one
      // would let a same-directory join masquerade as a cross-cutting dependency.
      assert.ok(
        !absolute.startsWith(packDir + sep),
        `${repoRelative(testFilePath)}: ${varName} join('${relativePath}') resolved inside PACK ` +
          `(${repoRelative(absolute)}) — this derivation only handles genuine escapes`,
      )
      externalPaths.add(repoRelative(absolute))
    }
  }
  return [...externalPaths].sort()
}

/**
 * Minimal re-implementation of the pattern shapes GitHub Actions' `paths` filter uses in THIS
 * workflow: literal path segments and a trailing `**` that spans any number of further segments
 * (see https://docs.github.com/actions/writing-workflows/choosing-what-your-workflow-does/patterns-to-match-file-paths).
 * It is not a general-purpose glob engine — `minimatch`/`picomatch` are transitive dependencies
 * only (no root `node_modules/{minimatch,picomatch}` entry point), so pulling either in here
 * would be reaching past what pnpm actually promises this file, for a class of pattern
 * (mid-string `**`, brace expansion, `!`-negation) this workflow does not use.
 */
function pathGlobToRegExp(pattern) {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*') {
      i++ // consume both '*' of the '**'
      if (pattern[i + 1] === '/') i++ // and a following '/', so '**' can match zero segments
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

function pathsMatch(patterns, filePath) {
  return patterns.some((pattern) => pathGlobToRegExp(pattern).test(filePath))
}

function loadWorkflow() {
  return yaml.load(readFileSync(workflowPath))
}

test('the migration live-id-fk-validate-pack.test.mjs reads directly is a real, derivable dependency', () => {
  // This is the "the derivation itself is trustworthy" check: assert what the derivation for
  // this specific, known pack actually produces, so a change to the extraction logic that
  // quietly stops finding anything cannot pass this file by vacuously deriving an empty set.
  const [testFile] = verifyTestFiles('live-id-fk-validate-20260920')
  const external = externalReadsOf(testFile)
  assert.deepEqual(external, [
    'packages/core-backend/src/db/migrations/zzzz20260920120000_data_source_live_id_binding_lock.ts',
  ])
})

test('every path a verify suite reads from outside its own pack directory is in BOTH trigger path lists', () => {
  const workflow = loadWorkflow()
  const prPaths = workflow.on.pull_request.paths
  const pushPaths = workflow.on.push.paths
  assert.ok(Array.isArray(prPaths) && prPaths.length > 0, 'pull_request.paths must be a non-empty list')
  assert.ok(Array.isArray(pushPaths) && pushPaths.length > 0, 'push.paths must be a non-empty list')

  const derived = new Set()
  for (const packName of PACKS) {
    for (const testFile of verifyTestFiles(packName)) {
      for (const dep of externalReadsOf(testFile)) derived.add(dep)
    }
  }
  // Known floor from this review round (F5): at least the #5896 migration. A regression that
  // makes the derivation collapse to nothing would otherwise let this whole test go vacuously
  // green, which is exactly the failure mode #5926 was flagged for in the first place.
  assert.ok(derived.size >= 1, 'expected at least one cross-directory dependency to be derived')

  for (const dep of derived) {
    assert.ok(pathsMatch(prPaths, dep), `pull_request.paths does not cover ${dep} (read by a verify suite)`)
    assert.ok(pathsMatch(pushPaths, dep), `push.paths does not cover ${dep} (read by a verify suite)`)
  }
})

test('changing ONLY the migration file is, by itself, enough to match both trigger path lists', () => {
  const workflow = loadWorkflow()
  const migrationPath =
    'packages/core-backend/src/db/migrations/zzzz20260920120000_data_source_live_id_binding_lock.ts'
  assert.ok(pathsMatch(workflow.on.pull_request.paths, migrationPath))
  assert.ok(pathsMatch(workflow.on.push.paths, migrationPath))
  // And an unrelated file must NOT match — the filter stays a real filter, not a blanket allow.
  assert.ok(!pathsMatch(workflow.on.pull_request.paths, 'docs/unrelated.md'))
  assert.ok(!pathsMatch(workflow.on.push.paths, 'docs/unrelated.md'))
})

test('the drift check bites: deleting the migration path entry from the yml text un-triggers it (in-memory)', () => {
  // In-memory mutation of the yml TEXT only — nothing on disk is touched. This proves the
  // assertion above is actually exercising the real `paths` list rather than a fixed string it
  // happens to already contain: with the entry gone, the same evaluation must go false.
  const migrationPath =
    'packages/core-backend/src/db/migrations/zzzz20260920120000_data_source_live_id_binding_lock.ts'
  const source = readFileSync(workflowPath)
  const entryLine = `      - '${migrationPath}'\n`
  assert.ok(source.includes(entryLine), 'mutation anchor not found — the entry text moved')
  const doctored = source.split(entryLine).join('')
  assert.notEqual(doctored, source)

  const mutatedWorkflow = yaml.load(doctored)
  assert.ok(
    !pathsMatch(mutatedWorkflow.on.pull_request.paths, migrationPath),
    'removing the entry must un-match pull_request.paths',
  )
  assert.ok(
    !pathsMatch(mutatedWorkflow.on.push.paths, migrationPath),
    'removing the entry must un-match push.paths',
  )
  // ...and the two directory globs the rest of each pack still lives under must be unaffected by
  // the mutation, so this isn't accidentally deleting more than the one line it targets.
  for (const packName of PACKS) {
    const probe = `scripts/ops/${packName}/verify/anything.test.mjs`
    assert.ok(pathsMatch(mutatedWorkflow.on.pull_request.paths, probe))
    assert.ok(pathsMatch(mutatedWorkflow.on.push.paths, probe))
  }
})

test('both packs still keep their own directory glob in both trigger path lists', () => {
  const workflow = loadWorkflow()
  for (const packName of PACKS) {
    const pattern = `scripts/ops/${packName}/**`
    assert.ok(workflow.on.pull_request.paths.includes(pattern), `pull_request.paths must list ${pattern}`)
    assert.ok(workflow.on.push.paths.includes(pattern), `push.paths must list ${pattern}`)
  }
})
