import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { expect } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'

const require = createRequire(import.meta.url)
const plugin = '../../../../plugins/plugin-integration-core/lib/'
const large = require(plugin + 'stock-preparation-large-bom-jobs.cjs').__internals
const dry = require(plugin + 'stock-preparation-dry-run-jobs.cjs').__internals
const actions = require(plugin + 'stock-preparation-table-actions.cjs')
const { sheetWriteScopeKey } = require(plugin + 'stock-preparation-project-write-lock.cjs')
const q = (sql: string, values: unknown[]) => poolManager.get().query(sql, values)
const kvPlugin = 'plugin-integration-core'
type Scope = { tenantId: string; projectNo: string; actor: string }
type Preview = { verificationCode: string; challengeId: string; counts: { runtimeRecords: number } }
type Service = { preview(scope: Scope): Promise<Preview>; confirm(input: Scope & Preview): Promise<{ counts: Preview['counts'] }> }

export async function checkProjectDeleteRuntime(scope: Scope, service: Service, dedicatedId: string, sharedId: string) {
  const actionId = actions.PLM_STOCK_PREPARATION_ACTION_ID
  const job = (owner: Scope, sheetId: string, status: string) => ({
    tenantId: owner.tenantId, workspaceId: 'synthetic-workspace', actionId, jobId: randomUUID(), status,
    parameters: { projectNo: owner.projectNo }, actionSnapshot: { target: { sheetId } },
  })
  const unrelated = { ...scope, projectNo: 'another-project' }
  const parent = job(scope, sharedId, 'running')
  const neighbor = job(unrelated, sharedId, 'running')
  const checkpoint = { tenantId: scope.tenantId, workspaceId: parent.workspaceId, actionId, applyJobId: randomUUID(),
    sourceJobId: parent.jobId, target: { sheetId: sharedId }, status: 'running' }
  const targetDry = { ...scope, actionId }
  const legacyKey = dry.dryRunJobRecordKey({ ...targetDry, principal: scope.actor + '@example.test', valueBearing: false })
  const newDryKey = dry.dryRunJobRecordKey({ ...targetDry, principal: scope.actor, valueBearing: true })
  const token = (sheet: string, projectNo: string) => ({
    writeScope: sheetWriteScopeKey(sheet), parametersHash: actions.__internals.hashJson({ projectNo }), actionId,
  })
  const tokenKey = () => 'integration:table-action:dry-run-token:' + randomUUID()
  const owned = [
    [large.backgroundJobKey(parent), parent],
    [large.checkpointApplyJobKey(checkpoint), checkpoint],
    [legacyKey, { status: 'succeeded', result: { synthetic: 'legacy' } }],
    [newDryKey, { status: 'succeeded', targetKey: dry.dryRunJobTargetKey(targetDry) }],
    [tokenKey(), token(dedicatedId, scope.projectNo)],
    [tokenKey(), token(sharedId, scope.projectNo)],
  ] as const
  const controls = [
    [large.backgroundJobKey(neighbor), neighbor],
    [dry.dryRunJobRecordKey({ ...unrelated, actionId, principal: scope.actor, valueBearing: false }), { status: 'running' }],
    [tokenKey(), token(sharedId, unrelated.projectNo)],
  ] as const
  const keys = [...owned, ...controls].map(([key]) => key)
  const rows = async (subset: string[]) => (await q('SELECT * FROM plugin_kv WHERE plugin = $1 AND key = ANY($2::text[]) ORDER BY key', [kvPlugin, subset])).rows
  const terminal = (key: string, status: string) => q("UPDATE plugin_kv SET value = jsonb_set(value, '{status}', to_jsonb($3::text)), updated_at = now() WHERE plugin = $1 AND key = $2", [kvPlugin, key, status])
  try {
    for (const [key, value] of [...owned, ...controls]) {
      await q('INSERT INTO plugin_kv (plugin, key, value) VALUES ($1,$2,$3::jsonb)', [kvPlugin, key, JSON.stringify(value)])
    }
    const retained = await rows(controls.map(([key]) => key))
    expect(retained).toHaveLength(controls.length)
    await expect(service.preview(scope)).rejects.toMatchObject({ code: 'STOCK_PREPARATION_PROJECT_DELETE_BUSY' })
    await terminal(owned[0][0], 'completed')
    await expect(service.preview(scope)).rejects.toMatchObject({ code: 'STOCK_PREPARATION_PROJECT_DELETE_BUSY' })
    await terminal(owned[1][0], 'succeeded')
    const preview = await service.preview(scope)
    expect(preview.counts.runtimeRecords).toBe(owned.length)
    const done = await service.confirm({ ...scope, ...preview })
    expect(done.counts.runtimeRecords).toBe(owned.length)
    expect(await rows(owned.map(([key]) => key))).toEqual([])
    expect(await rows(controls.map(([key]) => key))).toEqual(retained)
  } finally {
    await q('DELETE FROM plugin_kv WHERE plugin = $1 AND key = ANY($2::text[])', [kvPlugin, keys])
  }
}
