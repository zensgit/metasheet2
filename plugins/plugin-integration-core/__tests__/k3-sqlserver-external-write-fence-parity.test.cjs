'use strict'

// E4-S ACCEPTANCE SUITE — `erp:k3-wise-sqlserver` reaches PARITY with the WebAPI kind's permanent
// fence (HG v1.2 §10, extended 20260901).
//
// WHY THIS SUITE EXISTS. G-4 / E4 bans "K3 external write-back". The fence that enforces it keyed
// on ONE connector kind, `erp:k3-wise-webapi`. The SIBLING kind `erp:k3-wise-sqlserver` — a second,
// disjoint transport into the SAME customer K3 — sat outside it. Its own guard was materially
// weaker AND config-bypassable: `assertNoDirectK3Write` required `writeMode === 'middle-table'`,
// but an object config carrying `allowDirectTableWrite: true` returned early and authorised a
// direct write into a live K3 business table. What actually kept the kind shut in production was
// the DEFAULT injection of a read-only query executor at plugin activation.
//
// A doctrine held by a default is not a fence. Swap the executor — a documented, invited move; the
// read-only one's own refusal message says "inject a deployment-owned middle-table executor for
// writes" — and a K3 write re-opened without one character of the fence changing. This suite pins
// the fix: the ban now has TWO subjects, refused with the SAME closed token at the same depth.
//
// One test per acceptance row, named E4S-01..E4S-08 so a verification MD maps 1:1:
//
//   E4S-01  Apply HTTP route          refused on the credential-STRIPPED peek; credential reload /
//                                     token consume / source read / adapter construction all ZERO
//   E4S-02  applyExternalWrite        refused before token consumption and before the planner
//   E4S-03  channel `upsert`          refused unconditionally — INCLUDING under the historic
//                                     `allowDirectTableWrite: true` bypass; executor calls ZERO
//   E4S-04  the EXECUTOR SEAM         a WRITE-CAPABLE injected executor's `insertMany` is refused,
//                                     driven directly so the layer is witnessed ALONE
//   E4S-05  pipeline runner           the plain-run seam that reaches the one kind-generic
//                                     `targetAdapter.upsert(...)` refuses at target resolution
//   E4S-06  READ-ONLY regression      reads, listObjects, getSchema and testConnection all still
//                                     work THROUGH a write-capable executor; insertMany ZERO
//   E4S-07  READ-FAILURE regression   an injected READ failure keeps its own read-side code and
//                                     never surfaces the write-fence code
//   E4S-08  BYPASS ATTEMPT            every plausible enabling flag — environment, system config,
//                                     object config, request options — set at once; still refused
//
// The layers are INDEPENDENT. E4S-03 and E4S-04 drive their own entry points directly, so removing
// either one alone turns exactly that test red while the other still holds `insertMany = 0`. That
// is what the guard-removal drills in the PR body record.
//
// VALUES-FREE: every assertion is a closed code, a count, or a fixed structural identifier.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const { registerIntegrationRoutes } = require(path.join(LIB, 'http-routes.cjs'))
const { applyExternalWrite } = require(path.join(LIB, 'external-write-dry-run.cjs'))
const { createPipelineRunner } = require(path.join(LIB, 'pipeline-runner.cjs'))
const {
  createK3WiseSqlServerChannel,
  K3_WISE_SQLSERVER_ADAPTER_METADATA,
  __internals: SQLSERVER_INTERNALS,
} = require(path.join(LIB, 'adapters', 'k3-wise-sqlserver-channel.cjs'))
const { createK3WiseSqlServerReadOnlyExecutor } = require(path.join(LIB, 'adapters', 'k3-wise-sqlserver-executor.cjs'))
const fence = require(path.join(LIB, 'k3-external-write-permanent-fence.cjs'))

const TENANT_ID = 'tenant_1'
const WORKSPACE_ID = 'workspace_1'

// Both literals are spelled out rather than taken from the import, so a rename in production must
// be a visible, reviewable edit HERE and cannot silently re-point every expectation in the file.
const SQL_KIND = 'erp:k3-wise-sqlserver'
const WEBAPI_KIND = 'erp:k3-wise-webapi'
const FIXED_CODE = 'K3_WISE_EXTERNAL_WRITE_DISABLED'

// --------------------------------------------------------------------------------------------
// E4S-00 — the widened subject set
// --------------------------------------------------------------------------------------------

