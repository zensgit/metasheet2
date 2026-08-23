'use strict'

/**
 * CUSTOMER-DICTIONARY LEAK GUARD — the mechanised half of a rule that already existed in prose.
 *
 * `lib/customer-packs/factory-a.sample.cjs` has said since the day it was written that a real
 * deployment's dictionaries are DEPLOY-TIME DATA loaded from an uncommitted local file, and that
 * nothing customer-identifying belongs in this repository. #5074 then committed the customer's live
 * 领料节点 (6 entries) and 交接工段 (15 entries) option sets — their `config_info` primary keys
 * paired with their own process names — into `factory-a.rehearsal.cjs`, whose own header repeats
 * the rule two screens above the paste. Prose did not hold. This does.
 *
 * WHAT IS ACTUALLY BEING PROTECTED
 * --------------------------------
 * Not "Chinese text in a fixture", and not "steel grades". The protected thing is a tenant's
 * INTERNAL ID → NAME PAIRING:
 *
 *   FINE      '40 - S30408'. S30408 is a grade designation in GB 24511 / GB/T 150; every Chinese
 *             pressure-vessel supplier's catalogue carries it, and the `40` is a rung on a ladder
 *             invented for the fixture. Nothing in the pair identifies anyone.
 *   NOT FINE  '<their config_info key> - <their own process name>' — and the leaked pairs are NOT
 *             restated here, not even as an illustration, because quoting one to explain the ban
 *             would re-commit it. The numeric half was a primary key in ONE customer's table; that
 *             key means that name in exactly one database.
 *
 * A published designation is industry vocabulary and may be quoted. A key→label mapping read out of
 * a customer's instance is a row of their data and may not be, at any length.
 *
 * THE HEURISTIC, AND WHY THIS ONE
 * -------------------------------
 * A pasted dictionary has a fingerprint that survives translation, redaction and reformatting: the
 * numeric half is an OPAQUE PRIMARY KEY, so the ids are irregular — arbitrary gaps, and often not
 * even sorted (the leaked 交接工段 ran 53,54,…,61,158,163,206,257,290,304 and then 58). A list a
 * human authored for a fixture looks nothing like that: it is a ladder — 10,20,30,… — because
 * nobody hand-invents 76-wide gaps.
 *
 * So the rule is: any run of >= MIN_RUN_LENGTH consecutive source lines each carrying a
 * `'<digits> - <text>'` literal must have ids that, ONCE SORTED, form an arithmetic sequence with a
 * constant positive step.
 *
 * Sorted, not as-authored, on purpose. Array ORDER is a property the fixtures legitimately
 * exercise — `factory-a.rehearsal.cjs` deliberately appends its legacy bucket after the live
 * vocabulary so that the pack pipeline's stable-sort guarantee stays under test — and order is not
 * the provenance signal. ID SPACING is.
 *
 * POSTURE, STATED PLAINLY
 * -----------------------
 * FALSE POSITIVES — a fixture author who numbers a synthetic list irregularly (1, 7, 30, 44) trips
 * the guard. That is the intended cost and it is small: the remedy is renumbering onto a ladder, the
 * failure names the file, the line and the offending ids, and every legitimate list in this package
 * today already is a ladder (verified: across all 140+ lib modules and 160+ suites, the ONLY runs
 * this heuristic flagged were the two leaked dictionaries). It cannot be silenced without editing
 * this file, which is the point.
 *
 * FALSE NEGATIVES — three, named honestly:
 *   1. Renumbering. Paste a real dictionary, then renumber the ids 10,20,30,… and it passes. But
 *      renumbering DESTROYS the id→name pairing, which is the thing being protected; what survives
 *      is a name list, which is a materially smaller disclosure and often none at all.
 *   2. A real catalogue whose keys happen to be a perfect ladder. Possible; rare, because
 *      `config_info`-style tables accumulate keys by insertion over years.
 *   3. Anything not in the `'<id> - <name>'` shape at all — a dictionary carried as
 *      `{ id: 48, name: '…' }`, as JSON, or as prose. This guard is shaped to the ONE carrier this
 *      package actually uses for option values (`stock-preparation-option-sync.cjs` takes
 *      `{ value }` strings). Widen it when a second carrier appears; do not assume it is covered.
 *
 * Dependency-free (node:assert / node:fs / node:path) and hermetic: it reads the working tree and
 * writes nothing.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const PACKAGE_ROOT = path.join(__dirname, '..')

/**
 * Scanned roots. Scoped to this package because this is where packs and their fixtures live and
 * where the leak happened; a repo-wide sweep would trade a sharp, zero-noise signal for a broad one
 * nobody keeps green. `lib/` is included as a whole, not just `lib/customer-packs/`: a dictionary
 * pasted into a template or a mapper module is the same disclosure.
 */
