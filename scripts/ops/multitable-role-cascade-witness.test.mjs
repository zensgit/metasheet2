import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { ROLE_CASCADE_WITNESS_QUERY } from './multitable-l1-battery.mjs'
import {
  HEADLINES,
  INDETERMINATE_REASONS,
  PROTOCOL,
  RELATION_PRESENCE_QUERY,
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

/** A witness ROWS entry. Every field is required by the protocol, so the helper supplies them all. */
function row({ schema = 'public', table = 'role_permissions', conname = 'role_permissions_role_id_fkey', confdeltype = 'c' } = {}) {
  return { child_schema: schema, child_table: table, conname, confdeltype }
}

const PRESENT_RELATIONS = { roles: 1, recovery_authority_relations: 8, roles_referencing_fks: 1 }

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
    text: observation({ presence: { ...PRESENT_RELATIONS, recovery_authority_relations: 0 }, rows: [] }),
    reason: INDETERMINATE_REASONS.relationsAbsent,
  },
  {
    label: 'positive control: the observed database has no session-resolvable roles relation',
    text: observation({ presence: { ...PRESENT_RELATIONS, roles: 0 }, rows: [] }),
    reason: INDETERMINATE_REASONS.relationsAbsent,
  },
  {
    label: 'PRESENCE counts are not numbers',
    text: observation({ presence: { roles: 'yes', recovery_authority_relations: 'yes', roles_referencing_fks: 'yes' }, rows: [] }),
    reason: INDETERMINATE_REASONS.unparseable,
  },
  {
    label: 'PRESENCE is missing the audit-only FK count (a /1-shaped capture from an older probe)',
    text: observation({ presence: { roles: 1, role_permissions: 1 }, rows: [] }),
    reason: INDETERMINATE_REASONS.unparseable,
  },
]

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
    assert.match(summary, /relation presence \(positive control\): roles=1, recovery_authority_relations=8/)
    // The narrowing is visible as a number, not invisible: FKs excluded for carrying no trigger.
    assert.match(summary, /foreign keys referencing `roles` in total \(audit only, decides nothing\): 1/)
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
    if (String(sql).includes('relkind')) return { rows: [plan.presence || { roles_relations: '1', recovery_authority_relations: '8', roles_referencing_fks: '1' }] }
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
  assert.ok(source.includes(JSON.stringify(ROLE_CASCADE_WITNESS_QUERY)), 'the probe no longer embeds ROLE_CASCADE_WITNESS_QUERY verbatim')
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
  // conjunct 1 — the FK targets the session-resolved `roles` relation
  "AND con.confrelid = to_regclass('roles')",
  // conjunct 2 — the child table carries a canonical recovery-authority trigger
  'WHERE tg.tgrelid = con.conrelid',
  // the auditable projection the output protocol depends on
  'child_ns.nspname AS child_schema',
]
const WITNESS_SQL_SIGNATURE = WITNESS_SQL_SIGNATURES[0]

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
    assert.ok(ROLE_CASCADE_WITNESS_QUERY.includes(signature), `the signature no longer matches the query it censuses: ${signature}`)
  }
  // Non-vacuity: the scanner must actually be reading files.
  assert.ok(nonTestSources().length > 20, 'the source scan found implausibly few files')
})

