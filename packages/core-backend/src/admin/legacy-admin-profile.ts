type LegacyProfileQuery = (sql: string, params?: unknown[]) => Promise<unknown>

export async function syncLegacyAdminProfile(
  userId: string,
  enabled: boolean,
  runQuery: LegacyProfileQuery,
): Promise<void> {
  await runQuery(
    `UPDATE users
     SET role = CASE
       WHEN $2::boolean THEN 'admin'
       WHEN role = 'admin' THEN 'user'
       ELSE role
     END,
     is_admin = $2,
     updated_at = NOW()
     WHERE id = $1`,
    [userId, enabled],
  )
}
