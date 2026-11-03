/**
 * "A multitable request is about to be sent": one app-wide signal, told by every MultitableApiClient
 * right before it hands a request to its transport.
 *
 * The listener runs synchronously, in the same run as the transport reads the session headers
 * (`apiFetch` reads the stored token and org header before its first await), so it can read the
 * identity the request will carry. Today's user: the record drawer's 派发任务 binding
 * (tasks/recordTaskDispatchIdentity.ts), which must know whether any record content was read while
 * another user or org was signed in.
 *
 * WHY THIS IS ITS OWN MODULE, and not a method on the client: specs replace the client module, or the
 * workbench's client, with hand-built stubs; a leaf with no dependencies needs no stub (the same
 * reasoning as composables/authPrincipal.ts).
 *
 * Listeners are notified, never asked: they cannot stop or change a request, and one that throws is
 * ignored.
 */

const listeners = new Set<() => void>()

/** Subscribe; returns an unsubscribe. */
export function onMultitableBeforeSend(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Called by the client right before each request goes to its transport. */
export function notifyMultitableBeforeSend(): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener()
    } catch {
      // A listener must never break a request.
    }
  }
}
