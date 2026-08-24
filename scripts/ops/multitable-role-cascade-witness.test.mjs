import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { CANONICAL_ROLES_SCHEMA, FK_DELETE_ACTION_LETTERS, ROLE_DELETE_CHILD_WRITE_ACTIONS, buildRoleCascadeWitnessQuery } from './multitable-l1-battery.mjs'
import {
  HEADLINES,
  INDETERMINATE_REASONS,
  PROTOCOL,
  buildRelationPresenceQuery,
  buildProbeSource,
  classifyObservation,
  parseWitnessObservation,
  renderSummary,
  runVerdict,
} from './multitable-role-cascade-witness.mjs'

/**
 * Hermetic self-test for the role-cascade witness.
 *
 * No database, no docker, no hosts, no node_modules — `node --test` straight against the checked-out
 * tree, the same shape as the rest of the O-2 kit (registered in
 * .github/workflows/multitable-o2-observation-kit.yml, an always-on `pull_request:` lane with no
 * path filter, which is where a cross-file sync pin has to live).
 *
 * The load-bearing property under test is NOT "does it detect a cascade" — that predicate belongs to
 * the battery and is tested there. It is "can an observation that never happened be reported as
 * ABSENT". Every failure shape below must land in INDETERMINATE.
 *
 * Run: node --test scripts/ops/multitable-role-cascade-witness.test.mjs
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')
const workflowsDir = path.join(repoRoot, '.github', 'workflows')
const workflowPath = path.join(workflowsDir, 'multitable-role-cascade-witness.yml')
const workflowRaw = readFileSync(workflowPath, 'utf8')
const runnerRaw = readFileSync(path.join(here, 'multitable-role-cascade-witness.mjs'), 'utf8')

// The canonical-schema renderings the production dispatch uses. The static-shape tests below assert
// against THESE, so a change that only holds for a random golden schema cannot pass them.
const WITNESS_SQL = buildRoleCascadeWitnessQuery(CANONICAL_ROLES_SCHEMA)
const PRESENCE_SQL = buildRelationPresenceQuery(CANONICAL_ROLES_SCHEMA)

/** A witness ROWS entry. Every field is required by the protocol, so the helper supplies them all. */
function row({ schema = 'public', table = 'role_permissions', conname = 'role_permissions_role_id_fkey', confdeltype = 'c' } = {}) {
  return { child_schema: schema, child_table: table, conname, confdeltype }
}

const PRESENT_RELATIONS = Object.freeze({
  canonical_schema: 'public',
  canonical_roles_present: true,
  session_binds_canonical: true,
  session_roles_schema: 'public',
  visible_roles_relations: 1,
  canonical_exact_carriers: 8,
  recovery_authority_relations: 8,
  roles_referencing_fks: 1,
})

function observation({ presence = PRESENT_RELATIONS, rows = [] } = {}) {
  return [
    '== multitable role-cascade witness (read-only) ==',
    `${PROTOCOL} BEGIN`,
    `${PROTOCOL} PRESENCE ${JSON.stringify(presence)}`,
    `${PROTOCOL} ROWS ${JSON.stringify(rows)}`,
    `${PROTOCOL} END ok`,
    'probe exit code: 0',
    'OBSERVATION: COMPLETE',
    '',
  ].join('\n')
}

function verdictFor(text) {
  return classifyObservation(parseWitnessObservation(text))
}

// ---------------------------------------------------------------------------
// 1. The three outcomes
// ---------------------------------------------------------------------------

test('empty rows ⇒ CASCADE ABSENT / premise CONFIRMED / exit 0', () => {
  const verdict = verdictFor(observation({ rows: [] }))
  assert.equal(verdict.verdict, 'ABSENT')
  assert.equal(verdict.premise, 'CONFIRMED')
  assert.equal(verdict.exitCode, 0)
  assert.equal(verdict.headline, HEADLINES.ABSENT)
  assert.equal(verdict.headline, 'CASCADE ABSENT (premise CONFIRMED)')
})

test("confdeltype 'c' ⇒ CASCADE PRESENT / premise REFUTED / exit 1", () => {
  const verdict = verdictFor(observation({ rows: [row({ confdeltype: 'c' })] }))
  assert.equal(verdict.verdict, 'PRESENT')
  assert.equal(verdict.premise, 'REFUTED')
  assert.equal(verdict.exitCode, 1)
  assert.equal(verdict.headline, HEADLINES.PRESENT)
  // The headline must name the consequence, not just the observation: a reader of the run list has
  // to see that the battery would refuse to produce evidence at all.
  assert.match(verdict.headline, /not_driven_reason_expired/)
})

test("'n' (SET NULL) and 'd' (SET DEFAULT) UPDATE the child row ⇒ PRESENT, not ABSENT", () => {
  // The nine recovery-authority triggers are BEFORE INSERT OR UPDATE OR DELETE
  // (zzzz20260721121000_add_recovery_authority_locks.ts). SET NULL and SET DEFAULT update the child
  // row on a parent delete, so they fire it exactly as CASCADE does. Reading them as "not a
  // cascade" — as this witness originally did — reports a live, blockable roles:delete as excused.
  for (const confdeltype of ['n', 'd']) {
    const verdict = verdictFor(observation({ rows: [row({ table: 'user_roles', conname: 'user_roles_role_id_fkey', confdeltype })] }))
    assert.equal(verdict.verdict, 'PRESENT', `confdeltype '${confdeltype}' writes the child row and must refute the premise`)
    assert.equal(verdict.exitCode, 1)
    // The refutation must name what refuted it, not just that something did.
    assert.match(verdict.detail, /public\.user_roles/)
    assert.match(verdict.detail, new RegExp(`confdeltype=${confdeltype}`))
  }
})

test("'a' (NO ACTION) and 'r' (RESTRICT) perform no child DML ⇒ still ABSENT", () => {
  // These two REFUSE the parent delete rather than write the child, so no trigger can fire and the
  // excuse survives. A predicate that accepted every FK would get both backwards.
  for (const confdeltype of ['a', 'r']) {
    const verdict = verdictFor(observation({ rows: [row({ confdeltype })] }))
    assert.equal(verdict.verdict, 'ABSENT', `confdeltype '${confdeltype}' must not read as a child write`)
    assert.equal(verdict.exitCode, 0)
  }
  // Prove the discriminator by mixing a writing row into the same result set.
  const mixed = verdictFor(observation({
    rows: [
      row({ conname: 'rp_roles_restrict', confdeltype: 'r' }),
      row({ conname: 'rp_roles_cascade', confdeltype: 'c' }),
    ],
  }))
  assert.equal(mixed.verdict, 'PRESENT')
  assert.equal(mixed.exitCode, 1)
})

test('user_roles alone refutes the premise — the two children are independent outcomes', () => {
  // 033_create_rbac_core.sql creates role_permissions.role_id (:17) AND user_roles.role_id (:36) as
  // separate `REFERENCES roles(id) ON DELETE CASCADE` under separate CREATE TABLE IF NOT EXISTS, so
  // a database can carry one without the other. user_roles carries
  // trg_user_roles_recovery_authority_lock, so its cascade expires the excuse on its own.
  const verdict = verdictFor(observation({
    rows: [row({ table: 'user_roles', conname: 'user_roles_role_id_fkey', confdeltype: 'c' })],
  }))
  assert.equal(verdict.verdict, 'PRESENT')
  assert.equal(verdict.exitCode, 1)
  assert.match(verdict.detail, /user_roles_role_id_fkey/)
})

// ---------------------------------------------------------------------------
// 2. Fail-closed: every unobserved shape is INDETERMINATE, never ABSENT
// ---------------------------------------------------------------------------

const INDETERMINATE_CASES = [
  {
    label: 'empty capture (ssh produced nothing)',
    text: '',
    reason: INDETERMINATE_REASONS.observationEmpty,
  },
  {
    label: 'whitespace-only capture',
    text: '   \n\n  ',
    reason: INDETERMINATE_REASONS.observationEmpty,
  },
  {
    label: 'container missing — remote refused before the probe ran',
    text: [
      '== multitable role-cascade witness (read-only) ==',
      "target='production' -> container='metasheet-backend'",
      "OBSERVATION: FAIL — expected container 'metasheet-backend' is NOT running; nothing observed is not evidence that no cascade exists",
    ].join('\n'),
    reason: INDETERMINATE_REASONS.incomplete,
  },
  {
    label: 'DATABASE_URL unreadable inside the container',
    text: [
      `${PROTOCOL} BEGIN`,
      `${PROTOCOL} ERROR database_url_unreadable DATABASE_URL is unset or empty inside this container`,
      `${PROTOCOL} END error`,
    ].join('\n'),
    reason: INDETERMINATE_REASONS.probeError,
  },
  {
    label: 'psql/pg query failed',
    text: [
      `${PROTOCOL} BEGIN`,
      `${PROTOCOL} ERROR query_failed permission denied for schema pg_catalog`,
      `${PROTOCOL} END error`,
    ].join('\n'),
    reason: INDETERMINATE_REASONS.probeError,
  },
  {
    label: 'truncated capture (connection dropped mid-observation)',
    text: [
      `${PROTOCOL} BEGIN`,
      `${PROTOCOL} PRESENCE ${JSON.stringify(PRESENT_RELATIONS)}`,
    ].join('\n'),
    reason: INDETERMINATE_REASONS.incomplete,
  },
  {
    label: 'two complete observations in one capture (which host answered?)',
    text: observation({ rows: [] }) + observation({ rows: [] }),
    reason: INDETERMINATE_REASONS.incomplete,
  },
  {
    label: 'unparseable ROWS payload',
    text: [
      `${PROTOCOL} BEGIN`,
      `${PROTOCOL} PRESENCE ${JSON.stringify(PRESENT_RELATIONS)}`,
      `${PROTOCOL} ROWS [{"conname":`,
      `${PROTOCOL} END ok`,
    ].join('\n'),
    reason: INDETERMINATE_REASONS.unparseable,
  },
  {
    label: 'ROWS is not an array of objects',
    text: [
      `${PROTOCOL} BEGIN`,
      `${PROTOCOL} PRESENCE ${JSON.stringify(PRESENT_RELATIONS)}`,
      `${PROTOCOL} ROWS ["role_permissions_role_id_fkey"]`,
      `${PROTOCOL} END ok`,
    ].join('\n'),
    reason: INDETERMINATE_REASONS.unparseable,
  },
  {
    label: 'a ROWS entry is missing confdeltype',
    text: [
      `${PROTOCOL} BEGIN`,
      `${PROTOCOL} PRESENCE ${JSON.stringify(PRESENT_RELATIONS)}`,
      `${PROTOCOL} ROWS [{"child_schema":"public","child_table":"role_permissions","conname":"rp_roles_fk"}]`,
      `${PROTOCOL} END ok`,
    ].join('\n'),
    reason: INDETERMINATE_REASONS.unparseable,
  },
  {
    label: 'a ROWS entry is missing child_table — the verdict would name no relation',
    text: [
      `${PROTOCOL} BEGIN`,
      `${PROTOCOL} PRESENCE ${JSON.stringify(PRESENT_RELATIONS)}`,
      `${PROTOCOL} ROWS [{"child_schema":"public","conname":"rp_roles_fk","confdeltype":"c"}]`,
      `${PROTOCOL} END ok`,
    ].join('\n'),
    reason: INDETERMINATE_REASONS.unparseable,
  },
  {
    label: 'a ROWS entry is missing child_schema — a shadow-schema hit would be unattributable',
    text: [
      `${PROTOCOL} BEGIN`,
      `${PROTOCOL} PRESENCE ${JSON.stringify(PRESENT_RELATIONS)}`,
      `${PROTOCOL} ROWS [{"child_table":"role_permissions","conname":"rp_roles_fk","confdeltype":"c"}]`,
      `${PROTOCOL} END ok`,
    ].join('\n'),
    reason: INDETERMINATE_REASONS.unparseable,
  },
  {
    label: 'positive control: no relation carries a canonical recovery-authority trigger',
    text: observation({ presence: { ...PRESENT_RELATIONS, canonical_exact_carriers: 0 }, rows: [] }),
    reason: INDETERMINATE_REASONS.relationsAbsent,
  },
  {
    label: 'door 1: the canonical `roles` relation does not exist on the observed database',
    text: observation({ presence: { ...PRESENT_RELATIONS, canonical_roles_present: false }, rows: [] }),
    reason: INDETERMINATE_REASONS.canonicalRelationAbsent,
  },
  {
    label: 'door 2: the session resolves `roles` to a NON-canonical schema (the shadow vector)',
    text: observation({ presence: { ...PRESENT_RELATIONS, session_binds_canonical: false, session_roles_schema: 'metasheet' }, rows: [] }),
    reason: INDETERMINATE_REASONS.bindingMismatch,
  },
  {
    label: 'door 3: a second `roles` table is visible on the search_path',
    text: observation({ presence: { ...PRESENT_RELATIONS, visible_roles_relations: 2 }, rows: [] }),
    reason: INDETERMINATE_REASONS.relationAmbiguous,
  },
  {
    label: 'door 3: NO `roles` table is visible on the search_path',
    text: observation({ presence: { ...PRESENT_RELATIONS, visible_roles_relations: 0 }, rows: [] }),
    reason: INDETERMINATE_REASONS.relationAmbiguous,
  },
  {
    label: 'PRESENCE counts are not numbers',
    text: observation({ presence: { ...PRESENT_RELATIONS, visible_roles_relations: 'yes', canonical_exact_carriers: 'yes', recovery_authority_relations: 'yes', roles_referencing_fks: 'yes' }, rows: [] }),
    reason: INDETERMINATE_REASONS.unparseable,
  },
  {
    label: 'PRESENCE is a pre-canonical-binding capture from an older probe',
    text: observation({ presence: { roles: 1, recovery_authority_relations: 1, roles_referencing_fks: 1 }, rows: [] }),
    reason: INDETERMINATE_REASONS.unparseable,
  },
]

