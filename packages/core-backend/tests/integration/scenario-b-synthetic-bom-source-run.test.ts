import { createRequire } from 'module'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DataSourceManager } from '../../src/data-adapters/DataSourceManager'
import {
  MISSING_PRINCIPAL_MESSAGE,
  createDataSourcePluginFacade,
} from '../../src/data-adapters/data-source-plugin-facade'
import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'

// 场景 B / W7-A1 —— 合成 BOM 夹具经既有 data-source:sql-readonly 受控源跑通只读读取，
// **拿真 facade / 真 DataSourceManager 跑**。
//
// 与插件侧姊妹套件的分工（plugins/plugin-integration-core/__tests__/
// scenario-b-synthetic-bom-source-run.test.cjs）：那边证读取链本身（行数、完整性证明、
// 项目域、权限码），宿主 facade 在那边是被动替身；owner 隔离与"可写源根本读不了"这两件事
// 只有在这里才不是替身背书 —— 它们是 data-source-plugin-facade.ts 的 authorize() 和
// DataSourceManager.assertAccess() 本体。
//
// 前两个 describe **不需要数据库**：owner 门与只读门都在 connect 之前判（assertAccess 是内存里的
// scopes 表，isReadOnly() 是配置标志），所以它们在无 DB 的默认 vitest 泳道里也真跑。
// 第三个 describe 需要真 PG（DATABASE_URL），跑整条 feeder。

const require = createRequire(import.meta.url)
const PLUGIN_DIR = path.resolve(__dirname, '../../../../plugins/plugin-integration-core')
const FIXTURE_DIR = path.join(PLUGIN_DIR, 'fixtures', 'scenario-b-synthetic-bom')

const fixture = require(path.join(FIXTURE_DIR, 'scenario-b-synthetic-bom.cjs')) as {
  ROW_COUNT: number
  PROJECT_NO: string
  SUBASSEMBLY_COUNT: number
  TABLE_NAME: string
  readSourceConfig: (overrides?: { systemId?: string; object?: string }) => Record<string, unknown>
}
const {
  ADAPTER_KIND,
  createDataSourceSqlReadonlySourceAdapter,
} = require(path.join(PLUGIN_DIR, 'lib', 'adapters', 'data-source-sql-readonly-source-adapter.cjs')) as {
  ADAPTER_KIND: string
  createDataSourceSqlReadonlySourceAdapter: (input: Record<string, unknown>) => {
    read(input: Record<string, unknown>): Promise<{ records: Array<Record<string, unknown>> }>
    upsert(input: Record<string, unknown>): Promise<unknown>
  }
}
const { validateReadSourceConfig } = require(path.join(PLUGIN_DIR, 'lib', 'read-source-config.cjs')) as {
  validateReadSourceConfig: (config: unknown) => { valid: boolean; errors: unknown; normalized: unknown }
}
const { prepareConfiguredRead } = require(path.join(PLUGIN_DIR, 'lib', 'read-source-read-runtime.cjs')) as {
  prepareConfiguredRead: (body: unknown) => unknown
}
const { runPlmBomReadonlySource } = require(path.join(PLUGIN_DIR, 'lib', 'stock-preparation-readonly-source-run.cjs')) as {
  runPlmBomReadonlySource: (input: Record<string, unknown>) => Promise<{
    status: string
    mode: string
    evidence: Record<string, unknown>
  }>
}

const OWNER_ID = 'scenario-b-owner'
const OTHER_TENANT_USER = 'scenario-b-other-tenant-user'

