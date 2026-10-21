import { randomUUID } from 'node:crypto'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { assertInTransaction } from '../multitable/pg-transaction-guard'
import type { AutomationIntegrationActor } from './automation-live-authority'
import { checkedReconciliationInput, checkedReconciliationRecord, reconciliationContentHash,
  reconciliationFail as fail, reconciliationUuid as uuid } from './yida-reconciliation-contracts'

// Host-private history store. No delivery capability, network, live permit or
// sender imports. Caller must run live ACL and this operation in ONE transaction.
export function createYidaReconciliationStore(actor: Readonly<AutomationIntegrationActor>) {
  if (!actor.actorId || !actor.tenantId || actor.workspaceId !== null) fail('DENIED')
  const scope = [actor.tenantId, actor.actorId]
  async function chain(trx: Queryable, grantId: string, requestId: string) {
    uuid(grantId); uuid(requestId)
    await assertInTransaction(trx, 'YiDa reconciliation')
    if ((await trx.query('SHOW transaction_isolation')).rows[0]?.transaction_isolation !== 'read committed') fail('UNAVAILABLE')
    // Same lock order as admission: live ACL -> grant -> request/admission -> ledger.
    const grants = await trx.query(`SELECT id FROM integration_yida_auto_grants
      WHERE tenant_id=$1 AND owner_id=$2 AND workspace_id IS NULL AND id=$3 FOR UPDATE`, [...scope, grantId])
    if (grants.rows.length !== 1) fail('DENIED')
    const found = await trx.query(`SELECT a.id AS admission_id,l.id AS ledger_id FROM integration_yida_auto_requests r
      JOIN integration_yida_auto_admissions a ON a.request_id=r.id AND a.grant_id=r.grant_id
      JOIN integration_yida_delivery_ledger l ON l.id=a.ledger_id
      WHERE r.grant_id=$3 AND r.id=$4 AND l.tenant_id=$1 AND l.owner_id=$2 AND l.workspace_id IS NULL
      FOR UPDATE OF r,a,l`, [...scope, grantId, requestId])
    if (found.rows.length !== 1) fail('DENIED')
    return found.rows[0]
  }
  function project(row: Record<string, unknown>) {
    const recordedAt = row.recorded_at instanceof Date ? row.recorded_at.toISOString() : row.recorded_at
    return checkedReconciliationRecord({ ...checkedReconciliationInput(row.content), id: row.id,
      sequence: row.sequence, authorId: row.owner_id, recordedAt, evidenceOrigin: 'operator-supplied',
      evidenceVerified: false, canSend: false, canRetry: false })
  }
  async function head(trx: Queryable, ledgerId: unknown) {
    return Number((await trx.query(`SELECT COALESCE(MAX(sequence),0)::int AS head
      FROM integration_yida_reconciliation_observations WHERE ledger_id=$1`, [ledgerId])).rows[0].head)
  }
  return Object.freeze({
    async append(trx: Queryable, grantId: string, requestId: string, supplied: unknown) {
      const input = checkedReconciliationInput(supplied), linked = await chain(trx, grantId, requestId)
      const hash = reconciliationContentHash(requestId, input)
      const prior = await trx.query(`SELECT * FROM integration_yida_reconciliation_observations
        WHERE tenant_id=$1 AND owner_id=$2 AND grant_id=$3 AND command_key=$4`, [...scope, grantId, input.commandKey])
      // Must precede head comparison: replay after committed response loss.
      if (prior.rows.length) {
        if (prior.rows.length !== 1 || prior.rows[0].content_sha256 !== hash || prior.rows[0].ledger_id !== linked.ledger_id) fail('CONFLICT')
        return Object.freeze({ record: project(prior.rows[0]), reused: true })
      }
      const current = await head(trx, linked.ledger_id)
      if (current !== input.expectedHeadSequence) fail('CONFLICT')
      if (input.supersedesObservationId !== null) {
        const old = await trx.query(`SELECT id FROM integration_yida_reconciliation_observations
          WHERE id=$1 AND tenant_id=$2 AND owner_id=$3 AND grant_id=$4 AND ledger_id=$5`,
        [input.supersedesObservationId, ...scope, grantId, linked.ledger_id])
        if (old.rows.length !== 1) fail('DENIED')
      }
      const id = randomUUID()
      const inserted = await trx.query(`INSERT INTO integration_yida_reconciliation_observations
        (id,tenant_id,owner_id,grant_id,request_id,admission_id,ledger_id,sequence,command_key,content_sha256,content,supersedes_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12) RETURNING *`,
      [id, ...scope, grantId, requestId, linked.admission_id, linked.ledger_id, current + 1, input.commandKey, hash,
        JSON.stringify(input), input.supersedesObservationId])
      await trx.query(`INSERT INTO integration_yida_reconciliation_audit(observation_id,action) VALUES ($1,'OPERATOR_OBSERVATION_APPENDED')`, [id])
      return Object.freeze({ record: project(inserted.rows[0]), reused: false })
    },
    async list(trx: Queryable, grantId: string, requestId: string, afterId: string | null) {
      const linked = await chain(trx, grantId, requestId)
      let after = 0
      if (afterId !== null) {
        const cursor = await trx.query(`SELECT sequence FROM integration_yida_reconciliation_observations
          WHERE id=$1 AND tenant_id=$2 AND owner_id=$3 AND grant_id=$4 AND ledger_id=$5`,
        [uuid(afterId), ...scope, grantId, linked.ledger_id])
        if (cursor.rows.length !== 1) fail('DENIED')
        after = Number(cursor.rows[0].sequence)
      }
      const rows = await trx.query(`SELECT * FROM integration_yida_reconciliation_observations
        WHERE tenant_id=$1 AND owner_id=$2 AND grant_id=$3 AND ledger_id=$4 AND sequence>$5 ORDER BY sequence LIMIT 51`,
      [...scope, grantId, linked.ledger_id, after])
      const records = Object.freeze(rows.rows.slice(0, 50).map(project))
      return Object.freeze({ records, headSequence: await head(trx, linked.ledger_id),
        nextAfterId: rows.rows.length > 50 ? records.at(-1)!.id : null, canSend: false, canRetry: false })
    },
  })
}
