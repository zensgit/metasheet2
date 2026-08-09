#!/usr/bin/env node
// #4556 W4C-0 Stage D — §8.4 "source, effect, and result mechanical bypass guard" collector gate.
//
// Explicit whole-file CI step (see .github/workflows/plugin-tests.yml): this is a node:test
// (.test.mjs) file, not a vitest spec, so it is invisible to both `pnpm --filter core-backend
// test` and vitest.config.ts's exclude list — it must be named explicitly in CI or it silently
// never runs (feedback_plugin_integration_core_tests_not_in_ci).

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const toolDir = path.join(rootDir, 'scripts/attendance/w4c0-dml-inventory')

const { createWorktreeSource, createGitRefSource } = require(path.join(toolDir, 'sources.cjs'))
const {
  buildRawCensus,
  buildP25CallPathCensus,
  buildAttendanceRecordReadCensus,
  buildAttendanceCalculationReadCensus,
  classifyCensus,
  scanFileForDmlSites,
  scanFileForP25CallPathSites,
  scanFileForAttendanceRecordReadSites,
  scanFileForAttendanceCalculationReadSites,
  isCanonicalBoundaryPath,
  contentHashOfKeys,
  maskCommentsForDmlScan,
  hasLiveDmlOnTable,
  discoverRuntimeRoots,
  parseWorkspacePatterns,
  isScannablePath,
  isAttendanceOwnedCandidate,
  resolveTableIdentifier,
} = require(
  path.join(toolDir, 'collector.cjs'),
)
const { classifyTrackedSites } = require(path.join(toolDir, 'classify-tracked-sites.cjs'))
const { CURATED_DEBT_ENTRIES } = require(path.join(toolDir, 'curated-debt-entries.cjs'))
const { APPROVED_SITE_IDENTITY_BY_KEY } = require(path.join(toolDir, 'approved-site-identities.cjs'))
const {
  PINNED_BASELINE_REF,
  PINNED_BASELINE_ARTIFACT_RELPATH,
  provePinnedBaselineObligation,
} = require(path.join(toolDir, 'pinned-baseline-obligation.cjs'))
const {
  P25_CALL_PATH_CLASSIFICATIONS,
  classifyP25CallPathSites,
} = require(path.join(toolDir, 'p25-call-path-classification.cjs'))
const {
  classifyAttendanceRecordReadSites,
} = require(path.join(toolDir, 'current-record-read-classification.cjs'))
const {
  classifyAttendanceCalculationReadSites,
} = require(path.join(toolDir, 'calculation-read-classification.cjs'))
const {
  assertP26ActionAndFixtureContract,
  classifyP26ApprovalAssignmentSites,
  keyOf: p26KeyOf,
} = require(path.join(toolDir, 'p26-approval-assignment-classification.cjs'))
const {
  TABLE_BUCKETS,
  P25_FORBIDDEN_AUTHORITY_ROLES,
  P25_IMPORT_INTEGRATION_TABLES,
  P25_OPERATIONAL_TABLE_SPECS,
  classifyP25Use,
  assertP25Use,
} = require(path.join(toolDir, 'table-classification.cjs'))

const PINNED_REF = PINNED_BASELINE_REF
const BASELINE_ARTIFACT_RELPATH = PINNED_BASELINE_ARTIFACT_RELPATH
const WORKFLOW_PATH = path.join(rootDir, '.github/workflows/plugin-tests.yml')
const THIS_TEST_FILENAME = 'attendance-w4c0-dml-inventory-collector.test.mjs'

function readWorkflow() {
  return fs.readFileSync(WORKFLOW_PATH, 'utf8')
}

// -------------------------------------------------------------------------------------------
// 1. Exact-head HEAD scan: every business/schedule_fact/shared_hook site must resolve to an
//    APPROVED SITE IDENTITY — an exact (relPath, enclosingSymbol, table, verb) tuple occurring
//    the exact pinned number of times — every attendance-owned table must be classified, and
//    every w4_canonical-table site must be inside the canonical boundary. This is the actual
//    §8.4 CI gate against the real repository.
//
//    The `missing` leg doubles as the NON-EMPTY-DOMAIN leg: it is computed by walking the frozen
//    identity table, not the census, so a scanner that returns nothing (broken root discovery,
//    an over-eager exclusion, a regex that stops matching) puts all 181 pinned identities into
//    `missing` and reds — this gate cannot pass vacuously against an empty tree.
// -------------------------------------------------------------------------------------------
test('exact-head HEAD scan: zero new/unclassified/out-of-boundary attendance DML', () => {
  const source = createWorktreeSource(rootDir)
  const { sites } = buildRawCensus(source)
  const classified = classifyCensus(sites)
  const result = classifyTrackedSites(classified.trackedSites)
  const { unclaimed, overCount, missing } = result

  // Counts printed for the CI step log: a green tick is not evidence of what was measured.
  console.log(
    `[w4c0-dml-inventory] raw census sites=${sites.length} tracked=${result.trackedSiteCount}`
    + ` observedIdentities=${result.observedIdentityCount} approvedIdentities=${result.approvedIdentityCount}`
    + ` unclaimed=${unclaimed.length} overCount=${overCount.length} missing=${missing.length}`
    + ` genericShared=${result.genericAllowlisted.length}`
    + ` unclassifiedTables=${classified.unclassifiedTableSites.length}`
    + ` outsideBoundary=${classified.outsideBoundarySites.length}`,
  )

  assert.deepEqual(
    unclaimed.map((s) => `${s.relPath} :: ${s.enclosingSymbol} :: ${s.table}:${s.verb}`),
    [],
    'every business/schedule_fact/shared_hook DML site must be an approved site identity — a new table, verb, or symbol inside an already-approved file has no claim',
  )
  assert.deepEqual(
    overCount.map((d) => `${d.identity} pinned=${d.pinned} observed=${d.observed}`),
    [],
    'an approved site identity may occur exactly its pinned number of times — a SECOND write at the same file/symbol/table/verb is new debt',
  )
  assert.deepEqual(
    missing.map((d) => `${d.identity} pinned=${d.pinned} observed=${d.observed}`),
    [],
    'a pinned identity that no longer occurs is a stale approval (and an empty census reds here, so the gate has a non-empty domain)',
  )
  assert.deepEqual(
    classified.unclassifiedTableSites.map((s) => `${s.relPath} :: ${s.table}`),
    [],
    'every attendance-owned table hit must be classified in table-classification.cjs',
  )
  assert.deepEqual(
    classified.outsideBoundarySites.map((s) => `${s.relPath} :: ${s.table}`),
    [],
    'w4_canonical-bucket tables may only be written from the canonical adapter path prefix',
  )
})

// -------------------------------------------------------------------------------------------
// 1b. The owner's escape, as a permanent regression probe.
//
//     BASE BEHAVIOUR (origin/main before this conversion): adding `INSERT INTO
//     attendance_records` to packages/core-backend/src/services/AfterSalesApprovalBridgeService.ts
//     — a file approved WHOLE by GENERIC_SHARED_ALLOWLIST — left the exact-head HEAD scan GREEN.
//     Removing only that file's allowlist entry made it fail, proving the file name, not the
//     write, was doing the work.
//
//     These probes do NOT hand-construct site objects. Each one reads the REAL approved file,
//     splices SQL text into it in memory, RE-SCANS that file with the real scanner, and swaps the
//     rescan into the real census. So the scanner, the nearest-preceding-symbol attribution, the
//     bucket classifier and the identity lookup are all exercised exactly as they are in CI — a
//     hand-built tuple could accidentally assert an identity the scanner would never produce.
//     Each probe also asserts WHICH leg reds and that the others stay clean: a probe that reds
//     for the wrong reason proves nothing.
// -------------------------------------------------------------------------------------------
function currentTrackedSites() {
  const source = createWorktreeSource(rootDir)
  const { sites } = buildRawCensus(source)
  return classifyCensus(sites).trackedSites
}

/**
 * Real-file mutation probe: rescan `relPath` with mutated content and splice the result into the
 * live census. Asserts the mutation actually changed the file text and actually changed the
 * scanned site set — an ineffective mutation and a useless test look identical otherwise.
 */
function censusWithMutatedFile(relPath, mutate) {
  const tracked = currentTrackedSites()
  const original = fs.readFileSync(path.join(rootDir, relPath), 'utf8')
  const mutated = mutate(original)
  assert.notEqual(mutated, original, 'probe mutation must actually change the file content')

  const before = classifyCensus(scanFileForDmlSites(relPath, original)).trackedSites
  const after = classifyCensus(scanFileForDmlSites(relPath, mutated)).trackedSites
  assert.notEqual(
    after.length,
    before.length,
    'probe mutation must actually change the scanned DML site set for this file',
  )
  assert.ok(before.length > 0, 'precondition: the probed file really is an approved DML writer')
  return [...tracked.filter((site) => site.relPath !== relPath), ...after]
}

const AFTER_SALES_BRIDGE = 'packages/core-backend/src/services/AfterSalesApprovalBridgeService.ts'
const APPROVAL_PRODUCT_SERVICE = 'packages/core-backend/src/services/ApprovalProductService.ts'
const AFTER_SALES_TXN_ANCHOR = `    await this.runInTransaction(async (trx) => {
      await trx.query(
        \`INSERT INTO approval_instances`

function spliceAfterSalesTransaction(insertedStatements) {
  return (original) => {
    assert.equal(
      original.split(AFTER_SALES_TXN_ANCHOR).length - 1,
      1,
      'probe anchor must match exactly once — if the bridge was refactored, re-derive the probe',
    )
    return original.replace(
      AFTER_SALES_TXN_ANCHOR,
      `    await this.runInTransaction(async (trx) => {\n${insertedStatements}      await trx.query(\n        \`INSERT INTO approval_instances`,
    )
  }
}

test("owner escape probe: a new table inside a whole-file-approved file is unclaimed, not admitted by the file's name", () => {
  assert.deepEqual(
    classifyTrackedSites(currentTrackedSites()).unclaimed,
    [],
    'precondition: the untouched tree is clean',
  )

  // Verbatim shape of the owner's escape: an attendance_records INSERT added to the generic
  // after-sales approval bridge, which GENERIC_SHARED_ALLOWLIST used to approve by file path.
  const census = censusWithMutatedFile(
    AFTER_SALES_BRIDGE,
    spliceAfterSalesTransaction(
      '      await trx.query(\n'
      + '        `INSERT INTO attendance_records (id, org_id, user_id, work_date, status)\n'
      + "         VALUES ($1, $2, $3, $4, 'normal')`,\n"
      + '        [approvalId, command.sourceSystem, command.businessKey, command.title],\n'
      + '      )\n',
    ),
  )
  const result = classifyTrackedSites(census)
  assert.deepEqual(
    result.unclaimed.map((s) => `${s.relPath} :: ${s.enclosingSymbol} :: ${s.table}:${s.verb}`),
    [`${AFTER_SALES_BRIDGE} :: normalizeCommand :: attendance_records:insert`],
    'the owner escape must red by NAME in the unclaimed leg',
  )
  assert.deepEqual(result.overCount, [], 'the escape is a new identity, not a multiplicity drift')
  assert.deepEqual(result.missing, [], 'the escape must not disturb any pinned identity')
})

test('owner escape probe: a new VERB on an already-approved file/symbol/table is unclaimed', () => {
  // approval_instances IS approved at this file+symbol — but only for `insert`.
  const census = censusWithMutatedFile(
    AFTER_SALES_BRIDGE,
    spliceAfterSalesTransaction(
      '      await trx.query(`DELETE FROM approval_instances WHERE business_key = $1`, [command.businessKey])\n',
    ),
  )
  const result = classifyTrackedSites(census)
  assert.deepEqual(
    result.unclaimed.map((s) => `${s.relPath} :: ${s.enclosingSymbol} :: ${s.table}:${s.verb}`),
    [`${AFTER_SALES_BRIDGE} :: normalizeCommand :: approval_instances:delete`],
    'approval is per (file, symbol, table, VERB) — an approved table does not carry a new verb',
  )
  assert.deepEqual(result.overCount, [])
  assert.deepEqual(result.missing, [])
})

test('owner escape probe: a new SYMBOL inside the whole-file-approved ApprovalProductService is unclaimed', () => {
  // P26 used to claim this file by startsWith(), so every present and FUTURE symbol in it was
  // approved — including one writing attendance_records from an approval service.
  const census = censusWithMutatedFile(
    APPROVAL_PRODUCT_SERVICE,
    (original) => `${original}
async function quietlyAddedAssignmentWriter(client, instanceId) {
  await client.query(\`UPDATE approval_assignments SET is_active = FALSE WHERE instance_id = $1\`, [instanceId])
  await client.query(\`INSERT INTO attendance_records (id) VALUES ($1)\`, [instanceId])
}
`,
  )
  const result = classifyTrackedSites(census)
  assert.deepEqual(
    result.unclaimed.map((s) => `${s.relPath} :: ${s.enclosingSymbol} :: ${s.table}:${s.verb}`),
    [
      `${APPROVAL_PRODUCT_SERVICE} :: quietlyAddedAssignmentWriter :: approval_assignments:update`,
      `${APPROVAL_PRODUCT_SERVICE} :: quietlyAddedAssignmentWriter :: attendance_records:insert`,
    ],
    'a whole-file path-prefix claim would have admitted both of these; exact identity does not',
  )
  assert.deepEqual(result.overCount, [])
  assert.deepEqual(result.missing, [])
})

