import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

import { DataSourceManager } from '../../src/data-adapters/DataSourceManager'
import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'
import {
  K3_WISE_EXTERNAL_WRITE_DISABLED,
  K3_WISE_BUSINESS_TABLE_SIGNATURE,
  assertNotK3Destination,
  assertNotK3MarkedDestination,
  assertNotK3SqlWrite,
  classifySqlWrite,
  isK3BusinessTable,
  isK3MarkedDestination,
  normalizeDestinationTable,
  sqlTargetsK3BusinessTable,
} from '../../src/data-adapters/k3-destination-write-fence'

// G-4 / E4 DESTINATION FENCE — the by-kind ban made destination-oriented at the true chokepoint.
//
// The plugin fences key on connector KIND. This suite proves the host refuses a K3 WRITE by
// DESTINATION at DataSourceManager, closing the hole where a `data-source:sql-write-gated` source
// points at a `sqlserver` data_sources row aimed at the customer's K3 database and writes as the
// generic C6 kind. Two independent checks: an explicit marker (declared destination) and the K3
// business-table signature (catches a disguised, unmarked destination). READS stay untouched.

const require = createRequire(import.meta.url)
// The plugin's permanent kind fence — required directly so the host↔plugin token agreement is a
// VALUE pin, not a by-convention duplicate. A rename on either side reds here.
const PLUGIN_FENCE = require('../../../../plugins/plugin-integration-core/lib/k3-external-write-permanent-fence.cjs') as {
  K3_WISE_EXTERNAL_WRITE_DISABLED: string
  K3_EXTERNAL_WRITE_SQLSERVER_TARGET_KIND: string
}

const FIXED_CODE = 'K3_WISE_EXTERNAL_WRITE_DISABLED'

// The refusal is asserted on the closed CODE, not the message — the token is the contract, the
// operator text is not. These helpers capture the thrown/rejected error so `.code` can be checked.
function syncRefusal(fn: () => void): { code?: string; status?: number; message?: string } {
  try {
    fn()
  } catch (error) {
    return error as { code?: string; status?: number; message?: string }
  }
  throw new Error('expected a refusal, but nothing was thrown')
}

async function asyncRefusal(p: Promise<unknown>): Promise<{ code?: string; status?: number }> {
  try {
    await p
  } catch (error) {
    return error as { code?: string; status?: number }
  }
  throw new Error('expected a refusal, but the promise resolved')
}

function sqlserverConfig(id: string, extraOptions: Record<string, unknown> = {}): DataSourceConfig {
  return {
    id,
    name: id,
    type: 'sqlserver',
    connection: { server: 'sql.customer.local', port: 1433, database: 'AIS' },
    options: { autoConnect: false, readOnly: false, ...extraOptions },
  }
}

// A write-capable sqlserver source that will NOT touch a real driver: its adapter is stubbed to
// report connected and to record (never execute) writes. Lets the ALLOWED path complete and proves
// the fence did not fire, without a live database.
async function managerWithStubbedWrite(config: DataSourceConfig) {
  const m = new DataSourceManager()
  await m.addDataSource(config, { ownerId: 'owner-1' })
  const adapter = m.getDataSource(config.id)
  vi.spyOn(adapter, 'isConnected').mockReturnValue(true)
  const insertSpy = vi.spyOn(adapter, 'insert').mockResolvedValue({ data: [], rowCount: 0 } as never)
  const updateSpy = vi.spyOn(adapter, 'update').mockResolvedValue({ data: [], rowCount: 0 } as never)
  const deleteSpy = vi.spyOn(adapter, 'delete').mockResolvedValue({ data: [], rowCount: 0 } as never)
  const querySpy = vi.spyOn(adapter, 'query').mockResolvedValue({ data: [], rowCount: 0 } as never)
  return { m, adapter, insertSpy, updateSpy, deleteSpy, querySpy }
}