function readOnlyConfig(id: string, databaseUrl: string | undefined, readOnly = true): DataSourceConfig {
  const parsed = databaseUrl ? new URL(databaseUrl) : null
  const credentials: Record<string, string> = {}
  if (parsed?.username) credentials.username = decodeURIComponent(parsed.username)
  if (parsed?.password) credentials.password = decodeURIComponent(parsed.password)
  return {
    id,
    name: 'Scenario B synthetic BOM',
    type: 'postgresql',
    connection: {
      host: parsed?.hostname || 'localhost',
      port: parsed?.port ? Number(parsed.port) : 5432,
      database: parsed ? parsed.pathname.replace(/^\//, '') : 'scenario_b_never_connected',
    },
    credentials,
    options: { readOnly, autoConnect: false },
    poolConfig: { min: 0, max: 2, idleTimeout: 1000 },
  }
}

function preparedRead(object: string) {
  const validation = validateReadSourceConfig(fixture.readSourceConfig({ object }))
  expect(validation.valid, JSON.stringify(validation.errors)).toBe(true)
  return prepareConfiguredRead({ config: validation.normalized })
}

describe('scenario B synthetic BOM source — host owner gate (no database required)', () => {
  const dataSourceId = 'scenario-b-owner-gate'
  let manager: DataSourceManager
  let facade: ReturnType<typeof createDataSourcePluginFacade>

  beforeAll(async () => {
    manager = new DataSourceManager()
    await manager.addDataSource(readOnlyConfig(dataSourceId, process.env.DATABASE_URL), {
      ownerId: OWNER_ID,
      persist: false,
    })
    facade = createDataSourcePluginFacade(() => manager)
  })

  it('refuses a read carried by ANOTHER principal with the uniform not-found — no existence leak', async () => {
    await expect(
      facade.select(dataSourceId, fixture.TABLE_NAME, { limit: 1 }, OTHER_TENANT_USER),
    ).rejects.toThrow(`Data source with id '${dataSourceId}' not found`)
    // 同一句话也用在"源不存在"上，所以越权方分不出"不是你的"和"不存在"。
    await expect(
      facade.select('scenario-b-does-not-exist', fixture.TABLE_NAME, { limit: 1 }, OTHER_TENANT_USER),
    ).rejects.toThrow("Data source with id 'scenario-b-does-not-exist' not found");
  })

  it('refuses a read with no principal at all — never falls back to a default identity', async () => {
    await expect(
      facade.select(dataSourceId, fixture.TABLE_NAME, { limit: 1 }, undefined),
    ).rejects.toThrow(MISSING_PRINCIPAL_MESSAGE)
  })

  it('lets the owner through the same gate (so the two refusals above are not vacuous)', async () => {
    // 不需要真连库：owner 门在 connect 之前判，错误必须已经越过 authorize 才可能变成连接类错误。
    await expect(
      facade.select(dataSourceId, fixture.TABLE_NAME, { limit: 1 }, OWNER_ID),
    ).rejects.not.toThrow(`Data source with id '${dataSourceId}' not found`)
  })
})

describe('scenario B synthetic BOM source — read-only posture (no database required)', () => {
  it('refuses to READ a writable data source at the facade choke point, before any connection', async () => {
    const manager = new DataSourceManager()
    const writableId = 'scenario-b-writable'
    await manager.addDataSource(readOnlyConfig(writableId, process.env.DATABASE_URL, false), {
      ownerId: OWNER_ID,
      persist: false,
    })
    const facade = createDataSourcePluginFacade(() => manager)
    await expect(
      facade.select(writableId, fixture.TABLE_NAME, { limit: 1 }, OWNER_ID),
    ).rejects.toThrow(/read-only/i)
  })

  it('has no write verb on the adapter itself', async () => {
    const manager = new DataSourceManager()
    const dataSourceId = 'scenario-b-no-write'
    await manager.addDataSource(readOnlyConfig(dataSourceId, process.env.DATABASE_URL), {
      ownerId: OWNER_ID,
      persist: false,
    })
    const adapter = createDataSourceSqlReadonlySourceAdapter({
      system: { kind: ADAPTER_KIND, config: { dataSourceId } },
      context: { api: { dataSources: createDataSourcePluginFacade(() => manager) } },
      principal: OWNER_ID,
    })
    await expect(
      adapter.upsert({ object: fixture.TABLE_NAME, records: [{ part_no: 'SYN-EVIL' }], keyFields: ['part_no'] }),
    ).rejects.toThrow(/does not support upsert/)
  })
})

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

describeIfDatabase('scenario B synthetic BOM source — real Postgres feeder run', () => {
  const tableSuffix = `${process.pid}_${Date.now()}`
  const tableName = `${fixture.TABLE_NAME}_${tableSuffix}`
  const dataSourceId = `scenario-b-realdb-${tableSuffix}`
  let pool: Pool
  let manager: DataSourceManager

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL })
    // 夹具 SQL 是唯一事实来源；这里只把表名换成本次运行的独占名，内容一个字不改。
    const schemaSql = fs.readFileSync(path.join(FIXTURE_DIR, '01-schema.sql'), 'utf8')
    const seedSql = fs.readFileSync(path.join(FIXTURE_DIR, '02-seed.sql'), 'utf8')
    const rename = (sql: string) => sql.split(fixture.TABLE_NAME).join(tableName)
    await pool.query(rename(schemaSql))
    await pool.query(rename(seedSql))

    manager = new DataSourceManager()
    await manager.addDataSource(readOnlyConfig(dataSourceId, process.env.DATABASE_URL), {
      ownerId: OWNER_ID,
      persist: false,
    })
  })

  afterAll(async () => {
    if (manager) await manager.disconnectDataSource(dataSourceId).catch(() => undefined)
    if (pool) {
      await pool.query(`DROP TABLE IF EXISTS public.${tableName}`).catch(() => undefined)
      await pool.end()
    }
  })

  it('feeds every synthetic BOM row through the real feeder, read-only, with a proven-complete snapshot', async () => {
    const facade = createDataSourcePluginFacade(() => manager)
    const system = { id: 'scenario-b-realdb-system', kind: ADAPTER_KIND, role: 'source', config: { dataSourceId } }
    const result = await runPlmBomReadonlySource({
      permission: 'admin',
      projectId: 'business_project_scenario_b',
      sourceProjectNo: fixture.PROJECT_NO,
      syncRunId: `scenario_b_realdb_${tableSuffix}`,
      snapshotBatchId: `scenario_b_realdb_batch_${tableSuffix}`,
      snapshotVersion: 1,
      actor: OWNER_ID,
      preparedRead: preparedRead(`public.${tableName}`),
      system,
      createAdapter: (adapterSystem: unknown) => createDataSourceSqlReadonlySourceAdapter({
        system: adapterSystem,
        context: { api: { dataSources: facade } },
        principal: OWNER_ID,
      }),
    })

    expect(result.status).toBe('ready')
    expect(result.mode).toBe('dry_run')
    expect(result.evidence.sourceRows).toBe(fixture.ROW_COUNT)
    expect(result.evidence.completenessProof).toBe('short_page')
    expect(result.evidence.sourceChannel).toBe('data_source')
    expect(result.evidence.internalWriteExecuted).toBe(false)
    expect(result.evidence.externalWriteExecuted).toBe(false)
    expect(result.evidence.rawSql).toBe(false)
    expect((result.evidence.intake as { result: { rowErrors: number; bomSnapshotLines: number } }).result)
      .toMatchObject({ rowErrors: 0, bomSnapshotLines: fixture.ROW_COUNT })

    // 只读：整条链跑完，表里的行数一行没变。
    const after = await pool.query(`SELECT count(*)::int AS n FROM public.${tableName}`)
    expect(after.rows[0].n).toBe(fixture.ROW_COUNT)
  })

  it('refuses the same read for a non-owner principal against the real database', async () => {
    const facade = createDataSourcePluginFacade(() => manager)
    await expect(
      facade.select(dataSourceId, `public.${tableName}`, { limit: 1 }, OTHER_TENANT_USER),
    ).rejects.toThrow(`Data source with id '${dataSourceId}' not found`)
  })
})
