/**
 * Pull batch BI-6a (design-final §14 row BI-6a, owner item O-BI-9) — the read-only site probe PACK
 * (scripts/ops/stock-prep-pull-batch-site-probe-20261107/01-site-probe.sql) run by the real `psql` on real PostgreSQL.
 *
 * This is a CASES MODULE, not a test file: `defineStockPreparationPullBatchSiteProbeRealDbCases()` registers its
 * `describe` block and is called from the already-wired stock-prep real-DB host
 * (tests/integration/stock-preparation-p4-repair-once-realdb.test.ts), so the cases run in the existing "Run
 * multitable real-DB integration" step of .github/workflows/plugin-tests.yml without a workflow edit. Do NOT also
 * list it as a standalone file in that step.
 *
 *   BI-PROBE-RD-01 a registered project sheet built by the REAL provisioning (staging project `T:integration-core`,
 *          the project-sheet objectId, the PLM lock marked by the real repair helper, the registry row through the
 *          registry store), then shaped: one PLM column unlocked, a frozen list on the host default view, a personal
 *          field order, automation rules on and naming the sheet, a bound webhook, a generic configured writer
 *          (external system + pipelines) aimed at the sheet, machine / person / manual / locked / inactive / trashed
 *          rows with add stamps at two plan times, one impossible-day stamp and one stamp after its row's creation,
 *          a row of another project, and a sheet copy with a copy of the copy. Every printed number equals the
 *          fixture's own; the first view equals the context route's order (`created_at ASC`); the default output
 *          carries no project number, objectId, sheet id or tenant; the private map carries them only on request.
 *   BI-PROBE-RD-02 the env-bound sheet (operator-supplied project + object id): one PROBE_ENV_SHEET line and one
 *          kind=env line per project number on it; a wrong `env_sheet_id` and a registry row whose sheet id is not
 *          the derived one each report `status=incomplete reason=sheet_id_mismatch` with no numbers, and the run's
 *          PROBE_RESULT is incomplete.
 *   BI-PROBE-RD-03 creator-absent rows split by the writer that created them (R-65 C9) and counted against the plugin-row
 *          test (R-65 C4): a plugin row with a JSON key and a RUN stamp, a forged JSON key without a RUN stamp, an
 *          automation-created row (non-JSON key, no stamp), an anonymous-form row, a row of another source, a row whose
 *          create revision is gone (a later automation update remains), a creator-absent unbound `manual:` row and a
 *          person row. Every bucket equals the fixture's own.
 *
 * Every run of the pack (runPack) also checks the whole default output values-free: each non-private line carries only
 * its documented keys, and every value is an integer or a closed lower-case token.
 *
 * Edge cells (stamps, creators, created_at, locked) are shaped with direct UPDATEs on this throwaway database — the
 * records API would coerce or refuse them, and the probe must read what is stored. Values-free: every id is synthetic
 * and per-run (BIP-…).
 */
