import assert from 'node:assert/strict'
import { randomUUID, createHmac } from 'node:crypto'

// Synthetic delivery only; execution uses the existing personal approval service.
export async function preparePackageApproval(root: string, pool: any, db: any) {
  await pool.query('CREATE TABLE approval_instances(id text PRIMARY KEY); CREATE TABLE directory_integrations(id uuid PRIMARY KEY)')
  for (const name of [
    'zzzz20260705120000_create_dingtalk_approval_card_deliveries',
    'zzzz20260705150100_add_send_columns_to_dingtalk_approval_card_deliveries',
    'zzzz20260709133000_add_integration_id_to_dingtalk_approval_card_deliveries',
    'zzzz20260710150000_add_outcome_unknown_delivery_status',
    'zzzz20260710160000_add_task_id_index_to_dingtalk_approval_card_deliveries',
    'zzzz20260711120000_add_entry_epoch_to_dingtalk_approval_card_deliveries',
    'zzzz20260715120000_create_automation_outbox',
    'zzzz20261015040000_create_plm_personal_approval_cards',
  ]) await (await import(root + '/src/db/migrations/' + name + '.ts')).up(db)
  // Extend this runner's existing predecessor user catalog; do not alter its user columns.
  await pool.query(`CREATE TABLE roles(id text PRIMARY KEY,name text);
    CREATE TABLE user_roles(user_id text,role_id text);
    CREATE TABLE role_permissions(role_id text,permission_code text);
    CREATE TABLE user_permissions(user_id text,permission_code text)`)
  for (const name of ['zzzz20260312170000_create_user_session_revocations',
                      'zzzz20260411120000_create_user_namespace_admissions'])
    await (await import(root + '/src/db/migrations/' + name + '.ts')).up(db)
  await pool.query("INSERT INTO user_permissions(user_id,permission_code) VALUES('meta-owner','approvals:act')")
  const linkSecret = randomUUID()
  process.env.APPROVAL_CARD_LINK_SECRET = linkSecret
  const { PLMAdapter } = await import(root + '/src/data-adapters/PLMAdapter.ts')
  const { ConfigService } = await import(root + '/src/services/ConfigService.ts')
  const adapter = new PLMAdapter(new ConfigService(), { info() {}, warn() {}, error() {}, debug() {} })
  // The real initializer reads the rendered operator provider tuple; no service credential is supplied.
  await adapter.initializePersonalApproval()
  const { PlmPersonalApprovalBindingService } = await import(root + '/src/services/PlmPersonalApprovalBindingService.ts')
  const service = new PlmPersonalApprovalBindingService(pool, () => adapter)
  const { createPlmApprovalBindingsRouter } = await import(root + '/src/routes/plm-approval-bindings.ts')
  return {
    router: createPlmApprovalBindingsRouter(service),
    decisions: (await import(root + '/src/routes/approvals.ts')).approvalsRouter({ plmPersonalCards: service }),
    async execute(meta: any, approvalGrant: string, bomGrant: string, nativeOrigin: string) {
      await assert.rejects(() => adapter.personalApprovalRequest('verify', bomGrant, 'personal-fixture'),
        (error: any) => error.code === 'PLM_PROVIDER_FORBIDDEN')
      const wrongPurpose = await meta('/api/me/plm-bom-write-bindings', 'POST', {
        dataSourceId: 'source-eco', connectionId: 'personal-fixture', grant: approvalGrant,
      })
      assert.equal(wrongPurpose.status, 403, JSON.stringify(wrongPurpose.body))
      assert.equal(wrongPurpose.body.error.code, 'PLM_BOM_WRITE_FORBIDDEN')
      const bound = await meta('/api/me/plm-approval-bindings', 'POST', {
        connectionId: 'personal-fixture', grant: approvalGrant,
      })
      assert.equal(bound.status, 201, JSON.stringify(bound.body))
      const bindingId = bound.body.data.id
      const synced = await meta('/api/me/plm-approval-bindings/' + bindingId + '/sync', 'POST', {})
      assert.equal(synced.status, 200, JSON.stringify(synced.body))
      const tasks = (await pool.query('SELECT * FROM plm_personal_approval_tasks WHERE binding_id=$1', [bindingId])).rows
      assert.equal(tasks.length, 1)
      const task = tasks[0], deliveryId = randomUUID()
      await pool.query(`INSERT INTO dingtalk_approval_card_deliveries
        (id,plm_task_id,node_key,recipient_user_id,recipient_dingtalk_user_id,delivery_kind,entry_epoch,send_status)
        VALUES($1,$2,$3,'meta-owner','synthetic-no-network','work_notice_action_card',$4,'sent')`,
        [deliveryId, task.id, task.source_stage_id, task.entry_epoch])
      const executed = await meta('/api/approval-card-deliveries/' + deliveryId + '/actions', 'POST', {
        t: createHmac('sha256', linkSecret).update(deliveryId).digest('hex').slice(0, 32), decision: 'approve',
      })
      assert.equal(executed.status, 200, JSON.stringify(executed.body))
      const intent = (await pool.query('SELECT * FROM plm_personal_approval_commands WHERE delivery_id=$1', [deliveryId])).rows[0]
      assert.equal(intent.state, 'settled')
      assert.equal(intent.receipt.actor_auth_user_id, '42')
      assert.equal(intent.receipt.seat_status, 'approved')
      assert.equal(intent.receipt.stage_complete, false)
      const duplicate = await fetch(nativeOrigin + '/api/v1/plm-approval-card/commands', {
        method: 'POST', headers: { authorization: 'Bearer ' + approvalGrant, 'content-type': 'application/json',
          'x-tenant-id': 'default', 'x-org-id': 'fixture-org' }, body: JSON.stringify(intent.command),
      })
      assert.equal(duplicate.status, 200)
      assert.deepEqual(await duplicate.json(), intent.receipt)
      const unbound = await meta('/api/me/plm-approval-bindings/' + bindingId, 'DELETE')
      assert.equal(unbound.status, 204)
      return { approved: true, purpose_isolation: true, native_subject: '42', meta_owner_distinct: true,
        source_receipt_idempotent: true, native_threshold_preserved: true, binding_unbound: true,
        decision_entry: 'existing authenticated approval card actions HTTP route', notification_sent: false }
    },
  }
}
