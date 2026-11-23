import { existsSync, readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { APPLICATION_SCHEMA_FINGERPRINT, eventSchemaDigest } from '../../src/security-events/schema'

// Reviewed per-major approvals that the real-database T31 compares the migrated catalog against.
// Every expected row below is written from the design lock section 2 tables (2.1 to 2.4),
// independently of the migration, the registry and the fixtures, and compared for exact equality.
let assertionCount = 0
afterEach(() => { assertionCount += expect.getState().assertionCalls; expect(expect.getState().assertionCalls).toBeGreaterThan(0) })
afterAll(() => { console.info('E1_ASSERTIONS_SCHEMA_APPROVALS=' + assertionCount) })

type Row = Record<string, unknown>
type Fixture = { major: number; digest: string; applicationFingerprint: string; sections: Row[][] }
const MAJORS = [14, 15, 16, 17]
const fixtureUrl = (major: number) => new URL(`../fixtures/security-events/schema-approvals/pg${major}.json`, import.meta.url)
const EVENTS = 'security_events', DELIVERIES = 'security_event_deliveries'
const TZ = 'timestamp with time zone'

/** Whitespace only: runs collapse to one space, no space inside parentheses; an escaped dot equals [.] in regexes. */
const normalize = (text: string) => text.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\\\./g, '[.]').trim()

// Section 0: two ordinary, permanent, non-partitioned tables, no row security (lock I02).
const TABLES: Row[] = [DELIVERIES, EVENTS].map(relname => ({ relname, relkind: 'r', relpersistence: 'p', relispartition: false, relrowsecurity: false, relforcerowsecurity: false, reloptions: null, owner_trusted: true }))

// Section 1: lock 2.1 and 2.3 columns in order: name, type, NOT NULL, default.
const COLUMNS: Record<string, [string, string, boolean, string | null][]> = {
  [EVENTS]: [
    ['id', 'uuid', true, null], ['schema_version', 'smallint', true, '1'], ['scope_kind', 'text', true, null], ['org_id', 'text', false, null],
    ['producer', 'text', true, null], ['event_type', 'text', true, null], ['severity', 'text', true, null], ['outcome', 'text', true, null],
    ['reason_code', 'text', false, null], ['actor_kind', 'text', true, null], ['actor_user_id', 'text', false, null], ['subject_user_id', 'text', false, null],
    ['target_kind', 'text', false, null], ['target_id', 'text', false, null], ['source_kind', 'text', true, null], ['source_id', 'text', true, null],
    ['source_step', 'text', true, null], ['record_origin', 'text', true, null], ['occurred_at', TZ, true, null],
    // recorded_at: DB now default (lock 2.1); facts: default {} (lock 2.1).
    ['recorded_at', TZ, true, 'now()'], ['facts', 'jsonb', true, "'{}'::jsonb"], ['expires_at', TZ, true, null], ['delivery_planned_at', TZ, false, null],
  ],
  [DELIVERIES]: [
    ['id', 'uuid', true, null], ['event_id', 'uuid', true, null], ['channel', 'text', true, null], ['route_ref', 'text', true, null],
    ['attempt_no', 'integer', true, null], ['status', 'text', true, null], ['result_code', 'text', false, null], ['created_at', TZ, true, 'now()'],
    ['due_at', TZ, true, null], ['started_at', TZ, false, null], ['finished_at', TZ, false, null], ['lease_id', 'uuid', false, null],
    ['lease_until', TZ, false, null], ['retry_safety', 'text', true, null], ['next_attempt_at', TZ, false, null], ['expires_at', TZ, true, null],
  ],
}
const columnRows = (): Row[] => [DELIVERIES, EVENTS].flatMap(relname => COLUMNS[relname].map(([attname, type, attnotnull, defaultExpression], index) => ({
  relname, attnum: index + 1, attname, type, attnotnull, attidentity: '', attgenerated: '', collation: type === 'text' ? 'default' : null, default_expression: defaultExpression,
})))