test('the protocol is VALIDATED, not coerced — malformed payloads are unreadable, never absence', () => {
  // `String()` and `Number()` manufacture a well-formed-looking observation out of junk:
  // `Number(true)` is 1, `Number(null)` is 0, `String(7)` is a non-empty string. Against head
  // cd0977e3c0, sending `true` for all four counts, and sending `{child_schema: 1, child_table:
  // true, conname: 2, confdeltype: 7}` as a row, BOTH returned CASCADE ABSENT / exit 0. The parse
  // has to reject the RAW JSON before anything is converted.
  const counts = { visible_roles_relations: 1, canonical_exact_carriers: 9, recovery_authority_relations: 9, roles_referencing_fks: 1 }
  const bound = { canonical_schema: 'public', canonical_roles_present: true, session_binds_canonical: true, session_roles_schema: 'public' }

  // Counts: booleans, nulls, empty strings, floats, negatives, leading-zero and exponent strings.
  for (const field of Object.keys(counts)) {
    for (const junk of [true, false, null, '', ' 1', '01', '1e3', 1.5, -1, [], {}, '1 ']) {
      const verdict = verdictFor(observation({ presence: { ...bound, ...counts, [field]: junk } }))
      assert.equal(verdict.verdict, 'INDETERMINATE', `${field}=${JSON.stringify(junk)} was accepted`)
      assert.equal(verdict.exitCode, 2, `${field}=${JSON.stringify(junk)} did not fail closed`)
      assert.equal(verdict.reason, INDETERMINATE_REASONS.unparseable, `${field}=${JSON.stringify(junk)}`)
      assert.match(verdict.detail, new RegExp(field), 'the detail must name the offending field')
    }
    // …and the strict decimal STRING form is still accepted, because node-postgres returns
    // `count(*)` as a string and the shared classifier is fed straight from a pg row.
    const ok = verdictFor(observation({ presence: { ...bound, ...counts, [field]: '3' }, rows: [] }))
    assert.notEqual(ok.reason, INDETERMINATE_REASONS.unparseable, `${field} rejected the decimal string form pg actually returns`)
  }

  // Row fields: every non-string type, on every field.
  for (const field of ['child_schema', 'child_table', 'conname', 'confdeltype']) {
    for (const junk of [1, true, null, undefined, [], {}, 7.5]) {
      const row = { child_schema: 'public', child_table: 'user_roles', conname: 'fk', confdeltype: 'c', [field]: junk }
      const verdict = verdictFor(observation({ presence: { ...bound, ...counts }, rows: [row] }))
      assert.equal(verdict.verdict, 'INDETERMINATE', `${field}=${JSON.stringify(junk)} was accepted`)
      assert.equal(verdict.reason, INDETERMINATE_REASONS.unparseable, `${field}=${JSON.stringify(junk)}`)
    }
  }

  // confdeltype must be a letter the CATALOG can produce. Anything else is unreadable — NOT
  // "some action that happens not to write the child", which is how it used to read.
  for (const junk of ['z', '7', '', 'C', 'cc', ' c']) {
    const row = { child_schema: 'public', child_table: 'user_roles', conname: 'fk', confdeltype: junk }
    const verdict = verdictFor(observation({ presence: { ...bound, ...counts }, rows: [row] }))
    assert.equal(verdict.verdict, 'INDETERMINATE', `confdeltype ${JSON.stringify(junk)} was accepted`)
    assert.match(verdict.detail, /not a legal foreign-key delete action/)
  }
  // POSITIVE CONTROL for all of the above: the legal letters still classify, both ways.
  for (const [letter, expected] of [['c', 'PRESENT'], ['n', 'PRESENT'], ['d', 'PRESENT'], ['a', 'ABSENT'], ['r', 'ABSENT']]) {
    const row = { child_schema: 'public', child_table: 'user_roles', conname: 'fk', confdeltype: letter }
    assert.equal(verdictFor(observation({ presence: { ...bound, ...counts }, rows: [row] })).verdict, expected, `confdeltype '${letter}'`)
  }

  // session_roles_schema is reported, so it must be a string or null — not coerced into one.
  for (const junk of [1, true, [], {}]) {
    const verdict = verdictFor(observation({ presence: { ...bound, ...counts, session_roles_schema: junk } }))
    assert.equal(verdict.reason, INDETERMINATE_REASONS.unparseable, `session_roles_schema=${JSON.stringify(junk)}`)
  }
})

test('the legal delete-action letters are a SUPERSET of the child-write letters', () => {
  // Two sets with one job each: "is this an action at all" and "does it write the child". If the
  // write set ever grew a letter the legal set does not have, every observation carrying it would
  // be rejected as unreadable instead of classified — and the widening would look like it worked.
  for (const letter of ROLE_DELETE_CHILD_WRITE_ACTIONS) {
    assert.ok(FK_DELETE_ACTION_LETTERS.includes(letter), `write action '${letter}' is not in the legal letter set`)
  }
  assert.deepEqual([...FK_DELETE_ACTION_LETTERS].sort(), ['a', 'c', 'd', 'n', 'r'], 'the legal set no longer matches pg_constraint.confdeltype')
})

test('every failed observation is INDETERMINATE — never ABSENT, never exit 0', () => {
  for (const testCase of INDETERMINATE_CASES) {
    const verdict = verdictFor(testCase.text)
    assert.equal(verdict.verdict, 'INDETERMINATE', `${testCase.label}: must not be classified as ${verdict.verdict}`)
    assert.notEqual(verdict.verdict, 'ABSENT', testCase.label)
    assert.equal(verdict.premise, 'NOT OBSERVED', testCase.label)
    assert.equal(verdict.headline, HEADLINES.INDETERMINATE, testCase.label)
    assert.equal(verdict.exitCode, 2, `${testCase.label}: an unobserved premise must fail the job`)
    assert.equal(verdict.reason, testCase.reason, testCase.label)
    assert.equal(verdict.rows.length, 0, `${testCase.label}: an unobserved run must publish no rows`)
  }
  // Non-vacuity: a fixture list that stopped exercising the classifier would satisfy the loop above
  // by iterating nothing.
  assert.ok(INDETERMINATE_CASES.length >= 16, 'the fail-closed matrix shrank')
})

test('the INDETERMINATE reasons discriminate (a first dispatch is diagnosable without a second)', () => {
  const observed = new Set(INDETERMINATE_CASES.map((testCase) => verdictFor(testCase.text).reason))
  // Every reason that the matrix claims to cover is genuinely produced by some case…
  for (const testCase of INDETERMINATE_CASES) assert.ok(observed.has(testCase.reason))
  // …and the matrix does not collapse into one undifferentiated "failed".
  assert.ok(observed.size >= 4, `expected several distinct reasons, got ${[...observed].join(', ')}`)
})

test('a missing observation file is INDETERMINATE, not ABSENT', () => {
  const { verdict } = runVerdict({
    observationPath: path.join(tmpdir(), `no-such-observation-${process.pid}.txt`),
    target: 'production',
  })
  assert.equal(verdict.verdict, 'INDETERMINATE')
  assert.equal(verdict.exitCode, 2)
  assert.equal(verdict.reason, INDETERMINATE_REASONS.observationMissing)
})

test('runVerdict reads a real file end to end and renders an auditable summary', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'role-cascade-witness-'))
  try {
    const file = path.join(dir, 'observation.txt')
    writeFileSync(file, observation({ rows: [row({ confdeltype: 'c' })] }))
    const { verdict, summary } = runVerdict({ observationPath: file, target: 'production' })
    assert.equal(verdict.verdict, 'PRESENT')
    assert.equal(verdict.exitCode, 1)
    // Requirement: the summary must carry the RAW rows observed, so the verdict is auditable
    // without re-running anything — including WHICH schema and WHICH table were written.
    assert.match(summary, /role_permissions_role_id_fkey/)
    assert.match(summary, /\| `public` \| `role_permissions` \| `role_permissions_role_id_fkey` \| `c` \| CASCADE \|/)
    assert.match(summary, /not_driven_reason_expired/)
    assert.match(summary, /target: `production`/)
    assert.match(summary, /bound to: `public\.roles` \(session resolves `roles` to `public`; 1 `roles` table\(s\) visible on the search_path\)/)
    assert.match(summary, /relation presence \(positive control\): recovery-authority-triggered relations in `public`=8/)
    // The narrowing is visible as a number, not invisible: FKs excluded for carrying no trigger.
    assert.match(summary, /foreign keys referencing `roles` \(audit only, decides nothing\): 1 in total, 1 on a table carrying a recovery-authority trigger/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the INDETERMINATE summary states the absence of a finding, not a finding of absence', () => {
  const summary = renderSummary(classifyObservation({ ok: false, reason: 'x', detail: 'y' }), { target: 'production' })
  assert.match(summary, /INDETERMINATE \(failed to observe\)/)
  assert.match(summary, /This is \*\*not\*\* a finding of "no cascade" — it is\s+the absence of a finding/)
  assert.ok(!summary.includes('premise CONFIRMED'), 'an unobserved run must never print the CONFIRMED headline')
  assert.ok(!summary.includes('CASCADE ABSENT'), 'an unobserved run must never print the ABSENT headline')
})

// ---------------------------------------------------------------------------
// 3. The probe actually emits what the parser accepts (both ends, one test)
// ---------------------------------------------------------------------------

const STUB_DATABASE_URL = 'postgres://witness_user:sup3rs3cret@db.internal:5432/metasheet'

function runProbe(plan, { databaseUrl = STUB_DATABASE_URL, withPgStub = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'role-cascade-probe-'))
  try {
    const probePath = path.join(dir, 'probe.cjs')
    writeFileSync(probePath, buildProbeSource())
    if (withPgStub) {
      const pgDir = path.join(dir, 'node_modules', 'pg')
      mkdirSync(pgDir, { recursive: true })
      writeFileSync(path.join(pgDir, 'package.json'), JSON.stringify({ name: 'pg', version: '0.0.0-stub', main: 'index.js' }))
      writeFileSync(path.join(pgDir, 'index.js'), `'use strict'
const plan = JSON.parse(process.env.STUB_PLAN || '{}')
class Client {
  constructor(options) { this.options = options }
  async connect() { if (plan.connectError) throw new Error(plan.connectError) }
  async query(sql) {
    if (plan.queryError) throw new Error(plan.queryError)
    if (String(sql).includes('relkind')) return { rows: [plan.presence || { canonical_roles_present: true, session_binds_canonical: true, session_roles_schema: 'public', visible_roles_relations: '1', canonical_exact_carriers: '8', recovery_authority_relations: '8', roles_referencing_fks: '1' }] }
    return { rows: plan.witnessRows || [] }
  }
  async end() {}
}
module.exports = { Client }
`)
    }
    const env = { ...process.env, STUB_PLAN: JSON.stringify(plan) }
    if (databaseUrl === null) delete env.DATABASE_URL
    else env.DATABASE_URL = databaseUrl
    const result = spawnSync(process.execPath, [probePath], { cwd: dir, env, encoding: 'utf8' })
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the generated probe emits a capture the parser accepts (ABSENT round trip)', () => {
  const { stdout, status } = runProbe({ witnessRows: [] })
  assert.equal(status, 0, `probe exited ${status}: ${stdout}`)
  const verdict = verdictFor(stdout)
  assert.equal(verdict.verdict, 'ABSENT')
  assert.equal(verdict.exitCode, 0)
})

test('the generated probe emits a capture the parser accepts (PRESENT round trip)', () => {
  const { stdout, status } = runProbe({ witnessRows: [row({ confdeltype: 'c' })] })
  assert.equal(status, 0, `probe exited ${status}: ${stdout}`)
  const verdict = verdictFor(stdout)
  assert.equal(verdict.verdict, 'PRESENT')
  assert.deepEqual(verdict.rows, [row({ confdeltype: 'c' })])
})

