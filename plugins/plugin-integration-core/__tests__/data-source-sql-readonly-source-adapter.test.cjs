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
const { dryRunExternalWrite } = require('../lib/external-write-dry-run.cjs')

const SYSTEM = { kind: ADAPTER_KIND, config: { dataSourceId: 'pg-1' } }
const LOOKUP_SYSTEM = {
  kind: ADAPTER_KIND,
  config: {
    dataSourceId: 'pg-1',
    lookupProjection: {
      baseObject: 'dbo.bom_detail',
      lookupObject: 'dbo.part_library',
      localKey: 'part_id',
      foreignKey: 'OBJ_ID',
      fields: {
        FNumber: 'IdentityNo',
        FName: 'IdentityName',
      },
      maxRows: 3,
    },
  },
}
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
      return overrides.select ? overrides.select(options, { id, table, principal }) : { data: [{ id: 1 }], metadata: {} }
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

  // 4d. A system-bound lookup projection enriches at most three base rows through exact, read-only
  //     per-row lookups. The request supplies only the base object/filter/limit; table and field
  //     identifiers come exclusively from the persisted system config.
  {
    const f = fakeFacade({
      select: (options, call) => {
        if (call.table === 'dbo.bom_detail') {
          return {
            data: [
              { id: 1, part_id: 'part-1', status: 'ready' },
              { id: 2, part_id: 'part-2', status: 'ready' },
            ],
            metadata: {},
          }
        }
        assert.equal(call.table, 'dbo.part_library')
        const key = options.where.OBJ_ID
        return {
          data: [{
            IdentityNo: key === 'part-1' ? 'M-001' : 'M-002',
            IdentityName: key === 'part-1' ? 'Material One' : 'Material Two',
          }],
          metadata: {},
        }
      },
    })
    const res = await adapterWith(f, 'owner-42', LOOKUP_SYSTEM).read({
      object: 'dbo.bom_detail',
      limit: 3,
      filters: { status: 'ready' },
    })
    assert.deepEqual(res.records, [
      { id: 1, part_id: 'part-1', status: 'ready', FNumber: 'M-001', FName: 'Material One' },
      { id: 2, part_id: 'part-2', status: 'ready', FNumber: 'M-002', FName: 'Material Two' },
    ])
    assert.equal(res.done, true)
    assert.equal(res.metadata.lookupProjectionApplied, true)
    assert.equal(res.metadata.lookupProjectionRows, 2)
    assert.equal(f.calls.select.length, 3, 'one base read plus one lookup per base row')
    assert.deepEqual(f.calls.select[0], {
      id: 'pg-1',
      table: 'dbo.bom_detail',
      options: { limit: 3, offset: 0, where: { status: 'ready' } },
      principal: 'owner-42',
    })
    assert.deepEqual(f.calls.select[1].options, {
      limit: 2,
      offset: 0,
      where: { OBJ_ID: 'part-1' },
    })
    assert.deepEqual(f.calls.select[2].options, {
      limit: 2,
      offset: 0,
      where: { OBJ_ID: 'part-2' },
    })
  }

  // 4e. Projection configuration is strict and fails at construction: no arbitrary SQL-shaped
  //     object names, unknown fields, or a row bound above three can reach the facade.
  {
    for (const lookupProjection of [
      { ...LOOKUP_SYSTEM.config.lookupProjection, lookupObject: 'dbo.parts;DROP_TABLE' },
      { ...LOOKUP_SYSTEM.config.lookupProjection, localKey: '__proto__' },
      { ...LOOKUP_SYSTEM.config.lookupProjection, foreignKey: 'constructor' },
      { ...LOOKUP_SYSTEM.config.lookupProjection, arbitrarySql: 'SELECT 1' },
      { ...LOOKUP_SYSTEM.config.lookupProjection, maxRows: 4 },
      { ...LOOKUP_SYSTEM.config.lookupProjection, maxRows: '3' },
      {
        ...LOOKUP_SYSTEM.config.lookupProjection,
        fields: { FNumber: 'IdentityNo', FName: 'IdentityName', extra: 'secret' },
      },
    ]) {
      const f = fakeFacade()
      assert.throws(
        () => adapterWith(f, 'owner-42', {
          kind: ADAPTER_KIND,
          config: { dataSourceId: 'pg-1', lookupProjection },
        }),
        /lookupProjection/,
      )
      assert.equal(f.calls.select.length, 0)
    }
  }

  // 4f. The projection is bound to one base object and its saved row cap. Mismatch, over-limit,
  //     and watermark modes fail before source contact.
  {
    const f = fakeFacade()
    const a = adapterWith(f, 'owner-42', LOOKUP_SYSTEM)
    await assert.rejects(
      () => a.read({ object: 'dbo.other_table', limit: 3 }),
      /bound to a different source object/,
    )
    await assert.rejects(
      () => a.read({ object: 'dbo.bom_detail', limit: 4 }),
      /server-bound maximum/,
    )
    await assert.rejects(
      () => a.read({
        object: 'dbo.bom_detail',
        limit: 3,
        watermark: { id: 1 },
        watermarkConfig: { type: 'monotonic_id', field: 'id' },
      }),
      /does not support watermark/,
    )
    assert.equal(f.calls.select.length, 0)
  }

  // 4g. A request cannot inject or override lookup identifiers, including through request.options.
  //     Unknown request fields are normalized away; only the system-bound lookup is contacted.
  {
    const f = fakeFacade({
      select: (options, call) => call.table === 'dbo.bom_detail'
        ? { data: [{ id: 1, part_id: 'part-1' }], metadata: {} }
        : { data: [{ IdentityNo: 'M-001', IdentityName: 'Material One' }], metadata: {} },
    })
    await adapterWith(f, 'owner-42', LOOKUP_SYSTEM).read({
      object: 'dbo.bom_detail',
      limit: 3,
      lookupProjection: { lookupObject: 'dbo.request_injected' },
      options: { lookupProjection: { lookupObject: 'dbo.options_injected' } },
    })
    assert.deepEqual(f.calls.select.map((call) => call.table), ['dbo.bom_detail', 'dbo.part_library'])
  }

  // 4h. Missing base keys and output alias collisions stop after the base read and before lookup.
  {
    for (const baseRow of [
      { id: 1, part_id: '' },
      { id: 1, part_id: true },
      { id: 1, part_id: 'part-1', FNumber: 'collision' },
    ]) {
      const f = fakeFacade({ select: () => ({ data: [baseRow], metadata: {} }) })
      await assert.rejects(
        () => adapterWith(f, 'owner-42', LOOKUP_SYSTEM).read({ object: 'dbo.bom_detail', limit: 3 }),
        /lookup projection/,
      )
      assert.equal(f.calls.select.length, 1, 'invalid base row must not trigger lookup')
    }
  }

  // 4i. Zero/multiple lookup rows, invalid projected fields, and driver failures all fail closed.
  //     Driver text and row values are not carried into the surfaced error.
  {
    const cases = [
      { lookupResult: { data: [], metadata: {} }, expected: /exactly one row/ },
      {
        lookupResult: {
          data: [
            { IdentityNo: 'M-001', IdentityName: 'Material One' },
            { IdentityNo: 'M-001-DUP', IdentityName: 'Material One Duplicate' },
          ],
          metadata: {},
        },
        expected: /exactly one row/,
      },
      {
        lookupResult: { data: [{ IdentityNo: 'M-001', IdentityName: ' ' }], metadata: {} },
        expected: /required field/,
      },
      {
        lookupResult: { data: [{ IdentityNo: 1001, IdentityName: 'Material One' }], metadata: {} },
        expected: /required field/,
      },
      {
        lookupResult: { data: [{ IdentityNo: 'M-001', IdentityName: false }], metadata: {} },
        expected: /required field/,
      },
      {
        lookupResult: { data: [], error: new Error('SENSITIVE_DRIVER_TEXT') },
        expected: /lookup projection read failed/,
      },
    ]
    for (const testCase of cases) {
      const f = fakeFacade({
        select: (options, call) => call.table === 'dbo.bom_detail'
          ? { data: [{ id: 1, part_id: 'SENSITIVE_KEY_VALUE' }], metadata: {} }
          : testCase.lookupResult,
      })
      let observed
      try {
        await adapterWith(f, 'owner-42', LOOKUP_SYSTEM).read({ object: 'dbo.bom_detail', limit: 3 })
      } catch (error) {
        observed = error
      }
      assert.ok(observed, 'invalid lookup must throw')
      assert.match(observed.message, testCase.expected)
      const publicError = JSON.stringify({ message: observed.message, details: observed.details })
      assert.ok(!publicError.includes('SENSITIVE_KEY_VALUE'))
      assert.ok(!publicError.includes('SENSITIVE_DRIVER_TEXT'))
    }
  }

  // 4j. Base-read driver errors are also coarse whenever projection mode is enabled.
  {
    const f = fakeFacade({
      select: () => ({ data: [], error: new Error('SENSITIVE_FILTER_OR_DRIVER_TEXT') }),
    })
    let observed
    try {
      await adapterWith(f, 'owner-42', LOOKUP_SYSTEM).read({ object: 'dbo.bom_detail', limit: 3 })
    } catch (error) {
      observed = error
    }
    assert.match(observed.message, /lookup projection base read failed/)
    assert.ok(!observed.message.includes('SENSITIVE_FILTER_OR_DRIVER_TEXT'))
  }

  // 4j.1. The bounded join must be one-to-one across the whole base page: duplicate local keys or
  //        duplicate projected material codes are ambiguous even when each individual lookup
  //        returns exactly one row.
  {
    const duplicateLocalFacade = fakeFacade({
      select: (options, call) => call.table === 'dbo.bom_detail'
        ? {
            data: [
              { id: 1, part_id: 'duplicate-part' },
              { id: 2, part_id: 'duplicate-part' },
            ],
            metadata: {},
          }
        : { data: [{ IdentityNo: 'M-001', IdentityName: 'Material One' }], metadata: {} },
    })
    await assert.rejects(
      () => adapterWith(duplicateLocalFacade, 'owner-42', LOOKUP_SYSTEM).read({
        object: 'dbo.bom_detail',
        limit: 3,
      }),
      /base keys must be unique/,
    )
    assert.equal(duplicateLocalFacade.calls.select.length, 2, 'duplicate second key stops before its lookup')

    const duplicateCodeFacade = fakeFacade({
      select: (options, call) => call.table === 'dbo.bom_detail'
        ? {
            data: [
              { id: 1, part_id: 'part-1' },
              { id: 2, part_id: 'part-2' },
            ],
            metadata: {},
          }
        : {
            data: [{
              IdentityNo: options.where.OBJ_ID === 'part-1'
                ? 'Duplicate-Material-Code'
                : ' duplicate-material-code ',
              IdentityName: 'Material Name',
            }],
            metadata: {},
          },
    })
    await assert.rejects(
      () => adapterWith(duplicateCodeFacade, 'owner-42', LOOKUP_SYSTEM).read({
        object: 'dbo.bom_detail',
        limit: 3,
      }),
      /material codes must be unique/,
    )
    assert.equal(duplicateCodeFacade.calls.select.length, 3)
  }

  // 4j.2. The facade is also treated as untrusted for row-count enforcement. Returning more base
  //        rows than requested fails before any per-row lookup.
  {
    const f = fakeFacade({
      select: () => ({
        data: [
          { id: 1, part_id: 'part-1' },
          { id: 2, part_id: 'part-2' },
          { id: 3, part_id: 'part-3' },
        ],
        metadata: {},
      }),
    })
    await assert.rejects(
      () => adapterWith(f, 'owner-42', LOOKUP_SYSTEM).read({ object: 'dbo.bom_detail', limit: 2 }),
      /exceeded the server-bound row limit/,
    )
    assert.equal(f.calls.select.length, 1)
  }

  // 4k. Real C6 dry-run composition: the persisted source system constructs this adapter, the
  //     persisted equality filter selects two base rows, projection supplies FNumber/FName, and
  //     planning reaches add=2 without invoking either target write method.
  {
    const sourceFacade = fakeFacade({
      select: (options, call) => {
        if (call.table === 'dbo.bom_detail') {
          assert.deepEqual(options.where, { approvedSlice: 'fixture' })
          return {
            data: [
              { id: 1, part_id: 'C6-PRIVATE-PART-1' },
              { id: 2, part_id: 'C6-PRIVATE-PART-2' },
            ],
            metadata: {},
          }
        }
        const suffix = options.where.OBJ_ID.endsWith('1') ? '1' : '2'
        return {
          data: [{ IdentityNo: `C6-PRIVATE-CODE-${suffix}`, IdentityName: `C6-PRIVATE-NAME-${suffix}` }],
          metadata: {},
        }
      },
    })
    const sourceAdapter = adapterWith(sourceFacade, 'owner-42', LOOKUP_SYSTEM)
    const targetCalls = { test: 0, lookup: 0, insert: 0, update: 0 }
    const tokenRecords = new Map()
    const result = await dryRunExternalWrite({
      pipeline: {
        id: 'pipe_lookup_projection_c6',
        tenantId: 'tenant-test',
        workspaceId: 'workspace-test',
        sourceSystemId: 'source-lookup-projection',
        sourceObject: 'dbo.bom_detail',
        targetSystemId: 'target-c6',
        targetObject: 'material',
        createdBy: 'owner-42',
        options: { source: { filters: { approvedSlice: 'fixture' } } },
        fieldMappings: [
          { sourceField: 'FNumber', targetField: 'externalId', validation: [{ type: 'required' }] },
          { sourceField: 'FName', targetField: 'name', validation: [{ type: 'required' }] },
        ],
      },
      sourceSystem: { id: 'source-lookup-projection', ...LOOKUP_SYSTEM },
      targetSystem: {
        id: 'target-c6',
        kind: 'data-source:sql-write-gated',
        config: {
          dataSourceId: 'target-data-source',
          object: 'dbo.material',
          keyFields: ['externalId'],
          writableFields: ['name'],
        },
      },
      sourceAdapter,
      dataSourceWrites: {
        async test() {
          targetCalls.test += 1
          return {
            success: true,
            capabilityState: { readOnly: false, c6WriteTarget: true, genericQueryDisabled: true },
          }
        },
        async lookupByKey() {
          targetCalls.lookup += 1
          return { data: [], metadata: {} }
        },
        async insertRows() {
          targetCalls.insert += 1
          throw new Error('dry-run must not insert')
        },
        async updateRows() {
          targetCalls.update += 1
          throw new Error('dry-run must not update')
        },
      },
      tokenStore: {
        async get(key) { return tokenRecords.get(key) || null },
        async set(key, value) { tokenRecords.set(key, value) },
      },
      dryRunUser: 'reviewer-1',
      dataSourceOwnerPrincipal: 'owner-42',
      maxRows: 3,
    })
    assert.equal(result.status, 'ready')
    assert.equal(result.canApply, true)
    assert.deepEqual(result.counts, {
      sourceRows: 2,
      planned: 2,
      add: 2,
      update: 0,
      skip: 0,
      held: 0,
      failed: 0,
    })
    assert.deepEqual(targetCalls, { test: 1, lookup: 2, insert: 0, update: 0 })
    assert.equal(sourceFacade.calls.select.length, 3)
    assert.equal(tokenRecords.size, 1)
    const publicText = JSON.stringify(result)
    for (const privateValue of [
      'C6-PRIVATE-PART-1',
      'C6-PRIVATE-PART-2',
      'C6-PRIVATE-CODE-1',
      'C6-PRIVATE-CODE-2',
      'C6-PRIVATE-NAME-1',
      'C6-PRIVATE-NAME-2',
    ]) {
      assert.equal(publicText.includes(privateValue), false, 'C6 dry-run result stays values-free')
    }
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

  // 11. W-5: two fail-closed floors for ARMED B2a reads over SQL Server, both scoped to
  //     `b2aAuthorization` being present (threaded per-call via the factory's `deps`, never off
  //     `context`) — see http-routes.cjs's stock-preparation table-action/MVP-persist/large-BOM
  //     entry points and b2a-trial-registry.cjs for the fixed code + refusal shape.
  {
    // A facade fake that records the 5th `select` argument (`armed`) explicitly — the shared
    // `fakeFacade` above deliberately does NOT record it, so every one of its existing pinned
    // `calls.select[i]` shape assertions stays byte-identical.
    function armedAwareFakeFacade(overrides = {}) {
      const calls = { select: [] }
      const api = {
        async test() { return { success: true } },
        async getSchema() { return { tables: [], views: [] } },
        async getTableInfo() { return { columns: [] } },
        async select(id, table, options, principal, armed) {
          calls.select.push({ id, table, options, principal, armed })
          if (overrides.select) return overrides.select({ id, table, options, principal, armed })
          return { data: [{ id: 1 }], metadata: {} }
        },
      }
      return { api, calls }
    }
    const AUTHORIZATION = { registryId: 'reg', registryVersion: 1, registrationId: 'trial-1', purpose: 'stock-preparation.table-action' }

    // 11a. Dormant/unauthorized (b2aAuthorization omitted): `armed` reaches the facade as `false` —
    //      never `undefined`, so a facade that switches on truthiness sees a stable value — and
    //      NOTHING about the call otherwise differs from before this change.
    {
      const f = armedAwareFakeFacade()
      await adapterWith(f).read({ object: 'items', limit: 5 })
      assert.equal(f.calls.select[0].armed, false, 'dormant read passes armed=false, never undefined')
    }

    // 11b. Armed + authorized: `armed=true` reaches the facade.
    {
      const f = armedAwareFakeFacade()
      const a = createDataSourceSqlReadonlySourceAdapter({
        system: SYSTEM, context: { api: { dataSources: f.api } }, principal: 'owner-1', b2aAuthorization: AUTHORIZATION,
      })
      await a.read({ object: 'items', limit: 5 })
      assert.equal(f.calls.select[0].armed, true, 'an armed, authorized read passes armed=true')
    }

    // 11c. Floor 1: the facade's generic pre-connect refusal (DATA_SOURCE_REQUEST_TIMEOUT_DISABLED)
    //      is caught and re-thrown as the FIXED B2a code, carrying only values-free evidence.
    {
      const facadeError = Object.assign(
        new Error("data source 'pg-1' has connection.requestTimeoutMs=0 (no timeout); this read requires a bounded request timeout and refuses to connect"),
        { code: 'DATA_SOURCE_REQUEST_TIMEOUT_DISABLED', status: 422, name: 'DataSourceRequestTimeoutDisabledError' },
      )
      const f = armedAwareFakeFacade({
        select: () => { throw facadeError },
      })
      const a = createDataSourceSqlReadonlySourceAdapter({
        system: SYSTEM, context: { api: { dataSources: f.api } }, principal: 'owner-1', b2aAuthorization: AUTHORIZATION,
      })
      let caught
      try {
        await a.read({ object: 'items', limit: 5 })
      } catch (error) {
        caught = error
      }
      assert.ok(caught, 'floor 1 must refuse')
      assert.notEqual(caught, facadeError, 'the core-backend generic error is MAPPED, not passed through verbatim')
      assert.equal(caught.name, 'B2aReadAuthorizationError')
      assert.equal(caught.status, 403)
      assert.equal(caught.code, 'B2A_SOURCE_TIMEOUT_DISABLED_REJECTED')
      assert.equal(caught.details.reason, 'sqlserver_request_timeout_disabled')
      assert.deepEqual(caught.details, {
        reason: 'sqlserver_request_timeout_disabled',
        registryId: 'reg',
        registryVersion: 1,
        registrationId: 'trial-1',
        purpose: 'stock-preparation.table-action',
      })
    }

    // 11c-dormant: the SAME facade error, but WITHOUT b2aAuthorization, propagates completely
    // unmapped — the floor is a strict no-op on a dormant/unauthorized read.
    {
      const facadeError = Object.assign(new Error('boom'), { code: 'DATA_SOURCE_REQUEST_TIMEOUT_DISABLED' })
      const f = armedAwareFakeFacade({ select: () => { throw facadeError } })
      let caught
      try {
        await adapterWith(f).read({ object: 'items', limit: 5 })
      } catch (error) {
        caught = error
      }
      assert.equal(caught, facadeError, 'dormant: the facade error propagates verbatim, never mapped')
    }

    // 11d. Floor 2: #5243's own bare Error (no `.code`, unchanged message) propagates UNMAPPED —
    //      "reuse the existing error, do not invent a parallel code" means this adapter does nothing
    //      special with it at all.
    {
      const strictError = new Error(
        'Offset pagination without an explicit orderBy is refused for data source "s" ' +
        '(connection.strictOffsetOrdering=true): SQL Server OFFSET/FETCH cannot guarantee stable row ' +
        'order across pages without a real ORDER BY key, so a multi-page read could duplicate or skip ' +
        'rows. Pass options.orderBy on this select, or unset connection.strictOffsetOrdering to accept ' +
        'that risk.'
      )
      const f = armedAwareFakeFacade({ select: () => { throw strictError } })
      const a = createDataSourceSqlReadonlySourceAdapter({
        system: SYSTEM, context: { api: { dataSources: f.api } }, principal: 'owner-1', b2aAuthorization: AUTHORIZATION,
      })
      let caught
      try {
        await a.read({ object: 'items', limit: 10, cursor: '20' })
      } catch (error) {
        caught = error
      }
      assert.equal(caught, strictError, 'floor 2 never wraps or re-throws — the underlying #5243 error passes through as-is')
      assert.equal(f.calls.select[0].armed, true, 'the offset>0, no-orderBy page was requested under armed=true')
      assert.equal(f.calls.select[0].options.offset, 20)
      assert.equal('orderBy' in f.calls.select[0].options, false, 'no orderBy on a non-watermark page — this is exactly what forces the floor')
    }

    // 11e. Floor 1 takes precedence over the lookup-projection catch-all (an operator needs the
    //      actionable message, not a generic "lookup projection base read failed").
    {
      const facadeError = Object.assign(new Error('timeout disabled'), { code: 'DATA_SOURCE_REQUEST_TIMEOUT_DISABLED' })
      const f = armedAwareFakeFacade({ select: () => { throw facadeError } })
      const a = createDataSourceSqlReadonlySourceAdapter({
        system: LOOKUP_SYSTEM, context: { api: { dataSources: f.api } }, principal: 'owner-1', b2aAuthorization: AUTHORIZATION,
      })
      await assert.rejects(
        () => a.read({ object: 'dbo.bom_detail', limit: 3 }),
        /B2A_SOURCE_TIMEOUT_DISABLED_REJECTED|requestTimeoutMs/,
      )
      let caught
      try {
        await a.read({ object: 'dbo.bom_detail', limit: 3 })
      } catch (error) {
        caught = error
      }
      assert.equal(caught.code, 'B2A_SOURCE_TIMEOUT_DISABLED_REJECTED', 'floor 1 wins over the lookup-projection generic message')
    }

    // 11f. The factory threads b2aAuthorization the SAME way it threads principal (per-call `deps`,
    //      never read off `context`).
    {
      const f = armedAwareFakeFacade()
      const factory = createDataSourceSqlReadonlySourceAdapterFactory({ context: { api: { dataSources: f.api } } })
      await factory({ system: SYSTEM, principal: 'owner-9', b2aAuthorization: AUTHORIZATION }).read({ object: 'items', limit: 3 })
      assert.equal(f.calls.select[0].armed, true, 'the factory must thread b2aAuthorization to the adapter')
      const f2 = armedAwareFakeFacade()
      const factory2 = createDataSourceSqlReadonlySourceAdapterFactory({ context: { api: { dataSources: f2.api } } })
      await factory2({ system: SYSTEM, principal: 'owner-9' }).read({ object: 'items', limit: 3 })
      assert.equal(f2.calls.select[0].armed, false, 'omitting b2aAuthorization is dormant, byte-identical to before this dep existed')
    }

    // 11g. H-2 (counter-review finding 2): W-5 armed its two floors on the BASE select but NOT on the
    //      per-page LOOKUP select, so the lookup table's read ran with them silently off. The lookup
    //      select now receives the SAME armed flag, and floor 1 (requestTimeoutMs=0) is mapped on the
    //      lookup leg too. Adversarial: the BASE read succeeds, and the LOOKUP table would trip floor 1
    //      ONLY when the armed flag reaches it — so pre-fix (5th arg missing) the lookup PROCEEDED and
    //      the whole read succeeded, the evasion; post-fix it is refused with the fixed B2a code.
    {
      const facadeError = Object.assign(new Error('lookup timeout disabled'), { code: 'DATA_SOURCE_REQUEST_TIMEOUT_DISABLED' })
      const f = armedAwareFakeFacade({
        select: ({ table, armed }) => {
          if (table === 'dbo.bom_detail') return { data: [{ id: 1, part_id: 'part-1' }], metadata: {} }
          // The lookup table (dbo.part_library): floor 1 fires ONLY when armed reaches it. Unarmed —
          // the pre-fix bug — it proceeds and returns a row, so the whole read would succeed.
          if (armed) throw facadeError
          return { data: [{ IdentityNo: 'M-001', IdentityName: 'Material One' }], metadata: {} }
        },
      })
      const a = createDataSourceSqlReadonlySourceAdapter({
        system: LOOKUP_SYSTEM, context: { api: { dataSources: f.api } }, principal: 'owner-1', b2aAuthorization: AUTHORIZATION,
      })
      let caught
      try {
        await a.read({ object: 'dbo.bom_detail', limit: 3 })
      } catch (error) {
        caught = error
      }
      assert.ok(caught, 'H-2: an armed read whose lookup source has requestTimeoutMs=0 must be refused on the lookup leg')
      assert.equal(caught.name, 'B2aReadAuthorizationError', 'H-2: the lookup floor-1 refusal is the mapped B2a error')
      assert.equal(caught.code, 'B2A_SOURCE_TIMEOUT_DISABLED_REJECTED',
        'H-2: floor 1 is mapped on the LOOKUP leg, not swallowed as a generic lookup failure')
      assert.equal(caught.details.reason, 'sqlserver_request_timeout_disabled')
      // The threading itself: the base read (call 0) and the lookup read (call 1) both carry armed=true.
      assert.equal(f.calls.select[0].armed, true, 'H-2: the base select is armed (as before)')
      assert.equal(f.calls.select[1].table, 'dbo.part_library', 'H-2: the second call is the lookup table')
      assert.equal(f.calls.select[1].armed, true, 'H-2: the lookup select now receives the armed flag too')

      // DORMANT CONTROL: the SAME facade, no b2aAuthorization -> the lookup select is unarmed, floor 1
      // is a no-op, and the read completes exactly as it did before this change.
      const dormant = armedAwareFakeFacade({
        select: ({ table, armed }) => {
          if (table === 'dbo.bom_detail') return { data: [{ id: 1, part_id: 'part-1' }], metadata: {} }
          if (armed) throw facadeError
          return { data: [{ IdentityNo: 'M-001', IdentityName: 'Material One' }], metadata: {} }
        },
      })
      const dormantRes = await adapterWith(dormant, 'owner-1', LOOKUP_SYSTEM).read({ object: 'dbo.bom_detail', limit: 3 })
      assert.deepEqual(dormantRes.records, [{ id: 1, part_id: 'part-1', FNumber: 'M-001', FName: 'Material One' }])
      assert.equal(dormant.calls.select[1].armed, false, 'H-2 dormant: the lookup select is unarmed, byte-identical to before')
    }
  }

  console.log('data-source-sql-readonly-source-adapter.test.cjs: all assertions passed')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