// Closed sets and limits from the lock.
const SCOPES = ['organization', 'system']
const PRODUCERS = ['directory', 'auth', 'security_action', 'authorization', 'admin_grant', 'deprovision', 'platform']
const SEVERITIES = ['info', 'warning', 'error', 'critical']
const OUTCOMES = ['succeeded', 'denied', 'failed', 'observed']
// Lock 2.1 fixes reason_code as a closed set of fixed internal codes; the members are the codes the lock text names.
const REASONS = ['sync_failed', 'refusal_window', 'startup_tail_unverified', 'aggregation_overflow', 'source_missing', 'event_store_unavailable', 'scan_interrupted', 'empty_directory_fetch', 'batch_exceeds_max', 'redirect_refused']
const ACTORS = ['user', 'system', 'anonymous']
const TARGET_KINDS = ['integration', 'user', 'membership', 'grant', 'operation', 'run', 'component']
const SOURCE_KINDS = ['sync_run', 'deprovision_effect', 'auth_operation', 'admin_grant_command', 'request', 'runtime_probe', 'request_window']
const ORIGINS = ['live', 'backfill', 'reconcile']
const CHANNELS = ['none', 'legacy_directory_webhook', 'group_extension']
const STATUSES = ['queued', 'sending', 'succeeded', 'failed', 'unknown', 'skipped']
// Lock 2.3 lists these result codes; delivered is the result of a succeeded attempt (platform accepted, lock 5.2).
const RESULTS = ['channel_unconfigured', 'plugin_unavailable', 'source_not_eligible', 'transport_not_started', 'provider_rejected', 'send_outcome_unknown', 'legacy_sent_observed', 'legacy_outcome_unknown', 'attempt_limit', 'delivered']
const SKIP_RESULTS = ['channel_unconfigured', 'plugin_unavailable', 'source_not_eligible', 'legacy_sent_observed', 'legacy_outcome_unknown', 'attempt_limit']
const RETRY = ['not_started', 'definitive_failure', 'unknown', 'not_applicable']
const COUNT_KEYS = ['affected_count', 'failed_count', 'pending_count', 'attempt_count', 'threshold_days']
const BOOLEAN_KEYS = ['membership_changed', 'grant_revoked', 'user_deactivated', 'source_missing', 'count_unknown', 'sampled', 'truncated']
const FACT_KEYS = [...COUNT_KEYS, 'duration_ms', ...BOOLEAN_KEYS]

const array = (values: readonly string[]) => `ARRAY[${values.map(value => `'${value}'::text`).join(', ')}]`
const oneOf = (column: string, values: readonly string[]) => `CHECK (${column} = ANY (${array(values)}))`
const length = (column: string, max: number) => `char_length(${column}) >= 1 AND char_length(${column}) <= ${max}`
const when = (condition: string, then: string, otherwise = 'true') => `CHECK (CASE WHEN ${condition} THEN ${then} ELSE ${otherwise} END)`
const numberFact = (key: string, max: string) => {
  const value = `((facts ->> '${key}'::text)::numeric)`
  return when(`facts ? '${key}'::text`, `jsonb_typeof(facts -> '${key}'::text) = 'number'::text AND ${value} >= 0::numeric AND ${value} <= ${max} AND trunc((facts ->> '${key}'::text)::numeric) = ${value}`)
}
const booleanFact = (key: string) => when(`facts ? '${key}'::text`, `jsonb_typeof(facts -> '${key}'::text) = 'boolean'::text`)