test('the probe issues the witness SQL verbatim and a presence probe, and nothing else', () => {
  // The stub discriminates on the SQL text, so a probe that stopped sending the real query would
  // fail the round trips above. Here, pin the statements themselves.
  const source = buildProbeSource()
  assert.ok(source.includes(JSON.stringify(WITNESS_SQL)), 'the probe no longer embeds the canonical-bound witness query verbatim')
  // Catalog-only by construction: the only SQL verbs in the probe are SELECTs over pg_catalog.
  const statements = [...source.matchAll(/"(\\n[^"]*SELECT[^"]*)"/g)].map((match) => match[1])
  assert.equal(statements.length, 2, `expected exactly 2 SQL literals in the probe, found ${statements.length}`)
  for (const statement of statements) {
    assert.match(statement, /pg_catalog\./)
    assert.ok(!/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COPY)\b/i.test(statement), `non-read statement in probe: ${statement}`)
  }
})

test('a probe that cannot connect reports connect_failed and REDACTS the database URL', () => {
  const { stdout } = runProbe({ connectError: `connection to ${STUB_DATABASE_URL} refused` })
  assert.ok(!stdout.includes('sup3rs3cret'), 'the probe leaked DATABASE_URL credentials into its output')
  assert.ok(!stdout.includes(STUB_DATABASE_URL), 'the probe leaked DATABASE_URL into its output')
  assert.match(stdout, /<redacted-uri>/)
  const verdict = verdictFor(stdout)
  assert.equal(verdict.verdict, 'INDETERMINATE')
  assert.match(verdict.detail, /connect_failed/)
})

test('a probe with no DATABASE_URL reports database_url_unreadable — never zero rows', () => {
  const { stdout } = runProbe({}, { databaseUrl: null })
  const verdict = verdictFor(stdout)
  assert.equal(verdict.verdict, 'INDETERMINATE')
  assert.match(verdict.detail, /database_url_unreadable/)
})

test('a probe that cannot resolve pg reports pg_load_failed — never zero rows', () => {
  const { stdout } = runProbe({}, { withPgStub: false })
  const verdict = verdictFor(stdout)
  assert.equal(verdict.verdict, 'INDETERMINATE')
  assert.match(verdict.detail, /pg_load_failed/)
})

test('a probe whose catalog query fails reports query_failed — never zero rows', () => {
  const { stdout } = runProbe({ queryError: 'permission denied for schema pg_catalog' })
  const verdict = verdictFor(stdout)
  assert.equal(verdict.verdict, 'INDETERMINATE')
  assert.match(verdict.detail, /query_failed/)
})

// ---------------------------------------------------------------------------
// 4. ONE definition of the witness (set-equality census, not a spot check)
// ---------------------------------------------------------------------------

/**
 * Fragments that must have EXACTLY ONE carrier across workflows and non-test ops scripts.
 *
 * Not one string but a set, and every one of them predicate-bearing: the census's job is "there is
 * one definition of the witness", and a signature that only pinned the SELECT list would let a
 * second copy of the CONJUNCTION appear as long as it projected different columns. Each conjunct of
 * the predicate is represented.
 */
const WITNESS_SQL_SIGNATURES = [
  // conjunct 1 — the FK targets the CANONICALLY-bound `roles` relation. The signature is the
  // template as it appears in source, not the rendered SQL: rendering it would make the signature
  // schema-specific and the census would silently stop finding the definition it censuses.
  'AND con.confrelid = ${canonicalRolesOidSql}',
  // conjunct 2 — the child table carries a canonical recovery-authority trigger
  'WHERE tg.tgrelid = con.conrelid',
  // the auditable projection the output protocol depends on
  'child_ns.nspname AS child_schema',
]

function nonTestSources() {
  const files = []
  for (const entry of readdirSync(workflowsDir)) {
    if (/\.ya?ml$/.test(entry)) files.push(path.join('.github/workflows', entry))
  }
  for (const entry of readdirSync(here)) {
    if (entry.endsWith('.mjs') && !entry.endsWith('.test.mjs')) files.push(path.join('scripts/ops', entry))
  }
  return files
}

test('the witness SQL has EXACTLY ONE definition across workflows and non-test ops scripts', () => {
  for (const signature of WITNESS_SQL_SIGNATURES) {
    const carriers = nonTestSources().filter((rel) => readFileSync(path.join(repoRoot, rel), 'utf8').includes(signature))
    assert.deepEqual(
      carriers.sort(),
      ['scripts/ops/multitable-l1-battery.mjs'],
      `a second copy of the witness query appeared (signature: ${signature}) — there must remain exactly one definition`,
    )
    // Non-vacuity: the signature must actually be findable in the query it censuses, or the set
    // equality above is satisfied by a fragment that no longer exists anywhere.
    assert.ok(
      readFileSync(path.join(repoRoot, 'scripts/ops/multitable-l1-battery.mjs'), 'utf8').includes(signature),
      `the signature no longer matches the query it censuses: ${signature}`,
    )
  }
  // Non-vacuity: the scanner must actually be reading files.
  assert.ok(nonTestSources().length > 20, 'the source scan found implausibly few files')
})

