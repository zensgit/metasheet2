/**
 * 派发任务 from a multitable record: WHO a dispatch belongs to.
 *
 * The rule. A dispatch is bound to the signed-in user and the organization its requests will carry,
 * read once when the multitable page was loaded (the workbench; a drawer used elsewhere reads it once
 * when it is set up). The rows on screen — and so a record's title, person ids and link — were read
 * under that identity, so they may only be sent under it. It is not re-read on a move to another
 * record or on opening the dialog, since those rows come from the same load. Before the create and
 * before the description write, the identity the request will actually carry is read again; if it is
 * not the bound one, nothing is sent and the dialog refuses until the page is reloaded. The dispatch
 * state of each record is kept per identity as well, so one identity never sees another's pending or
 * created task.
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
 *    principal key covers.
 * The raw token is left out, so a token refresh for the same user and org keeps the draft.
 *
 * NOTHING HERE IS AN AUTHORIZATION VALUE: it is derived client-side and only compared for equality.
 * The server checks the token and the org on every request.
 */
import { getAuthPrincipalKey } from '../composables/authPrincipal'
import { authHeaders } from '../utils/api'

/** No usable identity: no session, or a session-org switch caught half way. Never equal to anything,
 *  itself included (see `isSameDispatchIdentity`). */
export const NO_DISPATCH_IDENTITY = 'none'

/** The identity the next request would carry, or `NO_DISPATCH_IDENTITY`. */
export function readDispatchIdentity(): string {
  try {
    const principal = getAuthPrincipalKey()
    if (principal === null) return NO_DISPATCH_IDENTITY
    const org = authHeaders()['x-tenant-id'] ?? ''
    return JSON.stringify([principal, org])
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