test('multiplicity probe: a SECOND occurrence of an already-approved identity reds in overCount, not unclaimed', () => {
  // Duplicate an EXISTING approved write in place: same file, same enclosing symbol, same table,
  // same verb. Nothing about the tuple changes — only how many times it occurs. This is the ONLY
  // probe that exercises count pinning; if it reddened via `unclaimed` (because the scanner
  // attributed the copy to a different symbol) it would prove nothing about multiplicity, which
  // is why `unclaimed` is asserted empty FIRST.
  const census = censusWithMutatedFile(
    AFTER_SALES_BRIDGE,
    spliceAfterSalesTransaction(
      '      await trx.query(\n'
      + '        `INSERT INTO approval_instances (id, status, workflow_key)\n'
      + "         VALUES ($1, 'pending', $2)`,\n"
      + '        [approvalId, REFUND_WORKFLOW_KEY],\n'
      + '      )\n',
    ),
  )
  const result = classifyTrackedSites(census)

  assert.deepEqual(
    result.unclaimed,
    [],
    'the duplicate is the SAME identity — it must not red as unclaimed, or this probe never touched multiplicity',
  )
  assert.deepEqual(
    result.overCount.map((d) => `${d.identity} pinned=${d.pinned} observed=${d.observed}`),
    [`${AFTER_SALES_BRIDGE} :: normalizeCommand :: approval_instances:insert pinned=1 observed=2`],
    'an extra write at an already-approved (file, symbol, table, verb) must red by name with pinned vs observed counts',
  )
  assert.deepEqual(result.missing, [])
})

test('multiplicity probe: a REMOVED occurrence of a pinned identity reds in missing (stale approval / empty-domain leg)', () => {
  // Retarget the real approved write to a non-attendance table, so its pinned identity no longer
  // occurs. A stale approval left standing would silently re-admit a future re-add at that exact
  // coordinate, which is how a retired writer becomes a permanent hole.
  const census = censusWithMutatedFile(AFTER_SALES_BRIDGE, (original) => {
    assert.equal(
      original.split('`INSERT INTO approval_instances').length - 1,
      1,
      'probe anchor must match exactly once',
    )
    return original.replace('`INSERT INTO approval_instances', '`INSERT INTO unrelated_product_rows')
  })
  const result = classifyTrackedSites(census)
  assert.deepEqual(result.overCount, [])
  assert.deepEqual(result.unclaimed, [], 'the retargeted table is out of attendance scope, so only the stale leg may red')
  assert.deepEqual(
    result.missing.map((d) => `${d.identity} pinned=${d.pinned} observed=${d.observed}`),
    [`${AFTER_SALES_BRIDGE} :: normalizeCommand :: approval_instances:insert pinned=1 observed=0`],
    'a pinned approval that no longer matches a real write must be retired explicitly, not left to re-admit a future re-add',
  )

  // Non-empty-domain leg, mechanically: an empty census puts EVERY pinned identity in `missing`,
  // so a scanner that silently stops producing sites cannot make this gate pass against nothing.
  const empty = classifyTrackedSites([])
  assert.equal(empty.missing.length, empty.approvedIdentityCount)
  assert.equal(empty.overCount.length, 0)
  assert.ok(empty.approvedIdentityCount > 0, 'the approved-identity domain must be non-empty')
})

// -------------------------------------------------------------------------------------------
// 1c. Two escapes that defeated this gate BEFORE the identity table was ever consulted.
//
//     Both were found by adversarial review of the identity conversion, and neither is a defect
//     of the identity scheme — they are upstream of it, which is precisely why they mattered:
//     the conversion's headline promise ("a new INSERT INTO attendance_records in an
//     already-approved file can no longer land silently") held for exactly one spelling.
//
//       P1  TABLE-IDENTIFIER CASE. `INSERT INTO ATTENDANCE_RECORDS` DID mint a raw census site —
//           the keywords are uppercase, so the case-sensitive pattern matched — and was then
//           dropped by a case-SENSITIVE ownership test, before classifyTable. Not tracked, not
//           unclaimed, not unclassified: silent. In PostgreSQL an unquoted identifier folds to
//           lower case, so it named the same relation as the approved lowercase site.
//           Signature: `raw` MOVES, `tracked` does not.
//
//       P2  CENSUS DOMAIN. `plugins/plugin-after-sales` matches the `plugins/*` workspace pattern
//           but ships no package.json, and root promotion required one — so a live product plugin
//           in this very after-sales approval domain was scanned by nothing.
//           Signature: `raw` does NOT move, because the file is never opened.
//
//     The probes below are frozen must-red rows for both, and they assert the SIGNATURE, not just
//     redness: each one requires the raw census to grow by exactly one site, which is what
//     separates "the scanner saw it and the classifier judged it" from "the file was never read".
// -------------------------------------------------------------------------------------------
let cachedBaselineCensus = null
function baselineCensus() {
  if (cachedBaselineCensus === null) {
    const source = createWorktreeSource(rootDir)
    const { sites, roots } = buildRawCensus(source)
    const classified = classifyCensus(sites)
    cachedBaselineCensus = { sites, roots, classified, result: classifyTrackedSites(classified.trackedSites) }
  }
  return cachedBaselineCensus
}

/**
 * Whole-pipeline probe. `censusWithMutatedFile` above rescans ONE file and splices the result into
 * the live census, which is enough to exercise classification — but it assumes the file is in the
 * scan domain, so it can never detect a domain hole. This helper instead runs the REAL
 * `buildRawCensus` over a source whose `readFile` returns mutated content for exactly one path, so
 * root discovery and the directory walk are exercised too. That is what makes the
 * `plugins/plugin-after-sales` row below a domain proof rather than a classification proof.
 */
function fullCensusWithMutatedSource(relPath, mutate) {
  const base = createWorktreeSource(rootDir)
  const original = base.readFile(relPath)
  assert.ok(original != null, `probe target must exist: ${relPath}`)
  const mutated = mutate(original)
  assert.notEqual(mutated, original, 'probe mutation must actually change the file content')
  const source = {
    readFile: (probePath) => (probePath === relPath ? mutated : base.readFile(probePath)),
    listDir: (dir) => base.listDir(dir),
    listAllFiles: (dir) => base.listAllFiles(dir),
  }
  const { sites, roots } = buildRawCensus(source)
  const classified = classifyCensus(sites)
  return { sites, roots, classified, result: classifyTrackedSites(classified.trackedSites) }
}

function unclaimedLabels(result) {
  return result.unclaimed.map((s) => `${s.relPath} :: ${s.enclosingSymbol} :: ${s.table}:${s.verb}`)
}

function countLabels(rows) {
  return rows.map((d) => `${d.identity} pinned=${d.pinned} observed=${d.observed}`)
}

test('PostgreSQL identifier folding: the resolver states which reading applies to each token shape', () => {
  // The two axes are different SQL, not different strictness settings:
  //   unquoted  -> PostgreSQL folds to lower case  -> the SAME relation
  //   quoted    -> PostgreSQL preserves the spelling -> a DIFFERENT relation
  assert.deepEqual(resolveTableIdentifier('attendance_records'), { table: 'attendance_records', quoted: false })
  assert.deepEqual(resolveTableIdentifier('ATTENDANCE_RECORDS'), { table: 'attendance_records', quoted: false })
  assert.deepEqual(resolveTableIdentifier('Attendance_Records'), { table: 'attendance_records', quoted: false })
  assert.deepEqual(resolveTableIdentifier('"attendance_records"'), { table: 'attendance_records', quoted: true })
  assert.deepEqual(resolveTableIdentifier('"Attendance_Records"'), { table: 'Attendance_Records', quoted: true })
  assert.deepEqual(resolveTableIdentifier('"ATTENDANCE_RECORDS"'), { table: 'ATTENDANCE_RECORDS', quoted: true })
  // Asymmetric quoting is not a quoted identifier in any dialect. Fold it — the WIDER of the two
  // readings, so an evasion cannot be built out of a stray quote.
  assert.deepEqual(resolveTableIdentifier('"Attendance_Records'), { table: 'attendance_records', quoted: false })
  assert.deepEqual(resolveTableIdentifier('Attendance_Records"'), { table: 'attendance_records', quoted: false })
})

test('attendance ownership is case-insensitive on the WRITE census, as it always was on the read legs', () => {
  // Before the fix this predicate was exact-match, while P25_READ_TABLE_PATTERN,
  // ATTENDANCE_RECORD_READ_PATTERN and ATTENDANCE_CALCULATION_READ_PATTERN all carried `gi`.
  // The write census was the only leg in the file without case-insensitive table matching.
  for (const name of [
    'attendance_records', 'ATTENDANCE_RECORDS', 'Attendance_Records',
    'approval_instances', 'APPROVAL_INSTANCES', 'Approval_Records', 'APPROVAL_ASSIGNMENTS',
  ]) {
    assert.equal(isAttendanceOwnedCandidate(name), true, `${name} must be in attendance scope`)
  }
  // Negative control: the predicate widened on CASE only. It must not have widened on name.
  for (const name of [
    'approval_workflows', 'APPROVAL_WORKFLOWS', 'users', 'plugin_after_sales_template_installs',
    'attendance', 'attendancerecords',
  ]) {
    assert.equal(isAttendanceOwnedCandidate(name), false, `${name} must stay out of attendance scope`)
  }
})

// Frozen must-red rows for P1. Every one of these was GREEN before the fix, with the raw census
// moving 1220 -> 1221 while every counter stayed at zero.
const IDENTIFIER_CASE_MUST_RED_ROWS = [
  {
    name: 'uppercase table identifier',
    sql: '      await trx.query(`INSERT INTO ATTENDANCE_RECORDS (id) VALUES ($1)`, [approvalId])\n',
    unclaimed: [`${AFTER_SALES_BRIDGE} :: normalizeCommand :: attendance_records:insert`],
  },
  {
    name: 'mixed-case table identifier',
    sql: '      await trx.query(`INSERT INTO Attendance_Records (id) VALUES ($1)`, [approvalId])\n',
    unclaimed: [`${AFTER_SALES_BRIDGE} :: normalizeCommand :: attendance_records:insert`],
  },
  {
    name: 'uppercase verb AND uppercase table together',
    sql: "      await trx.query(`UPDATE ATTENDANCE_RECORDS SET status = 'void' WHERE id = $1`, [approvalId])\n",
    unclaimed: [`${AFTER_SALES_BRIDGE} :: normalizeCommand :: attendance_records:update`],
  },
  {
    name: 'schema-qualified uppercase table',
    sql: '      await trx.query(`INSERT INTO public.ATTENDANCE_RECORDS (id) VALUES ($1)`, [approvalId])\n',
    unclaimed: [`${AFTER_SALES_BRIDGE} :: normalizeCommand :: attendance_records:insert`],
  },
  {
    name: 'uppercase SHARED approval table (covers all of SHARED_TABLE_NAMES)',
    sql: '      await trx.query(`DELETE FROM APPROVAL_ASSIGNMENTS WHERE instance_id = $1`, [approvalId])\n',
    unclaimed: [`${AFTER_SALES_BRIDGE} :: normalizeCommand :: approval_assignments:delete`],
  },
]

test('frozen must-red: an attendance table written in ANY unquoted case is the same relation and reds by name', () => {
  for (const row of IDENTIFIER_CASE_MUST_RED_ROWS) {
    const probe = fullCensusWithMutatedSource(AFTER_SALES_BRIDGE, spliceAfterSalesTransaction(row.sql))
    // The P1 signature, asserted rather than assumed: the scanner DID see the write. If this
    // equality ever fails the probe has stopped testing case and started testing something else.
    assert.equal(
      probe.sites.length,
      baselineCensus().sites.length + 1,
      `${row.name}: the raw census must grow by exactly one site — the scanner sees the write, the question is only what the ownership test then does with it`,
    )
    assert.deepEqual(unclaimedLabels(probe.result), row.unclaimed, `${row.name}: must red in unclaimed, folded onto its real lowercase relation`)
    assert.deepEqual(probe.result.overCount, [], `${row.name}: no pinned identity may be disturbed`)
    assert.deepEqual(probe.result.missing, [], `${row.name}: no pinned identity may be disturbed`)
    assert.deepEqual(
      probe.classified.unclassifiedTableSites,
      [],
      `${row.name}: an UNQUOTED identifier folds to a real registered table, so it must land in its bucket and red by identity — not fall out as unclassified`,
    )
  }
})

test('frozen must-red: an UPPERCASE spelling of an APPROVED write is the SAME identity — it reds on multiplicity, not as a new site', () => {
  // This is the row that distinguishes the implemented reading from the crude alternative
  // ("anything non-lowercase becomes an unclassified table"). Under the crude variant an
  // uppercase spelling of an approved write would red in `unclassifiedTables`, and the collector
  // would be asserting that ATTENDANCE_RECORDS is a table it has never heard of — which is false.
  // Under PostgreSQL folding it must resolve onto the very identity that is already pinned, and
  // therefore red as observed=2 against pinned=1, minting NO new identity.
  const probe = fullCensusWithMutatedSource(
    AFTER_SALES_BRIDGE,
    spliceAfterSalesTransaction(
      '      await trx.query(\n'
      + '        `INSERT INTO APPROVAL_INSTANCES (id, status, workflow_key)\n'
      + "         VALUES ($1, 'pending', $2)`,\n"
      + '        [approvalId, REFUND_WORKFLOW_KEY],\n'
      + '      )\n',
    ),
  )
  assert.equal(probe.sites.length, baselineCensus().sites.length + 1)
  assert.deepEqual(
    probe.result.unclaimed,
    [],
    'an uppercase spelling of an approved write must NOT mint a new identity — if it does, the fold is not mapping onto the same relation',
  )
  assert.equal(
    probe.result.observedIdentityCount,
    baselineCensus().result.observedIdentityCount,
    'the identity COUNT must be unchanged: the uppercase write is the same tuple, occurring twice',
  )
  assert.deepEqual(
    countLabels(probe.result.overCount),
    [`${AFTER_SALES_BRIDGE} :: normalizeCommand :: approval_instances:insert pinned=1 observed=2`],
    'the uppercase duplicate must red on multiplicity against the identity it actually names',
  )
  assert.deepEqual(probe.classified.unclassifiedTableSites, [])
  assert.deepEqual(probe.result.missing, [])
})