test('E4S-00 (control): the ban now has exactly TWO subjects, and still discriminates', () => {
  assert.equal(fence.K3_WISE_EXTERNAL_WRITE_DISABLED, FIXED_CODE)
  assert.equal(fence.K3_EXTERNAL_WRITE_REFUSAL_STATUS, 403)

  // The WebAPI constant keeps its exact former value. Other suites pin it by name, and it stays
  // the default `targetKind` in a refusal's details, so no existing refusal shape moved.
  assert.equal(fence.K3_EXTERNAL_WRITE_TARGET_KIND, WEBAPI_KIND)
  assert.equal(fence.K3_EXTERNAL_WRITE_SQLSERVER_TARGET_KIND, SQL_KIND)
  assert.deepEqual([...fence.K3_EXTERNAL_WRITE_TARGET_KINDS], [WEBAPI_KIND, SQL_KIND])

  assert.equal(fence.isK3ExternalWriteTargetKind(WEBAPI_KIND), true)
  assert.equal(fence.isK3ExternalWriteTargetKind(SQL_KIND), true, 'the sibling kind is now a subject')

  // Discrimination: widening must not have swallowed the neighbouring wired kinds. If it had,
  // every zero-write assertion in this file would pass for the wrong reason.
  for (const other of [
    'data-source:sql-write-gated',
    'data-source:sql-readonly',
    'metasheet:multitable',
    'metasheet:staging',
    'bridge:legacy-sql-readonly',
    'plm:yuantus-wrapper',
    'http',
    // Near-misses, because a substring or prefix match would be a silent over-reach.
    'erp:k3-wise-sqlserver-v2',
    'erp:k3-wise',
    '',
  ]) {
    assert.equal(fence.isK3ExternalWriteTargetKind(other), false, `${other} is NOT a subject of the ban`)
  }
  for (const notAKind of [undefined, null, 0, {}, []]) {
    assert.equal(fence.isK3ExternalWriteTargetKind(notAKind), false)
  }
})

test('E4S-00 (control): the subject set is frozen and reserves no runtime unlock', () => {
  // "不得预留运行时开关" applied to the widened set: adding or removing a subject at runtime would
  // be exactly the unlock §10.1 forbids.
  assert.ok(Object.isFrozen(fence.K3_EXTERNAL_WRITE_TARGET_KINDS), 'the subject set is frozen')
  assert.throws(() => { fence.K3_EXTERNAL_WRITE_TARGET_KINDS.push('anything') }, TypeError)

  // The optional `targetKind` argument only LABELS a refusal — it can never suppress one, and a
  // caller cannot inject a value of its own choosing into the details.
  const build = (status, code, message, details) => Object.assign(new Error(message), { status, code, details })
  for (const attempt of [undefined, null, 'http', 'not-a-kind', 123, {}]) {
    const error = fence.k3ExternalWritePermanentRefusal(build, attempt)
    assert.equal(error.code, FIXED_CODE)
    assert.equal(error.status, 403)
    assert.equal(error.details.targetKind, WEBAPI_KIND, 'an unrecognised label falls back, it does not pass through')
  }
  assert.equal(fence.k3ExternalWritePermanentRefusal(build, SQL_KIND).details.targetKind, SQL_KIND)
  assert.throws(() => fence.refuseK3ExternalWritePermanently(build, SQL_KIND), /permanently disabled/)
})

test('E4S-00 (control): both kinds are INDISTINGUISHABLE in a refusal body', () => {
  // A caller must not be able to probe which kind — or which layer — caught it and work inward.
  const build = (status, code, message, details) => ({ status, code, message, details })
  const webapi = fence.k3ExternalWritePermanentRefusal(build, WEBAPI_KIND)
  const sql = fence.k3ExternalWritePermanentRefusal(build, SQL_KIND)
  assert.equal(webapi.status, sql.status)
  assert.equal(webapi.code, sql.code)
  assert.equal(webapi.message, sql.message, 'the operator-facing text is identical for both kinds')
})

// --------------------------------------------------------------------------------------------
// Shared fixtures
// --------------------------------------------------------------------------------------------

// A WRITE-CAPABLE executor that RECORDS every call and SUCCEEDS on purpose. This is the executor a
// deployment could have injected before this fence existed. It succeeds so that if any layer ever
// failed to hold, the write would land and the zero-count assertions would fail loudly rather than
// be masked by a stub that refuses anyway.
function recordingWriteCapableExecutor({ readFailure = null } = {}) {
  const calls = []
  return {
    calls,
    get inserts() { return calls.filter((c) => c.method === 'insertMany').length },
    get selects() { return calls.filter((c) => c.method === 'select').length },
    executor: {
      async testConnection() {
        calls.push({ method: 'testConnection' })
        return { ok: true }
      },
      async select(input) {
        calls.push({ method: 'select', input })
        if (readFailure === 'transport') {
          const error = new Error('SQL Server connection reset')
          error.code = 'SQLSERVER_READ_FAILED'
          throw error
        }
        return { records: [{ FItemID: 1, FNumber: 'MAT-001', FName: 'Bolt' }], nextCursor: null }
      },
      async insertMany(input) {
        calls.push({ method: 'insertMany', input })
        return { written: input.records.length, failed: 0, results: [] }
      },
    },
  }
}

