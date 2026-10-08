import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Hermetic PR-time guard for the ~61 fixed-string contracts that
// scripts/ops/multitable-onprem-package-verify.sh enforces against the two
// on-prem PowerShell helpers:
//   - scripts/ops/multitable-onprem-deploy-launcher.ps1  ($launcher_helper)
//   - scripts/ops/multitable-onprem-apply-package.ps1    ($apply_helper)
//
// Why this exists: verify.sh only ever runs inside dispatch-only workflows
// (multitable-onprem-package-build.yml, stock-prep-main-package-verify.yml),
// neither of which fires on a normal PR. A PR that edits either helper can
// therefore pass every PR check while silently breaking a verify.sh contract
// on main — exactly what #4998 did (the launcher stopped emitting the
// literal `-StagingRoot $stagingBase` when the apply-helper invocation was
// switched to hashtable splatting).
//
// This file re-implements verify.sh's three `search_fixed_string` contract
// shapes as a plain-JS parser + evaluator, decoding bash quoting itself
// (no bash, no rg/grep subprocess, no network), and evaluates the parsed
// contracts against the repo's own copies of the two helper files. It also
// mutation-tests the parser/evaluator in memory so a parser regression that
// silently stops matching contracts cannot pass vacuously (verified by both
// the >=55 contract-count floor and the two mutation self-tests below).
//
// The three shapes, as used against "$launcher_helper" / "$apply_helper":
//   1. search_fixed_string '<needle>' "$file" || die "..."       -> must contain
//   2. if ! search_fixed_string '<needle>' "$file"; then die     -> must contain
//   3. if search_fixed_string '<needle>' "$file"; then die       -> must NOT contain

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')

const VERIFY_SH_PATH = path.join(REPO_ROOT, 'scripts/ops/multitable-onprem-package-verify.sh')
const LAUNCHER_PATH = path.join(REPO_ROOT, 'scripts/ops/multitable-onprem-deploy-launcher.ps1')
const APPLY_PATH = path.join(REPO_ROOT, 'scripts/ops/multitable-onprem-apply-package.ps1')

const verifyShSource = fs.readFileSync(VERIFY_SH_PATH, 'utf8')
const launcherSource = fs.readFileSync(LAUNCHER_PATH, 'utf8')
const applyHelperSource = fs.readFileSync(APPLY_PATH, 'utf8')

// Matches a `search_fixed_string` call line whose file argument is exactly
// "$launcher_helper" or "$apply_helper" (quoted variable reference), with an
// optional leading `if`/`if !`. Anchored to line start; ignores anything
// after the file argument (`; then`, `|| die "..."`, etc. — those don't
// change which of the three contract shapes applies, only *what* die says).
const CONTRACT_LINE_RE =
  /^\s*(if\s+)?(!\s*)?search_fixed_string\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")\s+"\$(launcher_helper|apply_helper)"/

// Decodes a bash double-quoted string body exactly as bash would: backslash
// is an escape only in front of $, `, ", or \ — every other backslash
// (e.g. the "C:\ms-tmp" and "...\resolvedRoot..." needles below) is kept
// literally, backslash included. This is the one bug the starting-point
// checker had: it never restored `\$` -> `$`, which produced a false
// "MISSING" for "\$SupportedPackagePnpmVersion = '9.15.9'" even though the
// decoded needle ($SupportedPackagePnpmVersion = '9.15.9') is present.
function decodeBashDoubleQuoted(raw) {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1]
      if (next === '$' || next === '`' || next === '"' || next === '\\') {
        out += next
        i++
        continue
      }
    }
    out += ch
  }
  return out
}

// A bash single-quoted string is taken 100% literally: no escape processing
// at all (not even backslash), and it cannot itself contain a single quote.

/**
 * @typedef {{ mustContain: boolean, needle: string, fileKey: 'launcher_helper'|'apply_helper', line: number }} Contract
 */

/** @returns {Contract[]} */
function parseContracts(source) {
  const lines = source.split(/\r?\n/)
  const contracts = []
  lines.forEach((line, idx) => {
    const m = line.match(CONTRACT_LINE_RE)
    if (!m) return
    const isIf = Boolean(m[1])
    const isNeg = Boolean(m[2])
    // bare `search_fixed_string ... || die`      -> mustContain
    // `if ! search_fixed_string ...; then die`   -> mustContain
    // `if search_fixed_string ...; then die`     -> must NOT contain
    const mustContain = !isIf || isNeg
    const rawSingle = m[3]
    const rawDouble = m[4]
    const needle = rawSingle !== undefined ? rawSingle : decodeBashDoubleQuoted(rawDouble)
    contracts.push({ mustContain, needle, fileKey: m[5], line: idx + 1 })
  })
  return contracts
}

/**
 * Evaluates `contracts` (already filtered/parsed) against `sources`, a map
 * of fileKey -> file text. Uses plain substring containment, matching
 * verify.sh's `search_fixed_string` (rg --fixed-strings / grep -F) exactly.
 * @param {Contract[]} contracts
 * @param {Record<string, string>} sources
 */
function evaluateContracts(contracts, sources) {
  const violations = []
  for (const c of contracts) {
    const haystack = sources[c.fileKey]
    const found = haystack.includes(c.needle)
    if (found !== c.mustContain) {
      violations.push(c)
    }
  }
  return violations
}

function formatViolation(v) {
  return `${v.mustContain ? 'MISSING  ' : 'FORBIDDEN'} ${v.fileKey} (verify.sh:${v.line}) ${JSON.stringify(v.needle)}`
}

