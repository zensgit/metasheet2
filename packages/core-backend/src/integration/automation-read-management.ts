import { createAutomationReadLedger } from './automation-read-ledger'
import { lockAutomationReadSourceObservation } from './automation-read-source-observation'
import { AutomationReadLedgerError, type AutomationReadLedgerDependencies } from './automation-read-contracts'
import type { AutomationIntegrationActor } from './automation-live-authority'

type Ledger = ReturnType<typeof createAutomationReadLedger>
type Dependencies = Pick<AutomationReadLedgerDependencies, 'transaction' | 'manifest'>

/** Host-private OWNER management, not an execution capability. History and
 * cancellation remain usable while the integration plugin/producer is stopped.
 * The ledger independently checks live actor/admin and the original Connection
 * incarnation's CURRENT owner for every operation; no historical owner bypass.
 * Stop is server shutdown only, not plugin reload. No source IO can originate
 * here: execution authority is structurally absent.
 */
export function createAutomationReadManagement(deps: Dependencies) {
  const ledger = createAutomationReadLedger({ ...deps, authority: {
    async lockExecution() { throw new AutomationReadLedgerError('AUTOMATION_READ_DENIED') },
    lockObservation: lockAutomationReadSourceObservation,
  } })
  let closed = false
  const pending = new Set<Promise<unknown>>()
  function manage<T>(work: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new AutomationReadLedgerError('AUTOMATION_READ_UNAVAILABLE'))
    const task = Promise.resolve().then(work).finally(() => { pending.delete(task) })
    pending.add(task)
    return task
  }
  return Object.freeze({
    grantDetail(actor: AutomationIntegrationActor, grantId: string) {
      return manage(() => ledger.grantDetail(actor, grantId))
    },
    listGrants(actor: AutomationIntegrationActor, input?: Parameters<Ledger['listGrants']>[1]) {
      return manage(() => ledger.listGrants(actor, input))
    },
    listRequests(actor: AutomationIntegrationActor, input?: Parameters<Ledger['listRequests']>[1]) {
      return manage(() => ledger.listRequests(actor, input))
    },
    observe(actor: AutomationIntegrationActor, requestId: string) {
      return manage(() => ledger.observe(actor, requestId))
    },
    retryContext(actor: AutomationIntegrationActor, requestId: string) {
      return manage(() => ledger.retryContext(actor, requestId))
    },
    cancel(actor: AutomationIntegrationActor, requestId: string) {
      return manage(() => ledger.cancel(actor, requestId))
    },
    revoke(actor: AutomationIntegrationActor, grantId: string) {
      return manage(() => ledger.revoke(actor, grantId))
    },
    async stop(): Promise<void> {
      // The assignment precedes the first await; pool shutdown waits for every
      // already admitted operation, including history reconciliation writes.
      closed = true
      await Promise.allSettled([...pending])
    },
  })
}
