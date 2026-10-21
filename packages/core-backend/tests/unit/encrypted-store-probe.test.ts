/**
 * #6164 step 1 — the read-only encrypted-store probe (src/security/encrypted-store-probe.ts).
 *
 * Fixtures are sealed by the REAL writers of each store, so a probe that misreads an envelope fails
 * here rather than in production:
 *   - platform `enc:`          encryptStoredSecretValue (security/encrypted-secrets.ts)
 *   - attendance `enc:`        plugin-attendance's own copy (encryptIntegrationSecretValue)
 *   - system_configs           ConfigService SecretManager.encrypt (bare payload, no `enc:`), and the
 *                              `enc:`-prefixed shape DatabaseConfigSource decrypts
 *   - integration credentials  plugin-integration-core credential store: host security service (`enc:`)
 *                              and the legacy `v1:` cipher under the plugin's own key
 * Every secret below is an obvious fake marker; material A / B are fixture strings. The database is a
 * memory-level fake keyed by the catalog's own SQL; it records every statement it receives.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { encryptStoredSecretValue } from '../../src/security/encrypted-secrets'
import ts from 'typescript'

import { SENSITIVE_CREDENTIAL_KEYS } from '../../src/data-adapters/DataSourceManager'
import {
  ENCRYPTED_STORE_CATALOG,
  ENCRYPTED_STORE_COLUMNS_SQL,
  ENCRYPTED_STORE_REENTER_HINT,
  probeEncryptedStores,
  probeEncryptedStoresShared,
  runEncryptedStoreProbeAtStartup,
  type EncryptedStoreCatalogEntry,
  type EncryptedStoreProbeReport,
} from '../../src/security/encrypted-store-probe'
import { PluginRuntimeSecurityService } from '../../src/security/plugin-runtime-security-service'
import { SecretManager } from '../../src/services/ConfigService'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const credentialStoreModule = require('../../../../plugins/plugin-integration-core/lib/credential-store.cjs')

const MATERIAL_A = { key: 'probe-fixture-material-A-key-0123456789abcdef', salt: 'probe-fixture-material-A-salt-0123456789ab' }
const MATERIAL_B = { key: 'probe-fixture-material-B-key-fedcba9876543210', salt: 'probe-fixture-material-B-salt-ba9876543210' }
const ENV_A = { NODE_ENV: 'test', ENCRYPTION_KEY: MATERIAL_A.key, ENCRYPTION_SALT: MATERIAL_A.salt }
const ENV_B = { NODE_ENV: 'test', ENCRYPTION_KEY: MATERIAL_B.key, ENCRYPTION_SALT: MATERIAL_B.salt }
/** The plugin's own `v1:` key — a fixture, never platform material. */
const V1_FIXTURE_KEY = Buffer.alloc(32, 7)

const M = (name: string) => `MARKER-probe-${name}-7c41e0a9`

type Material = typeof MATERIAL_A
type FixtureRows = Record<string, unknown[] | Error>