test('the witness query and its presence control bind `roles` CANONICALLY, not through the session', () => {
  // THIS TEST'S INVARIANT WAS INVERTED, NOT WIDENED — deliberately, because the invariant it used
  // to pin was the defect. It previously asserted that BOTH queries session-resolve `roles`
  // (`to_regclass('roles')`) and that neither hard-codes a schema, and it called that coupling a
  // safety property. It is the opposite: because the control resolved the relation the SAME way the
  // query did, it failed for the SAME reason, and a decoy `roles` reached first on the search_path
  // satisfied the control while the query looked at the decoy and returned nothing — reported as
  // `CASCADE ABSENT (premise CONFIRMED)`, exit 0, on a database whose cascade was live. Widening
  // the old test would have left the old assertions standing and both shapes would read as green.
  assert.match(PRESENCE_SQL, /to_regclass\('public\.roles'\)/, 'the presence control stopped binding `roles` canonically')
  assert.match(WITNESS_SQL, /confrelid = to_regclass\('public\.roles'\)/, 'the witness query stopped binding `roles` canonically')
  // The bare-name resolution survives in exactly ONE role: as the thing compared AGAINST the
  // canonical binding, so a mismatch can be reported. It must never be what the query binds to.
  assert.ok(
    !/confrelid = to_regclass\('roles'\)/.test(WITNESS_SQL),
    'the witness query is binding the bare session-resolved name again — this is the shadow-schema false ABSENT',
  )
  assert.match(PRESENCE_SQL, /to_regclass\('roles'\) = to_regclass\('public\.roles'\)/, 'the presence control stopped comparing the session resolution against the canonical binding')
  // NOT hard-coded: production binds the canonical schema DERIVED from the containment census, and
  // the real-DB goldens bind the per-run random schema they just created. Both must render.
  const goldenSql = buildRoleCascadeWitnessQuery('rcw_random_schema')
  assert.match(goldenSql, /to_regclass\('rcw_random_schema\.roles'\)/, 'the query factory cannot bind a per-run golden schema')
  assert.equal(CANONICAL_ROLES_SCHEMA, 'public', 'the canonical schema is derived from EXPECTED_AUTHORITY_TRIGGERS; all nine are `public`')
  // Values-free by construction: a schema name that is not a plain identifier is refused at build
  // time rather than escaped and embedded.
  for (const junk of ["pu'blic", 'public; DROP TABLE roles', 'Public', '']) {
    assert.throws(() => buildRoleCascadeWitnessQuery(junk), /refusing to bind a non-identifier schema name/, `accepted ${JSON.stringify(junk)}`)
  }
  assert.ok(!/relname = 'roles'/.test(WITNESS_SQL), 'name matching resolves relations in schemas the session cannot see; use to_regclass')
  // `con.confrelid` can only ever be an ordinary or partitioned table, so the presence control must
  // not count a view named `roles` as presence for a query that would return nothing.
  assert.match(PRESENCE_SQL, /relkind IN \('r', 'p'\)/)
  // The trigger-carrier control is SCOPED to the canonical schema. Counting carriers globally is
  // what let the old control stay satisfied by a real child while the resolved `roles` sat
  // elsewhere: two counters, two different relations, both green.
  assert.match(PRESENCE_SQL, /rel_ns\.nspname = 'public'/, 'the exact-carrier control is no longer scoped to the canonical schema')
  assert.match(PRESENCE_SQL, /fn_ns\.nspname = 'public'/, 'the exact-carrier control stopped checking the FUNCTION schema — a same-named function elsewhere can feed it again')
  assert.match(PRESENCE_SQL, /pg_catalog\.pg_trigger/)
  // SET equality, not list equality: the presence control now ALSO carries the exact-identity
  // tuples, so the same function name legitimately appears more than once there. What must not
  // drift is WHICH functions each side considers canonical.
  const presencePronames = [...new Set([...PRESENCE_SQL.matchAll(/'(metasheet_[a-z_]+)'/g)].map((m) => m[1]))].sort()
  const queryPronames = [...new Set([...WITNESS_SQL.matchAll(/'(metasheet_[a-z_]+)'/g)].map((m) => m[1]))].sort()
  assert.ok(presencePronames.length >= 3, `parsed only ${presencePronames.length} trigger function(s) out of the presence control`)
  assert.deepEqual(
    presencePronames,
    queryPronames,
    'the presence control and the witness query disagree about which triggers are canonical — one of them is narrower than the other',
  )
  // The WITNESS QUERY STAYS WIDE. Narrowing it to the census's table list would be the enumeration
  // trap: it would go stale the first time the migration covers one more table, silently.
  assert.ok(!/want\(table_name/.test(WITNESS_SQL), 'the witness query was narrowed to the exact-identity table list — that is the enumeration trap')
})

test('each door names ITSELF, so one dispatch is enough to diagnose which one closed', () => {
  // Four distinct ways for zero rows to mean something other than "no cascade". An undifferentiated
  // reason would make a shadow-schema dispatch indistinguishable from a wrong-database one.
  const cases = [
    { presence: { canonical_roles_present: false }, reason: INDETERMINATE_REASONS.canonicalRelationAbsent, says: /no ordinary table `public\.roles`/, notSays: /resolves to schema/ },
    { presence: { session_binds_canonical: false, session_roles_schema: 'metasheet' }, reason: INDETERMINATE_REASONS.bindingMismatch, says: /resolves to schema "metasheet", not the canonical `public`/, notSays: /no ordinary table/ },
    { presence: { visible_roles_relations: 3 }, reason: INDETERMINATE_REASONS.relationAmbiguous, says: /3 `roles` tables are visible/, notSays: /resolves to schema/ },
    { presence: { canonical_exact_carriers: 0 }, reason: INDETERMINATE_REASONS.relationsAbsent, says: /at its EXPECTED identity/, notSays: /visible on this session/ },
  ]
  for (const testCase of cases) {
    const verdict = verdictFor(observation({ presence: { ...PRESENT_RELATIONS, ...testCase.presence } }))
    assert.equal(verdict.verdict, 'INDETERMINATE', JSON.stringify(testCase.presence))
    assert.equal(verdict.exitCode, 2, JSON.stringify(testCase.presence))
    assert.equal(verdict.reason, testCase.reason, JSON.stringify(testCase.presence))
    assert.match(verdict.detail, testCase.says)
    assert.ok(!testCase.notSays.test(verdict.detail), `the detail blamed a door that was open: ${verdict.detail}`)
  }
})

test('the workflow carries no SQL of its own and defers to the runner for both ends', () => {
  // Prose in the header comment may DESCRIBE what is read; an executable line may not RE-TYPE it.
  const executableLines = workflowRaw.split('\n').filter((line) => !line.trimStart().startsWith('#'))
  const sqlCarriers = executableLines.filter((line) => /pg_constraint|pg_catalog|\bSELECT\b/.test(line))
  assert.deepEqual(sqlCarriers, [], 'the workflow re-typed catalog SQL instead of deferring to the one definition')
  // Non-vacuity: the comment filter must not be swallowing everything.
  assert.ok(executableLines.length > 50, `the comment filter removed too much (${executableLines.length} executable lines left)`)
  assert.match(workflowRaw, /multitable-role-cascade-witness\.mjs emit-probe/)
  assert.match(workflowRaw, /multitable-role-cascade-witness\.mjs verdict/)
})

test('the runner re-implements neither half of the witness', () => {
  // Every predicate symbol the runner uses comes from the battery — the ONE definition — and the
  // import line is pinned so a locally-defined shadow cannot quietly take over.
  assert.match(
    runnerRaw,
    /import \{ CANONICAL_ROLES_SCHEMA, FK_DELETE_ACTION_LETTERS, ROLE_CASCADE_BINDING_DOORS, buildRoleCascadeBindingSql, buildRoleCascadeWitnessQuery, classifyRoleCascadeBinding, describeRoleCascadeRow, readCatalogCount, roleDeleteCascadeExists, roleDeleteChildWrites \} from '\.\/multitable-l1-battery\.mjs'/,
  )
  // The battery's predicate must be the thing that DECIDES; a hand-rolled test anywhere in this
  // module (or in the probe source it generates) is a second, narrower definition.
  assert.equal((runnerRaw.match(/roleDeleteCascadeExists\(/g) || []).length, 1, 'the battery predicate must be called exactly once, from the classifier')
  assert.equal((runnerRaw.match(/roleDeleteChildWrites\(/g) || []).length, 1, 'the offender accessor must be called exactly once, from the classifier')
  // Every parent-delete action letter the predicate knows about, not just 'c': a runner that grew
  // its own `confdeltype === 'n'` branch would be exactly the defect this widening fixes, one letter
  // over.
  for (const letter of ['a', 'c', 'd', 'n', 'r']) {
    assert.ok(
      !new RegExp(`confdeltype[^\\n]*===\\s*'${letter}'`).test(runnerRaw),
      `the runner grew its own predicate (confdeltype === '${letter}')`,
    )
    assert.ok(
      !new RegExp(`'${letter}'\\s*===[^\\n]*confdeltype`).test(runnerRaw),
      `the runner grew its own predicate ('${letter}' === confdeltype)`,
    )
  }
  // …and the probe it ships to the host carries no verdict logic at all: it observes and reports.
  const probe = buildProbeSource()
  assert.ok(!probe.includes('roleDeleteCascadeExists'), 'the probe must not classify — it only observes')
  assert.ok(!probe.includes('roleDeleteChildWrites'), 'the probe must not classify — it only observes')

  // (a) NOWHERE in the probe — its SQL included — may `confdeltype` be compared against a literal.
  // The parent-delete action letters are the battery predicate's knowledge; a probe that filtered on
  // them would be a second, narrower definition wearing the shipped query's clothes.
  const CLASSIFIES = [
    { pattern: /confdeltype[^\n]{0,60}'[a-z]'/i, control: "row.confdeltype === 'c'" },
    { pattern: /'[a-z]'[^\n]{0,60}confdeltype/i, control: "'n' === row.confdeltype" },
    { pattern: /confdeltype[^\n]{0,60}IN \(/i, control: "WHERE con.confdeltype IN ('c', 'n', 'd')" },
  ]
  for (const { pattern, control } of CLASSIFIES) {
    assert.ok(!pattern.test(probe), `the probe classifies on the parent-delete action (${pattern})`)
    // The criterion itself is attacked: a regex that matched nothing would pass the line above on a
    // probe that DID classify.
    assert.ok(pattern.test(control), `the classification guard ${pattern} is inert`)
  }
  // (b) In the probe's own JS — the SQL string constants excluded, since `relkind IN ('r','p')` is a
  // relation-kind letter and has nothing to do with delete actions — no action letter may appear at
  // all.
  const probeJs = probe
    .split('\n')
    .filter((line) => !/^const (WITNESS|PRESENCE)_SQL = /.test(line))
    .join('\n')
    .replace(/'use strict'/, '')
  assert.ok(probeJs.includes('function main'), 'the SQL-constant filter removed the probe body, not just the SQL')
  for (const letter of ['c', 'n', 'd', 'a', 'r']) {
    assert.ok(!new RegExp(`'${letter}'`).test(probeJs), `the probe compares against a parent-delete action literal ('${letter}')`)
  }
})

test('the runner stays node_modules-free at the top level (the kit lane runs without pnpm install)', () => {
  const specifiers = [...runnerRaw.matchAll(/^import\b[\s\S]*?from\s*['"]([^'"]+)['"]/gm)].map((match) => match[1])
  assert.ok(specifiers.length >= 2, `parsed only ${specifiers.length} top-level import(s) — the parse is broken, not the file clean`)
  for (const specifier of specifiers) {
    assert.ok(
      specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../'),
      `runner imports '${specifier}' at the top level — pg is reached lazily, inside the probe, on the host only`,
    )
  }
})

// ---------------------------------------------------------------------------
// 5. Workflow contract
// ---------------------------------------------------------------------------

test('dispatch only — never scheduled', () => {
  const executableLines = workflowRaw.split('\n').filter((line) => !line.trimStart().startsWith('#'))
  assert.ok(executableLines.some((line) => /^\s*workflow_dispatch:/.test(line)))
  assert.ok(!executableLines.some((line) => /^\s*schedule:/.test(line)), 'the witness must not be scheduled')
  assert.ok(!executableLines.some((line) => /^\s*(push|pull_request):/.test(line)), 'the witness must not run on push/PR')
})

test('target is a fixed choice, re-validated locally with a fail-closed default BEFORE ssh', () => {
  assert.match(workflowRaw, /type: choice/)
  assert.match(workflowRaw, /options: \[staging, production\]/)
  const localCaseIdx = workflowRaw.indexOf('case "$TARGET" in')
  const sshIdx = workflowRaw.indexOf('ssh $ssh_opts')
  assert.ok(localCaseIdx > 0, 'the local exact-match validation must exist')
  assert.ok(sshIdx > 0, 'the ssh invocation must exist')
  assert.ok(localCaseIdx < sshIdx, 'TARGET must be re-validated BEFORE it is interpolated onto the ssh command line')
  assert.match(workflowRaw, /unexpected target '\$\{TARGET\}' \(expected production\|staging\) — refusing to proceed/)
})

/** The `workflow_dispatch` `target` input, parsed from the EXECUTABLE lines only (a `default:` in
 *  a header comment must not be able to satisfy the pin below). */
function dispatchTargetInput() {
  const lines = workflowRaw.split('\n').filter((line) => !line.trimStart().startsWith('#'))
  const start = lines.findIndex((line) => /^ {6}target:\s*$/.test(line))
  assert.ok(start >= 0, 'the workflow_dispatch `target` input is gone')
  const block = []
  for (let i = start + 1; i < lines.length; i++) {
    if (!/^ {8}\S/.test(lines[i])) break
    block.push(lines[i])
  }
  const optionsLine = block.find((line) => /^ {8}options: /.test(line))
  const defaultLine = block.find((line) => /^ {8}default: /.test(line))
  return {
    options: optionsLine ? optionsLine.replace(/^ {8}options: \[/, '').replace(/\]\s*$/, '').split(',').map((token) => token.trim()) : null,
    default: defaultLine ? defaultLine.replace(/^ {8}default: /, '').trim() : null,
  }
}

test('the dispatch DEFAULT is staging — the positive control — and never production', () => {
  // Distinct from the fail-closed default in the test above: THAT one is the shell `case`'s
  // unmapped branch (an injection boundary). THIS one is the dispatch FORM's pre-selected value.
  // Neither covers the other. Staging's answer is independently known, so a staging dispatch is
  // the control for the witness itself; defaulting to production meant one mis-click reached the
  // production host and silently inverted the PR's own "dispatch staging first" guidance.
  const input = dispatchTargetInput()
  assert.deepEqual(
    input.options,
    ['staging', 'production'],
    'the dispatch options changed shape — staging must be listed FIRST so the form agrees with the guidance',
  )
  assert.equal(
    input.default,
    'staging',
    'the workflow_dispatch default is not `staging`: a mis-click on the dispatch form would reach PRODUCTION, inverting the "dispatch staging first as a positive control" guidance',
  )
  assert.equal(input.default, input.options[0], 'the pre-selected default must be the first option, or form and guidance disagree')
})

test('the target → container mapping is redone INDEPENDENTLY inside the remote heredoc', () => {
  const sshIdx = workflowRaw.indexOf('ssh $ssh_opts')
  const remoteEndIdx = workflowRaw.indexOf('\n          REMOTE')
  assert.ok(remoteEndIdx > sshIdx, 'the remote heredoc must be delimited')
  const remote = workflowRaw.slice(sshIdx, remoteEndIdx)
  assert.match(remote, /case "\$\{TARGET:-\}" in/)
  assert.match(remote, /CONTAINER="metasheet-backend"/)
  assert.match(remote, /CONTAINER="metasheet-staging-backend"/)
  assert.match(remote, /refusing to proceed/)
  // Neither container name may be passed as an env-assignment on the ssh command line: ssh
  // re-parses all trailing arguments through the remote login shell.
  const sshLine = workflowRaw.split('\n').find((line) => line.includes('ssh $ssh_opts'))
  assert.ok(!sshLine.includes('metasheet-'), 'a container name leaked onto the ssh command line')
  assert.match(sshLine, /TARGET="\$TARGET" PROBE_B64="\$probe_b64"/)
})

test('the probe crosses the ssh boundary as a single validated base64 word', () => {
  assert.match(workflowRaw, /\*\[!A-Za-z0-9\+\/=\]\*\)/, 'the base64 alphabet guard is gone')
  assert.match(workflowRaw, /refusing to interpolate it onto an ssh command line/)
  const guardIdx = workflowRaw.indexOf('*[!A-Za-z0-9+/=]*)')
  assert.ok(guardIdx > 0 && guardIdx < workflowRaw.indexOf('ssh $ssh_opts'), 'the alphabet guard must precede ssh')
})

test('host identity is pinned fail-closed; StrictHostKeyChecking=no never appears in an executable line', () => {
  assert.match(workflowRaw, /DEPLOY_KNOWN_HOSTS: \$\{\{ secrets\.DEPLOY_KNOWN_HOSTS \}\}/)
  assert.match(workflowRaw, /DEPLOY_KNOWN_HOSTS is required to pin the deploy-host identity/)
  assert.match(workflowRaw, /decoded_known_hosts=.*base64 -d/)
  assert.match(workflowRaw, /ssh-ed25519\|ssh-rsa\|ecdsa-sha2\|ssh-dss/)
  assert.match(workflowRaw, /did not resolve to a recognizable key/)
  assert.match(workflowRaw, /-o StrictHostKeyChecking=yes -o UserKnownHostsFile=\$HOME\/\.ssh\/known_hosts -o GlobalKnownHostsFile=\/dev\/null/)
  const insecure = workflowRaw
    .split('\n')
    .filter((line) => line.includes('StrictHostKeyChecking=no') && !line.trimStart().startsWith('#'))
  assert.deepEqual(insecure, [], 'no executable StrictHostKeyChecking=no line may exist')
  // …and both fail-closed refusals must precede the ssh call, not merely exist somewhere.
  const sshIdx = workflowRaw.indexOf('ssh $ssh_opts')
  assert.ok(workflowRaw.indexOf('DEPLOY_KNOWN_HOSTS is required to pin') < sshIdx)
  assert.ok(workflowRaw.indexOf('did not resolve to a recognizable key') < sshIdx)
})

test('read-only by construction: docker ps + exactly one docker exec, and no mutating docker verb', () => {
  const commands = workflowRaw
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .filter((line) => /\bdocker\s+\w/.test(line))
    .map((line) => line.trim())
  assert.equal(commands.filter((line) => line.includes('docker exec')).length, 1, `expected exactly one docker exec, got: ${commands.join(' | ')}`)
  assert.equal(commands.filter((line) => line.includes('docker ps')).length, 1)
  assert.equal(commands.length, 3, `unexpected docker command(s): ${commands.join(' | ')}`) // ps + the `command -v docker` guard + exec
  for (const line of commands) {
    assert.ok(
      !/\bdocker\s+(run|rm|start|stop|restart|cp|compose|kill|update|commit|build|pull|push|create|rename|volume|network)\b/.test(line),
      `mutating/undeclared docker verb in a read-only witness: ${line}`,
    )
  }
  // `docker exec -i` would attach the remote heredoc's own stdin to the container; the probe takes
  // no stdin and the rest of the script must keep flowing into bash.
  assert.ok(!/docker exec\s+-i\b/.test(workflowRaw), 'docker exec must not consume the heredoc stdin')
  assert.match(workflowRaw, /READ-ONLY BY CONSTRUCTION/)
})

test('the verdict step owns the exit code, so a broken observation is still REPORTED', () => {
  assert.match(workflowRaw, /continue-on-error: true/)
  const observeIdx = workflowRaw.indexOf('id: observe')
  const verdictIdx = workflowRaw.indexOf('name: Verdict —')
  assert.ok(observeIdx > 0 && verdictIdx > observeIdx)
  const verdictStep = workflowRaw.slice(verdictIdx, workflowRaw.indexOf('- name: Upload witness evidence'))
  assert.match(verdictStep, /if: always\(\)/)
  // `run:` executes under `bash -e {0}`: a bare `$?` read after the command would never be reached.
  assert.match(verdictStep, /\|\| rc=\$\?/)
  assert.match(verdictStep, /exit "\$rc"/)
  const uploadStep = workflowRaw.slice(workflowRaw.indexOf('- name: Upload witness evidence'))
  assert.match(uploadStep, /if: always\(\)/)
  assert.match(uploadStep, /upload-artifact@v4/)
})

test('the three headlines are the ones the workflow promises, verbatim', () => {
  assert.match(workflowRaw, /CASCADE ABSENT \(premise CONFIRMED\)/)
  assert.match(workflowRaw, /CASCADE PRESENT \(premise REFUTED/)
  assert.match(workflowRaw, /INDETERMINATE \(failed to observe\)/)
  assert.equal(HEADLINES.INDETERMINATE, 'INDETERMINATE (failed to observe)')
})

// ---------------------------------------------------------------------------
// 5b. The CLI seam — the ONLY path the workflow actually invokes
// ---------------------------------------------------------------------------

const runnerPath = path.join(here, 'multitable-role-cascade-witness.mjs')

/** Spawn the runner exactly as the workflow's verdict step does. */
function runCli(observationText, { target = 'production', writeObservation = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'role-cascade-cli-'))
  try {
    const observationPath = path.join(dir, 'observation.txt')
    if (writeObservation) writeFileSync(observationPath, observationText)
    const outPath = path.join(dir, 'verdict.md')
    const stepSummaryPath = path.join(dir, 'step-summary.md')
    writeFileSync(stepSummaryPath, '')
    const result = spawnSync(
      process.execPath,
      [runnerPath, 'verdict', observationPath, '--target', target, '--out', outPath],
      { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: stepSummaryPath } },
    )
    let out = null
    try {
      out = readFileSync(outPath, 'utf8')
    } catch {
      out = null
    }
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      outFile: out,
      stepSummary: readFileSync(stepSummaryPath, 'utf8'),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('CLI: an ABSENT observation exits 0 and writes the verdict to $GITHUB_STEP_SUMMARY and --out', () => {
  const run = runCli(observation({ rows: [] }))
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`)
  assert.match(run.stepSummary, /CASCADE ABSENT \(premise CONFIRMED\)/)
  assert.match(run.stepSummary, /target: `production`/)
  assert.ok(run.outFile && run.outFile.trim() !== '', '--out must produce a non-empty verdict file')
  assert.equal(run.outFile.trim(), run.stepSummary.trim(), 'the artifact and the step summary must be the same evidence')
  assert.match(run.stdout, /::notice::role-cascade witness \[production\] — CASCADE ABSENT/)
})

test('CLI: a PRESENT observation exits 1 and publishes the RAW rows (schema + table + conname + action)', () => {
  const run = runCli(observation({ rows: [row({ schema: 'tenant7', table: 'user_roles', conname: 'user_roles_role_id_fkey', confdeltype: 'n' })] }))
  assert.equal(run.status, 1, `${run.stdout}${run.stderr}`)
  // Requirement: the summary must carry the raw rows observed so the verdict is auditable — the
  // child SCHEMA and TABLE included, or a hit in an unexpected schema is unattributable.
  assert.match(run.stepSummary, /CASCADE PRESENT \(premise REFUTED/)
  assert.match(run.stepSummary, /user_roles_role_id_fkey/)
  assert.match(run.stepSummary, /\| `tenant7` \| `user_roles` \| `user_roles_role_id_fkey` \| `n` \| SET NULL \|/)
  assert.match(run.stdout, /::error::role-cascade witness \[production\] — CASCADE PRESENT/)
  assert.ok(run.outFile && run.outFile.includes('tenant7.user_roles'))
})

test('CLI: a missing observation exits 2 and STILL writes a verdict — a red step is never a silent one', () => {
  const run = runCli(null, { writeObservation: false })
  assert.equal(run.status, 2, `${run.stdout}${run.stderr}`)
  assert.match(run.stepSummary, /INDETERMINATE \(failed to observe\)/)
  assert.ok(!run.stepSummary.includes('premise CONFIRMED'))
  // The workflow's emptiness guard is only discriminating because --out is written on ALL
  // outcomes, this one included.
  assert.ok(run.outFile && run.outFile.trim() !== '', 'the INDETERMINATE path must still produce the verdict artifact')
})

test('CLI: staging is carried through to the published verdict, so evidence names its target', () => {
  const run = runCli(observation({ rows: [] }), { target: 'staging' })
  assert.equal(run.status, 0)
  assert.match(run.stepSummary, /target: `staging`/)
})

test('the workflow refuses a silent runner no-op instead of publishing it as a green run', () => {
  // Without this, a CLI that stopped executing would print nothing, exit 0, and a GREEN witness run
  // with an empty summary would read as CONFIRMED.
  const verdictStep = workflowRaw.slice(
    workflowRaw.indexOf('name: Verdict —'),
    workflowRaw.indexOf('- name: Upload witness evidence'),
  )
  assert.match(verdictStep, /if \[ ! -s output\/role-cascade-witness\/verdict\.md \]; then/)
  assert.match(verdictStep, /refusing to let a silent no-op read as CONFIRMED/)
  const guardIdx = verdictStep.indexOf('! -s output/role-cascade-witness/verdict.md')
  assert.ok(guardIdx > 0 && guardIdx < verdictStep.lastIndexOf('exit "$rc"'), 'the guard must run before the exit code is honoured')
})

// ---------------------------------------------------------------------------
// 6. The remote script, EXECUTED — text assertions do not prove fail-closed
// ---------------------------------------------------------------------------

/** The heredoc body as bash will actually see it (YAML block indentation stripped). */
function remoteScript() {
  const lines = workflowRaw.split('\n')
  const start = lines.findIndex((line) => line.includes("<<'REMOTE'"))
  const end = lines.findIndex((line, index) => index > start && line.trim() === 'REMOTE')
  assert.ok(start > 0 && end > start, 'the remote heredoc must be extractable')
  const body = lines.slice(start + 1, end)
  const base = body[0].match(/^\s*/)[0].length
  assert.equal(body[0].slice(base), 'set -uo pipefail', 'the remote script no longer starts where this extractor thinks')
  return body.map((line) => (line.startsWith(' '.repeat(base)) ? line.slice(base) : line)).join('\n')
}

/**
 * Run the real remote script under a stub `docker`, so the fail-closed branches are PROVEN rather
 * than asserted by regex. The stub records the container name it was asked for and can be told to
 * report a different set of running containers, or to fail the exec.
 */
function runRemote({ target, running = ['metasheet-backend'], execExit = 0, witnessRows = [], deliverProbe = true }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'role-cascade-remote-'))
  try {
    const bin = path.join(dir, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(path.join(bin, 'docker'), `#!/bin/bash
echo "$@" >> "$STUB_DOCKER_LOG"
verb="$1"; shift
case "$verb" in
  ps) printf '%s\\n' $STUB_RUNNING ;;
  exec) echo "container:$1" >> "$STUB_DOCKER_LOG"; shift
        if [ "$STUB_EXEC_EXIT" != "0" ]; then exit "$STUB_EXEC_EXIT"; fi
        exec "$@" ;;
  *) echo "unexpected docker verb: $verb" >&2; exit 99 ;;
esac
`, { mode: 0o755 })
    const pgDir = path.join(dir, 'node_modules', 'pg')
    mkdirSync(pgDir, { recursive: true })
    writeFileSync(path.join(pgDir, 'package.json'), JSON.stringify({ name: 'pg', version: '0.0.0-stub', main: 'index.js' }))
    writeFileSync(path.join(pgDir, 'index.js'), `'use strict'
class Client {
  async connect() {}
  async query(sql) {
    if (String(sql).includes('relkind')) return { rows: [{ canonical_roles_present: true, session_binds_canonical: true, session_roles_schema: 'public', visible_roles_relations: '1', canonical_exact_carriers: '8', recovery_authority_relations: '8', roles_referencing_fks: '1' }] }
    return { rows: ${JSON.stringify(witnessRows)} }
  }
  async end() {}
}
module.exports = { Client }
`)
    const dockerLog = path.join(dir, 'docker.log')
    writeFileSync(dockerLog, '')
    const result = spawnSync('bash', ['-c', remoteScript()], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TARGET: target,
        PROBE_B64: deliverProbe ? Buffer.from(buildProbeSource()).toString('base64') : '',
        DATABASE_URL: STUB_DATABASE_URL,
        STUB_RUNNING: running.join(' '),
        STUB_EXEC_EXIT: String(execExit),
        STUB_DOCKER_LOG: dockerLog,
      },
    })
    return {
      capture: `${result.stdout ?? ''}${result.stderr ?? ''}`,
      status: result.status,
      dockerLog: readFileSync(dockerLog, 'utf8'),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('remote (executed): production maps to metasheet-backend and a clean read yields ABSENT', () => {
  const run = runRemote({ target: 'production', running: ['metasheet-backend', 'metasheet-web'] })
  assert.equal(run.status, 0, run.capture)
  assert.match(run.dockerLog, /container:metasheet-backend/)
  assert.match(run.capture, /OBSERVATION: COMPLETE/)
  const verdict = verdictFor(run.capture)
  assert.equal(verdict.verdict, 'ABSENT')
  assert.equal(verdict.exitCode, 0)
})

test('remote (executed): staging maps to metasheet-staging-backend, independently of the local mapping', () => {
  const run = runRemote({ target: 'staging', running: ['metasheet-staging-backend'] })
  assert.equal(run.status, 0, run.capture)
  assert.match(run.dockerLog, /container:metasheet-staging-backend/)
  assert.ok(!run.dockerLog.includes('container:metasheet-backend\n'), 'staging must never exec the production container')
})

test('remote (executed): a cascading FK survives the whole pipe and lands as REFUTED', () => {
  const run = runRemote({ target: 'production', witnessRows: [row({ confdeltype: 'c' })] })
  assert.equal(run.status, 0, run.capture)
  const verdict = verdictFor(run.capture)
  assert.equal(verdict.verdict, 'PRESENT')
  assert.equal(verdict.exitCode, 1)
})

test('remote (executed): a user_roles SET NULL FK survives the whole pipe and lands as REFUTED', () => {
  // The two legs the widening added, proven end to end through the real remote script rather than
  // only at the predicate: a NON-role_permissions child, and a NON-CASCADE writing action.
  const run = runRemote({
    target: 'production',
    witnessRows: [row({ table: 'user_roles', conname: 'user_roles_role_id_fkey', confdeltype: 'n' })],
  })
  assert.equal(run.status, 0, run.capture)
  const verdict = verdictFor(run.capture)
  assert.equal(verdict.verdict, 'PRESENT')
  assert.equal(verdict.exitCode, 1)
  assert.match(verdict.detail, /public\.user_roles/)
})

test('remote (executed): a MISSING container fails closed — the capture can never classify as ABSENT', () => {
  // The whole point. A substring match on some other running container, or a silent skip, would
  // produce zero rows and read as "premise CONFIRMED".
  const run = runRemote({ target: 'production', running: ['metasheet-backend-old', 'metasheet-web'] })
  assert.equal(run.status, 2, run.capture)
  assert.match(run.capture, /is NOT running; nothing observed is not evidence/)
  assert.ok(!run.dockerLog.includes('container:'), 'no docker exec may be attempted against a container that is not running')
  const verdict = verdictFor(run.capture)
  assert.equal(verdict.verdict, 'INDETERMINATE')
  assert.equal(verdict.exitCode, 2)
})

test('remote (executed): a non-zero probe exit fails closed', () => {
  const run = runRemote({ target: 'production', execExit: 7 })
  assert.equal(run.status, 2, run.capture)
  assert.match(run.capture, /the catalog probe exited 7/)
  assert.equal(verdictFor(run.capture).verdict, 'INDETERMINATE')
})

test('remote (executed): an undelivered probe fails closed rather than reading zero rows', () => {
  const run = runRemote({ target: 'production', deliverProbe: false })
  assert.equal(run.status, 2, run.capture)
  assert.match(run.capture, /no probe source was delivered/)
  assert.equal(verdictFor(run.capture).verdict, 'INDETERMINATE')
})

test('remote (executed): an off-enum target is refused on the remote side too', () => {
  for (const target of ['both', 'production staging', '', 'PRODUCTION']) {
    const run = runRemote({ target })
    assert.equal(run.status, 2, `target ${JSON.stringify(target)} must be refused remotely: ${run.capture}`)
    assert.match(run.capture, /unexpected target/)
    assert.ok(!run.dockerLog.includes('container:'), `target ${JSON.stringify(target)} reached docker exec`)
    assert.equal(verdictFor(run.capture).verdict, 'INDETERMINATE')
  }
})

test('the hermetic suite is registered in the always-on O-2 kit lane (cross-file sync pin)', () => {
  // A cross-file census that only runs behind a path filter can be defeated by editing the other
  // file; the kit lane is `pull_request:` with no path filter, which is why it lives there.
  const kit = readFileSync(path.join(workflowsDir, 'multitable-o2-observation-kit.yml'), 'utf8')
  assert.match(kit, /scripts\/ops\/multitable-role-cascade-witness\.test\.mjs/)
})

// ---------------------------------------------------------------------------
// 6b. The real-DB goldens must ACTUALLY RUN SOMEWHERE (cross-file wiring pin)
// ---------------------------------------------------------------------------
// The goldens below are opt-in behind ROLE_CASCADE_WITNESS_DB_GOLDENS=1, and the required
// hermetic contract lane deliberately does not arm them. That leaves exactly one lane in which
// the catalog proof executes at all — .github/workflows/multitable-o2-observation-kit-realdb.yml.
// If its armed step, its env var, or its path filters are dropped, the strongest evidence in this
// change quietly returns to running in NO lane while every check stays green: the repo's named
// skip-green shape (被触发≠被验证). These pins live in THIS suite because this suite runs in the
// always-on, path-filter-free contract lane, so editing the other file cannot defeat them.

const REALDB_WORKFLOW_REL = '.github/workflows/multitable-o2-observation-kit-realdb.yml'
const realdbWorkflowRaw = readFileSync(path.join(workflowsDir, 'multitable-o2-observation-kit-realdb.yml'), 'utf8')

/** The exact command the armed step must run. Pinned, not matched loosely: a step that runs some
 *  OTHER file would satisfy a substring match while executing none of the goldens. */
const WITNESS_GOLDENS_COMMAND = 'node --test scripts/ops/multitable-role-cascade-witness.test.mjs'

/**
 * The lane's job steps as `{name, env, run}`, parsed from EXECUTABLE lines only.
 *
 * Comment lines are stripped FIRST and deliberately: a prose mention of
 * `ROLE_CASCADE_WITNESS_DB_GOLDENS` in a header comment must never be able to satisfy a pin on the
 * step that actually SETS it, and neither may an env var that landed on a different step
 * (源码文本断言≠行为断言).
 */
function realdbJobSteps() {
  const lines = realdbWorkflowRaw.split('\n').filter((line) => !/^\s*#/.test(line))
  const steps = []
  let current = null
  for (const line of lines) {
    const start = line.match(/^ {6}- (?:name|uses): (.*)$/)
    if (start) {
      current = { name: /^ {6}- name: /.test(line) ? start[1].trim() : '', body: [], env: {}, run: '' }
      steps.push(current)
      continue
    }
    if (/^ {0,6}\S/.test(line)) {
      current = null
      continue
    }
    if (current) current.body.push(line)
  }
  for (const step of steps) {
    const envIdx = step.body.findIndex((line) => /^ {8}env:\s*$/.test(line))
    if (envIdx >= 0) {
      for (let i = envIdx + 1; i < step.body.length; i++) {
        const kv = step.body[i].match(/^ {10}([A-Za-z_][A-Za-z0-9_]*): (.*)$/)
        if (!kv) break
        step.env[kv[1]] = kv[2].trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1')
      }
    }
    const runLine = step.body.find((line) => /^ {8}run: /.test(line))
    if (runLine) step.run = runLine.replace(/^ {8}run: /, '').trim()
  }
  return steps
}

/** Every `- 'entry'` list under each `paths:` key, in file order. Same shape the O-2 suite's own
 *  path-filter guard uses, so the two agree about what "is in the filter" means. */
function realdbPathSections() {
  const sections = []
  const lines = realdbWorkflowRaw.split('\n')
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

test('the real-DB goldens are ARMED in the observation-kit real-DB lane — otherwise they run in NO lane at all', () => {
  const steps = realdbJobSteps()
  // Non-vacuity: the parser must actually be reading the job, and must be reading env blocks.
  assert.ok(steps.length >= 6, `parsed implausibly few steps (${steps.length}) out of ${REALDB_WORKFLOW_REL}`)
  assert.ok(
    steps.some((step) => Object.keys(step.env).length > 0),
    'the step parser found no per-step env: block anywhere in the lane — it is not reading what it claims to read',
  )

  const armed = steps.filter((step) => step.run === WITNESS_GOLDENS_COMMAND)
  assert.equal(
    armed.length,
    1,
    `expected exactly ONE step in ${REALDB_WORKFLOW_REL} running \`${WITNESS_GOLDENS_COMMAND}\`, found ${armed.length}`
      + ' — without it the real-DB goldens (the user_roles-only counterexample, the SET NULL / SET DEFAULT'
      + ' legs and the view_permissions-shape over-widen guard) execute in no CI lane at all',
  )
  const step = armed[0]
  assert.equal(
    step.env.ROLE_CASCADE_WITNESS_DB_GOLDENS,
    '1',
    'the armed step no longer sets ROLE_CASCADE_WITNESS_DB_GOLDENS=1 on ITSELF — the goldens would SKIP inside a lane that looks like it runs them (skip-green)',
  )
  const adminUrl = step.env.ROLE_CASCADE_WITNESS_ADMIN_URL
  assert.ok(
    adminUrl,
    'the armed step no longer sets ROLE_CASCADE_WITNESS_ADMIN_URL — the goldens need a maintenance connection that may CREATE/DROP throwaway databases, and without one they skip',
  )
  // Derived, not re-typed: the admin URL must point at the SAME postgres service this lane
  // provisions, so changing the service port reds here instead of leaving the goldens pointed at
  // nothing and skipping.
  const laneDatabaseUrl = realdbWorkflowRaw.match(/^ {6}DATABASE_URL: (\S+)$/m)
  assert.ok(laneDatabaseUrl, `could not find the job-level DATABASE_URL in ${REALDB_WORKFLOW_REL}`)
  const lane = new URL(laneDatabaseUrl[1])
  const admin = new URL(adminUrl)
  assert.equal(admin.host, lane.host, "the goldens' admin URL points at a different host:port than the lane's own postgres service")
  assert.notEqual(
    admin.pathname,
    lane.pathname,
    'the goldens must connect to a MAINTENANCE database: they CREATE/DROP throwaway databases, which cannot be done from inside the migrated application database itself',
  )
})

