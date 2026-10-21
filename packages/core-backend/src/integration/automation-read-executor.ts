import { performance } from 'node:perf_hooks'
import { AutomationReadLedgerError, checkedReadPreview, type AutomationReadLedgerDependencies,
  type ReadPreview, type ReadRequestStatus } from './automation-read-contracts'
import type { createAutomationReadLedger, ReadCheckpoint } from './automation-read-ledger'
import type { AutomationReadExecutionAuthority, AutomationReadExecutionMaterial } from './automation-read-authority'
import { loadAutomationReadTargetRecords, type AutomationReadTargetRecords } from './automation-read-target-records'
import type { AutomationReadSourceExecution } from './automation-read-source-execution'

type Reference = { requestId: string; status: ReadRequestStatus }
export type AutomationReadPreviewInput = Omit<AutomationReadExecutionMaterial, 'target'> & {
  recordsApi: AutomationReadTargetRecords
  actor: ReadCheckpoint['actor']
  projectNo: string
  runId: string
  budget: ReadCheckpoint['budget']
  signal: AbortSignal
  checkpoint(): Promise<void>
  /** Host-owned lifecycle registration, never execution authority. */
  trackPendingWork(work: Promise<unknown>): void
}
export type AutomationReadExecutionPhase = 'claim' | 'initial-checkpoint' | 'material-checkpoint'
  | 'source-checkpoint' | 'final-checkpoint' | 'authority' | 'target-records'
  | 'source' | 'preview' | 'complete' | 'abandon'
export type AutomationReadExecutionDiagnostic = Readonly<{
  phase: AutomationReadExecutionPhase
  firstStop: 'none' | 'timeout' | 'live-deadline' | 'upstream-abort' | 'executor-failure'
  outcome: 'succeeded' | 'outcome_unknown' | 'reference-returned' | 'rejected'
  elapsedMs: number
  checkpointCount: number
  cleanupCount: number
}>
export type AutomationReadExecutorOptions = {
  ledger: ReturnType<typeof createAutomationReadLedger>
  authority: AutomationReadExecutionAuthority
  transaction: AutomationReadLedgerDependencies['transaction']
  sourceExecution: AutomationReadSourceExecution
  preview(input: AutomationReadPreviewInput): Promise<unknown>
  /** Host-private, values-free observation only. It is never execution authority. */
  onExecutionDiagnostic?(diagnostic: AutomationReadExecutionDiagnostic): void | Promise<void>
}
function unavailable(): never { throw new AutomationReadLedgerError('AUTOMATION_READ_UNAVAILABLE') }
function aborted(): never { throw new AutomationReadLedgerError('AUTOMATION_READ_FENCE_LOST') }

/** Host-private single-attempt executor. Dormant until the complete dispatcher
 * and owner-bound API ship. Queue/public output is ONLY an opaque reference.
 * Native non-cooperative SQL may finish after timeout; its result is discarded,
 * the private request remains unknown, and no automatic retry/re-read occurs.
 */
