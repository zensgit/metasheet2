import { beforeEach, describe, expect, it, vi } from 'vitest'

// BOM备料 向导第①a 步「登记外接数据源」的真实检测 — the SERVICE half (①拆分, 2026-09-10).
//
// WHY THIS READ EXISTS AT ALL. 整合切片 folded 外接数据源 into 数据工厂's 连接管理 section, which left
// the wizard's old step ① describing TWO acts at once: registering a physical data source (①a) and
// creating the SQL binding that references it (①b). The source-binding envelope the install page
// already holds answers ①b and ONLY ①b — `eligibleSources` enumerates external SYSTEMS, so its
// emptiness is SILENT about whether a data source is registered. This module is the read that can
// answer ①a, and this suite is what keeps it from answering anything wider.
//
// What this suite pins:
//   D1  the SQL-type filter: postgres / postgresql / sqlserver / mysql count; `http` and `plm` do
//       not, because ①b's binding kind is a SQL read-only bridge and a REST source cannot back one
//   D2  「看不到」≠「没完成」 (G4): 403 / 401 / 500 / network / non-JSON / envelope-not-ok /
//       unrecognised shape ALL collapse to `unknown`, and NEVER to `absent`
//   D3  `absent` stays REACHABLE and correct — an `items: []` that IS an array is a real answer
//   D4  VALUES-FREE, asserted in REVERSE on the serialized result: a payload stuffed with connection
//       names, hosts, ids and owner emails projects to a state and two integers, nothing else
//   D5  the route is read literally, as a GET, with no query string and no write method
//   D6  the read never rejects — a caller cannot turn it into a red banner by forgetting a catch
//   D7  D6 the OTHER D6 (源预检永不随页面自动跑): this module issues exactly ONE request and it is the
//       registry list. Nothing here touches a customer database, which is why the wizard may run it
//       unprompted on mount.

const h = vi.hoisted(() => ({ apiFetch: vi.fn() }))

vi.mock('../src/utils/api', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/api')>('../src/utils/api')
  return { ...actual, apiFetch: h.apiFetch }
})

import {
  STOCK_PREP_DATA_SOURCE_REGISTRY_ROUTE,
  STOCK_PREP_SQL_DATA_SOURCE_TYPES,
  readStockPrepDataSourceRegistry,
  stockPrepDataSourceRegistryFromPayload,
  stockPrepDataSourceRegistryUnknown,
  stockPrepIsSqlDataSourceType,
} from '../src/services/integration/stockPreparation/dataSourceRegistry'

/** Planted values. NONE of these may survive the projection (D4). */
const PLANTED_NAME = '用友U8生产库'
const PLANTED_HOST = '10.20.30.40'
const PLANTED_ID = 'ds-8f3c19'
const PLANTED_EMAIL = 'zhang.wei@factory-a.example.com'

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status })
}

function source(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: PLANTED_ID, name: PLANTED_NAME, type: 'sqlserver', connected: true, ...overrides }
}