describe('K3 destination fence — the closed token agrees with the plugin fence (value pin)', () => {
  it('the host token is the exact literal and equals the plugin fence token', () => {
    expect(K3_WISE_EXTERNAL_WRITE_DISABLED).toBe(FIXED_CODE)
    // The binding: host and plugin must name the SAME closed token. Not derived from each other —
    // each is its own literal — so this equality is what keeps them from silently diverging.
    expect(PLUGIN_FENCE.K3_WISE_EXTERNAL_WRITE_DISABLED).toBe(FIXED_CODE)
    expect(K3_WISE_EXTERNAL_WRITE_DISABLED).toBe(PLUGIN_FENCE.K3_WISE_EXTERNAL_WRITE_DISABLED)
    // And the kind the destination hole launders is the sibling the plugin fence now covers.
    expect(PLUGIN_FENCE.K3_EXTERNAL_WRITE_SQLSERVER_TARGET_KIND).toBe('erp:k3-wise-sqlserver')
  })
})

describe('K3 destination fence — the business-table signature is pinned BY VALUE and frozen', () => {
  it('contains the widened K3 write-target catalog by literal string, so shrinking it reds', () => {
    // P1b: widened from the item/BOM plane to the tables the legacy ErpController write surface
    // actually targeted — base-data core tables (t_MeasureUnit/t_Organization, which carry NO
    // t_ic/t_bd prefix and were a real gap), production order (ICMO), inventory bills (ICStockBill),
    // purchase/sales orders, and the ECN bill numbers. Value-pinned so removing any family reds.
    expect([...K3_WISE_BUSINESS_TABLE_SIGNATURE.exact]).toEqual([
      't_icitem',
      't_icbom',
      't_icbomchild',
      't_icitembase',
      't_measureunit',
      't_organization',
      'icmo',
      'icmoentry',
      'icstockbill',
      'icstockbillentry',
      'poorder',
      'poorderentry',
      'seorder',
      'seorderentry',
      'bill1002535',
      'bill1002502',
    ])
    expect([...K3_WISE_BUSINESS_TABLE_SIGNATURE.prefixes]).toEqual(['t_ic', 't_bd'])
    // The two families that had NO prefix coverage before — pin them explicitly so a regression
    // that drops them from `exact` reds here too.
    expect(isK3BusinessTable('t_MeasureUnit')).toBe(true)
    expect(isK3BusinessTable('t_Organization')).toBe(true)
    expect(isK3BusinessTable('ICMO')).toBe(true)
    expect(isK3BusinessTable('dbo.ICStockBill')).toBe(true)
    expect(isK3BusinessTable('POOrder')).toBe(true)
    expect(isK3BusinessTable('SEOrder')).toBe(true)
  })

  it('is frozen — a runtime mutation of the subject set is an unlock and must throw', () => {
    expect(Object.isFrozen(K3_WISE_BUSINESS_TABLE_SIGNATURE)).toBe(true)
    expect(Object.isFrozen(K3_WISE_BUSINESS_TABLE_SIGNATURE.exact)).toBe(true)
    expect(Object.isFrozen(K3_WISE_BUSINESS_TABLE_SIGNATURE.prefixes)).toBe(true)
    expect(() => {
      ;(K3_WISE_BUSINESS_TABLE_SIGNATURE.exact as unknown as string[]).push('t_evil')
    }).toThrow(TypeError)
  })
})