/** Run `fn` with process.env carrying `material` (the writers read process.env), then restore. */
async function under<T>(material: Material, fn: () => T | Promise<T>): Promise<T> {
  const saved = { node: process.env.NODE_ENV, key: process.env.ENCRYPTION_KEY, salt: process.env.ENCRYPTION_SALT }
  process.env.NODE_ENV = 'test'
  process.env.ENCRYPTION_KEY = material.key
  process.env.ENCRYPTION_SALT = material.salt
  try {
    return await fn()
  } finally {
    for (const [name, value] of [['NODE_ENV', saved.node], ['ENCRYPTION_KEY', saved.key], ['ENCRYPTION_SALT', saved.salt]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

const sealPlatform = (m: Material, plaintext: string) => under(m, () => encryptStoredSecretValue(plaintext))
const sealAttendance = (m: Material, plaintext: string) =>
  under(m, () => attendancePlugin.__attendanceIntegrationSecretForTests.encryptIntegrationSecretValue(plaintext) as string)
const sealSystemConfigBare = (m: Material, plaintext: string) => under(m, () => new SecretManager().encrypt(plaintext))
const sealIntegrationHost = (m: Material, plaintext: string) =>
  under(m, () => credentialStoreModule.createCredentialStore({ security: new PluginRuntimeSecurityService() }).encrypt(plaintext) as Promise<string>)
const sealIntegrationV1 = (plaintext: string) => credentialStoreModule.__internals.encrypt(plaintext, V1_FIXTURE_KEY) as string

/** A memory-level database keyed by the catalog's SQL. Records every statement. */
/**
 * The live schema the fake database reports through the existence precheck: every catalog table with
 * every column its entries reference (plus an unrelated `id`), unless a test overrides a table —
 * `null` = the table does not exist, an array = exactly those columns.
 */
function fixtureSchema(overrides: Record<string, string[] | null> = {}): Map<string, string[] | null> {
  const schema = new Map<string, string[] | null>()
  for (const entry of ENCRYPTED_STORE_CATALOG) {
    schema.set(entry.store, [...new Set([...(schema.get(entry.store) ?? ['id']), ...entry.columns])])
  }
  for (const [table, columns] of Object.entries(overrides)) schema.set(table, columns)
  return schema
}

/** A memory-level database: answers the existence precheck from a schema, the catalog SQL from rows. */
function fakeDatabase(rowsByField: FixtureRows, schema: Map<string, string[] | null> = fixtureSchema()) {
  const statements: Array<{ sql: string; params: unknown[] | undefined }> = []
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    statements.push({ sql, params })
    if (sql === ENCRYPTED_STORE_COLUMNS_SQL) {
      const columns = schema.get(String(params?.[0])) ?? null
      return { rows: (columns ?? []).map((attname) => ({ attname })) }
    }
    const entry = ENCRYPTED_STORE_CATALOG.find((candidate) => candidate.sql === sql)
    if (!entry) throw new Error('fixture database: unexpected statement')
    // Like PostgreSQL: a SELECT on an absent relation / column is REJECTED (a server-side ERROR).
    const live = schema.get(entry.store) ?? null
    if (live === null) throw sqlError('42P01', 'fixture database: relation does not exist')
    if (entry.columns.some((column) => !live.includes(column))) throw sqlError('42703', 'fixture database: column does not exist')
    const rows = rowsByField[`${entry.store}.${entry.field}`] ?? []
    if (rows instanceof Error) throw rows
    const limit = Number(params?.[0])
    return { rows: rows.slice(0, Number.isFinite(limit) ? limit : rows.length).map((value) => ({ value })) }
  })
  const catalogStatements = () => statements.filter((s) => s.sql !== ENCRYPTED_STORE_COLUMNS_SQL)
  const prechecks = () => statements.filter((s) => s.sql === ENCRYPTED_STORE_COLUMNS_SQL)
  return { query, statements, catalogStatements, prechecks }
}

const CATALOG_TABLES = [...new Set(ENCRYPTED_STORE_CATALOG.map((e) => e.store))]

function sqlError(code: string | undefined, message: string): Error {
  const error = new Error(message)
  if (code !== undefined) (error as Error & { code?: string }).code = code
  return error
}

/** The stable, comparable part of a report: one line per store field. */
function table(report: EncryptedStoreProbeReport) {
  return report.stores.map((s) => [
    `${s.store}.${s.field}`, s.status, s.rows, s.encrypted, s.undecryptable, s.plaintext, s.legacyNotChecked ?? null,
  ])
}

const EXPECTED_STORE_FIELDS = [
  'data_sources.config.credentials.password',
  'data_sources.config.credentials.apiKey',
  'data_sources.config.credentials.token',
  'directory_integrations.config.appSecret',
  'directory_integrations.config.workNotificationAgentId|agentId',
  'directory_integrations.config.approvalCardLinkSecret',
  'dingtalk_group_destinations.webhook_url',
  'dingtalk_group_destinations.secret',
  'integration_external_systems.credentials_encrypted',
  'attendance_integrations.config.appSecret|appsecret|app_secret',
  'system_configs.value (is_encrypted)',
]

const fixture: { rows: FixtureRows; sealed: string[]; plaintexts: string[] } = { rows: {}, sealed: [], plaintexts: [] }

beforeAll(async () => {
  const p = async (name: string) => {
    fixture.plaintexts.push(M(name))
    const sealed = await sealPlatform(MATERIAL_A, M(name))
    fixture.sealed.push(sealed)
    return sealed
  }
  const webhook = `https://robot.fixture.invalid/send?access_token=${M('robot-token')}`
  fixture.plaintexts.push(webhook, M('robot-token'), M('ies-pw'), M('ies-v1'), M('att-secret'), M('sys-1'), M('sys-2'))
  const sealedWebhook = await sealPlatform(MATERIAL_A, webhook)
  const hostSealed = await sealIntegrationHost(MATERIAL_A, JSON.stringify({ password: M('ies-pw') }))
  const v1Sealed = sealIntegrationV1(M('ies-v1'))
  const attendanceSealed = await sealAttendance(MATERIAL_A, M('att-secret'))
  const sysPrefixed = `enc:${await sealSystemConfigBare(MATERIAL_A, JSON.stringify(M('sys-1')))}`
  const sysBare = await sealSystemConfigBare(MATERIAL_A, JSON.stringify(M('sys-2')))
  const agentSealed = await sealPlatform(MATERIAL_A, '1234567')
  fixture.sealed.push(sealedWebhook, hostSealed, v1Sealed, attendanceSealed, sysPrefixed, sysBare, agentSealed)

  fixture.rows = {
    'data_sources.config.credentials.password': [await p('ds-pw-1'), await p('ds-pw-2'), M('ds-pw-plain')],
    'data_sources.config.credentials.apiKey': [await p('ds-key')],
    'data_sources.config.credentials.token': [],
    'directory_integrations.config.appSecret': [await p('dir-secret')],
    'directory_integrations.config.workNotificationAgentId|agentId': [agentSealed, '7654321'],
    'directory_integrations.config.approvalCardLinkSecret': [await p('card-link')],
    'dingtalk_group_destinations.webhook_url': [sealedWebhook],
    'dingtalk_group_destinations.secret': [await p('robot-secret'), M('robot-secret-plain')],
    'integration_external_systems.credentials_encrypted': [hostSealed, v1Sealed, M('ies-plain')],
    'attendance_integrations.config.appSecret|appsecret|app_secret': [attendanceSealed],
    // jsonb or text column: an `enc:` reader shape, a bare SecretManager payload, JSON, an object, short text
    'system_configs.value (is_encrypted)': [sysPrefixed, sysBare, '"plain-config-value"', { nested: true }, 'short'],
  }
  fixture.plaintexts.push(M('ds-pw-plain'), M('robot-secret-plain'), M('ies-plain'))
}, 60_000)

afterEach(() => {
  vi.restoreAllMocks()
})

const EXPECTED_UNDER_A = [
  ['data_sources.config.credentials.password', 'ok', 3, 2, 0, 1, null],
  ['data_sources.config.credentials.apiKey', 'ok', 1, 1, 0, 0, null],
  ['data_sources.config.credentials.token', 'ok', 0, 0, 0, 0, null],
  ['directory_integrations.config.appSecret', 'ok', 1, 1, 0, 0, null],
  ['directory_integrations.config.workNotificationAgentId|agentId', 'ok', 2, 1, 0, 1, null],
  ['directory_integrations.config.approvalCardLinkSecret', 'ok', 1, 1, 0, 0, null],
  ['dingtalk_group_destinations.webhook_url', 'ok', 1, 1, 0, 0, null],
  ['dingtalk_group_destinations.secret', 'ok', 2, 1, 0, 1, null],
  ['integration_external_systems.credentials_encrypted', 'ok', 3, 1, 0, 1, 1],
  ['attendance_integrations.config.appSecret|appsecret|app_secret', 'ok', 1, 1, 0, 0, null],
  ['system_configs.value (is_encrypted)', 'ok', 5, 2, 0, 3, null],
]

describe('probeEncryptedStores: trial decrypt with the current material', () => {
  it('material A opens every value sealed under A: undecryptable 0 in every store, exact counts', async () => {
    const db = fakeDatabase(fixture.rows)
    const report = await probeEncryptedStores({ query: db.query, env: ENV_A })
    expect(report.material).toEqual({ status: 'ok', issues: [] })
    expect(report.decryptChecked).toBe(true)
    expect(table(report)).toEqual(EXPECTED_UNDER_A)
    expect(report.totals).toEqual({ encrypted: 12, undecryptable: 0, plaintext: 7, legacyNotChecked: 1, unreadable: 0, missing: 0 })
  })

  it('material B (the key changed): every encrypted value is undecryptable; plaintext and legacy counts unchanged', async () => {
    const db = fakeDatabase(fixture.rows)
    const report = await probeEncryptedStores({ query: db.query, env: ENV_B })
    expect(table(report)).toEqual(EXPECTED_UNDER_A.map((row) => {
      const copy = [...row]
      copy[4] = row[3] // undecryptable = encrypted
      return copy
    }))
    expect(report.totals).toMatchObject({ encrypted: 12, undecryptable: 12, plaintext: 7, legacyNotChecked: 1 })
  })

  it('mixed material: only the values sealed under the OTHER material count as undecryptable', async () => {
    const underB = await sealPlatform(MATERIAL_B, M('ds-pw-b'))
    const db = fakeDatabase({
      'data_sources.config.credentials.password': [(fixture.rows['data_sources.config.credentials.password'] as string[])[0], underB],
    })
    const report = await probeEncryptedStores({ query: db.query, env: ENV_A })
    expect(report.stores[0]).toMatchObject({ status: 'ok', rows: 2, encrypted: 2, undecryptable: 1, plaintext: 0 })
    expect(report.totals.undecryptable).toBe(1)
  })

  it('system_configs: BOTH SecretManager envelopes are encrypted (bare rotateKey shape and the `enc:` reader shape); JSON / short text / objects are plaintext', async () => {
    const [prefixed, bare] = fixture.rows['system_configs.value (is_encrypted)'] as string[]
    expect(prefixed.startsWith('enc:')).toBe(true)
    expect(bare.startsWith('enc:')).toBe(false)
    for (const [label, rows, expected] of [
      ['bare only', [bare], { encrypted: 1, plaintext: 0 }],
      ['prefixed only', [prefixed], { encrypted: 1, plaintext: 0 }],
      ['JSON, object, short text, digits', ['"plain-config-value"', { nested: true }, 'short', '1234567890123456789012345678901234567890123456789012'], { encrypted: 0, plaintext: 4 }],
    ] as const) {
      const db = fakeDatabase({ 'system_configs.value (is_encrypted)': [...rows] })
      for (const [env, undecryptable] of [[ENV_A, 0], [ENV_B, expected.encrypted]] as const) {
        const report = await probeEncryptedStores({ query: db.query, env })
        const store = report.stores.find((s) => s.store === 'system_configs')
        expect({ label, ...expected, undecryptable, status: 'ok' }).toEqual({
          label, encrypted: store?.encrypted, plaintext: store?.plaintext, undecryptable: store?.undecryptable, status: store?.status,
        })
      }
    }
  })

  it('NULL / empty / whitespace-only values are not stored secrets: counted nowhere, not even in `rows`', async () => {
    const db = fakeDatabase({ 'directory_integrations.config.appSecret': ['   ', null, '', '\t\n'] })
    const report = await probeEncryptedStores({ query: db.query, env: ENV_A })
    expect(report.stores[3]).toMatchObject({ rows: 0, encrypted: 0, plaintext: 0, undecryptable: 0 })
  })

  it('rows = encrypted + plaintext + legacyNotChecked in every store field', async () => {
    for (const env of [ENV_A, ENV_B]) {
      const report = await probeEncryptedStores({ query: fakeDatabase(fixture.rows).query, env })
      for (const s of report.stores) {
        expect({ field: `${s.store}.${s.field}`, rows: s.rows }).toEqual({
          field: `${s.store}.${s.field}`, rows: s.encrypted + s.plaintext + (s.legacyNotChecked ?? 0),
        })
      }
    }
  })

  it('the `enc:` prefix is tested on the string each store\'s READER tests: raw where the reader is raw, trimmed where it trims', async () => {
    const sealed = (fixture.rows['data_sources.config.credentials.apiKey'] as string[])[0]
    const padded = ` ${sealed} `
    const db = fakeDatabase({
      // DataSourceManager.decryptCredentials / dingtalk destinations / attendance / credential store:
      // isEncryptedSecretValue(raw) — a leading space makes it plaintext to the reader
      'data_sources.config.credentials.password': [padded],
      'dingtalk_group_destinations.secret': [padded],
      'attendance_integrations.config.appSecret|appsecret|app_secret': [padded],
      'integration_external_systems.credentials_encrypted': [padded, ` ${sealIntegrationV1('MARKER-probe-pad-v1')}`],
      'system_configs.value (is_encrypted)': [padded],
      // directory readers normalizeText() first — the reader decrypts it, so it is encrypted here too
      'directory_integrations.config.appSecret': [padded],
      'directory_integrations.config.approvalCardLinkSecret': [padded],
    })
    const report = await probeEncryptedStores({ query: db.query, env: ENV_A })
    const by = Object.fromEntries(report.stores.map((s) => [`${s.store}.${s.field}`, s]))
    for (const field of [
      'data_sources.config.credentials.password',
      'dingtalk_group_destinations.secret',
      'attendance_integrations.config.appSecret|appsecret|app_secret',
      'system_configs.value (is_encrypted)',
    ]) {
      expect({ field, encrypted: by[field].encrypted, plaintext: by[field].plaintext }).toEqual({ field, encrypted: 0, plaintext: 1 })
    }
    expect(by['integration_external_systems.credentials_encrypted']).toMatchObject({ encrypted: 0, plaintext: 2, legacyNotChecked: 0 })
    for (const field of ['directory_integrations.config.appSecret', 'directory_integrations.config.approvalCardLinkSecret']) {
      expect({ field, encrypted: by[field].encrypted, undecryptable: by[field].undecryptable, plaintext: by[field].plaintext })
        .toEqual({ field, encrypted: 1, undecryptable: 0, plaintext: 0 })
    }
    expect(ENCRYPTED_STORE_CATALOG.filter((e) => e.prefixOn === 'trimmed').map((e) => e.store)).toEqual([
      'directory_integrations', 'directory_integrations', 'directory_integrations',
    ])
  })

  it('the data_sources catalog fields are EXACTLY DataSourceManager\'s SENSITIVE_CREDENTIAL_KEYS (a new key needs a catalog entry)', () => {
    const catalogKeys = ENCRYPTED_STORE_CATALOG
      .filter((e) => e.store === 'data_sources')
      .map((e) => /^config\.credentials\.(\w+)$/.exec(e.field)?.[1] ?? `<unparsed ${e.field}>`)
    expect([...catalogKeys].sort()).toEqual([...SENSITIVE_CREDENTIAL_KEYS].sort())
    // ...and each entry's SQL reads exactly its own key.
    for (const entry of ENCRYPTED_STORE_CATALOG.filter((e) => e.store === 'data_sources')) {
      const key = entry.field.slice('config.credentials.'.length)
      expect(entry.sql.match(/config->'credentials'->>'(\w+)'/g)).toEqual([`config->'credentials'->>'${key}'`, `config->'credentials'->>'${key}'`])
    }
  })

  it('the catalog is frozen to the entry: retargeting a statement or a scheme throws (strict mode) and changes nothing', () => {
    expect(Object.isFrozen(ENCRYPTED_STORE_CATALOG)).toBe(true)
    const before = ENCRYPTED_STORE_CATALOG.map((e) => e.sql)
    for (const entry of ENCRYPTED_STORE_CATALOG) {
      expect(Object.isFrozen(entry)).toBe(true)
      expect(() => { (entry as { sql: string }).sql = 'DELETE FROM system_configs' }).toThrow(TypeError)
      expect(() => { (entry as { scheme: string }).scheme = 'platform-enc' }).toThrow(TypeError)
      expect(() => { (entry as { prefixOn: string }).prefixOn = 'trimmed' }).toThrow(TypeError)
    }
    expect(() => { (ENCRYPTED_STORE_CATALOG as EncryptedStoreCatalogEntry[]).push(ENCRYPTED_STORE_CATALOG[0]) }).toThrow(TypeError)
    expect(ENCRYPTED_STORE_CATALOG.map((e) => e.sql)).toEqual(before)
  })

  it('covers EVERY catalog store field, in order, one bounded statement each', async () => {
    const db = fakeDatabase(fixture.rows)
    const report = await probeEncryptedStores({ query: db.query, env: ENV_A })
    expect(report.stores.map((s) => `${s.store}.${s.field}`)).toEqual(EXPECTED_STORE_FIELDS)
    expect(ENCRYPTED_STORE_CATALOG.map((e) => `${e.store}.${e.field}`)).toEqual(EXPECTED_STORE_FIELDS)
    expect(db.catalogStatements().map((s) => s.sql)).toEqual(ENCRYPTED_STORE_CATALOG.map((e) => e.sql))
    // ...after ONE existence precheck per distinct table, all issued before the first catalog SELECT
    expect(db.prechecks().map((s) => s.params)).toEqual(CATALOG_TABLES.map((t) => [t]))
    expect(db.statements.slice(0, CATALOG_TABLES.length).every((s) => s.sql === ENCRYPTED_STORE_COLUMNS_SQL)).toBe(true)
  })

  it('every statement it issues is ONE SELECT — the per-table precheck and the bounded catalog reads — nothing that writes or locks', async () => {
    const db = fakeDatabase(fixture.rows)
    await probeEncryptedStores({ query: db.query, env: ENV_A })
    const forbidden = /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|LOCK|COPY|CALL|DO|VACUUM|REINDEX|CLUSTER|COMMENT|SET|RESET|BEGIN|COMMIT|NOTIFY|INTO|FOR\s+(NO\s+KEY\s+)?(UPDATE|SHARE)|nextval|setval|pg_advisory\w*)\b/i
    const shapes = [...db.statements.map((s) => s.sql), ...ENCRYPTED_STORE_CATALOG.map((e) => e.sql), ENCRYPTED_STORE_COLUMNS_SQL]
    for (const sql of shapes) {
      expect({ sql, select: /^SELECT\s/.test(sql) }).toEqual({ sql, select: true })
      expect({ sql, forbidden: forbidden.exec(sql)?.[0] ?? null }).toEqual({ sql, forbidden: null })
      expect({ sql, statements: sql.includes(';') }).toEqual({ sql, statements: false })
    }
    // Catalog reads are bounded by LIMIT $1 = rowLimit + 1; the precheck reads one table's columns,
    // through to_regclass (NULL, not an ERROR, for a missing relation).
    for (const s of db.catalogStatements()) {
      expect({ sql: s.sql, bounded: /\sLIMIT \$1$/.test(s.sql), params: s.params }).toEqual({ sql: s.sql, bounded: true, params: [10_001] })
    }
    expect(ENCRYPTED_STORE_COLUMNS_SQL).toBe('SELECT attname FROM pg_attribute WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped')
    expect(db.prechecks().every((s) => s.params?.length === 1 && CATALOG_TABLES.includes(String(s.params[0])))).toBe(true)
  })

  it('every catalog entry lists exactly the top-level columns its SELECT references (what the precheck checks)', () => {
    const KEYWORDS = new Set(['select', 'as', 'from', 'where', 'and', 'is', 'null', 'true', 'limit', 'coalesce'])
    for (const entry of ENCRYPTED_STORE_CATALOG) {
      const tokens = entry.sql.replace(/'[^']*'/g, ' ').replace(/\$\d+/g, ' ').toLowerCase().match(/[a-z_]+/g) ?? []
      const referenced = new Set<string>()
      tokens.forEach((token, i) => {
        if (KEYWORDS.has(token) || token === entry.store || tokens[i - 1] === 'as') return
        referenced.add(token)
      })
      expect({ field: `${entry.store}.${entry.field}`, columns: [...entry.columns].sort() })
        .toEqual({ field: `${entry.store}.${entry.field}`, columns: [...referenced].sort() })
    }
  })

  it('bounded read: past rowLimit it counts the first rowLimit rows and says `truncated`', async () => {
    const rows = fixture.rows['data_sources.config.credentials.password'] as string[]
    const db = fakeDatabase({ 'data_sources.config.credentials.password': rows })
    const report = await probeEncryptedStores({ query: db.query, env: ENV_A, rowLimit: 2 })
    expect(db.catalogStatements()[0].params).toEqual([3])
    expect(report.stores[0]).toMatchObject({ rows: 2, encrypted: 2, plaintext: 0, truncated: true })
    expect(report.stores[1].truncated).toBeUndefined()
  })
})

describe('probeEncryptedStores: an absent table / column is decided by the precheck — no statement that would ERROR', () => {
  /** A database that records every statement it REJECTS (each one is a server-side ERROR in real life). */
  function recordingRejections(db: ReturnType<typeof fakeDatabase>) {
    const rejected: string[] = []
    const query = async (sql: string, params?: unknown[]) => {
      try {
        return await db.query(sql, params)
      } catch (error) {
        rejected.push(sql)
        throw error
      }
    }
    return { query, rejected }
  }

  it('missing table: table_missing for all its fields, NO catalog SELECT issued for it, nothing rejected', async () => {
    const db = fakeDatabase(fixture.rows, fixtureSchema({ directory_integrations: null, system_configs: null }))
    const spy = recordingRejections(db)
    const report = await probeEncryptedStores({ query: spy.query, env: ENV_A })
    const missing = report.stores.filter((s) => s.status === 'table_missing').map((s) => `${s.store}.${s.field}`)
    expect(missing).toEqual([
      'directory_integrations.config.appSecret',
      'directory_integrations.config.workNotificationAgentId|agentId',
      'directory_integrations.config.approvalCardLinkSecret',
      'system_configs.value (is_encrypted)',
    ])
    for (const s of report.stores.filter((r) => r.status === 'table_missing')) {
      expect(s).toMatchObject({ rows: 0, encrypted: 0, undecryptable: 0, plaintext: 0 })
      expect(s.sqlState).toBeUndefined() // nothing was raised
    }
    const issued = db.catalogStatements().map((s) => s.sql)
    for (const entry of ENCRYPTED_STORE_CATALOG.filter((e) => e.store === 'directory_integrations' || e.store === 'system_configs')) {
      expect(issued).not.toContain(entry.sql)
    }
    expect(issued).toHaveLength(EXPECTED_STORE_FIELDS.length - 4)
    expect(spy.rejected).toEqual([])
    expect(report.totals).toMatchObject({ missing: 4, unreadable: 0 })
  })

  it('missing column: column_missing for the entry that needs it, its SELECT never issued; a sibling field of the same table is still read', async () => {
    const db = fakeDatabase(fixture.rows, fixtureSchema({ dingtalk_group_destinations: ['id', 'webhook_url'] }))
    const spy = recordingRejections(db)
    const report = await probeEncryptedStores({ query: spy.query, env: ENV_A })
    const secret = report.stores.find((s) => s.store === 'dingtalk_group_destinations' && s.field === 'secret')
    const webhook = report.stores.find((s) => s.store === 'dingtalk_group_destinations' && s.field === 'webhook_url')
    expect(secret).toMatchObject({ status: 'column_missing', rows: 0 })
    expect(secret?.sqlState).toBeUndefined()
    expect(webhook).toMatchObject({ status: 'ok', rows: 1, encrypted: 1 })
    const issued = db.catalogStatements().map((s) => s.sql)
    expect(issued).not.toContain(ENCRYPTED_STORE_CATALOG.find((e) => e.field === 'secret')?.sql)
    expect(issued).toContain(ENCRYPTED_STORE_CATALOG.find((e) => e.field === 'webhook_url')?.sql)
    // data_sources needs is_active / deleted_at too, not only config
    const noDeletedAt = fakeDatabase(fixture.rows, fixtureSchema({ data_sources: ['id', 'config', 'is_active'] }))
    const r2 = await probeEncryptedStores({ query: noDeletedAt.query, env: ENV_A })
    expect(r2.stores.slice(0, 3).map((s) => s.status)).toEqual(['column_missing', 'column_missing', 'column_missing'])
    expect(noDeletedAt.catalogStatements().some((s) => s.sql.includes('FROM data_sources'))).toBe(false)
    expect(spy.rejected).toEqual([])
  })

  it('present table and columns: the SELECT is issued and read', async () => {
    const db = fakeDatabase(fixture.rows)
    const spy = recordingRejections(db)
    const report = await probeEncryptedStores({ query: spy.query, env: ENV_A })
    expect(db.catalogStatements().map((s) => s.sql)).toEqual(ENCRYPTED_STORE_CATALOG.map((e) => e.sql))
    expect(report.stores.every((s) => s.status === 'ok')).toBe(true)
    expect(spy.rejected).toEqual([])
  })

  it('a failing precheck makes that table read_failed (its SQLSTATE, no text) without issuing its SELECTs; other tables are still probed', async () => {
    const db = fakeDatabase(fixture.rows)
    const query = async (sql: string, params?: unknown[]) => {
      if (sql === ENCRYPTED_STORE_COLUMNS_SQL && params?.[0] === 'integration_external_systems') {
        throw Object.assign(new Error('MARKER-permission-text'), { code: '42501' })
      }
      return db.query(sql, params)
    }
    const report = await probeEncryptedStores({ query, env: ENV_A })
    expect(report.stores[8]).toMatchObject({ store: 'integration_external_systems', status: 'read_failed', sqlState: '42501', rows: 0 })
    expect(db.catalogStatements().map((s) => s.sql)).not.toContain(ENCRYPTED_STORE_CATALOG[8].sql)
    expect(table(report).filter((_, i) => i !== 8)).toEqual(EXPECTED_UNDER_A.filter((_, i) => i !== 8))
    expect(JSON.stringify(report)).not.toContain('MARKER')
  })
})

describe('probeEncryptedStoresShared: concurrent on-demand callers share ONE run; nothing is cached', () => {
  it('two concurrent calls run the probe once and get the same report; a later call runs again', async () => {
    const db = fakeDatabase(fixture.rows)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const query = async (sql: string, params?: unknown[]) => {
      await gate
      return db.query(sql, params)
    }
    const makeDeps = vi.fn(() => ({ query, env: ENV_A }))
    const first = probeEncryptedStoresShared(makeDeps)
    const second = probeEncryptedStoresShared(makeDeps)
    expect(second).toBe(first)
    expect(makeDeps).toHaveBeenCalledTimes(1)
    release()
    const [a, b] = await Promise.all([first, second])
    expect(b).toBe(a)
    const oneRun = db.statements.length
    expect(oneRun).toBe(CATALOG_TABLES.length + EXPECTED_STORE_FIELDS.length)

    const later = await probeEncryptedStoresShared(makeDeps)
    expect(makeDeps).toHaveBeenCalledTimes(2)
    expect(later).not.toBe(a)
    expect(db.statements.length).toBe(2 * oneRun)
  })

  it('a makeDeps that throws shares nothing: the throw reaches the caller and the next call starts a run', async () => {
    expect(() => probeEncryptedStoresShared(() => { throw new Error('no pool') })).toThrow('no pool')
    const db = fakeDatabase(fixture.rows)
    const report = await probeEncryptedStoresShared(() => ({ query: db.query, env: ENV_A }))
    expect(report.stores).toHaveLength(EXPECTED_STORE_FIELDS.length)
  })
})

describe('probeEncryptedStores: unreadable stores are classified by SQLSTATE, and never stop the probe', () => {
  it('race fallback: a catalog SELECT that still fails with 42P01 / 42703 after the precheck is table_missing / column_missing, whatever the (localized) message says', async () => {
    const db = fakeDatabase({
      ...fixture.rows,
      'dingtalk_group_destinations.webhook_url': sqlError('42P01', 'MARKER-localized-message-a'),
      'dingtalk_group_destinations.secret': sqlError('42703', 'MARKER-localized-message-b'),
    })
    const report = await probeEncryptedStores({ query: db.query, env: ENV_A })
    expect(report.stores[6]).toEqual({
      store: 'dingtalk_group_destinations', field: 'webhook_url', scheme: 'platform-enc',
      status: 'table_missing', rows: 0, encrypted: 0, undecryptable: 0, plaintext: 0, sqlState: '42P01',
    })
    expect(report.stores[7]).toMatchObject({ status: 'column_missing', sqlState: '42703', rows: 0 })
    expect(report.totals).toMatchObject({ missing: 2, unreadable: 0 })
    expect(JSON.stringify(report)).not.toContain('MARKER-localized-message')
  })

  it('message text is never the classifier: "does not exist" without the SQLSTATE is read_failed, and a SQLSTATE beats the message', async () => {
    const db = fakeDatabase({
      'data_sources.config.credentials.password': sqlError(undefined, 'relation "data_sources" does not exist'),
      'data_sources.config.credentials.apiKey': sqlError('28P01', 'column "config" does not exist'),
    })
    const report = await probeEncryptedStores({ query: db.query, env: ENV_A })
    expect(report.stores[0]).toMatchObject({ status: 'read_failed' })
    expect(report.stores[0].sqlState).toBeUndefined()
    expect(report.stores[1]).toMatchObject({ status: 'read_failed', sqlState: '28P01' })
  })

  it('sqlState is reported only for the exact SQLSTATE shape /^[0-9A-Z]{5}$/', async () => {
    const cases: Array<[unknown, string | undefined]> = [
      ['42P01', '42P01'], ['28P01', '28P01'], ['XX000', 'XX000'],
      ['42p01', undefined], ['42P011', undefined], ['4P01', undefined], ['ECONNRESET', undefined], [42701, undefined], [undefined, undefined],
    ]
    for (const [code, expected] of cases) {
      const error = Object.assign(new Error('relation does not exist'), code === undefined ? {} : { code })
      const report = await probeEncryptedStores({ query: fakeDatabase({ 'data_sources.config.credentials.token': error }).query, env: ENV_A })
      const store = report.stores[2]
      expect({ code, sqlState: store.sqlState }).toEqual({ code, sqlState: expected })
      // Only the exact 42P01 is table_missing — a lowercase look-alike is just unreadable.
      expect({ code, status: store.status }).toEqual({ code, status: expected === '42P01' ? 'table_missing' : 'read_failed' })
    }
  })

  it('a query that throws a non-SQLSTATE error fails THAT store only; every other store is still probed', async () => {
    const db = fakeDatabase({
      ...fixture.rows,
      'directory_integrations.config.appSecret': Object.assign(new Error('MARKER-socket-text'), { code: 'ECONNRESET' }),
    })
    const report = await probeEncryptedStores({ query: db.query, env: ENV_A })
    expect(report.stores[3]).toMatchObject({ store: 'directory_integrations', status: 'read_failed', rows: 0, encrypted: 0 })
    expect(report.stores[3].sqlState).toBeUndefined()
    expect(table(report).filter((_, i) => i !== 3)).toEqual(EXPECTED_UNDER_A.filter((_, i) => i !== 3))
    expect(db.catalogStatements()).toHaveLength(EXPECTED_STORE_FIELDS.length)
    expect(report.totals.unreadable).toBe(1)
    expect(JSON.stringify(report)).not.toContain('MARKER-socket-text')
  })

  it('never throws: a query returning garbage, a throwing clock, a non-object row', async () => {
    const schema = fakeDatabase({})
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql === ENCRYPTED_STORE_COLUMNS_SQL) return schema.query(sql, params)
      if (sql.includes('data_sources')) return undefined as never
      if (sql.includes('directory_integrations')) return { rows: 'not-an-array' } as never
      return { rows: [7, null, 'x'] }
    })
    const report = await probeEncryptedStores({ query, env: ENV_A, now: () => { throw new Error('clock') } })
    expect(report.stores.filter((s) => s.status === 'read_failed').map((s) => s.store)).toEqual([
      'data_sources', 'data_sources', 'data_sources', 'directory_integrations', 'directory_integrations', 'directory_integrations',
    ])
    expect(report.stores.filter((s) => s.status === 'ok')).toHaveLength(5)
    expect(typeof report.checkedAt).toBe('string')

    // ...and garbage from the precheck itself: no rows array -> read_failed; rows without a column
    // name -> the required columns are not there -> column_missing.
    const garbagePrecheck = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql !== ENCRYPTED_STORE_COLUMNS_SQL) return { rows: [] }
      return params?.[0] === 'data_sources' ? (undefined as never) : { rows: [7, null, { attname: 42 }] }
    })
    const r2 = await probeEncryptedStores({ query: garbagePrecheck, env: ENV_A })
    expect(r2.stores.map((s) => s.status)).toEqual([
      'read_failed', 'read_failed', 'read_failed',
      ...Array(EXPECTED_STORE_FIELDS.length - 3).fill('column_missing'),
    ])
  })
})