test('frozen must-red: a QUOTED mixed-case identifier is a DIFFERENT relation — unclassified, and never silently dropped', () => {
  // PostgreSQL does not fold a double-quoted identifier, so `"Attendance_Records"` is NOT
  // `attendance_records` and must not be admitted as it. It is still one shift key away from an
  // attendance table, so it must not be dropped in silence either — the union ownership test pulls
  // it into scope and `classifyTable` (whose registry holds only the real, lowercase tables) then
  // reds it as an unclassified attendance-owned table. Both halves of that are asserted here.
  const probe = fullCensusWithMutatedSource(
    AFTER_SALES_BRIDGE,
    spliceAfterSalesTransaction(
      '      await trx.query(`INSERT INTO "Attendance_Records" (id) VALUES ($1)`, [approvalId])\n',
    ),
  )
  assert.equal(probe.sites.length, baselineCensus().sites.length + 1)
  assert.deepEqual(
    probe.classified.unclassifiedTableSites.map((s) => `${s.relPath} :: ${s.table}`),
    [`${AFTER_SALES_BRIDGE} :: Attendance_Records`],
    'a quoted mixed-case attendance lookalike must red as an unclassified attendance-owned table',
  )
  assert.deepEqual(
    probe.result.unclaimed,
    [],
    'it must NOT be folded into attendance_records — that would be the wrong PostgreSQL reading, and would let a quoted identifier inherit a lowercase table approval',
  )
  assert.deepEqual(probe.result.overCount, [])
  assert.deepEqual(probe.result.missing, [])

  // Control: a quoted identifier that is ALREADY lowercase names the ordinary relation, so it must
  // keep classifying normally. Quoting is not itself suspicious.
  const quotedLower = scanFileForDmlSites(
    'probe.cjs',
    'async function q() { await db.query(`INSERT INTO "attendance_records" (id) VALUES ($1)`) }',
  )
  assert.deepEqual([quotedLower.length, quotedLower[0]?.table], [1, 'attendance_records'])
})

// --- P2: the census domain -------------------------------------------------------------------

const AFTER_SALES_PLUGIN_DIR = 'plugins/plugin-after-sales'
const AFTER_SALES_PLUGIN_MODULE = `${AFTER_SALES_PLUGIN_DIR}/lib/refund-approval.cjs`

test('census domain: every workspace-manifest directory is a scan root, with no marker-file escape', () => {
  const source = createWorktreeSource(rootDir)
  const roots = discoverRuntimeRoots(source)

  // Expectation DERIVED from the manifest, not a copied list: expand pnpm-workspace.yaml here and
  // require the root set to be exactly that, plus the named extra roots. Any marker-file rule
  // (package.json, plugin.json, or the next one someone invents) fails this by construction —
  // which is the point. Membership must come from the manifest, not from an incidental file.
  const patterns = parseWorkspacePatterns(fs.readFileSync(path.join(rootDir, 'pnpm-workspace.yaml'), 'utf8'))
  const expected = new Set(['scripts'])
  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) {
      const base = pattern.slice(0, -2)
      for (const entry of fs.readdirSync(path.join(rootDir, base), { withFileTypes: true })) {
        if (entry.isDirectory()) expected.add(`${base}/${entry.name}`)
      }
    } else {
      expected.add(pattern)
    }
  }
  assert.ok(expected.size > 1, 'precondition: the manifest expansion must be non-empty')
  assert.deepEqual(roots, [...expected].sort(), 'the scan domain is exactly the workspace manifest plus the named extra roots')

  // Frozen by name: the directory the marker-file rule lost. It is a live product plugin —
  // plugin.json manifestVersion 2.0.0, an 850-line index.cjs, a contributed route, 13 lib modules.
  assert.ok(roots.includes(AFTER_SALES_PLUGIN_DIR), `${AFTER_SALES_PLUGIN_DIR} must be a scan root`)
  // Non-vacuity: if someone later adds a package.json to this plugin, the old rule would have
  // covered it too and this row would silently stop exercising the escape. Say so out loud.
  assert.equal(
    fs.existsSync(path.join(rootDir, AFTER_SALES_PLUGIN_DIR, 'package.json')),
    false,
    'precondition: this plugin still has no package.json, so it still exercises the marker-file escape — if that changes, pick another manifest directory without one',
  )
  assert.equal(
    fs.existsSync(path.join(rootDir, AFTER_SALES_PLUGIN_DIR, 'plugin.json')),
    true,
    'precondition: this plugin really is product code',
  )
})

test('frozen must-red: attendance DML inside plugins/plugin-after-sales is inside the census domain and reds', () => {
  const source = createWorktreeSource(rootDir)
  // Walk the chain rather than assuming it: extension, exclusion rules, and the directory walk.
  assert.equal(isScannablePath(AFTER_SALES_PLUGIN_MODULE), true, 'the module must be a scannable path')
  assert.ok(
    source.listAllFiles(AFTER_SALES_PLUGIN_DIR).includes(AFTER_SALES_PLUGIN_MODULE),
    'the directory walk must actually reach the module',
  )
  assert.deepEqual(
    scanFileForDmlSites(AFTER_SALES_PLUGIN_MODULE, source.readFile(AFTER_SALES_PLUGIN_MODULE)),
    [],
    'precondition: this module writes no DML today, so the probe below contributes the only site and the +1 assertion is exact',
  )

  const probe = fullCensusWithMutatedSource(AFTER_SALES_PLUGIN_MODULE, (original) => `${original}
async function quietlyWriteAttendance(client, recordId) {
  await client.query(\`INSERT INTO attendance_records (id) VALUES ($1)\`, [recordId])
}
`)
  // The P2 signature, and the discriminator against P1: under the old rule the raw census did NOT
  // move at all here, because the file was never opened. Redness alone would not have shown that.
  assert.equal(
    probe.sites.length,
    baselineCensus().sites.length + 1,
    'the raw census must grow — an unscanned directory contributes nothing, which is exactly how this escape hid',
  )
  assert.deepEqual(
    unclaimedLabels(probe.result),
    [`${AFTER_SALES_PLUGIN_MODULE} :: quietlyWriteAttendance :: attendance_records:insert`],
    'an attendance write from the after-sales plugin must red by name',
  )
  assert.deepEqual(probe.result.overCount, [])
  assert.deepEqual(probe.result.missing, [])
})

test('approval carries no file, prefix, or bare-symbol shape: every entry claim is exact-identity membership', () => {
  // Attack the criterion itself. If any entry still approved by file or prefix, a synthetic site
  // with that file but a nonsense symbol/table/verb would be claimed by it.
  for (const entry of CURATED_DEBT_ENTRIES) {
    for (const relPath of [
      'packages/core-backend/src/routes/approvals.ts',
      'packages/core-backend/src/services/ApprovalProductService.ts',
      'packages/core-backend/src/services/ApprovalBridgeService.ts',
      'packages/core-backend/src/services/AfterSalesApprovalBridgeService.ts',
      'packages/core-backend/src/services/AttendanceExpiryService.ts',
      'packages/core-backend/src/attendance/w4c3a-legacy-plan-record-effects.ts',
      'packages/core-backend/src/attendance/w4c3a-canonical-import-kernel.ts',
      'packages/core-backend/src/attendance/w4c3a-sync-import-host.ts',
      'packages/core-backend/src/attendance/w4c3b-approved-leave-cancellation.ts',
      'plugins/plugin-attendance/index.cjs',
    ]) {
      assert.equal(
        entry.claims({
          relPath,
          enclosingSymbol: '__synthetic_unapproved_symbol__',
          table: 'attendance_records',
          verb: 'insert',
          line: 1,
        }),
        false,
        `${entry.id} must not claim an unapproved symbol merely because it is in ${relPath}`,
      )
    }
    // ...and the file's own approved symbols must not carry a different table or verb.
    for (const row of APPROVED_SITE_IDENTITY_BY_KEY.values()) {
      if (!(row.entryIds || []).includes(entry.id)) continue
      assert.equal(
        entry.claims({ ...row, table: '__synthetic_unapproved_table__' }),
        false,
        `${entry.id} must not claim a new table under its approved symbol ${row.enclosingSymbol}`,
      )
      assert.equal(
        entry.claims({ ...row, verb: 'truncate' }),
        false,
        `${entry.id} must not claim a new verb under its approved symbol ${row.enclosingSymbol}`,
      )
      assert.equal(entry.claims(row), true, `${entry.id} must still claim its own approved identity`)
    }
  }
})

test('the identity table itself is well-formed: exact keys, no duplicates, one disposition, known owners', () => {
  const rows = [...APPROVED_SITE_IDENTITY_BY_KEY.values()]
  assert.ok(rows.length > 0)
  const knownIds = new Set(CURATED_DEBT_ENTRIES.map((entry) => entry.id))
  const seen = new Set()
  for (const row of rows) {
    const key = JSON.stringify([row.relPath, row.enclosingSymbol, row.table, row.verb])
    assert.equal(seen.has(key), false, `duplicate approved identity: ${key}`)
    seen.add(key)
    assert.ok(Number.isInteger(row.occurrences) && row.occurrences >= 1, `bad multiplicity on ${key}`)
    const owned = (row.entryIds || []).length > 0
    const generic = typeof row.genericSharedReason === 'string' && row.genericSharedReason.length > 0
    assert.notEqual(owned, generic, `exactly one disposition required on ${key}`)
    for (const id of row.entryIds || []) {
      assert.ok(knownIds.has(id), `approved identity ${key} names unknown debt id ${id}`)
    }
  }
  console.log(
    `[w4c0-dml-inventory] approved identities=${rows.length}`
    + ` pinnedOccurrences=${rows.reduce((n, r) => n + r.occurrences, 0)}`
    + ` repeated=${rows.filter((r) => r.occurrences > 1).length}`
    + ` genericShared=${rows.filter((r) => r.genericSharedReason).length}`,
  )
})

test('W4C-3a: generated SELECT inventory classifies every attendance-record read', () => {
  const source = createWorktreeSource(rootDir)
  const { sites } = buildAttendanceRecordReadCensus(source)
  const result = classifyAttendanceRecordReadSites(sites)

  assert.ok(sites.some((site) => site.table === 'attendance_current_records'))
  assert.ok(sites.some((site) => site.table === 'attendance_records'))
  assert.deepEqual(
    result.unclassified.map((site) => `${site.relPath} :: ${site.enclosingSymbol}`),
    [],
    'a direct ordinary attendance_records read must be classified or moved to the current view',
  )
  assert.deepEqual(result.countDrift, [], 'an added base-table read in a known wrapper needs explicit review')
  assert.deepEqual(result.stale, [], 'removed base-table reads must retire their historical classification')
  assert.equal(result.classifiedSites.length, sites.length)
})

test('W4C-3a SELECT-inventory mutation: a new direct ordinary base read fails while the current view passes', () => {
  const relPath = 'plugins/plugin-attendance/index.cjs'
  const direct = scanFileForAttendanceRecordReadSites(
    relPath,
    "async function newOrdinarySummary() { return db.query(`SELECT * FROM\n attendance_records`) }\n",
  )
  const current = scanFileForAttendanceRecordReadSites(
    relPath,
    "async function newOrdinarySummary() { return db.query(`SELECT * FROM\n attendance_current_records`) }\n",
  )

  assert.equal(classifyAttendanceRecordReadSites(direct).unclassified.length, 1)
  const currentResult = classifyAttendanceRecordReadSites(current)
  assert.deepEqual(currentResult.unclassified, [])
  assert.equal(currentResult.classifiedSites[0]?.posture, 'current')
})

test('W4C-3a SELECT-inventory mutation: a dynamic base-table member fails while the current view passes', () => {
  const relPath = 'plugins/plugin-attendance/index.cjs'
  const scan = (table) => scanFileForAttendanceRecordReadSites(
    relPath,
    `async function dynamicSummary() { const tables = ['${table}']; for (const table of tables) await db.query(\`SELECT 1 FROM \${table}\`) }\n`,
  )

  assert.equal(classifyAttendanceRecordReadSites(scan('attendance_records')).unclassified.length, 1)
  const currentResult = classifyAttendanceRecordReadSites(scan('attendance_current_records'))
  assert.deepEqual(currentResult.unclassified, [])
  assert.equal(currentResult.classifiedSites[0]?.posture, 'current')
  assert.equal(currentResult.classifiedSites[0]?.dynamic, true)

  const bypassShapes = [
    "const TABLE = 'attendance_records'\nasync function moduleConstant() { return db.query(`SELECT 1 FROM ${TABLE}`) }\n",
    'const TABLE = `attendance_records`\nasync function backtickConstant() { return db.query(`SELECT 1 FROM ${TABLE}`) }\n',
    "const TABLE = 'attendance_records'\nasync function wrappedConstant() { return db.query(`SELECT 1 FROM ${quote(TABLE)}`) }\n",
  ]
  for (const source of bypassShapes) {
    const result = classifyAttendanceRecordReadSites(
      scanFileForAttendanceRecordReadSites(relPath, source),
    )
    assert.equal(result.unclassified.length, 1, source)
    assert.equal(result.unclassified[0]?.table, 'attendance_records')
    assert.equal(result.unclassified[0]?.dynamic, true)
  }
})

test('W4C-4: generated SELECT inventory classifies every calculation and segment read', () => {
  const source = createWorktreeSource(rootDir)
  const { sites } = buildAttendanceCalculationReadCensus(source)
  const result = classifyAttendanceCalculationReadSites(sites)

  assert.ok(sites.some((site) => site.table === 'attendance_record_calculations'))
  assert.ok(sites.some((site) => site.table === 'attendance_record_segments'))
  assert.deepEqual(
    result.unclassified.map((site) => `${site.relPath} :: ${site.enclosingSymbol} :: ${site.table}`),
    [],
    'every direct calculation/segment read must have a current or history classification',
  )
  assert.deepEqual(result.countDrift, [], 'a new direct read in a known wrapper requires explicit review')
  assert.deepEqual(result.stale, [], 'a removed direct read must retire its historical classification')
  assert.deepEqual(result.predicateDrift, [], 'current readers must retain their required active-row predicate')
  assert.equal(result.classifiedSites.length, sites.length)
  assert.equal(result.classifiedSites.filter((site) => site.posture === 'current').length, 3)
  assert.ok(result.classifiedSites.some((site) =>
    site.enclosingSymbol === 'readAuthoritativeTraceCalculation'
      && site.table === 'attendance_record_calculations'
      && site.posture === 'current'))
  assert.ok(result.classifiedSites.some((site) =>
    site.enclosingSymbol === 'readShadowTraceCalculation'
      && site.table === 'attendance_record_calculations'
      && site.posture === 'history'))

  const baseSource = createWorktreeSource(rootDir)
  const mutatedSource = {
    ...baseSource,
    readFile: (relPath) => {
      const content = baseSource.readFile(relPath)
      if (relPath !== 'packages/core-backend/src/services/AttendanceW4CalculationDetail.ts') return content
      return content.replace(
        "AND record.visibility_state = 'active'",
        "AND record.visibility_state = 'retired'",
      )
    },
  }
  const mutated = classifyAttendanceCalculationReadSites(
    buildAttendanceCalculationReadCensus(mutatedSource).sites,
  )
  assert.deepEqual(mutated.unclassified, [])
  assert.deepEqual(mutated.countDrift, [])
  assert.deepEqual(mutated.stale, [])
  assert.equal(mutated.predicateDrift.length, 1)
  assert.equal(mutated.predicateDrift[0]?.enclosingSymbol, 'readAuthoritativeTraceCalculation')
  assert.equal(mutated.predicateDrift[0]?.actual, null)
})

