// Shape guard for scripts/run-required-web-tests.sh (2026-09-20, rewritten 2026-09-21).
//
// Why this exists: three parallel lanes (feat/approval-template-groups-phase1-fe #5854,
// feat/approval-template-groups-phase3-sections #5878, feat/todo-center-phase2-fe #5857) each
// independently appended their new spec token to a COPY of the final `exec npx vitest run ...`
// line left behind by a prior rebase, instead of the one line bash's `exec` builtin actually
// reaches. `exec` unconditionally replaces the shell process on the FIRST such line encountered,
// so every token appended to a later duplicate never ran in CI:
//   - #5854: approvalTemplateGroupsClient / ApprovalTemplateGroupsPanel / SessionOrgSwitcher.spec.ts
//   - #5878: approvalTemplateCenterSections
//   - #5857: todoApi / TodoCenterView / todoCountsRealtime
// A green required-web-tests run therefore proved nothing about any of those six specs.
//
// REWRITE (2026-09-21, Q8 / C4 P1 landed on main): the required lane's `exec npx vitest run ...`
// invocation is no longer a single physical line — main now writes it as one token per PHYSICAL
// line, backslash-continued, case-insensitively sorted, with a bare `exec npx vitest run \` header
// and a bare `--reporter=dot` terminator (see packages/core-backend/tests/unit/
// required-web-lane-registration-shape.test.ts, which owns that structural contract — sortedness,
// one-token-per-line, no duplicates, .gitattributes `merge=union` pin — in a REQUIRED lane). This
// file's original `line.startsWith('exec npx vitest run ')` parse matched only that bare header —
// whose sole "token" is the continuation backslash — so it read the required lane as running ZERO
// specs and reddened on every file in apps/web/tests. Rewritten below to strip comments, JOIN
// backslash continuations into LOGICAL lines, and read the exec invocation off the logical line —
// same parsing contract as apps/web/tests/attendance-web-guard-workflow.spec.ts's
// `requiredLaneExecCommand` and the backend structural guard's `logicalLines`/`execLogicalLine`.
//
// This file keeps a DIFFERENT job than the backend structural guard: it does not re-check sort
// order, one-token-per-line, or the .gitattributes pin (that guard already owns those, in a
// required lane). What only THIS guard checks is semantic content — does every token actually
// resolve to a real spec file under apps/web/tests, is this file's own token wired in and
// collision-free, and (new) is there no SECOND exec invocation anywhere else in the script (the
// literal shape of the #5854/#5878/#5857 incident, re-expressed for the logical-line format so a
// future rebase cannot silently reintroduce a dead duplicate exec block).
//
// A DELIBERATE NARROWING from "no token may ever be a substring of another": that blanket form
// does not hold on origin/main today. A mechanical bidirectional scan of main's exec block finds
// pre-existing substring pairs, e.g. `multitable-record-drawer` ⊂ `multitable-record-drawer-button`.
// These are not bugs: `npx vitest run A B` is an OR over path substrings, so a token being a
// substring of a sibling drops no coverage for either. What actually signals a real error is (a) an
// exact duplicate token (dead weight from a bad merge) and (b) THIS spec's own newly-added token
// silently colliding with an existing one (which would mean the "wire the guard's own token in"
// step was done wrong). Both are checked; the pre-existing incidental-substring convention is left
// alone.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const WEB_ROOT = resolve(__dirname, '..')
const SCRIPT_PATH = join(WEB_ROOT, 'scripts', 'run-required-web-tests.sh')
const TESTS_DIR = join(WEB_ROOT, 'tests')

// This file's own path as vitest would report it when collected — matched against the exec
// block's tokens the same way vitest matches a CLI positional arg against a collected file path.
const OWN_SPEC_PATH = 'tests/run-required-web-tests-shape.spec.ts'

/** Recursively collect every `*.spec.ts` / `*.test.ts` path under apps/web/tests, relative to
 *  apps/web (forward-slash separated) — the same shape vitest reports collected file paths in. */
