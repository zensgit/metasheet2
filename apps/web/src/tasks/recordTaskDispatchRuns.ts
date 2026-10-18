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
 * Nothing here reads record content; a run holds a task id, flags, a message key, the identity it was
 * bound to and the ticket of the create that started it.
 *
 * Runs are kept PER IDENTITY (`recordTaskDispatchIdentity.ts`): the key names the identity the
 * dispatch was bound to as well as the record, so a dialog under another user or org never sees a
 * run that is not its own (neither its pending note nor its created task). When this tab's session
 * changes (sign-out, sign-in, org switch through `useAuth`), the runs of every other identity are
 * dropped; a create still out for a dropped run settles into nothing. A sign-in in another tab is
 * not announced here, which the per-identity key and the page binding cover.
 *
 * A run is settled only by the create that started it: `beginDispatchRun` hands out a ticket and
 * `settleDispatchRun` takes it back. A create whose run was dropped (or replaced by a newer one under
 * the same key) settles into nothing, so an older answer can never overwrite a newer run.
 */
import { reactive } from 'vue'
import { onAuthSessionSwitch } from '../composables/authPrincipal'
import { readDispatchIdentity } from './recordTaskDispatchIdentity'

export interface DispatchCreated {
  id: string
  /** The second write (the source line in the description) did not land. */
  sourceNoteFailed: boolean
}

export interface DispatchRun {
  /** The identity the dispatch was bound to (part of its key as well). */
  identity: string
  /** The ticket of the create that started this run (see `beginDispatchRun`). */
  ticket: number
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
let nextTicket = 1
let unsubscribeSessionSwitch: (() => void) | null = null

/** Drops every run that does not belong to `identity`, in flight or settled. */
function dropRunsOutside(identity: string): void {
  for (const [key, run] of Array.from(runs.entries())) {
    if (run.identity !== identity) runs.delete(key)
  }
}

/** Subscribes once, on the first run: this tab's session changing drops the other identities' runs. */
function watchSessionSwitch(): void {
  if (unsubscribeSessionSwitch) return
  unsubscribeSessionSwitch = onAuthSessionSwitch(() => dropRunsOutside(readDispatchIdentity()))
}

/** The key of one record's dispatch state under one identity. */
export function dispatchRunKey(identity: string, sheetId: string, recordId: string): string {
  return JSON.stringify([identity, sheetId, recordId])
}

export function readDispatchRun(key: string): DispatchRun | undefined {
  return runs.get(key)
}

/** Starts a run for `identity` and returns its ticket, to be handed back to `settleDispatchRun`.
 *  `null` (and nothing changes) while a create for this record is out, or while its created task has
 *  not been shown yet. */
export function beginDispatchRun(key: string, identity: string): number | null {
  watchSessionSwitch()
  const current = runs.get(key)
  if (current && (current.inFlight || (current.created !== null && !current.seen))) return null
  const ticket = nextTicket++
  runs.set(key, { identity, ticket, inFlight: true, created: null, failure: null, seen: false })
  return ticket
}

/** Settles the run that `ticket` started. Nothing happens when that run is no longer the one under
 *  `key` (it was dropped because the session changed, and possibly replaced by a newer run): its
 *  outcome belongs to a run this tab no longer holds. */
export function settleDispatchRun(key: string, ticket: number, outcome: DispatchOutcome): void {
  const current = runs.get(key)
  if (!current || !current.inFlight || current.ticket !== ticket) return
  runs.set(key, {
    identity: current.identity,
    ticket,
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
  unsubscribeSessionSwitch?.()
  unsubscribeSessionSwitch = null
}
