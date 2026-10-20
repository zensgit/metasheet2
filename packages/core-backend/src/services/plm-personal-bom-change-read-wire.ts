/** Personal change reads use frozen persisted authority, never a shared source credential.
 * Target shape restricts the grant; enrollment must separately prove current Meta ACL. */
import { z } from 'zod'
import { canonicalPlmEvent } from '../multitable/plm-wire'
import { parsePlmChangeEvent, parsePlmChangePage } from '../multitable/plm-change-ingress-wire'
import { snapshotShareTargetSchema } from './plm-managed-snapshot-share-wire'
import { resolvePersistedPlmSource, trustedRequestOrigin } from './plm-personal-bom-write-wire'

const id = z.string().min(1).refine(value => [...value].length <= 128 && value === value.trim()
  && !/[\u0000-\u001f\u007f]/.test(value) && !/[\ud800-\udfff]/u.test(value))
const root = id.refine(value => !/[/?#\\]/.test(value) && value !== '.' && value !== '..')
const uuid = z.string().uuid().refine(value => value === value.toLowerCase())
const version = z.number().int().positive().safe()
export const personalChangeReadAuthoritySchema = z.object({
  origin: z.string(), connectionId: id, tenantId: id, orgId: id,
  authUserId: z.string().regex(/^[1-9][0-9]*$/), rootPartId: root,
  target: snapshotShareTargetSchema, reviewBindingId: uuid, reviewBindingVersion: version,
}).strict()
export type PersonalChangeReadAuthority = z.infer<typeof personalChangeReadAuthoritySchema>
const callSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('verify') }).strict(),
  z.object({ operation: z.literal('revoke') }).strict(),
  z.object({ operation: z.literal('page'), afterSequence: z.number().int().nonnegative().safe().optional() }).strict(),
  z.object({ operation: z.literal('fact'), eventId: uuid }).strict(),
])
export type PersonalChangeReadCall = z.infer<typeof callSchema>
export const YUE_GRANT = /^yue_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/
export const personalChangeReadConnectionIdSchema = id.refine(value => !/^(?:yua|yuw|yur|yue)_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/.test(value))
const bindingSchema = z.object({
  schema: z.literal('yuantus.plm-bom-change-read-binding.v1'),
  grant_id: z.string().regex(/^[0-9a-f]{32}$/), connection_id: id, tenant_id: id, org_id: id,
  auth_user_id: z.string().regex(/^[1-9][0-9]*$/), expires_at: z.string().datetime(),
  purpose: z.literal('bom_change_read'), root_part_id: root, target: snapshotShareTargetSchema,
  review_binding_id: uuid, review_binding_version: version, confirmed_scope: z.literal('bom_change_read.v1'),
}).strict()

export class PlmPersonalChangeReadError extends Error {
  constructor(readonly status: number, readonly code: string, readonly responseReceived = false) { super(code) }
}
export function requirePersonalChangeRead(): void {
  if (process.env.PLM_PERSONAL_BOM_CHANGE_READ_ENABLED !== 'true')
    throw new PlmPersonalChangeReadError(404, 'PLM_CHANGE_READ_DISABLED')
}
function authority(value: PersonalChangeReadAuthority): PersonalChangeReadAuthority {
  const parsed = personalChangeReadAuthoritySchema.safeParse(value)
  if (!parsed.success) throw new PlmPersonalChangeReadError(422, 'PLM_CHANGE_READ_INVALID')
  try { trustedRequestOrigin(parsed.data.origin) }
  catch { throw new PlmPersonalChangeReadError(403, 'PLM_CHANGE_READ_FORBIDDEN') }
  return parsed.data
}

export function personalChangeReadManagementUrl(sourceConfig: unknown, expected: PersonalChangeReadAuthority): string {
  requirePersonalChangeRead()
  const scope = authority(expected)
  try {
    const source = resolvePersistedPlmSource(sourceConfig)
    if (source.origin.origin !== scope.origin || source.tenantId !== scope.tenantId || source.orgId !== scope.orgId) throw new Error()
  } catch { throw new PlmPersonalChangeReadError(403, 'PLM_CHANGE_READ_FORBIDDEN') }
  const request = { connection_id: scope.connectionId, root_part_id: scope.rootPartId, target: scope.target,
    review_binding_id: scope.reviewBindingId, review_binding_version: scope.reviewBindingVersion }
  return new URL('/personal-approval-grants', scope.origin).href
    + '#bom-change-read?request=' + encodeURIComponent(JSON.stringify(request))
}

