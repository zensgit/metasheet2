import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

import { DataSourceManager } from '../../src/data-adapters/DataSourceManager'
import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'
import {
  K3_DESTINATION_MARKER_IMMUTABLE,
  K3_WISE_EXTERNAL_WRITE_DISABLED,
  assertNotK3Destination,
  attemptsToClearK3Marker,
  isK3MarkedDestination,
  preserveK3Marker,
} from '../../src/data-adapters/k3-destination-write-fence'

// THE K3 DESTINATION MARKER — what remains after the destination sniffer was RETIRED.
//
// The load-bearing control for SQL writes is now the DEFAULT-DENY capability gate
// (`outbound-sql-write-gate.ts`, suite: `outbound-sql-write-gate.test.ts`). Four rounds of
// adversarial verification showed a destination sniffer (parse the SQL for K3 tables, probe the
// catalog) cannot hold, and it is the option the owner rejected on 2026-08-29.
//
// What survives here, and is tested here, is deliberately modest:
//   * the DECLARED marker `options.k3Destination === true`;
//   * a marked source refuses STRUCTURED writes (cheap defense in depth, not a guarantee); and
//   * the marker is SET-ONCE — no config edit may clear it.
// There is no SQL parsing, no K3 table signature and no catalog probe left to test, because none of
// them is a control any more.

const require = createRequire(import.meta.url)
// The plugin's permanent kind fence — required directly so the host↔plugin token agreement is a
// VALUE pin, not a by-convention duplicate. A rename on either side reds here.
const PLUGIN_FENCE = require('../../../../plugins/plugin-integration-core/lib/k3-external-write-permanent-fence.cjs') as {
  K3_WISE_EXTERNAL_WRITE_DISABLED: string
  K3_EXTERNAL_WRITE_SQLSERVER_TARGET_KIND: string
}

const FIXED_CODE = 'K3_WISE_EXTERNAL_WRITE_DISABLED'

function syncRefusal(fn: () => void): { code?: string; status?: number } {
  try {
    fn()
  } catch (error) {
    return error as { code?: string; status?: number }
  }
  throw new Error('expected a refusal, but nothing was thrown')
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

describe('K3 marker — the closed token still agrees with the plugin fence (value pin)', () => {
  it('the host token is the exact literal and equals the plugin fence token', () => {
    expect(K3_WISE_EXTERNAL_WRITE_DISABLED).toBe(FIXED_CODE)
    expect(PLUGIN_FENCE.K3_WISE_EXTERNAL_WRITE_DISABLED).toBe(FIXED_CODE)
    expect(K3_WISE_EXTERNAL_WRITE_DISABLED).toBe(PLUGIN_FENCE.K3_WISE_EXTERNAL_WRITE_DISABLED)
    expect(PLUGIN_FENCE.K3_EXTERNAL_WRITE_SQLSERVER_TARGET_KIND).toBe('erp:k3-wise-sqlserver')
  })
})

describe('K3 marker — declaration semantics', () => {
  it('counts only a deliberate boolean true', () => {
    expect(isK3MarkedDestination({ k3Destination: true } as never)).toBe(true)
    expect(isK3MarkedDestination({ k3Destination: 'true' } as never)).toBe(false)
    expect(isK3MarkedDestination({ k3Destination: 1 } as never)).toBe(false)
    expect(isK3MarkedDestination({} as never)).toBe(false)
    expect(isK3MarkedDestination(undefined)).toBe(false)
  })

  it('a marked source refuses structured writes; an unmarked one does not (marker-only, no table check)', () => {
    expect(syncRefusal(() => assertNotK3Destination({ options: { k3Destination: true } } as never)).code).toBe(FIXED_CODE)
    expect(syncRefusal(() => assertNotK3Destination({ options: { k3Destination: true } } as never)).status).toBe(403)
    expect(() => assertNotK3Destination({ options: {} } as never)).not.toThrow()
  })
})

describe('K3 marker durability (P1) — set-once, not clearable', () => {
  it('attemptsToClearK3Marker detects only a real clear on an already-marked source', () => {
    expect(attemptsToClearK3Marker({ k3Destination: true } as never, { k3Destination: false } as never)).toBe(true)
    expect(attemptsToClearK3Marker({ k3Destination: true } as never, { k3Destination: true } as never)).toBe(false)
    // Absent in the incoming patch = not clearing (the deep-merge preserves it).
    expect(attemptsToClearK3Marker({ k3Destination: true } as never, { timeout: 5 } as never)).toBe(false)
    // Not marked to begin with: nothing to protect.
    expect(attemptsToClearK3Marker({} as never, { k3Destination: false } as never)).toBe(false)
  })

  it('preserveK3Marker forces the marker true through any merge on a marked source', () => {
    expect(preserveK3Marker({ k3Destination: true } as never, { timeout: 5 } as never)).toEqual({ timeout: 5, k3Destination: true })
    expect(preserveK3Marker({ k3Destination: true } as never, { k3Destination: false } as never)).toEqual({ k3Destination: true })
    expect(preserveK3Marker({} as never, { k3Destination: false } as never)).toEqual({ k3Destination: false })
  })

  it('DataSourceManager.updateDataSource cannot clear the marker (belt-and-suspenders net)', async () => {
    const m = new DataSourceManager()
    await m.addDataSource(sqlserverConfig('durable', { k3Destination: true }), { ownerId: 'o' })
    await m.updateDataSource(
      'durable',
      { ...sqlserverConfig('durable'), options: { autoConnect: false, readOnly: false, k3Destination: false } },
      { ownerId: 'o' },
    )
    expect(m.getDataSource('durable').getConfig().options?.k3Destination).toBe(true)
    expect(K3_DESTINATION_MARKER_IMMUTABLE).toBe('K3_DESTINATION_MARKER_IMMUTABLE')
  })

  it('a marked source refuses the structured manager write methods', async () => {
    const m = new DataSourceManager()
    await m.addDataSource(sqlserverConfig('marked', { k3Destination: true }), { ownerId: 'o' })
    const adapter = m.getDataSource('marked')
    vi.spyOn(adapter, 'isConnected').mockReturnValue(true)
    const insertSpy = vi.spyOn(adapter, 'insert').mockResolvedValue({ data: [], rowCount: 0 } as never)
    await expect(m.insert('marked', 'anything', { a: 1 })).rejects.toMatchObject({ code: FIXED_CODE })
    expect(insertSpy).not.toHaveBeenCalled()
  })
})