describe('BOM备料 第①a 步数据源检测 — 纯投影 (stockPrepDataSourceRegistryFromPayload)', () => {
  // D1 -----------------------------------------------------------------------
  it('counts a SQL Server source as present', () => {
    const result = stockPrepDataSourceRegistryFromPayload({ items: [source()] })
    expect(result.state).toBe('present')
    expect(result.sqlCount).toBe(1)
    expect(result.totalCount).toBe(1)
    expect(result.status).toBeNull()
  })

  it.each(['postgres', 'postgresql', 'sqlserver', 'mysql'])(
    'counts %s — every relational kind a SQL read-only binding can sit on',
    (type) => {
      expect(stockPrepDataSourceRegistryFromPayload({ items: [source({ type })] }).state).toBe('present')
    },
  )

  it.each(['http', 'plm'])(
    'does NOT count %s — it exists, but it cannot back a data-source:sql-readonly binding',
    (type) => {
      const result = stockPrepDataSourceRegistryFromPayload({ items: [source({ type })] })
      expect(result.state).toBe('absent')
      expect(result.sqlCount).toBe(0)
      // ...and it is still COUNTED as a source, so the view can distinguish 「一个源都没有」 from
      // 「有源,但都不是数据库」 rather than reporting an empty machine.
      expect(result.totalCount).toBe(1)
    },
  )

  it('a mixed list counts only the relational half', () => {
    const result = stockPrepDataSourceRegistryFromPayload({
      items: [source({ type: 'http' }), source({ type: 'mysql' }), source({ type: 'postgres' }), source({ type: 'plm' })],
    })
    expect(result.sqlCount).toBe(2)
    expect(result.totalCount).toBe(4)
    expect(result.state).toBe('present')
  })

  it('the type match is case- and whitespace-tolerant, and nothing else', () => {
    expect(stockPrepIsSqlDataSourceType('  SQLServer  ')).toBe(true)
    expect(stockPrepIsSqlDataSourceType('  sqlserver  ')).toBe(true)
    expect(stockPrepIsSqlDataSourceType('SQLSERVER')).toBe(true)
    // Neighbours of a real token do NOT match — a prefix/suffix rule would count `mysql-proxy`.
    expect(stockPrepIsSqlDataSourceType('mysql-proxy')).toBe(false)
    expect(stockPrepIsSqlDataSourceType('not-postgres')).toBe(false)
    expect(stockPrepIsSqlDataSourceType('')).toBe(false)
    expect(stockPrepIsSqlDataSourceType(null)).toBe(false)
    expect(stockPrepIsSqlDataSourceType(42)).toBe(false)
  })

  it('the SQL type list is exactly the four relational kinds — http and plm are deliberately absent', () => {
    expect([...STOCK_PREP_SQL_DATA_SOURCE_TYPES]).toEqual(['postgres', 'postgresql', 'sqlserver', 'mysql'])
    expect(STOCK_PREP_SQL_DATA_SOURCE_TYPES).not.toContain('http')
    expect(STOCK_PREP_SQL_DATA_SOURCE_TYPES).not.toContain('plm')
  })

  // D3 -----------------------------------------------------------------------
  it('an EMPTY list is a real answer (absent), not an unrecognised shape', () => {
    const result = stockPrepDataSourceRegistryFromPayload({ items: [] })
    expect(result.state).toBe('absent')
    expect(result.state).not.toBe('unknown')
    expect(result.totalCount).toBe(0)
  })

  // D2 (shape half) ----------------------------------------------------------
  it.each([
    ['no data at all', null],
    ['a primitive instead of an envelope body', 'nope'],
    ['an object with no items key', { total: 3 }],
    ['items that are not an array', { items: { 'ds-1': true } }],
  ])('an unrecognised shape (%s) is unknown, NOT 「还没登记」', (_label, payload) => {
    const result = stockPrepDataSourceRegistryFromPayload(payload)
    expect(result.state).toBe('unknown')
    expect(result.state).not.toBe('absent')
    expect(result.sqlCount).toBe(0)
  })

  it('entries that are not objects are skipped without poisoning the verdict', () => {
    const result = stockPrepDataSourceRegistryFromPayload({ items: [null, 42, 'ds-1', source()] })
    expect(result.state).toBe('present')
    expect(result.sqlCount).toBe(1)
    expect(result.totalCount).toBe(1)
  })

  it('a row whose type is unreadable is counted as a source but never as a SQL one', () => {
    const result = stockPrepDataSourceRegistryFromPayload({ items: [source({ type: undefined }), source({ type: 99 })] })
    expect(result.totalCount).toBe(2)
    expect(result.sqlCount).toBe(0)
    expect(result.state).toBe('absent')
  })

  // D4 -----------------------------------------------------------------------
  it('a payload stuffed with values projects a state and two integers, and nothing else', () => {
    const serialized = JSON.stringify(stockPrepDataSourceRegistryFromPayload({
      items: [{
        id: PLANTED_ID,
        name: PLANTED_NAME,
        type: 'sqlserver',
        connected: true,
        ownerId: 'u-9',
        ownerEmail: PLANTED_EMAIL,
        connection: { host: PLANTED_HOST, port: 1433, database: 'ProdPLM', user: 'sa' },
      }],
    }))
    for (const planted of [PLANTED_ID, PLANTED_NAME, PLANTED_HOST, PLANTED_EMAIL, 'ProdPLM', '1433', 'sa']) {
      expect(serialized, `planted value must not survive the projection: ${planted}`).not.toContain(planted)
    }
    // The whole of what DOES survive, said positively so the reverse assertion above cannot pass by
    // the projection simply being empty.
    expect(JSON.parse(serialized)).toEqual({ state: 'present', sqlCount: 1, totalCount: 1, status: null })
  })

  it('the unknown constructor carries a status and nothing else', () => {
    expect(stockPrepDataSourceRegistryUnknown(403)).toEqual({ state: 'unknown', sqlCount: 0, totalCount: 0, status: 403 })
    expect(stockPrepDataSourceRegistryUnknown(null).status).toBeNull()
  })
})