test('a change to the witness, its goldens, or the ONE query definition TRIGGERS the lane that executes them', () => {
  const sections = realdbPathSections()
  assert.equal(sections.length, 2, `expected 2 paths: sections (pull_request + push) in ${REALDB_WORKFLOW_REL}, found ${sections.length}`)
  const required = [
    'scripts/ops/multitable-role-cascade-witness.mjs',
    'scripts/ops/multitable-role-cascade-witness.test.mjs',
    // The ONE definition of the witness query lives here; the goldens execute its exported text.
    'scripts/ops/multitable-l1-battery.mjs',
  ]
  sections.forEach((entries, index) => {
    assert.ok(entries.length >= 9, `paths-section#${index + 1} unexpectedly small (${entries.length} entries)`)
    for (const rel of required) {
      assert.ok(
        entries.includes(rel),
        `paths-section#${index + 1} of ${REALDB_WORKFLOW_REL} does not trigger on ${rel}`
          + ' — a PR editing it would land without the real-DB goldens ever running',
      )
    }
  })
})

// ---------------------------------------------------------------------------
// 7. REAL-DB GOLDENS — the catalog, not a fixture's idea of the catalog
//
// Everything above drives the predicate through hand-written rows. That proves the classifier, and
// nothing about whether the SQL SELECTS the rows the classifier is supposed to see. These cases
// build the real catalog shapes in a throwaway Postgres database and run the EXPORTED query text
// (never a re-typed variant) against them, in ONE psql session — `to_regclass` is session-resolved,
// so two `psql -c` calls would silently defeat the whole schema-binding property under test.
//
// OPT-IN, not opt-out (L1_BATTERY_DOCKER_GOLDENS discipline): the required, path-filter-free O-2
// contract lane must stay hermetic, so a database hiccup on an unrelated PR can never red it. Not
// being armed is a LOUD skip, never a silent one (被触发≠被验证).
//
// OPT-IN IS NOT "NEVER RUNS": in CI they are armed by the execution-proof lane
// .github/workflows/multitable-o2-observation-kit-realdb.yml, whose armed step — and whose path
// filters — are pinned by section 6b above, so this suite reds if that wiring is ever dropped.
// And when a lane DOES arm them, the sentinel below turns "armed but unrunnable" into a hard
// failure rather than a skip that reads as green.
//
//   ROLE_CASCADE_WITNESS_DB_GOLDENS=1 \
//   ROLE_CASCADE_WITNESS_ADMIN_URL=postgresql://postgres@localhost:5432/postgres \
//     node --test scripts/ops/multitable-role-cascade-witness.test.mjs
//
// No `pg` npm dependency: the `psql` binary is invoked directly, exactly as
// multitable-o2-observation.test.mjs does, so the kit lane's "no pnpm install" contract survives.
// ---------------------------------------------------------------------------