describe('K3 destination fence — table normalization and signature match', () => {
  it('normalizes brackets, schema qualifiers and case to one canonical form', () => {
    expect(normalizeDestinationTable('t_ICItem')).toBe('t_icitem')
    expect(normalizeDestinationTable('[t_ICItem]')).toBe('t_icitem')
    expect(normalizeDestinationTable('dbo.t_ICItem')).toBe('t_icitem')
    expect(normalizeDestinationTable('dbo.[t_ICItem]')).toBe('t_icitem')
    expect(normalizeDestinationTable('AIS.dbo.t_ICItem')).toBe('t_icitem')
    expect(normalizeDestinationTable('  T_ICItem  ')).toBe('t_icitem')
  })

  it('matches the K3 business tables (exact + prefix) and NOT staging tables', () => {
    expect(isK3BusinessTable('t_ICItem')).toBe(true)
    expect(isK3BusinessTable('dbo.t_ICBOM')).toBe(true)
    expect(isK3BusinessTable('[t_ICBomChild]')).toBe(true)
    expect(isK3BusinessTable('t_BDMaterial')).toBe(true) // t_bd prefix (base data)
    expect(isK3BusinessTable('AIS.dbo.t_ICItemBase')).toBe(true)
    // The legitimate C6 middle-table lane — must NOT match, or the green lane breaks.
    expect(isK3BusinessTable('integration_material_stage')).toBe(false)
    expect(isK3BusinessTable('dbo.stg_material')).toBe(false)
    expect(isK3BusinessTable('')).toBe(false)
  })

  it('the marker counts only a deliberate boolean true', () => {
    expect(isK3MarkedDestination({ k3Destination: true } as never)).toBe(true)
    expect(isK3MarkedDestination({ k3Destination: 'true' } as never)).toBe(false)
    expect(isK3MarkedDestination({ k3Destination: 1 } as never)).toBe(false)
    expect(isK3MarkedDestination({} as never)).toBe(false)
    expect(isK3MarkedDestination(undefined)).toBe(false)
  })

  it('assertNotK3Destination fires on the marker, on the signature, and passes otherwise', () => {
    // Marker fires even against a perfectly innocent staging table name.
    expect(syncRefusal(() => assertNotK3Destination({ options: { k3Destination: true } } as never, 'stg_ok')).code)
      .toBe(FIXED_CODE)
    // Signature fires even with NO marker — the disguise case.
    expect(syncRefusal(() => assertNotK3Destination({ options: {} } as never, 't_ICItem')).code).toBe(FIXED_CODE)
    // Both refusals are a 403.
    expect(syncRefusal(() => assertNotK3Destination({ options: {} } as never, 't_ICItem')).status).toBe(403)
    // Neither fires: a normal write to a normal table.
    expect(() => assertNotK3Destination({ options: {} } as never, 'integration_material_stage')).not.toThrow()
    // Marker-only assertion for raw query.
    expect(syncRefusal(() => assertNotK3MarkedDestination({ options: { k3Destination: true } } as never)).code)
      .toBe(FIXED_CODE)
    expect(() => assertNotK3MarkedDestination({ options: {} } as never)).not.toThrow()
  })
})

describe('DataSourceManager destination fence — a MARKED K3 destination is refused (declared)', () => {
  it('refuses insert/update/delete/query on a k3Destination source before touching the driver', async () => {
    const { m, insertSpy, updateSpy, deleteSpy, querySpy } =
      await managerWithStubbedWrite(sqlserverConfig('k3-marked', { k3Destination: true }))

    // Even a totally innocent target table name is refused — the destination itself is banned.
    expect((await asyncRefusal(m.insert('k3-marked', 'harmless_stage', { code: 'X' }))).code).toBe(FIXED_CODE)
    expect((await asyncRefusal(m.update('k3-marked', 'harmless_stage', { name: 'Y' }, { code: 'X' }))).code).toBe(FIXED_CODE)
    expect((await asyncRefusal(m.delete('k3-marked', 'harmless_stage', { code: 'X' }))).code).toBe(FIXED_CODE)
    expect((await asyncRefusal(m.query('k3-marked', 'SELECT 1'))).code).toBe(FIXED_CODE)

    expect(insertSpy).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
    expect(deleteSpy).not.toHaveBeenCalled()
    expect(querySpy).not.toHaveBeenCalled()
  })

  it('the marker survives the in-memory registration round-trip (getConfig reports it)', async () => {
    const { m } = await managerWithStubbedWrite(sqlserverConfig('k3-marked-2', { k3Destination: true }))
    // The DB persist path (configToRecord -> recordToConfig) spreads options wholesale, so the marker
    // is durable across a restart too; here we pin the in-memory contract the write path reads.
    expect(m.getDataSource('k3-marked-2').getConfig().options?.k3Destination).toBe(true)
  })
})