describe('BOM备料 第①a 步数据源检测 — 读 (readStockPrepDataSourceRegistry)', () => {
  beforeEach(() => {
    h.apiFetch.mockReset()
  })

  // D5 / D7 ------------------------------------------------------------------
  it('GETs the data-source list, literally, with no query string and no write method', async () => {
    h.apiFetch.mockResolvedValue(envelope({ items: [source()] }))
    await readStockPrepDataSourceRegistry()
    expect(h.apiFetch).toHaveBeenCalledTimes(1)
    const [url, options] = h.apiFetch.mock.calls[0] as [string, Record<string, unknown> | undefined]
    // Asserted against the literal, not against the constant the code under test also uses.
    expect(url).toBe('/api/data-sources')
    expect(STOCK_PREP_DATA_SOURCE_REGISTRY_ROUTE).toBe('/api/data-sources')
    expect(url).not.toContain('?')
    expect(options?.method).toBeUndefined()
    expect(options?.body).toBeUndefined()
    // A background probe must not bounce the caller to the sign-in screen (G3).
    expect(options?.suppressUnauthorizedRedirect).toBe(true)
  })

  it('D6「源预检永不随页面自动跑」: exactly ONE request, and it is the registry list — never a probe', async () => {
    h.apiFetch.mockResolvedValue(envelope({ items: [source()] }))
    await readStockPrepDataSourceRegistry()
    const urls = h.apiFetch.mock.calls.map((call) => String(call[0]))
    expect(urls).toEqual(['/api/data-sources'])
    // The per-source routes that DO reach a customer database must never be called from here.
    for (const url of urls) {
      expect(url).not.toContain('/test')
      expect(url).not.toContain('/schema')
      expect(url).not.toContain('/select')
      expect(url).not.toContain('/preview')
    }
  })

  it('reads the envelope and answers present', async () => {
    h.apiFetch.mockResolvedValue(envelope({ items: [source()], total: 1 }))
    const result = await readStockPrepDataSourceRegistry()
    expect(result.state).toBe('present')
    expect(result.sqlCount).toBe(1)
    expect(result.status).toBeNull()
  })

  // D2 (transport half) ------------------------------------------------------
  it.each([403, 401, 404, 500, 502])('a %s is unknown — never 「还没登记」', async (status) => {
    h.apiFetch.mockResolvedValue(new Response(JSON.stringify({ ok: false, error: { code: 'FORBIDDEN' } }), { status }))
    const result = await readStockPrepDataSourceRegistry()
    expect(result.state).toBe('unknown')
    expect(result.state).not.toBe('absent')
    expect(result.status).toBe(status)
  })

  it('a network failure is unknown, and the promise still resolves (D6)', async () => {
    h.apiFetch.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(readStockPrepDataSourceRegistry()).resolves.toMatchObject({ state: 'unknown', status: null })
  })

  it('a client that answers with nothing at all is unknown, not a crash', async () => {
    h.apiFetch.mockResolvedValue(undefined)
    await expect(readStockPrepDataSourceRegistry()).resolves.toMatchObject({ state: 'unknown' })
  })

  it('a 200 carrying an HTML sign-in page is unknown, not a successful read', async () => {
    h.apiFetch.mockResolvedValue(new Response('<!doctype html><title>Sign in</title>', {
      status: 200, headers: { 'Content-Type': 'text/html' },
    }))
    const result = await readStockPrepDataSourceRegistry()
    expect(result.state).toBe('unknown')
    expect(result.status).toBe(200)
  })

  it('a 200 whose envelope is not ok is unknown', async () => {
    h.apiFetch.mockResolvedValue(new Response(JSON.stringify({ ok: false, data: { items: [source()] } }), { status: 200 }))
    expect((await readStockPrepDataSourceRegistry()).state).toBe('unknown')
  })

  it('a 200 whose data has no items is unknown, not absent', async () => {
    h.apiFetch.mockResolvedValue(envelope({ total: 0 }))
    const result = await readStockPrepDataSourceRegistry()
    expect(result.state).toBe('unknown')
    expect(result.state).not.toBe('absent')
  })

  // D4 over the wire ---------------------------------------------------------
  it('an envelope carrying connection values projects none of them', async () => {
    h.apiFetch.mockResolvedValue(envelope({
      items: [{ id: PLANTED_ID, name: PLANTED_NAME, type: 'sqlserver', connected: true, ownerEmail: PLANTED_EMAIL }],
    }))
    const serialized = JSON.stringify(await readStockPrepDataSourceRegistry())
    expect(serialized).not.toContain(PLANTED_ID)
    expect(serialized).not.toContain(PLANTED_NAME)
    expect(serialized).not.toContain(PLANTED_EMAIL)
  })
})