import { execFile, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'module'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import type { LoadedPlugin } from '../../src/core/plugin-loader'
import type { PluginContext } from '../../src/types/plugin'

const require = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const PLUGIN_LIB = path.join(REPO_ROOT, 'plugins/plugin-integration-core/lib')
const PACK_FILE = path.join(REPO_ROOT, 'scripts/ops/stock-prep-pull-batch-site-probe-20261107/01-site-probe.sql')

const { createDb } = require(path.join(PLUGIN_LIB, 'db.cjs')) as any
const projectTargetStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-project-target-store.cjs')) as any
const projectTargetsLib = require(path.join(PLUGIN_LIB, 'stock-preparation-project-targets.cjs')) as any
const ownBaseLib = require(path.join(PLUGIN_LIB, 'stock-preparation-own-base.cjs')) as any
const templatesLib = require(path.join(PLUGIN_LIB, 'stock-preparation-templates.cjs')) as any
const { ensureStockPreparationSandboxTarget } = require(path.join(PLUGIN_LIB, 'stock-preparation-target-provisioning.cjs')) as any

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const execFileAsync = promisify(execFile)
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

// `PSQL` may name the binary or a node shim (.cjs/.mjs/.js) that forwards to a psql elsewhere. CI uses the runner's own.
const PSQL = process.env.PSQL || 'psql'
const PSQL_IS_SCRIPT = /\.(?:c|m)?js$/.test(PSQL)
function psqlCommand(args: string[]): [string, string[]] {
  return PSQL_IS_SCRIPT ? [process.execPath, [PSQL, ...args]] : [PSQL, args]
}
function psqlAvailable(): boolean {
  const [command, args] = psqlCommand(['--version'])
  return spawnSync(command, args, { encoding: 'utf8' }).status === 0
}

const sha1Id = (prefix: string, ...parts: string[]) => `${prefix}_${createHash('sha1').update(parts.join(':')).digest('hex').slice(0, 24)}`

function createProductionPluginContext(): PluginContext {
  const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
  const loaded: LoadedPlugin = {
    manifest: { name: 'plugin-integration-core', version: 'pull-batch-site-probe-realdb' },
    plugin: { activate: async () => {} },
    path: 'realdb://stock-preparation-pull-batch-site-probe',
    loadedAt: new Date(),
  }
  return (server as unknown as { createPluginContext: (plugin: LoadedPlugin) => PluginContext }).createPluginContext(loaded)
}

type PackLine = { kind: string; fields: Record<string, string> }
function parsePack(stdout: string): PackLine[] {
  return stdout.split(/\r?\n/).filter((line) => /^PROBE_[A-Z_]+ /.test(line)).map((line) => {
    const [kind, ...pairs] = line.trim().split(' ')
    return { kind, fields: Object.fromEntries(pairs.map((pair) => { const at = pair.indexOf('='); return [pair.slice(0, at), pair.slice(at + 1)] })) }
  })
}

// The documented keys of every default-output line (README §3). A key outside its line's list, or a value that is not an
// integer or a closed lower-case token, fails every case: a zone name, an upper-cased or otherwise transformed handle
// cannot pass.
const SHEET_KEYS = ['plm_lock', 'plm_cols_locked', 'plm_cols_unlocked', 'plm_cols_missing', 'labels', 'view_count', 'first_view', 'views_at_first',
  'plugin_views', 'views_with_frozen', 'personal_order_overrides', 'automation_rules', 'automation_rules_enabled', 'automation_rules_elsewhere',
  'webhooks_active', 'writer_systems', 'writer_pipelines', 'writer_pipelines_active', 'copies', 'sheet_rows_all_projects']
const UNIT_KEYS = ['row_count', 'active_row_count', 'machine_rows', 'person_rows', 'person_rows_with_key', 'manual_rows', 'locked_rows', 'trashed_rows',
  'created_span_days', 'created_days', 'created_at_gap_clusters', 'stamped_rows', 'add_stamp_rows', 'add_stamp_iso_rows', 'add_stamp_clusters',
  'add_stamps_after_create', 'null_creator_rows', 'null_creator_rows_by_birth_source_plugin', 'null_creator_rows_by_birth_source_automation',
  'null_creator_rows_by_birth_source_public_form', 'null_creator_rows_by_birth_source_other', 'null_creator_rows_by_birth_source_none',
  'null_creator_rows_not_plugin']
const LINE_KEYS: Record<string, string[]> = {
  PROBE_SITE: ['server_encoding_utf8', 'expected_tz_known', 'db_timezone_is_expected', 'db_utc_offset_is_expected', 'registry_rows', 'webhooks_active_total',
    'webhooks_active_unbound', 'writer_systems_total', 'env_input', 'tenant_filter'],
  PROBE_PROJECT: ['kind', 'ordinal', 'registry_status', 'object_shape', 'status', 'reason', ...SHEET_KEYS, ...UNIT_KEYS],
  PROBE_ENV_SHEET: ['status', 'reason', 'in_registry', 'projects', 'rows_without_project', ...SHEET_KEYS],
  PROBE_COPY: ['ordinal', 'source_kind', 'source_ordinal', 'depth', 'deleted', 'row_count', 'person_rows', 'locked_rows', 'locked_fields', 'view_count',
    'automation_rules', 'webhooks_active'],
  PROBE_RESULT: ['file', 'status', 'reason', 'targets', 'complete', 'incomplete', 'copies', 'env'],
}
function assertValuesFreeLines(lines: PackLine[]): void {
  for (const line of lines) {
    if (line.kind === 'PROBE_PRIVATE') continue
    expect(Object.keys(LINE_KEYS), line.kind).toContain(line.kind)
    for (const [key, value] of Object.entries(line.fields)) {
      expect(LINE_KEYS[line.kind], `${line.kind} key ${key}`).toContain(key)
      expect(value, `${line.kind} ${key}`).toMatch(/^(?:\d+|[a-z][a-z0-9_-]*|01-site-probe\.sql)$/)
    }
  }
}

// The pack's own embedded plm_system list (the installed R-line build's template, pinned by the plugin suite SP-03), so a
// column main adds later does not shift the expected lock counts.
function packPlmSystemFieldIds(): string[] {
  const pack = readFileSync(PACK_FILE, 'utf8')
  const start = pack.indexOf('probe-plm-system-field-ids:begin')
  const stop = pack.indexOf('probe-plm-system-field-ids:end')
  if (start < 0 || stop < start) throw new Error('the pack lost its plm_system list markers')
  const block = pack.slice(start, stop).split(/\r?\n/).filter((line) => !line.trim().startsWith('--')).join('\n')
  return [...block.matchAll(/'([A-Za-z]+)'/g)].map((match) => match[1])
}

export function defineStockPreparationPullBatchSiteProbeRealDbCases(): void {
  test('pull-batch site probe real-DB sentinel: the real-DB step must have DATABASE_URL and psql (fail-not-skip)', () => {
    if (process.env.METASHEET_REAL_DB_TEST_STEP !== '1') return
    if (!process.env.DATABASE_URL) throw new Error('METASHEET_REAL_DB_TEST_STEP=1 but DATABASE_URL is unset — the BI-6a probe cases would skip-green')
    if (!psqlAvailable()) throw new Error(`METASHEET_REAL_DB_TEST_STEP=1 but ${PSQL} is not runnable — the BI-6a probe pack cannot be executed`)
  })

  describeIfDatabase('BI-6a pull-batch site probe: the read-only psql pack on real Postgres', () => {
    const TOKEN = `${process.pid}_${Date.now().toString(36)}`
    const TENANT = `tenant_bip_${TOKEN}`
    const PROJECT_ID = `${TENANT}:integration-core`
    const SENTINEL_PROJECT = `BIP-SENTINEL-${TOKEN}`
    const OTHER_PROJECT = `BIP-OTHER-${TOKEN}`
    const ENV_OBJECT = `plm_stock_preparation_sandbox_bip_env_${TOKEN}`
    const ENV_PROJECT_A = `P-07-${TOKEN}`
    const ENV_PROJECT_B = `S-01-${TOKEN}`
    const sheets: string[] = []
    const extraIds = { rules: [] as string[], webhooks: [] as string[], systems: [] as string[], pipelines: [] as string[] }
    const pluginContext = createProductionPluginContext()
    const multitable: any = pluginContext.api.multitable
    const registry = projectTargetStoreLib.createStockPreparationProjectTargetStore({ db: createDb({ database: pluginContext.api.database }) })
    type Sheet = { projectNo: string; objectId: string; sheetId: string; fields: Record<string, string> }
    let main: Sheet
    let env: Sheet
    const copyIds = [`sheet_bip_copy1_${TOKEN}`, `sheet_bip_copy2_${TOKEN}`]

    async function provision(objectId: string, projectNo: string, { register }: { register: boolean }): Promise<Sheet> {
      const ensured = await ensureStockPreparationSandboxTarget({ context: { api: { multitable } }, projectId: PROJECT_ID, permission: 'admin', objectId })
      expect(ensured.ready).toBe(true)
      const sheetId: string = ensured.target.sheetId
      sheets.push(sheetId)
      if (register) {
        await projectTargetsLib.markProjectSheetPlmSystemColumns({ provisioning: multitable.provisioning, projectId: PROJECT_ID, objectId })
        await registry.create({ tenantId: TENANT, projectNo, sheetId, objectId, createdBy: 'u_bip_puller' })
      }
      return { projectNo, objectId, sheetId, fields: ensured.target.fieldIdMap || {} }
    }

    // One row: created through the host records API (projectNo only), then its stored cells and envelope shaped directly.
    async function seed(sheet: Sheet, cells: Record<string, unknown>, envelope: { creator?: string; createdAt?: string; locked?: boolean; projectNo?: string | null } = {}) {
      const projectNo = envelope.projectNo === undefined ? sheet.projectNo : envelope.projectNo
      // A row WITHOUT a project is created with a placeholder project and the cell removed afterwards (the column is
      // required on create).
      const created = await multitable.records.createRecord({ sheetId: sheet.sheetId, data: { [sheet.fields.projectNo]: projectNo === null ? `BIP-PLACEHOLDER-${TOKEN}` : projectNo } })
      if (projectNo === null) await q('UPDATE meta_records SET data = data - $2::text WHERE id = $1', [created.id, sheet.fields.projectNo])
      const patch: Record<string, unknown> = {}
      for (const [logical, value] of Object.entries(cells)) {
        const physical = sheet.fields[logical]
        if (!physical) throw new Error(`fixture field ${logical} is not on the sheet`)
        patch[physical] = value
      }
      await q('UPDATE meta_records SET data = data || $2::jsonb WHERE id = $1', [created.id, JSON.stringify(patch)])
      if (envelope.creator !== undefined) await q('UPDATE meta_records SET created_by = $2 WHERE id = $1', [created.id, envelope.creator])
      if (envelope.createdAt !== undefined) await q('UPDATE meta_records SET created_at = $2::timestamptz WHERE id = $1', [created.id, envelope.createdAt])
      if (envelope.locked) await q('UPDATE meta_records SET locked = true WHERE id = $1', [created.id])
      return String(created.id)
    }

    async function runPack(extra: string[] = []) {
      const [command, args] = psqlCommand(['-X', '-q', '-d', String(process.env.DATABASE_URL), '-v', `tenant=${TENANT}`, ...extra, '-f', PACK_FILE])
      const { stdout, stderr } = await execFileAsync(command, args, { env: { ...process.env, PGCLIENTENCODING: 'UTF8' }, maxBuffer: 4 * 1024 * 1024 })
      const lines = parsePack(stdout)
      assertValuesFreeLines(lines)
      return { stdout, stderr, lines }
    }

    const envArgs = () => ['-v', `env_project_id=${PROJECT_ID}`, '-v', `env_object_id=${ENV_OBJECT}`]

    beforeAll(async () => {
      main = await provision(ownBaseLib.deriveStockPreparationProjectSheetObjectId(TENANT, SENTINEL_PROJECT), SENTINEL_PROJECT, { register: true })
      // One PLM column loses its lock (a sheet registered before R67 and never repaired looks like this, column by column).
      const unlocked = await q(`UPDATE meta_fields SET property = property - 'humanWriteLock' WHERE sheet_id = $1 AND id = $2`, [main.sheetId, main.fields.lastPlmConflictSummary])
      expect(unlocked.rowCount).toBe(1)
      // A frozen list on the host default view; a personal field order (and an empty one, which is no override) on the fill view.
      const defaultView = sha1Id('view', PROJECT_ID, main.objectId, 'default')
      const fillView = sha1Id('view', PROJECT_ID, main.objectId, 'prep-fill')
      expect((await q(`UPDATE meta_views SET config = COALESCE(config, '{}'::jsonb) || '{"frozenLeftColumnIds":["fld_bip_x"]}'::jsonb WHERE id = $1 AND sheet_id = $2`, [defaultView, main.sheetId])).rowCount).toBe(1)
      expect((await q('SELECT 1 FROM meta_views WHERE id = $1', [fillView])).rowCount).toBe(1)
      await q('INSERT INTO meta_view_personal_configs (view_id, user_id, config) VALUES ($1, $2, $3::jsonb), ($1, $4, $5::jsonb)',
        [fillView, `u_bip_a_${TOKEN}`, JSON.stringify({ fieldOrder: [main.fields.notes] }), `u_bip_b_${TOKEN}`, JSON.stringify({ fieldOrder: [] })])
      // Automation: two rules on the sheet (one enabled), one rule elsewhere whose config names the sheet.
      for (const [suffix, sheetId, enabled, config] of [
        ['on1', main.sheetId, true, {}],
        ['on2', main.sheetId, false, {}],
        ['elsewhere', `sheet_bip_elsewhere_${TOKEN}`, true, { targetSheetId: main.sheetId }],
      ] as const) {
        const id = `ar_bip_${suffix}_${TOKEN}`
        extraIds.rules.push(id)
        await q(`INSERT INTO automation_rules (id, sheet_id, name, trigger_type, action_type, action_config, enabled, created_by) VALUES ($1, $2, 'bip', 'record.created', 'notify', $3::jsonb, $4, 'u_bip')`,
          [id, sheetId, JSON.stringify(config), enabled])
      }
      // Webhooks: an active one bound to the sheet, an inactive one bound to it.
      for (const [suffix, active] of [['active', true], ['inactive', false]] as const) {
        const id = `wh_bip_${suffix}_${TOKEN}`
        extraIds.webhooks.push(id)
        await q(`INSERT INTO multitable_webhooks (id, name, url, events, active, created_by, sheet_id) VALUES ($1, 'bip', 'https://sink.test/bip', '["record.created"]'::jsonb, $2, 'u_bip', $3)`, [id, active, main.sheetId])
      }
      // A generic configured writer aimed at the sheet: a multitable target system + an active and a draft pipeline.
      const source = `es_bip_src_${TOKEN}`
      const target = `es_bip_tgt_${TOKEN}`
      extraIds.systems.push(source, target)
      await q(`INSERT INTO integration_external_systems (id, tenant_id, name, kind, role, config) VALUES ($1, $2, $3, 'http', 'source', '{}'::jsonb)`, [source, TENANT, `bip-src-${TOKEN}`])
      await q(`INSERT INTO integration_external_systems (id, tenant_id, name, kind, role, config) VALUES ($1, $2, $3, 'metasheet:multitable', 'target', $4::jsonb)`,
        [target, TENANT, `bip-tgt-${TOKEN}`, JSON.stringify({ objects: { main: { sheetId: main.sheetId, keyFields: ['idempotencyKey'], mode: 'upsert' } } })])
      for (const [suffix, status] of [['active', 'active'], ['draft', 'draft']] as const) {
        const id = `ip_bip_${suffix}_${TOKEN}`
        extraIds.pipelines.push(id)
        await q(`INSERT INTO integration_pipelines (id, tenant_id, name, source_system_id, source_object, target_system_id, target_object, status) VALUES ($1, $2, $3, $4, 'bip', $5, 'main', $6)`,
          [id, TENANT, `bip-${suffix}-${TOKEN}`, source, target, status])
      }
      // Rows of the sentinel project. Batch 1 created 2026-10-02 01:00 (plan 00:59:59), batch 2 created 2026-10-05 03:00
      // (plan 03:00:00): the batch-1 rows the second pull swept read `inactive @ p2`.
      const p1 = '2026-10-02T00:59:59.000Z'
      const p2 = '2026-10-05T03:00:00.000Z'
      await seed(main, { idempotencyKey: 'bip-k1', active: true, lastPlmRefreshDecision: 'add', lastPlmRefreshAt: p1 }, { createdAt: '2026-10-02T01:00:00Z' })
      await seed(main, { idempotencyKey: 'bip-k2', active: false, lastPlmRefreshDecision: 'inactive', lastPlmRefreshAt: p2 }, { createdAt: '2026-10-02T01:00:01Z' })
      await seed(main, { idempotencyKey: 'bip-k3', active: true, lastPlmRefreshDecision: 'add', lastPlmRefreshAt: p2 }, { createdAt: '2026-10-05T03:00:02Z' })
      await seed(main, { idempotencyKey: 'bip-k4', active: true, lastPlmRefreshDecision: 'add', lastPlmRefreshAt: p2 }, { createdAt: '2026-10-05T03:00:03Z', locked: true })
      // An impossible day (the shape passes, the day does not exist): never cast, never a cluster.
      await seed(main, { idempotencyKey: 'bip-k5', active: true, lastPlmRefreshDecision: 'add', lastPlmRefreshAt: '2026-02-30T03:00:00.000Z' }, { createdAt: '2026-10-05T03:00:04Z' })
      // A plan time AFTER the row's creation (the degenerate-createdAt sign); also a third distinct plan time.
      await seed(main, { idempotencyKey: 'bip-k6', active: true, lastPlmRefreshDecision: 'add', lastPlmRefreshAt: '2026-10-09T03:00:00.000Z' }, { createdAt: '2026-10-05T03:00:05Z' })
      // Person rows: a right-click duplicate (PLM key, a creator), a hand-made keyless row; a manual row (M′).
      await seed(main, { idempotencyKey: 'bip-k3', active: true }, { creator: 'u_bip_hand', createdAt: '2026-10-06T03:00:00Z' })
      await seed(main, { active: true }, { creator: 'u_bip_hand', createdAt: '2026-10-06T03:00:01Z' })
      await seed(main, { idempotencyKey: `manual:v1:bip-${TOKEN}`, active: true }, { creator: 'u_bip_hand', createdAt: '2026-10-06T03:00:02Z' })
      // A row of another project on the same sheet (outside every per-project count; inside sheet_rows_all_projects).
      await seed(main, { idempotencyKey: 'bip-o1', active: true, lastPlmRefreshDecision: 'add', lastPlmRefreshAt: p2 }, { createdAt: '2026-10-05T03:00:02Z', projectNo: OTHER_PROJECT })
      // A trashed row of the project, and one of the other project.
      for (const projectNo of [SENTINEL_PROJECT, OTHER_PROJECT]) {
        await q(`INSERT INTO meta_records_trash (record_id, sheet_id, data, original_version, created_by, deleted_by) VALUES ($1, $2, $3::jsonb, 1, NULL, 'u_bip')`,
          [`rec_bip_trash_${projectNo}`, main.sheetId, JSON.stringify({ [main.fields.projectNo]: projectNo })])
      }
      // A sheet copy of the project sheet (live, two rows, one with the source creator) and a soft-deleted copy of the copy.
      await q(`INSERT INTO meta_sheets (id, base_id, name, copied_from_sheet_id, copied_from_kind, copied_at) SELECT $1, base_id, 'bip copy', $2, 'plugin-managed', $3::timestamptz FROM meta_sheets WHERE id = $2`, [copyIds[0], main.sheetId, '2026-10-07T00:00:00Z'])
      await q(`INSERT INTO meta_sheets (id, base_id, name, copied_from_sheet_id, copied_from_kind, copied_at) SELECT $1, base_id, 'bip copy 2', $2, 'user', $3::timestamptz FROM meta_sheets WHERE id = $2`, [copyIds[1], copyIds[0], '2026-10-08T00:00:00Z'])
      await q(`UPDATE meta_sheets SET deleted_at = now() WHERE id = $1`, [copyIds[1]])
      sheets.push(...copyIds)
      await q(`INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1, $2, '{}'::jsonb, 1, 'u_bip_src'), ($3, $2, '{}'::jsonb, 1, NULL)`, [`rec_bip_c1_${TOKEN}`, copyIds[0], `rec_bip_c2_${TOKEN}`])

      // The env-bound sheet: not registered; rows of two projects and one row without a project.
      env = await provision(ENV_OBJECT, '', { register: false })
      await seed(env, { idempotencyKey: 'bip-e1', active: true }, { projectNo: ENV_PROJECT_A, createdAt: '2026-09-02T00:00:00Z' })
      await seed(env, { idempotencyKey: 'bip-e2', active: false }, { projectNo: ENV_PROJECT_A, createdAt: '2026-09-04T00:00:00Z' })
      await seed(env, { idempotencyKey: 'bip-e3', active: true }, { projectNo: ENV_PROJECT_B, creator: 'u_bip_hand', createdAt: '2026-09-03T00:00:00Z' })
      await seed(env, { idempotencyKey: 'bip-e4', active: true }, { projectNo: null, createdAt: '2026-09-03T00:00:00Z' })
    }, 300000)

    afterAll(async () => {
      await q('DELETE FROM integration_stock_prep_project_target WHERE tenant_id = $1', [TENANT]).catch(() => {})
      await q('DELETE FROM integration_pipelines WHERE id = ANY($1::text[])', [extraIds.pipelines]).catch(() => {})
      await q('DELETE FROM integration_external_systems WHERE id = ANY($1::text[])', [extraIds.systems]).catch(() => {})
      await q('DELETE FROM multitable_webhooks WHERE id = ANY($1::text[])', [extraIds.webhooks]).catch(() => {})
      await q('DELETE FROM automation_rules WHERE id = ANY($1::text[])', [extraIds.rules]).catch(() => {})
      for (const sheetId of sheets) {
        await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_view_personal_configs WHERE view_id IN (SELECT id FROM meta_views WHERE sheet_id = $1)', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_views WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_sheets WHERE id = $1', [sheetId]).catch(() => {})
      }
    })

    function requirePsql(label: string): boolean {
      if (psqlAvailable()) return true
      if (process.env.METASHEET_REAL_DB_TEST_STEP === '1') throw new Error('psql is required in the real-DB step')
      console.warn(`[${label}] psql not runnable — skipped outside the real-DB step`)
      return false
    }

    // The context route's order (`created_at ASC`), compared at the database's own (microsecond) precision.
    async function firstViewOf(sheet: Sheet): Promise<{ firstView: string; atFirst: number }> {
      const row = (await q(
        'SELECT count(*)::int AS n, array_agg(id) AS ids FROM meta_views WHERE sheet_id = $1 AND created_at = (SELECT min(created_at) FROM meta_views WHERE sheet_id = $1)',
        [sheet.sheetId],
      )).rows[0] as { n: number; ids: string[] | null }
      if (row.n === 0) return { firstView: 'none', atFirst: 0 }
      if (row.n > 1) return { firstView: 'tie', atFirst: row.n }
      const byId = new Map(['default', 'prep-fill', 'prep-todo'].map((logical) => [sha1Id('view', PROJECT_ID, sheet.objectId, logical), logical]))
      return { firstView: byId.get(row.ids![0]) || 'other', atFirst: 1 }
    }

    test('BI-PROBE-RD-01 every number on the project line equals the fixture; the first view is the context route\'s; copies are listed; the default output is values-free', async () => {
      if (!requirePsql('BI-PROBE-RD-01')) return
      const plain = await runPack()
      const priv = await runPack(['-v', 'emit_private_map=1'])
      expect(main.sheetId).toBe(sha1Id('sheet', PROJECT_ID, main.objectId))
      const privateLines = priv.lines.filter((line) => line.kind === 'PROBE_PRIVATE')
      const ordinal = privateLines.find((line) => line.fields.kind === 'project' && line.fields.object_id === main.objectId)!.fields.ordinal
      const projectLine = plain.lines.find((line) => line.kind === 'PROBE_PROJECT' && line.fields.kind === 'project' && line.fields.ordinal === ordinal)!
      expect(projectLine).toBeTruthy()
      const { firstView, atFirst } = await firstViewOf(main)
      const labels = templatesLib.resolveTemplateLabelLocale() === 'zh-CN' ? 'zh' : 'en'
      const plmTotal = packPlmSystemFieldIds().length
      expect(plmTotal).toBe(20)
      expect(projectLine.fields).toEqual({
        kind: 'project', ordinal, registry_status: 'active', object_shape: 'derived', status: 'complete',
        plm_lock: 'partial', plm_cols_locked: String(plmTotal - 1), plm_cols_unlocked: '1', plm_cols_missing: '0', labels,
        view_count: String((await q('SELECT count(*)::int AS n FROM meta_views WHERE sheet_id = $1', [main.sheetId])).rows[0].n),
        first_view: firstView, views_at_first: String(atFirst),
        plugin_views: String((await q('SELECT count(*)::int AS n FROM meta_views WHERE sheet_id = $1 AND id = ANY($2::text[])',
          [main.sheetId, ['prep-fill', 'prep-todo'].map((logical) => sha1Id('view', PROJECT_ID, main.objectId, logical))])).rows[0].n),
        views_with_frozen: '1', personal_order_overrides: '1',
        automation_rules: '2', automation_rules_enabled: '1', automation_rules_elsewhere: '1', webhooks_active: '1',
        writer_systems: '1', writer_pipelines: '2', writer_pipelines_active: '1', copies: '2', sheet_rows_all_projects: '10',
        row_count: '9', active_row_count: '8', machine_rows: '6', person_rows: '2', person_rows_with_key: '1', manual_rows: '1',
        locked_rows: '1', trashed_rows: '1', created_span_days: '4', created_days: expect.stringMatching(/^[34]$/),
        created_at_gap_clusters: '2', stamped_rows: '6', add_stamp_rows: '5', add_stamp_iso_rows: '4', add_stamp_clusters: '3',
        add_stamps_after_create: '1',
        // The six machine rows came through the plugin records API (birth revision source 'plugin'); their keys are not
        // JSON, so all six fail the plugin-row test.
        null_creator_rows: '6', null_creator_rows_by_birth_source_plugin: '6', null_creator_rows_by_birth_source_automation: '0',
        null_creator_rows_by_birth_source_public_form: '0', null_creator_rows_by_birth_source_other: '0', null_creator_rows_by_birth_source_none: '0',
        null_creator_rows_not_plugin: '6',
      })
      // The copies: depth 1 live with its rows, depth 2 soft-deleted; both lead back to this project's ordinal.
      const copies = plain.lines.filter((line) => line.kind === 'PROBE_COPY' && line.fields.source_kind === 'project' && line.fields.source_ordinal === ordinal)
      expect(copies.map((line) => [line.fields.depth, line.fields.deleted, line.fields.row_count, line.fields.person_rows])).toEqual([['1', 'no', '2', '1'], ['2', 'yes', '0', '0']])
      const copyOrdinals = new Set(copies.map((line) => line.fields.ordinal))
      expect(privateLines.filter((line) => line.fields.kind === 'copy' && copyOrdinals.has(line.fields.ordinal)).map((line) => line.fields.sheet_id).sort()).toEqual([...copyIds].sort())
      // Site line: tokens only; the result line is last.
      const site = plain.lines.find((line) => line.kind === 'PROBE_SITE')!
      expect(site.fields).toMatchObject({ server_encoding_utf8: 'yes', env_input: 'absent', tenant_filter: 'on', registry_rows: '1' })
      for (const key of ['expected_tz_known', 'db_timezone_is_expected']) expect(['yes', 'no']).toContain(site.fields[key])
      expect(['yes', 'no', 'unknown']).toContain(site.fields.db_utc_offset_is_expected)
      const result = plain.lines[plain.lines.length - 1]
      expect(result.kind).toBe('PROBE_RESULT')
      expect(result.fields).toMatchObject({ status: 'complete', targets: '1', complete: '1', incomplete: '0', env: 'absent' })
      // Values-free on the real output.
      for (const needle of [SENTINEL_PROJECT, OTHER_PROJECT, TENANT, main.objectId, main.sheetId, ...copyIds, 'bip-k', 'u_bip', '2026-10']) {
        expect(plain.stdout.includes(needle), needle).toBe(false)
      }
      expect(plain.lines.every((line) => line.kind !== 'PROBE_PRIVATE')).toBe(true)
      expect(priv.stdout.includes(main.objectId)).toBe(true)
      expect(priv.stdout.includes(SENTINEL_PROJECT)).toBe(false)
    }, 300000)

    test('BI-PROBE-RD-02 the env sheet reports per project; a wrong env sheet id and a non-derived registry sheet id fail closed with no numbers', async () => {
      if (!requirePsql('BI-PROBE-RD-02')) return
      const withEnv = await runPack(envArgs())
      const envSheet = withEnv.lines.find((line) => line.kind === 'PROBE_ENV_SHEET')!
      expect(envSheet.fields).toMatchObject({ status: 'complete', in_registry: 'no', projects: '2', rows_without_project: '1', plm_lock: 'none', plm_cols_locked: '0', sheet_rows_all_projects: '4', copies: '0' })
      const privEnv = await runPack([...envArgs(), '-v', 'emit_private_map=1'])
      const ordinalOf = new Map(privEnv.lines.filter((line) => line.kind === 'PROBE_PRIVATE' && line.fields.kind === 'env').map((line) => [line.fields.project_no, line.fields.ordinal]))
      // Ordinals follow each project's first created_at: A (09-02) before B (09-03).
      expect([ordinalOf.get(ENV_PROJECT_A), ordinalOf.get(ENV_PROJECT_B)]).toEqual(['1', '2'])
      const envLine = (projectNo: string) => withEnv.lines.find((line) => line.kind === 'PROBE_PROJECT' && line.fields.kind === 'env' && line.fields.ordinal === ordinalOf.get(projectNo))!.fields
      expect(envLine(ENV_PROJECT_A)).toMatchObject({ status: 'complete', row_count: '2', active_row_count: '1', machine_rows: '2', person_rows: '0', created_span_days: '2', created_at_gap_clusters: '2' })
      expect(envLine(ENV_PROJECT_B)).toMatchObject({ status: 'complete', row_count: '1', machine_rows: '0', person_rows: '1', person_rows_with_key: '1', created_at_gap_clusters: '0' })
      expect(withEnv.lines[withEnv.lines.length - 1].fields).toMatchObject({ status: 'complete', targets: '2', env: 'complete' })
      for (const needle of [ENV_OBJECT, ENV_PROJECT_A, ENV_PROJECT_B, env.sheetId, PROJECT_ID]) expect(withEnv.stdout.includes(needle), needle).toBe(false)

      // A wrong env sheet id, and a registry row whose sheet id is not the derived one.
      const mismatchProject = `BIP-MISMATCH-${TOKEN}`
      const mismatchObject: string = ownBaseLib.deriveStockPreparationProjectSheetObjectId(TENANT, mismatchProject)
      await q('INSERT INTO integration_stock_prep_project_target (id, tenant_id, project_no, sheet_id, object_id, status) VALUES ($1, $2, $3, $4, $5, $6)',
        [`spt_bip_mm_${TOKEN}`, TENANT, mismatchProject, `sheet_bip_not_derived_${TOKEN}`, mismatchObject, 'active'])
      const broken = await runPack([...envArgs(), '-v', `env_sheet_id=sheet_bip_wrong_${TOKEN}`])
      expect(broken.stdout.split(/\r?\n/).find((line) => line.startsWith('PROBE_ENV_SHEET '))).toBe('PROBE_ENV_SHEET status=incomplete reason=sheet_id_mismatch')
      expect(broken.lines.some((line) => line.kind === 'PROBE_PROJECT' && line.fields.kind === 'env')).toBe(false)
      const mismatchLine = broken.stdout.split(/\r?\n/).find((line) => line.startsWith('PROBE_PROJECT kind=project ') && line.includes(' status=incomplete'))
      expect(mismatchLine).toMatch(/^PROBE_PROJECT kind=project ordinal=\d+ registry_status=active object_shape=derived status=incomplete reason=sheet_id_mismatch$/)
      expect(broken.lines[broken.lines.length - 1].fields).toMatchObject({ status: 'incomplete', reason: 'target_checks_failed', targets: '3', complete: '1', incomplete: '2', env: 'incomplete' })
      expect(broken.stdout.includes(mismatchProject) || broken.stdout.includes(mismatchObject)).toBe(false)
    }, 300000)

    test('BI-PROBE-RD-03 creator-absent rows are split by the writer that created them, and the rows failing the plugin-row test are counted', async () => {
      if (!requirePsql('BI-PROBE-RD-03')) return
      const birthProject = `BIP-BIRTH-${TOKEN}`
      const birth = await provision(ownBaseLib.deriveStockPreparationProjectSheetObjectId(TENANT, birthProject), birthProject, { register: true })
      const plan = '2026-10-12T02:00:00.000Z'
      const jsonKey = (tag: string) => JSON.stringify({ bip: tag, token: TOKEN })
      // Every row is born through the plugin records API (create revision source 'plugin'); the birth revision of some is
      // then reshaped to what the other writers leave: automation-executor create_record and the anonymous public-form
      // submit insert a creator-absent row with a create revision of their own source.
      await seed(birth, { idempotencyKey: jsonKey('p1'), active: true, lastPlmRefreshDecision: 'add', lastPlmRefreshAt: plan }, { createdAt: '2026-10-12T02:00:01Z' })
      await seed(birth, { idempotencyKey: jsonKey('p2'), active: true }, { createdAt: '2026-10-12T02:00:02Z' })
      const automation = await seed(birth, { idempotencyKey: `bip-auto-${TOKEN}`, active: true }, { createdAt: '2026-10-12T03:00:00Z' })
      const form = await seed(birth, { active: true }, { createdAt: '2026-10-12T04:00:00Z' })
      const other = await seed(birth, { idempotencyKey: jsonKey('o1'), active: true, lastPlmRefreshDecision: 'add', lastPlmRefreshAt: plan }, { createdAt: '2026-10-12T02:00:03Z' })
      const legacy = await seed(birth, { idempotencyKey: jsonKey('n1'), active: true, lastPlmRefreshDecision: 'add', lastPlmRefreshAt: plan }, { createdAt: '2026-10-12T02:00:04Z' })
      await seed(birth, { idempotencyKey: `manual:bip-unbound-${TOKEN}`, active: true }, { createdAt: '2026-10-12T05:00:00Z' })
      await seed(birth, { idempotencyKey: jsonKey('h1'), active: true, lastPlmRefreshDecision: 'add', lastPlmRefreshAt: plan }, { creator: 'u_bip_hand', createdAt: '2026-10-12T06:00:00Z' })
      const created = await q(`SELECT record_id, source FROM meta_record_revisions WHERE sheet_id = $1 AND action = 'create'`, [birth.sheetId])
      expect(created.rows.length).toBe(8)
      expect(new Set(created.rows.map((row: { source: string }) => row.source))).toEqual(new Set(['plugin']))
      const reshape = async (recordId: string, sql: string) => expect((await q(sql, [birth.sheetId, recordId])).rowCount).toBe(1)
      await reshape(automation, `UPDATE meta_record_revisions SET source = 'automation' WHERE sheet_id = $1 AND record_id = $2 AND action = 'create'`)
      await reshape(form, `UPDATE meta_record_revisions SET source = 'public-form' WHERE sheet_id = $1 AND record_id = $2 AND action = 'create'`)
      await reshape(other, `UPDATE meta_record_revisions SET source = 'rest' WHERE sheet_id = $1 AND record_id = $2 AND action = 'create'`)
      // A row older than revision recording: no create revision; a later automation UPDATE is not its birth.
      await reshape(legacy, `UPDATE meta_record_revisions SET action = 'update', source = 'automation', version = 2 WHERE sheet_id = $1 AND record_id = $2 AND action = 'create'`)

      const plain = await runPack()
      const priv = await runPack(['-v', 'emit_private_map=1'])
      const ordinal = priv.lines.find((line) => line.kind === 'PROBE_PRIVATE' && line.fields.kind === 'project' && line.fields.object_id === birth.objectId)!.fields.ordinal
      const line = plain.lines.find((entry) => entry.kind === 'PROBE_PROJECT' && entry.fields.kind === 'project' && entry.fields.ordinal === ordinal)!
      expect(line.fields).toMatchObject({
        status: 'complete', row_count: '8', person_rows: '1', manual_rows: '0',
        // machine_rows keeps its own rule (no creator, not `manual:v1:`), so the unbound `manual:` row is in it; the split
        // uses the shared raw `manual:` predicate and leaves it out.
        machine_rows: '7', null_creator_rows: '6',
        null_creator_rows_by_birth_source_plugin: '2', null_creator_rows_by_birth_source_automation: '1',
        null_creator_rows_by_birth_source_public_form: '1', null_creator_rows_by_birth_source_other: '1',
        null_creator_rows_by_birth_source_none: '1',
        // Failing the plugin-row test: the forged JSON key (no RUN stamp), the automation row, the form row.
        null_creator_rows_not_plugin: '3',
      })
      for (const needle of [birthProject, birth.objectId, birth.sheetId, 'bip-auto', 'manual:bip', '"bip"', 'u_bip', '2026-10']) {
        expect(plain.stdout.includes(needle), needle).toBe(false)
      }
    }, 300000)
  })
}
