import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DataSourceManager } from '../../src/data-adapters/DataSourceManager'
import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'
import {
  OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID,
  OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID_STATUS,
  OUTBOUND_SQL_WRITE_DISABLED,
  OUTBOUND_SQL_WRITE_ERROR_CODES,
  OUTBOUND_SQL_WRITE_OPERATIONS,
  OUTBOUND_SQL_WRITE_OPERATION_STATEMENT,
  OUTBOUND_SQL_WRITE_REFUSAL_STATUS,
  OUTBOUND_SQL_WRITE_TARGETS_ENV,
  OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED,
  OutboundSqlWriteGateError,
  assertOutboundSqlWriteAuthorized,
  evaluateOutboundSqlWrite,
  isPureReadStatement,
  isSqlWriteStatement,
  loadOutboundSqlWriteAllowlist,
} from '../../src/data-adapters/outbound-sql-write-gate'

/**
 * W-1(c) DEFAULT-DENY GATE FOR GENERIC OUTBOUND SQL WRITE.
 *
 * WHAT WAS OPEN BEFORE THIS GATE. On a `readOnly:false` generic SQL source the route's SELECT-only
 * classifier is SKIPPED (routes/data-sources.ts), so an arbitrary INSERT/UPDATE/DELETE/MERGE/EXEC fell
 * straight through to `DataSourceManager.query`. The previous mitigation tried to SNIFF THE
 * DESTINATION — parse the statement for K3 table names, probe the catalog — and four rounds of
 * adversarial verification defeated it with ordinary T-SQL. That is the option the owner rejected on
 * 2026-08-29; the ruling was to gate the CAPABILITY, exactly as the generic HTTP lane was closed.
 *
 * WHAT THIS SUITE PROVES:
 *   PART 1  THE LEAF. Load semantics, the closed key sets, identity-not-destination matching, the
 *           wildcard refusal, the operation vocabulary, values-free refusals, and the DEFAULT (env
 *           unset => every write refused, reads untouched).
 *   PART 2  THE WRITE/READ SPLIT, which is the ONLY classification the gate performs — and which must
 *           be fail-closed on every shape that defeated the destination sniffer.
 *   PART 3  THE ENFORCEMENT POINTS. Real DataSourceManager + real MSSQLAdapter: an unarmed write is
 *           refused before the driver; an ARMED target writes; every read passes either way.
 *
 * NOT A DUPLICATE OF THE K3 FENCES. Those are a permanent BAN with no runtime switch. This is a GATE
 * a deployment opens for named sources. Collapsing them would be the first step toward turning the
 * ban into a gate or the gate into a ban.
 */

const ENV_KEY = OUTBOUND_SQL_WRITE_TARGETS_ENV
const savedEnv = process.env[ENV_KEY]
const tempFiles: string[] = []

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = savedEnv
  vi.restoreAllMocks()
  for (const file of tempFiles.splice(0)) {
    try { fs.unlinkSync(file) } catch { /* best effort */ }
  }
})

function writeAllowlistFile(contents: unknown): string {
  const file = path.join(os.tmpdir(), `sql-write-allowlist-${Math.random().toString(36).slice(2)}.json`)
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8')
  tempFiles.push(file)
  return file
}

function armFor(systemId: string, extra: Record<string, unknown> = {}): void {
  process.env[ENV_KEY] = writeAllowlistFile({
    allowlistId: 'test-allowlist',
    allowlistVersion: 1,
    targets: [{ entryId: 'e1', systemId, allObjects: true, ...extra }],
  })
}

const buildError = (status: number, code: string, message: string, details: Record<string, unknown>) =>
  Object.assign(new Error(message), { status, code, details })

function refusalOf(fn: () => unknown): { code?: string; status?: number; message?: string; details?: Record<string, unknown> } {
  try {
    fn()
  } catch (error) {
    return error as { code?: string; status?: number; message?: string; details?: Record<string, unknown> }
  }
  throw new Error('expected a refusal, but nothing was thrown')
}

// ─────────────────── PART 1 — THE LEAF ───────────────────