test('W4C-4 mutation: a SQL-comment marker cannot satisfy the active predicate fingerprint', () => {
  for (const query of [
    "`SELECT 1 FROM attendance_record_calculations /* visibility_state = 'active' */`",
    "'SELECT 1 FROM attendance_record_calculations /* visibility_state = \'active\' */'",
  ]) {
    const source = `async function shadowRead() { return db.query(${query}) }\n`
    const sites = scanFileForAttendanceCalculationReadSites('packages/core-backend/src/attendance/shadow-read.ts', source)
    assert.equal(sites.length, 1, query)
    assert.equal(sites[0]?.requiredPredicateFingerprint, null, query)
  }
})

test('W4C-4 mutation: removing shadow active predicate is independently detected', () => {
  const baseSource = createWorktreeSource(rootDir)
  const relPath = 'packages/core-backend/src/services/AttendanceW4CalculationDetail.ts'
  const original = baseSource.readFile(relPath)
  const mutatedSource = {
    ...baseSource,
    readFile: (candidate) => {
      if (candidate !== relPath) return baseSource.readFile(candidate)
      return original.replace(
        "AND calculation.mode = 'shadow'\n      WHERE record.org_id = $1 AND record.user_id = $2 AND record.work_date = $3\n        AND record.visibility_state = 'active'",
        "AND calculation.mode = 'shadow'\n      WHERE record.org_id = $1 AND record.user_id = $2 AND record.work_date = $3\n        /* visibility_state = 'active' */",
      )
    },
  }
  const result = classifyAttendanceCalculationReadSites(
    buildAttendanceCalculationReadCensus(mutatedSource).sites,
  )
  assert.deepEqual(result.unclassified, [])
  assert.equal(result.predicateDrift.length, 1)
  assert.equal(result.predicateDrift[0]?.enclosingSymbol, 'readShadowTraceCalculation')
  assert.equal(result.predicateDrift[0]?.actual, null)
})

test('W4C-4 SELECT-inventory mutation: unclassified calculation and segment reads fail closed', () => {
  for (const table of ['attendance_record_calculations', 'attendance_record_segments']) {
    const sites = scanFileForAttendanceCalculationReadSites(
      'packages/core-backend/src/routes/attendance-unclassified-read.ts',
      `async function unclassifiedRead() { return db.query(\`SELECT * FROM ${table}\`) }\n`,
    )
    const result = classifyAttendanceCalculationReadSites(sites)
    assert.equal(result.unclassified.length, 1, table)
    assert.equal(result.unclassified[0]?.table, table)
  }
})

test('W4C-4 SELECT-inventory mutation: a direct retired-row read fails closed', () => {
  const sites = scanFileForAttendanceCalculationReadSites(
    'packages/core-backend/src/routes/attendance-retired-row-leak.ts',
    `async function exposeRetiredCalculation() {
      return db.query(\`SELECT calculation.id
        FROM attendance_record_calculations calculation
        JOIN attendance_records record ON record.id = calculation.attendance_record_id
       WHERE record.visibility_state = 'retired'\`)
    }\n`,
  )
  const result = classifyAttendanceCalculationReadSites(sites)
  assert.equal(result.unclassified.length, 1)
  assert.equal(result.unclassified[0]?.table, 'attendance_record_calculations')
})

test('W4C-4 SELECT-inventory mutation: dynamic calculation table reads fail closed', () => {
  const sites = scanFileForAttendanceCalculationReadSites(
    'packages/core-backend/src/routes/attendance-dynamic-read.ts',
    "const TABLE = 'attendance_record_calculations'\nasync function dynamicRead() { return db.query(`SELECT * FROM ${TABLE}`) }\n",
  )
  const result = classifyAttendanceCalculationReadSites(sites)
  assert.equal(result.unclassified.length, 1)
  assert.equal(result.unclassified[0]?.dynamic, true)
})

// -------------------------------------------------------------------------------------------
// 2. Separately named pinned-baseline obligation (W4C-3c).
//    The frozen e0defbe artifact is proven against the pinned ref WITHOUT consulting live
//    CURATED_DEBT_ENTRIES.claims. Current-tree claims must not retain removed symbols solely to
//    keep this green; see pinned-baseline-obligation.cjs.
// -------------------------------------------------------------------------------------------
test('pinned baseline obligation: frozen artifact covers the pinned ref without live claim crutches', () => {
  const result = provePinnedBaselineObligation(rootDir)
  assert.equal(result.ok, true)
  assert.equal(result.pinnedRef, PINNED_REF)
  assert.ok(result.trackedSiteCount > 0)
  // Discriminate: live P05 claims must NOT include the historical post-write patch symbol.
  const p05 = CURATED_DEBT_ENTRIES.find((entry) => entry.id === 'P05')
  assert.ok(p05)
  const syntheticHistorical = {
    relPath: 'plugins/plugin-attendance/index.cjs',
    enclosingSymbol: 'attachManualResultEditMarkerToRecord',
    table: 'attendance_records',
    verb: 'update',
    line: 1,
  }
  assert.equal(
    p05.claims(syntheticHistorical),
    false,
    'current P05 must not retain a claim for the removed post-write patch symbol',
  )
})

// -------------------------------------------------------------------------------------------
// 3. Baseline pin identity: the ref is the exact SHA the design lock names, not inferred.
// -------------------------------------------------------------------------------------------
test('baseline ref is the exact pinned SHA named by the design lock, restore-only', () => {
  assert.equal(PINNED_REF, 'e0defbe26d7f2e1747e74aa908ca710422812bf7')
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, BASELINE_ARTIFACT_RELPATH), 'utf8'))
  assert.equal(manifest.generatedFromRef, PINNED_REF)
})

// -------------------------------------------------------------------------------------------
// 4. Positive controls — §8.4: "Each syntax/table class has a positive-control fixture,
//    including deliberate plugin, packages/core-backend/src, shared-approval, and
//    operator-script bypasses." These call the scanner/classifier directly on synthetic
//    in-memory content (never written under a scanned root) so the guard proves it has teeth
//    without polluting the real repository scan.
// -------------------------------------------------------------------------------------------

function classifyOneSyntheticSite(relPath, content) {
  const rawSites = scanFileForDmlSites(relPath, content)
  const classified = classifyCensus(rawSites)
  return classified
}

test('positive control: deliberate plugin-style direct INSERT bypass is unclaimed', () => {
  const content = "async function newLiveBypassRoute() {\n  await db.query(`INSERT INTO attendance_records (id) VALUES ($1)`, [id])\n}\n"
  const classified = classifyOneSyntheticSite('plugins/plugin-attendance/index.cjs', content)
  const { unclaimed } = classifyTrackedSites(classified.trackedSites)
  assert.equal(classified.trackedSites.length, 1)
  assert.equal(unclaimed.length, 1, 'a brand-new symbol writing attendance_records must not be silently claimed by an existing P0x entry')
})

test('positive control: deliberate packages/core-backend/src bypass (new route, no discriminator) is unclaimed', () => {
  const content = "router.post('/api/attendance/new-bypass-route', async (req, res) => {\n  await client.query('UPDATE attendance_records SET status = $1 WHERE id = $2', [status, id])\n})\n"
  const classified = classifyOneSyntheticSite('packages/core-backend/src/routes/attendance-new-bypass.ts', content)
  const { unclaimed } = classifyTrackedSites(classified.trackedSites)
  assert.equal(unclaimed.length, 1)
})

test('positive control: shared-approval bypass (approval_instances write from an unlisted path) is unclaimed', () => {
  const content = "function terminalizeSomewhereElse() {\n  return trx.raw(\"UPDATE approval_instances SET status = 'completed' WHERE id = $1\", [id])\n}\n"
  const classified = classifyOneSyntheticSite('packages/core-backend/src/services/SomeOtherBridgeNotOnAllowlist.ts', content)
  const { unclaimed, genericAllowlisted } = classifyTrackedSites(classified.trackedSites)
  assert.equal(genericAllowlisted.length, 0)
  assert.equal(unclaimed.length, 1)
})

test('positive control: operator-script bypass (direct delete outside the staging-helper path prefix) is unclaimed', () => {
  const content = "async function pruneOldRows() {\n  await pool.query('DELETE FROM attendance_records WHERE org_id = $1', [orgId])\n}\n"
  const classified = classifyOneSyntheticSite('scripts/ops/attendance-unlisted-operator-tool.mjs', content)
  const { unclaimed } = classifyTrackedSites(classified.trackedSites)
  assert.equal(unclaimed.length, 1)
})

test('positive control: raw COPY into a W4 authoritative (canonical) table from outside the boundary fails', () => {
  const content = "async function sneakyBulkLoad(client) {\n  const stream = client.query(copyFrom(`COPY attendance_result_operations (org_id) FROM STDIN`))\n}\n"
  const classified = classifyOneSyntheticSite('plugins/plugin-attendance/index.cjs', content)
  assert.equal(classified.canonicalSites.length, 0)
  assert.equal(classified.outsideBoundarySites.length, 1, 'a COPY into a w4_canonical table from a non-canonical path must be flagged out-of-boundary, not silently allowed')
  assert.equal(classified.outsideBoundarySites[0].verb, 'copy')
})

test('positive control: raw COPY FROM STDIN into attendance_records ahead of preflight is unclaimed', () => {
  const content = "async function legacyImportRawCopy(client) {\n  const stream = client.query(copyFrom(`COPY attendance_records (id) FROM STDIN`))\n}\n"
  const classified = classifyOneSyntheticSite('plugins/plugin-attendance/index.cjs', content)
  const { unclaimed } = classifyTrackedSites(classified.trackedSites)
  assert.equal(classified.trackedSites.length, 1)
  assert.equal(classified.trackedSites[0].verb, 'copy')
  assert.equal(unclaimed.length, 1)
})

test('positive control: MERGE INTO and runtime staging CREATE TABLE syntax classes are both detected', () => {
  const mergeContent = "async function upsertViaMerge() {\n  await db.query(`MERGE INTO attendance_records t USING src ON t.id = src.id`)\n}\n"
  const mergeSites = scanFileForDmlSites('plugins/plugin-attendance/index.cjs', mergeContent)
  assert.equal(mergeSites.length, 1)
  assert.equal(mergeSites[0].verb, 'merge')
  assert.equal(mergeSites[0].table, 'attendance_records')

  const stagingContent = "async function makeTempStage() {\n  await db.query(`CREATE TABLE attendance_records (id uuid)`)\n}\n"
  const stagingSites = scanFileForDmlSites('plugins/plugin-attendance/index.cjs', stagingContent)
  assert.equal(stagingSites.length, 1)
  assert.equal(stagingSites[0].verb, 'staging_create')
})

test('canonical boundary helper agrees with the classifier on in/out-of-boundary paths', () => {
  assert.equal(isCanonicalBoundaryPath('packages/core-backend/src/attendance/w4c0-operation-registry.ts'), true)
  assert.equal(isCanonicalBoundaryPath('packages/core-backend/src/attendance/w4c3a-legacy-plan-enqueue.ts'), true)
  assert.equal(isCanonicalBoundaryPath('packages/core-backend/src/attendance/w4c3b-request-snapshots.ts'), true)
  assert.equal(isCanonicalBoundaryPath('plugins/plugin-attendance/index.cjs'), false)
  assert.equal(isCanonicalBoundaryPath('packages/core-backend/src/routes/admin-users.ts'), false)
})

test('W4C-3b snapshot storage accepts only the canonical module path', () => {
  const sql = "async function appendSnapshot() {\n  await db.query('INSERT INTO attendance_request_calculation_snapshots (org_id) VALUES ($1)', [orgId])\n}\n"
  const canonical = classifyOneSyntheticSite(
    'packages/core-backend/src/attendance/w4c3b-request-snapshots.ts',
    sql,
  )
  const plugin = classifyOneSyntheticSite('plugins/plugin-attendance/index.cjs', sql)

  assert.equal(canonical.canonicalSites.length, 1)
  assert.equal(canonical.outsideBoundarySites.length, 0)
  assert.equal(plugin.canonicalSites.length, 0)
  assert.equal(plugin.outsideBoundarySites.length, 1)
})

test('W4C-3a storage buckets preserve frozen source, result, revision, and cleanup boundaries', () => {
  for (const table of [
    'attendance_import_legacy_execution_plans',
    'attendance_import_legacy_execution_plan_chunks',
    'attendance_import_legacy_terminal_responses',
    'attendance_import_rollback_commands',
    'attendance_import_rollback_restore_witnesses',
    'attendance_record_target_revisions',
    'attendance_group_effect_revisions',
  ]) {
    assert.equal(TABLE_BUCKETS[table], 'w4_canonical', `${table} must stay inside the canonical boundary`)
  }
  assert.equal(
    TABLE_BUCKETS.attendance_import_upload_cleanup_commands,
    'operational',
    'upload cleanup commands are P25 operational-only state',
  )
})

