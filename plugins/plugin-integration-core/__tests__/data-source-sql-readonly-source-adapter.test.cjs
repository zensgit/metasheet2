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

  // 5. Read-only-source binding required: a writable source is refused.
  {
    const f = fakeFacade({ test: () => ({ success: true, readOnly: false }) })
    await assert.rejects(() => adapterWith(f).testConnection(), /writable|read-only/i, 'a writable data source binding must be rejected')
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