// Section 2: every constraint, exactly.
const CHECKS: Record<string, Record<string, string>> = {
  [EVENTS]: {
    se_version: 'CHECK (schema_version = 1)',
    se_scope: oneOf('scope_kind', SCOPES),
    se_org: when(`scope_kind = 'organization'::text`, `org_id IS NOT NULL AND ${length('org_id', 128)}`, 'org_id IS NULL'),
    se_producer: oneOf('producer', PRODUCERS),
    se_type: `CHECK (${length('event_type', 96)} AND event_type ~ '^[a-z_]+\\.[a-z_]+$'::text)`,
    se_severity: oneOf('severity', SEVERITIES),
    se_outcome: oneOf('outcome', OUTCOMES),
    se_reason: oneOf('reason_code', REASONS),
    se_actor_kind: oneOf('actor_kind', ACTORS),
    se_actor: when(`actor_kind = 'user'::text`, `actor_user_id IS NOT NULL AND ${length('actor_user_id', 128)}`, 'actor_user_id IS NULL'),
    se_subject: `CHECK (subject_user_id IS NULL OR ${length('subject_user_id', 128)})`,
    se_target_kind: oneOf('target_kind', TARGET_KINDS),
    se_target: when('target_kind IS NULL', 'target_id IS NULL', `target_id IS NOT NULL AND ${length('target_id', 128)}`),
    se_source_kind: oneOf('source_kind', SOURCE_KINDS),
    se_source_id: `CHECK (${length('source_id', 512)} AND octet_length(source_id) <= 2048)`,
    se_source_step: `CHECK (${length('source_step', 64)} AND source_step ~ '^[a-z_]+$'::text)`,
    se_origin: oneOf('record_origin', ORIGINS),
    se_times: 'CHECK (isfinite(occurred_at) AND isfinite(recorded_at) AND isfinite(expires_at) AND expires_at > recorded_at AND (delivery_planned_at IS NULL OR isfinite(delivery_planned_at)))',
    se_facts: `CHECK (jsonb_typeof(facts) = 'object'::text AND octet_length(facts::text) <= 2048 AND (facts - ${array(FACT_KEYS)}) = '{}'::jsonb)`,
    ...Object.fromEntries(COUNT_KEYS.map(key => [`se_fact_${key}`, numberFact(key, '2147483647::numeric')])),
    se_fact_duration_ms: numberFact('duration_ms', "'9007199254740991'::bigint::numeric"),
    ...Object.fromEntries(BOOLEAN_KEYS.map(key => [`se_fact_${key}`, booleanFact(key)])),
  },
  // Lock 2.3: closed sets, the route key, and the state, time, lease and attempt combinations.
  [DELIVERIES]: {
    sed_attempt: 'CHECK (attempt_no >= 0 AND attempt_no <= 5)',
    sed_channel: oneOf('channel', CHANNELS),
    sed_status: oneOf('status', STATUSES),
    sed_result: oneOf('result_code', RESULTS),
    sed_retry: oneOf('retry_safety', RETRY),
    sed_route: `CHECK (${length('route_ref', 128)} AND route_ref ~ '^[a-z_]+([.][a-z_]+)*$'::text)`,
    // First version: none or legacy.directory_sync; legacy has a single attempt and never queues.
    sed_channel_shape: `CHECK (CASE WHEN channel = 'none'::text THEN route_ref = 'none'::text AND status = 'skipped'::text WHEN channel = 'legacy_directory_webhook'::text THEN route_ref = 'legacy.directory_sync'::text AND attempt_no <= 1 AND status <> 'queued'::text ELSE true END)`,
    sed_zero: when('attempt_no = 0', `status = 'skipped'::text AND started_at IS NULL AND lease_id IS NULL AND lease_until IS NULL AND retry_safety = 'not_applicable'::text`, `status <> 'skipped'::text OR started_at IS NULL`),
    sed_queued: when(`status = 'queued'::text`, `attempt_no > 0 AND started_at IS NULL AND lease_id IS NULL AND retry_safety = 'not_started'::text`),
    sed_sending: when(`status = 'sending'::text`, `attempt_no > 0 AND started_at IS NOT NULL AND lease_id IS NOT NULL AND lease_until > started_at AND retry_safety = 'unknown'::text`),
    sed_success: when(`status = 'succeeded'::text`, `attempt_no > 0 AND started_at IS NOT NULL AND lease_id IS NOT NULL AND retry_safety = 'not_applicable'::text AND result_code = 'delivered'::text`),
    sed_unknown: when(`status = 'unknown'::text`, `attempt_no > 0 AND started_at IS NOT NULL AND lease_id IS NOT NULL AND retry_safety = 'unknown'::text AND result_code = 'send_outcome_unknown'::text`),
    sed_failed: when(`status = 'failed'::text`, `attempt_no > 0 AND CASE WHEN retry_safety = 'not_started'::text THEN started_at IS NULL AND lease_id IS NULL AND result_code = 'transport_not_started'::text WHEN retry_safety = 'definitive_failure'::text THEN started_at IS NOT NULL AND lease_id IS NOT NULL AND result_code = 'provider_rejected'::text ELSE false END`),
    sed_skipped: when(`status = 'skipped'::text`, `started_at IS NULL AND lease_id IS NULL AND retry_safety = 'not_applicable'::text AND (result_code = ANY (${array(SKIP_RESULTS)}))`),
    sed_finish: `CHECK (CASE WHEN status = ANY (${array(['queued', 'sending'])}) THEN finished_at IS NULL AND result_code IS NULL ELSE finished_at IS NOT NULL AND finished_at >= created_at AND result_code IS NOT NULL END)`,
    sed_lease: 'CHECK ((lease_id IS NULL) = (lease_until IS NULL) AND (lease_id IS NULL OR started_at IS NOT NULL AND lease_until > started_at))',
    sed_next: `CHECK (next_attempt_at IS NULL OR status = 'failed'::text AND (retry_safety = ANY (${array(['not_started', 'definitive_failure'])})) AND attempt_no < 5 AND next_attempt_at >= finished_at)`,
    sed_order: 'CHECK (started_at IS NULL OR started_at >= created_at AND (finished_at IS NULL OR finished_at >= started_at))',
    sed_times: 'CHECK (isfinite(created_at) AND isfinite(due_at) AND isfinite(expires_at) AND expires_at > created_at AND due_at >= created_at AND (started_at IS NULL OR isfinite(started_at)) AND (finished_at IS NULL OR isfinite(finished_at)) AND (lease_until IS NULL OR isfinite(lease_until)) AND (next_attempt_at IS NULL OR isfinite(next_attempt_at)))',
  },
}
const constraint = (source: string, conname: string, contype: string, definition: string, target: string | null = null): Row => ({
  source_schema: 'public', source, conname, contype, convalidated: true, condeferrable: false, condeferred: false,
  target_schema: target ? 'public' : null, target, definition,
})
const constraintRows = (): Row[] => [
  ...Object.entries(CHECKS).flatMap(([table, checks]) => Object.entries(checks).map(([name, definition]) => constraint(table, name, 'c', definition))),
  constraint(EVENTS, 'security_events_pkey', 'p', 'PRIMARY KEY (id)'),
  // Lock 2.1 :68 idempotency key; lock 2.3 :111 attempt key; the only FK, between the new tables (lock 2.3 :94).
  constraint(EVENTS, 'se_source_unique', 'u', 'UNIQUE (producer, source_kind, source_id, source_step, event_type)'),
  constraint(DELIVERIES, 'security_event_deliveries_pkey', 'p', 'PRIMARY KEY (id)'),
  constraint(DELIVERIES, 'sed_unique', 'u', 'UNIQUE (event_id, channel, route_ref, attempt_no)'),
  constraint(DELIVERIES, 'security_event_deliveries_event_id_fkey', 'f', 'FOREIGN KEY (event_id) REFERENCES security_events(id) ON DELETE RESTRICT', EVENTS),
]

