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
 * Values-free: reads only repo-tracked script text and returns token/line strings.
 */

/**
 * Strip whole-line `#` comments, then fold backslash continuations into logical lines.
 *
 * Byte-for-byte the same algorithm as the two existing copies (shape test / token-set-diff): only
 * a line whose LAST non-whitespace character is `\` continues; the backslash is dropped and a
 * single space joins the pieces, matching how bash hands the argv to vitest.
 */
export function logicalLines(scriptSrc) {
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
