import { existsSync, readFileSync } from 'node:fs'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { APPLICATION_SCHEMA_FINGERPRINT, eventSchemaDigest } from '../../src/security-events/schema'

// Reviewed per-major approvals that the real-database T31 compares the migrated catalog against.
// Every expectation below is written from the design lock section 2 tables, independently of the
// migration, the registry and the fixture itself.
let assertionCount = 0
afterEach(() => { assertionCount += expect.getState().assertionCalls; expect(expect.getState().assertionCalls).toBeGreaterThan(0) })
afterAll(() => { console.info('E1_ASSERTIONS_SCHEMA_APPROVALS=' + assertionCount) })

type Row = Record<string, unknown>
type Fixture = { major: number; digest: string; applicationFingerprint: string; sections: Row[][] }
const fixtureUrl = (major: number) => new URL(`../fixtures/security-events/schema-approvals/pg${major}.json`, import.meta.url)
const EVENTS = 'security_events', DELIVERIES = 'security_event_deliveries'
const TZ = 'timestamp with time zone'

// Lock 2.1 and 2.3: column, type, NOT NULL.
const LOCK_COLUMNS: Record<string, [string, string, boolean][]> = {
  [EVENTS]: [
    ['id', 'uuid', true], ['schema_version', 'smallint', true], ['scope_kind', 'text', true], ['org_id', 'text', false],
    ['producer', 'text', true], ['event_type', 'text', true], ['severity', 'text', true], ['outcome', 'text', true],
    ['reason_code', 'text', false], ['actor_kind', 'text', true], ['actor_user_id', 'text', false], ['subject_user_id', 'text', false],
    ['target_kind', 'text', false], ['target_id', 'text', false], ['source_kind', 'text', true], ['source_id', 'text', true],
    ['source_step', 'text', true], ['record_origin', 'text', true], ['occurred_at', TZ, true], ['recorded_at', TZ, true],
    ['facts', 'jsonb', true], ['expires_at', TZ, true], ['delivery_planned_at', TZ, false],
  ],
  [DELIVERIES]: [
    ['id', 'uuid', true], ['event_id', 'uuid', true], ['channel', 'text', true], ['route_ref', 'text', true],
    ['attempt_no', 'integer', true], ['status', 'text', true], ['result_code', 'text', false], ['created_at', TZ, true],
    ['due_at', TZ, true], ['started_at', TZ, false], ['finished_at', TZ, false], ['lease_id', 'uuid', false],
    ['lease_until', TZ, false], ['retry_safety', 'text', true], ['next_attempt_at', TZ, false], ['expires_at', TZ, true],
  ],
}
// Lock closed sets.
const SETS = {
  scope_kind: ['organization', 'system'],
  producer: ['directory', 'auth', 'security_action', 'authorization', 'admin_grant', 'deprovision', 'platform'],
  severity: ['info', 'warning', 'error', 'critical'],
  outcome: ['succeeded', 'denied', 'failed', 'observed'],
  actor_kind: ['user', 'system', 'anonymous'],
  target_kind: ['integration', 'user', 'membership', 'grant', 'operation', 'run', 'component'],
  source_kind: ['sync_run', 'deprovision_effect', 'auth_operation', 'admin_grant_command', 'request', 'runtime_probe', 'request_window'],
  record_origin: ['live', 'backfill', 'reconcile'],
  channel: ['none', 'legacy_directory_webhook', 'group_extension'],
  status: ['queued', 'sending', 'succeeded', 'failed', 'unknown', 'skipped'],
  retry_safety: ['not_started', 'definitive_failure', 'unknown', 'not_applicable'],
}
// Lock 2.3 lists these result codes as examples; delivered is the succeeded result and is not in that list.
const RESULT_EXAMPLES = ['channel_unconfigured', 'plugin_unavailable', 'source_not_eligible', 'transport_not_started', 'provider_rejected', 'send_outcome_unknown', 'legacy_sent_observed', 'legacy_outcome_unknown', 'attempt_limit']
// Lock 2.2 generic facts keys.
const COUNT_KEYS = ['affected_count', 'failed_count', 'pending_count', 'attempt_count', 'threshold_days']
const BOOLEAN_KEYS = ['membership_changed', 'grant_revoked', 'user_deactivated', 'source_missing', 'count_unknown', 'sampled', 'truncated']
const FACT_KEYS = [...COUNT_KEYS, 'duration_ms', ...BOOLEAN_KEYS]

