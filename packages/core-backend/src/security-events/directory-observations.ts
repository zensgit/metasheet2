import type { DirectoryRunObservation, DirectorySchedulerObservation, ObservationDiagnostic } from './repository'
import { eventRepository, eventRetries as retries } from './process-store'
import { uuid } from './validation'

const pending: { input: DirectoryRunObservation | DirectorySchedulerObservation; startedAt: number; occurredAt: string }[] = []
let writing = false
let retryTimer: ReturnType<typeof setTimeout> | undefined
let draining = false
const nextDiagnostic = new Map<ObservationDiagnostic, number>()

function gap(code: ObservationDiagnostic = 'event_store_unavailable'): void {
  try {
    const now = performance.now()
    if (now < (nextDiagnostic.get(code) ?? -Infinity)) return
    nextDiagnostic.set(code, now + 60000)
    console.warn(code, { count_unknown: true })
  } catch { /* Diagnostics do not affect the completed action. */ }
}

function scheduleRetry(): void {
  if (retryTimer || draining || retries.size === 0) return
  retryTimer = setTimeout(() => {
    retryTimer = undefined
    draining = true
    void drain().catch(() => gap()).finally(() => {
      draining = false
      try { scheduleRetry() } catch { gap() }
    })
  }, 30000)
  retryTimer.unref()
}

async function drain(): Promise<void> {
  // Each entry leaves the buffer before its only retry starts.
  while (retries.size > 0) {
    let diagnostic: ObservationDiagnostic = 'event_store_unavailable'
    const result = await retries.retryOne(async (input, authority) => {
      const written = await (await eventRepository()).appendCommitted(input, authority, 'background')
      if (written.recorded === false && written.diagnostic) diagnostic = written.diagnostic
      return written
    })
    if (result.count_unknown) gap(diagnostic)
  }
}

async function writePending(): Promise<void> {
  try {
    while (pending.length > 0) {
      const { input, startedAt, occurredAt } = pending.shift()!
      try {
        const repository = await eventRepository()
        if (performance.now() - startedAt >= 60000) { gap(); continue }
        const result = await repository.appendDirectoryObservation(input, occurredAt)
        if (result.recorded) continue
        gap(result.diagnostic)
        if (result.retry) {
          retries.offer(result.retry.input, result.retry.authority, startedAt)
          scheduleRetry()
        }
      } catch { gap() }
    }
  } finally { writing = false }
}

function record(input: DirectoryRunObservation | DirectorySchedulerObservation, startedAt: number, occurredAt: string): void {
  const now = performance.now()
  for (let index = pending.length - 1; index >= 0; index--) {
    if (now - pending[index].startedAt >= 60000) { pending.splice(index, 1); gap() }
  }
  // Initial admission and retained snapshots share a bounded in-memory allowance.
  if (now - startedAt >= 60000 || pending.length + retries.size + Number(writing) >= 1000) { gap(); return }
  pending.push({ input, startedAt, occurredAt })
  if (writing) return
  writing = true
  void writePending().catch(() => gap())
}

/** Call after the scheduler action has finished. Only fixed kinds and internal IDs are accepted. */
export function recordDirectorySchedulerObservation(input: DirectorySchedulerObservation): void {
  try {
    const startedAt = performance.now(), occurredAt = new Date().toISOString()
    if (!input || Reflect.ownKeys(input).length !== 2 || !Object.hasOwn(input, 'kind') || !Object.hasOwn(input, 'integrationId')) { gap('mapping_rejected'); return }
    const { kind, integrationId } = input
    if (!['schedule_invalid', 'reclaim', 'bootstrap', 'refresh'].includes(kind)) { gap('mapping_rejected'); return }
    if (['reclaim', 'bootstrap'].includes(kind) ? integrationId !== null : !uuid(integrationId)) { gap('mapping_rejected'); return }
    record(Object.freeze({ kind, integrationId: integrationId?.toLowerCase() ?? null }), startedAt, occurredAt)
  } catch { gap() }
}

/** Diagnostics follow the finished sampling attempt; other run observations follow confirmed sync COMMIT. */
export function recordDirectoryRunObservation(input: DirectoryRunObservation): void {
  try {
    const startedAt = performance.now(), occurredAt = new Date().toISOString()
    if (!input || Reflect.ownKeys(input).length !== 3
      || !['kind', 'runId', 'integrationId'].every(key => Object.hasOwn(input, key))) { gap('mapping_rejected'); return }
    const { kind, runId, integrationId } = input
    if (!['diagnostic_failed', 'binding_sweep_failed', 'post_commit_failed'].includes(kind) || !uuid(runId) || !uuid(integrationId)) { gap('mapping_rejected'); return }
    record(Object.freeze({ kind, runId: runId.toLowerCase(), integrationId: integrationId.toLowerCase() }), startedAt, occurredAt)
  } catch { gap() }
}
