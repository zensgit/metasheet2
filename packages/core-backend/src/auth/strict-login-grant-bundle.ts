import { createAdminGrantProofService } from './admin-grant-proof'
import type { ConsumedAdminGrantProof } from './admin-grant-proof'
import { encodeAdminGrantIntent, hashAdminGrantIntent, normalizeAdminGrantIntent } from './admin-login-grant-intent'
import type { AdminGrantIntent } from './admin-login-grant-intent'
import type { AuthenticatedSessionContext } from './security-action-proof'
import type { AuthorizationInputTx } from '../rbac/authorization-input-lock'
import {
  STRICT_LOGIN_GRANT_GRANT_TABLE,
  STRICT_LOGIN_GRANT_RECEIPT_TABLE,
} from '../db/migrations/zzzz20261118120000_strict_login_grant_scope'
import {
  commandKeyFor,
  grantIdsFor,
  strictLoginGrantOpaque as opaque,
  strictLoginGrantPgDetail as pgDetail,
  strictLoginGrantQualified as qualified,
  strictLoginGrantRows as rowsOf,
  strictLoginGrantText as textAt,
  requireStrictLoginGrantInstallation as requireInstalled,
  STRICT_LOGIN_GRANT_LIVE_SLOT_INDEX,
  StrictLoginGrantError,
} from './strict-login-grant-store'
import type { StrictLoginGrantBundle } from './strict-login-grant-store'

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function refuse(code: 'STRICT_LOGIN_GRANT_INPUT_REFUSED'): never {
  throw new StrictLoginGrantError(code)
}

function sameTarget(snapshot: ConsumedAdminGrantProof['receiving']['targets'][number], intentTarget: AdminGrantIntent['targets'][number]): boolean {
  return snapshot.userId === intentTarget.userId
    && snapshot.identityId === intentTarget.identityId
    && snapshot.evidenceId === intentTarget.evidenceId
    && snapshot.bindingRevision === intentTarget.bindingRevision
    && snapshot.accessGeneration === intentTarget.accessGeneration
    && snapshot.privilegeClass === 'standard'
    && snapshot.authorizes === false
}

function assertReceiving(consumed: ConsumedAdminGrantProof, intent: AdminGrantIntent): void {
  const receiving = consumed.receiving
  if (receiving.commandId !== intent.commandId
    || receiving.connectionId !== intent.connectionId
    || receiving.applicationRevision !== intent.applicationRevision
    || receiving.authorizes !== false
    || receiving.actor.userId !== intent.actorId
    || receiving.actor.orgId !== intent.orgId
    || receiving.actor.authorizes !== false
    || receiving.targets.length !== intent.targets.length
    || consumed.commandId !== intent.commandId
    || consumed.targetCount !== intent.targets.length
    || !UUID_TEXT.test(consumed.proofId)
    || consumed.intentDigest !== hashAdminGrantIntent(intent)) {
    refuse('STRICT_LOGIN_GRANT_INPUT_REFUSED')
  }
  const byUser = new Map(receiving.targets.map((target) => [target.userId, target]))
  if (byUser.size !== receiving.targets.length) refuse('STRICT_LOGIN_GRANT_INPUT_REFUSED')
  for (const target of intent.targets) {
    const snapshot = byUser.get(target.userId)
    if (!snapshot || !sameTarget(snapshot, target)) refuse('STRICT_LOGIN_GRANT_INPUT_REFUSED')
  }
}

async function insertReturning(
  tx: AuthorizationInputTx,
  text: string,
  params: readonly unknown[],
): Promise<readonly Record<string, unknown>[]> {
  try {
    return rowsOf(await tx.query(text, [...params]))
  } catch (error) {
    if (error instanceof StrictLoginGrantError) throw error
    const detail = pgDetail(error)
    if (detail.sqlState === '23505' && detail.constraint === STRICT_LOGIN_GRANT_LIVE_SLOT_INDEX) {
      throw new StrictLoginGrantError('STRICT_LOGIN_GRANT_GRANT_OCCUPIED', detail)
    }
    if (detail.sqlState === '23505') throw new StrictLoginGrantError('STRICT_LOGIN_GRANT_UNIQUE_CONFLICT', detail)
    throw error
  }
}

