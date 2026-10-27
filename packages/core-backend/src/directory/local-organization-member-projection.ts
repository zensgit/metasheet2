import { transaction } from '../db/pg'
import { lockUsersForAccessGraphWrite, supersedeDeprovisionEvidenceForAccessGraphWrite } from './access-graph-mutex'
import { readOrgMembershipHistory } from './org-membership-history'

export class LocalMemberProjectionError extends Error {
  constructor(public readonly status: 404 | 409, public readonly code: string, message: string) {
    super(message)
    this.name = 'LocalMemberProjectionError'
  }
}

const conflict = () => new LocalMemberProjectionError(
  409, 'DIRECTORY_LOCAL_CONFLICT', 'Local member projection requires review or retry',
)

export async function projectLocalOrganizationMember(
  orgId: string,
  input: { integrationId: string; localUserId: string; actorId: string },
): Promise<{ accountId: string; created: boolean }> {
  try {
    return await transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      const users = await lockUsersForAccessGraphWrite(client, [input.localUserId])
      if (!users.has(input.localUserId)) {
        throw new LocalMemberProjectionError(404, 'DIRECTORY_LOCAL_NOT_FOUND', 'Local member was not found')
      }

      // Separate post-mutex statements see a membership/evidence change committed while waiting.
      const active = await (client.query(
        `SELECT u.id, u.name, u.username
           FROM users u JOIN user_orgs uo ON uo.user_id = u.id
          WHERE u.id = $1::text AND u.is_active = true
            AND uo.org_id = $2::text AND uo.is_active = true`,
        [input.localUserId, orgId],
      ) as Promise<{ rows: { id: string; name: string | null; username: string | null }[] }>)
      if (active.rows.length !== 1) throw conflict()
      const history = await readOrgMembershipHistory(client, { userId: input.localUserId, orgId })
      if (history.deprovisionApplied) throw conflict()

      // User-first writers must not wait for a source lock held by an anchor-first writer.
      const anchors = await (client.query(
        `SELECT i.id::text AS id, i.corp_id
           FROM directory_integrations i
          WHERE i.org_id = $1::text AND i.provider = 'local' AND i.status = 'active'
          FOR SHARE OF i NOWAIT`,
        [orgId],
      ) as Promise<{ rows: { id: string; corp_id: string | null }[] }>)
      const anchor = anchors.rows[0]
      if (!anchor) {
        throw new LocalMemberProjectionError(404, 'DIRECTORY_LOCAL_NOT_FOUND', 'Active local organization was not found')
      }
      if (anchor.id !== input.integrationId) {
        throw new LocalMemberProjectionError(409, 'LOCAL_ORG_CONTEXT_CHANGED', 'Local organization context changed; refresh before continuing')
      }
      if (anchors.rows.length !== 1 || anchor.corp_id !== `local:${orgId}`) throw conflict()

      const externalKey = `${orgId}:${input.localUserId}`
      const existing = await (client.query(
        `SELECT a.id::text AS id, a.integration_id::text AS integration_id,
                a.provider, a.corp_id, a.external_user_id, a.external_key, a.is_active
           FROM directory_accounts a
          WHERE (a.integration_id = $1::uuid AND
                (a.external_user_id = $2::text OR a.external_key = $3::text OR EXISTS (
                  SELECT 1 FROM directory_account_links l
                   WHERE l.directory_account_id = a.id AND l.local_user_id = $2::text)))
             OR (a.provider = 'local' AND a.external_key = $3::text)
          ORDER BY a.id FOR UPDATE OF a NOWAIT`,
        [anchor.id, input.localUserId, externalKey],
      ) as Promise<{ rows: {
        id: string; integration_id: string; provider: string; corp_id: string | null
        external_user_id: string; external_key: string; is_active: boolean
      }[] }>)
      if (existing.rows.length > 0) {
        if (existing.rows.length !== 1) throw conflict()
        const account = existing.rows[0]!
        if (account.integration_id !== anchor.id || account.provider !== 'local' || account.corp_id !== null ||
            account.external_user_id !== input.localUserId || account.external_key !== externalKey ||
            account.is_active !== true) throw conflict()
        const links = await (client.query(
          `SELECT local_user_id, link_status FROM directory_account_links
            WHERE directory_account_id = $1::uuid FOR UPDATE NOWAIT`,
          [account.id],
        ) as Promise<{ rows: { local_user_id: string | null; link_status: string }[] }>)
        if (links.rows.length !== 1 || links.rows[0]?.local_user_id !== input.localUserId ||
            links.rows[0]?.link_status !== 'linked') throw conflict()
        return { accountId: account.id, created: false }
      }

      const profile = active.rows[0]!
      const name = profile.name?.trim() || profile.username?.trim() || ''
      if (!name || name.length > 200) throw conflict()
      const inserted = await (client.query(
        `INSERT INTO directory_accounts (
           integration_id, provider, corp_id, external_user_id, external_key, name,
           title, is_active, raw, last_seen_at, created_at, updated_at
         ) VALUES ($1::uuid, 'local', NULL, $2::text, $3::text, $4::text,
                   NULL, true, $5::jsonb, NOW(), NOW(), NOW())
         RETURNING id::text AS id`,
        [anchor.id, input.localUserId, externalKey, name, JSON.stringify({ source: 'local', localUserId: input.localUserId })],
      ) as Promise<{ rows: { id: string }[] }>)
      const accountId = inserted.rows[0]?.id
      if (!accountId) throw new Error('Local member projection insert returned no row')
      await client.query(
        `INSERT INTO directory_account_links (
           directory_account_id, local_user_id, link_status, match_strategy, created_at, updated_at
         ) VALUES ($1::uuid, $2::text, 'linked', 'local_explicit', NOW(), NOW())`,
        [accountId, input.localUserId],
      )
      // Both canonical evidence UPDATE legs have empty targets under the fresh no-applied guard.
      await supersedeDeprovisionEvidenceForAccessGraphWrite(client, {
        userIds: [input.localUserId],
        actorId: input.actorId,
        reason: 'local directory member projection created',
      })
      return { accountId, created: true }
    })
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === '55P03' || code === '23505') throw conflict()
    throw error
  }
}