export function preparePersonalChangeRead(call: PersonalChangeReadCall, grant: string, expected: PersonalChangeReadAuthority) {
  const parsed = callSchema.safeParse(call)
  if (!parsed.success) throw new PlmPersonalChangeReadError(422, 'PLM_CHANGE_READ_INVALID')
  if (parsed.data.operation !== 'revoke') requirePersonalChangeRead()
  const match = YUE_GRANT.exec(grant)
  if (!match) throw new PlmPersonalChangeReadError(403, 'PLM_CHANGE_READ_FORBIDDEN')
  const scope = authority(expected)
  const prefix = '/api/v1/plm-bom-change-read-grant'
  const operation = parsed.data.operation
  const path = operation === 'verify' ? prefix + '/verify' : operation === 'revoke' ? prefix + '/grant'
    : prefix + '/roots/' + encodeURIComponent(scope.rootPartId) + '/change-events'
      + (parsed.data.operation === 'fact' ? '/' + parsed.data.eventId : '')
  const url = new URL(path, scope.origin)
  if (parsed.data.operation === 'page' && parsed.data.afterSequence !== undefined)
    url.searchParams.set('after_sequence', String(parsed.data.afterSequence))
  return { call: parsed.data, scope, grantId: match[1], url,
    method: operation === 'verify' ? 'POST' : operation === 'revoke' ? 'DELETE' : 'GET',
    headers: { Authorization: `Bearer ${grant}`, 'Content-Type': 'application/json',
      'x-tenant-id': scope.tenantId, 'x-org-id': scope.orgId },
    body: operation === 'verify' ? JSON.stringify({ connection_id: scope.connectionId }) : undefined }
}

export function parsePersonalChangeRead(prepared: ReturnType<typeof preparePersonalChangeRead>, status: number, body: string) {
  const { scope, call } = prepared
  if (call.operation === 'revoke') {
    if (status !== 204 || body) throw new PlmPersonalChangeReadError(502, 'PLM_CHANGE_READ_INVALID_RESPONSE')
    return null
  }
  if (status !== 200 || Buffer.byteLength(body) > 2_000_000)
    throw new PlmPersonalChangeReadError(502, 'PLM_CHANGE_READ_INVALID_RESPONSE')
  try {
    const value: unknown = JSON.parse(body)
    const source = { connection_id: scope.target.source_id, tenant_id: scope.tenantId,
      org_id: scope.orgId, part_id: scope.rootPartId }
    if (call.operation === 'verify') {
      const row = bindingSchema.parse(value)
      if (row.grant_id !== prepared.grantId || row.connection_id !== scope.connectionId
        || row.tenant_id !== scope.tenantId || row.org_id !== scope.orgId || row.auth_user_id !== scope.authUserId
        || row.root_part_id !== scope.rootPartId || row.review_binding_id !== scope.reviewBindingId
        || row.review_binding_version !== scope.reviewBindingVersion
        || canonicalPlmEvent(row.target) !== canonicalPlmEvent(scope.target) || Date.parse(row.expires_at) <= Date.now()) throw new Error()
      return row
    }
    const request = { binding_id: scope.reviewBindingId, binding_version: scope.reviewBindingVersion, source }
    if (call.operation === 'page') return parsePlmChangePage(value, { ...request,
      ...(call.afterSequence === undefined ? {} : { after_sequence: call.afterSequence }) })
    const event = parsePlmChangeEvent(value)
    if (event.event_id !== call.eventId || event.binding_id !== scope.reviewBindingId
      || event.binding_version !== scope.reviewBindingVersion || canonicalPlmEvent(event.source) !== canonicalPlmEvent(source)) throw new Error()
    return event
  } catch { throw new PlmPersonalChangeReadError(502, 'PLM_CHANGE_READ_INVALID_RESPONSE') }
}
