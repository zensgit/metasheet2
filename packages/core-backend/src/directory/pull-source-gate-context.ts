/**
 * Marker for code that runs while a transaction holds an organisation's pull-source lock (the
 * advisory lock defined in `pull-source-rule.ts`; its key text is spelled only there).
 *
 * That lock is outside the authorization-input lock order: a transaction that holds it takes no
 * authorization-input lock, and an authorization-input transaction never takes it. The holder wraps
 * every function it is handed in `runInsidePullSourceGate`; both authorization-input entry points
 * read `isInsidePullSourceGate()` before they issue a statement and refuse while it is true.
 *
 * The marker follows the asynchronous call chain, so it is also seen by work the wrapped function
 * starts on another connection. This module imports nothing from the rest of the package, so the
 * lock holder and the entry points can both read it without importing each other. Creating the
 * storage object at import time has no side effect: no timer, no I/O, no environment read.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const pullSourceGateScope = new AsyncLocalStorage<true>()

/** Runs `callback` with the marker set for its whole asynchronous call chain. */
export function runInsidePullSourceGate<T>(callback: () => T): T {
  return pullSourceGateScope.run(true, callback)
}

/** Whether the current asynchronous call chain started inside `runInsidePullSourceGate`. */
export function isInsidePullSourceGate(): boolean {
  return pullSourceGateScope.getStore() === true
}