describe('DataSourceManager destination fence — an UNMARKED K3 business-table write is refused (disguise)', () => {
  it('refuses a write to t_ICItem even with no marker — the table name is the tell', async () => {
    const { m, insertSpy, updateSpy, deleteSpy } =
      await managerWithStubbedWrite(sqlserverConfig('k3-disguised')) // NO k3Destination marker

    expect((await asyncRefusal(m.insert('k3-disguised', 't_ICItem', { FNumber: 'MAT-1' }))).code).toBe(FIXED_CODE)
    expect((await asyncRefusal(m.update('k3-disguised', 'dbo.t_ICBOM', { FName: 'x' }, { FNumber: 'MAT-1' }))).code).toBe(FIXED_CODE)
    expect((await asyncRefusal(m.delete('k3-disguised', '[t_ICItemBase]', { FNumber: 'MAT-1' }))).code).toBe(FIXED_CODE)

    expect(insertSpy).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
    expect(deleteSpy).not.toHaveBeenCalled()
  })

  it('refuses copyData whose TARGET table is a K3 business table, before the first source read', async () => {
    const m = new DataSourceManager()
    await m.addDataSource(sqlserverConfig('copy-src'), { ownerId: 'owner-1' })
    await m.addDataSource(sqlserverConfig('copy-k3-target'), { ownerId: 'owner-1' })
    const connectSpy = vi.spyOn(m, 'connectDataSource')
    expect((await asyncRefusal(m.copyData('copy-src', 'src', 'copy-k3-target', 't_ICItem'))).code).toBe(FIXED_CODE)
    expect(connectSpy).not.toHaveBeenCalled() // refused before any connect / source read
    connectSpy.mockRestore()
  })
})

describe('DataSourceManager destination fence — the legitimate non-K3 write lane still works (green)', () => {
  it('allows a write to a normal staging table on an unmarked non-K3 sqlserver source', async () => {
    const { m, insertSpy } = await managerWithStubbedWrite(sqlserverConfig('non-k3'))
    // Passes the fence and reaches the (stubbed) adapter — proving the fence did NOT fire.
    await expect(m.insert('non-k3', 'integration_material_stage', { code: 'MAT-1' })).resolves.toBeDefined()
    expect(insertSpy).toHaveBeenCalledTimes(1)
    // DataSourceManager.insert forwards `data` verbatim to the adapter (the facade is what wraps rows
    // into an array before it reaches here), so a single-object write arrives as a single object.
    expect(insertSpy).toHaveBeenCalledWith('integration_material_stage', { code: 'MAT-1' })
  })

  it('allows update/query on the same non-K3 source', async () => {
    const { m, updateSpy, querySpy } = await managerWithStubbedWrite(sqlserverConfig('non-k3-2'))
    await expect(m.update('non-k3-2', 'integration_material_stage', { name: 'x' }, { code: 'A' })).resolves.toBeDefined()
    await expect(m.query('non-k3-2', 'SELECT 1')).resolves.toBeDefined()
    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(querySpy).toHaveBeenCalledTimes(1)
  })
})

// ── P0 — SWITCH THE VERB (the executed bypass) ────────────────────────────────────────────────
// The refuted attack: structured insert/update/delete were fenced, but query() ran ANY statement —
// so INSERT INTO t_ICItem via query() reached the driver. The fix classifies the raw SQL.

