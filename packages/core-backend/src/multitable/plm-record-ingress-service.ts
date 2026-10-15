import { ensureRecordNotLocked } from './record-lock'
import { randomUUID } from 'node:crypto'
import { fenceWriterEntry } from './canonical-sheet-fence'
import { mintOperation, sealOperation } from './operation-ledger'
import { recordRecordRevision } from './record-history-service'
import { insertCommittedAuditInTxn, type OapiWriteAuditContext } from './oapi-write-audit'
import { enqueueRecordEventIfDurable } from './automation-producer-emit'
import { assertInTransaction } from './pg-transaction-guard'
import { loadRecordPermissionScopeMap } from './permission-service'
import { acquireRecordLinkRowAuthLockOnQuery } from '../services/approval-record-link-row-auth-lock'
import {
  canonicalPlmEvent,
  hashPlmEvent,
  parsePlmRecordEvent,
  PlmIngressError,
} from './plm-record-ingress-wire'
import {
  requirePlmIngressRuntime,
  verifyPlmBindingAuthority,
  type PlmBinding,
  type PlmPool,
} from './plm-record-ingress-binding'

export interface PlmReceipt {
  schema: 'yuantus.bom-record-receipt.v1'
  event_id: string
  binding_id: string
  binding_version: number
  source_sequence: number
  record_id: string
  result: 'applied'
}
export async function receivePlmRecordEvent(
  pool: PlmPool,
  input: unknown,
  audit: OapiWriteAuditContext,
): Promise<PlmReceipt> {
  requirePlmIngressRuntime()
  const event = parsePlmRecordEvent(input)
  if (!audit.tokenId || !audit.actorId) throw new PlmIngressError(401, 'invalid_token')
  return pool.transaction(async ({ query }) => {
    await assertInTransaction({ query }, 'receivePlmRecordEvent')
    const candidate = (
      await query('SELECT sheet_id FROM meta_plm_record_bindings WHERE id=$1', [event.binding_id])
    ).rows[0]
    if (!candidate) throw new PlmIngressError(403, 'binding_unavailable')
    await fenceWriterEntry(query, candidate.sheet_id)
    requirePlmIngressRuntime()
    const binding = (
      await query('SELECT * FROM meta_plm_record_bindings WHERE id=$1 FOR UPDATE', [
        event.binding_id,
      ])
    ).rows[0] as PlmBinding | undefined
    const { bom_line_id: lineId, ...source } = event.source
    if (
      !binding ||
      !binding.enabled ||
      Number(binding.version) !== event.binding_version ||
      binding.token_id !== audit.tokenId ||
      canonicalPlmEvent(binding.source) !== canonicalPlmEvent(source)
    )
      throw new PlmIngressError(403, 'binding_unavailable')
    const actorId = await verifyPlmBindingAuthority(query, binding, audit.actorId)
    // Required schema is checked even for a receipt replay; a degraded runtime never claims success.
    const schema = (
      await query(
        "SELECT to_regclass('meta_automation_outbox') IS NOT NULL AND to_regclass('meta_automation_outbox_consumer') IS NOT NULL AND to_regclass('meta_record_history_operations') IS NOT NULL AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='meta_record_revisions' AND column_name='operation_id' AND table_schema=ANY(current_schemas(false))) AS ready",
      )
    ).rows[0]
    if (!schema?.ready) throw new PlmIngressError(503, 'ingress_unavailable')
    const row = (
      await query(
        'SELECT * FROM meta_plm_record_rows WHERE binding_id=$1 AND bom_line_id=$2 FOR UPDATE',
        [binding.id, lineId],
      )
    ).rows[0]
    let record:
      | {
          id: string
          data: Record<string, unknown>
          version: number
          created_by?: string
          locked?: boolean
          locked_by?: string
        }
      | undefined
    if (row) {
      // Share the permission-writer advisory: a record-row lock cannot serialize a phantom deny.
      await acquireRecordLinkRowAuthLockOnQuery(query, binding.sheet_id, row.record_id)
      record = (
        await query(
          'SELECT id,data,version,created_by,locked,locked_by FROM meta_records WHERE id=$1 AND sheet_id=$2 FOR UPDATE',
          [row.record_id, binding.sheet_id],
        )
      ).rows[0]
      if (!record) throw new PlmIngressError(409, 'source_record_missing')
      const scopes = await loadRecordPermissionScopeMap(
        query,
        binding.sheet_id,
        [record.id],
        actorId,
      )
      const scope = scopes.get(record.id)
      if (
        scope?.accessLevel === 'none' ||
        scope?.accessLevel === 'read'
      )
        throw new PlmIngressError(403, 'forbidden')
      ensureRecordNotLocked(actorId, record, () => new PlmIngressError(403, 'forbidden'))
    }
    const hash = hashPlmEvent(event)
    const seen = (
      await query(
        'SELECT payload_hash,receipt FROM meta_plm_record_inbox WHERE binding_id=$1 AND event_id=$2',
        [binding.id, event.event_id],
      )
    ).rows[0]
    if (seen) {
      if (seen.payload_hash !== hash) throw new PlmIngressError(409, 'event_conflict')
      return seen.receipt as PlmReceipt
    }
    const expected = row ? Number(row.last_sequence) + 1 : 1
    if (event.source_sequence !== expected)
      throw new PlmIngressError(
        409,
        event.source_sequence > expected ? 'sequence_gap' : 'sequence_conflict',
      )
    const ledger = await mintOperation(query, binding.sheet_id)
    if (!ledger.operationId) throw new PlmIngressError(503, 'ingress_unavailable')
    const recordId = row?.record_id ?? `rec_${randomUUID()}`
    const receipt: PlmReceipt = {
      schema: 'yuantus.bom-record-receipt.v1',
      event_id: event.event_id,
      binding_id: event.binding_id,
      binding_version: event.binding_version,
      source_sequence: event.source_sequence,
      record_id: recordId,
      result: 'applied',
    }
    const patch = Object.fromEntries(
      Object.entries(binding.fields).map(([key, id]) => [
        id,
        event.cells[key as keyof typeof event.cells],
      ]),
    )
    await query(
      `INSERT INTO meta_plm_record_inbox(binding_id,event_id,payload_hash,payload,receipt) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)`,
      [binding.id, event.event_id, hash, JSON.stringify(event), JSON.stringify(receipt)],
    )
    await query(
      `INSERT INTO meta_plm_record_rows(binding_id,bom_line_id,record_id,last_sequence) VALUES($1,$2,$3,$4)
      ON CONFLICT(binding_id,bom_line_id) DO UPDATE SET last_sequence=EXCLUDED.last_sequence`,
      [binding.id, lineId, recordId, event.source_sequence],
    )
    // The DB guard also requires this event's inbox txid/record/cells. This is never an HTTP option.
    await query("SELECT set_config('metasheet.plm_ingress_event',$1,true)", [
      event.event_id.toLowerCase(),
    ])
    const write = row
      ? await query(
          `UPDATE meta_records SET data=data || $1::jsonb,version=version+1,updated_at=now(),modified_by=$4 WHERE id=$2 AND sheet_id=$3 RETURNING version,data`,
          [JSON.stringify(patch), recordId, binding.sheet_id, actorId],
        )
      : await query(
          `INSERT INTO meta_records(id,sheet_id,data,created_by,modified_by) VALUES($1,$2,$3::jsonb,$4,$4) RETURNING version,data`,
          [recordId, binding.sheet_id, JSON.stringify(patch), actorId],
        )
    const written = write.rows[0]
    await recordRecordRevision(query, {
      sheetId: binding.sheet_id,
      recordId,
      version: Number(written.version),
      action: row ? 'update' : 'create',
      source: 'plm_domain_event',
      actorId,
      changedFieldIds: Object.keys(patch),
      patch,
      snapshot: written.data,
      ledger,
    })
    await insertCommittedAuditInTxn(
      query,
      { ...audit, sheetId: binding.sheet_id, operation: 'upsert', scope: 'records:write' },
      { recordIds: [recordId], batchCount: 1 },
    )
    if (!(await sealOperation(query, ledger))) throw new PlmIngressError(503, 'ingress_unavailable')
    const payload = {
      sheetId: binding.sheet_id,
      recordId,
      actorId,
      ...(row ? { changes: patch } : { data: patch }),
      _eventId: `plm:${binding.id}:${event.event_id}`,
      _automationDepth: 0,
      _origin: 'plm_domain_event',
    }
    if (
      !(await enqueueRecordEventIfDurable(
        { query, isTransaction: true },
        row ? 'multitable.record.updated' : 'multitable.record.created',
        payload,
      ))
    )
      throw new PlmIngressError(503, 'ingress_unavailable')
    return receipt
  })
}
