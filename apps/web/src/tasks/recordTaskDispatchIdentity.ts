/**
 * 派发任务 from a multitable record: WHO a dispatch belongs to.
 *
 * The rule. A page that offers 派发任务 holds one binding (`createDispatchBinding`), made when the page
 * is set up: the signed-in user, the org its requests carry and the org the task service uses (the
 * token's org claim) at that moment. A dispatch is sent only under that identity. The binding is marked
 * CHANGED, for good, the first time the identity a request would carry is seen to differ from it,
 * wherever that is seen:
 *  - right before every multitable request the page sends (the client's before-send hook, wired by the
 *    workbench), so a record read while another user or org was signed in poisons the binding even if
 *    the identity has changed back by the time anyone opens the dialog;
 *  - on a storage change from another tab and on a sign-in, sign-out or org switch in this tab;
 *  - on opening the dialog, right before the create and right before each read/write of the
 *    description step.
 * Once changed, the dialog clears its draft and refuses until the page is reloaded; a dialog opened
 * later, for this or any other record, refuses as well. Coming back to the bound identity does not
 * clear it: the record content on screen may have been read in between.
 *
 * Why a value check and not only a notification: `useAuth` announces the transitions THIS tab
 * performs, but a sign-in in another tab only rewrites the shared storage, and an ordinary (not
 * explicit) session gets no announcement here at all. `apiFetch` reads the stored token and the org
 * header at send time, so the send-time value is the one that has to be compared.
 *
 * What the identity is made of:
 *  - the principal key (`getAuthPrincipalKey`): the token's subject, or for an explicitly selected
 *    session org the actor, org and switch epoch;
 *  - the org header the request will carry (`authHeaders()['x-tenant-id']`), which for an ordinary
 *    session may come from stored hints, the address or the token's claim — none of which the
 *    principal key covers;
 *  - the org the task service uses: the stored token's `tenantId` claim, read the way the server reads
 *    it (only `tenantId`, a string, trimmed, non-empty; `workspaceId` is not read). It is part of the
 *    identity only when the token carries one, so for a token without it the identity is exactly the
 *    first two components, and a claim that appears, disappears or changes is a change like any other.
 * For a token that carries a subject claim the raw token is not part of it, so a token refresh for the
 * same user, org header and org claim keeps the binding. A token without a subject claim is keyed by
 * its text, so a refresh of such a token counts as a change.
 *
 * NOTHING HERE IS AN AUTHORIZATION VALUE: it is derived client-side and only compared for equality.
 * The server checks the token and the org on every request.
 */
import { readonly, ref, type Ref } from 'vue'
import {
  getAuthPrincipalKey,
  onAuthSessionSwitch,
  parseJwtPayload,
  readStoredToken,
} from '../composables/authPrincipal'
import { authHeaders } from '../utils/api'

/** No usable identity: no session, or a session-org switch caught half way. Never equal to anything,
 *  itself included (see `isSameDispatchIdentity`). */
export const NO_DISPATCH_IDENTITY = 'none'

/** The stored token's org claim as the task service reads it, or `''` when it carries none. Never
 *  throws: an unreadable token has no claim. */
function readTokenOrgClaim(): string {
  const token = readStoredToken()
  if (!token) return ''
  const raw = parseJwtPayload(token)?.tenantId
  return typeof raw === 'string' ? raw.trim() : ''
}

/** The identity the next request would carry, or `NO_DISPATCH_IDENTITY`. */
export function readDispatchIdentity(): string {
  try {
    const principal = getAuthPrincipalKey()
    if (principal === null) return NO_DISPATCH_IDENTITY
    const org = authHeaders()['x-tenant-id'] ?? ''
    const claim = readTokenOrgClaim()
    return JSON.stringify(claim ? [principal, org, claim] : [principal, org])
  } catch {
    // A partial explicit switch throws in both readers: not a session.
    return NO_DISPATCH_IDENTITY
  }
}

/** Whether a dispatch bound to `bound` may still send: the current identity is a real one and the
 *  same as the bound one. */
export function isSameDispatchIdentity(bound: string, current: string): boolean {
  return bound !== NO_DISPATCH_IDENTITY && current !== NO_DISPATCH_IDENTITY && bound === current
}

export interface DispatchBinding {
  /** The identity read when the binding was made. */
  readonly identity: string
  /** Set the first time another identity is seen (or at once when there was none); never cleared. */
  readonly changed: Readonly<Ref<boolean>>
  /** Reads the identity a request sent now would carry. `true` while it is the bound one and no other
   *  has been seen; otherwise marks the binding changed and returns `false`. */
  check(): boolean
  /** Stops listening for storage changes and session switches. */
  dispose(): void
}

/** Makes the binding of one page (see the header). The caller disposes it when the page goes away. */
export function createDispatchBinding(): DispatchBinding {
  const identity = readDispatchIdentity()
  const changed = ref(identity === NO_DISPATCH_IDENTITY)
  function check(): boolean {
    if (changed.value) return false
    if (isSameDispatchIdentity(identity, readDispatchIdentity())) return true
    changed.value = true
    return false
  }
  const stopSessionSwitch = onAuthSessionSwitch(() => { check() })
  const onStorage = () => { check() }
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)
  let disposed = false
  return {
    identity,
    changed: readonly(changed),
    check,
    dispose() {
      if (disposed) return
      disposed = true
      stopSessionSwitch()
      if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
    },
  }
}