test('the relation-presence control resolves the SAME relation the witness query resolves', () => {
  // The module's own docblock warns that these two are COUPLED: narrowing the query without
  // narrowing the control manufactures a FALSE ABSENT (the control passes on a shadow `roles` the
  // query cannot see, and its zero rows then read as "no cascade"). Pin the coupling mechanically.
  assert.match(RELATION_PRESENCE_QUERY, /to_regclass\('roles'\)/, 'the presence control stopped session-resolving `roles`')
  assert.match(ROLE_CASCADE_WITNESS_QUERY, /to_regclass\('roles'\)/, 'the witness query stopped session-resolving `roles`')
  for (const query of [RELATION_PRESENCE_QUERY, ROLE_CASCADE_WITNESS_QUERY]) {
    assert.ok(!/to_regclass\('public\./.test(query), 'a hard-coded `public.` literal blinds every per-random-schema real-DB golden')
    assert.ok(!/relname = 'roles'/.test(query), 'name matching resolves relations in schemas the session cannot see; use to_regclass')
  }
  // `con.confrelid` can only ever be an ordinary or partitioned table, so the presence control must
  // not count a view named `roles` as presence for a query that would return nothing.
  assert.match(RELATION_PRESENCE_QUERY, /relkind IN \('r', 'p'\)/)
  // Both halves of the relation set the query consults are counted, including the trigger carriers
  // the EXISTS conjunct can match — derived from the same census, never hand-typed.
  assert.match(RELATION_PRESENCE_QUERY, /pg_catalog\.pg_trigger/)
  const presencePronames = [...RELATION_PRESENCE_QUERY.matchAll(/'(metasheet_[a-z_]+)'/g)].map((match) => match[1]).sort()
  const queryPronames = [...ROLE_CASCADE_WITNESS_QUERY.matchAll(/'(metasheet_[a-z_]+)'/g)].map((match) => match[1]).sort()
  assert.ok(presencePronames.length >= 3, `parsed only ${presencePronames.length} trigger function(s) out of the presence control`)
  assert.deepEqual(
    presencePronames,
    queryPronames,
    'the presence control and the witness query disagree about which triggers are canonical — one of them is narrower than the other',
  )
})

test('the presence control names WHICH half was missing, so one dispatch is enough to diagnose it', () => {
  const noRoles = verdictFor(observation({ presence: { ...PRESENT_RELATIONS, roles: 0 } }))
  assert.equal(noRoles.reason, INDETERMINATE_REASONS.relationsAbsent)
  assert.match(noRoles.detail, /no session-resolvable `roles` table/)
  assert.ok(!/canonical recovery-authority trigger/.test(noRoles.detail), 'the detail blamed the half that was present')

  const noTriggers = verdictFor(observation({ presence: { ...PRESENT_RELATIONS, recovery_authority_relations: 0 } }))
  assert.equal(noTriggers.reason, INDETERMINATE_REASONS.relationsAbsent)
  assert.match(noTriggers.detail, /no relation carries a canonical recovery-authority trigger/)
  assert.ok(!/no session-resolvable/.test(noTriggers.detail), 'the detail blamed the half that was present')
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
    /import \{ ROLE_CASCADE_WITNESS_QUERY, describeRoleCascadeRow, roleDeleteCascadeExists, roleDeleteChildWrites \} from '\.\/multitable-l1-battery\.mjs'/,
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
  assert.match(workflowRaw, /options: \[production, staging\]/)
  const localCaseIdx = workflowRaw.indexOf('case "$TARGET" in')
  const sshIdx = workflowRaw.indexOf('ssh $ssh_opts')
  assert.ok(localCaseIdx > 0, 'the local exact-match validation must exist')
  assert.ok(sshIdx > 0, 'the ssh invocation must exist')
  assert.ok(localCaseIdx < sshIdx, 'TARGET must be re-validated BEFORE it is interpolated onto the ssh command line')
  assert.match(workflowRaw, /unexpected target '\$\{TARGET\}' \(expected production\|staging\) — refusing to proceed/)
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
    if (String(sql).includes('relkind')) return { rows: [{ roles_relations: '1', recovery_authority_relations: '8', roles_referencing_fks: '1' }] }
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
function schemaDdl({ schema, children }) {
  const parts = [`CREATE SCHEMA ${schema};`, `SET search_path TO ${schema};`]
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
function observeRealDatabase({ ddl, searchPath }) {
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
        `SET search_path TO ${searchPath};`,
        `SELECT row_to_json(p) FROM (${RELATION_PRESENCE_QUERY}) p;`,
        `SELECT coalesce(json_agg(row_to_json(w)), '[]'::json) FROM (${ROLE_CASCADE_WITNESS_QUERY}) w;`,
      ].join('\n'),
    )
    const [presenceLine, rowsLine] = raw.split('\n').map((line) => line.trim()).filter((line) => line !== '')
    const presenceRow = JSON.parse(presenceLine)
    const witnessRows = JSON.parse(rowsLine)
    // Mirrors buildProbeSource()'s emit exactly: Number() the counts, String() the row fields.
    const capture = [
      `${PROTOCOL} BEGIN`,
      `${PROTOCOL} PRESENCE ${JSON.stringify({
        roles: Number(presenceRow.roles_relations),
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
  {
    label: "SET NULL — UPDATEs the child row, so the BEFORE … UPDATE … trigger fires",
    children: [{ table: 'user_roles', action: 'SET NULL', trigger: GOLDEN_TRIGGER_FUNCTIONS.user_roles }],
    expect: { verdict: 'PRESENT', exitCode: 1, rows: [['user_roles', 'n']] },
  },
  {
    label: 'SET DEFAULT — likewise UPDATEs the child row',
    children: [{ table: 'user_roles', action: 'SET DEFAULT', trigger: GOLDEN_TRIGGER_FUNCTIONS.user_roles }],
    expect: { verdict: 'PRESENT', exitCode: 1, rows: [['user_roles', 'd']] },
  },
  {
    label: 'NO ACTION — refuses the parent delete instead of writing the child; excuse survives',
    children: [{ table: 'user_roles', action: 'NO ACTION', trigger: GOLDEN_TRIGGER_FUNCTIONS.user_roles }],
    expect: { verdict: 'ABSENT', exitCode: 0, rows: [['user_roles', 'a']] },
  },
  {
    label: 'RESTRICT — likewise refuses; excuse survives',
    children: [{ table: 'user_roles', action: 'RESTRICT', trigger: GOLDEN_TRIGGER_FUNCTIONS.user_roles }],
    expect: { verdict: 'ABSENT', exitCode: 0, rows: [['user_roles', 'r']] },
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
  })
  assert.equal(verdict.verdict, 'ABSENT', capture)
  assert.equal(verdict.exitCode, 0, capture)
  assert.deepEqual(verdict.rows.map((r) => [r.child_schema, r.child_table, r.confdeltype]), [[live, 'user_roles', 'r']], capture)
  // Positive control for the control: the same shadow DDL, now ON the search_path, DOES refute —
  // otherwise this case would pass on a query that simply never finds anything.
  const armed = observeRealDatabase({
    ddl: schemaDdl({ schema: shadow, children: [{ table: 'user_roles', action: 'CASCADE', trigger: GOLDEN_TRIGGER_FUNCTIONS.user_roles }] }),
    searchPath: `${shadow}, public`,
  })
  assert.equal(armed.verdict.verdict, 'PRESENT', armed.capture)
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
  const { verdict, capture } = observeRealDatabase({ ddl, searchPath: `${schema}, public` })
  assert.equal(verdict.verdict, 'INDETERMINATE', capture)
  assert.equal(verdict.exitCode, 2, capture)
  assert.equal(verdict.reason, INDETERMINATE_REASONS.relationsAbsent, capture)
  assert.match(verdict.detail, /no relation carries a canonical recovery-authority trigger/)
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
  })
  assert.equal(verdict.verdict, 'INDETERMINATE', capture)
  assert.equal(verdict.exitCode, 2, capture)
  assert.equal(verdict.reason, INDETERMINATE_REASONS.relationsAbsent, capture)
  assert.match(verdict.detail, /no session-resolvable `roles` table/)
})
