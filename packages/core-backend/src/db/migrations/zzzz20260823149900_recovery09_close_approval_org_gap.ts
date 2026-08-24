import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkColumnExists, checkTableExists } from './_patterns'
import { resolveRecovery09LegacyOrgAnchor } from './zzzz20260823040000_recovery09_prepare_legacy_default_org'

const BACKFILL_MIGRATION_NAME = 'zzzz20260823100000_backfill_approval_instance_org_id'

/**
 * Recovery09 source-first close of the Migration-B -> writer-deploy gap. It runs immediately
 * before the older single-org gap closer. Attachment and unique-membership sources win; only the
 * residual requester-missing / active-requester-with-no-membership-row shapes may use the bounded
 * legacy `default` fallback. Cross-source or ambiguous shapes fail before any write.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await checkColumnExists(db, 'approval_instances', 'org_id'))) return
  if (!(await checkTableExists(db, 'approval_attachments'))) return
  if (!(await checkTableExists(db, 'user_orgs'))) return
  if (!(await checkTableExists(db, 'users'))) return
  if (!(await checkTableExists(db, 'kysely_migration'))) return

  const record = await sql<{ ts: string }>`
    SELECT timestamp AS ts FROM kysely_migration WHERE name = ${BACKFILL_MIGRATION_NAME}
  `.execute(db)
  const boundary = record.rows[0]?.ts
  if (!boundary) return

  const window = await sql<{ n: string }>`
    SELECT count(*)::text AS n
      FROM approval_instances i
     WHERE i.org_id IS NULL
       AND i.id NOT LIKE 'plm:%'
       AND i.id NOT LIKE 'afs:%'
       AND COALESCE(i.source_system, 'platform') = 'platform'
       AND i.created_at > ${boundary}::timestamptz
  `.execute(db)
  const windowCount = Number(window.rows[0]?.n ?? '0')
  if (windowCount === 0) return

  const conflicts = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM (
      SELECT i.id
        FROM approval_instances i
        JOIN approval_attachments a ON a.instance_id = i.id
       WHERE i.org_id IS NULL
         AND i.id NOT LIKE 'plm:%'
         AND i.id NOT LIKE 'afs:%'
         AND COALESCE(i.source_system, 'platform') = 'platform'
         AND i.created_at > ${boundary}::timestamptz
       GROUP BY i.id
      HAVING count(DISTINCT a.org_id) > 1
    ) q
  `.execute(db)
  const conflictCount = Number(conflicts.rows[0]?.n ?? '0')
  if (conflictCount > 0) {
    throw new Error(
      `Recovery09 gap repair aborted before any UPDATE: ${conflictCount} window instance(s) have ` +
      `attachments from more than one org. Instance and org ids are NOT interpolated.`,
    )
  }

  // Rows not resolvable from a singleton attachment source or singleton active membership may
  // only fall back when their requester is absent, or is active and has never had a membership.
  const unsupported = await sql<{ n: string }>`
    SELECT count(*)::text AS n
      FROM approval_instances i
     WHERE i.org_id IS NULL
       AND i.id NOT LIKE 'plm:%'
       AND i.id NOT LIKE 'afs:%'
       AND COALESCE(i.source_system, 'platform') = 'platform'
       AND i.created_at > ${boundary}::timestamptz
       AND NOT EXISTS (
         SELECT 1 FROM approval_attachments a
          WHERE a.instance_id = i.id
          GROUP BY a.instance_id HAVING count(DISTINCT a.org_id) = 1
       )
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
      `Recovery09 gap repair aborted before any UPDATE: ${unsupportedCount} window instance(s) ` +
      `have no unique approved source and are outside the bounded legacy fallback. ` +
      `Instance, user, and org ids are NOT interpolated.`,
    )
  }

  const fallback = await sql<{ n: string }>`
    SELECT count(*)::text AS n
      FROM approval_instances i
     WHERE i.org_id IS NULL
       AND i.id NOT LIKE 'plm:%'
       AND i.id NOT LIKE 'afs:%'
       AND COALESCE(i.source_system, 'platform') = 'platform'
       AND i.created_at > ${boundary}::timestamptz
       AND NOT EXISTS (
         SELECT 1 FROM approval_attachments a
          WHERE a.instance_id = i.id
          GROUP BY a.instance_id HAVING count(DISTINCT a.org_id) = 1
       )
       AND NOT EXISTS (
         SELECT 1 FROM user_orgs uo
          WHERE uo.user_id = i.requester_snapshot->>'id' AND uo.is_active = TRUE
          GROUP BY uo.user_id HAVING count(*) = 1
       )
  `.execute(db)
  const fallbackCount = Number(fallback.rows[0]?.n ?? '0')
  let legacyOrgId: string | null = null
  if (fallbackCount > 0) {
    if (!(await checkTableExists(db, 'directory_integrations'))) {
      throw new Error('Recovery09 gap repair aborted before any UPDATE: directory_integrations is unavailable.')
    }
    legacyOrgId = await resolveRecovery09LegacyOrgAnchor(db)
  }

  const class2 = await sql`
    UPDATE approval_instances i
       SET org_id = a.org_id
      FROM (
        SELECT instance_id, min(org_id) AS org_id
          FROM approval_attachments
         WHERE instance_id IS NOT NULL
         GROUP BY instance_id
        HAVING count(DISTINCT org_id) = 1
      ) a
     WHERE i.id = a.instance_id
       AND i.org_id IS NULL
       AND i.id NOT LIKE 'plm:%'
       AND i.id NOT LIKE 'afs:%'
       AND COALESCE(i.source_system, 'platform') = 'platform'
       AND i.created_at > ${boundary}::timestamptz
  `.execute(db)

  const class3 = await sql`
    UPDATE approval_instances i
       SET org_id = r.org_id
      FROM (
        SELECT user_id, min(org_id) AS org_id
          FROM user_orgs
         WHERE is_active = TRUE
         GROUP BY user_id
        HAVING count(*) = 1
      ) r
     WHERE i.requester_snapshot->>'id' = r.user_id
       AND i.org_id IS NULL
       AND i.id NOT LIKE 'plm:%'
       AND i.id NOT LIKE 'afs:%'
       AND COALESCE(i.source_system, 'platform') = 'platform'
       AND i.created_at > ${boundary}::timestamptz
  `.execute(db)

  let fallbackStamped = 0
  if (legacyOrgId) {
    const stamped = await sql`
      UPDATE approval_instances i
         SET org_id = ${legacyOrgId}
       WHERE i.org_id IS NULL
         AND i.id NOT LIKE 'plm:%'
         AND i.id NOT LIKE 'afs:%'
         AND COALESCE(i.source_system, 'platform') = 'platform'
         AND i.created_at > ${boundary}::timestamptz
    `.execute(db)
    fallbackStamped = Number(stamped.numAffectedRows ?? 0)
  }

  const remaining = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM approval_instances i
     WHERE i.org_id IS NULL
       AND i.id NOT LIKE 'plm:%'
       AND i.id NOT LIKE 'afs:%'
       AND COALESCE(i.source_system, 'platform') = 'platform'
       AND i.created_at > ${boundary}::timestamptz
  `.execute(db)
  const remainingCount = Number(remaining.rows[0]?.n ?? '0')
  if (remainingCount > 0) {
    throw new Error(
      `Recovery09 gap repair failed closed: ${remainingCount} window instance(s) remain unresolved; ` +
      `the migration transaction must roll back.`,
    )
  }

  // eslint-disable-next-line no-console
  console.log(
    `[recovery09-org-gap] attachment_stamped=${Number(class2.numAffectedRows ?? 0)} ` +
    `membership_stamped=${Number(class3.numAffectedRows ?? 0)} fallback_stamped=${fallbackStamped}`,
  )
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // Pure data repair: no safe reverse attribution exists.
}