// A system config with EVERY write-enabling knob this channel has ever honoured turned on at once,
// including the historic `allowDirectTableWrite: true` bypass that made the old guard vacuous, and
// a target table that is a LIVE K3 business table rather than a middle table.
function permissiveSqlSystem(extraConfig = {}) {
  return {
    id: 'k3_sql_1',
    name: 'K3 WISE SQL Server',
    kind: SQL_KIND,
    role: 'bidirectional',
    credentials: { username: 'u', password: 'p' },
    config: {
      allowedTables: ['dbo.t_ICItem', 'dbo.integration_material_stage'],
      readTables: ['dbo.t_ICItem'],
      writeTables: ['dbo.t_ICItem', 'dbo.integration_material_stage'],
      objects: {
        material: {
          table: 'dbo.t_ICItem',
          operations: ['read', 'upsert'],
          keyField: 'FNumber',
          columns: ['FItemID', 'FNumber', 'FName'],
          // The bypass. Before this fence, this single flag authorised a direct write into the
          // live K3 item table.
          allowDirectTableWrite: true,
          writeMode: 'middle-table',
        },
        material_stage: {
          table: 'dbo.integration_material_stage',
          operations: ['read', 'upsert'],
          writeMode: 'middle-table',
          keyField: 'FNumber',
        },
      },
      ...extraConfig,
    },
  }
}

// --------------------------------------------------------------------------------------------
// E4S-03 — the channel's own `upsert` (layer 3), witnessed ALONE
// --------------------------------------------------------------------------------------------

test('E4S-03: the SQL Server channel refuses upsert unconditionally — no table, mode or flag reaches past it', async () => {
  const wire = recordingWriteCapableExecutor()
  const adapter = createK3WiseSqlServerChannel({
    system: permissiveSqlSystem(),
    queryExecutor: wire.executor,
  })

  // Both the live-business-table object (with the bypass flag) and the sanctioned middle-table
  // object. Neither is a way through.
  for (const object of ['material', 'material_stage']) {
    const refusal = await adapter.upsert({
      object,
      records: [{ FNumber: 'MAT-E4S-1', FName: 'One' }],
      keyFields: ['FNumber'],
      options: { allowDirectTableWrite: true, writeMode: 'middle-table' },
    }).then(() => null, (error) => error)

    assert.ok(refusal, `E4S-03: upsert on ${object} must refuse`)
    assert.equal(refusal.code, FIXED_CODE, `E4S-03: ${object} carries the fixed code`)
    assert.equal(refusal.status, 403, 'E4S-03: 403 — not a configuration the caller can fix')
    assert.equal(refusal.details.code, FIXED_CODE, 'E4S-03: the code also rides details')
    assert.equal(refusal.details.targetKind, SQL_KIND, 'E4S-03: the refusal names the sqlserver kind')
  }

  assert.equal(wire.inserts, 0, 'E4S-03: insertMany = 0')
  assert.equal(wire.calls.length, 0, 'E4S-03: the executor was not touched AT ALL — not even resolved')
})

test('E4S-03: the refusal lands even with NO executor injected — it precedes every resolution', async () => {
  // The refusal is the first statement of `upsert`, ahead of the executor shape check. Without
  // this, a reader could think the channel merely fails late on a missing executor.
  const adapter = createK3WiseSqlServerChannel({ system: permissiveSqlSystem() })
  const refusal = await adapter.upsert({ object: 'material', records: [{ FNumber: 'X' }] })
    .then(() => null, (error) => error)
  assert.equal(refusal && refusal.code, FIXED_CODE, 'the permanent code, not SQLSERVER_EXECUTOR_MISSING')
})

test('E4S-03 control: the SAME adapter instance still READS through the SAME executor', async () => {
  // Anti-fake-green for E4S-03. `insertMany = 0` above must mean "the write path stopped early",
  // not "this channel does nothing". A blanket deny that killed reads would be a FAIL, not a pass
  // (§15.2 E4-05 restated for this kind) — the read path is what this kind is wired for.
  const wire = recordingWriteCapableExecutor()
  const adapter = createK3WiseSqlServerChannel({
    system: permissiveSqlSystem(),
    queryExecutor: wire.executor,
  })

  const connection = await adapter.testConnection()
  assert.equal(connection.ok, true, 'testConnection still works')

  const objects = await adapter.listObjects()
  assert.ok(objects.some((o) => o.name === 'material'), 'listObjects still works')

  const schema = await adapter.getSchema({ object: 'material' })
  assert.equal(schema.table, 'dbo.t_ICItem', 'getSchema still works')

  const read = await adapter.read({ object: 'material', limit: 10 })
  assert.equal(read.records.length, 1, 'read really returned rows')
  assert.equal(read.metadata.mode, 'sqlserver-read')
  assert.ok(wire.selects > 0, 'the READ genuinely reached the executor — so insertMany=0 is meaningful')
  assert.equal(wire.inserts, 0, 'and still zero writes')
})

