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
 *     ancestry-verdict downgrade) IS exercised by CI: four subprocess-driven `node:test` cases in
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
// SECOND BATCH, closed this round (gate-2, CHANGES-REQUESTED, PR #4839, 20260810) — named here so
// the next reader can tell what was learned rather than re-deriving it: `unconditionally`,
// `each`, `100%`, `invariably`, `completely`. A REAL this-round instance of one of these
// (`each`) existed in this very PR's body ("five findings … each fixed and mutation-proven") —
// not a hypothetical, the exact class this sweep exists to catch. `100%` needed a boundary-
// fragment special case (see `phraseFragment` below): a bare trailing `\b` never matches after a
// non-word character like `%`, so the OLD single alternation-wide `\b(...)\b` wrapper would have
// silently never fired for it even once it was added to the list — verified via this file's own
// self-test battery, which is exactly the control that catches this class of authoring mistake.
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
  { phrase: 'unconditionally', positive: 'This rule holds unconditionally.', negative: 'The unconditional guarantee still needed sign-off.' },
  { phrase: 'each', positive: 'It applies to each row.', negative: 'The beach was crowded.' },
  { phrase: '100%', positive: 'It is 100% covered.', negative: 'It costs 1000 dollars.' },
  { phrase: 'invariably', positive: 'It invariably fails under load.', negative: 'The invariant held throughout.' },
  { phrase: 'completely', positive: 'It completely resolves the issue.', negative: 'The complete set was archived.' },
]

const QUANTIFIER_PHRASES = QUANTIFIER_CASES.map((quantifierCase) => quantifierCase.phrase)

/**
 * Boundary-aware regex fragment for ONE phrase. A bare `\b` requires a transition between a word
 * character (`\w`) and a non-word character; it can never match immediately after a phrase that
 * itself ENDS in a non-word character (e.g. `100%` followed by a space or end-of-string — `%`
 * and the following non-word character are never a `\b` transition). Phrases that start/end with
 * a word character (every phrase here except `100%`) get the original plain `\b` treatment,
 * unchanged; `100%`'s trailing edge uses a negative lookahead (`(?!\w)` — "not immediately
 * followed by a word character") instead, which correctly requires nothing further for a
 * non-word-ending phrase rather than a boundary transition that structurally cannot exist.
 */
function phraseFragment(phrase) {
  const escaped = phrase.replace(/ /g, '\\s+')
  const leftBoundary = /^\w/.test(phrase) ? '\\b' : ''
  const rightBoundary = /\w$/.test(phrase) ? '\\b' : '(?!\\w)'
  return `${leftBoundary}(${escaped})${rightBoundary}`
}

/** Regex for ONE phrase — what each phrase's own controls are checked against. */
function buildSinglePhraseRegex(phrase) {
  return new RegExp(phraseFragment(phrase), 'gi')
}

function buildQuantifierRegex() {
  // Each alternative carries its OWN boundary fragment (see `phraseFragment`) rather than one
  // outer `\b(...)\b` wrapped around the whole alternation — the old wrapper form would apply the
  // same (wrong, for `100%`) trailing-`\b` requirement to every alternative regardless of what it
  // ends with.
  const alternation = QUANTIFIER_PHRASES.map((phrase) => phraseFragment(phrase)).join('|')
  return new RegExp(alternation, 'gi')
}

// SHA-like: 7-40 lowercase hex characters. A candidate is first matched as a bare run of
// [0-9a-f]{7,40}, then required to contain at least one a-f LETTER — a run of only digits (a
// date like "20260810", an issue number, a byte count) is valid hex syntactically but is never
// what this codebase means by a "SHA-like token"; requiring one a-f letter is a cheap, disclosed
// heuristic that eliminates the single largest false-positive source (every doc comment in this
// repo embeds dates like ", 20260810)") at the cost of missing the astronomically rare real git
// SHA that happens to be all-digit.
//
// P3 fix (gate-2 round, CHANGES-REQUESTED, PR #4839, 20260810): this pattern's {7,40} quantifier
// structurally CANNOT match a run of 41+ hex characters — a full-length sha256 digest (64 hex
// chars, exactly what this repo's own content-addressed pins use, e.g.
// `s6a-package-provenance-pins.json`) has no valid match position: any 40-or-fewer-char window
// selected from inside a 64-char run still borders more hex characters on at least one side, so
// the required `\b` boundary never lands. Verified directly: a file containing both a 64-char
// digest and an 8-char SHA-like token flagged only the 8-char one before this fix. The pin
// digests — the values that actually gate the required `integration-guard` check — were the one
// thing this sweep could not see. Fixed with a SEPARATE, exact-length pattern below rather than
// widening {7,40} (widening would blur the two different claim classes together: a git commit
// SHA is verifiable ancestry, a content digest is not, and must never be run through
// `gitAncestryVerdict`'s `cat-file`/`merge-base` calls — see its own use-site comment in
// `scanLine`).
const SHA_CANDIDATE_RE = /\b[0-9a-f]{7,40}\b/g
function isShaLike(token) {
  return /[a-f]/.test(token)
}

