import { randomUUID } from 'node:crypto'
import { AutomationLogService } from '../multitable/automation-log-service'
import { assertInTransaction, type TransactionalQueryable } from '../multitable/pg-transaction-guard'
import { canonicalReadId, exactObject } from './automation-read-contracts'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

/** Audit only: the caller already authorized and inserted this request in this transaction. */
export async function recordAutomationReadExecution(
  trx: TransactionalQueryable,
  input: { requestId: string; ruleId: string; actorId: string; tenantId: string },
): Promise<void> {
  if (!exactObject(input, ['requestId', 'ruleId', 'actorId', 'tenantId'])
    || !uuid.test(input.requestId) || ![input.ruleId, input.actorId, input.tenantId].every(canonicalReadId)) {
    throw new Error('AUTOMATION_READ_EXECUTION_AUDIT_INVALID')
  }
  const { requestId, ruleId, actorId, tenantId } = input
  await assertInTransaction(trx, 'Automation read execution audit')
  const result = await trx.query(`SELECT r.sheet_id, r.integration_authority_revision::text AS rule_revision,
      pg_catalog.to_char(q.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS triggered_at
    FROM automation_rules r
    JOIN integration_automation_read_requests q ON q.id=$1
    JOIN integration_automation_read_grants g ON g.id=q.grant_id
    WHERE r.id=$2 AND r.created_by=$3 AND r.enabled=true
      AND r.action_type='integration_read_preview' AND r.integration_authority_revision IS NOT NULL
      AND q.owner_id=$3 AND q.tenant_id=$4 AND q.workspace_id IS NULL
      AND q.status='queued' AND q.trigger_type IN ('manual','schedule','record')
      AND q.xmin::text=(pg_catalog.pg_current_xact_id()::text::numeric % 4294967296)::text
      AND g.owner_id=q.owner_id AND g.tenant_id=q.tenant_id AND g.workspace_id IS NULL
      AND g.selector->>'ruleId'=r.id AND g.status='active' AND g.expires_at>pg_catalog.clock_timestamp()
      AND q.project_no=ANY(g.projects) AND q.trigger_type=ANY(g.triggers)
    FOR SHARE OF r,q,g NOWAIT`, [requestId, ruleId, actorId, tenantId])
  const row = result.rows[0]
  if (result.rows.length !== 1 || typeof row?.sheet_id !== 'string'
    || typeof row?.rule_revision !== 'string' || !uuid.test(row.rule_revision)
    || typeof row?.triggered_at !== 'string') throw new Error('AUTOMATION_READ_EXECUTION_AUDIT_DENIED')
  const executionId = `axe_${randomUUID()}`
  await new AutomationLogService().recordWithQuery(trx.query.bind(trx), {
    id: executionId, ruleId, sheetId: row.sheet_id, triggeredBy: 'integration-read-owner',
    triggeredAt: row.triggered_at, status: 'running', steps: [],
    integrationRead: { requestId, status: 'queued' },
  })
  await trx.query(`INSERT INTO integration_automation_read_executions
    (request_id,execution_id,rule_id,rule_revision,step_index) VALUES ($1,$2,$3,$4,0)`,
  [requestId, executionId, ruleId, row.rule_revision])
}
