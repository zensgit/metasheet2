import { z } from 'zod'
import { evaluateUserAuthenticationGate } from '../auth/user-activation'
import {
  lockRecordLinkAuthorityRowsOnQuery,
  resolveRecordLinkTargetAuthOnQuery,
} from '../services/approval-record-link-txn-auth'
import { fenceWriterEntry, isWriterFenceEnabled } from './canonical-sheet-fence'
import { isDurableDeliveryEnabled } from './automation-durable-delivery'
import { loadFieldPermissionScopeMap } from './permission-service'
import { assertInTransaction } from './pg-transaction-guard'
import {
  canonicalPlmEvent,
  isPlmRecordIngressEnabled,
  plmId,
  plmSourceSchema,
  PlmIngressError,
} from './plm-record-ingress-wire'

export type PlmQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: any[]; rowCount: number }>
export interface PlmPool {
  transaction<T>(fn: (tx: { query: PlmQuery }) => Promise<T>): Promise<T>
}
export const plmBindingSchema = z
  .object({
    id: z.string().uuid(),
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    token_id: plmId,
    source: plmSourceSchema,
    sheet_id: plmId,
    fields: z.object({ quantity: plmId, uom: plmId, find_num: plmId, refdes: plmId }).strict(),
  })
  .strict()
  .refine((v) => new Set(Object.values(v.fields)).size === 4)
export type PlmBindingConfig = z.infer<typeof plmBindingSchema>
export type PlmBinding = PlmBindingConfig & {
  creator_id: string
  base_id: string
  enabled: boolean
}

export function requirePlmIngressRuntime(): void {
  if (!isPlmRecordIngressEnabled() || !isDurableDeliveryEnabled() || !isWriterFenceEnabled()) {
    throw new PlmIngressError(503, 'ingress_unavailable')
  }
}

// All reads use the real transaction; no cached JWT/RBAC snapshot authorizes a write or a receipt replay.
export async function verifyPlmBindingAuthority(
  query: PlmQuery,
  binding: PlmBinding,
  actorId?: string,
): Promise<string> {
  const token = (
    await query('SELECT * FROM multitable_api_tokens WHERE id=$1 FOR SHARE', [binding.token_id])
  ).rows[0]
  if (
    !token ||
    token.revoked ||
    (token.expires_at && new Date(token.expires_at).getTime() <= Date.now()) ||
    token.created_by !== binding.creator_id ||
    (actorId && actorId !== token.created_by)
  )
    throw new PlmIngressError(401, 'invalid_token')
  const scopes = typeof token.scopes === 'string' ? JSON.parse(token.scopes) : token.scopes
  if (!Array.isArray(scopes) || !scopes.includes('records:write'))
    throw new PlmIngressError(403, 'forbidden')
  if (
    (token.base_ids?.length && !token.base_ids.includes(binding.base_id)) ||
    (token.sheet_ids?.length && !token.sheet_ids.includes(binding.sheet_id))
  )
    throw new PlmIngressError(403, 'forbidden')
  await lockRecordLinkAuthorityRowsOnQuery(query, {
    userId: token.created_by,
    baseId: binding.base_id,
    sheetId: binding.sheet_id,
  })
  const user = (
    await query(
      'SELECT is_active,role,activation_status,local_password_set FROM users WHERE id=$1',
      [token.created_by],
    )
  ).rows[0]
  if (!user || evaluateUserAuthenticationGate(user)) throw new PlmIngressError(401, 'invalid_token')
  const access = await resolveRecordLinkTargetAuthOnQuery(query, {
    userId: token.created_by,
    baseId: binding.base_id,
    sheetId: binding.sheet_id,
  })
  if (!access.ok || !access.capabilities.canCreateRecord || !access.capabilities.canEditRecord)
    throw new PlmIngressError(403, 'forbidden')
  const fields = (
    await query(
      'SELECT id,type,property FROM meta_fields WHERE sheet_id=$1 AND id=ANY($2::text[]) FOR SHARE',
      [binding.sheet_id, Object.values(binding.fields)],
    )
  ).rows
  if (
    fields.length !== 4 ||
    fields.some(
      (f) =>
        f.type !== 'string' || !(f.property?.readOnly === true || f.property?.readonly === true),
    )
  )
    throw new PlmIngressError(409, 'binding_invalid')
  await query(
    'SELECT field_id FROM field_permissions WHERE sheet_id=$1 AND field_id=ANY($2::text[]) FOR SHARE',
    [binding.sheet_id, Object.values(binding.fields)],
  )
  const fieldScopes = await loadFieldPermissionScopeMap(query, binding.sheet_id, token.created_by)
  if (
    Object.values(binding.fields).some((id) => {
      const s = fieldScopes.get(id)
      return s && (!s.visible || s.readOnly)
    })
  )
    throw new PlmIngressError(403, 'forbidden')
  if (token.expires_at && new Date(token.expires_at).getTime() <= Date.now())
    throw new PlmIngressError(401, 'invalid_token')
  return token.created_by
}

