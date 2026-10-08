import { performance } from 'node:perf_hooks'

const CLOSED_ERRORS = new Set([
  'RECOVERY_ARCHIVE_CAPTURE_TIME_EXCEEDED', 'RECOVERY_ARCHIVE_CAPTURE_BYTE_LIMIT_EXCEEDED',
  'RECOVERY_ARCHIVE_OWNED_AUTHORITY_UNAVAILABLE', 'RECOVERY_ARCHIVE_OWNED_GENERATION_REFUSED',
  'RECOVERY_ARCHIVE_OWNED_CLEANUP_REFUSED',
])
// Exact canonical migration MESSAGE codes: cleanup-anchor, section-checkpoint and staging-cleanup protocols.
const NATIVE_GUARDS = new Set([
  'recovery_archive_binding_invalid', 'recovery_archive_snapshot_reservation_set_invalid',
  'recovery_archive_abandoned_cleanup_claim_invalid', 'recovery_archive_abandoned_cleanup_claim_shape_invalid',
  'recovery_archive_abandoned_cleanup_claim_refused', 'recovery_archive_attachment_cleanup_release_refused',
])
const EXTERNAL_PHASES = new Set(['attachment-read', 'put', 'head', 'get', 'pin', 'deleteExpired'])
type DiagnosticCase = 'canonical-cleanup' | 'controlled-delayed-commit' | 'natural-late-query' | 'prepared-upload-cleanup'
type Entry = {
  sequence: number; phase: string; elapsedMs: number; depth: number;
  originalExecuteCalls: number; outcome?: 'fulfilled' | 'rejected'; statementBudgetMs?: number; endElapsedMs?: number; endDepth?: number;
  rowCount?: number; rowBooleans?: Record<string, boolean>; sqlstate?: string; nativeGuard?: string; closedError?: string;
}
function own(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined
}
function phase(sql: string): string {
  if (/^BEGIN.*REPEATABLE READ/i.test(sql)) return 'capture_begin'
  if (/^BEGIN/i.test(sql)) return 'begin'
  if (/^(COMMIT|ROLLBACK)$/i.test(sql)) return sql.toLowerCase()
  if (/set_config\('statement_timeout'/i.test(sql)) return 'statement_budget'
  if (sql.includes('meta_recovery_archive_claim_abandoned_cleanup(')) return 'cleanup_claim'
  if (sql.includes('meta_recovery_archive_release_abandoned_source_pin(')) return 'source_pin_release'
  if (/INSERT INTO\s+(?:public\.)?meta_recovery_archive_coverage_items/i.test(sql)) return 'coverage_insert'
  if (/INSERT INTO\s+(?:public\.)?meta_sheet_section_revisions/i.test(sql)) return 'section_insert'
  if (sql.includes('meta_recovery_archive_reserve_nonce(')) return 'nonce_reservation'
  if (sql.includes('AS within_budget')) return 'inventory_budget'
  if (sql.includes("UPDATE public.meta_recovery_archives SET build_status='abandoned'")) return 'abandon'
  if (sql.includes('UPDATE public.meta_sheets SET recovery_writer_state=NULL')) return 'clear_writer_block'
  if (sql.includes("UPDATE public.meta_recovery_archive_staging_objects SET object_state='absent'")) return 'early_terminal'
  if (sql.includes('FOR UPDATE OF k')) return 'key_lock'
  if (sql.includes('FROM public.meta_sheets') && /FOR UPDATE/i.test(sql)) return 'sheet_lock'
  if (sql.includes('meta_recovery_archive_prepared_captures')) return 'prepared'
  if (sql.includes('owned-capture:binding')) return 'binding'
  if (sql.includes('meta_recovery_archive_snapshot_reservations')) return 'reservations'
  if (sql.includes('meta_recovery_archive_manual_requests')) return 'manual_request'
  if (sql.includes('meta_recovery_archive_attachment_refs')) return 'source_pins'
  if (sql.includes('meta_recovery_archive_staging_objects')) return 'staging'
  if (sql.includes('meta_recovery_archives') && /FOR UPDATE/i.test(sql)) return 'generation_lock'
  if (sql.includes('pg_advisory_xact_lock')) return 'fence'
  return 'other'
}

/** Opt-in test observation only; never stores SQL, parameters, rows, identifiers or error text. */
export function createRecoveryArchiveNativeDiagnostics() {
  let started = 0, selected: DiagnosticCase | undefined, budgetMs = 0, sequence = 0, dropped = 0, originalStarted = 0, originalFinished = 0
  const entries: Entry[] = [], externalCounts: Record<string, number> = {}, closedErrors = new Set<string>()
  const safe = (work: () => void) => { try { work() } catch { dropped++ } }
  const errorCode = (error: unknown) => {
    const message = own(error, 'message')
    return typeof message === 'string' && CLOSED_ERRORS.has(message) ? message : undefined
  }
  return {
    get active() { return selected !== undefined },
    start(name: DiagnosticCase, timeoutMs: number) { selected = name; budgetMs = timeoutMs; started = performance.now() },
    external(name: string) { if (selected && EXTERNAL_PHASES.has(name)) safe(() => { externalCounts[name] = (externalCounts[name] ?? 0) + 1 }) },
    commandError(error: unknown) { if (selected) safe(() => { const code = errorCode(error); if (code) closedErrors.add(code) }) },
    async query<T>(sql: string, params: unknown[] | undefined, depth: () => number,
      run: (executeObserved: <R>(execute: () => Promise<R>) => Promise<R>) => Promise<T>): Promise<T> {
      let entry: Entry | undefined
      if (selected) safe(() => {
        sequence++
        if (entries.length >= 2048) { dropped++; return }
        entry = { sequence, phase: phase(sql), elapsedMs: performance.now() - started, depth: depth(), originalExecuteCalls: 0 }
        if (/^SELECT set_config\('statement_timeout',\$1,true\)$/.test(sql)
          && typeof params?.[0] === 'string' && /^[1-9][0-9]*ms$/.test(params[0])
          && Number.isSafeInteger(Number.parseInt(params[0], 10))) entry.statementBudgetMs = Number.parseInt(params[0], 10)
        entries.push(entry)
      })
      const nativeError = (error: unknown) => { if (entry) safe(() => {
        const code = own(error, 'code'), severity = own(error, 'severity')
        if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)
          && typeof severity === 'string' && ['ERROR', 'FATAL', 'PANIC'].includes(severity)) {
          entry!.sqlstate = code
          const message = own(error, 'message')
          if (typeof message === 'string' && NATIVE_GUARDS.has(message)) entry!.nativeGuard = message
        }
      }) }
      const executeObserved = <R>(execute: () => Promise<R>) => {
        if (entry) safe(() => { entry!.originalExecuteCalls++ })
        originalStarted++
        try {
          const pending = execute()
          safe(() => { void pending.then(() => { originalFinished++ }, error => { originalFinished++; nativeError(error) }) })
          return pending
        } catch (error) { originalFinished++; nativeError(error); throw error }
      }
      try {
        const result = await run(executeObserved)
        if (entry) safe(() => {
          entry!.endElapsedMs = performance.now() - started; entry!.endDepth = depth(); entry!.outcome = 'fulfilled'
          const count = own(result, 'rowCount')
          if (Number.isSafeInteger(count) && Number(count) >= 0) entry!.rowCount = Number(count)
          const rows = own(result, 'rows'), first = Array.isArray(rows) && rows.length === 1 ? rows[0] : undefined
          for (const name of ['matches', 'valid', 'within_budget', 'expired']) {
            const value = own(first, name)
            if (typeof value === 'boolean') (entry!.rowBooleans ??= {})[name] = value
          }
        })
        return result
      } catch (error) {
        if (entry) safe(() => {
          entry!.endElapsedMs = performance.now() - started; entry!.endDepth = depth(); entry!.outcome = 'rejected'
          entry!.closedError = errorCode(error)
        })
        throw error
      }
    },
    failure(state: string | undefined, errors: readonly unknown[] = []) {
      if (!selected || state !== 'fail') return undefined
      let result: string | undefined
      const terminalCodes: string[] = []
      safe(() => { for (const error of errors) safe(() => { const code = errorCode(error); if (code) terminalCodes.push(code) }) })
      safe(() => {
        result = JSON.stringify({ diagnosticCase: selected, configuredBudgetMs: budgetMs, elapsedMs: performance.now() - started,
          queryScope: 'native adapter requests; originalExecuteCalls counts original fixture execute closure calls; direct hook SQL is not traced',
          sqlstateScope: 'original execute rejection only; own ERROR/FATAL/PANIC severity and five-character code',
          sequence, dropped, incomplete: dropped > 0 || originalStarted !== originalFinished || entries.some(entry => entry.endElapsedMs === undefined),
          originalExecution: { started: originalStarted, finished: originalFinished, inFlight: originalStarted - originalFinished },
          pending: entries.filter(entry => entry.endElapsedMs === undefined).length,
          lastRequestedPhase: entries.at(-1)?.phase, lastSettledPhase: entries.filter(entry => entry.endElapsedMs !== undefined).sort((a, b) => a.endElapsedMs! - b.endElapsedMs!).at(-1)?.phase,
          lastFulfilledPhase: entries.filter(entry => entry.outcome === 'fulfilled').sort((a, b) => a.endElapsedMs! - b.endElapsedMs!).at(-1)?.phase,
          externalCounts, commandCodes: [...closedErrors], terminalCodes, entries }, null, 2)
      })
      return result
    },
  }
}
