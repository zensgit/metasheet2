#!/usr/bin/env node
/**
 * Mechanical claim sweep — finds every sentence that makes a claim needing independent backing
 * (an absolute quantifier, a SHA-like token, or an N/M or "N of M" figure) across a set of
 * source files and/or a text blob (e.g. a PR body), and emits one row per claim: file, line, the
 * matched text, the sentence it came from, and a "backing" column that either states the
 * mechanically-verified verdict (SHA ancestry, checked against a live git repo) or says
 * `NEEDS-MANUAL-BACKING` when the claim cannot be verified without human/domain judgment.
 *
 * Built PR #4839 gate, 20260810, per the standing house lesson that a false-statement class does
 * not converge under hand-fixing individual sentences (feedback_absolute_claim_sweep_must_be_
 * mechanical.md, feedback_trap_enumeration_does_not_converge.md): a single mechanical sweep run
 * repeatedly beats an enumeration of "just this one more fix." This script is a reusable TOOL,
 * not a one-shot fix.
 *
 * WIRING — stated precisely so no other text in this PR can be read as implying otherwise:
 *   - This tool's OWN correctness (its pattern self-tests, `--self-test`, AND its shallow-clone
 *     ancestry-verdict downgrade) IS exercised by CI: two subprocess-driven `node:test` cases in
 *     `scripts/ops/attendance-w4c5-rollout-transition-lib.test.ts`, which is already wired into
 *     `.github/workflows/plugin-tests.yml` (`pnpm exec tsx --test
 *     scripts/ops/attendance-w4c5-rollout-transition-lib.test.ts`). No edit to any workflow file
 *     was needed for this — the tests were added to a file CI already invokes.
 *   - This tool's INTENDED normal-use invocation — sweeping an arbitrary set of changed files
 *     and/or a PR body for absolute-claim language on demand — is run by NO CI gate. Nothing in
 *     this PR runs `claim-sweep.mjs --file ... --text-file ...` automatically on every push; it
 *     remains a manually-invoked audit tool a reviewer or author points at whatever needs
 *     checking, same as before this PR's fresh-gate round.
 *
 * Usage:
 *   node scripts/ops/claim-sweep.mjs --self-test
 *     Runs ONLY the pattern self-tests (every pattern proven to fire on a synthetic positive AND
 *     proven NOT to fire on a synthetic near-miss negative) and exits 0/1. No file input needed.
 *
 *   node scripts/ops/claim-sweep.mjs --file <path> [--file <path> ...] [--text-file <path>]
 *                                     [--text-label <label>] [--format md|json] [--git-head <ref>]
 *     Runs the self-tests first (as a standing control on every invocation — a sweep whose own
 *     patterns silently stopped firing must never quietly report "clean"), then scans every
 *     --file (real path, real line numbers) and, if given, --text-file (scanned the same way, but
 *     reported under --text-label — default "TEXT_BLOB" — since a blob like a PR body has no
 *     meaningful repo-relative path). Prints a table to stdout.
 *
 * Controls (a sweep with none of these is theatre, not a mechanism):
 *   - Self-tests run on EVERY invocation (not just --self-test) before the real sweep starts, and
 *     abort the whole run (exit 1) if any pattern fails to fire on its own synthetic positive, or
 *     DOES fire on its own synthetic near-miss negative.
 *   - Zero input (no --file and no --text-file) is a hard error (exit 2), never a silently empty
 *     "0 findings" table — an empty table must mean "scanned N files/blobs, found nothing", never
 *     "scanned nothing".
 *   - An unreadable --file path is a hard error (exit 2), never a silent skip.
 *   - Shallowness (`git rev-parse --is-shallow-repository`) is checked ONCE per run, before any
 *     SHA-like token is verdicted. On a shallow clone, neither "not found as a commit object" nor
 *     a `merge-base --is-ancestor` exit-1 is trusted as a disproof (repo doctrine: shallow-clone
 *     ancestry answers are lies) — both downgrade to an explicit `UNKNOWN: shallow clone …` row,
 *     which never starts with the `AUTO: NOT an ancestor` prefix the exit-1 escalation below
 *     matches on, so an unreliable shallow-clone signal can never trigger a false mechanical
 *     disproof.
 *
 * Exit codes:
 *   0 — self-tests passed and (for a sweep run) the scan completed with no MECHANICALLY-DISPROVEN
 *       claim (a SHA-like token confirmed NOT an ancestor of --git-head). NEEDS-MANUAL-BACKING
 *       rows do not affect the exit code — this tool cannot unilaterally clear or fail those.
 *   1 — a self-test failed (the sweep's own mechanism is broken — refuses to report anything else)
 *       OR (sweep mode) at least one SHA-like token was mechanically confirmed NOT an ancestor of
 *       --git-head.
 *   2 — misuse: zero input, or an unreadable --file path.
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

// SINGLE SOURCE. A phrase and its two controls are ONE record: the production regex is derived
// from this list, and each phrase's controls are checked with a regex built for THAT PHRASE ALONE.
//
// Both properties are here because their absence was executed, not imagined (owner review,
// PR #4839, 20260810):
//   - A phrase list and a parallel control list drifted the first time a phrase was added: seven
//     phrases landed with zero controls while the banner still printed the old pattern count.
//   - A "does every phrase have a control?" check on top of that did NOT fix it, because every
//     control ran the FULL-vocabulary regex. Rewriting the `none` case's positive to a sentence
//     containing only `every` left the battery green and still claiming all patterns verified.
//     The criterion was the hole. One record per phrase, checked by its own regex, removes both.
//
// A NAMED LIST, not a closed one — the sweep's own load-bearing limitation, stated rather than
// left for a reader to find. The battery proves each phrase BELOW fires; that is evidence the
// implemented patterns work, NOT evidence the vocabulary is complete. A clean run means "no listed
// phrase found", never "this text makes no absolute claims". Measured, not asserted: the original
// ten-phrase list scored ZERO rows on the sentence "none of the reachable classes is impossible to
// bucket, and this module is the sole arbiter; any subclass must inherit the exact same bucket
// without exception" — five absolute claims, all invisible. Six phrases that sentence exposed are
// listed below (`none`, `any`, `must`, `impossible`, `sole`, `without exception`), plus `solely`
// as a spelling variant of one of them. The next such sentence will expose more; add them then.
//
// Every negative is a NEAR MISS — a string that contains the phrase's letters but must not match
// under word boundaries. A negative that merely omits the phrase would pass trivially.
const QUANTIFIER_CASES = [
  { phrase: 'every', positive: 'This works for every case.', negative: 'The everyday case is different.' },
  { phrase: 'all', positive: 'It covers all paths.', negative: 'The overall design is fine.' },
  { phrase: 'always', positive: 'The guard always releases the lock.', negative: 'The hallways were empty.' },
  { phrase: 'never', positive: 'This never happens.', negative: 'The endeavor was cut short.' },
  { phrase: 'cannot', positive: 'It cannot be instantiated.', negative: 'The cannonball rolled away.' },
  { phrase: 'no other', positive: 'There is no other writer.', negative: 'There is another writer.' },
  { phrase: 'by construction', positive: 'Shared by construction.', negative: 'By constructing it early we saved time.' },
  { phrase: 'exhaustively', positive: 'Checked exhaustively.', negative: 'The exhaustive-sounding claim was vague.' },
  { phrase: 'only', positive: 'It only matches boundary classes.', negative: 'This is a commonly used pattern.' },
  // `guaranteed` previously carried `skipNegative: true` — an escape hatch that made the banner's
  // "each proven ... not to fire on a negative" false for one row. Removed; this is its real
  // near-miss (`guarantor` shares the stem, must not match under \b).
  { phrase: 'guaranteed', positive: 'This is guaranteed to work.', negative: 'The guarantor signed the form.' },
  { phrase: 'none', positive: 'None of the classes match.', negative: 'The nonexistent file was skipped.' },
  { phrase: 'any', positive: 'Any subclass inherits the bucket.', negative: 'The build anyway completed.' },
  { phrase: 'must', positive: 'It must fail closed.', negative: 'The mustard jar sat there.' },
  { phrase: 'impossible', positive: 'That state is impossible.', negative: 'The impossibility argument was long.' },
  { phrase: 'sole', positive: 'This module is the sole arbiter.', negative: 'The console logged it.' },
  { phrase: 'solely', positive: 'It relies solely on the pin.', negative: 'The solenoid clicked.' },
  { phrase: 'without exception', positive: 'It holds without exception.', negative: 'Without exceptions listed, review stalls.' },
]

const QUANTIFIER_PHRASES = QUANTIFIER_CASES.map((quantifierCase) => quantifierCase.phrase)

/** Regex for ONE phrase — what each phrase's own controls are checked against. */
function buildSinglePhraseRegex(phrase) {
  return new RegExp(`\\b(${phrase.replace(/ /g, '\\s+')})\\b`, 'gi')
}