function collectSpecFiles(dir: string, base: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const rel = base ? `${base}/${entry}` : entry
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push(...collectSpecFiles(full, rel))
    } else if (/\.(spec|test)\.ts$/.test(entry)) {
      out.push(rel.split(sep).join('/'))
    }
  }
  return out
}

/**
 * Strip whole-line `#` comments, then fold backslash continuations into logical lines.
 *
 * Same algorithm as apps/web/tests/attendance-web-guard-workflow.spec.ts's
 * `requiredLaneExecCommand` and packages/core-backend/tests/unit/
 * required-web-lane-registration-shape.test.ts's `logicalLines` — kept byte-for-byte equivalent
 * on purpose so the three parsers of this one file cannot silently drift apart and disagree.
 */
function logicalLines(script: string): string[] {
  const out: string[] = []
  let buf: string | null = null
  for (const raw of script.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (/^\s*#/.test(line)) continue
    const trimmedRight = line.replace(/\s+$/, '')
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

const EXEC_PATTERN = /^exec\s+npx\s+vitest\s+run\b/

/** Every logical line matching the required lane's exec invocation, in file order. */
function execLogicalLines(script: string): string[] {
  return logicalLines(script).filter((line) => EXEC_PATTERN.test(line))
}

/** Positional filter tokens (flags dropped) of a `… vitest run …` logical line. */
function tokensOf(execLine: string): string[] {
  const withoutPrefix = execLine.replace(/^exec\s+npx\s+vitest\s+run\s*/, '')
  return withoutPrefix
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0 && !part.startsWith('-'))
}

describe('run-required-web-tests.sh shape guard', () => {
  const script = readFileSync(SCRIPT_PATH, 'utf8')
  const logical = logicalLines(script)
  const execLines = execLogicalLines(script)
  const specFiles = collectSpecFiles(TESTS_DIR, 'tests')

  it('has exactly one exec `npx vitest run` LOGICAL block (continuations joined, comments stripped)', () => {
    expect(
      execLines.length,
      `expected exactly one exec vitest invocation, found ${execLines.length} — a second one is dead ` +
        'code (bash `exec` replaces the process at the first match), so every token registered on a ' +
        'later copy would run in no CI job at all',
    ).toBe(1)
  })

  it('has no second exec logical line anywhere after the required lane block', () => {
    expect(execLines.length).toBeGreaterThan(0)
    const blockIndex = logical.indexOf(execLines[0])
    const trailing = logical.slice(blockIndex + 1).filter((line) => EXEC_PATTERN.test(line))
    expect(
      trailing,
      'a second exec logical line was found after the required lane block — this is exactly the ' +
        'dead-duplicate shape #5854/#5878/#5857 hit, just re-introduced in the new logical-line format',
    ).toEqual([])
  })

  it('every token in the exec block matches at least one real spec file under apps/web/tests', () => {
    expect(execLines).toHaveLength(1)
    const tokens = tokensOf(execLines[0])
    expect(tokens.length).toBeGreaterThan(0)

    const deadTokens = tokens.filter((token) => !specFiles.some((file) => file.includes(token)))
    expect(deadTokens).toEqual([])
  })

  it('no two tokens in the exec block are byte-identical (the literal artifact of a bad rebase merge)', () => {
    expect(execLines).toHaveLength(1)
    const tokens = tokensOf(execLines[0])

    const seen = new Set<string>()
    const duplicates: string[] = []
    for (const token of tokens) {
      if (seen.has(token)) duplicates.push(token)
      seen.add(token)
    }
    expect(duplicates).toEqual([])
  })

  it("this guard's own spec is wired into the exec block, and its token collides with no other", () => {
    expect(execLines).toHaveLength(1)
    const tokens = tokensOf(execLines[0])

    const ownTokens = tokens.filter((token) => OWN_SPEC_PATH.includes(token))
    expect(ownTokens.length).toBeGreaterThan(0)

    const collisions: string[] = []
    for (const own of ownTokens) {
      for (const other of tokens) {
        if (other === own) continue
        if (other.includes(own)) collisions.push(`'${own}' is a substring of '${other}'`)
        if (own.includes(other)) collisions.push(`'${other}' is a substring of '${own}'`)
      }
    }
    expect(collisions).toEqual([])
  })
})
