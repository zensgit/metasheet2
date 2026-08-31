import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

import { DataSourceManager } from '../../src/data-adapters/DataSourceManager'
import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'
import {
  K3_WISE_EXTERNAL_WRITE_DISABLED,
  K3_WISE_BUSINESS_TABLE_SIGNATURE,
  assertNotK3Destination,
  assertNotK3MarkedDestination,
  isK3BusinessTable,
  isK3MarkedDestination,
  normalizeDestinationTable,
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
  it('contains the K3 catalog by literal string, so shrinking it reds', () => {
    expect([...K3_WISE_BUSINESS_TABLE_SIGNATURE.exact]).toEqual([
      't_icitem',
      't_icbom',
      't_icbomchild',
      't_icitembase',
    ])
    expect([...K3_WISE_BUSINESS_TABLE_SIGNATURE.prefixes]).toEqual(['t_ic', 't_bd'])
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
