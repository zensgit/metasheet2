import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkColumnExists, checkTableExists } from './_patterns'

const LEGACY_ORG_ID = 'default'

/**
 * Recovery09 pre-alignment for deployments that contain isolated/synthetic org memberships in
 * addition to the legacy org. It does not delete, rename, deactivate, or otherwise rewrite an
 * existing organization or membership. The only membership write is an INSERT for an active user
 * that has never had any user_orgs row. A user with a deactivated row is deliberately untouched.
 *
 * The fallback is intentionally narrower than "pick an org": directory_integrations must expose
 * exactly one distinct nonblank org and it must be the repo-owned legacy literal `default`; that
 * same org must already have an active membership witness. Any other shape fails values-free.
 */
export async function resolveRecovery09LegacyOrgAnchor(db: Kysely<unknown>): Promise<string> {
  const anchors = await sql<{ org_id: string }>`
    SELECT DISTINCT org_id
      FROM directory_integrations
     WHERE org_id IS NOT NULL AND btrim(org_id) <> ''
  `.execute(db)
  if (anchors.rows.length !== 1 || anchors.rows[0]?.org_id !== LEGACY_ORG_ID) {
    throw new Error(
      `Recovery09 legacy-org resolution aborted before any write: directory_integrations exposed ` +
      `${anchors.rows.length} distinct nonblank org(s), but exactly the repo-owned legacy anchor is required. ` +
      `Org ids are NOT interpolated (values-free discipline).`,
    )
  }

  const witness = await sql<{ n: string }>`
    SELECT count(*)::text AS n
      FROM user_orgs
     WHERE org_id = ${LEGACY_ORG_ID} AND is_active = TRUE
  `.execute(db)
  if (Number(witness.rows[0]?.n ?? '0') === 0) {
    throw new Error(
      `Recovery09 legacy-org resolution aborted before any write: the repo-owned legacy anchor ` +
      `has no active membership witness. Org and user ids are NOT interpolated (values-free discipline).`,
    )
  }
  return LEGACY_ORG_ID
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await checkTableExists(db, 'users'))) return
  if (!(await checkTableExists(db, 'user_orgs'))) return
  if (!(await checkTableExists(db, 'directory_integrations'))) return

  const hasApprovalOrgId = await checkColumnExists(db, 'approval_instances', 'org_id')
  const hasAttachments = await checkTableExists(db, 'approval_attachments')

  const usersWithNoMembershipRow = await sql<{ n: string }>`
    SELECT count(*)::text AS n
      FROM users u
     WHERE u.is_active = TRUE
       AND NOT EXISTS (SELECT 1 FROM user_orgs uo WHERE uo.user_id = u.id)
  `.execute(db)
  const userCount = Number(usersWithNoMembershipRow.rows[0]?.n ?? '0')

  let missingRequesterTerminalCount = 0
  if (hasApprovalOrgId && hasAttachments) {
    const unsupported = await sql<{ n: string }>`
      SELECT count(*)::text AS n
        FROM approval_instances i
       WHERE i.org_id IS NULL
         AND i.id NOT LIKE 'plm:%'
         AND i.id NOT LIKE 'afs:%'
         AND COALESCE(i.source_system, 'platform') = 'platform'
         AND i.template_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM approval_attachments a WHERE a.instance_id = i.id)
         AND NOT EXISTS (
           SELECT 1 FROM user_orgs uo
            WHERE uo.user_id = i.requester_snapshot->>'id' AND uo.is_active = TRUE
            GROUP BY uo.user_id HAVING count(*) = 1
         )
         AND NOT (
           NOT EXISTS (SELECT 1 FROM users u WHERE u.id = i.requester_snapshot->>'id')
           OR EXISTS (
             SELECT 1 FROM users u
              WHERE u.id = i.requester_snapshot->>'id' AND u.is_active = TRUE
                AND NOT EXISTS (SELECT 1 FROM user_orgs uo WHERE uo.user_id = u.id)
           )
         )
    `.execute(db)
    const unsupportedCount = Number(unsupported.rows[0]?.n ?? '0')
    if (unsupportedCount > 0) {
      throw new Error(
        `Recovery09 pre-alignment aborted before any write: ${unsupportedCount} terminal approval ` +
        `instance(s) are neither requester-missing nor active-requester-with-no-membership-row. ` +
        `Instance, user, and org ids are NOT interpolated (values-free discipline).`,
      )
    }

    const missing = await sql<{ n: string }>`
      SELECT count(*)::text AS n
        FROM approval_instances i
       WHERE i.org_id IS NULL
         AND i.id NOT LIKE 'plm:%'
         AND i.id NOT LIKE 'afs:%'
         AND COALESCE(i.source_system, 'platform') = 'platform'
         AND i.template_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM approval_attachments a WHERE a.instance_id = i.id)
         AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = i.requester_snapshot->>'id')
    `.execute(db)
    missingRequesterTerminalCount = Number(missing.rows[0]?.n ?? '0')
  }

  if (userCount === 0 && missingRequesterTerminalCount === 0) return
  const legacyOrgId = await resolveRecovery09LegacyOrgAnchor(db)

  const memberships = await sql`
    INSERT INTO user_orgs (user_id, org_id, is_active)
    SELECT u.id, ${legacyOrgId}, TRUE
      FROM users u
     WHERE u.is_active = TRUE
       AND NOT EXISTS (SELECT 1 FROM user_orgs uo WHERE uo.user_id = u.id)
    ON CONFLICT (user_id, org_id) DO NOTHING
  `.execute(db)

  let terminalStamped = 0
  if (hasApprovalOrgId && hasAttachments) {
    const stamped = await sql`
      UPDATE approval_instances i
         SET org_id = ${legacyOrgId}
       WHERE i.org_id IS NULL
         AND i.id NOT LIKE 'plm:%'
         AND i.id NOT LIKE 'afs:%'
         AND COALESCE(i.source_system, 'platform') = 'platform'
         AND i.template_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM approval_attachments a WHERE a.instance_id = i.id)
         AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = i.requester_snapshot->>'id')
    `.execute(db)
    terminalStamped = Number(stamped.numAffectedRows ?? 0)

    const remaining = await sql<{ n: string }>`
      SELECT count(*)::text AS n
        FROM approval_instances i
       WHERE i.org_id IS NULL
         AND i.id NOT LIKE 'plm:%'
         AND i.id NOT LIKE 'afs:%'
         AND COALESCE(i.source_system, 'platform') = 'platform'
         AND i.template_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM approval_attachments a WHERE a.instance_id = i.id)
         AND NOT EXISTS (
           SELECT 1 FROM user_orgs uo
            WHERE uo.user_id = i.requester_snapshot->>'id' AND uo.is_active = TRUE
            GROUP BY uo.user_id HAVING count(*) = 1
         )
    `.execute(db)
    const remainingCount = Number(remaining.rows[0]?.n ?? '0')
    if (remainingCount > 0) {
      throw new Error(
        `Recovery09 pre-alignment failed closed: ${remainingCount} terminal approval instance(s) ` +
        `remain unresolved after the bounded repair. The migration transaction must roll back. ` +
        `Instance, user, and org ids are NOT interpolated (values-free discipline).`,
      )
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[recovery09-org-prealignment] memberships_inserted=${Number(memberships.numAffectedRows ?? 0)} ` +
    `missing_requester_terminal_stamped=${terminalStamped}`,
  )
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // Pure data repair: rows cannot be distinguished safely from later legitimate writes.
}
