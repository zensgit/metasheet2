/**
 * DT-HARDEN-03 — backfill: encrypt any plaintext DingTalk group-destination
 * credentials left in `dingtalk_group_destinations`.
 *
 * Encrypt-on-write + decrypt-on-read means new and updated rows are already
 * encrypted and legacy plaintext rows keep working. This script closes the gap for
 * rows that are never edited again.
 *
 * MUST run with the same ENCRYPTION_KEY / ENCRYPTION_SALT as the application, or
 * the values it writes cannot be decrypted at runtime. Idempotent: values already
 * carrying the `enc:` prefix are left untouched (normalizeStoredSecretValue is a
 * no-op on them), so a re-run is safe.
 *
 * Usage:
 *   DATABASE_URL=… ENCRYPTION_KEY=… ENCRYPTION_SALT=… pnpm dlx tsx \
 *     packages/core-backend/scripts/encrypt-dingtalk-destination-secrets.ts [--dry-run]
 */
import pg from 'pg'
import { isEncryptedSecretValue, normalizeStoredSecretValue } from '../src/security/encrypted-secrets'

const dryRun = process.argv.includes('--dry-run')

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  if (!process.env.ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY is required — running with the default dev key would write values production cannot decrypt')
  }

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 })
  try {
    const { rows } = await pool.query<{ id: string; webhook_url: string; secret: string | null }>(
      `SELECT id, webhook_url, secret FROM dingtalk_group_destinations`,
    )

    let encrypted = 0
    let alreadyEncrypted = 0

    for (const row of rows) {
      const webhookNeedsEncrypting = !isEncryptedSecretValue(row.webhook_url)
      const secretNeedsEncrypting = typeof row.secret === 'string'
        && row.secret.length > 0
        && !isEncryptedSecretValue(row.secret)

      if (!webhookNeedsEncrypting && !secretNeedsEncrypting) {
        alreadyEncrypted += 1
        continue
      }

      encrypted += 1
      if (dryRun) {
        console.log(`[dry-run] would encrypt destination ${row.id} (webhook=${webhookNeedsEncrypting}, secret=${secretNeedsEncrypting})`)
        continue
      }

      await pool.query(
        `UPDATE dingtalk_group_destinations
            SET webhook_url = $2,
                secret = $3
          WHERE id = $1`,
        [
          row.id,
          normalizeStoredSecretValue(row.webhook_url),
          row.secret ? normalizeStoredSecretValue(row.secret) : null,
        ],
      )
      console.log(`encrypted destination ${row.id}`)
    }

    console.log(
      `${dryRun ? '[dry-run] ' : ''}done: ${encrypted} row(s) ${dryRun ? 'would be' : ''} encrypted, ${alreadyEncrypted} already encrypted, ${rows.length} total`,
    )
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error('backfill failed:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
