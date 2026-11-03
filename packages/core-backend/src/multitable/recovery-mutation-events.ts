import { withAutomationEventId } from './automation-event-dedup'
import { emitRecordEventIfLegacy, enqueueRecordEventIfDurable } from './automation-producer-emit'
import type { ExactAnchorAppliedMutation } from './exact-anchor-recovery-execute'
import type { QueryFn } from './permission-service'
import type { TransactionalQueryable } from './pg-transaction-guard'
import type { RecoveryArchiveWorkerApplyCallbacks, RecoveryArchiveWorkerIdentity } from './recovery-archive-async-restore'

export type RecoveryMutationEvent = {
  type: 'multitable.record.updated' | 'multitable.record.deleted'
  payload: Record<string, unknown> & { _eventId: string }
}

/** The producer probes the real transaction; the marker alone cannot authorize an enqueue. */
export async function enqueueRecoveryMutationEvent(
  query: QueryFn,
  sheetId: string,
  actorId: string,
  mutation: ExactAnchorAppliedMutation,
): Promise<RecoveryMutationEvent> {
  const transaction: TransactionalQueryable = {
    isTransaction: true,
    query: async (sql, params) => {
      const result = await query(sql, params)
      return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount ?? null }
    },
  }
  const event: RecoveryMutationEvent = {
    type: mutation.kind === 'revert' ? 'multitable.record.updated' : 'multitable.record.deleted',
    payload: withAutomationEventId({
      sheetId,
      recordId: mutation.recordId,
      ...(mutation.kind === 'revert' ? { changes: mutation.patch } : {}),
      actorId,
    }),
  }
  await enqueueRecordEventIfDurable(transaction, event.type, event.payload)
  return event
}

export function createRecoveryArchiveWorkerRecordEvents(
  bus: { emit(eventType: string, payload: unknown): void },
): Pick<RecoveryArchiveWorkerApplyCallbacks, 'onMutationApplied' | 'afterCommit'> {
  const events = new WeakMap<ExactAnchorAppliedMutation, { identity: RecoveryArchiveWorkerIdentity; event: RecoveryMutationEvent }>()
  return {
    onMutationApplied: async (query, mutation, identity) => {
      const event = await enqueueRecoveryMutationEvent(query, identity.sheetId, identity.actorId, mutation)
      events.set(mutation, { identity, event })
    },
    afterCommit: async (identity, mutations) => {
      // Validate the whole batch before emitting anything for an unbound/mixed identity.
      const committed = mutations.map((mutation) => {
        const entry = events.get(mutation)
        if (!entry || entry.identity !== identity) throw new Error('RECOVERY_MUTATION_EVENT_BINDING_INVALID')
        return entry.event
      })
      for (const mutation of mutations) events.delete(mutation)
      for (const event of committed) emitRecordEventIfLegacy(bus, event.type, event.payload)
    },
  }
}
