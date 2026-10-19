/** Server-only native response parser. Expected authority comes from the locked
 * Meta intent. Parsing does not replace target permission and mapping locks. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { BomReviewError, parseManagedSnapshot, type ShareSnapshot } from '../multitable/plm-bom-review-wire'

function clean(value: string): boolean {
  return value === value.trim() && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
}
const id = z.string().min(1).max(128).refine(clean)
export const snapshotShareTargetSchema = z.object({
  tenant_id: id, org_id: id, user_id: id, base_id: id, sheet_id: id,
  source_id: id, binding_id: id, binding_generation: z.number().int().positive().safe(), session_id: id,
  audience: z.string().min(1).max(1000).refine(clean),
}).strict()
export type SnapshotShareTarget = z.infer<typeof snapshotShareTargetSchema>
const authoritySchema = z.object({
  intentId: z.string().uuid(), operationId: z.string().uuid(), target: snapshotShareTargetSchema,
  source: z.object({ tenant_id: id, org_id: id, auth_user_id: z.string().regex(/^[1-9][0-9]*$/), part_id: id }).strict(),
}).strict()
export type SnapshotShareAuthority = z.infer<typeof authoritySchema>
const receiptSchema = z.object({
  contract: z.literal('bom_snapshot_share.v1'), policy: z.literal('authorized_snapshot_target_acl.v1'),
  intent_id: z.string().uuid(), operation_id: z.string().uuid(), target: snapshotShareTargetSchema,
  confirmed_at: z.string().datetime(), expires_at: z.string().datetime(),
  snapshot_hash: z.string().regex(/^[0-9a-f]{64}$/), snapshot_base64: z.string().min(4),
}).strict()

export function parseNativeSnapshotShareExport(value: unknown, authority: SnapshotShareAuthority): {
  snapshot: ShareSnapshot
  nativeSnapshotHash: string
  confirmedAt: string
  expiresAt: string
} {
  const expected = authoritySchema.safeParse(authority)
  if (!expected.success) throw new BomReviewError(403, 'PLM_SNAPSHOT_SHARE_TARGET_CHANGED')
  const bound = expected.data
  const parsed = receiptSchema.safeParse(value)
  if (!parsed.success) throw new BomReviewError(502, 'PLM_SNAPSHOT_SHARE_INVALID')
  const receipt = parsed.data
  if (receipt.intent_id !== bound.intentId || receipt.operation_id !== bound.operationId
    || Object.entries(bound.target).some(([key, expected]) => receipt.target[key as keyof SnapshotShareTarget] !== expected)) {
    throw new BomReviewError(403, 'PLM_SNAPSHOT_SHARE_TARGET_CHANGED')
  }
  const confirmed = Date.parse(receipt.confirmed_at), expires = Date.parse(receipt.expires_at)
  if (expires <= Date.now()) throw new BomReviewError(409, 'PLM_SNAPSHOT_SHARE_EXPIRED')
  if (confirmed >= expires || expires - confirmed > 300_000) throw new BomReviewError(502, 'PLM_SNAPSHOT_SHARE_INVALID')
  let decoded: unknown
  try {
    const bytes = Buffer.from(receipt.snapshot_base64, 'base64')
    // Python and JavaScript number formatting differ: hash original native bytes.
    if (bytes.toString('base64') !== receipt.snapshot_base64
      || createHash('sha256').update(bytes).digest('hex') !== receipt.snapshot_hash) throw new Error()
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new BomReviewError(502, 'PLM_SNAPSHOT_SHARE_INVALID')
  }
  const envelope = z.object({ source: z.unknown(), context: z.unknown() }).strict().safeParse(decoded)
  if (!envelope.success) throw new BomReviewError(502, 'PLM_SNAPSHOT_SHARE_INVALID')
  const validated = parseManagedSnapshot({
    projection_contract: 'bom_review_managed.v1', feature_key: 'bom_multitable', entitled: true,
    upgrade: { available: false }, snapshot_at: receipt.confirmed_at, ...envelope.data,
  }, bound.source)
  return {
    snapshot: { ...validated, projection_contract: 'bom_review_share.v1' },
    nativeSnapshotHash: receipt.snapshot_hash, confirmedAt: receipt.confirmed_at, expiresAt: receipt.expires_at,
  }
}