describe('outbound SQL write gate — the default is DENY', () => {
  it('env unset: every write is refused with the fixed code, before any file I/O', () => {
    delete process.env[ENV_KEY]
    const readSpy = vi.spyOn(fs, 'readFileSync')
    const decision = evaluateOutboundSqlWrite({ systemId: 's1', operation: OUTBOUND_SQL_WRITE_OPERATION_STATEMENT })
    expect(decision.authorized).toBe(false)
    expect(decision.code).toBe(OUTBOUND_SQL_WRITE_DISABLED)
    expect(decision.status).toBe(OUTBOUND_SQL_WRITE_REFUSAL_STATUS)
    expect(decision.reason).toBe('capability_not_authorized')
    expect(readSpy).not.toHaveBeenCalled() // the default path opens nothing
  })

  it('env blank is the same as unset', () => {
    process.env[ENV_KEY] = '   '
    expect(loadOutboundSqlWriteAllowlist()).toBeNull()
    expect(evaluateOutboundSqlWrite({ systemId: 's1', operation: 'statement' }).code).toBe(OUTBOUND_SQL_WRITE_DISABLED)
  })

  it('the refusal codes are a frozen, distinct vocabulary', () => {
    expect([...OUTBOUND_SQL_WRITE_ERROR_CODES]).toEqual([
      'OUTBOUND_SQL_WRITE_DISABLED',
      'OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED',
      'OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID',
    ])
    // "gate shut" and "gate open, target not listed" must stay DISTINCT — different remedies.
    expect(OUTBOUND_SQL_WRITE_DISABLED).not.toBe(OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED)
    expect(OUTBOUND_SQL_WRITE_REFUSAL_STATUS).toBe(403)
    expect(OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID_STATUS).toBe(500)
    expect([...OUTBOUND_SQL_WRITE_OPERATIONS]).toEqual(['statement'])
    expect(() => { (OUTBOUND_SQL_WRITE_OPERATIONS as unknown as string[]).push('x') }).toThrow(TypeError)
  })

  it('an unknown operation default-refuses (a new write path must be inventoried)', () => {
    armFor('s1')
    const decision = evaluateOutboundSqlWrite({ systemId: 's1', operation: 'exfiltrate' })
    expect(decision.authorized).toBe(false)
    expect(decision.code).toBe(OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED)
    expect(decision.reason).toBe('unknown_write_operation')
  })
})

describe('outbound SQL write gate — arming', () => {
  it('an armed source is authorized; an unlisted source gets the DISTINCT not-authorized code', () => {
    armFor('armed-source')
    const ok = evaluateOutboundSqlWrite({ systemId: 'armed-source', operation: 'statement' })
    expect(ok.authorized).toBe(true)
    expect(ok.entryId).toBe('e1')
    expect(ok.code).toBeNull()

    const denied = evaluateOutboundSqlWrite({ systemId: 'other-source', operation: 'statement' })
    expect(denied.authorized).toBe(false)
    expect(denied.code).toBe(OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED)
    expect(denied.reason).toBe('target_not_listed')
    expect(denied.allowlistTargetCount).toBe(1) // a COUNT, never the names
  })

  it('corroborating identities only NARROW a match, never widen one', () => {
    armFor('s1', { systemName: 'Staging', kind: 'sqlserver' })
    expect(evaluateOutboundSqlWrite({ systemId: 's1', systemName: 'Staging', kind: 'sqlserver', operation: 'statement' }).authorized).toBe(true)
    // Present-but-disagreeing corroboration refuses.
    expect(evaluateOutboundSqlWrite({ systemId: 's1', systemName: 'Other', kind: 'sqlserver', operation: 'statement' }).authorized).toBe(false)
    expect(evaluateOutboundSqlWrite({ systemId: 's1', systemName: 'Staging', kind: 'postgres', operation: 'statement' }).authorized).toBe(false)
  })

  it('fails closed on an under-specified subject', () => {
    armFor('s1')
    const d = evaluateOutboundSqlWrite({ systemId: null, operation: 'statement' })
    expect(d.authorized).toBe(false)
    expect(d.reason).toBe('missing_system_identity')
  })

  it('an ARMED but EMPTY allowlist authorizes nothing (a legal, visible state)', () => {
    process.env[ENV_KEY] = writeAllowlistFile({ allowlistId: 'empty', allowlistVersion: 1, targets: [] })
    const d = evaluateOutboundSqlWrite({ systemId: 's1', operation: 'statement' })
    expect(d.authorized).toBe(false)
    expect(d.code).toBe(OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED)
  })
})

