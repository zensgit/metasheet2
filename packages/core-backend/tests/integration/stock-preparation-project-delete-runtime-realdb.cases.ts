import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { expect } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'

const require = createRequire(import.meta.url)
const plugin = '../../../../plugins/plugin-integration-core/lib/'
const large = require(plugin + 'stock-preparation-large-bom-jobs.cjs').__internals
const dry = require(plugin + 'stock-preparation-dry-run-jobs.cjs').__internals
const policies = require(plugin + 'stock-preparation-conflict-policies.cjs')
const { duplicateExpandedKeyDiagnosticsForRows } = require(plugin + 'stock-preparation-conflict-planner.cjs')
const { deriveStockPreparationProjectSheetObjectId } = require(plugin + 'stock-preparation-own-base.cjs')
const actions = require(plugin + 'stock-preparation-table-actions.cjs')
const { sheetWriteScopeKey } = require(plugin + 'stock-preparation-project-write-lock.cjs')
const q = (sql: string, values: unknown[]) => poolManager.get().query(sql, values)
const kvPlugin = 'plugin-integration-core'
type Scope = { tenantId: string; projectNo: string; actor: string }
type Preview = { verificationCode: string; challengeId: string; counts: { runtimeRecords: number } }
type Service = { preview(scope: Scope): Promise<Preview>; confirm(input: Scope & Preview): Promise<{ counts: Preview['counts'] }> }