test('W4C-3a canonical tables reject a plugin-side writer', () => {
  const classified = classifyOneSyntheticSite(
    'plugins/plugin-attendance/index.cjs',
    "async function bypassFrozenPlan() {\n  await db.query('UPDATE attendance_import_legacy_execution_plans SET plan_digest = $1 WHERE job_id = $2', [digest, jobId])\n}\n",
  )
  assert.equal(classified.canonicalSites.length, 0)
  assert.equal(classified.outsideBoundarySites.length, 1)
  assert.equal(classified.outsideBoundarySites[0].table, 'attendance_import_legacy_execution_plans')
})

test('W4C-3a canonical tables accept a W4C-3a boundary writer', () => {
  const classified = classifyOneSyntheticSite(
    'packages/core-backend/src/attendance/w4c3a-synthetic-positive-control.ts',
    "async function persistFrozenPlan() {\n  await db.query('INSERT INTO attendance_import_legacy_execution_plans (job_id) VALUES ($1)', [jobId])\n}\n",
  )
  assert.equal(classified.canonicalSites.length, 1)
  assert.equal(classified.outsideBoundarySites.length, 0)
  assert.equal(classified.canonicalSites[0].table, 'attendance_import_legacy_execution_plans')
})

test('W4C-3a fixed record-effect DML is classified under the completed P06-P09 cutovers', () => {
  const source = createWorktreeSource(rootDir)
  const { sites } = buildRawCensus(source)
  const classified = classifyCensus(sites)
  const { claimsByEntryId } = classifyTrackedSites(classified.trackedSites)
  const adapterPath =
    'packages/core-backend/src/attendance/w4c3a-legacy-plan-record-effects.ts'
  const expectedKeys = classified.trackedSites
    .filter((site) => site.relPath === adapterPath)
    .map((site) => site.key)
    .sort()

  assert.equal(expectedKeys.length, 2, 'the fixed adapter must expose exactly UPDATE + INSERT')
  for (const id of ['P06', 'P07', 'P08', 'P09']) {
    const claimedKeys = (claimsByEntryId.get(id) || [])
      .filter((site) => site.relPath === adapterPath)
      .map((site) => site.key)
      .sort()
    assert.deepEqual(claimedKeys, expectedKeys, `${id} must classify both shared adapter sites`)
    const entry = CURATED_DEBT_ENTRIES.find((candidate) => candidate.id === id)
    assert.equal(
      entry?.canonicalizedBy,
      'W4C-3a',
      `${id} must remain explicitly canonicalized by its owning slice`,
    )
  }
})

test('W4C-3a fixed item-effect DML is classified under the completed P06-P09 cutovers', () => {
  const source = createWorktreeSource(rootDir)
  const { sites } = buildRawCensus(source)
  const classified = classifyCensus(sites)
  const { claimsByEntryId } = classifyTrackedSites(classified.trackedSites)
  const adapterPath =
    'packages/core-backend/src/attendance/w4c3a-legacy-plan-item-effects.ts'
  const expectedKeys = classified.trackedSites
    .filter((site) => site.relPath === adapterPath)
    .map((site) => site.key)
    .sort()

  assert.equal(expectedKeys.length, 1, 'the fixed item adapter must expose exactly one INSERT')
  for (const id of ['P06', 'P07', 'P08', 'P09']) {
    const claimedKeys = (claimsByEntryId.get(id) || [])
      .filter((site) => site.relPath === adapterPath)
      .map((site) => site.key)
      .sort()
    assert.deepEqual(claimedKeys, expectedKeys, `${id} must classify the shared item adapter site`)
    const entry = CURATED_DEBT_ENTRIES.find((candidate) => candidate.id === id)
    assert.equal(
      entry?.canonicalizedBy,
      'W4C-3a',
      `${id} must remain explicitly canonicalized by its owning slice`,
    )
  }
})

// -------------------------------------------------------------------------------------------
// 5. CI wiring: this file must be named explicitly in the workflow (node:test files are neither
//    vitest-discovered nor covered by vitest.config.ts's exclude list — see module header).
// -------------------------------------------------------------------------------------------
test('this collector test file has an explicit CI execution step', () => {
  const workflow = readWorkflow()
  assert.match(workflow, new RegExp(THIS_TEST_FILENAME.replaceAll('.', '\\.')))
  assert.match(
    workflow,
    /Run attendance W4C-0 Stage D §8\.4 and W4C-4 §12\.7 inventory collectors/,
    'the required CI step must name the W4C-4 current/history inventory, not only the older DML collector',
  )
})

// -------------------------------------------------------------------------------------------
// 6. W4C-2 cutover markers (lock §12.3: "P01 live, P02 merge second-pass, P03 cron absence,
//    and P04 administrator-run absence inventory entries are removed independently"). Each of
//    the four entries must INDEPENDENTLY carry the removed-by-adapter marker; no other entry
//    may be silently marked; and the claim predicates still cover the adapter-owned sites so
//    unclaimed=0 detection is not bypassed by the removal.
// -------------------------------------------------------------------------------------------
test('W4C-2: P01, P02, P03, P04 each independently carry canonicalizedBy=W4C-2 — and only they do for W4C-2', () => {
  const byId = new Map(CURATED_DEBT_ENTRIES.map((entry) => [entry.id, entry]))
  // Four independent assertions — removing any ONE marker fails on its own line.
  assert.equal(byId.get('P01')?.canonicalizedBy, 'W4C-2', 'P01 (live punch) must be removed-by-adapter')
  assert.equal(byId.get('P02')?.canonicalizedBy, 'W4C-2', 'P02 (merge second-pass) must be removed-by-adapter')
  assert.equal(byId.get('P03')?.canonicalizedBy, 'W4C-2', 'P03 (cron absence) must be removed-by-adapter')
  assert.equal(byId.get('P04')?.canonicalizedBy, 'W4C-2', 'P04 (administrator absence run) must be removed-by-adapter')
  const marked = CURATED_DEBT_ENTRIES.filter((entry) => entry.canonicalizedBy === 'W4C-2')
    .map((entry) => `${entry.id}:${entry.canonicalizedBy}`)
    .sort()
  assert.deepEqual(
    marked,
    ['P01:W4C-2', 'P02:W4C-2', 'P03:W4C-2', 'P04:W4C-2'],
    'exactly the four W4C-2 entries carry the W4C-2 marker',
  )
})

test('W4C-2: the canonical adapter symbols are claimed by exactly the expected entries', () => {
  const syntheticLive = {
    relPath: 'plugins/plugin-attendance/index.cjs',
    enclosingSymbol: 'applyLivePunchProjectionLegacyV1',
    table: 'attendance_events',
    verb: 'insert',
    bucket: 'business',
    key: 'synthetic-live',
    line: 1,
  }
  const syntheticAbsence = {
    relPath: 'plugins/plugin-attendance/index.cjs',
    enclosingSymbol: 'generateAbsenceRecords',
    table: 'attendance_records',
    verb: 'insert',
    bucket: 'business',
    key: 'synthetic-absence',
    line: 2,
  }
  const { claimsByEntryId, unclaimed } = classifyTrackedSites([syntheticLive, syntheticAbsence])
  assert.deepEqual(unclaimed, [], 'the adapter-owned sites must remain claimed (unclaimed=0 not bypassed)')
  assert.deepEqual(
    (claimsByEntryId.get('P01') || []).map((site) => site.key),
    ['synthetic-live'],
    'P01 claims the live adapter site',
  )
  // One function, two initiators, two debt ids (lock section 1.1): P03 AND P04 both claim it.
  assert.deepEqual((claimsByEntryId.get('P03') || []).map((site) => site.key), ['synthetic-absence'])
  assert.deepEqual((claimsByEntryId.get('P04') || []).map((site) => site.key), ['synthetic-absence'])
})

// -------------------------------------------------------------------------------------------
// 7. W4 canonical wrong-bucket drift guard (origin: W4C-2 P1-2, #4612 final-gate P2-5):
//    the collector's classification suite covered ABSENCE (an unclassified table fails) but not
//    WRONG BUCKET — re-classifying `attendance_scheduled_runs` from `w4_canonical` to
//    `operational` left all prior legs green, silently disarming the canonical-boundary hard
//    fail (ATTENDANCE_W4C0_DML_OUTSIDE_CANONICAL_BOUNDARY) for that table. Same exact-set shape
//    as the debt-ID exclusivity assertion in section 6: three per-table legs (each of the three
//    new tables reddens on its own line) + one exact-set leg over the WHOLE w4_canonical bucket
//    (so demoting ANY canonical table — the W4C-0/W4C-3a ones included — reddens too, and a table
//    smuggled INTO the bucket to widen the path-prefix allowlist's reach also reddens).
// -------------------------------------------------------------------------------------------
test('the three scheduled-run tables are w4_canonical, and the bucket is the exact known closed set', () => {
  // Three independent assertions — flipping any ONE table's bucket fails on its own line.
  assert.equal(
    TABLE_BUCKETS.attendance_scheduled_runs,
    'w4_canonical',
    'attendance_scheduled_runs must stay canonical-boundary-only (wrong-bucket drift, not just absence)',
  )
  assert.equal(
    TABLE_BUCKETS.attendance_scheduled_run_targets,
    'w4_canonical',
    'attendance_scheduled_run_targets must stay canonical-boundary-only (wrong-bucket drift, not just absence)',
  )
  assert.equal(
    TABLE_BUCKETS.attendance_scheduled_run_target_outcomes,
    'w4_canonical',
    'attendance_scheduled_run_target_outcomes must stay canonical-boundary-only (wrong-bucket drift, not just absence)',
  )
  const bucketMembers = Object.keys(TABLE_BUCKETS)
    .filter((table) => TABLE_BUCKETS[table] === 'w4_canonical')
    .sort()
  assert.deepEqual(
    bucketMembers,
    [
      'attendance_calculation_rollout_events',
      'attendance_calculation_rollout_state',
      'attendance_group_effect_revisions',
      'attendance_import_legacy_execution_plan_chunks',
      'attendance_import_legacy_execution_plans',
      'attendance_import_legacy_terminal_responses',
      'attendance_import_rollback_closures',
      'attendance_import_rollback_commands',
      'attendance_import_rollback_restore_witnesses',
      'attendance_record_calculations',
      'attendance_record_segments',
      'attendance_record_target_revisions',
      'attendance_request_calculation_snapshots',
      'attendance_result_event_outbox',
      'attendance_result_operation_batches',
      'attendance_result_operations',
      'attendance_scheduled_run_target_outcomes',
      'attendance_scheduled_run_targets',
      'attendance_scheduled_runs',
    ],
    'the w4_canonical bucket is an exact closed set — a demotion OR a smuggled addition both redden here',
  )
})

// -------------------------------------------------------------------------------------------
// 8. P25 import/integration inventory contract (OD-W4C-36 and OD-W4C-56).  A bucket allowlist alone
// is too weak: it would let a V1 job/plan value be reported as authority while the DML census
// remains green.  The P25 table spec is the closed family/authority inventory; the synthetic
// use checks below are deliberately independent from route behavior and do not claim that the
// completed P06-P11/P23-P25 callers and classifications remain mechanically visible.
// -------------------------------------------------------------------------------------------
test('P25: the closed import/integration set has explicit family and non-authority specs', () => {
  const expectedP25Tables = [
    'attendance_import_items_stage',
    'attendance_import_jobs',
    'attendance_import_legacy_execution_plan_chunks',
    'attendance_import_legacy_execution_plans',
    'attendance_import_legacy_terminal_responses',
    'attendance_import_records_stage',
    'attendance_import_template_prefs',
    'attendance_import_tokens',
    'attendance_import_upload_cleanup_commands',
    'attendance_integration_runs',
    'attendance_integrations',
  ]
  assert.deepEqual(
    P25_IMPORT_INTEGRATION_TABLES,
    expectedP25Tables,
    'P25 must remain a closed import/integration set, not every operational attendance feature',
  )

  for (const [table, spec] of Object.entries(P25_OPERATIONAL_TABLE_SPECS)) {
    assert.ok(TABLE_BUCKETS[table], `${table} must also exist in the closed table bucket map`)
    assert.match(spec.family, /^[a-z0-9_]+$/)
    assert.match(spec.authorityClass, /^[a-z0-9_]+$/)
    assert.deepEqual(spec.forbiddenAuthorityRoles, P25_FORBIDDEN_AUTHORITY_ROLES)
    assert.equal(spec.forbiddenAuthorityRoles.includes('calculation_source'), true)
    assert.equal(spec.forbiddenAuthorityRoles.includes('calculation_result'), true)
    assert.equal(spec.forbiddenAuthorityRoles.includes('promotion_evidence'), true)
    assert.equal(spec.forbiddenAuthorityRoles.includes('rollback_authority'), true)
    assert.equal(spec.forbiddenAuthorityRoles.includes('authorization_evidence'), true)
    assert.equal(spec.forbiddenAuthorityRoles.includes('operation_claim'), true)
  }

  const source = createWorktreeSource(rootDir)
  const { sites } = buildRawCensus(source)
  const classified = classifyCensus(sites)
  const p25Sites = [...classified.bucketAllowlistedSites, ...classified.canonicalSites].filter(
    (site) => P25_OPERATIONAL_TABLE_SPECS[site.table],
  )
  assert.ok(p25Sites.length > 0, 'the generated census must contain P25 operational/canonical sites')
  for (const site of p25Sites) {
    assert.deepEqual(site.p25, P25_OPERATIONAL_TABLE_SPECS[site.table], `${site.table} must carry its P25 posture in generated inventory`)
  }

  assert.equal(P25_OPERATIONAL_TABLE_SPECS.attendance_import_jobs.family, 'import_job')
  assert.equal(P25_OPERATIONAL_TABLE_SPECS.attendance_import_items_stage.family, 'temporary_staging')
  assert.equal(P25_OPERATIONAL_TABLE_SPECS.attendance_import_upload_cleanup_commands.family, 'upload_lifecycle')
  assert.equal(P25_OPERATIONAL_TABLE_SPECS.attendance_integration_runs.family, 'integration_audit_attempt')
  assert.equal(P25_OPERATIONAL_TABLE_SPECS.attendance_import_legacy_execution_plans.family, 'durable_legacy_plan')
  assert.equal(P25_OPERATIONAL_TABLE_SPECS.attendance_import_legacy_execution_plan_chunks.family, 'durable_legacy_plan')
  assert.equal(P25_OPERATIONAL_TABLE_SPECS.attendance_import_legacy_terminal_responses.family, 'durable_legacy_terminal')
  for (const table of [
    'attendance_notification_deliveries',
    'attendance_unscheduled_reminder_dispatch',
    'attendance_record_target_revisions',
    'attendance_group_effect_revisions',
  ]) {
    assert.equal(P25_OPERATIONAL_TABLE_SPECS[table], undefined, `${table} must remain outside P25 scope`)
    assert.equal(classifyP25Use({ table, role: 'business_state' }).classification, 'not_p25_operational')
  }
})