const DB_GOLDEN_ADMIN_URL = process.env.ROLE_CASCADE_WITNESS_ADMIN_URL || process.env.DATABASE_URL || ''

function dbGoldenSkipReason() {
  if (process.env.ROLE_CASCADE_WITNESS_DB_GOLDENS !== '1') {
    return 'ROLE_CASCADE_WITNESS_DB_GOLDENS != 1 (real-DB goldens are opt-in; the required hermetic contract lane must not depend on a database)'
  }
  if (!DB_GOLDEN_ADMIN_URL) {
    return 'no ROLE_CASCADE_WITNESS_ADMIN_URL / DATABASE_URL — the goldens need a maintenance connection that may CREATE/DROP throwaway databases'
  }
  const probe = spawnSync('psql', ['--version'], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0) return `psql binary not usable: ${probe.error?.message ?? `exit ${probe.status}`}`
  return null
}

const DB_GOLDEN_SKIP = dbGoldenSkipReason()

test('sentinel: a lane that ARMS the goldens must actually be able to run them (fail-not-skip)', () => {
  // Dormant unless armed, so the hermetic contract lane is untouched. When a CI step sets
  // ROLE_CASCADE_WITNESS_DB_GOLDENS=1 it is ASSERTING that the catalog proof runs there; a missing
  // admin URL or an absent psql binary must then RED the lane, not skip it green
  // (mirrors multitable-o2-observation.test.mjs's METASHEET_REAL_DB_TEST_STEP sentinel).
  if (process.env.ROLE_CASCADE_WITNESS_DB_GOLDENS !== '1') return
  assert.equal(
    DB_GOLDEN_SKIP,
    null,
    `ROLE_CASCADE_WITNESS_DB_GOLDENS=1 says this step runs the real-DB goldens, but they would be SKIPPED — ${DB_GOLDEN_SKIP}`,
  )
})

if (DB_GOLDEN_SKIP) {
  // eslint-disable-next-line no-console
  console.error(
    `[golden] REAL-DB GOLDENS SKIPPED — ${DB_GOLDEN_SKIP}. The hermetic cases above still ran; the`
    + ' catalog proof (does the SQL actually SELECT what the predicate must classify?) did NOT.',
  )
}

/** Run a script in ONE psql session. Throws on any error (ON_ERROR_STOP=1). */
function psql(url, script) {
  const result = spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-d', url], {
    input: script,
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`psql exited ${result.status}: ${(result.stderr || '').trim()}`)
  return String(result.stdout ?? '')
}

/** The canonical trigger FUNCTIONS, by the names the containment census pins. Bodies are irrelevant
 *  here — the witness matches on `pg_proc.proname`, which is what makes the trigger set derivable
 *  from the catalog instead of from a hand-typed table list. */
const GOLDEN_TRIGGER_FUNCTIONS = {
  role_permissions: 'metasheet_recovery_role_permission_trigger',
  user_roles: 'metasheet_recovery_authority_user_trigger',
}

/**
 * DDL for one schema: a `roles` table plus the requested children.
 * @param {{schema: string, children: {table: string, action?: string, trigger?: string|null}[]}} spec
 */
function schemaDdl({ schema, children, existingSchema = false }) {
  const parts = existingSchema ? [`SET search_path TO ${schema};`] : [`CREATE SCHEMA ${schema};`, `SET search_path TO ${schema};`]
  for (const fn of new Set(Object.values(GOLDEN_TRIGGER_FUNCTIONS))) {
    parts.push(`CREATE FUNCTION ${schema}.${fn}() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END $fn$;`)
  }
  parts.push(`CREATE TABLE ${schema}.roles (id text PRIMARY KEY, name text);`)
  for (const child of children) {
    const fkClause = child.action
      ? `, role_id text DEFAULT 'seed-role' REFERENCES ${schema}.roles(id) ON DELETE ${child.action}`
      : ', role_id text'
    parts.push(`CREATE TABLE ${schema}.${child.table} (owner_id text${fkClause});`)
    if (child.trigger) {
      parts.push(
        `CREATE TRIGGER trg_${child.table}_recovery_authority_lock BEFORE INSERT OR UPDATE OR DELETE`
        + ` ON ${schema}.${child.table} FOR EACH ROW EXECUTE FUNCTION ${schema}.${child.trigger}();`,
      )
    }
  }
  return parts.join('\n')
}

/**
 * Build the fixture, then run BOTH exported queries in ONE session with the given `search_path`, and
 * return the capture in the probe's own wire format so the REAL parser and the REAL classifier
 * decide — not a shortcut that calls the predicate directly.
 */
