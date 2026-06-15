'use strict'

// C1 (data-source:sql-readonly bridge) adapter tests. Plain node test (throws on failure).
// Locks: contract conformance + upsert NotSupported; missing dataSourceId rejected; the
// fail-closed facade-absent guard (legible error, not undefined); principal forwarded to the
// facade on read; read-only-source binding required (writable rejected); offset paging
// (cursor->offset, done on short page, nextCursor on full page); result.data->records and
// result.error surfaced (not swallowed); factory threads the principal.

const assert = require('node:assert/strict')

const {
  ADAPTER_KIND,
  createDataSourceSqlReadonlySourceAdapter,
  createDataSourceSqlReadonlySourceAdapterFactory,
} = require('../lib/adapters/data-source-sql-readonly-source-adapter.cjs')

const SYSTEM = { kind: ADAPTER_KIND, config: { dataSourceId: 'pg-1' } }
const WATERMARK_CURSOR_PREFIX = 'dswm1:'

function decodeWatermarkCursor(cursor) {
  assert.equal(typeof cursor, 'string')
  assert.ok(cursor.startsWith(WATERMARK_CURSOR_PREFIX), 'cursor must be an opaque watermark cursor')
  return JSON.parse(Buffer.from(cursor.slice(WATERMARK_CURSOR_PREFIX.length), 'base64url').toString('utf8'))
}

// A fake host facade that records calls and returns canned data.
function fakeFacade(overrides = {}) {
  const calls = { test: [], getSchema: [], getTableInfo: [], select: [] }
  const api = {
    async test(id, principal) {
      calls.test.push({ id, principal })
      return overrides.test ? overrides.test(id, principal) : { success: true, readOnly: true }
    },
    async getSchema(id, principal, schema) {
      calls.getSchema.push({ id, principal, schema })
      return overrides.getSchema
        ? overrides.getSchema()
        : { tables: [{ name: 'items', schema: 'public', columns: [] }], views: [] }
    },
    async getTableInfo(id, object, principal, schema) {
      calls.getTableInfo.push({ id, object, principal, schema })
      return overrides.getTableInfo ? overrides.getTableInfo() : { columns: [{ name: 'id', type: 'int', nullable: false }] }
    },
    async select(id, table, options, principal) {
      calls.select.push({ id, table, options, principal })
      return overrides.select ? overrides.select(options) : { data: [{ id: 1 }], metadata: {} }
    },
  }
  return { api, calls }
}

function adapterWith(facade, principal = 'owner-1', system = SYSTEM) {
  return createDataSourceSqlReadonlySourceAdapter({
    system,
    context: { api: { dataSources: facade.api } },
    principal,
  })
}