test('P25: durable legacy V1 job and plan values cannot become authority evidence', () => {
  for (const table of [
    'attendance_import_jobs',
    'attendance_import_legacy_execution_plans',
    'attendance_import_legacy_execution_plan_chunks',
    'attendance_import_legacy_terminal_responses',
  ]) {
    assert.throws(
      () => assertP25Use({ table, role: 'authorization_evidence' }),
      (error) => error.code === 'ATTENDANCE_P25_OPERATIONAL_AUTHORITY_FORBIDDEN',
      `${table} must not be promoted into authorization evidence`,
    )
    assert.equal(
      classifyP25Use({ table, role: 'compatibility_transport', adapter: 'private_worker' }).allowed,
      true,
      `${table} may remain transport state for the private worker`,
    )
  }
})

test('P25: non-worker adapters cannot claim a retryable V1 job identity', () => {
  for (const adapter of ['sync', 'legacy_import', 'integration_sync', 'rollback']) {
    assert.throws(
      () => assertP25Use({ table: 'attendance_import_jobs', role: 'retryable_job_identity_claim', adapter }),
      (error) => error.code === 'ATTENDANCE_P25_NON_WORKER_JOB_IDENTITY_FORBIDDEN',
      `${adapter} must reject a retryable job identity before source/operation DML`,
    )
  }
  assert.equal(
    classifyP25Use({
      table: 'attendance_import_jobs',
      role: 'retryable_job_identity_claim',
      adapter: 'private_worker',
    }).allowed,
    true,
    'the private worker is the only adapter allowed to claim a retryable job identity',
  )
  assert.equal(
    classifyP25Use({
      table: 'attendance_import_jobs',
      role: 'identity_transport',
      adapter: 'legacy_import',
    }).allowed,
    false,
    'a non-worker adapter cannot transport a reserved V1 identity tuple',
  )
  assert.equal(
    classifyP25Use({
      table: 'attendance_import_legacy_execution_plans',
      role: 'compatibility_transport',
      adapter: 'legacy_import',
    }).allowed,
    false,
    'renaming a reserved identity use as compatibility transport must not bypass the adapter boundary',
  )
  assert.equal(
    classifyP25Use({
      table: 'attendance_import_legacy_execution_plans',
      role: 'compatibility_transport',
      adapter: 'private_worker',
    }).allowed,
    true,
    'the private worker may consume the durable compatibility plan',
  )
})

test('P25: integration dryRun audit state cannot be categorized as business state', () => {
  assert.throws(
    () => assertP25Use({ table: 'attendance_integration_runs', role: 'business_state', dryRun: true }),
    (error) => error.code === 'ATTENDANCE_P25_DRY_RUN_AUDIT_NOT_BUSINESS_STATE',
  )
  assert.equal(
    classifyP25Use({ table: 'attendance_integration_runs', role: 'audit_attempt', dryRun: true }).allowed,
    true,
    'dryRun may append an audit attempt only',
  )
})

test('P25: generated runtime call-path census classifies every closed-table read and write', () => {
  const source = createWorktreeSource(rootDir)
  const { sites } = buildP25CallPathCensus(source)
  const result = classifyP25CallPathSites(sites)

  assert.equal(sites.length, 109, 'the current generated P25 read/write inventory must remain explicit')
  assert.deepEqual(result.unclassified, [], 'a new P25 table/site or renamed wrapper must not inherit a broad allowlist')
  assert.deepEqual(result.countDrift, [], 'an extra P25 access in an existing wrapper must require an explicit classification')
  assert.deepEqual(result.stale, [], 'removing a P25 access must retire its classification deliberately')
  assert.equal(result.classifiedSites.length, sites.length, 'every generated P25 site must carry an explicit adapter and role')
  assert.deepEqual(
    [...new Set(sites.map((site) => site.table))].sort(),
    P25_IMPORT_INTEGRATION_TABLES,
    'the generated call-path census must cover every closed P25 table family',
  )
})

test('P25 mutation: removing the private-worker boundary or adding a non-worker reserved-tuple read fails', () => {
  const workerClassification = P25_CALL_PATH_CLASSIFICATIONS.find(
    (classification) =>
      classification.relPath === 'packages/core-backend/src/attendance/w4c3a-legacy-plan-worker-repository.ts' &&
      classification.table === 'attendance_import_legacy_execution_plans' &&
      classification.access === 'read',
  )
  assert.ok(workerClassification)
  const withoutPrivateWorker = P25_CALL_PATH_CLASSIFICATIONS.map((classification) =>
    classification === workerClassification ? { ...classification, adapter: 'sync' } : classification,
  )
  assert.throws(
    () => classifyP25CallPathSites([], withoutPrivateWorker),
    (error) => error.code === 'ATTENDANCE_P25_IDENTITY_ADAPTER_PATH_FORBIDDEN',
    'the durable plan read cannot survive after its private-worker boundary is removed',
  )

  const nonWorkerRead = scanFileForP25CallPathSites(
    'plugins/plugin-attendance/index.cjs',
    "async function syncAdoptsReservedTuple() {\n  await db.query('SELECT * FROM attendance_import_jobs WHERE id = $1', [jobId])\n}\n",
  )
  assert.equal(nonWorkerRead.length, 1)
  assert.throws(
    () =>
      classifyP25CallPathSites(nonWorkerRead, [
        {
          relPath: 'plugins/plugin-attendance/index.cjs',
          enclosingSymbol: 'syncAdoptsReservedTuple',
          table: 'attendance_import_jobs',
          access: 'read',
          verb: 'select',
          count: 1,
          role: 'compatibility_transport',
          adapter: 'sync',
        },
      ]),
    (error) => error.code === 'ATTENDANCE_P25_IDENTITY_ADAPTER_PATH_FORBIDDEN',
    'a sync/legacy/integration/rollback wrapper cannot consume a reserved retryable tuple',
  )

  const hiddenReadShapes = [
    'async function multilineP25Read() {\n  return db.query(`SELECT * FROM\n attendance_import_jobs`)\n}\n',
    "const TABLE = 'attendance_import_jobs'\nasync function moduleP25Read() { return db.query(`SELECT * FROM ${TABLE}`) }\n",
    'const TABLE = `attendance_import_jobs`\nasync function backtickP25Read() { return db.query(`SELECT * FROM ${TABLE}`) }\n',
    "const TABLE = 'attendance_import_jobs'\nasync function wrappedP25Read() { return db.query(`SELECT * FROM ${quote(TABLE)}`) }\n",
  ]
  for (const source of hiddenReadShapes) {
    const sites = scanFileForP25CallPathSites('plugins/plugin-attendance/index.cjs', source)
    assert.equal(sites.length, 1, source)
    assert.equal(sites[0]?.table, 'attendance_import_jobs')
    assert.equal(classifyP25CallPathSites(sites).unclassified.length, 1, source)
  }

  const reusedLoopVariable = scanFileForP25CallPathSites(
    'packages/core-backend/src/db/migrations/example.ts',
    "async function down() {\n  const checks = ['attendance_import_legacy_execution_plans']\n  for (const table of checks) { await db.query(`SELECT * FROM ${quote(table)}`) }\n  for (const table of ['attendance_import_jobs']) { await drop(table) }\n}\n",
  )
  assert.deepEqual(
    reusedLoopVariable.map((site) => site.table),
    ['attendance_import_legacy_execution_plans'],
    'a later same-name loop binding must not contaminate an earlier dynamic SELECT',
  )
})

test('P25 mutation: an unclassified wrapper and integration-run authority both fail', () => {
  const renamedWrapper = scanFileForP25CallPathSites(
    'packages/core-backend/src/attendance/w4c3a-legacy-plan-worker-repository.ts',
    "async function renamedPlanReader() {\n  await db.query('SELECT * FROM attendance_import_legacy_execution_plans WHERE job_id = $1', [jobId])\n}\n",
  )
  const unclassified = classifyP25CallPathSites(renamedWrapper)
  assert.equal(unclassified.unclassified.length, 1, 'renaming a P25 wrapper must require a new explicit classification')

  const addedSite = scanFileForP25CallPathSites(
    'plugins/plugin-attendance/index.cjs',
    "function buildImportJobProjectionSql() {\n  return 'SELECT * FROM attendance_import_jobs'\n}\n",
  )
  const addedSiteResult = classifyP25CallPathSites(addedSite)
  assert.equal(addedSiteResult.unclassified.length, 0, 'the single known wrapper site remains classified')
  const duplicateSiteResult = classifyP25CallPathSites([...addedSite, ...addedSite])
  assert.equal(duplicateSiteResult.unclassified.length, 1, 'a new P25 site inside an existing wrapper must be unclassified')

  const integrationAudit = P25_CALL_PATH_CLASSIFICATIONS.find(
    (classification) => classification.table === 'attendance_integration_runs',
  )
  assert.ok(integrationAudit)
  const authorityMutation = P25_CALL_PATH_CLASSIFICATIONS.map((classification) =>
    classification === integrationAudit ? { ...classification, role: 'business_state' } : classification,
  )
  assert.throws(
    () => classifyP25CallPathSites([], authorityMutation),
    (error) => error.code === 'ATTENDANCE_P25_AUDIT_NOT_BUSINESS_STATE',
    'integration_runs, including dry-run audit state, cannot feed calculation or authorization authority',
  )
})

test('P06-P11/P23-P25 remain visible and explicitly canonicalized by W4C-3a', () => {
  const requiredDebtIds = ['P06', 'P07', 'P08', 'P09', 'P10', 'P11', 'P23', 'P24', 'P25']
  const byId = new Map(CURATED_DEBT_ENTRIES.map((entry) => [entry.id, entry]))
  const source = createWorktreeSource(rootDir)
  const { sites } = buildRawCensus(source)
  const classified = classifyCensus(sites)
  const { claimsByEntryId } = classifyTrackedSites(classified.trackedSites)

  for (const id of requiredDebtIds) {
    const entry = byId.get(id)
    assert.ok(entry, `${id} must remain in the generated debt inventory`)
    assert.equal(
      entry.owningSlice,
      id === 'P25' ? 'W4C-0' : 'W4C-3a',
      `${id} must retain its original owning slice`,
    )
    assert.equal(entry.canonicalizedBy, 'W4C-3a', `${id} must retain its completed-slice marker`)
    // P23/P24/P25 are authorization/operational classification debt and intentionally have no
    // tracked business DML claim; P06-P11 must retain the concrete current census claims.
    if (!['P23', 'P24', 'P25'].includes(id)) {
      assert.ok((claimsByEntryId.get(id) || []).length > 0, `${id} must expose its current canonical writers`)
    }
  }
})

test('W4C-3b P26 generates the action/fixture matrix and classifies every assignment DML site', () => {
  const source = createWorktreeSource(rootDir)
  const { sites } = buildRawCensus(source)
  const result = classifyP26ApprovalAssignmentSites(sites)

  assert.deepEqual(
    result.unclassified.map((site) => `${site.relPath} :: ${site.enclosingSymbol} :: ${site.verb}`),
    [],
    'a new approval_assignments DML site must be explicitly classified',
  )
  assert.deepEqual(result.countDrift, [], 'a new or removed DML call in a known writer must require review')
  assert.deepEqual(result.stale, [], 'removed assignment writers must retire their classification')
  assert.equal(
    result.classifiedSites.length,
    sites.filter((site) => site.table === 'approval_assignments').length,
  )

  const contract = assertP26ActionAndFixtureContract(
    fs.readFileSync(path.join(rootDir, 'packages/core-backend/src/types/approval-product.ts'), 'utf8'),
    fs.readFileSync(path.join(rootDir, 'packages/core-backend/tests/integration/attendance-w4c3b-central-approval.db.test.ts'), 'utf8'),
  )
  assert.deepEqual(contract.fixtureKinds, ['normal', 'adversary'])
  assert.deepEqual(contract.timeoutEffects, ['transfer', 'jump'])
  assert.equal(contract.actions.length, 8)
})

test('W4C-3b P26 mutations kill action, fixture, and assignment-DML omissions or additions', () => {
  const typeSource = fs.readFileSync(
    path.join(rootDir, 'packages/core-backend/src/types/approval-product.ts'),
    'utf8',
  )
  const testSource = fs.readFileSync(
    path.join(rootDir, 'packages/core-backend/tests/integration/attendance-w4c3b-central-approval.db.test.ts'),
    'utf8',
  )
  assert.throws(
    () => assertP26ActionAndFixtureContract(typeSource.replace("  'reduce_sign',\n", ''), testSource),
    /ATTENDANCE_P26_ACTION_UNION_DRIFT/,
  )
  assert.throws(
    () => assertP26ActionAndFixtureContract(typeSource, testSource.replace("'normal', ", '')),
    /ATTENDANCE_P26_FIXTURE_MATRIX_DRIFT/,
  )
  assert.throws(
    () => assertP26ActionAndFixtureContract(typeSource, testSource.replace("'adversary'", "'mutated'")),
    /ATTENDANCE_P26_FIXTURE_MATRIX_DRIFT/,
  )

  const source = createWorktreeSource(rootDir)
  const { sites } = buildRawCensus(source)
  const target = sites.find((site) =>
    site.table === 'approval_assignments'
    && site.relPath === 'packages/core-backend/src/services/ApprovalProductService.ts'
    && site.enclosingSymbol === 'targetUserIds')
  assert.ok(target)
  assert.equal(classifyP26ApprovalAssignmentSites(sites.filter((site) => site !== target)).countDrift.length, 1)

  const added = scanFileForDmlSites(
    'packages/core-backend/src/services/NewApprovalWriter.ts',
    "async function mutateAssignments() { await db.query('UPDATE approval_assignments SET is_active = FALSE') }\n",
  )
  assert.equal(classifyP26ApprovalAssignmentSites([...sites, ...added]).unclassified.length, 1)
})