export function createAutomationReadExecutor(options: AutomationReadExecutorOptions) {
  const { ledger, authority, transaction, sourceExecution, preview, onExecutionDiagnostic } = options
  const pendingWork = new Set<Promise<unknown>>()
  function trackPendingWork(work: Promise<unknown>): void {
    pendingWork.add(work)
    const remove = () => { pendingWork.delete(work) }
    // Observe both outcomes without creating an unobserved rejecting finally.
    void work.then(remove, remove)
  }
  return Object.freeze({
    /** Host stop calls this after closing admission and draining public runs.
     * Inner preview work can outlive both deadline races, including metadata IO. */
    async drainPendingWork(): Promise<void> {
      while (pendingWork.size > 0) await Promise.allSettled([...pendingWork])
    },
    async execute(requestId: string, signal: AbortSignal): Promise<Reference> {
      const started = performance.now()
      let phase: AutomationReadExecutionPhase = 'claim'
      let firstStop: AutomationReadExecutionDiagnostic['firstStop'] = 'none'
      let firstStopPhase: AutomationReadExecutionPhase | undefined
      let outcome: AutomationReadExecutionDiagnostic['outcome'] = 'rejected'
      let checkpointCount = 0, cleanupCount = 0
      function recordStop(origin: Exclude<AutomationReadExecutionDiagnostic['firstStop'], 'none'>) {
        // First observed local branch only. Never infer origin from an Error,
        // AbortSignal.reason, stack, or a later cleanup/continuation.
        if (firstStop === 'none') { firstStop = origin; firstStopPhase = phase }
      }
      async function attempt(): Promise<Reference> {
        if (!(signal instanceof AbortSignal)) unavailable()
        if (signal.aborted) { recordStop('upstream-abort'); aborted() }
        const claim = await ledger.claim(requestId)
        if (!('fence' in claim) || typeof claim.fence !== 'string') return claim
        const fence = claim.fence
        const reference = { requestId: claim.requestId, fence }
        const controller = new AbortController()
        let records: AutomationReadTargetRecords | undefined
        let stopped = false
        let deadline = performance.now() + claim.budget.timeoutMs
        let timer: ReturnType<typeof setTimeout> | undefined
        let rejectAbort: (error: Error) => void = () => {}
        const abortPromise = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
        // A listener may fire before Promise.race attaches; immediately install a
        // rejection observer without converting the race's rejection to success.
        void abortPromise.catch(() => {})
        function stop(origin: Exclude<AutomationReadExecutionDiagnostic['firstStop'], 'none'>) {
          recordStop(origin)
          stopped = true
          records?.close()
          controller.abort()
          rejectAbort(new AutomationReadLedgerError('AUTOMATION_READ_FENCE_LOST'))
        }
        function live() {
          if (stopped || controller.signal.aborted || performance.now() >= deadline) { stop('live-deadline'); aborted() }
        }
        function arm() {
          if (timer) clearTimeout(timer)
          const remaining = deadline - performance.now()
          if (remaining <= 0) { stop('live-deadline'); aborted() }
          timer = setTimeout(() => stop('timeout'), Math.ceil(remaining))
        }
        const upstreamAbort = () => stop('upstream-abort')
        signal.addEventListener('abort', upstreamAbort, { once: true })
        if (signal.aborted) upstreamAbort()
        let permit: ReadCheckpoint | undefined
        async function checkpoint(checkpointPhase: 'initial-checkpoint' | 'material-checkpoint'
          | 'source-checkpoint' | 'final-checkpoint'): Promise<void> {
          const previousPhase = phase
          phase = checkpointPhase
          checkpointCount = Math.min(10000, checkpointCount + 1)
          live()
          const started = performance.now()
          const current = await ledger.checkpoint(reference)
          live()
          if (current.authorityMode !== 'execution' && current.authorityMode !== 'record') unavailable()
          // Subtract the WHOLE checkpoint latency conservatively. A slow DB reply
          // must not extend the clock-derived lease or the initial timeout.
          deadline = Math.min(deadline, started + current.remainingMs)
          arm()
          if (permit && (permit.authorityMode !== current.authorityMode || permit.authorityKey !== current.authorityKey
            || permit.projectNo !== current.projectNo
            || JSON.stringify(permit.selector) !== JSON.stringify(current.selector)
            || JSON.stringify(permit.budget) !== JSON.stringify(current.budget))) {
            throw new AutomationReadLedgerError('AUTOMATION_READ_SCOPE_CHANGED')
          }
          permit = current
          phase = previousPhase
        }
        // Plugin/source callbacks cannot supply a phase or private logger value.
        const sourceCheckpoint = () => checkpoint('source-checkpoint')
        async function work(): Promise<Reference> {
          phase = 'initial-checkpoint'
          arm()
          await checkpoint('initial-checkpoint')
          if (!permit) return unavailable()
          const captured = permit
          phase = 'authority'
          const material = await transaction(async trx => {
            live()
            if (captured.authorityMode === 'record' && (typeof authority.lockRecordExecution !== 'function'
              || typeof authority.evaluateRecordConditions !== 'function' || typeof authority.recordConditionFor !== 'function')) unavailable()
            const proof = captured.authorityMode === 'record'
              ? await authority.lockRecordExecution(trx, captured.actor, captured.selector)
              : await authority.lockExecution(trx, captured.actor, captured.selector)
            live()
            if (proof.key !== captured.authorityKey
              || proof.sourceReference.connectionId !== captured.sourceReference.connectionId
              || proof.sourceReference.connectionIncarnation !== captured.sourceReference.connectionIncarnation) {
              throw new AutomationReadLedgerError('AUTOMATION_READ_SCOPE_CHANGED')
            }
            const value = authority.materialFor(proof)
            const { scope, targetContract: { projection } } = value.target
            phase = 'target-records'
            records = await loadAutomationReadTargetRecords(trx, {
              actorId: captured.actor.actorId, baseId: scope.baseId, sheetId: scope.sheetId,
              fieldIds: [...projection.fieldIds], projectNo: captured.projectNo,
              projectFieldId: projection.projectFieldId, activeFieldId: projection.activeFieldId,
              maxRows: Math.min(captured.budget.maxRows, 100000),
              maxQueries: Math.min(200, 2 * (captured.budget.maxPages + 1)), signal: controller.signal,
            })
            live()
            return value
          })
          await checkpoint('material-checkpoint')
          if (!records) return unavailable()
          phase = 'source'
          const result = await sourceExecution({ actor: captured.actor, sourceValidation: material.sourceValidation,
            budget: captured.budget, signal: controller.signal, checkpoint: sourceCheckpoint }, async () => {
            phase = 'preview'
            const output = await preview({ action: material.action, installedFieldProperties: material.installedFieldProperties,
              extFieldMapping: material.extFieldMapping, sourceValidation: material.sourceValidation,
              actor: captured.actor, recordsApi: records!,
              projectNo: captured.projectNo, runId: 'automation-read:' + claim.requestId,
              budget: captured.budget, signal: controller.signal, checkpoint: sourceCheckpoint, trackPendingWork })
            live()
            const checked = checkedReadPreview(output)
            phase = 'source'
            return checked
          })
          await checkpoint('final-checkpoint')
          live()
          phase = 'complete'
          return ledger.complete({ ...reference, result: result as ReadPreview, signal: controller.signal })
        }
        try {
          const running = work()
          trackPendingWork(running)
          return await Promise.race([running, abortPromise])
        } catch {
          // Also latch authorization/driver failures. Late SOURCE continuations
          // cannot start another read or enter completion. A terminal transaction
          // already handed to COMMIT may win; abandon preserves proven success.
          stop('executor-failure')
          phase = 'abandon'
          try { return await ledger.abandon(reference) } catch { return unavailable() }
        } finally {
          // This ordinary resource cleanup is NOT an execution failure or timeout.
          cleanupCount = 1
          stopped = true
          controller.abort()
          records?.close()
          if (timer) clearTimeout(timer)
          signal.removeEventListener('abort', upstreamAbort)
        }
      }
      try {
        const reference = await attempt()
        // COMMIT may already have won over a stop. Report the actual returned
        // ledger status, not an inferred failure or proof of native completion.
        outcome = reference.status === 'succeeded' ? 'succeeded'
          : reference.status === 'outcome_unknown' ? 'outcome_unknown' : 'reference-returned'
        return reference
      } catch (error) {
        recordStop('executor-failure')
        throw error
      } finally {
        const elapsed = performance.now() - started
        const diagnostic: AutomationReadExecutionDiagnostic = Object.freeze({
          phase: firstStopPhase ?? phase, firstStop, outcome,
          elapsedMs: Number.isFinite(elapsed) ? Math.max(0, Math.min(86400000, Math.floor(elapsed))) : 0,
          checkpointCount, cleanupCount,
        })
        try {
          // Never await an observer: diagnostics cannot hold or reopen admission.
          // Observe async rejection as well as synchronous throws, without logs.
          void Promise.resolve(onExecutionDiagnostic?.(diagnostic)).catch(() => {})
        } catch { /* observation cannot alter the execution result */ }
      }
    },
  })
}