describe('outbound SQL write gate — the allowlist file is validated, and a fault DENIES', () => {
  it('unreadable / malformed / not-an-object all throw INVALID and never echo the path', () => {
    process.env[ENV_KEY] = path.join(os.tmpdir(), 'definitely-not-here-9f2b.json')
    const unreadable = refusalOf(() => loadOutboundSqlWriteAllowlist())
    expect(unreadable.code).toBe(OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID)
    expect(unreadable.message).toContain(ENV_KEY)
    expect(unreadable.message).not.toContain('definitely-not-here-9f2b') // the path is topology

    process.env[ENV_KEY] = writeAllowlistFile('{ not json')
    expect(refusalOf(() => loadOutboundSqlWriteAllowlist()).code).toBe(OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID)

    process.env[ENV_KEY] = writeAllowlistFile([1, 2, 3])
    expect(refusalOf(() => loadOutboundSqlWriteAllowlist()).code).toBe(OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID)
  })

  it('a load fault DEGRADES A PREVIEW into an honest refusal rather than throwing', () => {
    process.env[ENV_KEY] = writeAllowlistFile('{ not json')
    const d = evaluateOutboundSqlWrite({ systemId: 's1', operation: 'statement' })
    expect(d.authorized).toBe(false)
    expect(d.code).toBe(OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID)
    expect(d.status).toBe(OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID_STATUS)
  })

  it('DESTINATION keys are refused AT LOAD, by name, stating the rule', () => {
    for (const key of ['host', 'server', 'database', 'connectionString', 'dsn', 'port', 'linkedServer', 'password']) {
      process.env[ENV_KEY] = writeAllowlistFile({
        allowlistId: 'a', allowlistVersion: 1,
        targets: [{ entryId: 'e1', systemId: 's1', allObjects: true, [key]: 'anything' }],
      })
      const err = refusalOf(() => loadOutboundSqlWriteAllowlist())
      expect(err.code).toBe(OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID)
      expect(err.details?.reason).toBe('identity_matching_only')
    }
  })

  it('an objects enumeration is refused with its own message (no object scope on this lane)', () => {
    process.env[ENV_KEY] = writeAllowlistFile({
      allowlistId: 'a', allowlistVersion: 1,
      targets: [{ entryId: 'e1', systemId: 's1', objects: ['t'] }],
    })
    expect(refusalOf(() => loadOutboundSqlWriteAllowlist()).details?.reason).toBe('object_scope_not_supported')
  })

  it('allObjects must be stated explicitly; wildcards and duplicates are refused', () => {
    process.env[ENV_KEY] = writeAllowlistFile({
      allowlistId: 'a', allowlistVersion: 1, targets: [{ entryId: 'e1', systemId: 's1' }],
    })
    expect(refusalOf(() => loadOutboundSqlWriteAllowlist()).details?.reason).toBe('object_scope_required')

    for (const wildcard of ['*', 'all', 'any', 'pre*fix']) {
      process.env[ENV_KEY] = writeAllowlistFile({
        allowlistId: 'a', allowlistVersion: 1,
        targets: [{ entryId: 'e1', systemId: wildcard, allObjects: true }],
      })
      expect(refusalOf(() => loadOutboundSqlWriteAllowlist()).details?.reason).toBe('wildcard_forbidden')
    }

    process.env[ENV_KEY] = writeAllowlistFile({
      allowlistId: 'a', allowlistVersion: 1,
      targets: [
        { entryId: 'dup', systemId: 's1', allObjects: true },
        { entryId: 'dup', systemId: 's2', allObjects: true },
      ],
    })
    expect(refusalOf(() => loadOutboundSqlWriteAllowlist()).details?.reason).toBe('duplicate_entry_id')

    process.env[ENV_KEY] = writeAllowlistFile({
      allowlistId: 'a', allowlistVersion: 1,
      targets: [{ entryId: 'e1', systemId: 's1', allObjects: true, operations: ['drop-everything'] }],
    })
    expect(refusalOf(() => loadOutboundSqlWriteAllowlist()).details?.reason).toBe('unknown_operation')
  })

  it('NO CACHING: revoking an entry takes effect immediately', () => {
    const file = writeAllowlistFile({
      allowlistId: 'a', allowlistVersion: 1, targets: [{ entryId: 'e1', systemId: 's1', allObjects: true }],
    })
    process.env[ENV_KEY] = file
    expect(evaluateOutboundSqlWrite({ systemId: 's1', operation: 'statement' }).authorized).toBe(true)
    fs.writeFileSync(file, JSON.stringify({ allowlistId: 'a', allowlistVersion: 2, targets: [] }), 'utf8')
    expect(evaluateOutboundSqlWrite({ systemId: 's1', operation: 'statement' }).authorized).toBe(false)
  })
})

