#!/usr/bin/env node
/**
 * Q8 / C4 P1 (2026-09-21) — compare the required web lane's positional token SET between two
 * revisions of `apps/web/scripts/run-required-web-tests.sh`.
 *
 * The Q8 rewrite reshapes that invocation from one 11410-byte physical line into one token per
 * line, backslash-continued and alphabetised. Reshaping is only safe if the set of filters handed
 * to vitest is IDENTICAL afterwards — a dropped token silently stops running a spec in the
 * required lane while the lane stays green, which is the worst possible outcome for a "hygiene"
 * change. This script is the mechanical proof, kept in-tree so the claim can be re-run rather than
 * trusted.
 *
 * It intentionally compares SETS, not sequences: the whole point of the change is that the order
 * becomes alphabetical, so an order diff is expected and a set diff is not.
 *
 * Usage:
 *   node scripts/ops/required-web-lane-token-set-diff.mjs <before-rev> [<after-rev>]
 *
 *   <before-rev>  a git revision (e.g. origin/main, HEAD~1) to read the OLD file from
 *   <after-rev>   a git revision for the NEW file; omit to use the working tree
 *
 * Exit 0 when the sets are byte-for-byte equal, 1 with a printed diff otherwise.
 *
 * Values-free: reads only repo-tracked script text, prints only token names and counts.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const LANE_PATH = 'apps/web/scripts/run-required-web-tests.sh'

/**
 * Strip whole-line `#` comments, then fold backslash continuations into logical lines.
 *
 * Deliberately duplicated from
 * packages/core-backend/tests/unit/required-web-lane-registration-shape.test.ts rather than
 * imported: this script must be able to parse the OLD single-physical-line shape and the NEW
 * multi-line shape with the same code, and it must run standalone under plain `node` with no
 * TypeScript toolchain. The shape guard asserts the in-tree file's shape; this one only ever
 * compares two texts, so a drift between the two copies cannot make either lie about the lane.
 */
function logicalLines(scriptSrc) {
  const kept = scriptSrc
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => !/^\s*#/.test(line))

  const out = []
  let buf = null
  for (const raw of kept) {
    const trimmedRight = raw.replace(/\s+$/, '')
    const continued = trimmedRight.endsWith('\\')
    const body = continued ? trimmedRight.slice(0, -1).trim() : trimmedRight.trim()
    buf = buf === null ? body : `${buf} ${body}`.trim()
    if (!continued) {
      out.push(buf)
      buf = null
    }
  }
  if (buf !== null) out.push(buf)
  return out
}

function execLogicalLine(scriptSrc, label) {
  const matches = logicalLines(scriptSrc).filter((line) => /^exec\s+npx\s+vitest\s+run\b/.test(line))
  if (matches.length !== 1) {
    throw new Error(`${label}: expected exactly 1 exec logical line, found ${matches.length}`)
  }
  return matches[0]
}

function tokensOf(logicalLine) {
  const after = logicalLine.replace(/^.*?\bvitest\s+run\b\s*/, '')
  return after.split(/\s+/).filter((token) => token.length > 0 && !token.startsWith('-'))
}

function readAt(rev) {
  if (rev === null) return readFileSync(join(REPO_ROOT, LANE_PATH), 'utf8')
  return execFileSync('git', ['show', `${rev}:${LANE_PATH}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
}

function main(argv) {
  const beforeRev = argv[0]
  if (!beforeRev) {
    console.error('usage: node scripts/ops/required-web-lane-token-set-diff.mjs <before-rev> [<after-rev>]')
    return 2
  }
  const afterRev = argv[1] ?? null
  const afterLabel = afterRev ?? '<working tree>'

  const beforeTokens = tokensOf(execLogicalLine(readAt(beforeRev), beforeRev))
  const afterTokens = tokensOf(execLogicalLine(readAt(afterRev), afterLabel))

  const beforeSet = new Set(beforeTokens)
  const afterSet = new Set(afterTokens)
  const removed = [...beforeSet].filter((token) => !afterSet.has(token)).sort()
  const added = [...afterSet].filter((token) => !beforeSet.has(token)).sort()

  const dupes = (tokens) => {
    const seen = new Set()
    const out = []
    for (const token of tokens) {
      if (seen.has(token)) out.push(token)
      seen.add(token)
    }
    return out.sort()
  }
  const beforeDupes = dupes(beforeTokens)
  const afterDupes = dupes(afterTokens)

  console.log(`before (${beforeRev}):        ${beforeTokens.length} tokens, ${beforeSet.size} distinct`)
  console.log(`after  (${afterLabel}): ${afterTokens.length} tokens, ${afterSet.size} distinct`)
  if (beforeDupes.length) console.log(`before duplicates: ${beforeDupes.join(' ')}`)
  if (afterDupes.length) console.log(`after duplicates:  ${afterDupes.join(' ')}`)

  if (removed.length === 0 && added.length === 0) {
    console.log('SET IDENTICAL — every filter the old invocation handed vitest is still handed to it.')
    return 0
  }
  if (removed.length) console.log(`REMOVED (${removed.length}): ${removed.join(' ')}`)
  if (added.length) console.log(`ADDED   (${added.length}): ${added.join(' ')}`)
  return 1
}

process.exit(main(process.argv.slice(2)))