export async function insertConsumedGrantBundle(
  tx: AuthorizationInputTx,
  input: {
    readonly publicOrigin: string
    readonly context: AuthenticatedSessionContext
    readonly consumed: ConsumedAdminGrantProof
    readonly intent: AdminGrantIntent
    readonly grantedBy: string
  },
): Promise<StrictLoginGrantBundle> {
  const service = createAdminGrantProofService({ publicOrigin: input.publicOrigin })
  const intent = normalizeAdminGrantIntent(input.intent)
  service.assertConsumedOnTx(input.consumed, tx, input.context, intent)
  assertReceiving(input.consumed, intent)
  const grantedBy = opaque(input.grantedBy)
  if (grantedBy !== input.context.userId || grantedBy !== intent.actorId) refuse('STRICT_LOGIN_GRANT_INPUT_REFUSED')
  const schemaName = await requireInstalled(tx)
  const commandKey = commandKeyFor(intent.actorId, intent.orgId, intent.commandId)
  const grants = grantIdsFor(commandKey, intent.targets.map((target) => target.userId))
  const canonicalIntent = encodeAdminGrantIntent(intent)
  const result = { grants: grants.map((grant) => ({ grantId: grant.grantId, ordinal: grant.ordinal, userId: grant.userId })) }
  const receipts = qualified(schemaName, STRICT_LOGIN_GRANT_RECEIPT_TABLE)
  const receipt = await insertReturning(
    tx,
    `INSERT INTO ${receipts} (
       command_key, purpose, actor_id, org_id, command_id, intent_digest, canonical_intent, result, proof_id, target_count, outcome
     ) VALUES (
       $1, 'admin_login_grant_enable', $2, $3, $4, $5, $6, $7::jsonb, $8::uuid, $9, 'enabled'
     )
     RETURNING command_key`,
    [commandKey, intent.actorId, intent.orgId, intent.commandId, hashAdminGrantIntent(intent), canonicalIntent, JSON.stringify(result), input.consumed.proofId, intent.targets.length],
  )
  if (receipt.length !== 1) refuse('STRICT_LOGIN_GRANT_INPUT_REFUSED')
  const grantTable = qualified(schemaName, STRICT_LOGIN_GRANT_GRANT_TABLE)
  for (let index = 0; index < intent.targets.length; index += 1) {
    const target = intent.targets[index]
    const row = grants[index]
    const ordinal = index + 1
    if (!target || !row || row.userId !== target.userId || row.ordinal !== ordinal) {
      refuse('STRICT_LOGIN_GRANT_INPUT_REFUSED')
    }
    service.assertConsumedOnTx(input.consumed, tx, input.context, intent)
    assertReceiving(input.consumed, intent)
    const inserted = await insertReturning(
      tx,
      `INSERT INTO ${grantTable} (
         id, command_key, target_ordinal, command_id, evidence_id, evidence_witness, identity_id, live_identity_id,
         local_user_id, connection_id, binding_revision, binding_revision_text, application_revision,
         access_generation_text, org_id, privilege_witness, assurance, grant_method, enabled, granted_by, revocation_generation
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8::uuid,
         $9, $10::uuid, $11::bigint, $12, $13,
         $14, $15, $16, 'self_authenticated', 'admin_explicit', TRUE, $17, 0
       )
       RETURNING id`,
      [
        row.grantId,
        commandKey,
        ordinal,
        intent.commandId,
        target.evidenceId,
        target.evidenceWitness,
        target.identityId,
        target.identityId,
        target.userId,
        intent.connectionId,
        target.bindingRevision,
        target.bindingRevision,
        intent.applicationRevision,
        target.accessGeneration,
        intent.orgId,
        target.privilegeWitness,
        grantedBy,
      ],
    )
    if (inserted.length !== 1 || textAt(inserted[0], 'id') !== row.grantId) refuse('STRICT_LOGIN_GRANT_INPUT_REFUSED')
  }
  return {
    commandKey,
    proofId: input.consumed.proofId,
    commandId: intent.commandId,
    targetCount: intent.targets.length,
    grants,
  }
}