test('W4C-3b P26 key is injective: a symbol containing the old separator cannot alias another site', () => {
  // The collector mints route symbols as `${METHOD} ${routePath}` from arbitrary path literals,
  // so an enclosingSymbol containing ' :: ' is constructible, not hypothetical. Under the old
  // `[relPath, enclosingSymbol, verb].join(' :: ')` key these two DIFFERENT sites collapse onto
  // the same string, which silently lends one site's classification to the other — the criterion
  // itself becoming the bypass.
  const classifications = [
    { relPath: 'a.ts', enclosingSymbol: 'POST /x :: b.ts :: sym', verb: 'update', count: 1, owner: 'decoy' },
  ]
  const impostor = {
    relPath: 'a.ts :: POST /x',
    enclosingSymbol: 'b.ts :: sym',
    verb: 'update',
    table: 'approval_assignments',
  }
  assert.notEqual(
    p26KeyOf(classifications[0]),
    p26KeyOf(impostor),
    'two distinct (relPath, enclosingSymbol, verb) triples must not share a key',
  )
  const result = classifyP26ApprovalAssignmentSites([impostor], classifications)
  assert.equal(
    result.unclassified.length,
    1,
    'the impostor site must remain unclassified — it must not inherit the decoy classification',
  )
  assert.equal(result.classifiedSites.length, 0)
  assert.equal(result.stale.length, 1, 'and the decoy classification must itself report as stale')

  // Positive control: the SAME triple really does classify, so the assertion above is about
  // aliasing and not about `classifyP26ApprovalAssignmentSites` rejecting synthetic input.
  const genuine = { ...impostor, relPath: 'a.ts', enclosingSymbol: 'POST /x :: b.ts :: sym' }
  const ok = classifyP26ApprovalAssignmentSites([genuine], classifications)
  assert.deepEqual([ok.unclassified.length, ok.classifiedSites.length, ok.stale.length], [0, 1, 0])
})

test('P12-P14/P17-P19/P22/P26-P28 remain visible and explicitly canonicalized by W4C-3b', () => {
  const requiredDebtIds = ['P12', 'P13', 'P14', 'P17', 'P18', 'P19', 'P22', 'P26', 'P27', 'P28']
  const concreteDebtIds = requiredDebtIds.filter((id) => !['P19', 'P22'].includes(id))
  const byId = new Map(CURATED_DEBT_ENTRIES.map((entry) => [entry.id, entry]))
  const source = createWorktreeSource(rootDir)
  const { sites } = buildRawCensus(source)
  const { trackedSites } = classifyCensus(sites)
  const { claimsByEntryId } = classifyTrackedSites(trackedSites)

  for (const id of requiredDebtIds) {
    const entry = byId.get(id)
    assert.ok(entry, `${id} must remain in the generated debt inventory`)
    assert.equal(entry.owningSlice, 'W4C-3b')
    assert.equal(entry.canonicalizedBy, 'W4C-3b', `${id} must carry its completed-slice marker`)
  }
  for (const id of concreteDebtIds) {
    assert.ok((claimsByEntryId.get(id) || []).length > 0, `${id} must expose its canonical writers`)
  }

  const pluginSource = fs.readFileSync(path.join(rootDir, 'plugins/plugin-attendance/index.cjs'), 'utf8')
  assert.match(
    pluginSource,
    /acquireAttendanceScheduleAssignmentLocks\(\s*client,\s*orgId,\s*\[requesterSource\.userId, counterpartySource\.userId\],\s*\{ required: true \}\s*\)/,
    'shift-swap finalization must not silently degrade its schedule-fact lock',
  )
  assert.match(
    pluginSource,
    /acquireAttendanceScheduleAssignmentLocks\(client, orgId, \[detail\.user_id\], \{ required: true \}\)/,
    'schedule-dispatch finalization must not silently degrade its schedule-fact lock',
  )
})

// ---------------------------------------------------------------------------
// W4C-3c: hard zero-bypass — current-tree open debt is empty; live side doors fail.
// Comments/examples are excluded structurally (maskCommentsForDmlScan).
// ---------------------------------------------------------------------------

function currentOpenDebtEntries(entries = CURATED_DEBT_ENTRIES) {
  return entries.filter((entry) => !entry.canonicalizedBy)
}

test('W4C-3c hard zero-bypass: current-tree open-debt set is exactly empty', () => {
  const open = currentOpenDebtEntries()
  assert.deepEqual(
    open.map((entry) => entry.id),
    [],
    'current-tree generated open-debt set must be exactly empty',
  )

  const source = createWorktreeSource(rootDir)
  const { sites } = buildRawCensus(source)
  const { trackedSites } = classifyCensus(sites)
  const { unclaimed } = classifyTrackedSites(trackedSites)
  assert.deepEqual(unclaimed, [], 'current-tree unclaimed tracked sites must be empty')
})

test('W4C-3c mutation: removing a canonicalizedBy/current closure reopens debt', () => {
  const closed = CURATED_DEBT_ENTRIES.filter((entry) => entry.canonicalizedBy)
  assert.ok(closed.length > 0, 'precondition: at least one closed entry')
  const mutated = CURATED_DEBT_ENTRIES.map((entry) =>
    entry.id === 'P05' ? { ...entry, canonicalizedBy: undefined } : entry,
  )
  const reopened = currentOpenDebtEntries(mutated)
  assert.ok(
    reopened.some((entry) => entry.id === 'P05'),
    'stripping P05 canonicalizedBy must reopen open debt',
  )
  assert.equal(
    currentOpenDebtEntries().some((entry) => entry.id === 'P05'),
    false,
    'live inventory must still keep P05 closed',
  )
})

test('W4C-3c: P05/P15/P16/P20 remain visible and explicitly canonicalized', () => {
  const requiredDebtIds = ['P05', 'P15', 'P16', 'P20']
  const byId = new Map(CURATED_DEBT_ENTRIES.map((entry) => [entry.id, entry]))
  const source = createWorktreeSource(rootDir)
  const { sites } = buildRawCensus(source)
  const { trackedSites } = classifyCensus(sites)
  const { claimsByEntryId, unclaimed } = classifyTrackedSites(trackedSites)

  assert.deepEqual(unclaimed, [], 'hard zero-bypass requires unclaimed=0')
  for (const id of requiredDebtIds) {
    const entry = byId.get(id)
    assert.ok(entry, `${id} must remain in the generated debt inventory`)
    assert.equal(entry.owningSlice, 'W4C-3c')
    assert.equal(entry.canonicalizedBy, 'W4C-3c', `${id} must carry its completed-slice marker`)
  }
  assert.ok((claimsByEntryId.get('P05') || []).length > 0, 'P05 must expose current canonical writers')
  assert.ok((claimsByEntryId.get('P15') || []).length > 0, 'P15 must expose ops_retirement writers')
  assert.ok((claimsByEntryId.get('P16') || []).length > 0, 'P16 must expose staging tooling sites')
  const p16Sites = claimsByEntryId.get('P16') || []
  const p16ClaimKeys = p16Sites.map((site) =>
    `${site.relPath}::${site.enclosingSymbol}::${site.table}::${site.verb}`,
  )
  assert.equal(
    new Set(p16ClaimKeys).size,
    p16ClaimKeys.length,
    'P16 exact allowlist must reject a second DML site with the same file/symbol/table/verb tuple',
  )
  // No historical crutch: removed post-write symbol is not a current claim.
  const p05Sites = claimsByEntryId.get('P05') || []
  assert.equal(
    p05Sites.some((site) => site.enclosingSymbol === 'attachManualResultEditMarkerToRecord'),
    false,
    'P05 current claims must not include the removed post-write patch symbol',
  )
})

test('W4C-3c structural comment exclusion: comment examples are not live DML sites', () => {
  const withCommentOnly = [
    '// DELETE FROM attendance_records WHERE id = 1',
    '/* UPDATE attendance_records SET status = x */',
    'const sql = `-- DO NOT: DELETE FROM attendance_records`',
    'function demo() { return 1 } // UPDATE attendance_records SET x = 1',
  ].join('\n')
  const sites = scanFileForDmlSites('probe.cjs', withCommentOnly)
  assert.deepEqual(
    sites.filter((site) => site.table === 'attendance_records'),
    [],
    'comment/documentation DELETE/UPDATE must not mint DML sites',
  )
  assert.equal(hasLiveDmlOnTable(withCommentOnly, 'delete', 'attendance_records'), false)
  assert.equal(hasLiveDmlOnTable(withCommentOnly, 'update', 'attendance_records'), false)

  const live = "async function evil() { await db.query(`DELETE FROM attendance_records WHERE id = $1`) }\n"
  assert.equal(hasLiveDmlOnTable(live, 'delete', 'attendance_records'), true)
  assert.equal(scanFileForDmlSites('probe.cjs', live).length, 1)
})

test('W4C-3c string-aware comment mask: live DML after JS string containing -- or http:// is preserved', () => {
  const afterDashDash = [
    "const s = '--'",
    'async function live() { await db.query(`DELETE FROM attendance_records WHERE id = $1`) }',
  ].join('\n')
  const maskedDash = maskCommentsForDmlScan(afterDashDash)
  assert.match(maskedDash, /DELETE FROM attendance_records/)
  assert.equal(hasLiveDmlOnTable(afterDashDash, 'delete', 'attendance_records'), true)
  assert.equal(scanFileForDmlSites('probe.cjs', afterDashDash).length, 1)

  const afterHttp = [
    "const u = 'http://x'",
    'async function live() { await db.query(`UPDATE attendance_records SET status = $1 WHERE id = $2`) }',
  ].join('\n')
  const maskedHttp = maskCommentsForDmlScan(afterHttp)
  assert.match(maskedHttp, /UPDATE attendance_records/)
  assert.equal(hasLiveDmlOnTable(afterHttp, 'update', 'attendance_records'), true)
  assert.equal(scanFileForDmlSites('probe.cjs', afterHttp).length, 1)

  // Negative control: SQL -- comment inside a template must not mint live DML,
  // and must not blank later JS outside the template.
  const sqlCommentInTemplate = [
    'const q = `SELECT 1 -- DELETE FROM attendance_records`',
    'const later = 1',
    'async function live() { await db.query(`DELETE FROM attendance_events WHERE id = $1`) }',
  ].join('\n')
  const maskedSql = maskCommentsForDmlScan(sqlCommentInTemplate)
  assert.equal(hasLiveDmlOnTable(sqlCommentInTemplate, 'delete', 'attendance_records'), false)
  assert.equal(hasLiveDmlOnTable(sqlCommentInTemplate, 'delete', 'attendance_events'), true)
  assert.match(maskedSql, /const later = 1/)
  assert.match(maskedSql, /DELETE FROM attendance_events/)
})

test('W4C-3c whole-file scanner catches multiline DML verb/table boundaries', () => {
  const shapes = [
    'async function insertBypass() { await db.query(`INSERT INTO\n  attendance_records (id) VALUES ($1)`) }',
    'async function deleteBypass() { await db.query(`DELETE FROM\n  attendance_events WHERE id = $1`) }',
    'async function updateBypass() { await db.query(`UPDATE\n  attendance_records SET status = $1`) }',
  ]
  const expected = [
    ['insert', 'attendance_records'],
    ['delete', 'attendance_events'],
    ['update', 'attendance_records'],
  ]
  for (let index = 0; index < shapes.length; index += 1) {
    const sites = scanFileForDmlSites('probe.cjs', shapes[index])
    assert.equal(sites.length, 1, shapes[index])
    assert.deepEqual([sites[0].verb, sites[0].table], expected[index])
  }
})

test('W4C-3c scanner resolves schema-qualified write targets to the real table, not the qualifier', () => {
  // Found by feeding the scanner an evasion battery while converting approval to exact site
  // identity. Before the fix the capture group took the FIRST identifier after the verb, so
  // `INSERT INTO public.attendance_records` produced a site on the table `public` — which is not
  // attendance-owned, so the write fell out of the tracked buckets entirely and no identity, no
  // count and no allowlist was ever consulted. A one-token bypass of the whole §8.4 gate.
  //
  // Exact-identity approval cannot help here: a write the scanner never turns into a site has no
  // identity to be approved or refused. This leg therefore guards the SCANNER, and it is the
  // reason the fix belongs with the identity conversion rather than after it.
  const shapes = [
    ['async function q1() { await db.query(`INSERT INTO public.attendance_records (id) VALUES ($1)`) }', 'insert', 'attendance_records'],
    ['async function q2() { await db.query(`DELETE FROM public."attendance_events" WHERE id = $1`) }', 'delete', 'attendance_events'],
    ['async function q3() { await db.query(`UPDATE "public".attendance_records SET status = $1`) }', 'update', 'attendance_records'],
    ['async function q4() { await db.query(`INSERT INTO db.public.attendance_records (id) VALUES ($1)`) }', 'insert', 'attendance_records'],
  ]
  for (const [source, verb, table] of shapes) {
    const sites = scanFileForDmlSites('probe.cjs', source)
    assert.equal(sites.length, 1, source)
    assert.deepEqual([sites[0].verb, sites[0].table], [verb, table], source)
  }

  // Negative control: the qualifier group must not swallow the table when there IS no qualifier,
  // and must not invent a site out of a bare dotted expression that is not a DML target.
  const bare = scanFileForDmlSites('probe.cjs', 'async function q5() { await db.query(`INSERT INTO attendance_records (id) VALUES ($1)`) }')
  assert.deepEqual([bare.length, bare[0]?.table], [1, 'attendance_records'])
})