// --------------------------------------------------------------------------------------------
// E4S-04 — the EXECUTOR SEAM (layer 4), witnessed ALONE
// --------------------------------------------------------------------------------------------

test('E4S-04: the executor seam refuses insertMany for ANY injected executor, driven directly', async () => {
  // This layer is driven WITHOUT going through `upsert`, which is what makes it independent: with
  // the layer-3 refusal deleted, this alone still guarantees zero writes.
  const wire = recordingWriteCapableExecutor()
  const fenced = SQLSERVER_INTERNALS.fenceExecutorExternalWrites(wire.executor)

  const refusal = await fenced.insertMany({ table: 'dbo.t_ICItem', records: [{ FNumber: 'MAT-E4S-2' }] })
    .then(() => null, (error) => error)

  assert.ok(refusal, 'E4S-04: the seam must refuse')
  // The refusal arrives as a REJECTION, not a synchronous throw: an executor's `insertMany`
  // returns a promise, and a caller that holds it before awaiting must still see the refusal
  // through its own error handling rather than as an uncaught exception.
  assert.equal(refusal.code, FIXED_CODE)
  assert.equal(refusal.status, 403)
  assert.equal(refusal.details.targetKind, SQL_KIND)
  assert.equal(wire.inserts, 0, 'E4S-04: the underlying write-capable executor never ran')

  // The shape check the channel performs cannot be turned into a way to DETECT the fence and
  // route around it: the member is still a function.
  assert.equal(typeof fenced.insertMany, 'function')

  // Re-attaching a live write from outside is refused, not silently dropped.
  assert.throws(() => { fenced.insertMany = wire.executor.insertMany }, (error) => error.code === FIXED_CODE)
  assert.equal(wire.inserts, 0, 'E4S-04: still zero after the re-attach attempt')
})