function buildQuantifierRegex() {
  const alternation = QUANTIFIER_PHRASES.map((phrase) => phrase.replace(/ /g, '\\s+')).join('|')
  return new RegExp(`\\b(${alternation})\\b`, 'gi')
}

// SHA-like: 7-40 lowercase hex characters. A candidate is first matched as a bare run of
// [0-9a-f]{7,40}, then required to contain at least one a-f LETTER — a run of only digits (a
// date like "20260810", an issue number, a byte count) is valid hex syntactically but is never
// what this codebase means by a "SHA-like token"; requiring one a-f letter is a cheap, disclosed
// heuristic that eliminates the single largest false-positive source (every doc comment in this
// repo embeds dates like ", 20260810)") at the cost of missing the astronomically rare real git
// SHA that happens to be all-digit.
const SHA_CANDIDATE_RE = /\b[0-9a-f]{7,40}\b/g
function isShaLike(token) {
  return /[a-f]/.test(token)
}

// N/M (e.g. "28/28") and "N of M" (e.g. "5 of 7") figures.
const NM_SLASH_RE = /\b\d+\s*\/\s*\d+\b/g
const NM_OF_RE = /\b\d+\s+of\s+\d+\b/gi

// ---------------------------------------------------------------------------
// Self-tests: every pattern must be PROVEN to fire on a synthetic positive, and PROVEN not to
// fire on a synthetic near-miss negative (a substring/adjacent-word case a naive regex would get
// wrong). A clean sweep below means "none found by a working mechanism", never "the mechanism
// never worked".
// ---------------------------------------------------------------------------
// Derived from QUANTIFIER_CASES — never re-typed. Each quantifier row is checked against a regex
// built for ITS OWN phrase, so a positive that exercises some OTHER listed phrase fails the row it
// is written under instead of passing on the alternation's coattails.
const SELF_TESTS = [
  ...QUANTIFIER_CASES.map((quantifierCase) => ({
    name: `quantifier: ${quantifierCase.phrase}`,
    re: () => buildSinglePhraseRegex(quantifierCase.phrase),
    positive: quantifierCase.positive,
    negative: quantifierCase.negative,
  })),
  {
    name: 'sha-like token',
    re: () => SHA_CANDIDATE_RE,
    positive: 'The head is at a21615573cdeadbeef1234567890abcdef123456.',
    negative: 'Filed on 20260810 as PR #4839, item 3 of 3.',
    filter: isShaLike,
  },
  { name: 'N/M figure (slash)', re: () => NM_SLASH_RE, positive: 'All 28/28 tests passed.', negative: 'See packages/core-backend for the source.' },
  { name: 'N of M figure ("of")', re: () => NM_OF_RE, positive: '5 of 7 predicates fired.', negative: 'It ran out of memory.' },
]

