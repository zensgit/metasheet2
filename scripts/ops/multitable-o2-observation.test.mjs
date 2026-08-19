// Self-test for the O-2 observation kit:
//   scripts/ops/multitable-o2-observation.sql   (read-only ladder observation queries)
//   scripts/ops/multitable-o2-canary-drill.md   (L4/L5 canary drill runbook)
//
// Hermetic: no database, no network, no pnpm install — `node --test` against the
// checked-out tree only (same shape as data-source-exposure-inventory.test.mjs / its
// standalone workflow). What a hermetic test CAN prove here:
//   * the SQL file is read-only by construction (statement-head census, with a positive
//     control proving the census would catch a write statement);
//   * the query set and its per-ladder-level shape documentation are complete;
//   * the trigger/function/lock-key literals the queries observe are the SAME literals the
//     authoritative migration installs (drift guard — a migration change reds this test);
//   * every host-reaching command mentioned in the runbook is OWNER-GATED (again with a
//     positive control proving the scanner catches an unmarked command);
//   * every evidence-anchor path the runbook cites exists in the tree.
// What it can NOT prove (and does not claim): that the queries return the documented
// shapes against a real database — that evidence leg is produced by running the .sql file
// against a freshly migrated scratch DB (recorded in the authoring branch's evidence).

import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const SQL_PATH = resolve(HERE, 'multitable-o2-observation.sql')
const RUNBOOK_PATH = resolve(HERE, 'multitable-o2-canary-drill.md')
const AUTHORITY_MIGRATION_PATH = resolve(
  ROOT,
  'packages/core-backend/src/db/migrations/zzzz20260721121000_add_recovery_authority_locks.ts',
)
const FENCE_MODULE_PATH = resolve(ROOT, 'packages/core-backend/src/multitable/canonical-sheet-fence.ts')

const sqlText = readFileSync(SQL_PATH, 'utf8')
const runbookText = readFileSync(RUNBOOK_PATH, 'utf8')
const migrationText = readFileSync(AUTHORITY_MIGRATION_PATH, 'utf8')
const fenceText = readFileSync(FENCE_MODULE_PATH, 'utf8')

// ---------------------------------------------------------------------------
// SQL statement census helpers
// ---------------------------------------------------------------------------

/** Strip `-- …` line comments, keep everything else. */
function stripLineComments(sql) {
  return sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--')
      return idx === -1 ? line : line.slice(0, idx)
    })
    .join('\n')
}

/** Split into statements on `;`. Sound ONLY while the file has no dollar-quoting /
 *  procedural bodies — asserted separately below. */
