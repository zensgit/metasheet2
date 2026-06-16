'use strict'

// C6-1 latent target adapter tests. Locks: target-only shape; no raw read path;
// facade-absent fail-closed; principal forwarded; configured object/fields are
// server-owned; upsert remains disabled until C6 token-bound apply lands.

const assert = require('node:assert/strict')

const {
  ADAPTER_KIND,
  createDataSourceSqlWriteGatedTargetAdapter,
  createDataSourceSqlWriteGatedTargetAdapterFactory,
} = require('../lib/adapters/data-source-sql-write-gated-target-adapter.cjs')

const SYSTEM = {
  kind: ADAPTER_KIND,
  role: 'target',
  config: {
    dataSourceId: 'pg-write-1',
    object: 'public.target_items',
    keyFields: ['externalId'],
    writableFields: ['name', 'status'],
  },
}

function fakeWriteFacade(overrides = {}) {
  const calls = { test: [], getSchema: [], getTableInfo: [], lookupByKey: [], insertRows: [], updateRows: [] }
  const api = {
    async test(id, principal) {
      calls.test.push({ id, principal })
      return overrides.test ? overrides.test(id, principal) : { success: true }
    },
    async getSchema(id, principal, schema) {
      calls.getSchema.push({ id, principal, schema })
      return overrides.getSchema
        ? overrides.getSchema(id, principal, schema)
        : { tables: [{ name: 'target_items', schema: 'public', columns: [] }], views: [] }
    },
    async getTableInfo(id, object, principal, schema) {
      calls.getTableInfo.push({ id, object, principal, schema })
      return overrides.getTableInfo
        ? overrides.getTableInfo(id, object, principal, schema)
        : {
            name: object,
            schema,
            columns: [
              { name: 'externalId', type: 'text', nullable: false },
              { name: 'name', type: 'text', nullable: true },
              { name: 'status', type: 'text', nullable: true },
            ],
          }
    },
    async lookupByKey(id, object, key, policy, principal) {
      calls.lookupByKey.push({ id, object, key, policy, principal })
      return overrides.lookupByKey ? overrides.lookupByKey(id, object, key, policy, principal) : { data: [], metadata: {} }
    },
    async insertRows(id, object, rows, policy, principal) {
      calls.insertRows.push({ id, object, rows, policy, principal })
      return overrides.insertRows ? overrides.insertRows(id, object, rows, policy, principal) : { data: rows, metadata: {} }
    },
    async updateRows(id, object, rows, policy, principal) {
      calls.updateRows.push({ id, object, rows, policy, principal })
      return overrides.updateRows ? overrides.updateRows(id, object, rows, policy, principal) : { rowCount: rows.length, results: [] }
    },
  }
  return { api, calls }
}

function adapterWith(facade, principal = 'owner-1', system = SYSTEM) {
  return createDataSourceSqlWriteGatedTargetAdapter({
    system,
    context: { api: { dataSourceWrites: facade.api } },
    principal,
  })
}

async function main() {
  // 1. Contract shape: target adapter exists, but read/upsert are closed in C6-1.
  {
    const a = adapterWith(fakeWriteFacade())
    for (const method of ['testConnection', 'listObjects', 'getSchema', 'read', 'upsert']) {
      assert.equal(typeof a[method], 'function', `adapter must implement ${method}`)
    }
    await assert.rejects(() => a.read({ object: 'public.target_items' }), /does not support read/)
    await assert.rejects(
      () => a.upsert({ object: 'public.target_items', records: [{ externalId: 'A-1', name: 'Widget' }] }),
      /does not support upsert until C6 token-bound apply is implemented/
    )
  }

  // 2. Required server-owned target config.
  assert.throws(
    () =>
      createDataSourceSqlWriteGatedTargetAdapter({
        system: { kind: ADAPTER_KIND, role: 'target', config: { dataSourceId: 'pg-write-1' } },
        context: { api: { dataSourceWrites: fakeWriteFacade().api } },
        principal: 'owner-1',
      }),
    /config\.object/,
    'configured target object is required'
  )
  assert.throws(
    () =>
      createDataSourceSqlWriteGatedTargetAdapter({
        system: { kind: ADAPTER_KIND, role: 'target', config: { dataSourceId: 'pg-write-1', object: 'public.t', keyFields: [], writableFields: ['name'] } },
        context: { api: { dataSourceWrites: fakeWriteFacade().api } },
        principal: 'owner-1',
      }),
    /config\.keyFields/,
    'configured keyFields are required'
  )

  // 3. Facade-absent guard fails closed legibly.
  {
    const a = createDataSourceSqlWriteGatedTargetAdapter({ system: SYSTEM, context: {}, principal: 'owner-1' })
    await assert.rejects(() => a.testConnection(), /context\.api\.dataSourceWrites/)
    await assert.rejects(() => a.getSchema({ object: 'public.target_items' }), /context\.api\.dataSourceWrites/)
  }

  // 4. Principal forwarded to the host write facade on direct target operations.
  {
    const f = fakeWriteFacade()
    const a = adapterWith(f, 'owner-42')
    await a.testConnection()
    await a.getSchema({ object: 'public.target_items', schema: 'public' })
    assert.deepEqual(f.calls.test[0], { id: 'pg-write-1', principal: 'owner-42' })
    assert.deepEqual(f.calls.getTableInfo[0], {
      id: 'pg-write-1',
      object: 'public.target_items',
      principal: 'owner-42',
      schema: 'public',
    })
  }

  // 5. listObjects is intentionally narrow: it returns only the configured target object.
  {
    const f = fakeWriteFacade()
    const a = adapterWith(f)
    assert.deepEqual(await a.listObjects(), [{
      name: 'public.target_items',
      label: 'public.target_items',
      operations: [],
      schema: [],
    }])
    assert.equal(f.calls.getSchema.length, 0, 'listObjects must not enumerate the full writable schema')
  }

  // 6. Schema object must match the configured server-owned target.
  {
    const f = fakeWriteFacade()
    const a = adapterWith(f)
    await assert.rejects(
      () => a.getSchema({ object: 'public.other_table' }),
      /object must match the configured C6 target object/
    )
    assert.equal(f.calls.getTableInfo.length, 0)
  }

  // 7. Factory threads the principal from the adapter registry deps.
  {
    const f = fakeWriteFacade()
    const factory = createDataSourceSqlWriteGatedTargetAdapterFactory({ context: { api: { dataSourceWrites: f.api } } })
    const a = factory({ system: SYSTEM, principal: 'pipeline-owner' })
    await a.testConnection()
    assert.equal(f.calls.test[0].principal, 'pipeline-owner')
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