describe('probeEncryptedStores: material and key derivation', () => {
  it('production with unusable material: material unavailable, ZERO key derivations and ZERO decrypt attempts; values still counted', async () => {
    for (const env of [
      { NODE_ENV: 'production' },
      { NODE_ENV: 'production', ENCRYPTION_KEY: 'default-key-change-in-production', ENCRYPTION_SALT: 'default-salt-change-in-production' },
    ]) {
      const pbkdf2 = vi.spyOn(crypto, 'pbkdf2')
      const pbkdf2Sync = vi.spyOn(crypto, 'pbkdf2Sync')
      const decipher = vi.spyOn(crypto, 'createDecipheriv')
      const db = fakeDatabase(fixture.rows)
      const report = await probeEncryptedStores({ query: db.query, env })
      expect(report.material.status).toBe('unavailable')
      expect(report.material.issues.length).toBe(2)
      expect(report.material.issues.join(' ')).toMatch(/ENCRYPTION_KEY/)
      expect(report.decryptChecked).toBe(false)
      expect(pbkdf2).not.toHaveBeenCalled()
      expect(pbkdf2Sync).not.toHaveBeenCalled()
      expect(decipher).not.toHaveBeenCalled()
      expect(report.totals).toMatchObject({ encrypted: 12, undecryptable: 0, plaintext: 7 })
      vi.restoreAllMocks()
    }
  })

  it('non-production defaults stay usable and are named in `issues` (values-free)', async () => {
    const db = fakeDatabase({})
    const report = await probeEncryptedStores({ query: db.query, env: { NODE_ENV: 'development' } })
    expect(report.material.status).toBe('ok')
    expect(report.material.issues).toEqual(['ENCRYPTION_KEY not configured / not set', 'ENCRYPTION_SALT not configured / not set'])
  })

  it('derives the key ONCE per run (async pbkdf2, never pbkdf2Sync), then one decipher per encrypted value', async () => {
    const pbkdf2 = vi.spyOn(crypto, 'pbkdf2')
    const pbkdf2Sync = vi.spyOn(crypto, 'pbkdf2Sync')
    const decipher = vi.spyOn(crypto, 'createDecipheriv')
    const db = fakeDatabase(fixture.rows)
    const report = await probeEncryptedStores({ query: db.query, env: ENV_B })
    expect(pbkdf2).toHaveBeenCalledTimes(1)
    expect(pbkdf2Sync).not.toHaveBeenCalled()
    expect(decipher).toHaveBeenCalledTimes(report.totals.encrypted)
    expect(report.totals.encrypted).toBe(12)
  })

  it('the async derivation yields the byte-identical key the writers derive synchronously', async () => {
    const pbkdf2Sync = vi.spyOn(crypto, 'pbkdf2Sync')
    const sealed = await sealPlatform(MATERIAL_A, M('identity'))
    fixture.sealed.push(sealed)
    fixture.plaintexts.push(M('identity'))
    const writerKey = pbkdf2Sync.mock.results[0].value as Buffer
    vi.restoreAllMocks()
    const original = crypto.pbkdf2
    let probeKey: Buffer | undefined
    vi.spyOn(crypto, 'pbkdf2').mockImplementation(((...args: unknown[]) => {
      const callback = args[5] as (error: Error | null, key: Buffer) => void
      return (original as (...a: unknown[]) => void)(...args.slice(0, 5), (error: Error | null, key: Buffer) => {
        probeKey = key
        callback(error, key)
      })
    }) as never)
    const report = await probeEncryptedStores({ query: fakeDatabase({ 'data_sources.config.credentials.apiKey': [sealed] }).query, env: ENV_A })
    expect(report.stores[1]).toMatchObject({ encrypted: 1, undecryptable: 0 })
    expect(probeKey?.equals(writerKey)).toBe(true)
  })
})