test('W4C-3c comment masker tracks nested braces inside template expressions', () => {
  const source = [
    'const sql = `SELECT ${render({ nested: { value: 1 } })}`',
    'async function live() {',
    '  await db.query(`DELETE FROM attendance_records WHERE id = $1`)',
    '}',
  ].join('\n')
  const masked = maskCommentsForDmlScan(source)
  assert.match(masked, /render\(\{ nested: \{ value: 1 \} \}\)/)
  assert.equal(hasLiveDmlOnTable(source, 'delete', 'attendance_records'), true)
  assert.equal(scanFileForDmlSites('probe.cjs', source).length, 1)
})

test('W4C-3c P16 exact allowlist: new DELETE under allowed file/symbol or different table/verb is unclaimed', () => {
  const p16 = CURATED_DEBT_ENTRIES.find((entry) => entry.id === 'P16')
  assert.ok(p16)

  // Known allowlisted site still claims.
  const allowed = {
    relPath: 'scripts/ops/staging-attendance-tooling-teardown.mjs',
    enclosingSymbol: 'runStagingAttendanceRecordTeardown',
    table: 'attendance_records',
    verb: 'delete',
    line: 1,
  }
  assert.equal(p16.claims(allowed), true)

  // Mutation A: new DELETE on a different table inside an otherwise allowed file/symbol.
  const differentTable = {
    ...allowed,
    table: 'attendance_events',
  }
  assert.equal(p16.claims(differentTable), false)
  const { unclaimed: unclaimedTable } = classifyTrackedSites([differentTable])
  assert.equal(unclaimedTable.length, 1, 'different table under allowed symbol must be unclaimed')

  // Mutation B: same table but different verb.
  const differentVerb = {
    ...allowed,
    verb: 'update',
  }
  assert.equal(p16.claims(differentVerb), false)
  const { unclaimed: unclaimedVerb } = classifyTrackedSites([differentVerb])
  assert.equal(unclaimedVerb.length, 1, 'different verb under allowed symbol must be unclaimed')

  // Mutation C: new DELETE inside an allowed staging file but different enclosingSymbol.
  const differentSymbol = {
    relPath: 'scripts/ops/staging-attendance-ae4-result-edit-smoke.mjs',
    enclosingSymbol: 'operatorShortcutDelete',
    table: 'attendance_records',
    verb: 'delete',
    line: 1,
  }
  assert.equal(p16.claims(differentSymbol), false)
  const { unclaimed: unclaimedSymbol } = classifyTrackedSites([differentSymbol])
  assert.equal(unclaimedSymbol.length, 1, 'new symbol DELETE must not inherit P16 by path prefix')
})

test('W4C-3c P15: generate-cleanup-sql never emits live DELETE on attendance_records', () => {
  const genPath = path.join(rootDir, 'scripts/attendance/generate-cleanup-sql.cjs')
  const gen = require(genPath)
  assert.throws(
    () => gen.buildCleanupSql({ source: 'dingtalk_csv_test' }),
    (error) => error?.code === 'ATTENDANCE_P15_ORG_REQUIRED',
  )
  const plan = gen.buildCleanupSql({ orgId: 'org-test', source: 'dingtalk_csv_test' })
  assert.equal(plan.forbidsRecordDelete, true)
  assert.equal(plan.requiresOpsRetirement, true)
  assert.equal(hasLiveDmlOnTable(plan.sql, 'delete', 'attendance_records'), false)
  assert.equal(
    scanFileForDmlSites('scripts/attendance/generate-cleanup-sql.cjs', plan.sql)
      .filter((site) => site.table === 'attendance_records' && site.verb === 'delete')
      .length,
    0,
  )
  assert.match(plan.sql, /ops_retirement/)
  assert.match(
    plan.sql,
    /EXISTS\s*\(\s*SELECT 1\s+FROM attendance_record_calculations c\s+WHERE c\.attendance_record_id = r\.id\s+AND c\.org_id = r\.org_id\s*\)/,
    'a calculation child alone must classify the parent as ops_retirement_required',
  )
})

test('W4C-3c mutation: inserting a new live DELETE or UPDATE bypass is caught', () => {
  const deleteBypass = [
    'async function operatorShortcut() {',
    '  await db.query(`DELETE FROM attendance_records WHERE org_id = $1`)',
    '}',
  ].join('\n')
  const updateBypass = [
    'async function sideDoorPatch() {',
    '  await db.query(`UPDATE attendance_records SET meta = $1 WHERE id = $2`)',
    '}',
  ].join('\n')

  const deleteClassified = classifyOneSyntheticSite(
    'scripts/ops/attendance-unlisted-operator-tool.mjs',
    deleteBypass,
  )
  const updateClassified = classifyOneSyntheticSite(
    'packages/core-backend/src/routes/attendance-evil-side-door.ts',
    updateBypass,
  )
  assert.equal(deleteClassified.trackedSites.length, 1)
  assert.equal(deleteClassified.trackedSites[0].verb, 'delete')
  assert.equal(updateClassified.trackedSites.length, 1)
  assert.equal(updateClassified.trackedSites[0].verb, 'update')

  const { unclaimed: unclaimedDelete } = classifyTrackedSites(deleteClassified.trackedSites)
  const { unclaimed: unclaimedUpdate } = classifyTrackedSites(updateClassified.trackedSites)
  assert.equal(unclaimedDelete.length, 1, 'live DELETE bypass must be unclaimed')
  assert.equal(unclaimedUpdate.length, 1, 'live UPDATE bypass must be unclaimed')

  // Comment-only reintroduction of the same text must NOT mint live DML sites.
  const commentOnly = '// DELETE FROM attendance_records\n// UPDATE attendance_records SET x = 1\n'
  assert.equal(scanFileForDmlSites('probe.cjs', commentOnly).length, 0)
  assert.equal(maskCommentsForDmlScan(commentOnly).includes('DELETE'), false)
  assert.equal(hasLiveDmlOnTable(commentOnly, 'delete', 'attendance_records'), false)
})

test('W4C-3c P05: post-write patch symbol is fully removed and no live second UPDATE exists', () => {
  const pluginSource = fs.readFileSync(path.join(rootDir, 'plugins/plugin-attendance/index.cjs'), 'utf8')

  // 1) Dead throw-only helper must not exist — symbol fully removed (P2).
  assert.doesNotMatch(
    pluginSource,
    /\bfunction attachManualResultEditMarkerToRecord\b|\battachManualResultEditMarkerToRecord\s*\(/,
    'attachManualResultEditMarkerToRecord must be fully removed, not retained as dead throw-only code',
  )

  // 2) Route goes through record-operation boundary (manual_edit), not direct apply alone.
  assert.match(pluginSource, /kind:\s*'manual_edit'/)
  assert.match(pluginSource, /createRecordOperationBoundary/)
  assert.match(pluginSource, /appendManualOverrideCalculation/)

  // 3) applyAttendanceResultEdit (legacy path only) must not itself UPDATE attendance_records.
  const applyMatch = pluginSource.match(
    /async function applyAttendanceResultEdit[\s\S]*?(?=\nasync function batchUpsertAttendanceRecordsValues)/,
  )
  assert.ok(applyMatch, 'applyAttendanceResultEdit must exist for legacy_projection_only')
  assert.equal(
    hasLiveDmlOnTable(applyMatch[0], 'update', 'attendance_records'),
    false,
    'applyAttendanceResultEdit must not contain a second live UPDATE attendance_records',
  )
  assert.match(applyMatch[0], /manual_result_edit:\s*frozenMarker/)
  assert.match(applyMatch[0], /upsertAttendanceRecord\s*\(/)

  // 4) Collector must not see any attachManual attendance_records DML site on HEAD.
  const source = createWorktreeSource(rootDir)
  const { sites } = buildRawCensus(source)
  const attachSites = sites.filter(
    (site) =>
      site.relPath === 'plugins/plugin-attendance/index.cjs'
      && site.enclosingSymbol === 'attachManualResultEditMarkerToRecord',
  )
  assert.deepEqual(attachSites, [], 'HEAD must not still have an attachManual DML site')
})

test('W4C-3c P20: singular host-port active-current module backs all four surfaces', () => {
  const pluginSource = fs.readFileSync(path.join(rootDir, 'plugins/plugin-attendance/index.cjs'), 'utf8')
  const decisionTrace = fs.readFileSync(
    path.join(rootDir, 'packages/core-backend/src/services/AttendanceDecisionTrace.ts'),
    'utf8',
  )
  const activeCurrent = fs.readFileSync(
    path.join(rootDir, 'packages/core-backend/src/attendance/w4c3c-active-current.ts'),
    'utf8',
  )
  const hostIndex = fs.readFileSync(path.join(rootDir, 'packages/core-backend/src/index.ts'), 'utf8')

  // Singular module + host port (not a plugin-local relation constant).
  assert.match(activeCurrent, /ATTENDANCE_ACTIVE_CURRENT_RELATION_V1/)
  assert.match(hostIndex, /activeCurrent:\s*Object\.freeze/)
  assert.match(pluginSource, /attendanceW4ActiveCurrentPort\s*=\s*attendanceW4SegmentCalculationPort\?\.activeCurrent/)
  assert.doesNotMatch(
    pluginSource,
    /const ATTENDANCE_ACTIVE_CURRENT_RELATION\s*=\s*'attendance_current_records'/,
    'plugin must not copy the relation constant; it must use the host port',
  )
  assert.match(pluginSource, /port\.listForAnomalyListing/)
  assert.match(pluginSource, /port\.loadForMakeupAnomalyFacts/)
  assert.match(pluginSource, /port\.listOpenForWorkDateResolver/)
  assert.match(decisionTrace, /loadActiveCurrentAttendanceRecordForDecisionTraceV1/)
})

test('W4C-3c P20 mutation: bypassing the host port on anomaly listing fails only that surface', () => {
  const pluginSource = fs.readFileSync(path.join(rootDir, 'plugins/plugin-attendance/index.cjs'), 'utf8')
  const mutated = pluginSource.replace(
    /async function listActiveCurrentAttendanceRecordsForAnomalyListing\(db, options\) \{\n  const port = requireAttendanceActiveCurrentPort\(\)\n  return port\.listForAnomalyListing\(pluginQueryAdapter\(db\), options\)\n\}/,
    `async function listActiveCurrentAttendanceRecordsForAnomalyListing(db, options) {
  return db.query('SELECT * FROM attendance_records WHERE user_id = $1', [options.userId])
}`,
  )
  assert.match(mutated, /FROM attendance_records WHERE user_id/)
  // Other surfaces still call the host port.
  assert.match(mutated, /port\.loadForMakeupAnomalyFacts/)
  assert.match(mutated, /port\.listOpenForWorkDateResolver/)
})

test('W4C-3c P21/P25 residual classifications closed honestly', () => {
  const byId = new Map(CURATED_DEBT_ENTRIES.map((entry) => [entry.id, entry]))
  assert.equal(byId.get('P21')?.canonicalizedBy, 'W4C-1/W4C-2')
  assert.equal(byId.get('P21')?.residualClassification, 'strict_parse_authority_closed_legacy_byte_preserved')
  assert.equal(byId.get('P25')?.canonicalizedBy, 'W4C-3a')
  for (const id of ['X01', 'X02', 'X03', 'X04', 'X05']) {
    assert.equal(byId.get(id)?.canonicalizedBy, 'W4C-3c-residual-classification')
    assert.ok(byId.get(id)?.residualClassification, `${id} must name its residual classification`)
    assert.ok(byId.get(id)?.residualEvidence, `${id} must carry evidence-backed residual classification`)
  }
})

test('W4C-3c mutation: new side-door business DML is unclaimed under hard zero-bypass', () => {
  const synthetic = {
    relPath: 'packages/core-backend/src/routes/evil-attendance-side-door.ts',
    enclosingSymbol: 'evilRewrite',
    table: 'attendance_records',
    verb: 'update',
    line: 1,
  }
  const { unclaimed } = classifyTrackedSites([synthetic])
  assert.equal(unclaimed.length, 1, 'a new business write side door must not inherit any P0x claim')
})

test('W4C-3c operator retirement path exists and forbids live DELETE', () => {
  const opsPath = path.join(rootDir, 'packages/core-backend/src/attendance/w4c3c-ops-retirement.ts')
  const source = fs.readFileSync(opsPath, 'utf8')
  assert.match(source, /appendOperatorRetirementCalculationV1/)
  assert.match(source, /operator_retirement/)
  assert.match(source, /ops_retirement/)
  assert.match(source, /set_retired/)
  assert.equal(
    hasLiveDmlOnTable(source, 'delete', 'attendance_records'),
    false,
    'ops-retirement module must not contain live DELETE on attendance_records',
  )
  assert.match(source, /assertToolingOnlyNonW4FixtureTeardownAllowedV1/)
  assert.match(source, /ATTENDANCE_RECORD_OPERATOR_RETIRED/)
})

test('W4C-3c mutation: reintroducing live second UPDATE after result edit is caught by scanner', () => {
  const reintroduced = [
    'async function attachManualResultEditMarkerToRecord(trx, record, marker) {',
    '  await trx.query(`UPDATE attendance_records SET meta = $3 WHERE id = $1 AND org_id = $2`, [record.id, record.org_id, marker])',
    '}',
  ].join('\n')
  const sites = scanFileForDmlSites('plugins/plugin-attendance/index.cjs', reintroduced)
  assert.equal(sites.length, 1)
  assert.equal(sites[0].verb, 'update')
  assert.equal(sites[0].enclosingSymbol, 'attachManualResultEditMarkerToRecord')
  // Historical-only claim is gone: current P05 must not absorb this reintroduction by symbol name alone
  // when the site is a brand-new write (it would claim by symbol if we kept the crutch — prove we did not).
  const p05 = CURATED_DEBT_ENTRIES.find((entry) => entry.id === 'P05')
  assert.equal(p05.claims(sites[0]), false)
  const classified = classifyCensus(sites)
  const { unclaimed } = classifyTrackedSites(classified.trackedSites)
  assert.equal(unclaimed.length, 1, 'reintroduced post-write UPDATE must be unclaimed open debt')
})