function observeRealDatabase({ ddl, searchPath, canonicalSchema, sessionPrelude = '' }) {
  // The canonical schema is EXPLICIT at every call site, never defaulted: a golden that silently
  // inherited production's `public` binding would be testing a relation its fixture never created.
  if (!canonicalSchema) throw new Error('observeRealDatabase requires an explicit canonicalSchema')
  const dbName = `rcw_golden_${process.pid}_${Math.random().toString(36).slice(2, 10)}`
  psql(DB_GOLDEN_ADMIN_URL, `CREATE DATABASE ${dbName};`)
  const dbUrl = new URL(DB_GOLDEN_ADMIN_URL)
  dbUrl.pathname = `/${dbName}`
  try {
    psql(dbUrl.toString(), ddl)
    // ONE session: the search_path, the presence control and the witness query together. Splitting
    // them would resolve `to_regclass` in a different session than the one under test.
    const raw = psql(
      dbUrl.toString(),
      [
        // Runs in the OBSERVATION session, not the fixture session — the only way to put a pg_temp
        // relation in front of the binding, which is where `current_schemas(true)` looks first.
        ...(sessionPrelude ? [sessionPrelude] : []),
        `SET search_path TO ${searchPath};`,
        `SELECT row_to_json(p) FROM (${buildRelationPresenceQuery(canonicalSchema)}) p;`,
        `SELECT coalesce(json_agg(row_to_json(w)), '[]'::json) FROM (${buildRoleCascadeWitnessQuery(canonicalSchema)}) w;`,
      ].join('\n'),
    )
    const [presenceLine, rowsLine] = raw.split('\n').map((line) => line.trim()).filter((line) => line !== '')
    const presenceRow = JSON.parse(presenceLine)
    const witnessRows = JSON.parse(rowsLine)
    // Mirrors buildProbeSource()'s emit exactly: Number() the counts, String() the row fields.
    const capture = [
      `${PROTOCOL} BEGIN`,
      `${PROTOCOL} PRESENCE ${JSON.stringify({
        canonical_schema: canonicalSchema,
        canonical_roles_present: presenceRow.canonical_roles_present === true || presenceRow.canonical_roles_present === 't',
        session_binds_canonical: presenceRow.session_binds_canonical === true || presenceRow.session_binds_canonical === 't',
        session_roles_schema: presenceRow.session_roles_schema == null ? null : String(presenceRow.session_roles_schema),
        visible_roles_relations: Number(presenceRow.visible_roles_relations),
        canonical_exact_carriers: Number(presenceRow.canonical_exact_carriers),
        recovery_authority_relations: Number(presenceRow.recovery_authority_relations),
        roles_referencing_fks: Number(presenceRow.roles_referencing_fks),
      })}`,
      `${PROTOCOL} ROWS ${JSON.stringify(witnessRows.map((r) => ({
        child_schema: String(r.child_schema),
        child_table: String(r.child_table),
        conname: String(r.conname),
        confdeltype: String(r.confdeltype),
      })))}`,
      `${PROTOCOL} END ok`,
      '',
    ].join('\n')
    return { capture, verdict: classifyObservation(parseWitnessObservation(capture)) }
  } finally {
    psql(DB_GOLDEN_ADMIN_URL, `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE);`)
  }
}

/**
 * The golden matrix. Each row is its OWN case (a matrix collapsed into one test would let a single
 * mutation red everything and prove nothing about which leg is load-bearing).
 */
const DB_GOLDENS = [
  {
    label: 'user_roles-only CASCADE — the leg the original predicate could not see',
    // 033_create_rbac_core.sql:36 creates this FK under its own CREATE TABLE IF NOT EXISTS, so it
    // exists INDEPENDENTLY of the role_permissions one at :17.
    children: [
      { table: 'user_roles', action: 'CASCADE', trigger: GOLDEN_TRIGGER_FUNCTIONS.user_roles },
      { table: 'role_permissions', action: null, trigger: GOLDEN_TRIGGER_FUNCTIONS.role_permissions },
    ],
    expect: { verdict: 'PRESENT', exitCode: 1, rows: [['user_roles', 'c']] },
  },
  {
    label: 'role_permissions CASCADE — the leg the original predicate DID see (regression anchor)',
    children: [{ table: 'role_permissions', action: 'CASCADE', trigger: GOLDEN_TRIGGER_FUNCTIONS.role_permissions }],
    expect: { verdict: 'PRESENT', exitCode: 1, rows: [['role_permissions', 'c']] },
  },
  // The four action legs deliberately sit on `role_permissions`, not `user_roles`: it keeps each
  // mutation's blast radius attributable. Dropping user_roles coverage must red the two user_roles
  // cases and NOT these; dropping 'n' must red only the SET NULL case; dropping 'd' only SET DEFAULT.
  {
    label: 'SET NULL — UPDATEs the child row, so the BEFORE … UPDATE … trigger fires',
    children: [{ table: 'role_permissions', action: 'SET NULL', trigger: GOLDEN_TRIGGER_FUNCTIONS.role_permissions }],
    expect: { verdict: 'PRESENT', exitCode: 1, rows: [['role_permissions', 'n']] },
  },
  {
    label: 'SET DEFAULT — likewise UPDATEs the child row',
    children: [{ table: 'role_permissions', action: 'SET DEFAULT', trigger: GOLDEN_TRIGGER_FUNCTIONS.role_permissions }],
    expect: { verdict: 'PRESENT', exitCode: 1, rows: [['role_permissions', 'd']] },
  },
  {
    label: 'NO ACTION — refuses the parent delete instead of writing the child; excuse survives',
    children: [{ table: 'role_permissions', action: 'NO ACTION', trigger: GOLDEN_TRIGGER_FUNCTIONS.role_permissions }],
    expect: { verdict: 'ABSENT', exitCode: 0, rows: [['role_permissions', 'a']] },
  },
  {
    label: 'RESTRICT — likewise refuses; excuse survives',
    children: [{ table: 'role_permissions', action: 'RESTRICT', trigger: GOLDEN_TRIGGER_FUNCTIONS.role_permissions }],
    expect: { verdict: 'ABSENT', exitCode: 0, rows: [['role_permissions', 'r']] },
  },
  {
    label: 'view_permissions shape: a CASCADE FK on a table with NO recovery-authority trigger ⇒ ABSENT',
    // 20250925_create_view_tables.sql:261 adds view_permissions_role_id_fkey conditionally, and
    // view_permissions carries no recovery-authority trigger. Counting it would be a FALSE PRESENT —
    // which does not merely add noise: it makes the battery exit 1 not_driven_reason_expired and
    // refuse to produce ANY evidence, blocking the L1 evidence path on an unrefuted premise.
    children: [
      { table: 'view_permissions', action: 'CASCADE', trigger: null },
      { table: 'user_roles', action: null, trigger: GOLDEN_TRIGGER_FUNCTIONS.user_roles },
    ],
    expect: { verdict: 'ABSENT', exitCode: 0, rows: [] },
    // …and it must still be COUNTED in the audit-only total, so the exclusion is visible.
    expectReferencingFks: 1,
  },
]

for (const golden of DB_GOLDENS) {
  test(`real-DB golden: ${golden.label}`, { skip: DB_GOLDEN_SKIP ?? false }, () => {
    const schema = `rcw_${Math.random().toString(36).slice(2, 8)}`
    const { verdict, capture } = observeRealDatabase({
      ddl: schemaDdl({ schema, children: golden.children }),
      searchPath: `${schema}, public`,
      canonicalSchema: schema,
    })
    assert.equal(verdict.verdict, golden.expect.verdict, capture)
    assert.equal(verdict.exitCode, golden.expect.exitCode, capture)
    assert.deepEqual(
      verdict.rows.map((r) => [r.child_table, r.confdeltype]),
      golden.expect.rows,
      `the query selected the wrong rows: ${capture}`,
    )
    // Non-public schema throughout: a query hard-coding `public.` would return nothing here and
    // every PRESENT case above would silently become ABSENT.
    for (const r of verdict.rows) assert.equal(r.child_schema, schema)
    if (golden.expectReferencingFks !== undefined) {
      assert.equal(verdict.presence.roles_referencing_fks, golden.expectReferencingFks, capture)
    }
  })
}

test('real-DB golden: a shadow schema OFF search_path cannot flip the verdict', { skip: DB_GOLDEN_SKIP ?? false }, () => {
  // The schema/OID binding, attacked. `shadow` carries a complete decoy — its own `roles`, its own
  // triggered `user_roles`, its own CASCADE FK between them — but is NOT on the session search_path.
  // A witness that matched relations by NAME (`child.relname = …` / `parent.relname = …`, the shape
  // this query used to have) would report PRESENT here and expire an excuse that is still true.
  const live = `rcw_live_${Math.random().toString(36).slice(2, 8)}`
  const shadow = `rcw_shadow_${Math.random().toString(36).slice(2, 8)}`
  const { verdict, capture } = observeRealDatabase({
    ddl: [
      schemaDdl({ schema: live, children: [{ table: 'user_roles', action: 'RESTRICT', trigger: GOLDEN_TRIGGER_FUNCTIONS.user_roles }] }),
      schemaDdl({ schema: shadow, children: [{ table: 'user_roles', action: 'CASCADE', trigger: GOLDEN_TRIGGER_FUNCTIONS.user_roles }] }),
    ].join('\n'),
    searchPath: `${live}, public`,
    canonicalSchema: live,
  })
  assert.equal(verdict.verdict, 'ABSENT', capture)
  assert.equal(verdict.exitCode, 0, capture)
  assert.deepEqual(verdict.rows.map((r) => [r.child_schema, r.child_table, r.confdeltype]), [[live, 'user_roles', 'r']], capture)
  // Positive control for the control: the same shadow DDL, now ON the search_path, DOES refute —
  // otherwise this case would pass on a query that simply never finds anything.
  const armed = observeRealDatabase({
    ddl: schemaDdl({ schema: shadow, children: [{ table: 'user_roles', action: 'CASCADE', trigger: GOLDEN_TRIGGER_FUNCTIONS.user_roles }] }),
    searchPath: `${shadow}, public`,
    canonicalSchema: shadow,
  })
  assert.equal(armed.verdict.verdict, 'PRESENT', armed.capture)
})

/**
 * THE SHADOW-RESOLUTION GOLDENS.
 *
 * Every case below returned `CASCADE ABSENT (premise CONFIRMED)`, exit 0, against the shipped
 * pre-fix queries — on a database whose `roles:delete` cascade into a recovery-authority-triggered
 * child was LIVE. Reproduced end to end on PG 15 with the shipped probe, parser, classifier and
 * summary renderer; see `docs/development/role-cascade-witness-shadow-resolution-repro-20260824.md`.
 *
 * They are separate tests, not a matrix, because each one is caught by a DIFFERENT door and the
 * mutation proofs pair case to door. Collapsing them would let one mutation red everything and
 * prove nothing about which door is load-bearing.
 */
test('real-DB golden: a `$user`-shaped decoy in FRONT of the canonical schema cannot read as ABSENT', { skip: DB_GOLDEN_SKIP ?? false }, () => {
  // The production accident, at production's own binding: the canonical fixture lives in `public`,
  // and the connecting role owns a schema of its own containing a bare `roles`. No `SET
  // search_path`, no DSN `options=`, no `ALTER ROLE` is needed for this on a real deployment — the
  // stock default `"$user", public` puts the decoy first all by itself.
  const decoy = `rcw_user_${Math.random().toString(36).slice(2, 8)}`
  const { verdict, capture } = observeRealDatabase({
    ddl: [
      schemaDdl({ schema: 'public', existingSchema: true, children: [{ table: 'user_roles', action: 'CASCADE', trigger: GOLDEN_TRIGGER_FUNCTIONS.user_roles }] }),
      `CREATE SCHEMA ${decoy};`,
      `CREATE TABLE ${decoy}.roles (id text PRIMARY KEY);`,
    ].join('\n'),
    searchPath: `${decoy}, public`,
    canonicalSchema: 'public',
  })
  assert.equal(verdict.verdict, 'INDETERMINATE', capture)
  assert.equal(verdict.exitCode, 2, capture)
  assert.equal(verdict.reason, INDETERMINATE_REASONS.bindingMismatch, capture)
  assert.equal(verdict.presence, null, capture)
})

test('real-DB golden: a session looking at ONE wrong schema cannot read as ABSENT — the ambiguity count alone would miss it', { skip: DB_GOLDEN_SKIP ?? false }, () => {
  // The narrow case that refutes "count the visible `roles` tables and flag >1". Here exactly ONE
  // `roles` is visible and it is the WRONG one, so an ambiguity gate sees nothing wrong. Only the
  // canonical OID equality catches it. This golden exists to keep that asymmetry testable: if
  // someone ever trades door 2 away for door 3, THIS is the test that reds.
  const live = `rcw_live_${Math.random().toString(36).slice(2, 8)}`
  const wrong = `rcw_wrong_${Math.random().toString(36).slice(2, 8)}`
  const { verdict, capture } = observeRealDatabase({
    ddl: [
      schemaDdl({ schema: live, children: [{ table: 'user_roles', action: 'CASCADE', trigger: GOLDEN_TRIGGER_FUNCTIONS.user_roles }] }),
      `CREATE SCHEMA ${wrong};`,
      `CREATE TABLE ${wrong}.roles (id text PRIMARY KEY);`,
    ].join('\n'),
    searchPath: wrong,
    canonicalSchema: live,
  })
  assert.equal(verdict.verdict, 'INDETERMINATE', capture)
  assert.equal(verdict.reason, INDETERMINATE_REASONS.bindingMismatch, capture)
  // The point of the case, asserted rather than asserted-by-absence: the ambiguity door was OPEN.
  assert.match(capture, /"visible_roles_relations":1/, 'the fixture stopped being the narrow one-visible-relation case this golden exists for')
})

