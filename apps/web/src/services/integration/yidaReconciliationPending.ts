import { parseJwtPayload, readAuthSessionSignature, readStoredToken } from '../../composables/authPrincipal'
import { parseYidaReconciliationInput, type YidaReconciliationInput } from './yidaReconciliation'

const prefix = 'metasheet:yida-reconciliation-pending:v1:'
function unavailable(): never { throw new Error('YIDA_RECONCILIATION_RECOVERY_REQUIRED') }
/** Tab-local recovery journal, not authority. No JWT or raw evidence stored.
 * Never evict unresolved commands. If storage fails, DO NOT submit a new fact.
 * Stable across token refresh for the same subject/tenant; every server request
 * still rechecks its real JWT, live ACL and owner. No automatic replay. */
export async function openYidaReconciliationPending(grantId: string, requestId: string) {
  const signature = readAuthSessionSignature(), token = readStoredToken(), claims = token && parseJwtPayload(token)
  const subject = claims && (claims.sub ?? claims.userId ?? claims.id), tenant = claims && claims.tenantId
  if (signature === 'invalid' || typeof subject !== 'string' || !subject || typeof tenant !== 'string' || !tenant
    || !/^[a-f0-9-]{36}$/u.test(grantId) || !/^[a-f0-9-]{36}$/u.test(requestId)) unavailable()
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([subject, tenant, grantId, requestId])))
  const key = prefix + Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('')
  const current = () => { if (readAuthSessionSignature() !== signature) unavailable() }
  current()
  return Object.freeze({
    read(): YidaReconciliationInput | null {
      current()
      const raw = sessionStorage.getItem(key)
      if (raw === null) return null
      if (raw.length > 4096) unavailable()
      return parseYidaReconciliationInput(JSON.parse(raw))
    },
    save(input: YidaReconciliationInput) {
      current()
      const captured = parseYidaReconciliationInput(input), raw = JSON.stringify(captured), old = sessionStorage.getItem(key)
      if (old !== null && old !== raw) unavailable()
      if (old === null && Object.keys(sessionStorage).filter(item => item.startsWith(prefix)).length >= 16) unavailable()
      sessionStorage.setItem(key, raw)
      if (sessionStorage.getItem(key) !== raw) unavailable()
    },
    remove(commandKey: string) {
      current()
      const raw = sessionStorage.getItem(key)
      if (raw !== null && parseYidaReconciliationInput(JSON.parse(raw)).commandKey !== commandKey) unavailable()
      sessionStorage.removeItem(key)
    },
  })
}