// Section 3: every index, exactly.
const index = (table: string, name: string, unique: boolean, columns: string, where?: string, primary = false): Row => ({
  table_name: table, index_name: name, indisunique: unique, indisprimary: primary, indisvalid: true, indisready: true, indislive: true,
  definition: `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${name} ON public.${table} USING btree (${columns})${where ? ` WHERE (${where})` : ''}`,
})
const indexRows = (): Row[] => [
  // Lock 2.1 :78: organization and system time indexes, the unique key and the expiry cleanup index.
  index(EVENTS, 'security_events_pkey', true, 'id', undefined, true),
  index(EVENTS, 'se_org_time', false, 'org_id, recorded_at DESC, id DESC', "scope_kind = 'organization'::text"),
  index(EVENTS, 'se_system_time', false, 'recorded_at DESC, id DESC', "scope_kind = 'system'::text"),
  index(EVENTS, 'se_source_unique', true, 'producer, source_kind, source_id, source_step, event_type'),
  index(EVENTS, 'se_expiry', false, 'expires_at, id'),
  // DEVIATION from lock 2.1 :78 (composite indexes only after a measured need): present in the migration,
  // recorded here exactly as they are, and awaiting an owner or lock-author ruling.
  index(EVENTS, 'se_org_type_time', false, 'org_id, event_type, recorded_at DESC, id DESC', "scope_kind = 'organization'::text"),
  index(EVENTS, 'se_system_type_time', false, 'event_type, recorded_at DESC, id DESC', "scope_kind = 'system'::text"),
  // Lock 2.3 :111: attempt key, one queued or sending per event/channel/route, claim queue and detail order;
  // lock 2.4 cleanup of terminal deliveries by expiry.
  index(DELIVERIES, 'security_event_deliveries_pkey', true, 'id', undefined, true),
  index(DELIVERIES, 'sed_unique', true, 'event_id, channel, route_ref, attempt_no'),
  index(DELIVERIES, 'sed_active', true, 'event_id, channel, route_ref', `status = ANY (${array(['queued', 'sending'])})`),
  index(DELIVERIES, 'sed_queue', false, 'status, due_at'),
  index(DELIVERIES, 'sed_event_time', false, 'event_id, created_at, id'),
  index(DELIVERIES, 'sed_expiry', false, 'expires_at, id'),
]

