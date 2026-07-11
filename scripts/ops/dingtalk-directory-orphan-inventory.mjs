#!/usr/bin/env node
/**
 * DT-HARDEN-02 — DingTalk directory auto-admission orphan inventory (READ-ONLY).
 *
 * Before DT-HARDEN-02, sync auto-admission hardcoded `enableDingTalkGrant: true`.
 * A corp-scoped directory account without an openId makes the downstream grant
 * assertion throw AFTER the `users` row was inserted; the sync loop's catch
 * swallowed the error and the transaction committed, leaving an ACTIVE local user
 * with no DingTalk identity and no linked directory account — an orphan that does
 * not surface in the admin review queue.
 *
 * This script finds those likely orphans. It DELETES NOTHING — remediation
 * (deactivate / delete / rebind) is an owner decision. Heuristic, so it favours
 * precision: a user is reported only when it looks auto-admission-shaped
 * (must_change_password, plain 'user' role, active) AND clearly originated from
 * directory data (email/mobile matches a directory account, or a generated
 * `dt_…` username) AND has neither a DingTalk external identity nor a linked
 * directory account.
 *
 * Usage: DATABASE_URL=postgres://… node scripts/ops/dingtalk-directory-orphan-inventory.mjs [--limit N] [--json]
 */
import pg from 'pg'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const limitFlagIdx = args.indexOf('--limit')
const limit = limitFlagIdx >= 0 ? Math.max(1, Number(args[limitFlagIdx + 1]) || 100) : 100

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('DATABASE_URL is required')
  process.exit(2)
}

const ORPHAN_SQL = `
  SELECT u.id, u.email, u.username, u.mobile, u.name, u.created_at
  FROM users u
  WHERE u.must_change_password = TRUE
    AND COALESCE(u.is_active, TRUE) = TRUE
    AND COALESCE(u.role, 'user') = 'user'
    AND NOT EXISTS (
      SELECT 1 FROM user_external_identities i
      WHERE i.provider = 'dingtalk' AND i.local_user_id = u.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM directory_account_links l
      WHERE l.local_user_id = u.id AND l.link_status = 'linked'
    )
    AND (
      (u.email IS NOT NULL AND EXISTS (
        SELECT 1 FROM directory_accounts a WHERE lower(a.email) = lower(u.email)
      ))
      OR (u.mobile IS NOT NULL AND EXISTS (
        SELECT 1 FROM directory_accounts a
        WHERE regexp_replace(COALESCE(a.mobile, ''), '\\s+', '', 'g')
            = regexp_replace(u.mobile, '\\s+', '', 'g')
          AND regexp_replace(u.mobile, '\\s+', '', 'g') <> ''
      ))
      OR u.username LIKE 'dt\\_%'
    )
  ORDER BY u.created_at DESC
  LIMIT $1
`

async function main() {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 })
  try {
    const { rows } = await pool.query(ORPHAN_SQL, [limit])
    if (asJson) {
      process.stdout.write(JSON.stringify({ count: rows.length, orphans: rows }, null, 2) + '\n')
      return
    }
    if (rows.length === 0) {
      console.log('No likely DingTalk auto-admission orphans found.')
      return
    }
    console.log(`Found ${rows.length} likely DingTalk auto-admission orphan(s) (showing up to ${limit}):`)
    console.log('This script does not modify data. Review each before deactivating/deleting/rebinding.\n')
    for (const r of rows) {
      console.log(
        `  ${r.id}  email=${r.email ?? '-'}  username=${r.username ?? '-'}  mobile=${r.mobile ?? '-'}  created=${new Date(r.created_at).toISOString()}`,
      )
    }
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error('orphan inventory failed:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