export async function provisionPlmRecordBinding(
  pool: PlmPool,
  input: unknown,
  options: { apply: boolean },
): Promise<PlmBinding> {
  const config = plmBindingSchema.parse(input)
  requirePlmIngressRuntime()
  return pool.transaction(async ({ query }) => {
    await assertInTransaction({ query }, 'provisionPlmRecordBinding')
    await fenceWriterEntry(query, config.sheet_id)
    requirePlmIngressRuntime()
    const sheet = (
      await query('SELECT base_id FROM meta_sheets WHERE id=$1 AND deleted_at IS NULL FOR SHARE', [
        config.sheet_id,
      ])
    ).rows[0]
    const token = (
      await query('SELECT created_by FROM multitable_api_tokens WHERE id=$1', [config.token_id])
    ).rows[0]
    if (!sheet?.base_id || !token?.created_by) throw new PlmIngressError(403, 'forbidden')
    const binding: PlmBinding = {
      ...config,
      base_id: sheet.base_id,
      creator_id: token.created_by,
      enabled: true,
    }
    await verifyPlmBindingAuthority(query, binding)
    const existing = (
      await query('SELECT * FROM meta_plm_record_bindings WHERE id=$1 OR sheet_id=$2 FOR UPDATE', [
        binding.id,
        binding.sheet_id,
      ])
    ).rows[0]
    if (existing) {
      const same = plmBindingSchema.parse({
        id: existing.id,
        version: Number(existing.version),
        token_id: existing.token_id,
        source: existing.source,
        sheet_id: existing.sheet_id,
        fields: existing.fields,
      })
      if (
        canonicalPlmEvent(same) !== canonicalPlmEvent(config) ||
        !existing.enabled ||
        existing.creator_id !== binding.creator_id ||
        existing.base_id !== binding.base_id
      )
        throw new PlmIngressError(409, 'binding_conflict')
      return binding
    }
    if (options.apply)
      await query(
        `INSERT INTO meta_plm_record_bindings(id,version,token_id,creator_id,source,sheet_id,base_id,fields)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb)`,
        [
          binding.id,
          binding.version,
          binding.token_id,
          binding.creator_id,
          JSON.stringify(binding.source),
          binding.sheet_id,
          binding.base_id,
          JSON.stringify(binding.fields),
        ],
      )
    return binding
  })
}

export async function disablePlmRecordBinding(pool: PlmPool, id: string): Promise<void> {
  z.string().uuid().parse(id)
  await pool.transaction(async ({ query }) => {
    await assertInTransaction({ query }, 'disablePlmRecordBinding')
    const row = (await query('SELECT sheet_id FROM meta_plm_record_bindings WHERE id=$1', [id]))
      .rows[0]
    if (!row) throw new PlmIngressError(404, 'binding_unavailable')
    await fenceWriterEntry(query, row.sheet_id)
    await query('UPDATE meta_plm_record_bindings SET enabled=false WHERE id=$1', [id])
  })
}
