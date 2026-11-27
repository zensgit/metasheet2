import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { expect, test } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { composeBaselineOverlay } from '../../src/multitable/exact-anchor-recovery'
import { activateCheckpoint } from '../../src/multitable/history-trust-checkpoint'
import { reconstructRecordsAtSeq } from '../../src/multitable/record-reconstructor'
import type { ProjectDeleteTestStack } from './stock-preparation-project-delete-realdb.cases'

const require = createRequire(import.meta.url)
const { ensureStockPreparationSandboxTarget } = require('../../../../plugins/plugin-integration-core/lib/stock-preparation-target-provisioning.cjs')
const q = (sql: string, values: unknown[] = []) => poolManager.get().query(sql, values)
type Scope = { tenantId: string; projectNo: string; actor: string }

async function adopted(fixture: ProjectDeleteTestStack, scope: Scope) {
  await fixture.admitAdmins(scope.tenantId)
  const objectId = 'plm_stock_preparation_sandbox_adopted'
  const projectId = scope.tenantId + ':integration-core'
  const { target } = await ensureStockPreparationSandboxTarget({ context: fixture.context, projectId, objectId, permission: 'admin' })
  const sheetId: string = target.sheetId
  await fixture.registry.create({ ...scope, objectId, sheetId, createdBy: scope.actor, maxPerTenant: 200 })
  const projectField = fixture.provisioning.getFieldId(projectId, objectId, 'projectNo')
  const mine = await fixture.records.createRecord({ sheetId, data: { [projectField]: scope.projectNo } })
  const neighbor = await fixture.records.createRecord({ sheetId, data: { [projectField]: 'control' } })
  return { sheetId, projectId, objectId, projectField, mine: mine.id, neighbor: neighbor.id }
}