function runSelfTests() {
  const failures = []
  // Meta-assertion: EVERY row must carry both controls and both must actually run. The previous
  // version allowed a per-row `skipNegative` escape hatch, which made the banner's "each proven to
  // fire on a positive and not fire on a negative" false for the one row that used it. There is no
  // longer such a field; this refuses to run if one is reintroduced, rather than trusting nobody
  // will add it back.
  for (const test of SELF_TESTS) {
    if ('skipNegative' in test) {
      failures.push(
        `${test.name}: carries a skipNegative escape hatch — every row must run both controls, ` +
          'or this tool\'s own PASSED banner becomes a false claim',
      )
    }
    if (typeof test.positive !== 'string' || test.positive.length === 0) {
      failures.push(`${test.name}: missing a synthetic positive`)
    }
    if (typeof test.negative !== 'string' || test.negative.length === 0) {
      failures.push(`${test.name}: missing a near-miss negative`)
    }
  }
  for (const test of SELF_TESTS) {
    const re = test.re()
    const positiveMatches = [...test.positive.matchAll(re)].map((m) => m[0]).filter((t) => (test.filter ? test.filter(t) : true))
    if (positiveMatches.length === 0) {
      failures.push(`${test.name}: FAILED TO FIRE on its own synthetic positive sentence: ${JSON.stringify(test.positive)}`)
    }
    // Unconditional — there is no opt-out. See the meta-assertion above.
    const negRe = test.re()
    const negativeMatches = [...test.negative.matchAll(negRe)].map((m) => m[0]).filter((t) => (test.filter ? test.filter(t) : true))
    if (negativeMatches.length > 0) {
      failures.push(
        `${test.name}: FALSELY FIRED on its own synthetic near-miss negative sentence: ${JSON.stringify(test.negative)} (matched ${JSON.stringify(negativeMatches)})`,
      )
    }
  }
  return failures
}

