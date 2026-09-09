const STORAGE_KEY = 'metasheet.explicitSessionOrg.v1'
export const EXPLICIT_SESSION_ORG_KEY = STORAGE_KEY
const INVALID_SESSION = 'SESSION_ORG_REAUTH_REQUIRED'

type ExplicitSession = { token: string; actor: string; tenantId: string; exp: number; epoch: string }
type SessionChange = { previous: string | null; epoch: string }

// Origin-shared current-session metadata, never a login preference or grant.
// No auth/API imports: the principal module supplies its existing payload parser.
export function readExplicitSession(token: string | null, payload: Record<string, unknown> | null): ExplicitSession | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const marker = JSON.parse(raw)
    const actor = payload?.userId ?? payload?.sub ?? payload?.id
    if (marker?.state !== 'ready' || !token || marker.token !== token
      || typeof marker.actor !== 'string' || !marker.actor || marker.actor !== actor
      || typeof marker.tenantId !== 'string' || !marker.tenantId || marker.tenantId !== payload?.tenantId
      || marker.exp !== payload?.exp || typeof marker.exp !== 'number'
      || !Number.isFinite(marker.exp) || marker.exp <= Date.now() / 1000
      || typeof marker.epoch !== 'string' || !marker.epoch
      || localStorage.getItem('auth_token') !== token || localStorage.getItem('jwt') !== token) {
      throw new Error(INVALID_SESSION)
    }
    return marker as ExplicitSession
  } catch { throw new Error(INVALID_SESSION) }
}

export function beginExplicitSessionOrgChange(expectedToken: string): SessionChange | null {
  try {
    if (localStorage.getItem('auth_token') !== expectedToken) return null
    const change = { previous: localStorage.getItem(STORAGE_KEY), epoch: crypto.randomUUID() }
    // Install the barrier BEFORE either token alias changes. Every reader blocks
    // on this state rather than temporarily falling back to an old login hint.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: 'changing', epoch: change.epoch }))
    return change
  } catch { return null }
}

export function ownsExplicitSessionOrgChange(change: SessionChange): boolean {
  try {
    const marker = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
    return marker?.state === 'changing' && marker.epoch === change.epoch
  } catch { return false }
}

export function installExplicitSessionOrg(token: string, tenantId: string, payload: Record<string, unknown>, change: SessionChange): boolean {
  const actor = payload.userId ?? payload.sub ?? payload.id
  if (typeof actor !== 'string' || !actor || payload.tenantId !== tenantId
    || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= Date.now() / 1000) return false
  try {
    if (!ownsExplicitSessionOrgChange(change) || localStorage.getItem('auth_token') !== token
      || localStorage.getItem('jwt') !== token) return false
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: 'ready', token, actor, tenantId, exp: payload.exp, epoch: change.epoch }))
    const published = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
    return published?.state === 'ready' && published.epoch === change.epoch
      && localStorage.getItem('auth_token') === token && localStorage.getItem('jwt') === token
  } catch { return false }
}

export function restoreExplicitSessionOrg(change: SessionChange): void {
  if (!ownsExplicitSessionOrgChange(change)) return
  if (change.previous === null) localStorage.removeItem(STORAGE_KEY)
  else localStorage.setItem(STORAGE_KEY, change.previous)
}

export function clearExplicitSessionOrg(): void {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* An unreadable marker remains fail-closed. */ }
}
