import type { DataSourceManager } from '../data-adapters/DataSourceManager'
import { withDataSourceReadExecution } from '../data-adapters/data-source-read-execution'
import { AutomationReadLedgerError } from './automation-read-contracts'
import type { ReadBudget } from './automation-read-contracts'
import type { AutomationIntegrationActor } from './automation-live-authority'
import type { AutomationReadExecutionMaterial } from './automation-read-authority'

export type AutomationReadSourceExecution = ReturnType<typeof createAutomationReadSourceExecution>

/** Host-only per-run scope. No credentials or adapter escape to the plugin. The
 * production readonly facade and its canonical resolver remain in the path.
 * Native SQL scopes bind OBJECT identity, not just a reusable Connection id.
 */
export function createAutomationReadSourceExecution(getManager: () => DataSourceManager) {
  return async function run<T>(input: {
    actor: AutomationIntegrationActor
    sourceValidation: AutomationReadExecutionMaterial['sourceValidation']
    budget: Readonly<ReadBudget>
    signal: AbortSignal
    checkpoint(): Promise<void>
  }, work: () => Promise<T>): Promise<T> {
    const { actor, sourceValidation, budget, signal, checkpoint } = input
    let reads = 0
    const manager = getManager()
    const id = sourceValidation.connectionId
    const adapter = manager.getDataSource(id)
    function current() {
      manager.assertAccess(id, actor.actorId)
      const scope = manager.getScope(id)
      if (actor.workspaceId !== null || !scope || scope.tenantId !== actor.tenantId
        || scope.workspaceId !== null || scope.scopeKind !== 'private'
        || manager.getDataSource(id) !== adapter || !adapter.isReadOnly()
        || !['postgresql', 'postgres', 'sqlserver'].includes(adapter.getType())
        || manager.getLoadedValidationRevision(id, adapter) !== sourceValidation.connectionRevision) {
        throw new AutomationReadLedgerError('AUTOMATION_READ_SCOPE_CHANGED')
      }
    }
    current()
    return withDataSourceReadExecution({ adapter, signal,
      async beforeIO() {
        await checkpoint(); current()
        // The same finite grant also caps native operations, including schema
        // fanout/connection health. Logical page/row caps remain in the plugin.
        if (++reads > budget.maxReadCount) throw new AutomationReadLedgerError('AUTOMATION_READ_BUDGET_EXHAUSTED')
      },
      async afterIO() { await checkpoint(); current() },
    }, work)
  }
}
