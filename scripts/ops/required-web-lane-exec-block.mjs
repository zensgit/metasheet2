/**
 * H-6 (2026-09-22) — the required web lane's `exec npx vitest run …` logical-line parser,
 * extracted to a single plain-ESM module so the token-manifest generator (plain `node`, no
 * TypeScript toolchain) and its vitest guard (TypeScript, compiled by vitest/esbuild) can both
 * import the SAME code instead of each carrying their own copy.
 *
 * WHY THIS IS A NEW FILE AND NOT A REUSE OF AN EXISTING COPY
 * -----------------------------------------------------------
 * Two copies of this exact parsing logic already exist, and both were checked for import
 * feasibility before writing a third:
 *
 *   - `scripts/ops/required-web-lane-token-set-diff.mjs` is plain ESM and exports nothing — its
 *     `logicalLines`/`execLogicalLine`/`tokensOf` are unexported top-level functions, and the file
 *     ends in a top-level `process.exit(main(process.argv.slice(2)))`. Importing that module from
 *     anywhere (the generator, a vitest worker) executes `main` and calls `process.exit` as a
 *     side effect of the import itself — for a vitest worker that kills the process running the
 *     test file. Not safely importable as-is, and this task's harder constraint (see the design
 *     doc) is to leave existing guards' bytes alone rather than prove an edit to them didn't
 *     regress anything.
 *   - `packages/core-backend/tests/unit/required-web-lane-registration-shape.test.ts` DOES export
 *     `logicalLines` and `execLogicalLine` (not `tokensOf`), but the module's top level also calls
 *     `describe(...)` four times, registering that file's 18 tests. Importing it from a second
 *     vitest test file registers those 18 tests a SECOND time under vitest's collection — silently
 *     doubling a suite that other guards byte-pin the subtest count of the same class of thing
 *     (see plugin-tests.yml's `MIN_CONTRACT_TESTS` floor pattern) is exactly the kind of paved-over
 *     drift this repo's CI conventions exist to catch.
 *
 * So: this module is a deliberate, minimal (three functions, no CLI, no top-level side effects)
 * THIRD text of the same three functions, but it is the last one — both existing copies are left
 * byte-identical, and every future consumer (the generator, the guard, and anything else that
 * needs to read this exec block) imports from here rather than adding a fourth.
 *
 * ROUND 2 (2026-09-22, independent gate review round 1, P1-1 option (a) — selected during
 * implementation, on the round-1 reviewer's own framing that only (a) closes the residual; this is
 * NOT an owner ruling (`gh pr view 5974 --json comments,reviews` → 0 comments, 0 reviews as of the
 * round-2 gate review) and option (b) remains a fallback if the owner rules otherwise):
 * `logicalLines`/`execLogicalLine`/`tokensOf` below are UNCHANGED from round 1, byte-for-byte,
 * on purpose — a guard test asserts they stay textually identical to the shape guard's own copy
 * (see `required-web-lane-token-manifest-guard.test.ts`'s cross-copy agreement check — ROUND 4,
 * 2026-09-22, replaced the text-identical form of that check with a behavioural one; see this
 * file's ROUND 4 note further down for why), and widening their *behaviour* would break that
 * assertion for no benefit: the divergence this round needs (reading MORE than the exec block, and
 * not choking on `|| exit $?` tails) is added as new, separate exports (`stripTrailingErrorGuard`,
 * `allVitestInvocations`, `allVitestTokenLines`, `allVitestTokens`) below them instead.
 *
 * The round-1 guard covered only the final `exec` line's 397 tokens. The gate review
 * (`/Users/chouhua/.claude/projects/-Users-chouhua-Downloads-Github-metasheet2/reviews/impl-gate-H6-token-manifest-guard-round1-20260922.md`,
 * P1-1) found the script actually has **19** logical lines matching `\bvitest\s+run\b` after
 * `set -euo pipefail` (line 473) — 18 earlier `npx vitest run …` lines plus the final `exec …`
 * line — carrying **499** distinct tokens total (397 in the exec block, 102 more on the earlier
 * 18 lines, zero overlap), of which round 1 counted **28** gated by nothing else in the repo. The
 * round-2 gate review (P2-1) found a SIXTH lane-reading guard (`attendance-web-guard-workflow.spec.ts`)
 * that the round-1 census missed, which pins 4 more of those 28 (on an early line) plus 3 exec-block
 * tokens — corrected: **≤24** of the 499 are pinned by NOTHING across the six lane-reading guards
 * enumerated so far (see the design doc §1 for the full census and the recompute command).
 * `allVitestInvocations`/`allVitestTokenLines`/`allVitestTokens` close that: they read all 19
 * lines, not just the last one.
 *
 * ROUND 4 (2026-09-22, merge-train dry-run v3 gate finding G1) — the cross-copy agreement check
 * this file's header used to cite (paragraph above) compared the OTHER two copies' SOURCE TEXT
 * against `logicalLines`/`execLogicalLine`/`tokensOf` below, byte-for-byte. That broke the moment
 * a sibling copy was refactored into a differently-shaped but behaviourally equal form (e.g.
 * `required-web-lane-registration-shape.test.ts` growing a `logicalLinesWithLineNumbers()` helper
 * and rewriting `logicalLines()` as `return logicalLinesWithLineNumbers(scriptSrc).map(e => e.line)`
 * around it — same output, different bytes) — see the dry-run finding for the measured two-lane
 * conflict. `required-web-lane-token-manifest-guard.test.ts` now compares BEHAVIOUR (materialized,
 * executed functions on a fixture battery) instead of source text, so this file no longer needs to
 * stay textually frozen against that class of refactor. `logicalLines` below is now a thin wrapper
 * over `logicalLinesWithLineNumbers` (added this round) — its OWN output is unchanged byte-for-byte
 * (same filter-then-fold order, same trimming), it just also exposes the physical start line of
 * each logical line, which the cross-copy guard's line-number-mapping half needs and which
 * `allVitestInvocations` below used to duplicate the fold loop just to get (that duplication is
 * left in place, untouched, to avoid changing `allVitestInvocations`'s/`allVitestTokenLines`'s
 * already-tested output shape in the same change that fixes G1/G2).
 *
 * Values-free: reads only repo-tracked script text and returns token/line strings.
 */