const normalizedRows = (rows: Row[] | undefined, key: (row: Row) => string) => [...(rows ?? [])]
  .map(row => ({ ...row, ...(typeof row.definition === 'string' ? { definition: normalize(row.definition) } : {}) }))
  .sort((a, b) => key(a).localeCompare(key(b)))
const constraintKey = (row: Row) => `${row.source}/${row.conname}`
const indexKey = (row: Row) => `${row.table_name}/${row.index_name}`

/** Problems of one fixture against the lock; empty means it conforms exactly. */
function lockProblems(fixture: Fixture, major: number): string[] {
  const problems: string[] = []
  const same = (actual: unknown, expected: unknown) => isDeepStrictEqual(actual, expected)
  if (!same(Object.keys(fixture).sort(), ['applicationFingerprint', 'digest', 'major', 'sections'])) problems.push('fixture fields')
  if (fixture.major !== major) problems.push('major')
  if (fixture.applicationFingerprint !== APPLICATION_SCHEMA_FINGERPRINT) problems.push('application fingerprint')
  if (fixture.digest !== eventSchemaDigest(fixture.major, fixture.sections)) problems.push('digest is not recomputed from sections')
  const sections = fixture.sections ?? []
  if (sections.length !== 7) problems.push('seven sections')
  if (!same(sections[0], TABLES)) problems.push('tables')
  if (!same(sections[1], columnRows())) problems.push('columns')
  const constraints = normalizedRows(sections[2], constraintKey), expectedConstraints = normalizedRows(constraintRows(), constraintKey)
  if (!same(constraints.map(constraintKey), expectedConstraints.map(constraintKey))) problems.push('constraint set')
  for (const row of constraints) {
    const expected = expectedConstraints.find(item => constraintKey(item) === constraintKey(row))
    if (expected && !same(row, expected)) problems.push(`constraint ${constraintKey(row)}`)
  }
  const indexes = normalizedRows(sections[3], indexKey), expectedIndexes = normalizedRows(indexRows(), indexKey)
  if (!same(indexes.map(indexKey), expectedIndexes.map(indexKey))) problems.push('index set')
  for (const row of indexes) {
    const expected = expectedIndexes.find(item => indexKey(item) === indexKey(row))
    if (expected && !same(row, expected)) problems.push(`index ${indexKey(row)}`)
  }
  for (const [position, name] of [[4, 'triggers'], [5, 'rules'], [6, 'policies']] as const) if (!same(sections[position], [])) problems.push(name)
  return problems
}