// Exact-length sha256 hex digest (64 chars) — a SEPARATE class from SHA_CANDIDATE_RE above, not
// an extension of it (see that pattern's comment for why). A run of 65 hex characters correctly
// produces ZERO matches here (proven by this pattern's own self-test negative below): whichever
// 64-char window is tried, at least one boundary still borders another hex character from the
// same run, exactly the same boundary-exhaustion reasoning as SHA_CANDIDATE_RE's {7,40} case.
const SHA256_DIGEST_RE = /\b[0-9a-f]{64}\b/g

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
  {
    name: 'sha256 digest pin (exact 64-char run) vs a 65-char run (one longer — must NOT match)',
    re: () => SHA256_DIGEST_RE,
    positive: 'The pin is 88176e7e79f5f5a9017ff93675e05cbadf9589f9d1d3693f00503c05e0ea8fcf exactly.',
    // 65 hex chars (the positive's 64 plus one more) — proves the exact-length anchor rejects a
    // run one character too long, not just runs that are obviously too short.
    negative: 'The pin is 88176e7e79f5f5a9017ff93675e05cbadf9589f9d1d3693f00503c05e0ea8fcfa exactly.',
    filter: isShaLike,
  },
  {
    name: 'sha256 digest pin does not fire on a short hex run (6 chars)',
    re: () => SHA256_DIGEST_RE,
    positive: 'The pin is 88176e7e79f5f5a9017ff93675e05cbadf9589f9d1d3693f00503c05e0ea8fcf exactly.',
    negative: 'The short id abc123 is unrelated.',
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
  // Exact-length sha256 digest pins — a SEPARATE row type, deliberately NEVER routed through
  // `gitAncestryVerdict`: a content-addressed digest is not a git commit and `cat-file -e
  // <digest>^{commit}` would just report "not found", a misleading verdict dressed up as a real
  // one. Always NEEDS-MANUAL-BACKING — this sweep has no mechanical way to confirm a digest pin
  // matches what it claims to pin.
  for (const m of lineText.matchAll(SHA256_DIGEST_RE)) {
    if (!isShaLike(m[0])) continue
    rows.push({
      file: fileLabel,
      line: lineNumber,
      patternType: 'sha256-digest-pin',
      matched: m[0],
      sentence: lineText.trim().slice(0, 300),
      backing: 'NEEDS-MANUAL-BACKING',
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

// P3 fix (gate-2 round, CHANGES-REQUESTED, PR #4839, 20260810): a misuse-exit signal, never a
// direct `process.exit()` call from inside argument parsing — see `main()`'s own comment for why
// calling `process.exit()` anywhere after a `process.stdout.write()` in this file is the exact
// bug class being fixed (truncated piped output). `parseArgs` writes its own stderr diagnostic
// (that write is safe here — it happens before any stdout output exists to race) and throws this
// sentinel; `main()` is the ONLY place that decides the process's final exit code.
class ClaimSweepMisuseError extends Error {}

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
      throw new ClaimSweepMisuseError()
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

/**
 * P3 fix (gate-2 round, CHANGES-REQUESTED, PR #4839, 20260810): a large sweep piped to another
 * process (rather than redirected to a file) was SILENTLY TRUNCATED — exit code 0, no error,
 * just missing rows off the end. Root cause: for a PIPE destination (unlike a TTY or a regular
 * file), `process.stdout.write()` is asynchronous — Node queues the write and returns before the
 * data has necessarily reached the kernel. The old code called `process.exit(N)` immediately
 * after the LAST `stdout.write()`/`printTableMd()` call in every exit path, which forcibly
 * terminates the process without waiting for any still-in-flight writes to flush. Reproduced
 * directly (not simulated): a synthetic sweep whose file-redirected output is 1,000,896 bytes
 * came back as exactly 65,536 bytes (one pipe bufferful) when piped and drained with an eager
 * reader — the process exited before the remaining ~935KB of queued writes ever reached the
 * pipe.
 *
 * Fix: this function NEVER calls `process.exit()`. Every exit path sets `process.exitCode`
 * instead and returns; Node's default behaviour is to keep the event loop alive until all
 * pending I/O (including queued stdout/stderr writes) has actually drained, THEN exit with
 * whatever `process.exitCode` was last set to. `parseArgs`'s `ClaimSweepMisuseError` is caught
 * here for the same reason — it should never itself call `process.exit()`.
 */
function main() {
  const argv = process.argv.slice(2)
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    if (error instanceof ClaimSweepMisuseError) {
      process.exitCode = 2
      return
    }
    throw error
  }

  // Standing control: self-tests run on EVERY invocation, not only `--self-test`.
  const selfTestFailures = runSelfTests()
  if (args.selfTest) {
    if (selfTestFailures.length > 0) {
      process.stderr.write('claim-sweep self-test: FAILED\n')
      for (const failure of selfTestFailures) process.stderr.write(`  - ${failure}\n`)
      process.exitCode = 1
      return
    }
    process.stdout.write(`claim-sweep self-test: PASSED (${SELF_TESTS.length} patterns, each proven to fire on a positive and not fire on a negative)\n`)
    process.exitCode = 0
    return
  }
  if (selfTestFailures.length > 0) {
    process.stderr.write('claim-sweep: refusing to run — the sweep\'s own pattern self-tests failed, so a clean scan below would mean nothing:\n')
    for (const failure of selfTestFailures) process.stderr.write(`  - ${failure}\n`)
    process.exitCode = 1
    return
  }

  // Standing control: zero input is a hard error, never a silently-clean empty table.
  if (args.files.length === 0 && !args.textFile) {
    process.stderr.write(
      'claim-sweep: no input given (need at least one --file and/or --text-file) — refusing to report an empty sweep over nothing.\n',
    )
    process.exitCode = 2
    return
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
      process.exitCode = 2
      return
    }
    const text = readFileSync(filePath, 'utf8')
    allRows.push(...scanSource(filePath, text, args.gitHead, shallow))
  }
  if (args.textFile) {
    if (!existsSync(args.textFile) || !statSync(args.textFile).isFile()) {
      process.stderr.write(`claim-sweep: --text-file ${JSON.stringify(args.textFile)} does not exist or is not a regular file.\n`)
      process.exitCode = 2
      return
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
    process.exitCode = 1
    return
  }
  process.exitCode = 0
}

main()