describe('values-free: nothing secret leaves the probe', () => {
  function forbiddenFragments(): string[] {
    const derive = (m: Material) => crypto.pbkdf2Sync(m.key, Buffer.from(m.salt), 100_000, 32, 'sha256')
    const keys = [derive(MATERIAL_A), derive(MATERIAL_B)]
    return [
      'MARKER',
      ...fixture.plaintexts,
      ...fixture.sealed,
      // any recognisable slice of a ciphertext payload
      ...fixture.sealed.map((s) => s.replace(/^(enc:|v1:)/, '').slice(0, 16)),
      MATERIAL_A.key, MATERIAL_A.salt, MATERIAL_B.key, MATERIAL_B.salt,
      ...keys.flatMap((k) => [k.toString('hex'), k.toString('base64'), k.toString('hex').slice(0, 16)]),
    ]
  }

  it('the serialized report (under A and under B) carries no plaintext, ciphertext, material or derived key', async () => {
    const fragments = forbiddenFragments()
    for (const env of [ENV_A, ENV_B]) {
      const report = await probeEncryptedStores({ query: fakeDatabase(fixture.rows).query, env })
      const serialized = JSON.stringify(report)
      for (const fragment of fragments) expect({ fragment, leaked: serialized.includes(fragment) }).toEqual({ fragment, leaked: false })
    }
  })

  it('the startup log lines (summary + per-store warnings) carry none of them either', async () => {
    const lines: string[] = []
    const logger = {
      info: vi.fn((message: string, meta?: unknown) => { lines.push(message, JSON.stringify(meta ?? null)) }),
      warn: vi.fn((message: string, meta?: unknown) => { lines.push(message, JSON.stringify(meta ?? null)) }),
    }
    await runEncryptedStoreProbeAtStartup({ resolvePool: () => fakeDatabase(fixture.rows), env: ENV_B, logger })
    expect(logger.warn).toHaveBeenCalled()
    const serialized = lines.join('\n')
    for (const fragment of forbiddenFragments()) expect({ fragment, leaked: serialized.includes(fragment) }).toEqual({ fragment, leaked: false })
  })
})