// ---------------------------------------------------------------------------
// Git ancestry check (best-effort; degrades to UNKNOWN if not in a git repo, git is
// unavailable, or the repo is a SHALLOW CLONE — never silently treated as "verified").
//
// Standing house rule (this repo has been burned by this class before): on a shallow clone,
// neither `git cat-file -e <sha>^{commit}` returning failure NOR `git merge-base --is-ancestor`
// exiting 1 means what it means on a full clone. A commit outside the fetched depth is
// genuinely absent from THIS clone's object store (not absent from history), and
// `merge-base --is-ancestor` can run out of fetched history before finding a real common
// ancestor and report "not an ancestor" for a commit that truly is one. Both cases are
// downgraded to UNKNOWN rather than asserting a disproof.
// ---------------------------------------------------------------------------

/**
 * Computed ONCE per process (shallowness doesn't change mid-run) and threaded through every
 * verdict call, never re-queried per token. If shallowness itself cannot be determined (git
 * missing, not a repo), the safer assumption is SHALLOW — a repo this tool cannot even ask
 * about ancestry depth is not one it should assert a mechanical disproof against.
 */
function isShallowRepo() {
  try {
    const out = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { stdio: ['ignore', 'pipe', 'ignore'] })
    return out.toString('utf8').trim() === 'true'
  } catch {
    return true
  }
}

