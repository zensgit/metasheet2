import {
  AccessGraphUserUnavailableError,
  supersedeDeprovisionEvidenceForAccessGraphWrite,
  type AccessGraphTransactionClient,
  type LockedAccessGraphUser,
} from '../directory/access-graph-mutex'
import { assertPlatformActorAuthority } from './platform-actor-authority'
import { revokeLockedLegacyUserPermission } from './legacy-permission-revoke'

export type AuthorizationExceptionAction =
  | { kind: 'direct.grant' | 'direct.revoke' | 'legacy.revoke'; code: string }
  | { kind: 'template.grant'; codes: string[] }

export type AuthorizationExceptionInput = {
  actorId: string
  userId: string
  actor: LockedAccessGraphUser | undefined
  target: LockedAccessGraphUser | undefined
  action: AuthorizationExceptionAction
  /** The entire direct-grant before-image, as read under the command fence. */
  expectedDirectCodes?: string[]
  /** Wrapper distinguishes a missing witness from a JSON null. */
  expectedLegacy?: { value: unknown }
}

export class AuthorizationExceptionWriteError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'STALE' | 'UNKNOWN_PERMISSION' | 'WRITE_NOT_ACKNOWLEDGED') {
    super(`Authorization exception: ${code}`)
  }
}

/** Caller holds the shared access-subject locks for both users through commit. */
export async function writeAuthorizationException(
  client: AccessGraphTransactionClient,
  input: AuthorizationExceptionInput,
): Promise<{ changedCodes: string[] }> {
  const { actorId, userId, actor, target, action } = input
  if (!actorId || !userId || actorId !== actorId.trim() || userId !== userId.trim()) throw new AuthorizationExceptionWriteError('INVALID_INPUT')
  if (!actor || actor.id !== actorId) await assertPlatformActorAuthority(client, undefined, { requireLiveRbacAdmin: true })
  await assertPlatformActorAuthority(client, actor, { requireLiveRbacAdmin: true })
  if (!target || target.id !== userId) throw new AccessGraphUserUnavailableError('NOT_FOUND')
  if (target.deletedAt || target.purgedAt) throw new AccessGraphUserUnavailableError('USER_IN_RECYCLE_BIN')

  const requested = action.kind === 'template.grant' ? action.codes : [action.code]
  if (!Array.isArray(requested) || requested.length > 1000 || requested.some(code => typeof code !== 'string' || !code || code !== code.trim()) || new Set(requested).size !== requested.length) {
    throw new AuthorizationExceptionWriteError('INVALID_INPUT')
  }
  if (action.kind === 'legacy.revoke') {
    if (!input.expectedLegacy) throw new AuthorizationExceptionWriteError('INVALID_INPUT')
    const result = await revokeLockedLegacyUserPermission(client, { actorId, userId, permission: action.code, expected: input.expectedLegacy })
    return { changedCodes: result.changed ? [action.code] : [] }
  }
  const expected = input.expectedDirectCodes
  if (!Array.isArray(expected) || expected.length > 1000 || expected.some(code => typeof code !== 'string') || new Set(expected).size !== expected.length) throw new AuthorizationExceptionWriteError('INVALID_INPUT')
  const current = await client.query('SELECT permission_code FROM user_permissions WHERE user_id = $1 ORDER BY permission_code LIMIT 1001', [userId])
  const currentCodes = current.rows.map(row => row.permission_code)
  if (currentCodes.length > 1000 || currentCodes.some(code => typeof code !== 'string') || JSON.stringify([...currentCodes].sort()) !== JSON.stringify([...expected].sort())) throw new AuthorizationExceptionWriteError('STALE')
  if (action.kind !== 'direct.revoke' && requested.length) {
    const catalog = await client.query('SELECT code FROM permissions WHERE code = ANY($1::text[]) ORDER BY code', [requested])
    const found = catalog.rows.map(row => row.code)
    if (JSON.stringify([...found].sort()) !== JSON.stringify([...requested].sort())) throw new AuthorizationExceptionWriteError('UNKNOWN_PERMISSION')
  }
  const changedCodes: string[] = []
  for (const code of requested) {
    const present = currentCodes.includes(code)
    const shouldChange = action.kind === 'direct.revoke' ? present : !present
    if (!shouldChange) continue
    const result = action.kind === 'direct.revoke'
      ? await client.query('DELETE FROM user_permissions WHERE user_id = $1 AND permission_code = $2 RETURNING user_id, permission_code', [userId, code])
      : await client.query('INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, $2) ON CONFLICT (user_id, permission_code) DO NOTHING RETURNING user_id, permission_code', [userId, code])
    const rowCount = (result as { rowCount?: number | null }).rowCount
    if (rowCount !== 1 || result.rows.length !== 1 || result.rows[0]?.user_id !== userId || result.rows[0]?.permission_code !== code) throw new AuthorizationExceptionWriteError('WRITE_NOT_ACKNOWLEDGED')
    changedCodes.push(code)
  }
  if (changedCodes.length) await supersedeDeprovisionEvidenceForAccessGraphWrite(client, {
    userIds: [userId], actorId, reason: 'superseded by administrator permission exception write',
  })
  return { changedCodes }
}