test('real-DB golden: canonical bound FIRST but a second `roles` visible behind it is INDETERMINATE', { skip: DB_GOLDEN_SKIP ?? false }, () => {
  // Door 2 passes here — the session really does resolve the canonical relation — and door 3 is the
  // only thing standing between this and a verdict drawn on an environment we cannot fully explain.
  const live = `rcw_live_${Math.random().toString(36).slice(2, 8)}`
  const second = `rcw_second_${Math.random().toString(36).slice(2, 8)}`
  const { verdict, capture } = observeRealDatabase({
    ddl: [
      schemaDdl({ schema: live, children: [{ table: 'user_roles', action: 'RESTRICT', trigger: GOLDEN_TRIGGER_FUNCTIONS.user_roles }] }),
      `CREATE SCHEMA ${second};`,
      `CREATE TABLE ${second}.roles (id text PRIMARY KEY);`,
    ].join('\n'),
    searchPath: `${live}, ${second}, public`,
    canonicalSchema: live,
  })
  assert.equal(verdict.verdict, 'INDETERMINATE', capture)
  assert.equal(verdict.reason, INDETERMINATE_REASONS.relationAmbiguous, capture)
  assert.match(capture, /"session_binds_canonical":true/, 'this golden must exercise door 3, with door 2 satisfied')
})

test('real-DB golden: a pg_temp `roles` cannot read as ABSENT', { skip: DB_GOLDEN_SKIP ?? false }, () => {
  // `current_schemas(true)` searches pg_temp FIRST, so a temp relation shadows the canonical one
  // without touching search_path at all. Nobody enumerated this vector; it falls out of the OID
  // equality without being named, which is the argument for binding rather than enumerating.
  const live = `rcw_live_${Math.random().toString(36).slice(2, 8)}`
  const { verdict, capture } = observeRealDatabase({
    ddl: schemaDdl({ schema: live, children: [{ table: 'user_roles', action: 'CASCADE', trigger: GOLDEN_TRIGGER_FUNCTIONS.user_roles }] }),
    sessionPrelude: 'CREATE TEMP TABLE roles (id text PRIMARY KEY);',
    searchPath: `${live}, public`,
    canonicalSchema: live,
  })
  assert.equal(verdict.verdict, 'INDETERMINATE', capture)
  assert.equal(verdict.reason, INDETERMINATE_REASONS.bindingMismatch, capture)
  assert.match(capture, /"session_roles_schema":"pg_temp/, capture)
})

test('real-DB golden: a same-named trigger function from ANOTHER schema cannot satisfy the positive control', { skip: DB_GOLDEN_SKIP ?? false }, () => {
  // The impostor-carrier hole. Everything the loose control looked at is right here: the carrier
  // table IS in the canonical schema, and the function name IS one of the census's. Only the
  // function's SCHEMA is wrong. Against head b3bdb23d8b all four doors opened and this reported
  // ABSENT / exit 0 on a catalog whose recovery-authority surface is not the canonical one.
  const canon = `rcw_canon_${Math.random().toString(36).slice(2, 8)}`
  const evil = `rcw_evil_${Math.random().toString(36).slice(2, 8)}`
  const fn = GOLDEN_TRIGGER_FUNCTIONS.user_roles
  const { verdict, capture } = observeRealDatabase({
    ddl: [
      `CREATE SCHEMA ${canon};`,
      `CREATE SCHEMA ${evil};`,
      `CREATE FUNCTION ${evil}.${fn}() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END $fn$;`,
      `CREATE TABLE ${canon}.roles (id text PRIMARY KEY);`,
      `CREATE TABLE ${canon}.user_roles (owner_id text, role_id text REFERENCES ${canon}.roles(id) ON DELETE CASCADE);`,
      `CREATE TRIGGER trg_user_roles_recovery_authority_lock BEFORE INSERT OR UPDATE OR DELETE`
        + ` ON ${canon}.user_roles FOR EACH ROW EXECUTE FUNCTION ${evil}.${fn}();`,
    ].join('\n'),
    searchPath: canon,
    canonicalSchema: canon,
  })
  assert.equal(verdict.verdict, 'INDETERMINATE', capture)
  assert.equal(verdict.exitCode, 2, capture)
  assert.equal(verdict.reason, INDETERMINATE_REASONS.relationsAbsent, capture)
  // The point of the case: the LOOSE carrier count was satisfied — only the exact identity was not.
  assert.match(capture, /"recovery_authority_relations":1/, 'the fixture stopped exercising the loose-count-satisfied case')
  assert.match(capture, /"canonical_exact_carriers":0/, capture)
})

test('real-DB golden: a RENAMED trigger on the right table cannot satisfy the positive control', { skip: DB_GOLDEN_SKIP ?? false }, () => {
  // The third axis of "exact identity". Right schema, right carrier table, right function, right
  // function schema — only the trigger NAME differs from the census's. Added because a mutation
  // that deleted the `trg.tgname = want.trigger_name` conjunct left the golden suite green at
  // 66/66: the conjunct was asserted in source but nothing exercised it. An unexercised conjunct is
  // a claim, not a check.
  const canon = `rcw_canon_${Math.random().toString(36).slice(2, 8)}`
  const fn = GOLDEN_TRIGGER_FUNCTIONS.user_roles
  const { verdict, capture } = observeRealDatabase({
    ddl: [
      `CREATE SCHEMA ${canon};`,
      `CREATE FUNCTION ${canon}.${fn}() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END $fn$;`,
      `CREATE TABLE ${canon}.roles (id text PRIMARY KEY);`,
      `CREATE TABLE ${canon}.user_roles (owner_id text, role_id text REFERENCES ${canon}.roles(id) ON DELETE CASCADE);`,
      `CREATE TRIGGER trg_user_roles_recovery_authority_lock_RENAMED BEFORE INSERT OR UPDATE OR DELETE`
        + ` ON ${canon}.user_roles FOR EACH ROW EXECUTE FUNCTION ${canon}.${fn}();`,
    ].join('\n'),
    searchPath: canon,
    canonicalSchema: canon,
  })
  assert.equal(verdict.verdict, 'INDETERMINATE', capture)
  assert.equal(verdict.reason, INDETERMINATE_REASONS.relationsAbsent, capture)
  assert.match(capture, /"recovery_authority_relations":1/, 'the fixture stopped exercising the loose-count-satisfied case')
  assert.match(capture, /"canonical_exact_carriers":0/, capture)
})

test('real-DB golden: a canonical-schema trigger on an UNEXPECTED carrier table cannot satisfy the positive control', { skip: DB_GOLDEN_SKIP ?? false }, () => {
  // Same hole, the other axis: right schema, right function, right function schema — wrong table,
  // so it is not one of the census's carrier identities.
  const canon = `rcw_canon_${Math.random().toString(36).slice(2, 8)}`
  const fn = GOLDEN_TRIGGER_FUNCTIONS.user_roles
  const { verdict, capture } = observeRealDatabase({
    ddl: [
      `CREATE SCHEMA ${canon};`,
      `CREATE FUNCTION ${canon}.${fn}() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END $fn$;`,
      `CREATE TABLE ${canon}.roles (id text PRIMARY KEY);`,
      `CREATE TABLE ${canon}.user_roles (owner_id text, role_id text REFERENCES ${canon}.roles(id) ON DELETE CASCADE);`,
      `CREATE TABLE ${canon}.not_a_census_carrier (id text);`,
      `CREATE TRIGGER trg_user_roles_recovery_authority_lock BEFORE INSERT OR UPDATE OR DELETE`
        + ` ON ${canon}.not_a_census_carrier FOR EACH ROW EXECUTE FUNCTION ${canon}.${fn}();`,
    ].join('\n'),
    searchPath: canon,
    canonicalSchema: canon,
  })
  assert.equal(verdict.verdict, 'INDETERMINATE', capture)
  assert.equal(verdict.reason, INDETERMINATE_REASONS.relationsAbsent, capture)
  assert.match(capture, /"recovery_authority_relations":1/, 'the fixture stopped exercising the loose-count-satisfied case')
  assert.match(capture, /"canonical_exact_carriers":0/, capture)
})

test('real-DB golden: a trigger carrier in ANOTHER schema cannot satisfy the canonical positive control', { skip: DB_GOLDEN_SKIP ?? false }, () => {
  // Door 4, scoped. This is the shape that made the ORIGINAL control unfalsifiable: its two counts
  // were satisfied by two different relations in two different schemas — the decoy answered "a
  // `roles` exists" and the real child answered "a trigger carrier exists" — and neither noticed
  // they were describing different databases-within-a-database. Here the session binds the canonical
  // `roles` honestly, but the canonical schema carries no recovery-authority trigger at all, so the
  // witness query is structurally incapable of returning a row. A globally-counted carrier control
  // would be fed by the OTHER schema and let this proceed to ABSENT.
  const live = `rcw_live_${Math.random().toString(36).slice(2, 8)}`
  const elsewhere = `rcw_elsewhere_${Math.random().toString(36).slice(2, 8)}`
  const { verdict, capture } = observeRealDatabase({
    ddl: [
      `CREATE SCHEMA ${live};`,
      `CREATE TABLE ${live}.roles (id text PRIMARY KEY);`,
      `CREATE TABLE ${live}.user_roles (owner_id text, role_id text REFERENCES ${live}.roles(id) ON DELETE CASCADE);`,
      schemaDdl({ schema: elsewhere, children: [{ table: 'user_roles', action: 'CASCADE', trigger: GOLDEN_TRIGGER_FUNCTIONS.user_roles }] }),
    ].join('\n'),
    searchPath: `${live}, public`,
    canonicalSchema: live,
  })
  assert.equal(verdict.verdict, 'INDETERMINATE', capture)
  assert.equal(verdict.reason, INDETERMINATE_REASONS.relationsAbsent, capture)
  assert.match(capture, /"session_binds_canonical":true/, 'this golden must exercise door 4, with doors 1-3 satisfied')
})

test('real-DB golden: a database with no canonical trigger at all is INDETERMINATE, never ABSENT', { skip: DB_GOLDEN_SKIP ?? false }, () => {
  // The presence control, on real catalog output. The query's EXISTS conjunct makes it structurally
  // incapable of returning a row here, so its zero rows say nothing about the premise — reporting
  // CONFIRMED would be indistinguishable from a dispatch that reached the wrong database.
  const schema = `rcw_${Math.random().toString(36).slice(2, 8)}`
  const ddl = [
    `CREATE SCHEMA ${schema};`,
    `CREATE TABLE ${schema}.roles (id text PRIMARY KEY);`,
    `CREATE TABLE ${schema}.user_roles (owner_id text, role_id text REFERENCES ${schema}.roles(id) ON DELETE CASCADE);`,
  ].join('\n')
  const { verdict, capture } = observeRealDatabase({ ddl, searchPath: `${schema}, public`, canonicalSchema: schema })
  assert.equal(verdict.verdict, 'INDETERMINATE', capture)
  assert.equal(verdict.exitCode, 2, capture)
  assert.equal(verdict.reason, INDETERMINATE_REASONS.relationsAbsent, capture)
  assert.match(verdict.detail, /at its EXPECTED identity/)
})

test('real-DB golden: no session-resolvable `roles` is INDETERMINATE, never ABSENT', { skip: DB_GOLDEN_SKIP ?? false }, () => {
  // The other half of the presence control, and the coupling the module's docblock warns about: the
  // query resolves `roles` through to_regclass, so a database where the session cannot see one must
  // fail closed rather than report "no cascade".
  const schema = `rcw_${Math.random().toString(36).slice(2, 8)}`
  const hidden = `rcw_hidden_${Math.random().toString(36).slice(2, 8)}`
  const { verdict, capture } = observeRealDatabase({
    ddl: schemaDdl({ schema: hidden, children: [{ table: 'user_roles', action: 'CASCADE', trigger: GOLDEN_TRIGGER_FUNCTIONS.user_roles }] })
      + `\nCREATE SCHEMA ${schema};`,
    searchPath: `${schema}, public`,
    canonicalSchema: schema,
  })
  assert.equal(verdict.verdict, 'INDETERMINATE', capture)
  assert.equal(verdict.exitCode, 2, capture)
  assert.equal(verdict.reason, INDETERMINATE_REASONS.canonicalRelationAbsent, capture)
  assert.match(verdict.detail, /has no ordinary table `.+\.roles`/)
})