export async function checkProjectDeleteRuntime(scope: Scope, service: Service, dedicatedId: string, sharedId: string, recreate: () => Promise<string>) {
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
  const orphanedKey = dry.dryRunJobRecordKey({ ...targetDry, principal: randomUUID(), valueBearing: false })
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
  const objectId = deriveStockPreparationProjectSheetObjectId(scope.tenantId, scope.projectNo)
  const policyAction = (sheetId: string, object: string) => ({ actionId, target: { sheetId, objectId: object, keyField: 'idempotencyKey' } })
  const currentAction = policyAction(dedicatedId, objectId)
  const historical = { ...currentAction, target: { ...currentAction.target, keyField: 'retiredKey' } }
  const sharedAction = policyAction(sharedId, 'shared-synthetic')
  const neighborAction = policyAction('neighbor-' + dedicatedId, 'neighbor-synthetic')
  const policyKey = policies.__internals.conflictPolicyStoreKey
  const store = {
    get: async (key: string) => (await q('SELECT value FROM plugin_kv WHERE plugin=$1 AND key=$2', [kvPlugin, key])).rows[0]?.value,
    set: async (key: string, value: unknown) => q(`INSERT INTO plugin_kv(plugin,key,value) VALUES($1,$2,$3::jsonb)
      ON CONFLICT(plugin,key) DO UPDATE SET value=excluded.value, updated_at=clock_timestamp()`, [kvPlugin, key, JSON.stringify(value)]),
  }
  const diagnostics = duplicateExpandedKeyDiagnosticsForRows([
    { idempotencyKey: 'same', sourceDetailId: 'one', totalQuantity: 1 },
    { idempotencyKey: 'same', sourceDetailId: 'two', totalQuantity: 2 },
  ])
  const fingerprint = diagnostics.groups[0].fingerprint
  const review = async (sheetId: string) => policies.buildConflictPolicyReview({
    diagnostics, tableScopeReview: await policies.loadTableScopeConflictPolicies({ action: policyAction(sheetId, objectId), policyStore: store }),
  }).selectedPolicies.map((r: { scope: string, policy: string }) => [r.scope, r.policy])
  const policyKeys = [currentAction, sharedAction, neighborAction].map(policyKey)
  const keys = [...owned, ...controls].map(([key]) => key).concat(policyKeys, orphanedKey, policyKey(historical), policies.__internals.policyGenerationKey(dedicatedId))
  const rows = async (subset: string[]) => (await q('SELECT * FROM plugin_kv WHERE plugin = $1 AND key = ANY($2::text[]) ORDER BY key', [kvPlugin, subset])).rows
  const terminal = (key: string, status: string) => q("UPDATE plugin_kv SET value = jsonb_set(value, '{status}', to_jsonb($3::text)), updated_at = now() WHERE plugin = $1 AND key = $2", [kvPlugin, key, status])
  try {
    for (const [key, value] of [...owned, ...controls]) {
      await q('INSERT INTO plugin_kv (plugin, key, value) VALUES ($1,$2,$3::jsonb)', [kvPlugin, key, JSON.stringify(value)])
    }
    for (const action of [currentAction, sharedAction, neighborAction, historical]) {
      await policies.saveTableScopeConflictPolicies({ action, policyStore: store, approver: scope.actor,
        request: { policies: [{ fingerprint, policy: 'keep_multiple_rows' }] } })
    }
    const controlKeys = [...controls.map(([key]) => key), ...policyKeys.slice(1)]
    const retained = await rows(controlKeys)
    expect(retained).toHaveLength(controls.length + 2)
    expect(await review(dedicatedId)).toEqual([['table_scope', 'keep_multiple_rows']])
    await expect(service.preview(scope)).rejects.toMatchObject({ code: 'STOCK_PREPARATION_PROJECT_DELETE_BUSY' })
    await terminal(owned[0][0], 'completed')
    await expect(service.preview(scope)).rejects.toMatchObject({ code: 'STOCK_PREPARATION_PROJECT_DELETE_BUSY' })
    await terminal(owned[1][0], 'succeeded')
    const savedPolicy = await store.get(policyKeys[0])
    await store.set(policyKeys[0], { ...savedPolicy, targetScopeFingerprint: 'wrong-scope' })
    await expect(service.preview(scope)).rejects.toMatchObject({ code: 'STOCK_PREPARATION_PROJECT_DELETE_AMBIGUOUS' })
    await store.set(policyKeys[0], savedPolicy)
    // An old receipt whose principal is absent cannot be assigned, even when its work has finished.
    await store.set(orphanedKey, { status: 'succeeded' })
    await expect(service.preview(scope)).rejects.toMatchObject({ code: 'STOCK_PREPARATION_PROJECT_DELETE_AMBIGUOUS' })
    await q('DELETE FROM plugin_kv WHERE plugin = $1 AND key = $2', [kvPlugin, orphanedKey])
    const superseded = await service.preview(scope)
    // Older stored records may carry only the approved policies; their exact key is still attributable.
    await store.set(policyKeys[0], { policies: savedPolicy.policies })
    await expect(service.confirm({ ...scope, ...superseded })).rejects.toMatchObject({ code: 'STOCK_PREPARATION_PROJECT_DELETE_STALE' })
    const preview = await service.preview(scope)
    expect(preview.counts.runtimeRecords).toBe(owned.length + 1)
    const done = await service.confirm({ ...scope, ...preview })
    expect(done.counts.runtimeRecords).toBe(owned.length + 1)
    expect(await rows(owned.map(([key]) => key))).toEqual([])
    expect(await rows(controlKeys)).toEqual(retained)
    const rebuilt = await recreate()
    expect(rebuilt).toBe(dedicatedId)
    expect(await review(rebuilt)).toEqual([['default', 'hold']])
    expect((await policies.loadTableScopeConflictPolicies({ action: historical, policyStore: store })).policies).toEqual([])
    const replacement = await policies.saveTableScopeConflictPolicies({ action: historical, policyStore: store, approver: scope.actor,
      request: { policies: [{ fingerprint, policy: 'keep_multiple_rows' }] } })
    expect(replacement.policyCount).toBe(1)
    expect(await policies.loadTableScopeConflictPolicies({ action: historical, policyStore: store })).toEqual(replacement)
  } finally {
    await q('DELETE FROM plugin_kv WHERE plugin = $1 AND key = ANY($2::text[])', [kvPlugin, keys])
  }
}