describe('outbound SQL write gate — refusals are values-free', () => {
  it('a refusal carries no SQL, table, host or path', () => {
    delete process.env[ENV_KEY]
    const err = refusalOf(() => assertOutboundSqlWriteAuthorized(buildError, { systemId: 'src-1', operation: 'statement' }))
    const serialized = JSON.stringify({ message: err.message, details: err.details })
    for (const leak of ['INSERT', 't_ICItem', 'K3SRV', 'sql.customer.local', '/tmp', 'password']) {
      expect(serialized).not.toContain(leak)
    }
    // It DOES name the source id — that is what an operator must add to the allowlist to fix it.
    expect(serialized).toContain('src-1')
  })

  it('the error type is the caller layer’s own, and carries the fixed code/status', () => {
    delete process.env[ENV_KEY]
    const err = refusalOf(() => assertOutboundSqlWriteAuthorized(buildError, { systemId: 's', operation: 'statement' }))
    expect(err.code).toBe(OUTBOUND_SQL_WRITE_DISABLED)
    expect(err.status).toBe(403)
    expect(new OutboundSqlWriteGateError(500, 'X', 'm').name).toBe('OutboundSqlWriteGateError')
  })
})

// ─────────────────── PART 2 — THE WRITE/READ SPLIT ───────────────────

// The statements that defeated the destination sniffer across four rounds. Under the capability gate
// they are not special: each is simply "not provably a pure read", therefore a write.
const DEFEATED_THE_SNIFFER = [
  "UPDATE t SET FNumber='X' FROM t_ICItem AS t WHERE t.FItemID=1", // round-3: UPDATE…FROM alias
  "DELETE t FROM t_ICItem t WHERE t.FItemID=1",                    // round-3: DELETE…FROM alias
  "UPDATE TOP (5) t_ICItem SET FNumber='X'",                       // round-3: TOP before the table
  "INSERT INTO srv.AIS.dbo.t_ICItem (FItemID) VALUES (1)",         // round-3: 4-part linked-server name
  "WITH c AS (SELECT 1 AS n) DELETE FROM t_ICItem",                // round-4: data-modifying CTE
  "WITH c AS (SELECT 1 AS n) UPDATE t_ICItem SET FNumber='X'",
  "SELECT * FROM OPENQUERY(K3SRV, 'DELETE FROM t_ICItem')",        // round-4: cross-server smuggling
]

// Unterminated batches: T-SQL needs no `;`, so these LEAD with SELECT and carry no separator.
const NO_SEMICOLON_BATCHES = [
  'SELECT 1\nDELETE FROM t_ICItem',
  "SELECT 1\nINSERT t_ICItem(FName) VALUES('x')", // INSERT without INTO
  'SELECT 1\nTRUNCATE TABLE t_ICItem',
  'SELECT 1\nEXEC dbo.usp_x',
]

const PLAIN_WRITES = [
  "INSERT INTO staging (a) VALUES (1)",
  "UPDATE staging SET a=1",
  "DELETE FROM staging",
  "MERGE INTO staging AS t USING s ON 1=1 WHEN MATCHED THEN UPDATE SET a=1",
  "EXEC dbo.usp_anything",
  "DROP TABLE staging",
]

const PURE_READS = [
  'SELECT 1',
  '  select * from t ',
  'SELECT TOP 10 * FROM t_ICItem WHERE a=1', // a read OF a K3 table is still a read
  'SELECT 1;',                                // a single trailing semicolon is fine
  'EXPLAIN SELECT 1',
  'show tables',
  "SELECT a FROM t WHERE note = 'DELETE FROM t_ICItem'", // a write verb only inside a literal
  'SELECT [delete] FROM t',                              // …or only inside a quoted identifier
]