const SCAN_ROOTS = Object.freeze(['lib', '__tests__', 'scripts'])

const SCANNED_EXTENSIONS = /\.(cjs|mjs|js)$/

/**
 * A run shorter than this is not a dictionary. Four is chosen against the real corpus, not picked
 * round: the longest legitimate run of ADJACENT-but-unrelated id literals in this package is the
 * rehearsal suite's seeded row, where `materialType` / `blankType` / `stockPreparationStatus` sit on
 * three consecutive lines. Four clears that by exactly one line and still catches the smaller of the
 * two leaked dictionaries, which was six.
 */
const MIN_RUN_LENGTH = 4

/**
 * One `'<id> - <name>'` literal. Deliberately narrow:
 *   - the separator is exactly space-hyphen-space, the form `stock-preparation-option-sync` values
 *     use, so an ordinary hyphenated string is not a match;
 *   - the id is bounded at 6 digits, so timestamps and ISO dates are not ids;
 *   - the name is bounded at 80 chars, so a long prose string containing " - " is not an entry.
 */
const ID_NAME_LITERAL = /['"`](\d{1,6}) - ([^'"`\n]{1,80})['"`]/

function listSourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') listSourceFiles(full, out)
    } else if (SCANNED_EXTENSIONS.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

/**
 * Whether a set of ids is a hand-authored ladder. Sorted ascending, distinct, constant positive
 * step. Fewer than two distinct ids cannot express irregularity, so it is vacuously regular.
 */
function isRegularLadder(ids) {
  const distinct = [...new Set(ids)].sort((left, right) => left - right)
  if (distinct.length < 2) return true
  const step = distinct[1] - distinct[0]
  if (step <= 0) return false
  return distinct.every((value, index) => index === 0 || value - distinct[index - 1] === step)
}

/** Maximal runs of consecutive lines that each carry an id→name literal. */
function findIdNameRuns(source) {
  const lines = source.split(/\r?\n/)
  const runs = []
  let current = []
  const flush = () => {
    if (current.length >= MIN_RUN_LENGTH) runs.push(current)
    current = []
  }
  for (let index = 0; index < lines.length; index += 1) {
    const match = ID_NAME_LITERAL.exec(lines[index])
    if (match) {
      current.push({ id: Number(match[1]), text: `${match[1]} - ${match[2]}`, line: index + 1 })
    } else {
      flush()
    }
  }
  flush()
  return runs
}

function scanFile(file) {
  return findIdNameRuns(fs.readFileSync(file, 'utf8')).filter(
    (run) => !isRegularLadder(run.map((entry) => entry.id)),
  )
}

// ---------------------------------------------------------------------------
// Controls on the detector itself. Without these, a matcher that never fires
// would report the package clean forever.
// ---------------------------------------------------------------------------

/**
 * Control fixtures are BUILT FROM DATA, never written out as source lines. An `{ value: '<id> -
 * <name>' }` block spelled literally here would be scanned like any other committed block and would
 * make this suite fail against itself — and "just skip this file" is the one exemption a leak guard
 * must not grant, since it would leave exactly one committed file where a paste is invisible.
 */
function renderOptionBlock(pairs) {
  return pairs.map(([id, name]) => `  { value: '${id} - ${name}' },`).join('\n')
}

function detectorControls() {
  // NEGATIVE CONTROL — the shape that leaked. NOT the leaked values: reproducing them to prove they
  // are banned would re-commit them. What is reproduced is the STRUCTURE — a short opaque key, then
  // a clustered high block, then one out-of-place legacy key — which is what the guard reads.
  const exportedKeyShape = [[7, 'alpha'], [181, 'bravo'], [182, 'charlie'], [183, 'delta'], [9, 'legacy']]
  const flagged = findIdNameRuns(renderOptionBlock(exportedKeyShape))
    .filter((run) => !isRegularLadder(run.map((entry) => entry.id)))
  assert.equal(flagged.length, 1, 'an irregular id run must be flagged')
  assert.equal(flagged[0].length, 5)

  // POSITIVE CONTROL — a hand-authored ladder passes, including one whose authored order is not id
  // order (the tail-appended legacy bucket the rehearsal pack deliberately carries).
  for (const ladder of [
    [[10, 'a'], [20, 'b'], [30, 'c'], [40, 'd'], [50, 'e']],
    [[10, 'a'], [20, 'b'], [40, 'd'], [30, 'c']],
    [[1, 'a'], [2, 'b'], [3, 'c'], [4, 'd']],
  ]) {
    const runs = findIdNameRuns(renderOptionBlock(ladder))
    assert.equal(runs.length, 1, 'the run detector must see the ladder')
    assert.equal(isRegularLadder(runs[0].map((entry) => entry.id)), true, 'a constant step must pass')
  }

  // The run detector must respect MIN_RUN_LENGTH and must not fuse literals across an intervening
  // line — otherwise scattered single values (a seeded test row) would be read as a dictionary.
  assert.deepEqual(findIdNameRuns(renderOptionBlock([[7, 'a'], [91, 'b'], [92, 'c']])), [])
  assert.deepEqual(
    findIdNameRuns(
      [renderOptionBlock([[7, 'a'], [91, 'b']]), 'const x = 1', renderOptionBlock([[92, 'c'], [250, 'd']])].join('\n'),
    ),
    [],
  )

  // Shapes that must NOT be read as an id→name entry at all.
  for (const notAnEntry of [
    "'2026-08-22 - some note'", //          a date, not an id
    "'well - formed but unnumbered'", //    no leading digits
    "'12-34'", //                           no spaced separator
    "'1234567 - too many digits'", //       beyond the 6-digit id bound
  ]) {
    assert.equal(ID_NAME_LITERAL.test(notAnEntry), false, `${notAnEntry} must not match`)
  }

  // Regularity control: a monotone but non-constant step is irregular, and so is a repeat.
  assert.equal(isRegularLadder([10, 20, 30, 45]), false, 'a broken step is not a ladder')
  assert.equal(isRegularLadder([10, 10, 10]), true, 'a single distinct id cannot express spacing')
}

// ---------------------------------------------------------------------------
// The assertion itself.
// ---------------------------------------------------------------------------

function committedFixturesCarryNoExportedCatalogue() {
  const files = SCAN_ROOTS.flatMap((root) => {
    const dir = path.join(PACKAGE_ROOT, root)
    return fs.existsSync(dir) ? listSourceFiles(dir) : []
  })

  // Walker control: if the scan silently returned nothing (moved directory, changed extension
  // convention) every assertion below would pass vacuously.
  assert.ok(files.length > 100, `expected a populated package, saw ${files.length} source files`)
  for (const required of [
    path.join(PACKAGE_ROOT, 'lib', 'customer-packs', 'factory-a.rehearsal.cjs'),
    path.join(PACKAGE_ROOT, 'lib', 'customer-packs', 'factory-a.sample.cjs'),
    path.join(PACKAGE_ROOT, '__tests__', 'stock-preparation-customer-pack-rehearsal.test.cjs'),
  ]) {
    assert.ok(files.includes(required), `the scan must reach ${path.relative(PACKAGE_ROOT, required)}`)
  }

  const findings = []
  for (const file of files) {
    for (const run of scanFile(file)) {
      findings.push(
        `${path.relative(PACKAGE_ROOT, file)}:${run[0].line}-${run[run.length - 1].line} ` +
          `(${run.length} entries, ids ${run.map((e) => e.id).join(',')})`,
      )
    }
  }

  assert.deepEqual(
    findings,
    [],
    'A committed option set carries irregular numeric ids, which is the fingerprint of a dictionary ' +
      'exported from a live customer instance rather than authored for a fixture. Real dictionaries ' +
      'belong ONLY in the uncommitted deploy-time pack file (see lib/customer-packs/' +
      'factory-a.sample.cjs). If this list really is synthetic, renumber it onto a constant step. ' +
      `Findings:\n  ${findings.join('\n  ')}`,
  )

  return files.length
}

/**
 * The pack fixtures must keep carrying dictionaries at all — the guard above is satisfied by an
 * EMPTY repository, and "delete every fixture" is not the fix this is asking for.
 */
function theFixturesStillCarryDictionaries() {
  const { FACTORY_A_REHEARSAL_PACK } = require('../lib/customer-packs/factory-a.rehearsal.cjs')
  const { FACTORY_A_SAMPLE_PACK } = require('../lib/customer-packs/factory-a.sample.cjs')

  const rehearsalCounts = FACTORY_A_REHEARSAL_PACK.optionSets.map((set) => set.options.length)
  assert.deepEqual(rehearsalCounts, [6, 15, 6, 6, 5], 'the rehearsal pack keeps its five dictionaries')
  assert.equal(FACTORY_A_SAMPLE_PACK.optionSets[0].options.length, 12)

  for (const pack of [FACTORY_A_REHEARSAL_PACK, FACTORY_A_SAMPLE_PACK]) {
    for (const set of pack.optionSets) {
      const values = set.options.map((option) => option.value)
      assert.equal(new Set(values).size, values.length, `${set.fieldId} must stay unique`)
      const ids = values
        .map((value) => ID_NAME_LITERAL.exec(`'${value}'`))
        .filter(Boolean)
        .map((match) => Number(match[1]))
      assert.equal(ids.length, values.length, `${set.fieldId} must keep the '<id> - <name>' shape`)
      assert.equal(isRegularLadder(ids), true, `${set.fieldId} ids must be a ladder`)
    }
  }

  // The rehearsal pack's 交接工段 legacy bucket: id inside the live range, position at the tail.
  // That is the edge case the pack pipeline's authored-order guarantee is tested against, so it is
  // asserted here rather than left to survive by luck through a renumbering.
  const handover = FACTORY_A_REHEARSAL_PACK.optionSets.find((set) => set.fieldId === 'ext_handoverSection')
  const handoverIds = handover.options.map((option) => Number(ID_NAME_LITERAL.exec(`'${option.value}'`)[1]))
  const last = handoverIds[handoverIds.length - 1]
  assert.ok(
    last > Math.min(...handoverIds) && last < Math.max(...handoverIds),
    'the legacy bucket must sit LAST in the array with an id INSIDE the live range',
  )
  assert.notDeepEqual(
    handoverIds,
    [...handoverIds].sort((a, b) => a - b),
    'authored order must differ from id order, or the stable-sort guarantee is untested',
  )
}

function main() {
  detectorControls()
  theFixturesStillCarryDictionaries()
  const scanned = committedFixturesCarryNoExportedCatalogue()
  console.log(
    `✓ customer-dictionary-leak-guard: ${scanned} source files scanned, ` +
      `no committed id→name catalogue with exported-key spacing`,
  )
}

main()
