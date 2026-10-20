/** Separate-purpose native consent, followed by the existing BOM publication engine. */
import type { Request, Response } from 'express'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { query as globalQuery, transaction } from '../db/pg'
import { encryptStoredSecretValue, decryptStoredSecretValue } from '../security/encrypted-secrets'
import { PlmBomReviewService, type BomReviewDependencies } from '../multitable/plm-bom-review-service'
import type { PlmQuery } from '../multitable/plm-bom-review-db'
import { canonical, hash } from '../multitable/plm-bom-review-wire'
import { getObjectSheetId } from '../multitable/provisioning'
import { currentManagedRequest } from './plm-managed-request-context'
import { lockManagedBomAuthority } from './plm-managed-bom-authority'
import {
  ManagedCompanionRefusal as Refusal, isPlmManagedCompanionEnabled,
  registrationFor, randomUrlToken, pkceS256, sha256Hex, hashesEqual, readRequestCookie, cookieSecureFor,
  type ManagedClientRegistration,
} from './plm-managed-companion'
import { nativePrepareSnapshotShare, nativeExportSnapshotShare, nativeCancelSnapshotShare } from './plm-managed-native-http'
import type { SnapshotShareAuthority, SnapshotShareTarget } from './plm-managed-snapshot-share-wire'

const NONCE_COOKIE = 'plm_snapshot_share_nonce'
const INTENT_COOKIE = 'plm_snapshot_share_intent'
const RETURN_PATH = '/plm/snapshot-share-return'
const id = z.string().min(1).max(128)
const startSchema = z.object({ operationId: z.string().uuid(), dataSourceId: id, partId: id,
  baseId: id, name: z.string().trim().min(1).max(200) }).strict()
const completeSchema = z.object({ operationId: z.string().uuid(), code: z.string().regex(/^yus_[0-9a-f-]{36}\.[0-9a-f]{64}$/),
  state: z.string().min(1).max(512) }).strict()
const completionSchema = z.union([completeSchema, z.object({ operationId: z.string().uuid() }).strict()])
type Intent = Record<string, any>

function enabled(): void {
  if (!isPlmManagedCompanionEnabled() || process.env.PLM_MANAGED_SNAPSHOT_SHARE_ENABLED !== 'true') {
    throw new Refusal(403, 'PLM_SNAPSHOT_SHARE_DISABLED')
  }
}
function registration(row: Intent): ManagedClientRegistration {
  const source = row.source_identity
  const reg = registrationFor({ issuer: row.installation_issuer,
    nativeTenantId: source.tenant_id, nativeOrgId: source.org_id })
  if (hash(reg) !== row.registration_hash) throw new Refusal(403, 'PLM_SNAPSHOT_SHARE_REGISTRATION_CHANGED')
  return reg
}
function cookieOptions(origin: string) {
  return { httpOnly: true as const, sameSite: 'lax' as const, secure: cookieSecureFor(origin), path: '/' }
}
function requestGuard(req: Request, origin: string, action: 'start' | 'complete'): void {
  if (req.get('origin') !== origin || req.get('x-plm-snapshot-share') !== action
      || req.get('content-type')?.split(';')[0].trim() !== 'application/json') {
    throw new Refusal(403, 'PLM_SNAPSHOT_SHARE_BROWSER_REFUSED')
  }
}
function cookieAuthority(req: Request, row: Intent): void {
  const nonce = readRequestCookie(req.headers.cookie, NONCE_COOKIE)
  if (readRequestCookie(req.headers.cookie, INTENT_COOKIE) !== row.id || !nonce || !hashesEqual(sha256Hex(nonce), row.nonce_hash)) {
    throw new Refusal(403, 'PLM_SNAPSHOT_SHARE_BROWSER_REFUSED')
  }
}

/** Snapshot sharing still requires its independent product gate. */
async function lockAuthority(q: PlmQuery, req: Request, sourceId: string, partId: string) {
  enabled()
  return lockManagedBomAuthority(q, req, sourceId, partId)
}

function matchFrozen(row: Intent, current: Awaited<ReturnType<typeof lockAuthority>>): void {
  if (row.actor_id !== current.actor || row.link_id !== current.row.link_id || row.session_id !== current.row.session_id
      || row.generation !== current.row.generation || row.source_fingerprint !== current.row.source_fingerprint
      || row.meta_tenant_id !== current.row.meta_tenant_id || row.meta_org_id !== current.row.meta_org_id
      || canonical(row.source_identity) !== canonical(current.source) || row.registration_hash !== hash(current.reg)) {
    throw new Refusal(409, 'PLM_SNAPSHOT_SHARE_IDENTITY_CHANGED')
  }
}

export class PlmManagedSnapshotShareFlow {
  private readonly reviews: PlmBomReviewService
  constructor(private readonly deps: BomReviewDependencies) { this.reviews = new PlmBomReviewService(deps) }