describe('outbound SQL write gate — the write/read split is the ONLY classification', () => {
  it('every statement that defeated the destination sniffer is simply a WRITE', () => {
    for (const sql of DEFEATED_THE_SNIFFER) {
      expect(isPureReadStatement(sql)).toBe(false)
      expect(isSqlWriteStatement(sql)).toBe(true)
    }
  })

  it('an unterminated multi-statement batch is a WRITE (no `;` to split on)', () => {
    for (const sql of NO_SEMICOLON_BATCHES) {
      expect(isPureReadStatement(sql)).toBe(false)
    }
  })

  it('plain writes and explicit batches are writes', () => {
    for (const sql of [...PLAIN_WRITES, 'SELECT 1; DROP TABLE t', 'SELECT * INTO backup FROM t']) {
      expect(isPureReadStatement(sql)).toBe(false)
    }
  })

  it('pure reads pass — including reads of any table, and write words inside literals/identifiers', () => {
    for (const sql of PURE_READS) {
      expect(isPureReadStatement(sql)).toBe(true)
      expect(isSqlWriteStatement(sql)).toBe(false)
    }
  })

  it('empty / whitespace is NOT a pure read (fail-closed)', () => {
    for (const sql of ['', '   ', ';']) expect(isPureReadStatement(sql)).toBe(false)
  })
})

// ─────────────────── PART 3 — THE ENFORCEMENT POINTS ───────────────────

function sqlserverConfig(id: string): DataSourceConfig {
  return {
    id,
    name: id,
    type: 'sqlserver',
    connection: { server: 'sql.customer.local', port: 1433, database: 'AIS' },
    options: { autoConnect: false, readOnly: false },
  }
}

async function managerWith(config: DataSourceConfig) {
  const m = new DataSourceManager()
  await m.addDataSource(config, { ownerId: 'owner-1' })
  return { m, adapter: m.getDataSource(config.id) }
}

async function asyncRefusal(p: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await p
  } catch (error) {
    return error as { code?: string; message?: string }
  }
  throw new Error('expected a refusal, but the promise resolved')
}

describe('enforcement — DataSourceManager.query / federatedQuery', () => {
  it('UNARMED: every write is refused before the driver; reads reach it', async () => {
    delete process.env[ENV_KEY]
    const { m, adapter } = await managerWith(sqlserverConfig('unarmed'))
    vi.spyOn(adapter, 'isConnected').mockReturnValue(true)
    const querySpy = vi.spyOn(adapter, 'query').mockResolvedValue({ data: [], rowCount: 0 } as never)

    for (const sql of [...DEFEATED_THE_SNIFFER, ...NO_SEMICOLON_BATCHES, ...PLAIN_WRITES]) {
      expect((await asyncRefusal(m.query('unarmed', sql))).code).toBe(OUTBOUND_SQL_WRITE_DISABLED)
    }
    expect(querySpy).not.toHaveBeenCalled() // nothing reached the driver

    // Reads are byte-identical to a deployment that never heard of this gate.
    await expect(m.query('unarmed', 'SELECT TOP 1 * FROM t_ICItem')).resolves.toBeDefined()
    expect(querySpy).toHaveBeenCalledTimes(1)
  })

  it('UNARMED: a federated write leg is refused', async () => {
    delete process.env[ENV_KEY]
    const { m, adapter } = await managerWith(sqlserverConfig('fed'))
    vi.spyOn(adapter, 'isConnected').mockReturnValue(true)
    vi.spyOn(adapter, 'query').mockResolvedValue({ data: [], rowCount: 0 } as never)
    const refusal = await asyncRefusal(m.federatedQuery([
      { dataSourceId: 'fed', sql: 'INSERT INTO staging VALUES (1)', alias: 'a' },
    ]))
    expect(refusal.code).toBe(OUTBOUND_SQL_WRITE_DISABLED)
  })

  it('ARMED: the same writes on the armed (non-K3) target are allowed', async () => {
    armFor('armed')
    const { m, adapter } = await managerWith(sqlserverConfig('armed'))
    vi.spyOn(adapter, 'isConnected').mockReturnValue(true)
    const querySpy = vi.spyOn(adapter, 'query').mockResolvedValue({ data: [], rowCount: 0 } as never)
    await expect(m.query('armed', "INSERT INTO staging (a) VALUES (1)")).resolves.toBeDefined()
    await expect(m.query('armed', "UPDATE staging SET a=1")).resolves.toBeDefined()
    expect(querySpy).toHaveBeenCalledTimes(2)
  })

  it('ARMED for one source does not arm another', async () => {
    armFor('armed')
    const { m, adapter } = await managerWith(sqlserverConfig('not-armed'))
    vi.spyOn(adapter, 'isConnected').mockReturnValue(true)
    vi.spyOn(adapter, 'query').mockResolvedValue({ data: [], rowCount: 0 } as never)
    const refusal = await asyncRefusal(m.query('not-armed', 'INSERT INTO staging VALUES (1)'))
    expect(refusal.code).toBe(OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED)
  })
})