test('E4S-04 control: the seam forwards READS untouched, and preserves method identity', async () => {
  // Anti-fake-green for E4S-04: a wrapper that broke every member would satisfy "insertMany
  // refused" while destroying the read path this kind exists for.
  const wire = recordingWriteCapableExecutor()
  const fenced = SQLSERVER_INTERNALS.fenceExecutorExternalWrites(wire.executor)

  assert.equal((await fenced.testConnection()).ok, true, 'testConnection forwards')
  const selected = await fenced.select({ table: 'dbo.t_ICItem', limit: 1 })
  assert.equal(selected.records.length, 1, 'select forwards and returns real rows')
  assert.equal(wire.selects, 1, 'the underlying executor really ran the read')
  assert.equal(wire.inserts, 0)

  // A class-based deployment executor keeps its own `this` — the wrapper binds real methods to the
  // target rather than re-pointing the receiver, so private state still resolves.
  class DeploymentExecutor {
    #secret = 'held'

    async select() { return { records: [{ ok: this.#secret }] } }

    async insertMany() { throw new Error('must never run') }
  }
  const wrapped = SQLSERVER_INTERNALS.fenceExecutorExternalWrites(new DeploymentExecutor())
  const viaClass = await wrapped.select()
  assert.equal(viaClass.records[0].ok, 'held', 'a class executor keeps its private state through the wrapper')
  await assert.rejects(() => wrapped.insertMany({}), (error) => error.code === FIXED_CODE)
})

test('E4S-04: a write-capable executor injected into the CHANNEL is fenced at the seam', async () => {
  // The two layers together, through the real construction path — including the config-borne
  // executor, which is the more dangerous of the two seams because it is customer-editable shape.
  const injected = recordingWriteCapableExecutor()
  const viaConfig = recordingWriteCapableExecutor()

  const system = permissiveSqlSystem({ queryExecutor: viaConfig.executor })
  const adapter = createK3WiseSqlServerChannel({ system, queryExecutor: injected.executor })
  await adapter.upsert({ object: 'material', records: [{ FNumber: 'A' }] }).catch(() => {})
  assert.equal(injected.inserts, 0, 'the injected executor never wrote')

  const configOnly = createK3WiseSqlServerChannel({ system: permissiveSqlSystem({ queryExecutor: viaConfig.executor }) })
  await configOnly.upsert({ object: 'material', records: [{ FNumber: 'B' }] }).catch(() => {})
  assert.equal(viaConfig.inserts, 0, 'the CONFIG-borne executor never wrote either')
})

test('E4S-04 context: the read-only default executor still refuses on its own', async () => {
  // The old posture, kept as an assertion rather than deleted: the built-in executor is still
  // read-only. It is simply no longer what the guarantee RESTS on — that was the whole finding.
  const readOnly = createK3WiseSqlServerReadOnlyExecutor({ driver: {} })
  await assert.rejects(
    () => readOnly.insertMany({}),
    (error) => error.code === 'SQLSERVER_WRITE_EXECUTOR_DISABLED',
    'the built-in executor keeps its own read-only refusal',
  )
})

// --------------------------------------------------------------------------------------------
// E4S-06 / E4S-07 — regressions that a blanket deny would break
// --------------------------------------------------------------------------------------------

test('E4S-06: the published adapter metadata states a REFUSAL, not a write recipe', () => {
  const write = K3_WISE_SQLSERVER_ADAPTER_METADATA.guardrails.write
  assert.deepEqual(write, { permanentlyRefused: true, refusalCode: FIXED_CODE, authority: 'E4' })
  // The old keys are gone: a listing that names both a refusal and a recipe reads as a recipe.
  assert.equal(write.requiresMiddleTableMode, undefined)
  assert.equal(write.writeModes, undefined)
  // The READ guardrail is deliberately untouched — the read path is legitimate and in use.
  assert.deepEqual(K3_WISE_SQLSERVER_ADAPTER_METADATA.guardrails.read, {
    requiresTableAllowlist: true,
    allowlistKeys: ['readTables', 'allowedTables'],
  })
})

test('E4S-07: an injected READ failure keeps its own read-side code and never surfaces the fence code', async () => {
  const wire = recordingWriteCapableExecutor({ readFailure: 'transport' })
  const adapter = createK3WiseSqlServerChannel({
    system: permissiveSqlSystem(),
    queryExecutor: wire.executor,
  })

  const error = await adapter.read({ object: 'material', limit: 5 }).then(() => null, (err) => err)
  assert.ok(error, 'the injected read failure must surface')
  assert.notEqual(error.code, FIXED_CODE, 'a READ failure must NOT be reported as the write fence')
  const serialized = JSON.stringify({ message: error.message, code: error.code, details: error.details })
  assert.equal(serialized.includes(FIXED_CODE), false, 'the write-fence code appears nowhere in a read failure')
  assert.equal(wire.inserts, 0)
})

// --------------------------------------------------------------------------------------------
// E4S-08 — the bypass attempt
// --------------------------------------------------------------------------------------------

test('E4S-08: no environment variable, system config, object config or request option re-enables the write', async () => {
  // §10.1 verbatim: "env flag、通用 C6 开关、owner policy、审批结果和请求参数均不能解锁".
  // Every plausible enabling surface is pushed to its most permissive setting SIMULTANEOUSLY.
  const ENV_KEYS = [
    'INTEGRATION_C6_WRITE_APPLY_DISABLED',
    'INTEGRATION_K3_WRITE_ENABLED',
    'INTEGRATION_K3_SQLSERVER_WRITE_ENABLED',
    'INTEGRATION_EXTERNAL_WRITE_ENABLED',
    'INTEGRATION_SQLSERVER_WRITE_ENABLED',
    'SQLSERVER_WRITE_EXECUTOR_DISABLED',
    'K3_WISE_EXTERNAL_WRITE_DISABLED',
    'INTEGRATION_CORE_OUTBOUND_HTTP_WRITE_TARGETS',
  ]
  const saved = ENV_KEYS.map((key) => [key, process.env[key]])
  try {
    // Both polarities, because a guard could plausibly read either sense of any of these.
    for (const value of ['false', 'true', '1', '0', '*']) {
      for (const key of ENV_KEYS) process.env[key] = value

      const wire = recordingWriteCapableExecutor()
      const adapter = createK3WiseSqlServerChannel({
        system: permissiveSqlSystem({
          externalWriteEnabled: true,
          allowDirectTableWrite: true,
          writeMode: 'middle-table',
          c6AcceptancePolicy: { profile: 'anything' },
          objects: {
            material: {
              table: 'dbo.t_ICItem',
              operations: ['read', 'upsert', 'insert', 'update', 'write'],
              keyField: 'FNumber',
              allowDirectTableWrite: true,
              writeMode: 'middle-table',
              externalWriteEnabled: true,
              permanentlyRefused: false,
            },
          },
        }),
        queryExecutor: wire.executor,
      })

      const refusal = await adapter.upsert({
        object: 'material',
        records: [{ FNumber: 'MAT-E4S-BYPASS' }],
        keyFields: ['FNumber'],
        options: {
          allowDirectTableWrite: true,
          externalWriteEnabled: true,
          force: true,
          approved: true,
          dryRunToken: 'anything',
          autoSubmit: true,
          autoAudit: true,
        },
      }).then(() => null, (error) => error)

      assert.equal(refusal && refusal.code, FIXED_CODE, `still refused with every key = ${value}`)
      assert.equal(wire.inserts, 0, `still zero writes with every key = ${value}`)

      // And the seam alone, under the same environment.
      const fenced = SQLSERVER_INTERNALS.fenceExecutorExternalWrites(wire.executor)
      await assert.rejects(() => fenced.insertMany({ records: [] }), (error) => error.code === FIXED_CODE)
      assert.equal(wire.inserts, 0)
    }
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

// --------------------------------------------------------------------------------------------
// E4S-05 — the pipeline runner seam
// --------------------------------------------------------------------------------------------

function runnerHarness({ targetKind }) {
  const wire = recordingWriteCapableExecutor()
  const probes = { adapterCreates: 0, sourceReads: 0, credentialLoads: 0 }

  const sourceSystem = { id: 'source_1', name: 'Source', kind: 'metasheet:staging', role: 'source', status: 'active', config: {} }
  const targetSystem = { ...permissiveSqlSystem(), kind: targetKind, status: 'active' }
  const systems = new Map([[sourceSystem.id, sourceSystem], [targetSystem.id, targetSystem]])

  const pipeline = {
    id: 'pipe_sql_e4s',
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    sourceSystemId: 'source_1',
    sourceObject: 'materials',
    targetSystemId: targetSystem.id,
    targetObject: 'material',
    status: 'active',
    createdBy: 'owner-7',
    fieldMappings: [{ sourceField: 'code', targetField: 'FNumber' }],
  }

  const runner = createPipelineRunner({
    pipelineRegistry: {
      async getPipeline() { return pipeline },
      async listPipelines() { return [] },
    },
    externalSystemRegistry: {
      async getExternalSystem(input) { return systems.get(input.id) || null },
      async getExternalSystemForAdapter(input) {
        probes.credentialLoads += 1
        return systems.get(input.id) || null
      },
    },
    adapterRegistry: {
      listAdapterKinds() { return [targetKind, 'metasheet:staging'] },
      createAdapter(system) {
        probes.adapterCreates += 1
        if (system.kind === targetKind && targetKind === SQL_KIND) {
          return createK3WiseSqlServerChannel({ system, queryExecutor: wire.executor })
        }
        return {
          async read() { probes.sourceReads += 1; return { records: [{ code: 'MAT-1' }], done: true } },
          async upsert() { return { written: 1, failed: 0, results: [], errors: [] } },
          async previewUpsert() { return { records: [], metadata: {} } },
          async testConnection() { return { ok: true } },
          async listObjects() { return [] },
          async getSchema() { return { fields: [] } },
        }
      },
    },
    runLogger: { async startRun() { return { id: 'run_1' } }, async finishRun() { return {} }, async failRun() { return {} } },
    deadLetterStore: { async createDeadLetter() { return {} } },
    watermarkStore: { async getWatermark() { return null }, async setWatermark() { return {} } },
    logger: { warn() {}, error() {}, info() {} },
  })

  return { runner, wire, probes, pipeline }
}

test('E4S-05: the pipeline runner refuses a sqlserver target at TARGET RESOLUTION — before adapter, credentials or source read', async () => {
  const h = runnerHarness({ targetKind: SQL_KIND })

  const refusal = await h.runner.runPipeline({
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    pipelineId: h.pipeline.id,
    principal: 'owner-7',
  }).then((result) => result, (error) => error)

  const code = (refusal && refusal.code) || (refusal && refusal.details && refusal.details.code)
  assert.equal(code, FIXED_CODE, 'E4S-05: the runner refuses with the permanent token')
  assert.equal(h.wire.inserts, 0, 'E4S-05: insertMany = 0')
  assert.equal(h.probes.adapterCreates, 0, 'E4S-05: adapter construction = 0')
  assert.equal(h.probes.sourceReads, 0, 'E4S-05: source read = 0')
})

test('E4S-05 control: the SAME harness carries a non-K3 target all the way to a completed write', async () => {
  // The refusal above is only meaningful if this harness could otherwise have written. Swap ONLY
  // the target kind and the identical wiring runs a pipeline end to end.
  const h = runnerHarness({ targetKind: 'metasheet:staging' })
  const result = await h.runner.runPipeline({
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    pipelineId: h.pipeline.id,
    principal: 'owner-7',
  })
  assert.ok(result, 'a non-K3 target runs')
  assert.ok(h.probes.adapterCreates > 0, 'the harness DOES construct adapters when allowed')
  assert.ok(h.probes.sourceReads > 0, 'the harness DOES read the source when allowed')
})

// --------------------------------------------------------------------------------------------
// E4S-01 / E4S-02 — the shared route and C6 layers, now matching both kinds
// --------------------------------------------------------------------------------------------

const NOOP_CONFIG_STORE = {
  async saveVersion() { return {} },
  async list() { return [] },
  async get() { return {} },
  async approve() { return {} },
  async retire() { return {} },
  async listAudit() { return [] },
  async getForRuntime() { return {} },
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

async function invoke(routes, method, routePath, req) {
  const handler = routes.get(`${String(method).toUpperCase()} ${routePath}`)
  assert.ok(handler, `expected route ${method} ${routePath} to be registered`)
  const res = createResponse()
  await handler({ user: req.user, body: req.body || {}, query: req.query || {}, params: req.params || {} }, res)
  return res
}

function routeHarness({ targetKind }) {
  const wire = recordingWriteCapableExecutor()
  const probes = { credentialReloads: 0, adapterCreates: 0, sourceReads: 0 }
  const tokenStats = { consume: 0, delete: 0 }
  const tokens = new Map()

  const targetSystem = { ...permissiveSqlSystem(), kind: targetKind, status: 'active' }
  const sourceSystem = { id: 'source_1', name: 'Source', kind: 'data-source:sql-readonly', role: 'source', status: 'active', config: {} }
  const systems = new Map([[targetSystem.id, targetSystem], [sourceSystem.id, sourceSystem]])

  const routes = new Map()
  registerIntegrationRoutes({
    context: {
      storage: {
        async get(key) { return tokens.get(key) || null },
        async set(key, value) { tokens.set(key, value) },
        async consume(key) { tokenStats.consume += 1; const v = tokens.get(key) || null; tokens.delete(key); return v },
        async delete(key) { tokenStats.delete += 1; tokens.delete(key) },
      },
      config: {},
      api: {
        http: {
          addRoute(method, routePath, handler) {
            routes.set(`${String(method).toUpperCase()} ${routePath}`, handler)
          },
        },
      },
    },
    services: {
      externalSystemRegistry: {
        async upsertExternalSystem() { return {} },
        async deleteExternalSystem() { return {} },
        async listExternalSystems() { return [] },
        async getExternalSystem(input) {
          const system = systems.get(input.id)
          if (!system) return null
          const { credentials, ...rest } = system
          return { ...rest, hasCredentials: Boolean(credentials) }
        },
        // Reaching this at all for a banned kind is a layer-1 FAILURE.
        async getExternalSystemForAdapter(input) {
          probes.credentialReloads += 1
          return systems.get(input.id) || null
        },
        async getExternalSystemInstanceDigest() { return 'e4s-instance-digest' },
      },
      adapterRegistry: {
        listAdapterKinds() { return [targetKind, 'data-source:sql-readonly'] },
        createAdapter(system) {
          probes.adapterCreates += 1
          if (system && system.kind === SQL_KIND) {
            return createK3WiseSqlServerChannel({ system, queryExecutor: wire.executor })
          }
          return { async read() { probes.sourceReads += 1; return { records: [], done: true } } }
        },
      },
      pipelineRegistry: {
        async upsertPipeline() { return {} },
        async getPipeline() {
          return {
            id: 'pipe_sql_e4s',
            tenantId: TENANT_ID,
            workspaceId: WORKSPACE_ID,
            sourceSystemId: 'source_1',
            sourceObject: 'materials',
            targetSystemId: targetSystem.id,
            targetObject: 'material',
            status: 'active',
            createdBy: 'owner-7',
            fieldMappings: [{ sourceField: 'code', targetField: 'FNumber' }],
          }
        },
        async listPipelines() { return [] },
        async listPipelineRuns() { return [] },
      },
      pipelineRunner: { async runPipeline() { return {} } },
      deadLetterStore: { async listDeadLetters() { return [] } },
      stagingInstaller: { async installStaging() { return {} }, listStagingDescriptors() { return [] } },
      templateRegistry: {
        async upsertTemplate() { return {} },
        async getTemplate() { return {} },
        async listTemplates() { return [] },
        async deleteTemplate() { return {} },
        async instantiateTemplate() { return {} },
      },
      readSourceConfigStore: NOOP_CONFIG_STORE,
      readSourceCompositionConfigStore: NOOP_CONFIG_STORE,
      bridgeAgentChecklistStore: {
        async saveVersion() { return {} },
        async approve() { return {} },
        async retire() { return {} },
        async getForApply() { return {} },
      },
    },
    logger: { warn() {}, error() {}, info() {} },
  })

  return { routes, wire, probes, tokens, tokenStats }
}

test('E4S-01: the C6 Apply HTTP route refuses a sqlserver target on the credential-STRIPPED peek', async () => {
  const h = routeHarness({ targetKind: SQL_KIND })

  // A token that WOULD otherwise be presentable, seeded exactly like an in-flight approval.
  await h.tokens.set('integration:c6-write-dry-run-token:e4s-in-flight', {
    pipelineId: 'pipe_sql_e4s',
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    dryRunUser: 'user_write',
    dataSourceOwnerPrincipal: 'owner-7',
    revision: 'whatever',
    counts: {},
    maxRows: 3,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  })
  const consumesBefore = h.tokenStats.consume + h.tokenStats.delete

  const res = await invoke(h.routes, 'POST', '/api/integration/pipelines/:id/external-write/apply', {
    user: { id: 'user_write', tenantId: TENANT_ID, permissions: ['integration:write'] },
    params: { id: 'pipe_sql_e4s' },
    body: { confirm: { dryRunToken: 'e4s-in-flight' } },
  })

  assert.equal(res.statusCode, 403, 'E4S-01: 403')
  assert.equal(res.body.error.code, FIXED_CODE)

  assert.equal(h.probes.credentialReloads, 0, 'E4S-01: credential reload = 0')
  assert.equal(h.tokenStats.consume + h.tokenStats.delete, consumesBefore, 'E4S-01: token consume = 0')
  assert.ok(h.tokens.get('integration:c6-write-dry-run-token:e4s-in-flight'), 'E4S-01: the token is left UNCONSUMED')
  assert.equal(h.probes.adapterCreates, 0, 'E4S-01: adapter construction = 0')
  assert.equal(h.probes.sourceReads, 0, 'E4S-01: source read = 0')
  assert.equal(h.wire.inserts, 0, 'E4S-01: insertMany = 0')
})

test('E4S-01 control: the fence is what caught it — a non-banned kind travels PAST this point', async () => {
  // Anti-fake-green. Every count above is an ABSENCE, and `erp:k3-wise-sqlserver` has no C6 write
  // profile, so a reader could reasonably suspect the request died on the profile mismatch rather
  // than on the fence. Swap ONLY the target kind: the request then gets past the fence and fails
  // LATER with a DIFFERENT code, having reloaded credentials on the way.
  const h = routeHarness({ targetKind: 'data-source:sql-write-gated' })
  const res = await invoke(h.routes, 'POST', '/api/integration/pipelines/:id/external-write/apply', {
    user: { id: 'user_write', tenantId: TENANT_ID, permissions: ['integration:write'] },
    params: { id: 'pipe_sql_e4s' },
    body: { confirm: { dryRunToken: 'absent' } },
  })
  assert.notEqual(res.body.error && res.body.error.code, FIXED_CODE, 'a non-banned kind is NOT refused by the fence')
  assert.ok(h.probes.credentialReloads > 0, 'and the harness DOES travel further when the fence does not fire')
})

test('E4S-02: applyExternalWrite refuses a sqlserver target before token consumption and before the planner', async () => {
  const stats = { consume: 0 }
  const tokenStore = {
    async get() { return null },
    async set() {},
    async consume() { stats.consume += 1; return null },
    async delete() { stats.consume += 1 },
  }
  const source = { reads: 0 }

  const refusal = await applyExternalWrite({
    pipeline: {
      id: 'pipe_sql_e4s',
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      sourceSystemId: 'source_1',
      sourceObject: 'materials',
      targetSystemId: 'k3_sql_1',
      targetObject: 'material',
      status: 'active',
      createdBy: 'owner-7',
      fieldMappings: [{ sourceField: 'code', targetField: 'FNumber' }],
    },
    sourceSystem: { id: 'source_1', kind: 'data-source:sql-readonly' },
    targetSystem: permissiveSqlSystem(),
    sourceAdapter: { async read() { source.reads += 1; return { records: [], done: true } } },
    tokenStore,
    dryRunToken: 'e4s-direct',
    applyUser: 'operator-1',
    dataSourceOwnerPrincipal: 'owner-7',
    maxRows: 3,
  }).then(() => null, (error) => error)

  assert.ok(refusal, 'E4S-02: apply must refuse')
  assert.equal(refusal.code, FIXED_CODE)
  assert.equal(refusal.status, 403)
  assert.equal(stats.consume, 0, 'E4S-02: token consume = 0')
  assert.equal(source.reads, 0, 'E4S-02: source read = 0 — the planner never ran')
})

test('E4S-02: neither identity alone can launder the sqlserver kind past the module fence', async () => {
  // The check is OR-shaped over several independent identities. Strip either one and the other
  // must still refuse.
  const base = {
    pipeline: {
      id: 'pipe_sql_e4s',
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      sourceSystemId: 'source_1',
      sourceObject: 'materials',
      targetSystemId: 'k3_sql_1',
      targetObject: 'material',
      status: 'active',
      createdBy: 'owner-7',
      fieldMappings: [{ sourceField: 'code', targetField: 'FNumber' }],
    },
    sourceSystem: { id: 'source_1', kind: 'data-source:sql-readonly' },
    sourceAdapter: { async read() { return { records: [], done: true } } },
    tokenStore: { async get() { return null }, async set() {}, async consume() { return null }, async delete() {} },
    dryRunToken: 'nope',
    applyUser: 'operator-1',
    dataSourceOwnerPrincipal: 'owner-7',
  }

  for (const [label, input] of [
    ['targetSystem.kind carries it', { ...base, targetSystem: permissiveSqlSystem() }],
    ['the write profile carries it', {
      ...base,
      targetSystem: { ...permissiveSqlSystem(), kind: 'data-source:sql-write-gated' },
      targetWriteProfile: { kind: SQL_KIND },
    }],
  ]) {
    const refusal = await applyExternalWrite(input).then(() => null, (error) => error)
    assert.equal(refusal && refusal.code, FIXED_CODE, `${label}: still refused`)
  }
})