  async targets(req: Request) {
    enabled()
    const input = z.object({ dataSourceId: id, partId: id }).strict().parse(req.query)
    const actor = await this.deps.pool.transaction(async ({ query: q }) =>
      (await lockAuthority(q, req, input.dataSourceId, input.partId)).actor)
    return { ok: true, data: await this.reviews.bases(actor) }
  }

  async start(req: Request, res: Response) {
    enabled()
    const input = startSchema.parse(req.body)
    const nonce = randomUrlToken(), verifier = randomUrlToken(), state = randomUrlToken()
    const sealed = encryptStoredSecretValue(verifier)
    if (!sealed.startsWith('enc:')) throw new Refusal(503, 'PLM_SNAPSHOT_SHARE_SECRET_UNAVAILABLE')
    const intent = await this.deps.pool.transaction(async ({ query: q }) => {
      const current = await lockAuthority(q, req, input.dataSourceId, input.partId)
      requestGuard(req, current.reg.origin, 'start')
      await this.reviews.authorizeSnapshotTargetOnQuery(q, current.actor, input.baseId)
      await q('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['plm:snapshot-share:' + current.actor + ':' + input.operationId])
      const existing = (await q('SELECT * FROM plm_snapshot_share_intents WHERE actor_id=$1 AND operation_id=$2 FOR UPDATE', [current.actor, input.operationId])).rows[0]
      if (existing) {
        cookieAuthority(req, existing)
        matchFrozen(existing, current)
        if (existing.base_id !== input.baseId || existing.name !== input.name || existing.status !== 'pending' && existing.status !== 'prepared'
            || new Date(existing.expires_at).getTime() <= Date.now()) throw new Refusal(409, 'PLM_SNAPSHOT_SHARE_OPERATION_BOUND')
        return existing as Intent
      }
      const intentId = randomUUID()
      const baseName = (await q('SELECT name FROM meta_bases WHERE id=$1', [input.baseId])).rows[0]?.name
      const target: SnapshotShareTarget = { tenant_id: current.row.meta_tenant_id, org_id: current.row.meta_org_id,
        user_id: current.actor, base_id: input.baseId, sheet_id: getObjectSheetId('plm-bom-review', intentId),
        source_id: input.dataSourceId, binding_id: current.row.link_id, binding_generation: current.row.generation,
        session_id: current.row.session_id,
        audience: `MetaSheet 目标空间 ${JSON.stringify(String(baseName).slice(0,100))} (${input.baseId})：按目标权限访问，包括当前及后续被授权成员和系统管理员。原生撤权不删除已有快照。` }
      return (await q(`INSERT INTO plm_snapshot_share_intents(id,operation_id,actor_id,link_id,session_id,data_source_id,generation,
        meta_tenant_id,meta_org_id,base_id,name,source_fingerprint,source_identity,target,registration_hash,state,nonce_hash,verifier_ciphertext,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16,$17,$18,now()+interval '5 minutes') RETURNING *`,
        [intentId,input.operationId,current.actor,current.row.link_id,current.row.session_id,input.dataSourceId,current.row.generation,
          current.row.meta_tenant_id,current.row.meta_org_id,input.baseId,input.name,current.row.source_fingerprint,
          JSON.stringify(current.source),JSON.stringify(target),hash(current.reg),state,sha256Hex(nonce),sealed])).rows[0] as Intent
    })
    // Set before backchannel I/O: a lost response can retry the same operation and browser nonce.
    const reg = registrationFor({ issuer: (await this.deps.pool.query('SELECT installation_issuer FROM plm_managed_identity_links WHERE id=$1', [intent.link_id])).rows[0]?.installation_issuer,
      nativeTenantId: intent.source_identity.tenant_id, nativeOrgId: intent.source_identity.org_id })
    if (hash(reg) !== intent.registration_hash) throw new Refusal(403, 'PLM_SNAPSHOT_SHARE_REGISTRATION_CHANGED')
    if (!readRequestCookie(req.headers.cookie, INTENT_COOKIE) || readRequestCookie(req.headers.cookie, INTENT_COOKIE) !== intent.id) {
      res.cookie(INTENT_COOKIE, intent.id, { ...cookieOptions(reg.origin), maxAge: 300_000 })
      res.cookie(NONCE_COOKIE, nonce, { ...cookieOptions(reg.origin), maxAge: 300_000 })
    }
    const prepared = await nativePrepareSnapshotShare(reg, { operationId: intent.operation_id,
      nativeUserId: Number(intent.source_identity.auth_user_id), rootPartId: intent.source_identity.part_id,
      target: intent.target, state: intent.state, codeChallenge: pkceS256(decryptStoredSecretValue(intent.verifier_ciphertext)) })
    try { await this.deps.pool.transaction(async ({ query: q }) => {
      const current = await lockAuthority(q, req, intent.data_source_id, intent.source_identity.part_id)
      const row = (await q('SELECT * FROM plm_snapshot_share_intents WHERE id=$1 FOR UPDATE', [intent.id])).rows[0]
      matchFrozen(row, current)
      await this.reviews.authorizeSnapshotTargetOnQuery(q, current.actor, row.base_id)
      if (!['pending','prepared'].includes(row.status) || new Date(row.expires_at).getTime() <= Date.now()
          || row.native_intent_id && row.native_intent_id !== prepared.intentId) throw new Refusal(409, 'PLM_SNAPSHOT_SHARE_OPERATION_BOUND')
      await q("UPDATE plm_snapshot_share_intents SET native_intent_id=$2,status='prepared' WHERE id=$1", [row.id,prepared.intentId])
    }) } catch (error) {
      await this.deps.pool.query(`UPDATE plm_snapshot_share_intents SET native_intent_id=$2,status='cancel_pending'
        WHERE id=$1 AND status IN ('pending','prepared','cancel_pending')`, [intent.id,prepared.intentId])
      try {
        await nativeCancelSnapshotShare(reg, { intentId: prepared.intentId, operationId: intent.operation_id })
        await this.deps.pool.query("UPDATE plm_snapshot_share_intents SET status='cancelled',cancelled_at=now() WHERE id=$1 AND status='cancel_pending'", [intent.id])
      } catch { /* Durable cancel_pending is retried without granting publication. */ }
      throw error
    }
    return { ok: true, navigationUrl: prepared.navigationUrl }
  }

  async complete(req: Request) {
    enabled()
    const input = completionSchema.parse(req.body)
    const intent = (await this.deps.pool.query('SELECT i.*,l.installation_issuer FROM plm_snapshot_share_intents i JOIN plm_managed_identity_links l ON l.id=i.link_id WHERE i.operation_id=$1 AND i.actor_id=$2', [input.operationId,req.user?.id])).rows[0] as Intent
    if (!intent) throw new Refusal(404, 'PLM_SNAPSHOT_SHARE_NOT_FOUND')
    cookieAuthority(req, intent)
    const reg = registration(intent)
    requestGuard(req, reg.origin, 'complete')
    if ('state' in input && !hashesEqual(input.state, intent.state)) throw new Refusal(403, 'PLM_SNAPSHOT_SHARE_BROWSER_REFUSED')
    if (intent.status === 'published') {
      const store = currentManagedRequest()
      if (!store || store.conflict || store.userId !== intent.actor_id || store.sessionId !== intent.session_id
          || req.authenticatedTenantId !== intent.meta_tenant_id) throw new Refusal(403, 'PLM_SNAPSHOT_SHARE_IDENTITY_CHANGED')
      return this.deps.pool.transaction(async ({ query: q }) => ({ ok: true,
        data: await this.reviews.retainedSnapshotOnQuery(q, intent.actor_id, intent.binding_id) }))
    }
    if (intent.status !== 'prepared' || new Date(intent.expires_at).getTime() <= Date.now()) {
      throw new Refusal(409, 'PLM_SNAPSHOT_SHARE_OPERATION_BOUND')
    }
    if (!('code' in input)) throw new Refusal(409, 'PLM_SNAPSHOT_SHARE_CONFIRMATION_REQUIRED')
    const authority: SnapshotShareAuthority = { intentId: intent.native_intent_id, operationId: intent.operation_id,
      target: intent.target, source: intent.source_identity }
    const exported = await nativeExportSnapshotShare(reg, { code: input.code,
      codeVerifier: decryptStoredSecretValue(intent.verifier_ciphertext) }, authority)
    return this.deps.pool.transaction(async ({ query: q }) => {
      const current = await lockAuthority(q, req, intent.data_source_id, intent.source_identity.part_id)
      const row = (await q('SELECT * FROM plm_snapshot_share_intents WHERE id=$1 FOR UPDATE', [intent.id])).rows[0]
      matchFrozen(row, current)
      if (row.status === 'published') return { ok: true,
        data: await this.reviews.retainedSnapshotOnQuery(q, current.actor, row.binding_id) }
      if (row.status !== 'prepared' || new Date(row.expires_at).getTime() <= Date.now()
          || Date.parse(exported.expiresAt) <= Date.now()) throw new Refusal(409, 'PLM_SNAPSHOT_SHARE_OPERATION_BOUND')
      const result = await this.reviews.publishConsentedSnapshotOnQuery(q, current.actor, row as Parameters<PlmBomReviewService['publishConsentedSnapshotOnQuery']>[2], exported.snapshot)
      if (!(await q(`SELECT $1::timestamptz>clock_timestamp() AND $2::timestamptz>clock_timestamp()
        AND expires_at>clock_timestamp() AND revoked_at IS NULL AS valid FROM plm_managed_sessions WHERE id=$3`,
        [row.expires_at,exported.expiresAt,row.session_id])).rows[0]?.valid) throw new Refusal(409, 'PLM_SNAPSHOT_SHARE_EXPIRED')
      await q("UPDATE plm_snapshot_share_intents SET status='published',binding_id=$2,native_snapshot_hash=$3,confirmed_at=$4 WHERE id=$1",
        [row.id,result.id,exported.nativeSnapshotHash,exported.confirmedAt])
      return { ok: true, data: result }
    })
  }
}

/** GET navigation performs no export and creates no collaboration records. */
export async function handoffSnapshotShare(req: Request, res: Response): Promise<void> {
  const parsed = completeSchema.parse({ operationId: '00000000-0000-0000-0000-000000000000', code: req.query.code, state: req.query.state })
  const intentId = readRequestCookie(req.headers.cookie, INTENT_COOKIE)
  const intent = (await globalQuery('SELECT * FROM plm_snapshot_share_intents WHERE id=$1', [intentId])).rows[0] as Intent
  if (!intent) throw new Refusal(403, 'PLM_SNAPSHOT_SHARE_BROWSER_REFUSED')
  cookieAuthority(req, intent)
  if (!hashesEqual(parsed.state, intent.state) || intent.status !== 'prepared' || new Date(intent.expires_at).getTime() <= Date.now()) {
    throw new Refusal(403, 'PLM_SNAPSHOT_SHARE_BROWSER_REFUSED')
  }
  res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer')
  res.redirect(303, RETURN_PATH + '?' + new URLSearchParams({ operationId: intent.operation_id, code: parsed.code, state: parsed.state }))
}

type CleanupQuery = (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>

export async function queueSnapshotShareCancellationOnQuery(q: CleanupQuery, linkId: string, generation: number): Promise<string[]> {
  // Older installations cannot contain these intents; keep their existing revoke available.
  if (!(await q("SELECT to_regclass('plm_snapshot_share_intents') AS relation")).rows[0]?.relation) return []
  return (await q(`UPDATE plm_snapshot_share_intents SET status='cancel_pending'
    WHERE link_id=$1 AND generation=$2 AND status IN ('pending','prepared','cancel_pending') RETURNING id`,
    [linkId,generation])).rows.map(row => String(row.id))
}

/** Frozen cleanup remains available with issuance disabled. No publication/read fallback. */
export async function drainSnapshotShareCancellation(intentId: string): Promise<boolean> {
  return transaction(async client => {
    const peek = (await client.query('SELECT link_id FROM plm_snapshot_share_intents WHERE id=$1', [intentId])).rows[0]
    if (!peek) return false
    await client.query('SELECT id FROM plm_managed_identity_links WHERE id=$1 FOR UPDATE', [peek.link_id])
    const row = (await client.query(`SELECT i.*,l.installation_issuer FROM plm_snapshot_share_intents i
      JOIN plm_managed_identity_links l ON l.id=i.link_id WHERE i.id=$1 FOR UPDATE OF i`, [intentId])).rows[0] as Intent
    if (row.status === 'cancelled') return true
    if (row.status !== 'cancel_pending') return false
    try {
      const reg = registration(row)
      let nativeId = row.native_intent_id as string | null
      if (!nativeId) {
        // Recover the exact immutable operation after a lost prepare acknowledgement.
        const recovered = await nativePrepareSnapshotShare(reg, { operationId: row.operation_id,
          nativeUserId: Number(row.source_identity.auth_user_id), rootPartId: row.source_identity.part_id,
          target: row.target, state: row.state, codeChallenge: pkceS256(decryptStoredSecretValue(row.verifier_ciphertext)) })
        nativeId = recovered.intentId
        await client.query('UPDATE plm_snapshot_share_intents SET native_intent_id=$2 WHERE id=$1', [row.id,nativeId])
      }
      await nativeCancelSnapshotShare(reg, { intentId: nativeId, operationId: row.operation_id })
      await client.query("UPDATE plm_snapshot_share_intents SET status='cancelled',cancelled_at=now() WHERE id=$1", [row.id])
      return true
    } catch { return false }
  })
}

export async function pendingSnapshotShareCancellations(sourceId: string): Promise<string[]> {
  if (!(await globalQuery("SELECT to_regclass('plm_snapshot_share_intents') AS relation")).rows[0]?.relation) return []
  return (await globalQuery("SELECT id FROM plm_snapshot_share_intents WHERE data_source_id=$1 AND status='cancel_pending' ORDER BY created_at,id", [sourceId]))
    .rows.map(row => String(row.id))
}
