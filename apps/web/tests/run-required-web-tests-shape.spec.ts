// Shape guard for scripts/run-required-web-tests.sh (2026-09-20).
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
// A green required-web-tests run therefore proved nothing about any of those six specs. This
// guard makes that shape mechanically checkable so a future rebase cannot silently reintroduce a
// dead duplicate: (1) there must be exactly one live `exec npx vitest run` line, (2) every token
// on it must resolve to at least one real spec file (vitest's own filter semantics: the token is
// tested as a substring of the collected file's path), (3) no two tokens are byte-identical (the
// literal artifact a bad rebase merge produces), and (4) this spec's own token is neither a
// substring of, nor has as a substring, any other token already on the line.
//
// A DELIBERATE NARROWING from "no token may ever be a substring of another": that blanket form
// does not hold on origin/main today. A mechanical bidirectional scan of main's current single
// exec line (measured 2026-09-20, `git show origin/main:apps/web/scripts/run-required-web-tests.sh`)
// finds 21 pre-existing substring pairs, e.g. `multitable-record-drawer` ⊂
// `multitable-record-drawer-button`, `migration` ⊂ `meta-person-delivery-viewer-migration`. These
// are not bugs: `npx vitest run A B` is an OR over path substrings, so a token being a substring
// of a sibling drops no coverage for either — the file's own comments call this "harmless
// duplication, not a gap" at the `SessionOrgSwitcher.spec.ts` / `AttendanceSessionOrgSwitcher.spec.ts`
// pair specifically. A guard that asserted zero collisions would therefore be red against a clean
// origin/main checkout on day one, which defeats the point of a shape guard. What actually
// signals a real error is (a) an exact duplicate token (dead weight from a bad merge — main has
// zero today) and (b) THIS spec's own newly-added token silently colliding with an existing one
// (which would mean the "wire the guard's own token in" step below was done wrong). Both are
// checked; the pre-existing incidental-substring convention is left alone.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const WEB_ROOT = resolve(__dirname, '..')
const SCRIPT_PATH = join(WEB_ROOT, 'scripts', 'run-required-web-tests.sh')
const TESTS_DIR = join(WEB_ROOT, 'tests')

// This file's own path as vitest would report it when collected — matched against the exec
// line's tokens the same way vitest matches a CLI positional arg against a collected file path.
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

function parseExecLines(script: string): string[] {
  return script.split('\n').filter((line) => line.startsWith('exec npx vitest run '))
}

function tokensOf(execLine: string): string[] {
  const withoutPrefix = execLine.replace(/^exec npx vitest run /, '')
  return withoutPrefix
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0 && !part.startsWith('--'))
}

describe('run-required-web-tests.sh shape guard', () => {
  const script = readFileSync(SCRIPT_PATH, 'utf8')
  const execLines = parseExecLines(script)
  const specFiles = collectSpecFiles(TESTS_DIR, 'tests')

  it('has exactly one live `exec npx vitest run` line (bash exec only ever reaches the first)', () => {
    expect(execLines).toHaveLength(1)
  })

  it('every token on the exec line matches at least one real spec file under apps/web/tests', () => {
    expect(execLines).toHaveLength(1)
    const tokens = tokensOf(execLines[0])
    expect(tokens.length).toBeGreaterThan(0)

    const deadTokens = tokens.filter((token) => !specFiles.some((file) => file.includes(token)))
    expect(deadTokens).toEqual([])
  })

  it('no two tokens on the exec line are byte-identical (the literal artifact of a bad rebase merge)', () => {
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

  it("this guard's own spec is collected by some token on the exec line, and that token collides with no other", () => {
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