describe('runEncryptedStoreProbeAtStartup: one summary, one warning per broken store field, never throws', () => {
  const captureLogger = () => ({ info: vi.fn(), warn: vi.fn() })

  it('key changed: one info summary + one warn per store field with undecryptable values, each with the fixed re-enter hint', async () => {
    const logger = captureLogger()
    const report = await runEncryptedStoreProbeAtStartup({ resolvePool: () => fakeDatabase(fixture.rows), env: ENV_B, logger })
    expect(report?.totals.undecryptable).toBe(12)
    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(logger.info.mock.calls[0][0]).toMatch(/^Encrypted store probe: 12 encrypted value\(s\) across 11 store field\(s\); 12 undecryptable/)
    const broken = EXPECTED_UNDER_A.filter((row) => (row[3] as number) > 0).map((row) => row[0])
    expect(logger.warn).toHaveBeenCalledTimes(broken.length)
    expect(logger.warn.mock.calls.map((call) => `${call[1].store}.${call[1].field}`)).toEqual(broken)
    for (const [message, meta] of logger.warn.mock.calls) {
      expect(message).toContain(ENCRYPTED_STORE_REENTER_HINT)
      expect(meta).toEqual({ store: expect.any(String), field: expect.any(String), encrypted: expect.any(Number), undecryptable: expect.any(Number) })
      expect(meta.undecryptable).toBeGreaterThan(0)
    }
  })

  it('material intact: the info summary only, no warning', async () => {
    const logger = captureLogger()
    await runEncryptedStoreProbeAtStartup({ resolvePool: () => fakeDatabase(fixture.rows), env: ENV_A, logger })
    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('material unavailable: the summary says nothing was trial-decrypted and one warning names the issues', async () => {
    const logger = captureLogger()
    await runEncryptedStoreProbeAtStartup({ resolvePool: () => fakeDatabase(fixture.rows), env: { NODE_ENV: 'production' }, logger })
    expect(logger.info.mock.calls[0][0]).toContain('not trial-decrypted (encryption material unavailable)')
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0][1]).toEqual({ issues: ['ENCRYPTION_KEY not configured / not set', 'ENCRYPTION_SALT not configured / not set'] })
  })

  it('no database pool: skipped quietly (no query, no log line)', async () => {
    for (const resolvePool of [() => null, () => undefined, () => ({}) as never]) {
      const logger = captureLogger()
      await expect(runEncryptedStoreProbeAtStartup({ resolvePool, env: ENV_A, logger })).resolves.toBeNull()
      expect(logger.info).not.toHaveBeenCalled()
      expect(logger.warn).not.toHaveBeenCalled()
    }
  })

  it('swallows every error: a throwing pool resolver, a throwing logger, a throwing fallback warn', async () => {
    const throwingResolver = captureLogger()
    await expect(runEncryptedStoreProbeAtStartup({
      resolvePool: () => { throw new Error('MARKER-pool-unavailable') },
      env: ENV_A,
      logger: throwingResolver,
    })).resolves.toBeNull()
    expect(throwingResolver.warn).toHaveBeenCalledWith('Encrypted store probe could not run; startup continues without it.')

    const throwingInfo = { info: vi.fn(() => { throw new Error('log sink down') }), warn: vi.fn() }
    await expect(runEncryptedStoreProbeAtStartup({ resolvePool: () => fakeDatabase(fixture.rows), env: ENV_A, logger: throwingInfo })).resolves.toBeNull()
    expect(throwingInfo.warn).toHaveBeenCalledTimes(1)

    const throwingEverything = { info: vi.fn(() => { throw new Error('a') }), warn: vi.fn(() => { throw new Error('b') }) }
    await expect(runEncryptedStoreProbeAtStartup({ resolvePool: () => fakeDatabase(fixture.rows), env: ENV_B, logger: throwingEverything })).resolves.toBeNull()
  })

  it('every query failing (database down) still resolves: one summary, and ONE values-free warn naming the unreadable store fields', async () => {
    const logger = captureLogger()
    const pool = { query: vi.fn(async () => { throw Object.assign(new Error('MARKER-down 203.0.113.9:5432'), { code: 'ECONNREFUSED' }) }) }
    const report = await runEncryptedStoreProbeAtStartup({ resolvePool: () => pool, env: ENV_A, logger })
    expect(report?.totals.unreadable).toBe(11)
    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(logger.info.mock.calls[0][0]).toContain('11 store field(s) unreadable')
    expect(logger.warn).toHaveBeenCalledTimes(1)
    const [message, meta] = logger.warn.mock.calls[0]
    expect(message).toBe(`Encrypted store probe: 11 store field(s) could not be read, so their values were not checked: ${EXPECTED_STORE_FIELDS.join(', ')}.`)
    expect(meta).toEqual({
      unreadable: 11,
      stores: ENCRYPTED_STORE_CATALOG.map((e) => ({ store: e.store, field: e.field, sqlState: null })),
    })
    const serialized = JSON.stringify(logger.warn.mock.calls) + JSON.stringify(logger.info.mock.calls)
    for (const fragment of ['MARKER', '203.0.113.9', '5432', 'ECONNREFUSED']) expect(serialized).not.toContain(fragment)
  })

  it('a missing table / column is not a warning; one unreadable store field is, next to the per-store undecryptable warns', async () => {
    const logger = captureLogger()
    const db = fakeDatabase({
      ...fixture.rows,
      'system_configs.value (is_encrypted)': sqlError('42P01', 'relation missing'),
      'dingtalk_group_destinations.secret': sqlError('42501', 'MARKER-permission-text'),
    })
    await runEncryptedStoreProbeAtStartup({ resolvePool: () => db, env: ENV_B, logger })
    const unreadableWarns = logger.warn.mock.calls.filter(([message]) => String(message).includes('could not be read'))
    expect(unreadableWarns).toEqual([[
      'Encrypted store probe: 1 store field(s) could not be read, so their values were not checked: dingtalk_group_destinations.secret.',
      { unreadable: 1, stores: [{ store: 'dingtalk_group_destinations', field: 'secret', sqlState: '42501' }] },
    ]])
    const undecryptableWarns = logger.warn.mock.calls.filter(([message]) => String(message).includes(ENCRYPTED_STORE_REENTER_HINT))
    expect(undecryptableWarns).toHaveLength(8) // 10 broken fields minus dingtalk secret (unreadable) and system_configs (missing)
    expect(logger.warn).toHaveBeenCalledTimes(9)
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('MARKER')
  })
})