// Extracts a bash `function NAME() { ... }` body by locating the opening
// line and the next line that is exactly `}` at column 0 (the convention
// every top-level function in this file follows).
function extractFunctionBody(source, name) {
  const lines = source.split(/\r?\n/)
  const startIdx = lines.findIndex((l) => l.trim() === `function ${name}() {`)
  if (startIdx === -1) return null
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i] === '}') {
      return lines.slice(startIdx, i + 1).join('\n')
    }
  }
  return null
}

const contracts = parseContracts(verifyShSource)
const launcherContracts = contracts.filter((c) => c.fileKey === 'launcher_helper')
const applyContracts = contracts.filter((c) => c.fileKey === 'apply_helper')
const realViolations = evaluateContracts(contracts, {
  launcher_helper: launcherSource,
  apply_helper: applyHelperSource,
})

// Values-free summary line (no needle text, just counts) for quick CI scanning.
console.log(`packageVerifyStaticContracts=${contracts.length} violations=${realViolations.length}`)

test('search_fixed_string keeps literal (rg --fixed-strings / grep -F) semantics', () => {
  const body = extractFunctionBody(verifyShSource, 'search_fixed_string')
  assert.ok(body, 'search_fixed_string() function not found in verify.sh — has it been renamed or reshaped?')
  assert.ok(
    body.includes('--fixed-strings'),
    'the ripgrep branch of search_fixed_string must use --fixed-strings so needle decoding in this test stays literal (no regex metacharacter surprises)',
  )
  assert.ok(
    /grep\s+-\w*F\w*\b/.test(body),
    'the grep fallback branch of search_fixed_string must use -F (fixed-strings) so needle decoding in this test stays literal',
  )
})

test('parses at least 55 launcher/apply-helper contracts from verify.sh', () => {
  // A parser regression (e.g. a shape change in verify.sh's search_fixed_string
  // calls that this regex stops matching) must fail loudly, not silently
  // evaluate zero contracts and vacuously "pass". 61 were present at the time
  // this guard was written; 55 leaves headroom for minor edits without being
  // a no-op floor.
  assert.ok(
    contracts.length >= 55,
    `expected >=55 parsed launcher_helper/apply_helper contracts, got ${contracts.length} (parser regression? verify.sh reshaped?)`,
  )
  assert.ok(launcherContracts.length > 0, 'expected at least one launcher_helper contract')
  assert.ok(applyContracts.length > 0, 'expected at least one apply_helper contract')
})

test('current repo launcher + apply helper satisfy every parsed verify.sh contract', () => {
  if (realViolations.length > 0) {
    assert.fail(
      `${realViolations.length} package-verify static contract violation(s):\n${realViolations.map(formatViolation).join('\n')}`,
    )
  }
})

test('mutation: removing the launcher -StagingRoot pass-through literal is detected', () => {
  const targetNeedle = '-StagingRoot $stagingBase'
  const targetContract = launcherContracts.find((c) => c.needle === targetNeedle && c.mustContain)
  assert.ok(targetContract, 'expected a mustContain launcher_helper contract for the StagingRoot pass-through literal (has verify.sh changed?)')

  const baselineViolations = evaluateContracts(launcherContracts, { launcher_helper: launcherSource })
  const baselineNeedles = new Set(baselineViolations.map((v) => v.needle))

  // Regression direction: strip every occurrence of the literal from an
  // in-memory copy (this is exactly the #4998 shape: the launcher's apply
  // invocation stops spelling out `-StagingRoot $stagingBase`). Nothing is
  // written to disk.
  const mutatedSource = launcherSource.split(targetNeedle).join('')
  const mutatedViolations = evaluateContracts(launcherContracts, { launcher_helper: mutatedSource })
  const mutatedNeedles = new Set(mutatedViolations.map((v) => v.needle))

  assert.ok(mutatedNeedles.has(targetNeedle), 'removing the literal in memory must surface as a MISSING violation')

  // Every other contract's pass/fail state must be unchanged by this single
  // targeted removal, so the mutation is proven to add exactly one new
  // violation rather than incidentally breaking something else.
  for (const c of launcherContracts) {
    if (c.needle === targetNeedle) continue
    assert.strictEqual(
      mutatedNeedles.has(c.needle),
      baselineNeedles.has(c.needle),
      `unexpected side effect on unrelated contract: ${JSON.stringify(c.needle)}`,
    )
  }

  // Repair direction: a copy guaranteed to contain the literal must clear
  // the violation, proving the check is sensitive in both directions (not
  // just "always flags this needle").
  const repairedSource = `${mutatedSource}\n  ${targetNeedle}\n`
  const repairedViolations = evaluateContracts(launcherContracts, { launcher_helper: repairedSource })
  assert.ok(
    !repairedViolations.some((v) => v.needle === targetNeedle),
    'reintroducing the literal in memory must clear the violation',
  )
})

test('mutation: introducing a forbidden Expand-Archive call in the apply helper is detected', () => {
  const forbiddenNeedle = 'Expand-Archive'
  const forbiddenContract = applyContracts.find((c) => c.needle === forbiddenNeedle && c.mustContain === false)
  assert.ok(forbiddenContract, 'expected a mustNotContain apply_helper contract forbidding Expand-Archive (has verify.sh changed?)')

  const baselineViolations = evaluateContracts(applyContracts, { apply_helper: applyHelperSource })
  assert.ok(
    !baselineViolations.some((v) => v.needle === forbiddenNeedle),
    'apply helper must not already use Expand-Archive (baseline should be clean on this contract)',
  )

  const mutatedSource = `${applyHelperSource}\nExpand-Archive -Path $x -DestinationPath $y\n`
  const mutatedViolations = evaluateContracts(applyContracts, { apply_helper: mutatedSource })
  assert.ok(
    mutatedViolations.some((v) => v.needle === forbiddenNeedle),
    'introducing Expand-Archive in memory must surface as a FORBIDDEN violation',
  )
})