function splitStatements(sql) {
  return stripLineComments(sql)
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Returns the list of statements whose head keyword is NOT read-only. */
function findNonReadonlyStatements(sql) {
  const offenders = []
  for (const stmt of splitStatements(sql)) {
    const head = stmt.split(/\s+/, 1)[0]?.toUpperCase() ?? ''
    if (head !== 'SELECT' && head !== 'WITH') offenders.push(head)
  }
  return offenders
}

test('SQL: no dollar-quoting, so the statement splitter is sound', () => {
  assert.ok(!sqlText.includes('$$'), 'observation SQL must not contain $$ bodies')
})

test('SQL: every statement is SELECT/WITH (read-only by construction)', () => {
  assert.deepEqual(findNonReadonlyStatements(sqlText), [])
})

test('SQL: read-only census POSITIVE CONTROL — a write statement IS flagged', () => {
  // The census must not be vacuous: feed it a doctored copy and require a hit.
  const doctored = sqlText + "\nUPDATE meta_sheets SET name = 'x';\n"
  assert.deepEqual(findNonReadonlyStatements(doctored), ['UPDATE'])
  // Statement-head trickery (comment before the verb) is also caught.
  const sneaky = sqlText + '\n-- harmless\nDELETE FROM meta_sheets;\n'
  assert.deepEqual(findNonReadonlyStatements(sneaky), ['DELETE'])
})

test('SQL: balanced parentheses per statement (parse-shape sanity)', () => {
  for (const stmt of splitStatements(sqlText)) {
    let depth = 0
    for (const ch of stmt) {
      if (ch === '(') depth += 1
      if (ch === ')') depth -= 1
      assert.ok(depth >= 0, `unbalanced ')' in statement head: ${stmt.slice(0, 60)}`)
    }
    assert.equal(depth, 0, `unbalanced '(' in statement head: ${stmt.slice(0, 60)}`)
  }
})

// ---------------------------------------------------------------------------
// Query-tag completeness + per-level shape docs
// ---------------------------------------------------------------------------

const EXPECTED_TAGS = ['Q1', 'Q2', 'Q3', 'Q3b', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8']

/** The comment+query section for a tag: from its section rule to the tagged statement's `;`. */
function sectionFor(tag) {
  const lines = sqlText.split('\n')
  const tagIdx = lines.findIndex((l) => l.trim() === `-- ${tag}`)
  assert.notEqual(tagIdx, -1, `missing tag line "-- ${tag}"`)
  // Section start: walk back to the previous '-- ---…' rule.
  let start = tagIdx
  while (start > 0 && !/^-- -{10,}/.test(lines[start])) start -= 1
  // Statement end: first subsequent line ending with ';'.
  let end = tagIdx + 1
  while (end < lines.length && !/;\s*$/.test(lines[end])) end += 1
  assert.ok(end < lines.length, `tag ${tag}: no terminating ';'`)
  return lines.slice(start, end + 1).join('\n')
}

test('SQL: exactly the 9 documented queries, each tagged once', () => {
  for (const tag of EXPECTED_TAGS) {
    const hits = sqlText.split('\n').filter((l) => l.trim() === `-- ${tag}`).length
    assert.equal(hits, 1, `tag -- ${tag} must appear exactly once, found ${hits}`)
  }
})

test('SQL: every query documents its EXPECTED SHAPE, mentioning the L0 baseline', () => {
  for (const tag of EXPECTED_TAGS) {
    const section = sectionFor(tag)
    assert.match(section, /EXPECTED SHAPE/, `${tag}: missing EXPECTED SHAPE block`)
    assert.match(
      section,
      /L0|Always|every level|Idle database/i,
      `${tag}: shape block must state the baseline-level expectation`,
    )
  }
})

test('SQL: honest sink inventory is present (no fabricated 409/40001 sinks)', () => {
  assert.match(sqlText, /HONEST SINK INVENTORY/)
  assert.match(sqlText, /NO cumulative counter of\s*--\s*SQLSTATE 40001|NO cumulative counter/)
  assert.match(sqlText, /NO\s*--\s*queryable DB sink|NO queryable DB sink/i)
})

// ---------------------------------------------------------------------------
// Drift guards against the authoritative migration / fence module
// ---------------------------------------------------------------------------

/** Parse RECOVERY_AUTHORITY_TRIGGERS = [ ['table','trigger'], … ] from the migration. */
function parseAuthorityTriggerPairs() {
  const m = migrationText.match(/RECOVERY_AUTHORITY_TRIGGERS = \[([\s\S]*?)\] as const/)
  assert.ok(m, 'RECOVERY_AUTHORITY_TRIGGERS array not found in the authority migration')
  const pairs = [...m[1].matchAll(/\['([^']+)',\s*'([^']+)'\]/g)].map((x) => [x[1], x[2]])
  return pairs
}

test('drift guard: Q1 lists the migration\'s exact trigger set (9 pairs, verbatim)', () => {
  const pairs = parseAuthorityTriggerPairs()
  assert.equal(pairs.length, 9, 'authority migration must declare 9 triggers')
  assert.equal(new Set(pairs.map(([t]) => t)).size, 8, 'authority triggers must span 8 tables')
  const q1 = sectionFor('Q1')
  for (const [table, trigger] of pairs) {
    assert.ok(
      new RegExp(`\\('${table}',\\s*'${trigger}'\\)`).test(q1.replace(/\s+/g, ' ')),
      `Q1 missing pair ('${table}', '${trigger}')`,
    )
  }
  // Closed set: Q1 must not observe triggers the migration does not declare.
  const q1Triggers = [...q1.matchAll(/'(trg_[a-z_]+)'/g)].map((x) => x[1])
  assert.deepEqual(new Set(q1Triggers), new Set(pairs.map(([, trg]) => trg)))
})

test('drift guard: Q2 lists the migration\'s six function names', () => {
  const names = [...migrationText.matchAll(/^export const AUTHORITY_[A-Z_]*FUNCTION = '([a-z_]+)'/gm)].map(
    (x) => x[1],
  )
  assert.equal(names.length, 6, 'authority migration must export 6 function-name constants')
  const q2 = sectionFor('Q2')
  for (const fn of names) assert.ok(q2.includes(`'${fn}'`), `Q2 missing function '${fn}'`)
})

test('drift guard: Q3 derives keys with the production lock-key literals', () => {
  const q3 = sectionFor('Q3')
  for (const prefix of [
    'metasheet:recovery-authority:user:',
    'metasheet:recovery-authority:role:',
    'metasheet:recovery-authority:group:',
  ]) {
    assert.ok(migrationText.includes(`'${prefix}'`), `migration lost prefix ${prefix}`)
    assert.ok(q3.includes(`'${prefix}'`), `Q3 missing prefix ${prefix}`)
  }
  assert.ok(fenceText.includes('meta:auto-number:sheet:'), 'fence module lost its key prefix')
  assert.ok(q3.includes("'meta:auto-number:sheet:'"), 'Q3 missing the canonical fence key prefix')
  // Same derivation functions as production: hashtextextended(…, 0) / hashtext(…)::bigint.
  assert.match(q3, /hashtextextended\(/)
  assert.match(q3, /hashtext\('meta:auto-number:sheet:' \|\| subject_id\)::bigint/)
})

test('drift guard: observed tables exist in migrations (no phantom sinks)', () => {
  // Each table an expect-zero query reads must be created somewhere under migrations —
  // guards against the observation kit outliving a dropped/renamed sink.
  const created = {
    meta_recovery_token_burns: 'zzzz20260719120000_create_meta_recovery_token_burns.ts',
    meta_records_trash: 'zzzz20260617120000_create_meta_records_trash.ts',
  }
  for (const [table, file] of Object.entries(created)) {
    const p = resolve(ROOT, 'packages/core-backend/src/db/migrations', file)
    assert.ok(existsSync(p), `${file} missing`)
    assert.ok(readFileSync(p, 'utf8').includes(table), `${file} no longer creates ${table}`)
    assert.ok(sqlText.includes(table), `observation SQL no longer reads ${table}`)
  }
  assert.match(
    readFileSync(
      resolve(ROOT, 'packages/core-backend/src/db/migrations/zzzz20260715170000_add_meta_sheet_recovery_writer_state.ts'),
      'utf8',
    ),
    /recovery_writer_state/,
  )
  assert.ok(sqlText.includes('recovery_writer_state'), 'Q7 lost its column')
})

// ---------------------------------------------------------------------------
// Runbook: host-reaching commands must be OWNER-GATED
// ---------------------------------------------------------------------------

const HOST_COMMAND_RE = /\b(ssh|scp|rsync|kubectl|gh workflow run|docker exec|docker compose)\b/i

/** Split markdown into blocks: a block is a list item (with its indented continuation
 *  lines), a table row, a heading, or a blank-line-separated paragraph. */
function markdownBlocks(md) {
  const blocks = []
  let current = []
  for (const line of md.split('\n')) {
    const isNewBlock = /^\s*$/.test(line) || /^\s*[-*] /.test(line) || /^#/.test(line) || /^\|/.test(line) || /^> /.test(line)
    if (isNewBlock && current.length > 0) {
      blocks.push(current.join('\n'))
      current = []
    }
    if (!/^\s*$/.test(line)) current.push(line)
  }
  if (current.length > 0) blocks.push(current.join('\n'))
  return blocks
}

/** Blocks that mention a host-reaching command but are not marked OWNER-GATED. */
function findUngatedHostCommands(md) {
  return markdownBlocks(md).filter((b) => HOST_COMMAND_RE.test(b) && !b.includes('OWNER-GATED'))
}

test('runbook: every host-reaching command block is OWNER-GATED', () => {
  const ungated = findUngatedHostCommands(runbookText)
  assert.deepEqual(ungated, [], `ungated host-reaching blocks:\n${ungated.join('\n---\n')}`)
})

test('runbook: gating scan is not vacuous — commands exist AND the scanner catches an unmarked one', () => {
  // Positive control 1: the runbook genuinely mentions host-reaching commands (else the
  // "all gated" assertion above would be green against nothing).
  const gatedMentions = markdownBlocks(runbookText).filter((b) => HOST_COMMAND_RE.test(b))
  assert.ok(gatedMentions.length >= 2, 'expected ≥2 host-command mentions in the runbook')
  // Positive control 2: an unmarked command in a doctored copy IS caught.
  const doctored = runbookText + '\n\n- [ ] run `ssh deploy@host disable-triggers.sh` now\n'
  assert.equal(findUngatedHostCommands(doctored).length, 1)
})

test('runbook: declares itself non-executing and authorization-free', () => {
  assert.match(runbookText, /this runbook executes nothing by itself/i)
  assert.match(runbookText, /no new\s*\n?\s*> remote-reaching automation|no new remote-reaching automation/i)
  assert.match(runbookText, /grants no authorization/i)
})

test('runbook: every cited repo path exists', () => {
  const cited = [...runbookText.matchAll(/`((?:packages|scripts|docs|\.github)\/[^`\n]+)`/g)].map((m) => m[1])
  assert.ok(cited.length >= 10, `expected ≥10 cited repo paths, found ${cited.length}`)
  for (const p of cited) {
    assert.ok(existsSync(resolve(ROOT, p)), `runbook cites missing path: ${p}`)
  }
})

test('runbook: contains the ladder §4 no-40P01 link-in concurrent-write step for BOTH rungs', () => {
  assert.match(runbookText, /no-40P01/i)
  assert.match(runbookText, /deadlocks.*delta.*=\s*0|deadlock delta.*0/i)
  assert.match(runbookText, /repeated for reset/i)
})

// ---------------------------------------------------------------------------
// Workflow path-filter closed-world guard (gate #5018 NIT-1)
// ---------------------------------------------------------------------------
// The "every cited repo path exists" test above makes this kit red when any cited
// file is renamed — but the kit's workflow only runs when a path in its `paths:`
// filters changes. If a cited path is missing from the filters, the renaming PR
// lands green and the kit goes stale-red on a later, unrelated PR. So: every
// runbook-cited repo path must appear in BOTH trigger path filters, mechanically.

const KIT_WORKFLOW_PATH = resolve(ROOT, '.github/workflows/multitable-o2-observation-kit.yml')
const kitWorkflowText = readFileSync(KIT_WORKFLOW_PATH, 'utf8')

/** Every `- 'entry'` list under each `paths:` key, in file order (comments/blanks skipped). */
function workflowPathSections(ymlText) {
  const sections = []
  const lines = ymlText.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*paths:\s*$/.test(lines[i])) continue
    const entries = []
    for (let j = i + 1; j < lines.length; j++) {
      const entry = lines[j].match(/^\s*-\s*'([^']+)'\s*$/)
      if (entry) {
        entries.push(entry[1])
        continue
      }
      if (/^\s*#/.test(lines[j])) continue
      break
    }
    sections.push(entries)
  }
  return sections
}

/** Cited paths absent from any section, as `section#i: path` strings; [] = fully filtered. */
function missingFilterEntries(ymlText, citedPaths) {
  const sections = workflowPathSections(ymlText)
  const missing = []
  sections.forEach((entries, i) => {
    for (const p of citedPaths) {
      if (!entries.includes(p)) missing.push(`paths-section#${i + 1} (of ${sections.length}): ${p}`)
    }
  })
  return missing
}

function runbookCitedPaths() {
  // Deduplicated: the runbook may cite the same path in several sections.
  return [...new Set([...runbookText.matchAll(/`((?:packages|scripts|docs|\.github)\/[^`\n]+)`/g)].map((m) => m[1]))]
}

test('workflow: every runbook-cited repo path is in BOTH trigger path filters (renames re-run the kit on the renaming PR)', () => {
  const sections = workflowPathSections(kitWorkflowText)
  // Anti-vacuity: the parser must find exactly the pull_request and push filters,
  // each carrying at least the four kit files + five drift-guard sources.
  assert.equal(sections.length, 2, `expected 2 paths: sections (pull_request + push), found ${sections.length}`)
  for (const entries of sections) {
    assert.ok(entries.length >= 9, `paths: section unexpectedly small (${entries.length} entries)`)
  }
  const cited = runbookCitedPaths()
  assert.ok(cited.length >= 10, `expected ≥10 cited repo paths, found ${cited.length}`)
  const missing = missingFilterEntries(kitWorkflowText, cited)
  assert.deepEqual(missing, [], `runbook-cited paths missing from workflow path filters:\n${missing.join('\n')}`)
})

test('workflow filter guard is not vacuous: removing a cited path from one filter IS caught', () => {
  const cited = runbookCitedPaths()
  const victim = 'packages/core-backend/tests/unit/recovery-conflict-census.test.ts'
  // Anchor: the victim must genuinely be cited AND genuinely present before removal.
  assert.ok(cited.includes(victim), 'victim path is no longer cited by the runbook')
  assert.equal(missingFilterEntries(kitWorkflowText, cited).length, 0)
  const doctoredLines = kitWorkflowText.split('\n')
  const idx = doctoredLines.findIndex((l) => l.includes(`- '${victim}'`))
  assert.ok(idx >= 0, 'victim path line not found in workflow')
  doctoredLines.splice(idx, 1)
  const missing = missingFilterEntries(doctoredLines.join('\n'), cited)
  assert.deepEqual(missing, [`paths-section#1 (of 2): ${victim}`])
})