describe('startup wiring in src/index.ts', () => {
  it('ONE call site, fire-and-forget: `void import(...)` with a .catch — never awaited, so it cannot block or fail startup', () => {
    const indexSource = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/index.ts'),
      'utf8',
    )
    expect(indexSource.split('encrypted-store-probe')).toHaveLength(2)
    const statement = /(\S+)\s+import\('\.\/security\/encrypted-store-probe'\)([\s\S]*?)\r?\n\r?\n/.exec(indexSource)
    expect(statement?.[1]).toBe('void')
    expect(statement?.[2]).toContain('runEncryptedStoreProbeAtStartup({ resolvePool: () => poolManager.get() })')
    expect(statement?.[2]).toMatch(/\.catch\(/)
    expect(indexSource).not.toMatch(/await\s+import\('\.\/security\/encrypted-store-probe'\)/)
  })

  /**
   * The index.ts statement itself, executed: its text is cut out of src/index.ts, the dynamic import is
   * replaced by an injected loader, and it runs with `this.logger` / `poolManager` doubles. Whatever
   * fails — the module load, the hook, AND the logger inside the .catch — the promise it leaves behind
   * must resolve, never reject (a rejection there is an unhandled rejection in the server process).
   */
  function runIndexStatement(load: () => Promise<unknown>, warn: (message: string) => void, pool: unknown): Promise<unknown> {
    const indexSource = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/index.ts'), 'utf8')
    const statement = /void\s+import\('\.\/security\/encrypted-store-probe'\)([\s\S]*?)\r?\n\r?\n/.exec(indexSource)
    expect(statement).not.toBeNull()
    const js = ts.transpile(`const __statement = __load()${statement![1]}`, { target: ts.ScriptTarget.ES2020 })
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const run = new Function('__load', 'poolManager', `${js}\nreturn __statement`) as (this: unknown, ...args: unknown[]) => Promise<unknown>
    return run.call({ logger: { warn } }, load, { get: () => pool })
  }

  it('the statement never rejects: module load failing, hook throwing, and the logger throwing inside the .catch', async () => {
    const throwingWarn = vi.fn(() => { throw new Error('log sink down') })
    await expect(runIndexStatement(() => Promise.reject(new Error('module load failed')), throwingWarn, null)).resolves.toBeUndefined()
    expect(throwingWarn).toHaveBeenCalledTimes(1)
    const hookThrows = async () => ({ runEncryptedStoreProbeAtStartup: () => { throw new Error('hook threw') } })
    await expect(runIndexStatement(hookThrows, throwingWarn, null)).resolves.toBeUndefined()
    expect(throwingWarn).toHaveBeenCalledTimes(2)
  })

  it('the statement wires the real hook to poolManager.get()', async () => {
    const warn = vi.fn()
    const db = fakeDatabase(fixture.rows)
    const real = () => import('../../src/security/encrypted-store-probe')
    const env = { ...process.env }
    try {
      Object.assign(process.env, ENV_A)
      const report = (await runIndexStatement(real, warn, db)) as EncryptedStoreProbeReport
      expect(report.stores).toHaveLength(EXPECTED_STORE_FIELDS.length)
      expect(db.catalogStatements()).toHaveLength(EXPECTED_STORE_FIELDS.length)
    } finally {
      for (const key of ['NODE_ENV', 'ENCRYPTION_KEY', 'ENCRYPTION_SALT']) {
        if (env[key] === undefined) delete process.env[key]
        else process.env[key] = env[key]
      }
    }
    expect(warn).not.toHaveBeenCalled()
  })
})