async function main() {
  // 1. Contract conformance + upsert NotSupported (read-only source can never be a write target).
  {
    const a = adapterWith(fakeFacade())
    for (const m of ['testConnection', 'listObjects', 'getSchema', 'read', 'upsert']) {
      assert.equal(typeof a[m], 'function', `adapter must implement ${m}`)
    }
    await assert.rejects(() => a.upsert({ object: 'items', records: [{}] }), /does not support upsert/, 'upsert must be unsupported')
  }

  // 2. Missing config.dataSourceId -> throws at construction.
  assert.throws(
    () =>
      createDataSourceSqlReadonlySourceAdapter({
        system: { kind: ADAPTER_KIND, config: {} },
        context: { api: { dataSources: fakeFacade().api } },
        principal: 'owner-1',
      }),
    /dataSourceId/,
    'missing dataSourceId must throw'
  )

  // 3. Facade-absent guard fails closed with a legible error (not a confusing `undefined`).
  {
    const a = createDataSourceSqlReadonlySourceAdapter({ system: SYSTEM, context: {}, principal: 'owner-1' })
    await assert.rejects(() => a.read({ object: 'items', limit: 5 }), /context\.api\.dataSources/, 'read fails closed without the facade')
    await assert.rejects(() => a.listObjects(), /context\.api\.dataSources/, 'listObjects fails closed without the facade')
    await assert.rejects(() => a.testConnection(), /context\.api\.dataSources/, 'testConnection fails closed without the facade')
  }

  // 4. Principal forwarded to the facade on read (the load-bearing owner seam).
  {
    const f = fakeFacade()
    const a = adapterWith(f, 'owner-42')
    await a.read({ object: 'public.items', limit: 100 })
    assert.equal(f.calls.select.length, 1)
    assert.equal(f.calls.select[0].principal, 'owner-42', 'read must forward the principal to facade.select')
    assert.equal(f.calls.select[0].id, 'pg-1')
    assert.equal(f.calls.select[0].table, 'public.items')
  }

  // 4b. Equality filters are forwarded as `where`, enabling parameterized flat reads for
  //     FileCode / parent-id lookups without raw SQL or full-table local filtering.
  {
    const f = fakeFacade()
    const a = adapterWith(f, 'owner-42')
    await a.read({
      object: 'DN_PDM_PathExAttrInfo',
      limit: 25,
      cursor: '5',
      filters: { FileCode: 'P-001', active: true, optional: null },
    })
    assert.deepEqual(f.calls.select[0].options, {
      limit: 25,
      offset: 5,
      where: { FileCode: 'P-001', active: true, optional: null },
    })
  }

  // 4c. Filters are equality-only primitives. Structured operators/arrays remain out of scope for
  //     the readonly bridge; C2 gets parameterized equality reads, not a generic query surface.
  {
    const f = fakeFacade()
    const a = adapterWith(f)
    await assert.rejects(
      () => a.read({ object: 'items', filters: { FileCode: { $like: 'P%' } } }),
      /equality primitives only/,
      'operator-shaped filter rejected',
    )
    await assert.rejects(
      () => a.read({ object: 'items', filters: { FileCode: ['P-001'] } }),
      /equality primitives only/,
      'array filter rejected',
    )
    assert.equal(f.calls.select.length, 0, 'invalid filters fail before any facade read')
  }

  // 5. Read-only-source guard now lives in the host facade and fires on EVERY read path: a facade
  //    that rejects a writable binding makes read / listObjects / getSchema / testConnection all fail
  //    closed — NOT only when testConnection() runs first (the dry-run/pipeline paths skip it).
  {
    const writableErr = new Error("data source 'pg-1' is writable; the read-only bridge refuses a writable binding")
    const f = fakeFacade({
      test: () => { throw writableErr },
      getSchema: () => { throw writableErr },
      getTableInfo: () => { throw writableErr },
      select: () => { throw writableErr },
    })
    const a = adapterWith(f)
    await assert.rejects(() => a.read({ object: 'items', limit: 5 }), /writable/, 'read fails closed on a writable source')
    await assert.rejects(() => a.listObjects(), /writable/, 'listObjects fails closed on a writable source')
    await assert.rejects(() => a.getSchema({ object: 'items' }), /writable/, 'getSchema fails closed on a writable source')
    await assert.rejects(() => a.testConnection(), /writable/, 'testConnection fails closed on a writable source')
  }

  // 6. Offset paging: cursor->offset, short page => done + null nextCursor.
  {
    const f = fakeFacade({ select: () => ({ data: [{ id: 1 }, { id: 2 }], metadata: {} }) })
    const res = await adapterWith(f).read({ object: 'items', limit: 5, cursor: '10' })
    assert.equal(f.calls.select[0].options.offset, 10, 'cursor must map to offset')
    assert.equal(f.calls.select[0].options.limit, 5)
    assert.deepEqual(res.records, [{ id: 1 }, { id: 2 }])
    assert.equal(res.done, true, 'short page (rows < limit) => done')
    assert.equal(res.nextCursor, null, 'short page => no nextCursor')
  }

  // 7. Offset paging: full page => not done + nextCursor = offset + count.
  {
    const f = fakeFacade({ select: () => ({ data: [{ id: 1 }, { id: 2 }], metadata: {} }) })
    const res = await adapterWith(f).read({ object: 'items', limit: 2, cursor: '4' })
    assert.equal(res.done, false, 'full page => not done')
    assert.equal(res.nextCursor, '6', 'full page => nextCursor = offset + count')
  }

  // 7b. C3 updated_at watermark: the first page seeds from the store timestamp with >=,
  //     orders by (field,tiebreaker), and emits a mode-tagged composite cursor.
  {
    const timestamp = '2026-06-01T01:00:00.000Z'
    const f = fakeFacade({
      select: () => ({
        data: [
          { id: 'A-001', updatedAt: timestamp },
          { id: 'A-002', updatedAt: timestamp },
        ],
        metadata: {},
      }),
    })
    const res = await adapterWith(f).read({
      object: 'items',
      limit: 2,
      watermark: { updatedAt: timestamp },
      watermarkConfig: { type: 'updated_at', field: 'updatedAt', tiebreaker: 'id' },
    })
    assert.deepEqual(f.calls.select[0].options, {
      limit: 2,
      where: { updatedAt: { $gte: timestamp } },
      orderBy: [
        { column: 'updatedAt', direction: 'asc' },
        { column: 'id', direction: 'asc' },
      ],
    })
    assert.equal(res.done, false)
    const cursor = decodeWatermarkCursor(res.nextCursor)
    assert.equal(cursor.mode, 'wm-composite')
    assert.equal(cursor.field, 'updatedAt')
    assert.equal(cursor.tiebreaker, 'id')
    assert.equal(cursor.value, timestamp)
    assert.equal(cursor.tiebreakerValue, 'A-002')
    assert.equal(res.metadata.mode, 'wm-composite')
  }

  // 7c. C3 updated_at watermark: subsequent pages use the in-run composite cursor, so a
  //     same-timestamp batch larger than the page limit advances instead of stalling.
  {
    const timestamp = '2026-06-01T01:00:00.000Z'
    const f = fakeFacade({
      select: (options) => {
        if (!options.where.$or) {
          return {
            data: [
              { id: 'A-001', updatedAt: timestamp },
              { id: 'A-002', updatedAt: timestamp },
            ],
            metadata: {},
          }
        }
        return {
          data: [
            { id: 'A-003', updatedAt: timestamp },
            { id: 'A-004', updatedAt: timestamp },
          ],
          metadata: {},
        }
      },
    })
    const a = adapterWith(f)
    const first = await a.read({
      object: 'items',
      limit: 2,
      watermark: { updatedAt: timestamp },
      watermarkConfig: { type: 'updated_at', field: 'updatedAt', tiebreaker: 'id' },
    })
    const second = await a.read({
      object: 'items',
      limit: 2,
      cursor: first.nextCursor,
      watermark: { updatedAt: timestamp },
      watermarkConfig: { type: 'updated_at', field: 'updatedAt', tiebreaker: 'id' },
    })
    assert.deepEqual(f.calls.select[1].options.where, {
      $or: [
        { updatedAt: { $gt: timestamp } },
        { updatedAt: timestamp, id: { $gt: 'A-002' } },
      ],
    })
    assert.equal(decodeWatermarkCursor(second.nextCursor).tiebreakerValue, 'A-004')
  }

  // 7d. C3 monotonic_id watermark: strict > plus single-key ordering and cursor progress.
  {
    const floor = '9007199254740992'
    const lastId = '9007199254740994'
    const f = fakeFacade({
      select: () => ({
        data: [{ id: '9007199254740993' }, { id: lastId }],
        metadata: {},
      }),
    })
    const res = await adapterWith(f).read({
      object: 'items',
      limit: 2,
      // The runner's watermark store persists values as strings; the adapter normalizes
      // monotonic ids as integer strings, preserving SQL BIGINT precision beyond JS safe ints.
      watermark: { id: floor },
      watermarkConfig: { type: 'monotonic_id', field: 'id' },
    })
    assert.deepEqual(f.calls.select[0].options, {
      limit: 2,
      where: { id: { $gt: floor } },
      orderBy: [{ column: 'id', direction: 'asc' }],
    })
    const cursor = decodeWatermarkCursor(res.nextCursor)
    assert.equal(cursor.mode, 'wm-mono')
    assert.equal(cursor.value, lastId)
  }

  // 7d.1. Unsafe numeric monotonic ids fail closed instead of losing SQL BIGINT precision.
  {
    const f = fakeFacade()
    await assert.rejects(
      () => adapterWith(f).read({
        object: 'items',
        limit: 2,
        watermark: { id: Number.MAX_SAFE_INTEGER + 1 },
        watermarkConfig: { type: 'monotonic_id', field: 'id' },
      }),
      /safe integer or integer string/,
      'unsafe JS number monotonic ids are rejected before rounding',
    )
    assert.equal(f.calls.select.length, 0)
  }

  // 7e. Filters compose with watermark under one structured AND, so C2 equality filters are
  //     not silently dropped when C3 incremental mode is active.
  {
    const f = fakeFacade({
      select: () => ({ data: [{ id: 11, tenant: 'north' }], metadata: {} }),
    })
    await adapterWith(f).read({
      object: 'items',
      limit: 1,
      filters: { tenant: 'north' },
      watermark: { id: 10 },
      watermarkConfig: { type: 'monotonic_id', field: 'id' },
    })
    assert.deepEqual(f.calls.select[0].options.where, {
      $and: [
        { tenant: 'north' },
        { id: { $gt: '10' } },
      ],
    })
  }

  // 7e.1. The same filter composition also holds for updated_at's composite shape.
  {
    const timestamp = '2026-06-01T01:00:00.000Z'
    const f = fakeFacade({
      select: () => ({ data: [{ id: 'A-001', updatedAt: timestamp, tenant: 'north' }], metadata: {} }),
    })
    await adapterWith(f).read({
      object: 'items',
      limit: 10,
      filters: { tenant: 'north' },
      watermark: { updatedAt: timestamp },
      watermarkConfig: { type: 'updated_at', field: 'updatedAt', tiebreaker: 'id' },
    })
    assert.deepEqual(f.calls.select[0].options.where, {
      $and: [
        { tenant: 'north' },
        { updatedAt: { $gte: timestamp } },
      ],
    })
  }

  // 7f. Cursor mode tagging is fail-closed: offset cursors cannot drive watermark reads,
  //     and watermark cursors cannot drive offset reads.
  {
    const f = fakeFacade()
    const a = adapterWith(f)
    await assert.rejects(
      () => a.read({
        object: 'items',
        limit: 2,
        cursor: '6',
        watermark: { id: 10 },
        watermarkConfig: { type: 'monotonic_id', field: 'id' },
      }),
      /watermark cursor/,
      'offset cursor is rejected in watermark mode',
    )
    const wmCursor = `${WATERMARK_CURSOR_PREFIX}${Buffer.from(JSON.stringify({
      v: 1,
      mode: 'wm-mono',
      type: 'monotonic_id',
      field: 'id',
      value: 12,
    }), 'utf8').toString('base64url')}`
    await assert.rejects(
      () => a.read({ object: 'items', limit: 2, cursor: wmCursor }),
      /watermark cursor cannot be used for offset reads/,
      'watermark cursor is rejected in offset mode',
    )
    assert.equal(f.calls.select.length, 0, 'cursor mode mismatch fails before any facade read')
  }

  // 7g. updated_at mode requires the runner-resolved tiebreaker; otherwise it would either
  //     strict-> miss ties or >= stall on a same-timestamp page.
  {
    const f = fakeFacade()
    await assert.rejects(
      () => adapterWith(f).read({
        object: 'items',
        limit: 2,
        watermark: { updatedAt: '2026-06-01T01:00:00.000Z' },
        watermarkConfig: { type: 'updated_at', field: 'updatedAt' },
      }),
      /watermarkConfig\.tiebreaker/,
      'updated_at watermark mode requires a tiebreaker',
    )
    assert.equal(f.calls.select.length, 0)
  }

  // 7h. A full incremental page must expose the ordered cursor key on the last record, otherwise
  //     the adapter cannot advance safely and must fail instead of looping.
  {
    const f = fakeFacade({
      select: () => ({ data: [{ id: 11 }, { noId: true }], metadata: {} }),
    })
    await assert.rejects(
      () => adapterWith(f).read({
        object: 'items',
        limit: 2,
        watermark: { id: 10 },
        watermarkConfig: { type: 'monotonic_id', field: 'id' },
      }),
      /record\.id/,
      'missing cursor key on a full page fails closed',
    )
  }

  // 8. read surfaces a facade select error (fail-closed; never a silent empty page).
  {
    const f = fakeFacade({ select: () => ({ data: [], error: new Error('boom') }) })
    await assert.rejects(() => adapterWith(f).read({ object: 'items', limit: 5 }), /boom/, 'a facade select error must surface')
  }

  // 9. listObjects maps tables + views; getSchema(object) maps columns.
  {
    const f = fakeFacade({
      getSchema: () => ({ tables: [{ name: 't', schema: 'public', columns: [] }], views: [{ name: 'v', columns: [] }] }),
    })
    const a = adapterWith(f)
    const objs = await a.listObjects()
    assert.equal(objs.length, 2)
    assert.equal(objs[0].name, 'public.t')
    assert.equal(objs[0].kind, 'table')
    assert.equal(objs[1].name, 'v')
    assert.equal(objs[1].kind, 'view')
    const schema = await a.getSchema({ object: 'public.t' })
    assert.equal(schema.object, 'public.t')
    assert.deepEqual(schema.fields, [{ name: 'id', type: 'int', nullable: false }])
    // A schema-qualified object is split back into table + schema for getTableInfo (the entity-machine
    // follow-up: getTableInfo/getSchema want bare table + separate schema; read/select take schema.table).
    assert.equal(f.calls.getTableInfo[0].object, 't', 'getSchema splits schema.table → bare table for getTableInfo')
    assert.equal(f.calls.getTableInfo[0].schema, 'public', 'getSchema passes the qualified schema to getTableInfo')
  }

  // 9b. A bare object passes through unsplit (uses config.schema, here unset → undefined).
  {
    const f = fakeFacade()
    await adapterWith(f).getSchema({ object: 'items' })
    assert.equal(f.calls.getTableInfo[0].object, 'items', 'bare object → table only')
    assert.equal(f.calls.getTableInfo[0].schema, undefined, 'bare object → no schema split')
  }

  // 10. The factory threads the principal through to the adapter.
  {
    const f = fakeFacade()
    const factory = createDataSourceSqlReadonlySourceAdapterFactory({ context: { api: { dataSources: f.api } } })
    await factory({ system: SYSTEM, principal: 'owner-9' }).read({ object: 'items', limit: 3 })
    assert.equal(f.calls.select[0].principal, 'owner-9', 'factory must thread the principal to the adapter')
  }

  console.log('data-source-sql-readonly-source-adapter.test.cjs: all assertions passed')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