export function registerProjectDeleteAdoptionCases(getFixture: () => ProjectDeleteTestStack, newScope: (name: string) => Scope) {
  test('adopted pull-only sandbox releases its project registration while retaining the managed sheet and neighbor', async () => {
    const fixture = getFixture()
    const scope = newScope('adopted')
    const { sheetId, projectId, objectId, projectField, mine, neighbor } = await adopted(fixture, scope)
    const before = (await q('SELECT id, data FROM meta_records WHERE sheet_id = $1 AND id = $2', [sheetId, neighbor])).rows
    expect(before).toHaveLength(1)
    expect(before[0].data[projectField]).toBe('control')
    const preview = await fixture.service.preview(scope)
    expect(preview.counts).toMatchObject({ dedicatedSheets: 0, managedRegistrations: 0, projectTargets: 1, sharedPullRows: 1 })
    expect(preview.tables).toEqual([{ sheetId, kind: 'shared', name: expect.any(String), rowCount: 1 }])
    const result = await fixture.service.confirm({ ...scope, challengeId: preview.challengeId, verificationCode: preview.verificationCode })
    expect(result.counts).toEqual(preview.counts)
    expect((await q('SELECT id, data FROM meta_records WHERE sheet_id = $1 ORDER BY id', [sheetId])).rows).toEqual(before)
    expect((await q('SELECT id FROM meta_records_trash WHERE sheet_id = $1 AND record_id = $2', [sheetId, mine])).rows).toEqual([])
    expect((await q('SELECT sheet_id, project_id, object_id, plugin_name FROM plugin_multitable_object_registry WHERE sheet_id = $1', [sheetId])).rows).toEqual([
      { sheet_id: sheetId, project_id: projectId, object_id: objectId, plugin_name: 'plugin-integration-core' },
    ])
    expect(await fixture.provisioning.findObjectSheet({ projectId, objectId })).toMatchObject({ id: sheetId })
    expect(await fixture.registry.list({ tenantId: scope.tenantId })).toEqual([])
    const rebuilt = await fixture.dedicated(scope, false)
    expect(rebuilt.sheetId).not.toBe(sheetId)
    expect((await q('SELECT id FROM meta_records WHERE sheet_id = $1', [rebuilt.sheetId])).rows).toEqual([])
  }, 60000)

  test('ordinary shared pull rows must agree with their mapped PLM key before preview and confirmation', async () => {
    const fixture = getFixture()
    const scope = newScope('shared-key')
    await fixture.admitAdmins(scope.tenantId)
    const objectId = 'plm_stock_preparation_sandbox_shared_key'
    const projectId = scope.tenantId + ':integration-core'
    const { target } = await ensureStockPreparationSandboxTarget({ context: fixture.context, projectId, objectId, permission: 'admin' })
    const sheetId: string = target.sheetId
    const owner = fixture.provisioning.getFieldId(projectId, objectId, 'projectNo')
    const key = fixture.provisioning.getFieldId(projectId, objectId, 'idempotencyKey')
    const bound = { ...scope, boundTarget: { sheetId, objectId, keyField: 'externalKey', fieldIdMap: { projectNo: owner, externalKey: key } } }
    const current = JSON.stringify({ projectNo: scope.projectNo })
    const other = JSON.stringify({ projectNo: 'CONTROL' })
    const mine = await fixture.records.createRecord({ sheetId, data: { [owner]: scope.projectNo, [key]: current } })
    const neighbor = await fixture.records.createRecord({ sheetId, data: { [owner]: 'CONTROL', [key]: other } })
    const plan = await fixture.service.preview(bound)
    const refusal = { status: 409, code: 'STOCK_PREPARATION_PROJECT_DELETE_AMBIGUOUS' }
    const setKey = (id: string, value: string) => q('UPDATE meta_records SET data = data || jsonb_build_object($3::text,$4::text) WHERE sheet_id=$1 AND id=$2', [sheetId, id, key, value])
    await setKey(mine.id, other)
    await expect(fixture.service.confirm({ ...bound, challengeId: plan.challengeId, verificationCode: plan.verificationCode })).rejects.toMatchObject(refusal)
    await setKey(mine.id, current)
    await setKey(neighbor.id, current)
    await expect(fixture.service.preview(bound)).rejects.toMatchObject(refusal)
    await setKey(neighbor.id, other)
    const verified = await fixture.service.preview(bound)
    expect(verified.counts.sharedPullRows).toBe(1)
    await fixture.service.confirm({ ...bound, challengeId: verified.challengeId, verificationCode: verified.verificationCode })
    expect((await q('SELECT id, data FROM meta_records WHERE sheet_id=$1', [sheetId])).rows)
      .toEqual([{ id: neighbor.id, data: expect.objectContaining({ [owner]: 'CONTROL', [key]: other }) }])
  }, 60000)

  test('shared baseline preserves both projects at the later operation of the surviving project', async () => {
    const fixture = getFixture()
    const scope = newScope('checkpoint')
    const { sheetId, projectField, mine, neighbor } = await adopted(fixture, scope)
    // A preview issued BEFORE the checkpoint must also be blocked at confirmation.
    const preview = await fixture.service.preview(scope)
    const checkpoint = await poolManager.get().transaction(({ query }) => activateCheckpoint(query, { sheetId }))
    expect(checkpoint.baselineCount).toBe(2)
    const operationId = randomUUID()
    const seq = await poolManager.get().transaction(async ({ query }) => {
      const updated = await query('UPDATE meta_records SET version = version + 1 WHERE sheet_id = $1 AND id = $2 RETURNING version, data', [sheetId, neighbor])
      const { version, data } = updated.rows[0]
      const event = await query(`INSERT INTO meta_record_revisions
        (sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, operation_id)
        VALUES ($1,$2,$3,'update','rest',ARRAY[]::text[],'{}'::jsonb,$4::jsonb,$5::uuid) RETURNING seq::text`,
      [sheetId, neighbor, version, JSON.stringify(data), operationId])
      const endpointSeq = String(event.rows[0].seq)
      await query('INSERT INTO meta_record_history_operations (sheet_id, operation_id, endpoint_seq, event_count) VALUES ($1,$2,$3,1)',
        [sheetId, operationId, endpointSeq])
      return endpointSeq
    })
    try {
      const refusal = { status: 409, code: 'STOCK_PREPARATION_PROJECT_DELETE_DEPENDENCY', details: { reason: 'recovery' } }
      await expect(fixture.service.preview(scope)).rejects.toMatchObject(refusal)
      await expect(fixture.service.confirm({ ...scope, challengeId: preview.challengeId, verificationCode: preview.verificationCode })).rejects.toMatchObject(refusal)
      const replay = await reconstructRecordsAtSeq(q, sheetId, seq, undefined, checkpoint.trustedSinceSeq, checkpoint.checkpointId)
      const restored = await composeBaselineOverlay(q, { sheetId, checkpointId: checkpoint.checkpointId, stateMap: replay })
      expect(restored.size).toBe(2)
      expect(restored.get(mine)).toMatchObject({ exists: true, data: { [projectField]: scope.projectNo }, version: 1 })
      expect(restored.get(neighbor)).toMatchObject({ exists: true, data: { [projectField]: 'control' }, version: 2 })
    } finally {
      await q('SELECT meta_record_history_operations_prune($1, $2::uuid)', [sheetId, operationId])
    }
  }, 60000)
}
