/**
 * The ONE way a mounted surface holds the server's approval-administrator answer.
 *
 * WHY A COMPOSABLE AND NOT AN `onMounted` PER COMPONENT (round-4 item 2). Both consumers — the
 * batch-transfer page and its nav entry — read the capability once in `onMounted` and kept the
 * result in a local `ref`. `adminCapability.ts` invalidates its cache on every auth transition, but
 * an invalidated cache changes nothing for a component that has already resolved: it never asks
 * again. So after an identity change with no remount, a rendered nav entry and a mounted page went
 * on describing the PREVIOUS principal's rights. Every real gate is server-side, so this is a
 * display defect rather than an access one — but a page that says "you are an approval
 * administrator" to someone who is not is the same class of false statement this whole surface
 * exists to remove.
 *
 * WHAT THIS ADDS OVER A BARE READ, and each is pinned by its own test:
 *
 *   1. RE-READS ON A TRANSITION. Subscribed to `onApprovalAdminCapabilityInvalidated`, which fires
 *      AFTER the module cache is dropped — so the re-read is a real request, not the answer that
 *      just became stale. The subscription is torn down on unmount.
 *   2. GOES BACK TO `pending` FIRST, synchronously. The previous principal's answer must not stay
 *      on screen for the duration of the new read. `pending` is the state every consumer already
 *      renders as "nothing actionable yet", so this needs no new UI.
 *   3. GENERATION-GUARDED. Reads are not ordered: a slow first read can settle after the read that
 *      superseded it. Only the answer belonging to the newest read is ever applied, so an old
 *      request can never refill the state after a newer one. The generation is bumped by the
 *      TRANSITION as well as by each new read (round-7): a transition that issues no new read — a
 *      sign-out — must still retire the read already in flight, or the answer about the principal
 *      that has gone would be applied to the surface after it. This is display state; every real
 *      gate is server-side and unchanged.
 *
 * `onInvalidated` is the seam for state a consumer derives FROM the capability — the page's loaded
 * queue, for instance, which belongs to the principal that loaded it and must be dropped with it.
 * It runs synchronously inside the notification, before the re-read is issued.
 */
import { onMounted, onUnmounted, ref, type Ref } from 'vue'
import { onApprovalAdminCapabilityInvalidated, resolveApprovalAdminCapability, type ApprovalAdminCapability } from './adminCapability'
import { getAuthPrincipalKey } from '../composables/authPrincipal'

/** `pending` is "not answered yet" — never a statement about the caller's rights. */
export type ApprovalAdminCapabilityState = ApprovalAdminCapability | 'pending'

function hasSession(): boolean {
  try {
    return getAuthPrincipalKey() !== null
  } catch {
    // A storage read can throw (Safari private mode). "Cannot tell" is not "signed out", so the
    // read is still issued and the server decides.
    return true
  }
}

export function useApprovalAdminCapability(
  options: { onInvalidated?: () => void } = {},
): Ref<ApprovalAdminCapabilityState> {
  const capability = ref<ApprovalAdminCapabilityState>('pending')
  let generation = 0

  async function read(): Promise<void> {
    generation += 1
    const mine = generation
    try {
      const answer = await resolveApprovalAdminCapability()
      // A read that has been superseded says nothing about the principal this surface now holds.
      if (mine !== generation) return
      capability.value = answer
    } catch {
      // `resolveApprovalAdminCapability` answers `unavailable` rather than rejecting today, so this
      // is unreachable — but an unhandled rejection would leave the state at `pending` FOREVER: a
      // surface with no queue, no privilege state and no error, which is the one outcome nothing
      // else covers.
      if (mine !== generation) return
      capability.value = 'unavailable'
    }
  }

  let disposed = false

  const unsubscribe = onApprovalAdminCapabilityInvalidated(() => {
    // RETIRE EVERY READ IN FLIGHT, SYNCHRONOUSLY AND FIRST (round-7). Bumping the generation only
    // inside `read()` tied invalidation to the issuing of a NEW read, and one transition issues
    // none: a sign-out leaves no principal to ask about, so the branch below returns without
    // reading and the counter never moved. A read issued for the previous principal then still
    // matched the current generation when it settled, and wrote its answer — measured as a
    // `granted` answer restoring the form after the session was cleared. Bumping here makes the
    // guard a statement about the TRANSITION rather than about the next request, so it holds
    // whether or not a request follows. Ahead of `onInvalidated` too, so a consumer's own
    // teardown cannot run while an old answer is still eligible to land.
    generation += 1
    // Whatever this surface was showing was about the principal that has just been replaced, and it
    // must not survive a single frame of the new one.
    capability.value = 'pending'
    options.onInvalidated?.()
    // A transition that left NO session is answered without asking: there is no principal to ask
    // about, and the read could only be an anonymous request the endpoint refuses — one last
    // capability probe on the way out of a sign-out. A transition INTO a session, or between two,
    // still re-reads; that is the case this composable exists for.
    //
    // ON A MICROTASK, and that is not a detail: `useAuth`'s funnel ANNOUNCES the transition and
    // writes storage immediately after, so inside the notification the token is still the old one
    // (or already gone, for a sign-in from signed-out). Reading it here would answer about the
    // session that is being left, not the one being entered — every login would look like a
    // sign-out. A microtask runs once the funnel's own synchronous work has finished.
    void Promise.resolve().then(() => {
      if (disposed || !hasSession()) return
      void read()
    })
  })

  onMounted(() => { void read() })
  onUnmounted(() => {
    // Both halves: no further notifications, and no read from a microtask that was already queued.
    disposed = true
    unsubscribe()
  })

  return capability
}