/**
 * Fold backslash continuations into logical lines, pairing each with the 1-based physical line its
 * FIRST kept (non-comment) physical line starts at.
 *
 * Same filter-then-fold order as before ROUND 4 — whole-line `#` comments are dropped from the
 * physical-line stream FIRST, then remaining lines are joined on a trailing `\`. This is
 * deliberately NOT the same fold order as a comment encountered mid-continuation would need for
 * bash-exact semantics (a `#`-line that lands INSIDE an active continuation, e.g. because of a
 * rebase, is bash-fatal there in a way this simple strip-first pass cannot see) — that is a
 * separately tracked, documented divergence from at least one sibling copy, not something this
 * round's fix claims to close (see the cross-copy test's own comment for the fixture that proves
 * it, deliberately excluded from the "must agree" set).
 */
export function logicalLinesWithLineNumbers(scriptSrc) {
  const kept = []
  scriptSrc
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .forEach((line, idx) => {
      if (!/^\s*#/.test(line)) kept.push({ lineNo: idx + 1, text: line })
    })

  const out = []
  let buf = null
  let startLine = null
  for (const { lineNo, text } of kept) {
    const trimmedRight = text.replace(/\s+$/, '')
    const continued = trimmedRight.endsWith('\\')
    const body = continued ? trimmedRight.slice(0, -1).trim() : trimmedRight.trim()
    if (buf === null) {
      buf = body
      startLine = lineNo
    } else {
      buf = `${buf} ${body}`.trim()
    }
    if (!continued) {
      out.push({ line: buf, lineNumber: startLine })
      buf = null
      startLine = null
    }
  }
  if (buf !== null) out.push({ line: buf, lineNumber: startLine })
  return out
}

/**
 * Logical lines only, dropping the line-number pairing.
 *
 * ROUND 4: rewritten as a wrapper over `logicalLinesWithLineNumbers` above instead of its own
 * copy of the fold loop — the two steps (filter comments, fold continuations) are byte-for-byte
 * the same steps in the same order as the pre-round-4 body, so this function's OWN return value on
 * any input is unchanged; only the internal structure moved.
 */
export function logicalLines(scriptSrc) {
  return logicalLinesWithLineNumbers(scriptSrc).map((entry) => entry.line)
}

/** The one logical line that `exec`s vitest. Throws if there is not exactly one. */
export function execLogicalLine(scriptSrc) {
  const matches = logicalLines(scriptSrc).filter((line) => /^exec\s+npx\s+vitest\s+run\b/.test(line))
  if (matches.length !== 1) {
    throw new Error(`expected exactly 1 exec logical line, found ${matches.length}`)
  }
  return matches[0]
}

/** Positional filter tokens (flags dropped) of a `… vitest run …` logical line. */
export function tokensOf(logicalLine) {
  const after = logicalLine.replace(/^.*?\bvitest\s+run\b\s*/, '')
  return after.split(/\s+/).filter((token) => token.length > 0 && !token.startsWith('-'))
}

/**
 * ROUND 2 — drop a trailing `|| exit $?` shell error-propagation idiom from a logical line BEFORE
 * tokenizing it.
 *
 * Two of the 18 earlier `npx vitest run …` lines (run-required-web-tests.sh:1180, 1183) end
 * `… --reporter=dot || exit $?` — a guard so an early batch's non-zero exit isn't swallowed by a
 * later command in the same `set -euo pipefail` script (belt-and-suspenders; `pipefail` already
 * covers it). `tokensOf()` only drops tokens starting with `-`, so left unstripped this tail
 * yields three bogus "tokens" — `||`, `exit`, `$?` — none of them a real vitest positional filter.
 * Applied ONLY at the `allVitestInvocations`-family call sites below, not inside `tokensOf()`
 * itself: the exec block never carries this idiom (confirmed: it ends in `--reporter=dot` with no
 * tail), so stripping it there would be a no-op, but leaving `tokensOf()` untouched keeps it
 * byte-identical to the shape guard's and `token-set-diff.mjs`'s copies for the cross-copy
 * agreement check.
 *
 * Anchored at end-of-string (`$`), not a bare-word replace — a hypothetical positional token
 * literally named `exit` mid-line (not part of this exact trailing idiom) survives untouched; see
 * this function's own unit test in `required-web-lane-token-manifest-guard.test.ts`.
 */
export function stripTrailingErrorGuard(logicalLine) {
  return logicalLine.replace(/\s*\|\|\s*exit\s+\$\?\s*$/, '')
}

/**
 * ROUND 2 — every logical line in `scriptSrc` that invokes `vitest run` (matches `\bvitest\s+run\b`
 * — the same substring the round-1 gate review used to enumerate the 19), each carrying the
 * 1-based source line number its logical line STARTS at (comments stripped first, same as
 * `logicalLines()`, so a commented-out example like `# `npx vitest run …`` is correctly excluded).
 *
 * Re-implements the comment-strip/continuation-fold loop rather than sharing it with
 * `logicalLines()` above. ROUND 5 (r4-P3-3) — the justification this comment used to give was
 * that `logicalLines()` had to stay BYTE-IDENTICAL to the repo's other copies of it, so it could
 * not be refactored to track line numbers. Round 4 falsified that twice: the cross-copy check is
 * now behavioural rather than textual, and `logicalLinesWithLineNumbers()` — a function that does
 * exactly "track line numbers" — now lives in this same file. The real reason this loop is still
 * here is narrower: round 4 left it untouched to avoid changing `allVitestInvocations`'s output
 * shape in the same change that rewrote the cross-copy checks, and no round since has needed to.
 * The residual that scoping accepts — the fourth copy being compared on a single input — is
 * narrowed, not closed, from the test side: `r2-P3-4` compares it to `logicalLines()` on the real
 * lane script, and its round-5 widening runs the same comparison across the shared FIXTURES
 * battery, but that comparison is filtered through a `vitest run` predicate, so a divergence
 * confined to a non-`vitest run` logical line (e.g. an indented `#` comment) does not red there —
 * existing, unresolved (round-5 gate P3-1). The duplication is of the untyped line-splitting loop,
 * not of `logicalLines`/`execLogicalLine`/`tokensOf` themselves.
 *
 * Every `vitest run` invocation in this script today happens to fall after `set -euo pipefail`
 * (line 473; the earliest invocation is at line 477) — this function does not itself special-case
 * that boundary, it is simply true of the current file. See the design doc §1 for the fail-closed
 * consequence if a future edit ever added one before it (this function would wrongly count it as
 * gating when it would not be).
 *
 * Calls `execLogicalLine(scriptSrc)` first and lets its "exactly one exec logical line" throw
 * propagate un-widened — that fail-closed property is worth keeping independently of this
 * widening, not relaxed by it.
 */
export function allVitestInvocations(scriptSrc) {
  execLogicalLine(scriptSrc) // fail closed: still requires exactly one exec logical line to exist

  const kept = []
  scriptSrc
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .forEach((line, idx) => {
      if (!/^\s*#/.test(line)) kept.push({ lineNo: idx + 1, text: line })
    })

  const out = []
  let buf = null
  let startLine = null
  for (const { lineNo, text } of kept) {
    const trimmedRight = text.replace(/\s+$/, '')
    const continued = trimmedRight.endsWith('\\')
    const body = continued ? trimmedRight.slice(0, -1).trim() : trimmedRight.trim()
    if (buf === null) {
      buf = body
      startLine = lineNo
    } else {
      buf = `${buf} ${body}`.trim()
    }
    if (!continued) {
      out.push({ startLine, text: buf })
      buf = null
      startLine = null
    }
  }
  if (buf !== null) out.push({ startLine, text: buf })

  return out.filter((line) => /\bvitest\s+run\b/.test(line.text))
}

/**
 * ROUND 2 — token -> sorted array of every 1-based source line number it appears on, across ALL
 * gating `vitest run` invocations (not just the exec block). `stripTrailingErrorGuard()` is
 * applied to each invocation's text before `tokensOf()` so the two `|| exit $?`-tailed lines never
 * contribute `||`/`exit`/`$?` as if they were real tokens.
 */
export function allVitestTokenLines(scriptSrc) {
  const map = new Map()
  for (const { startLine, text } of allVitestInvocations(scriptSrc)) {
    for (const token of tokensOf(stripTrailingErrorGuard(text))) {
      if (!map.has(token)) map.set(token, [])
      map.get(token).push(startLine)
    }
  }
  for (const lines of map.values()) lines.sort((a, b) => a - b)
  return map
}

/** The distinct token SET across ALL 19 gating `vitest run` invocations (union, not just the exec block's 397). */
export function allVitestTokens(scriptSrc) {
  return new Set(allVitestTokenLines(scriptSrc).keys())
}
