/**
 * 派发任务 from a multitable record: the per-record state of a dispatch, kept OUTSIDE the dialog.
 *
 * The dialog is closed by 取消 / × / Esc, unmounted when the drawer moves to another record, and
 * gone with the drawer itself. A create that is still out when any of that happens must not be
 * forgotten: the next dialog for the same record has to see that it is still out (so it cannot send
 * a second create) or that it produced a task (so it shows that task instead of a blank form). So the
 * state of one dispatch lives here, keyed by sheet and record, for the life of the page.
 *
 * A run is:
 *  - in flight from the click until both writes settle;
 *  - then settled with the created task (kept until its success panel has been on screen) or with a
 *    failure message (kept until a dialog for that record shows it).
 * Nothing here reads record content; a run holds a task id, a flag and a message key.
 */
import { reactive } from 'vue'

export interface DispatchCreated {
  id: string
  /** The second write (the source line in the description) did not land. */
  sourceNoteFailed: boolean
}

export interface DispatchRun {
  inFlight: boolean
  created: DispatchCreated | null
  /** A message key for a create that failed; shown by the next dialog for the record that is open. */
  failure: string | null
  /** The created task's success panel has been on screen; the next open starts a fresh form. */
  seen: boolean
}

export type DispatchOutcome =
  | { created: DispatchCreated; failure?: undefined }
  | { created?: undefined; failure: string }

const runs = reactive(new Map<string, DispatchRun>())

/** The key of one record's dispatch state. */
export function dispatchRunKey(sheetId: string, recordId: string): string {
  return JSON.stringify([sheetId, recordId])
}

export function readDispatchRun(key: string): DispatchRun | undefined {
  return runs.get(key)
}

/** Starts a run. `false` (and nothing changes) while a create for this record is out, or while its
 *  created task has not been shown yet. */
export function beginDispatchRun(key: string): boolean {
  const current = runs.get(key)
  if (current && (current.inFlight || (current.created !== null && !current.seen))) return false
  runs.set(key, { inFlight: true, created: null, failure: null, seen: false })
  return true
}

export function settleDispatchRun(key: string, outcome: DispatchOutcome): void {
  runs.set(key, {
    inFlight: false,
    created: outcome.created ?? null,
    failure: outcome.failure ?? null,
    seen: false,
  })
}

export function markDispatchRunSeen(key: string): void {
  const current = runs.get(key)
  if (current && current.created !== null) current.seen = true
}

/** Drops a settled run (a shown task, or a failure that has been shown). An in-flight run stays. */
export function forgetDispatchRun(key: string): void {
  if (runs.get(key)?.inFlight) return
  runs.delete(key)
}

/** Test harnesses only: page-lifetime state would otherwise carry from one test into the next. */
export function resetDispatchRunsForTests(): void {
  runs.clear()
}