describe('K3 destination fence — raw-SQL write classification', () => {
  it('classifies write verbs and extracts write-target tables/procs, never read sources', () => {
    expect(classifySqlWrite("INSERT INTO t_ICItem (a) VALUES (1)")).toEqual({ isWrite: true, targets: ['t_icitem'] })
    expect(classifySqlWrite("UPDATE dbo.[t_ICItem] SET a=1 WHERE b=2")).toEqual({ isWrite: true, targets: ['t_icitem'] })
    expect(classifySqlWrite("DELETE FROM t_ICItem WHERE b=2")).toEqual({ isWrite: true, targets: ['t_icitem'] })
    expect(classifySqlWrite("MERGE INTO t_ICBOM AS x USING y ON x.id=y.id WHEN MATCHED THEN UPDATE SET a=1")).toEqual({ isWrite: true, targets: ['t_icbom'] })
    expect(classifySqlWrite("EXEC dbo.usp_save_material @x=1")).toEqual({ isWrite: true, targets: ['usp_save_material'] })
    // A write to a NON-K3 table INSERT ... SELECT FROM a K3 table: the target is staging, the FROM is
    // a legitimate READ of K3 — only the write target (staging) is captured.
    expect(classifySqlWrite("INSERT INTO integration_material_stage SELECT * FROM t_ICItem"))
      .toEqual({ isWrite: true, targets: ['integration_material_stage'] })
    // SELECT ... INTO newtable is a write.
    expect(classifySqlWrite("SELECT * INTO t_ICItem FROM src")).toMatchObject({ isWrite: true })
    expect(classifySqlWrite("SELECT * INTO t_ICItem FROM src").targets).toContain('t_icitem')
    // Reads are not writes and capture no target.
    expect(classifySqlWrite("SELECT * FROM t_ICItem WHERE a=1")).toEqual({ isWrite: false, targets: [] })
    expect(classifySqlWrite("WITH x AS (SELECT 1) SELECT * FROM x")).toEqual({ isWrite: false, targets: [] })
    // A table name that only appears INSIDE a string literal is not a target (literals are stripped).
    expect(classifySqlWrite("SELECT 'INSERT INTO t_ICItem' AS note")).toEqual({ isWrite: false, targets: [] })
  })

  it('sqlTargetsK3BusinessTable is true only for a write whose target is a K3 table', () => {
    expect(sqlTargetsK3BusinessTable("INSERT INTO t_ICItem (a) VALUES (1)")).toBe(true)
    expect(sqlTargetsK3BusinessTable("UPDATE ICMO SET status=1")).toBe(true)          // widened family
    expect(sqlTargetsK3BusinessTable("DELETE FROM dbo.ICStockBill")).toBe(true)       // widened family
    expect(sqlTargetsK3BusinessTable("INSERT INTO integration_material_stage VALUES (1)")).toBe(false)
    expect(sqlTargetsK3BusinessTable("SELECT * FROM t_ICItem")).toBe(false)           // read
  })

  it('assertNotK3SqlWrite: marked refuses any write; any destination refuses a K3-table write; reads pass', () => {
    // Marked K3 destination: any write refused (even to an innocent table).
    expect(syncRefusal(() => assertNotK3SqlWrite({ options: { k3Destination: true } } as never, "INSERT INTO whatever VALUES (1)")).code).toBe(FIXED_CODE)
    // Unmarked: a K3-table write refused.
    expect(syncRefusal(() => assertNotK3SqlWrite({ options: {} } as never, "INSERT INTO t_ICItem VALUES (1)")).code).toBe(FIXED_CODE)
    expect(syncRefusal(() => assertNotK3SqlWrite({ options: {} } as never, "UPDATE ICMO SET a=1")).code).toBe(FIXED_CODE)
    // Unmarked: a non-K3 write is allowed.
    expect(() => assertNotK3SqlWrite({ options: {} } as never, "INSERT INTO integration_material_stage VALUES (1)")).not.toThrow()
    // Any: a read is allowed, even a read of a K3 table, even on a marked source's read... (marked
    // reads are gated at the raw-query surface, but the SQL-write assertion itself never fences reads).
    expect(() => assertNotK3SqlWrite({ options: {} } as never, "SELECT * FROM t_ICItem")).not.toThrow()
    expect(() => assertNotK3SqlWrite({ options: { k3Destination: true } } as never, "SELECT 1")).not.toThrow()
  })
})