function loadFixture(major: number): Fixture {
  const url = fixtureUrl(major)
  if (!existsSync(url)) throw new Error(`E1A_REVIEWED_SCHEMA_APPROVAL_MISSING: pg${major}.json`)
  return JSON.parse(readFileSync(url, 'utf8'))
}
/** Every control is re-digested, so only the content comparison can catch it. */
function altered(fixture: Fixture, change: (sections: Row[][]) => void): Fixture {
  const sections = structuredClone(fixture.sections)
  change(sections)
  return { ...fixture, sections, digest: eventSchemaDigest(fixture.major, sections) }
}
function setConstraint(fixture: Fixture, name: string, rewrite: (definition: string) => string): Fixture {
  return altered(fixture, sections => {
    const row = sections[2].find(item => item.conname === name)
    if (!row) throw new Error('unknown constraint ' + name)
    const next = rewrite(String(row.definition))
    if (next === row.definition) throw new Error('control did not change ' + name)
    row.definition = next
  })
}
const body = (definition: string) => /^CHECK \(([\s\S]*)\)$/.exec(definition)![1]

describe('E1-A reviewed PG14-17 schema approvals match the design lock exactly', () => {
  for (const major of MAJORS) {
    it(`T31 pg${major}: the checked-in approval exists, recomputes its digest and equals the lock tables`, () => {
      expect(existsSync(fixtureUrl(major)), `reviewed approval fixture pg${major}.json is missing`).toBe(true)
      const fixture = loadFixture(major)
      expect(fixture.digest).toBe(eventSchemaDigest(fixture.major, fixture.sections))
      expect(lockProblems(fixture, major)).toEqual([])
    })
  }
  it('T31 the four approvals have identical sections; only the major differs', () => {
    const [first, ...rest] = MAJORS.map(loadFixture)
    for (const fixture of rest) expect(fixture.sections).toEqual(first.sections)
    expect(new Set(MAJORS.map(major => loadFixture(major).digest)).size).toBe(4)
  })
  it('T31 negative control: every weakening of a constraint or index is reported even with a recomputed digest', () => {
    const fixture = loadFixture(14)
    expect(lockProblems(fixture, 14)).toEqual([])
    const checks = fixture.sections[2].filter(row => row.contype === 'c')
    expect(checks).toHaveLength(Object.keys(CHECKS[EVENTS]).length + Object.keys(CHECKS[DELIVERIES]).length)
    for (const row of checks) {
      const name = String(row.conname), reported = `constraint ${row.source}/${name}`
      for (const rewrite of [
        () => 'CHECK (true)',
        (definition: string) => `CHECK (true OR ${body(definition)})`,
        (definition: string) => `CHECK (${body(definition)} OR true)`,
        (definition: string) => `CHECK (${body(definition)} OR 1 = 1)`,
        (definition: string) => `CHECK (CASE WHEN false THEN ${body(definition)} ELSE true END)`,
      ]) expect(lockProblems(setConstraint(fixture, name, rewrite), 14), name).toEqual([reported])
    }
    const weakened: [string, (definition: string) => string][] = [
      ['se_fact_affected_count', definition => definition.replace('<= 2147483647::numeric', '<= 21474836470::numeric')],
      ['se_fact_duration_ms', definition => definition.replace("'9007199254740991'", "'90071992547409910'")],
      ['sed_route', () => 'CHECK (char_length(route_ref) >= 1 AND char_length(route_ref) <= 128)'],
      ['sed_channel_shape', definition => definition.replace(" AND attempt_no <= 1 AND status <> 'queued'::text", '')],
      ['se_reason', definition => definition.replace("'redirect_refused'::text", "'redirect_refused'::text, 'exception_text'::text")],
      ['se_scope', definition => definition.replace("'system'::text", "'system'::text, 'tenant'::text")],
      ['se_type', definition => definition.replace('^[a-z_]+[.][a-z_]+$', '^.+$')],
      ['se_facts', definition => definition.replace("'truncated'::text", "'truncated'::text, 'raw'::text")],
      ['se_org', definition => definition.replace('char_length(org_id) <= 128', 'char_length(org_id) <= 4096')],
      ['security_event_deliveries_event_id_fkey', definition => definition.replace('RESTRICT', 'CASCADE')],
    ]
    for (const [name, rewrite] of weakened) {
      const row = fixture.sections[2].find(item => item.conname === name)!
      expect(lockProblems(setConstraint(fixture, name, rewrite), 14), name).toEqual([`constraint ${row.source}/${name}`])
    }
    const indexControls: [string, (sections: Row[][]) => void, string][] = [
      ['drop sed_active', sections => { sections[3] = sections[3].filter(row => row.index_name !== 'sed_active') }, 'index set'],
      ['drop se_org_time', sections => { sections[3] = sections[3].filter(row => row.index_name !== 'se_org_time') }, 'index set'],
      ['sed_active not unique', sections => { const row = sections[3].find(item => item.index_name === 'sed_active')!; row.indisunique = false; row.definition = String(row.definition).replace('UNIQUE ', '') }, `index ${DELIVERIES}/sed_active`],
      ['sed_active without its predicate', sections => { const row = sections[3].find(item => item.index_name === 'sed_active')!; row.definition = String(row.definition).replace(/ WHERE .*$/, '') }, `index ${DELIVERIES}/sed_active`],
      ['se_org_time on other columns', sections => { const row = sections[3].find(item => item.index_name === 'se_org_time')!; row.definition = String(row.definition).replace('org_id, recorded_at DESC', 'recorded_at DESC') }, `index ${EVENTS}/se_org_time`],
      ['invalid index', sections => { sections[3].find(item => item.index_name === 'sed_queue')!.indisvalid = false }, `index ${DELIVERIES}/sed_queue`],
      ['extra index', sections => { sections[3].push({ ...sections[3][0], index_name: 'extra', definition: 'CREATE INDEX extra ON public.security_events USING btree (severity)' }) }, 'index set'],
    ]
    for (const [label, change, reported] of indexControls) expect(lockProblems(altered(fixture, change), 14), label).toEqual([reported])
    const otherControls: [string, (sections: Row[][]) => void, string][] = [
      ['drop sed_zero', sections => { sections[2] = sections[2].filter(row => row.conname !== 'sed_zero') }, 'constraint set'],
      ['source_id nullable', sections => { sections[1].find(row => row.attname === 'source_id')!.attnotnull = false }, 'columns'],
      ['org_id collation', sections => { sections[1].find(row => row.attname === 'org_id')!.collation = 'C' }, 'columns'],
      ['schema_version default', sections => { sections[1].find(row => row.attname === 'schema_version')!.default_expression = '2' }, 'columns'],
      ['reloptions', sections => { sections[0][1].reloptions = ['fillfactor=50'] }, 'tables'],
      ['trigger', sections => { sections[4] = [{ relname: EVENTS, tgname: 'late', definition: 'CREATE TRIGGER late' }] }, 'triggers'],
    ]
    for (const [label, change, reported] of otherControls) expect(lockProblems(altered(fixture, change), 14), label).toEqual([reported])
    expect(lockProblems({ ...setConstraint(fixture, 'se_scope', () => 'CHECK (true)'), digest: fixture.digest }, 14)).toContain('digest is not recomputed from sections')
  })
  it('T31 normalization changes whitespace and the regex dot spelling only', () => {
    expect(normalize('CHECK (\nCASE\n    WHEN a THEN b\n    ELSE true\nEND)')).toBe('CHECK (CASE WHEN a THEN b ELSE true END)')
    expect(normalize("x ~ '^a\\.b$'")).toBe(normalize("x ~ '^a[.]b$'"))
    expect(normalize('CHECK (a OR 1 = 1)')).not.toBe(normalize('CHECK (a)'))
  })
})