const sorted = (values: readonly string[]) => [...values].sort()
const literals = (text: string) => [...text.matchAll(/'((?:[^']|'')*)'/g)].map(match => match[1].replace(/''/g, "'"))
const has = (text: string, ...patterns: RegExp[]) => patterns.every(pattern => pattern.test(text))
const sameSet = (a: readonly string[], b: readonly string[]) => JSON.stringify(sorted([...new Set(a)])) === JSON.stringify(sorted(b))
const closedSet = (column: string, values: readonly string[]) => (text: string) =>
  has(text, new RegExp(`\\b${column}\\s*=\\s*ANY\\s*\\(`)) && sameSet(literals(text), values)
const bounded = (column: string, max: number) => new RegExp(`char_length\\(${column}\\)\\s*<=\\s*${max}\\b`)
const atLeastOne = (column: string) => new RegExp(`char_length\\(${column}\\)\\s*>=\\s*1\\b`)
function regexLiteral(text: string, column: string): RegExp | null {
  const match = new RegExp(`\\b${column}\\s*~\\s*'((?:[^']|'')*)'`).exec(text)
  return match ? new RegExp(match[1].replace(/''/g, "'")) : null
}
function behaves(pattern: RegExp | null, accepted: string[], rejected: string[]) {
  return !!pattern && accepted.every(value => pattern.test(value)) && rejected.every(value => !pattern.test(value))
}
const countFact = (key: string, max: string) => (text: string) =>
  has(text, new RegExp(`facts \\? '${key}'`), new RegExp(`jsonb_typeof\\(facts -> '${key}'(?:::text)?\\)\\s*=\\s*'number'`),
    new RegExp(`>=\\s*\\(?'?0'?(?:::numeric)?\\)?`), new RegExp(`<=\\s*\\(?'?${max}'?`), /\btrunc\(/)
const booleanFact = (key: string) => (text: string) =>
  has(text, new RegExp(`facts \\? '${key}'`), new RegExp(`jsonb_typeof\\(facts -> '${key}'(?:::text)?\\)\\s*=\\s*'boolean'`))

// Closed world over CHECK constraints: each one carries a semantic required by the lock.
const CHECKS: Record<string, Record<string, (text: string) => boolean>> = {
  [EVENTS]: {
    se_version: text => has(text, /\bschema_version\s*=\s*1\b/),
    se_scope: closedSet('scope_kind', SETS.scope_kind),
    se_org: text => has(text, /'organization'/, /org_id IS NOT NULL/, atLeastOne('org_id'), bounded('org_id', 128), /ELSE org_id IS NULL/),
    se_producer: closedSet('producer', SETS.producer),
    se_type: text => has(text, atLeastOne('event_type'), bounded('event_type', 96))
      && behaves(regexLiteral(text, 'event_type'), ['auth.session_registered', 'a.b', 'future_type.valid_name'], ['BAD.type', 'a.b.c', 'nodot', 'a.', '.b', 'a-b.c', 'a.b1', ' a.b']),
    se_severity: closedSet('severity', SETS.severity),
    se_outcome: closedSet('outcome', SETS.outcome),
    se_reason: text => has(text, /\breason_code\s*=\s*ANY\s*\(/) && literals(text).length > 0
      && literals(text).every(value => /^[a-z_]{1,64}$/.test(value)),
    se_actor_kind: closedSet('actor_kind', SETS.actor_kind),
    se_actor: text => has(text, /actor_kind = 'user'/, /actor_user_id IS NOT NULL/, atLeastOne('actor_user_id'), bounded('actor_user_id', 128), /ELSE actor_user_id IS NULL/),
    se_subject: text => has(text, /subject_user_id IS NULL OR/, atLeastOne('subject_user_id'), bounded('subject_user_id', 128)),
    se_target_kind: closedSet('target_kind', SETS.target_kind),
    se_target: text => has(text, /target_kind IS NULL THEN target_id IS NULL/, /target_id IS NOT NULL/, atLeastOne('target_id'), bounded('target_id', 128)),
    se_source_kind: closedSet('source_kind', SETS.source_kind),
    se_source_id: text => has(text, atLeastOne('source_id'), bounded('source_id', 512), /octet_length\(source_id\)\s*<=\s*2048\b/),
    se_source_step: text => has(text, atLeastOne('source_step'), bounded('source_step', 64))
      && behaves(regexLiteral(text, 'source_step'), ['failed', 'window_closed'], ['Free text', 'free text', 'a.b', '']),
    se_origin: closedSet('record_origin', SETS.record_origin),
    se_times: text => has(text, /isfinite\(occurred_at\)/, /isfinite\(recorded_at\)/, /isfinite\(expires_at\)/, /expires_at > recorded_at/),
    se_facts: text => has(text, /jsonb_typeof\(facts\)\s*=\s*'object'/, /octet_length\(facts::text\)\s*<=\s*2048\b/, /= '\{\}'::jsonb/)
      && sameSet(literals(/facts - ARRAY\[([^\]]*)\]/.exec(text)?.[1] ?? ''), FACT_KEYS),
    ...Object.fromEntries(COUNT_KEYS.map(key => [`se_fact_${key}`, countFact(key, '2147483647')])),
    se_fact_duration_ms: countFact('duration_ms', '9007199254740991'),
    ...Object.fromEntries(BOOLEAN_KEYS.map(key => [`se_fact_${key}`, booleanFact(key)])),
  },
  [DELIVERIES]: {
    sed_channel: closedSet('channel', SETS.channel),
    sed_status: closedSet('status', SETS.status),
    sed_retry: closedSet('retry_safety', SETS.retry_safety),
    sed_result: text => has(text, /\bresult_code\s*=\s*ANY\s*\(/) && RESULT_EXAMPLES.every(code => literals(text).includes(code))
      && literals(text).every(code => [...RESULT_EXAMPLES, 'delivered'].includes(code)),
    sed_attempt: text => has(text, /attempt_no >= 0/, /attempt_no <= 5\b/),
    sed_route: text => has(text, atLeastOne('route_ref'), bounded('route_ref', 128)),
    sed_channel_shape: text => has(text, /channel = 'none'(?:::text)? THEN route_ref = 'none'/, /channel = 'legacy_directory_webhook'(?:::text)? THEN route_ref = 'legacy\.directory_sync'/),
    sed_zero: text => has(text, /WHEN attempt_no = 0 THEN status = 'skipped'/),
    sed_queued: text => has(text, /WHEN status = 'queued'/, /attempt_no > 0/, /lease_id IS NULL/),
    sed_sending: text => has(text, /WHEN status = 'sending'/, /attempt_no > 0/, /lease_id IS NOT NULL/, /started_at IS NOT NULL/),
    sed_success: text => has(text, /WHEN status = 'succeeded'/, /attempt_no > 0/, /started_at IS NOT NULL/),
    sed_unknown: text => has(text, /WHEN status = 'unknown'/, /attempt_no > 0/, /retry_safety = 'unknown'/),
    sed_failed: text => has(text, /WHEN status = 'failed'/, /attempt_no > 0/, /'not_started'/, /'definitive_failure'/),
    sed_skipped: text => has(text, /WHEN status = 'skipped'/, /retry_safety = 'not_applicable'/),
    sed_finish: text => has(text, /'queued'/, /'sending'/, /finished_at IS NULL/, /finished_at IS NOT NULL/),
    sed_lease: text => has(text, /\(lease_id IS NULL\) = \(lease_until IS NULL\)/),
    sed_next: text => has(text, /next_attempt_at IS NULL OR/, /status = 'failed'/),
    sed_order: text => has(text, /started_at >= created_at/, /finished_at >= started_at/),
    sed_times: text => has(text, /isfinite\(created_at\)/, /isfinite\(due_at\)/, /isfinite\(expires_at\)/, /expires_at > created_at/),
  },
}
const KEYS: Record<string, { primary: string; unique: [string, string] }> = {
  [EVENTS]: { primary: 'id', unique: ['se_source_unique', 'producer, source_kind, source_id, source_step, event_type'] },
  [DELIVERIES]: { primary: 'id', unique: ['sed_unique', 'event_id, channel, route_ref, attempt_no'] },
}

/** Problems of one fixture against the lock; empty means it conforms. */
function lockProblems(fixture: Fixture, major: number): string[] {
  const problems: string[] = []
  const fail = (message: string) => { problems.push(message) }
  if (JSON.stringify(Object.keys(fixture).sort()) !== JSON.stringify(['applicationFingerprint', 'digest', 'major', 'sections'])) fail('fixture fields')
  if (fixture.major !== major) fail('major')
  if (fixture.applicationFingerprint !== APPLICATION_SCHEMA_FINGERPRINT) fail('application fingerprint')
  if (fixture.digest !== eventSchemaDigest(fixture.major, fixture.sections)) fail('digest is not recomputed from sections')
  const [tables, columns, constraints, , triggers, rules, policies] = fixture.sections ?? []
  if (fixture.sections?.length !== 7) fail('seven sections')
  if (JSON.stringify((tables ?? []).map(row => row.relname).sort()) !== JSON.stringify([DELIVERIES, EVENTS])
    || (tables ?? []).some(row => row.relkind !== 'r' || row.relpersistence !== 'p' || row.relispartition !== false
      || row.relrowsecurity !== false || row.relforcerowsecurity !== false || row.owner_trusted !== true)) fail('tables')
  for (const [table, expected] of Object.entries(LOCK_COLUMNS)) {
    const actual = (columns ?? []).filter(row => row.relname === table)
    if (JSON.stringify(actual.map(row => [row.attname, row.type, row.attnotnull])) !== JSON.stringify(expected)) fail(`${table} columns`)
    if (actual.some(row => row.attidentity !== '' || row.attgenerated !== '')) fail(`${table} identity or generated columns`)
  }
  const column = (table: string, name: string) => (columns ?? []).find(row => row.relname === table && row.attname === name)
  if (!/^now\(\)$|^CURRENT_TIMESTAMP$/i.test(String(column(EVENTS, 'recorded_at')?.default_expression))) fail('recorded_at default')
  if (!/^'\{\}'::jsonb$/.test(String(column(EVENTS, 'facts')?.default_expression))) fail('facts default')
  const all = constraints ?? []
  if (all.some(row => row.source_schema !== 'public' || row.convalidated !== true || row.condeferrable !== false || !['c', 'f', 'p', 'u'].includes(String(row.contype)))) fail('constraint kinds')
  const foreign = all.filter(row => row.contype === 'f')
  if (foreign.length !== 1 || foreign[0].source !== DELIVERIES || foreign[0].target_schema !== 'public' || foreign[0].target !== EVENTS
    || !/^FOREIGN KEY \(event_id\) REFERENCES (?:public\.)?security_events\s*\(id\) ON DELETE RESTRICT$/.test(String(foreign[0].definition))) fail('foreign key')
  for (const [table, keys] of Object.entries(KEYS)) {
    const own = all.filter(row => row.source === table)
    const primary = own.filter(row => row.contype === 'p'), unique = own.filter(row => row.contype === 'u')
    if (primary.length !== 1 || primary[0].definition !== `PRIMARY KEY (${keys.primary})`) fail(`${table} primary key`)
    if (unique.length !== 1 || unique[0].conname !== keys.unique[0] || unique[0].definition !== `UNIQUE (${keys.unique[1]})`) fail(`${table} unique key`)
    const checks = own.filter(row => row.contype === 'c')
    const names = checks.map(row => String(row.conname))
    if (JSON.stringify(sorted(names)) !== JSON.stringify(sorted(Object.keys(CHECKS[table])))) fail(`${table} CHECK set`)
    const columnNames = LOCK_COLUMNS[table].map(([name]) => name)
    for (const row of checks) {
      const text = String(row.definition)
      const body = /^CHECK \(([\s\S]*)\)$/.exec(text)?.[1] ?? ''
      // A constant, a disjunction with true, or a CHECK that names no column of its table constrains nothing.
      if (!body || /^[\s()]*(?:true|false|null|\d+\s*=\s*\d+)[\s()]*$/i.test(body) || /\bOR\s*\(?\s*true\b/i.test(body)
        || !columnNames.some(name => new RegExp(`\\b${name}\\b`).test(body))) fail(`${table} ${row.conname} is trivial`)
      else if (!CHECKS[table][String(row.conname)]?.(text)) fail(`${table} ${row.conname} lacks the locked semantic`)
    }
  }
  if ((triggers ?? []).length || (rules ?? []).length || (policies ?? []).length) fail('triggers, rules or policies')
  return problems
}

function loadFixture(major: number): Fixture {
  const url = fixtureUrl(major)
  if (!existsSync(url)) throw new Error(`E1A_REVIEWED_SCHEMA_APPROVAL_MISSING: pg${major}.json`)
  return JSON.parse(readFileSync(url, 'utf8'))
}
const redigested = (fixture: Fixture, sections: Row[][]): Fixture => ({ ...fixture, sections, digest: eventSchemaDigest(fixture.major, sections) })
function withConstraint(fixture: Fixture, name: string, definition: string): Fixture {
  const sections = structuredClone(fixture.sections)
  const row = sections[2].find(item => item.conname === name)
  if (!row) throw new Error('unknown constraint ' + name)
  row.definition = definition
  return redigested(fixture, sections)
}

describe('E1-A reviewed PG14-17 schema approvals match the design lock', () => {
  for (const major of [14, 15, 16, 17]) {
    it(`T31 pg${major}: the checked-in approval exists, recomputes its digest and conforms to the lock tables`, () => {
      expect(existsSync(fixtureUrl(major)), `reviewed approval fixture pg${major}.json is missing`).toBe(true)
      const fixture = loadFixture(major)
      expect(fixture.digest).toBe(eventSchemaDigest(fixture.major, fixture.sections))
      expect(lockProblems(fixture, major)).toEqual([])
    })
  }
  it('T31 negative control: CHECK (true) or a weakened lock semantic in any approval is detected', () => {
    const fixture = loadFixture(14)
    expect(lockProblems(fixture, 14)).toEqual([])
    const checks = fixture.sections[2].filter(row => row.contype === 'c')
    expect(checks.length).toBeGreaterThan(40)
    for (const row of checks) {
      const name = String(row.conname)
      expect(lockProblems(withConstraint(fixture, name, 'CHECK (true)'), 14), name).toContain(`${row.source} ${name} is trivial`)
      expect(lockProblems(withConstraint(fixture, name, `CHECK (${String(row.definition).slice(7, -1)} OR true)`), 14), name).toContain(`${row.source} ${name} is trivial`)
    }
    const weakened: [string, string][] = [
      ['se_scope', "CHECK (scope_kind = ANY (ARRAY['organization'::text, 'system'::text, 'tenant'::text]))"],
      ['se_type', "CHECK (char_length(event_type) >= 1 AND char_length(event_type) <= 96 AND event_type ~ '^.+$'::text)"],
      ['se_fact_affected_count', "CHECK (CASE WHEN facts ? 'affected_count'::text THEN jsonb_typeof(facts -> 'affected_count'::text) = 'number'::text ELSE true END)"],
      ['se_facts', "CHECK (jsonb_typeof(facts) = 'object'::text AND octet_length(facts::text) <= 2048 AND (facts - ARRAY['affected_count'::text, 'raw'::text]) = '{}'::jsonb)"],
      ['sed_retry', "CHECK (retry_safety = ANY (ARRAY['not_started'::text, 'unknown'::text, 'not_applicable'::text]))"],
      ['se_org', "CHECK (CASE WHEN scope_kind = 'organization'::text THEN org_id IS NOT NULL AND char_length(org_id) >= 1 AND char_length(org_id) <= 4096 ELSE org_id IS NULL END)"],
    ]
    for (const [name, definition] of weakened) expect(lockProblems(withConstraint(fixture, name, definition), 14), name).toEqual([expect.stringContaining(`${name} lacks the locked semantic`)])
    const sections = structuredClone(fixture.sections)
    sections[2] = sections[2].filter(row => row.conname !== 'sed_zero')
    expect(lockProblems(redigested(fixture, sections), 14)).toContain(`${DELIVERIES} CHECK set`)
    const columns = structuredClone(fixture.sections)
    columns[1].find(row => row.attname === 'source_id')!.attnotnull = false
    expect(lockProblems(redigested(fixture, columns), 14)).toContain(`${EVENTS} columns`)
    const trigger = structuredClone(fixture.sections)
    trigger[4] = [{ relname: EVENTS, tgname: 'late', definition: 'CREATE TRIGGER late' }]
    expect(lockProblems(redigested(fixture, trigger), 14)).toContain('triggers, rules or policies')
    expect(lockProblems({ ...withConstraint(fixture, 'se_scope', 'CHECK (true)'), digest: fixture.digest }, 14)).toContain('digest is not recomputed from sections')
  })
})