describe('DataSourceManager query() — the verb-switch bypass is refused (P0)', () => {
  it('refuses INSERT/UPDATE/DELETE/MERGE/EXEC into a K3 table via raw query(), before the adapter', async () => {
    const { m, querySpy } = await managerWithStubbedWrite(sqlserverConfig('k3-verbswitch')) // UNMARKED
    for (const sql of [
      "INSERT INTO t_ICItem (FItemID,FNumber) VALUES (99999,'HACK')",
      "UPDATE t_ICItem SET FNumber='X' WHERE FItemID=1",
      "DELETE FROM t_ICItem WHERE FItemID=1",
      "MERGE INTO t_ICBOM AS t USING s ON t.id=s.id WHEN MATCHED THEN UPDATE SET a=1",
      "UPDATE ICMO SET FStatus=1",              // widened: production order
      "DELETE FROM dbo.ICStockBill WHERE x=1",  // widened: inventory bill
    ]) {
      expect((await asyncRefusal(m.query('k3-verbswitch', sql))).code).toBe(FIXED_CODE)
    }
    expect(querySpy).not.toHaveBeenCalled() // the executed P0 no longer reaches the driver
  })

  it('federatedQuery refuses a leg that writes a K3 table', async () => {
    const { m } = await managerWithStubbedWrite(sqlserverConfig('k3-fed'))
    const refusal = await asyncRefusal(m.federatedQuery([
      { dataSourceId: 'k3-fed', sql: "INSERT INTO t_ICItem VALUES (1)", alias: 'a' },
    ]))
    expect(refusal.code).toBe(FIXED_CODE)
  })

  it('still allows a non-K3 write and a read via raw query() (green lane intact)', async () => {
    const { m, querySpy } = await managerWithStubbedWrite(sqlserverConfig('non-k3-raw'))
    await expect(m.query('non-k3-raw', "INSERT INTO integration_material_stage (code) VALUES ('X')")).resolves.toBeDefined()
    await expect(m.query('non-k3-raw', "SELECT * FROM t_ICItem WHERE a=1")).resolves.toBeDefined() // read of K3 is fine
    expect(querySpy).toHaveBeenCalledTimes(2)
  })
})

// ── P1a — THE ADAPTER BOUNDARY (getDataSource hands out a raw write-capable adapter) ──────────
// The fence must hold at the true chokepoint, not only on the manager wrappers. Every MSSQLAdapter
// write funnels through query(), so fencing query() covers getDataSource(id).query()/insert() too.

describe('MSSQLAdapter.query() — the adapter-boundary chokepoint (P1a)', () => {
  // Use the REAL adapter.query (not stubbed). A refused write throws the fence code BEFORE the pool
  // is touched; an allowed statement passes the fence and then fails with "Not connected" (no live
  // DB) — so "not the fence code" proves it passed the fence.
  async function rawAdapter(config: DataSourceConfig) {
    const m = new DataSourceManager()
    await m.addDataSource(config, { ownerId: 'owner-1' })
    return m.getDataSource(config.id)
  }

  it('refuses getDataSource(id).query(INSERT INTO t_ICItem) — the raw-adapter path', async () => {
    const a = await rawAdapter(sqlserverConfig('raw-k3')) // UNMARKED
    expect((await asyncRefusal(a.query("INSERT INTO t_ICItem (FItemID) VALUES (1)"))).code).toBe(FIXED_CODE)
    expect((await asyncRefusal(a.query("UPDATE ICMO SET a=1"))).code).toBe(FIXED_CODE)
  })

  it('refuses getDataSource(id).insert(t_ICItem, …) at the same boundary', async () => {
    const a = await rawAdapter(sqlserverConfig('raw-k3-insert'))
    // adapter.insert builds `INSERT INTO [t_ICItem] …` and calls query() — the fence catches it.
    expect((await asyncRefusal(a.insert('t_ICItem', { FItemID: 1, FNumber: 'X' }))).code).toBe(FIXED_CODE)
  })

  it('refuses beginTransaction on a marked destination (no raw transaction handle for a K3 source)', async () => {
    const a = await rawAdapter(sqlserverConfig('raw-k3-txn', { k3Destination: true }))
    expect((await asyncRefusal(a.beginTransaction())).code).toBe(FIXED_CODE)
  })

  it('a read of a K3 table passes the fence (fails only later at connect, not with the fence code)', async () => {
    const a = await rawAdapter(sqlserverConfig('raw-k3-read'))
    const err = await asyncRefusal(a.query("SELECT TOP 1 * FROM t_ICItem")) as { code?: string; message?: string }
    expect(err.code).not.toBe(FIXED_CODE)              // reads are never fenced
    expect(String(err.message)).toMatch(/Not connected/) // it got PAST the fence, to the pool check
  })

  it('a non-K3 write passes the fence (green lane at the adapter boundary)', async () => {
    const a = await rawAdapter(sqlserverConfig('raw-nonk3'))
    const err = await asyncRefusal(a.query("INSERT INTO integration_material_stage (code) VALUES ('X')")) as { code?: string; message?: string }
    expect(err.code).not.toBe(FIXED_CODE)
    expect(String(err.message)).toMatch(/Not connected/)
  })
})