function gitAncestryVerdict(token, headRef, shallow) {
  try {
    execFileSync('git', ['cat-file', '-e', `${token}^{commit}`], { stdio: ['ignore', 'ignore', 'ignore'] })
  } catch {
    if (shallow) {
      return `UNKNOWN: shallow clone — cannot confirm ${token} is not a commit object (it may sit outside the fetched depth); re-run on a full clone for a real verdict`
    }
    return `AUTO: not found as a commit object in this repo`
  }
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', token, headRef], { stdio: ['ignore', 'ignore', 'ignore'] })
    return `AUTO: ancestor of ${headRef}`
  } catch (error) {
    // exit code 1 from `merge-base --is-ancestor` means "not an ancestor" ONLY on a full clone (a
    // real, mechanically verified negative); any OTHER failure (e.g. headRef itself unresolvable)
    // is a tool error, not a verdict, and must not be conflated with "not an ancestor".
    if (error && typeof error.status === 'number' && error.status === 1) {
      if (shallow) {
        // Deliberately NOT prefixed with "AUTO: NOT an ancestor" — the exit(1)-escalation check
        // in `main()` matches on that exact prefix, and a shallow-clone UNKNOWN must never re-arm
        // a mechanical-disproof exit code it did not actually establish.
        return `UNKNOWN: shallow clone — \`git merge-base --is-ancestor\` exit 1 is not a reliable disproof here (history may be truncated before a real common ancestor); re-run on a full clone (\`git fetch --unshallow\`) for a real verdict`
      }
      return `AUTO: NOT an ancestor of ${headRef}`
    }
    return `AUTO: git unavailable/unresolvable (${headRef}) — UNVERIFIED`
  }
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------
function scanLine(fileLabel, lineNumber, lineText, headRef, shallow) {
  const rows = []
  const quantifierRe = buildQuantifierRegex()
  for (const m of lineText.matchAll(quantifierRe)) {
    rows.push({
      file: fileLabel,
      line: lineNumber,
      patternType: 'absolute-quantifier',
      matched: m[0],
      sentence: lineText.trim().slice(0, 300),
      backing: 'NEEDS-MANUAL-BACKING',
    })
  }
  for (const m of lineText.matchAll(SHA_CANDIDATE_RE)) {
    if (!isShaLike(m[0])) continue
    rows.push({
      file: fileLabel,
      line: lineNumber,
      patternType: 'sha-like-token',
      matched: m[0],
      sentence: lineText.trim().slice(0, 300),
      backing: gitAncestryVerdict(m[0], headRef, shallow),
    })
  }
  for (const m of lineText.matchAll(NM_SLASH_RE)) {
    rows.push({
      file: fileLabel,
      line: lineNumber,
      patternType: 'n-of-m-figure',
      matched: m[0],
      sentence: lineText.trim().slice(0, 300),
      backing: 'NEEDS-MANUAL-BACKING',
    })
  }
  for (const m of lineText.matchAll(NM_OF_RE)) {
    rows.push({
      file: fileLabel,
      line: lineNumber,
      patternType: 'n-of-m-figure',
      matched: m[0],
      sentence: lineText.trim().slice(0, 300),
      backing: 'NEEDS-MANUAL-BACKING',
    })
  }
  return rows
}

function scanSource(fileLabel, text, headRef, shallow) {
  const rows = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    rows.push(...scanLine(fileLabel, i + 1, lines[i], headRef, shallow))
  }
  return rows
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { files: [], textFile: null, textLabel: 'TEXT_BLOB', format: 'md', gitHead: 'HEAD', selfTest: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--self-test') args.selfTest = true
    else if (arg === '--file') args.files.push(argv[++i])
    else if (arg === '--text-file') args.textFile = argv[++i]
    else if (arg === '--text-label') args.textLabel = argv[++i]
    else if (arg === '--format') args.format = argv[++i]
    else if (arg === '--git-head') args.gitHead = argv[++i]
    else {
      process.stderr.write(`claim-sweep: unrecognized argument ${JSON.stringify(arg)}\n`)
      process.exit(2)
    }
  }
  return args
}

function printTableMd(rows) {
  if (rows.length === 0) {
    process.stdout.write('No claims flagged.\n')
    return
  }
  process.stdout.write('| File | Line | Type | Matched | Sentence | Backing |\n')
  process.stdout.write('| --- | --- | --- | --- | --- | --- |\n')
  for (const row of rows) {
    const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ')
    process.stdout.write(
      `| ${cell(row.file)} | ${row.line} | ${cell(row.patternType)} | ${cell(row.matched)} | ${cell(row.sentence)} | ${cell(row.backing)} |\n`,
    )
  }
}