describe('enforcement — MSSQLAdapter.query (the raw-adapter chokepoint)', () => {
  // The real adapter.query: a refused write throws BEFORE the pool is touched; an allowed statement
  // passes the gate and then fails with "Not connected" (no live DB), so "not a gate code" proves it
  // got past the gate.
  it('UNARMED: getDataSource(id).query(<any write>) is refused, incl. every sniffer-defeating shape', async () => {
    delete process.env[ENV_KEY]
    const { adapter } = await managerWith(sqlserverConfig('raw-unarmed'))
    for (const sql of [...DEFEATED_THE_SNIFFER, ...NO_SEMICOLON_BATCHES]) {
      expect((await asyncRefusal(adapter.query(sql))).code).toBe(OUTBOUND_SQL_WRITE_DISABLED)
    }
  })

  it('UNARMED: getDataSource(id).insert(...) is refused at the same chokepoint', async () => {
    delete process.env[ENV_KEY]
    const { adapter } = await managerWith(sqlserverConfig('raw-insert'))
    // insert() builds `INSERT INTO [t] …` and calls query() — the gate catches it.
    expect((await asyncRefusal(adapter.insert('staging', { a: 1 }))).code).toBe(OUTBOUND_SQL_WRITE_DISABLED)
  })

  it('UNARMED: beginTransaction is refused (it vends a raw driver handle outside the funnel)', async () => {
    delete process.env[ENV_KEY]
    const { adapter } = await managerWith(sqlserverConfig('raw-txn'))
    expect((await asyncRefusal(adapter.beginTransaction())).code).toBe(OUTBOUND_SQL_WRITE_DISABLED)
  })

  it('UNARMED: a read passes the gate (fails only later, at connect)', async () => {
    delete process.env[ENV_KEY]
    const { adapter } = await managerWith(sqlserverConfig('raw-read'))
    const err = await asyncRefusal(adapter.query('SELECT TOP 1 * FROM t_ICItem'))
    expect(err.code).not.toBe(OUTBOUND_SQL_WRITE_DISABLED)
    expect(String(err.message)).toMatch(/Not connected/)
  })

  it('ARMED: a write passes the gate (fails only later, at connect)', async () => {
    armFor('raw-armed')
    const { adapter } = await managerWith(sqlserverConfig('raw-armed'))
    const err = await asyncRefusal(adapter.query("INSERT INTO staging (a) VALUES (1)"))
    expect(err.code).not.toBe(OUTBOUND_SQL_WRITE_DISABLED)
    expect(err.code).not.toBe(OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED)
    expect(String(err.message)).toMatch(/Not connected/)
  })
})

describe('outbound SQL write gate — env tampering cannot unlock it', () => {
  it('only the one env key arms the gate; neighbours and truthy values do nothing', async () => {
    delete process.env[ENV_KEY]
    const decoys = [
      'INTEGRATION_CORE_OUTBOUND_SQL_WRITE',
      'INTEGRATION_CORE_OUTBOUND_SQL_WRITE_TARGETS_ENABLED',
      'OUTBOUND_SQL_WRITE_DISABLED',
      'INTEGRATION_CORE_OUTBOUND_HTTP_WRITE_TARGETS', // the OTHER lane's key must not arm this one
      'SQL_WRITE_ENABLED',
    ]
    const saved = decoys.map((k) => [k, process.env[k]] as const)
    try {
      for (const k of decoys) process.env[k] = 'true'
      const { m, adapter } = await managerWith(sqlserverConfig('tamper'))
      vi.spyOn(adapter, 'isConnected').mockReturnValue(true)
      vi.spyOn(adapter, 'query').mockResolvedValue({ data: [], rowCount: 0 } as never)
      expect((await asyncRefusal(m.query('tamper', 'INSERT INTO staging VALUES (1)'))).code)
        .toBe(OUTBOUND_SQL_WRITE_DISABLED)
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('pointing the env at a file that arms nothing still denies', () => {
    process.env[ENV_KEY] = writeAllowlistFile({ allowlistId: 'a', allowlistVersion: 1, targets: [] })
    expect(evaluateOutboundSqlWrite({ systemId: 's1', operation: 'statement' }).authorized).toBe(false)
  })
})
