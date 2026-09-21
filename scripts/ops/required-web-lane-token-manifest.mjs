#!/usr/bin/env node
/**
 * H-6 (2026-09-22) — generate / check the committed token-set manifest for the required web
 * lane's `exec npx vitest run …` block.
 *
 * See docs/development/required-web-lane-token-manifest-guard-design-20260922.md for the full
 * design (option comparison, threat model). Short version: the lane's positional token filter can
 * silently lose a token (rebase mistake, bad manual edit, a "cleanup" that deletes the wrong
 * line) while the lane itself stays green — nothing currently asserts the SET of tokens the
 * script hands vitest against any independent record. This manifest is that independent record:
 * a plain, sorted, one-token-per-line file committed alongside the script, and a vitest guard
 * (packages/core-backend/tests/unit/required-web-lane-token-manifest-guard.test.ts) that fails
 * when the two sets diverge in either direction.
 *
 * This script only produces/checks the manifest file; it is not itself the guard — CI does not
 * invoke it. Run it locally after editing the exec block:
 *
 *   node scripts/ops/required-web-lane-token-manifest.mjs           # check only, exits 1 on drift
 *   node scripts/ops/required-web-lane-token-manifest.mjs --write   # regenerate the manifest file
 *
 * Values-free: reads only repo-tracked script text, writes only token names, one per line.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { execLogicalLine, tokensOf } from './required-web-lane-exec-block.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const LANE_SCRIPT = join(REPO_ROOT, 'apps', 'web', 'scripts', 'run-required-web-tests.sh')
const MANIFEST_PATH = join(REPO_ROOT, 'apps', 'web', 'scripts', 'run-required-web-tests.tokens')

const caseInsensitive = (a, b) => {
  const la = a.toLowerCase()
  const lb = b.toLowerCase()
  if (la !== lb) return la < lb ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

function readManifestTokens() {
  let raw
  try {
    raw = readFileSync(MANIFEST_PATH, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return []
    throw err
  }
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function activeTokens() {
  const script = readFileSync(LANE_SCRIPT, 'utf8')
  return tokensOf(execLogicalLine(script))
}

function main(argv) {
  const write = argv.includes('--write')

  const active = activeTokens()
  const activeSet = new Set(active)
  const sorted = [...activeSet].sort(caseInsensitive)

  if (write) {
    writeFileSync(MANIFEST_PATH, `${sorted.join('\n')}\n`, 'utf8')
    console.log(
      `wrote ${sorted.length} tokens to ${MANIFEST_PATH.replace(`${REPO_ROOT}/`, '')} `
      + `(from ${active.length} in the active exec block, ${activeSet.size} distinct).`,
    )
    return 0
  }

  const manifestTokens = readManifestTokens()
  const manifestSet = new Set(manifestTokens)

  const missing = [...manifestSet].filter((t) => !activeSet.has(t)).sort(caseInsensitive)
  const extra = [...activeSet].filter((t) => !manifestSet.has(t)).sort(caseInsensitive)

  console.log(`active exec block:  ${active.length} tokens, ${activeSet.size} distinct`)
  console.log(`committed manifest: ${manifestTokens.length} tokens, ${manifestSet.size} distinct`)

  if (missing.length === 0 && extra.length === 0) {
    console.log('MANIFEST MATCHES — the committed token set equals the active exec block\'s token set.')
    return 0
  }
  if (missing.length) {
    console.log(
      `MISSING FROM ACTIVE (${missing.length}) — in the manifest but no longer in the exec block, `
      + `i.e. silently dropped from the lane: ${missing.join(' ')}`,
    )
  }
  if (extra.length) {
    console.log(
      `EXTRA IN ACTIVE (${extra.length}) — in the exec block but not yet recorded in the manifest, `
      + `run with --write and commit the result: ${extra.join(' ')}`,
    )
  }
  return 1
}

process.exit(main(process.argv.slice(2)))