function main() {
  const argv = process.argv.slice(2)
  const args = parseArgs(argv)

  // Standing control: self-tests run on EVERY invocation, not only `--self-test`.
  const selfTestFailures = runSelfTests()
  if (args.selfTest) {
    if (selfTestFailures.length > 0) {
      process.stderr.write('claim-sweep self-test: FAILED\n')
      for (const failure of selfTestFailures) process.stderr.write(`  - ${failure}\n`)
      process.exit(1)
    }
    process.stdout.write(`claim-sweep self-test: PASSED (${SELF_TESTS.length} patterns, each proven to fire on a positive and not fire on a negative)\n`)
    process.exit(0)
  }
  if (selfTestFailures.length > 0) {
    process.stderr.write('claim-sweep: refusing to run — the sweep\'s own pattern self-tests failed, so a clean scan below would mean nothing:\n')
    for (const failure of selfTestFailures) process.stderr.write(`  - ${failure}\n`)
    process.exit(1)
  }

  // Standing control: zero input is a hard error, never a silently-clean empty table.
  if (args.files.length === 0 && !args.textFile) {
    process.stderr.write(
      'claim-sweep: no input given (need at least one --file and/or --text-file) — refusing to report an empty sweep over nothing.\n',
    )
    process.exit(2)
  }

  // Computed ONCE for the whole run — see `isShallowRepo`'s own doc for why per-token
  // re-computation would be wasteful (shallowness cannot change mid-process) and why "cannot
  // determine" defaults to the conservative `true`.
  const shallow = isShallowRepo()
  if (shallow) {
    process.stderr.write(
      'claim-sweep: this is a SHALLOW git clone — SHA-like-token ancestry verdicts below are downgraded to UNKNOWN rather than a mechanical disproof (repo doctrine: shallow-clone ancestry answers are lies).\n',
    )
  }

  const allRows = []
  for (const filePath of args.files) {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      process.stderr.write(`claim-sweep: --file ${JSON.stringify(filePath)} does not exist or is not a regular file — refusing to silently skip it.\n`)
      process.exit(2)
    }
    const text = readFileSync(filePath, 'utf8')
    allRows.push(...scanSource(filePath, text, args.gitHead, shallow))
  }
  if (args.textFile) {
    if (!existsSync(args.textFile) || !statSync(args.textFile).isFile()) {
      process.stderr.write(`claim-sweep: --text-file ${JSON.stringify(args.textFile)} does not exist or is not a regular file.\n`)
      process.exit(2)
    }
    const text = readFileSync(args.textFile, 'utf8')
    allRows.push(...scanSource(args.textLabel, text, args.gitHead, shallow))
  }

  if (args.format === 'json') {
    process.stdout.write(JSON.stringify(allRows, null, 2) + '\n')
  } else {
    printTableMd(allRows)
  }

  const byType = {}
  for (const row of allRows) byType[row.patternType] = (byType[row.patternType] ?? 0) + 1
  process.stderr.write(
    `claim-sweep: scanned ${args.files.length} file(s)${args.textFile ? ' + 1 text blob' : ''}, ${allRows.length} claim(s) flagged (${Object.entries(byType)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ') || 'none'}).\n`,
  )

  const disprovenShas = allRows.filter((row) => row.patternType === 'sha-like-token' && row.backing.startsWith('AUTO: NOT an ancestor'))
  if (disprovenShas.length > 0) {
    process.stderr.write(`claim-sweep: ${disprovenShas.length} SHA-like token(s) MECHANICALLY CONFIRMED NOT an ancestor of ${args.gitHead} — see rows above.\n`)
    process.exit(1)
  }
  process.exit(0)
}

main()
