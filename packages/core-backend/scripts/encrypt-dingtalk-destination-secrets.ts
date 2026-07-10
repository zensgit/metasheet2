/**
 * DT-HARDEN-03 — backfill: encrypt any plaintext DingTalk group-destination
 * credentials left in `dingtalk_group_destinations`.
 *
 * Encrypt-on-write + decrypt-on-read means new and updated rows are already
 * encrypted and legacy plaintext rows keep working. This script closes the gap for
 * rows that are never edited again.
 *
 * MUST run with the same ENCRYPTION_KEY / ENCRYPTION_SALT as the application, or
 * the values it writes cannot be decrypted at runtime. The derived key is
 * `pbkdf2(ENCRYPTION_KEY, ENCRYPTION_SALT)` — presence of ENCRYPTION_KEY alone does
 * NOT prove the pair matches the application: a correct key with the wrong (or
 * default) salt derives a *different* key and still "succeeds" at encrypting, just
 * with ciphertext the application can never decrypt again. Before touching any row
 * this script therefore runs a pre-flight: it decrypts an already-`enc:`-prefixed
 * value that some previous run of the application wrote, using the KEY/SALT this
 * invocation holds. A round-trip failure means the pair is wrong and the script
 * aborts with zero writes. (A fresh encrypt+decrypt "sentinel" cannot catch this —
 * it always round-trips against whatever key happens to be derived, right or
 * wrong; the check has to reuse ciphertext the *application* actually produced.)
 * If every row is still plaintext (first run ever), there is no such value to
 * check against — pass --confirm-first-run once you have independently confirmed
 * ENCRYPTION_KEY/ENCRYPTION_SALT match the application's env.
 *
 * Idempotent: values already carrying the `enc:` prefix are left untouched
 * (normalizeStoredSecretValue is a no-op on them), so a re-run is safe.
 *
 * Usage:
 *   DATABASE_URL=… ENCRYPTION_KEY=… ENCRYPTION_SALT=… pnpm dlx tsx \
 *     packages/core-backend/scripts/encrypt-dingtalk-destination-secrets.ts [--dry-run] [--confirm-first-run]
 */
import pg from 'pg'
import { decryptStoredSecretValue, isEncryptedSecretValue, normalizeStoredSecretValue } from '../src/security/encrypted-secrets'

export type DestinationSecretRow = { id: string; webhook_url: string; secret: string | null }

export interface QueryablePool {
  query: <T = unknown>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>
}

export interface BackfillOptions {
  dryRun: boolean
  allowFirstRun: boolean
}

export interface BackfillResult {
  encrypted: number
  alreadyEncrypted: number
  /** Rows whose value changed between this script's SELECT and its UPDATE — left untouched. */
  skippedConcurrent: number
  total: number
}

/** Both halves of the KDF input must be explicit — presence of ENCRYPTION_KEY alone is not the invariant that matters. */
export function assertEncryptionConfigPresent(env: NodeJS.ProcessEnv = process.env): void {
  if (!env.ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY is required — running with the default dev key would write values production cannot decrypt')
  }
  if (!env.ENCRYPTION_SALT) {
    throw new Error(
      'ENCRYPTION_SALT is required — the derived key is pbkdf2(ENCRYPTION_KEY, ENCRYPTION_SALT); running with ' +
      'the default salt while the application uses a different one would write values production cannot decrypt',
    )
  }
}

/** Finds an already-`enc:`-prefixed value in the current row set to verify the running KEY/SALT against. */
export function findCanary(rows: DestinationSecretRow[]): string | undefined {
  for (const row of rows) {
    if (isEncryptedSecretValue(row.webhook_url)) return row.webhook_url
    if (isEncryptedSecretValue(row.secret)) return row.secret as string
  }
  return undefined
}

/**
 * Pre-flight, BEFORE any UPDATE: prove this invocation's ENCRYPTION_KEY/ENCRYPTION_SALT
 * are the same pair that encrypted rows already at rest, by decrypting one of them.
 * Throws (writes nothing) on mismatch or on an unacknowledged first run.
 */
export function verifyEncryptionConfig(rows: DestinationSecretRow[], allowFirstRun: boolean): void {
  const canary = findCanary(rows)
  if (!canary) {
    if (allowFirstRun) return
    throw new Error(
      'No already-encrypted row found to verify ENCRYPTION_KEY/ENCRYPTION_SALT against, so this run cannot prove ' +
      'they match the application. If every row really is still plaintext (first run ever), re-run with ' +
      '--confirm-first-run after independently confirming ENCRYPTION_KEY/ENCRYPTION_SALT match the application env.',
    )
  }
  try {
    decryptStoredSecretValue(canary)
  } catch (error) {
    throw new Error(
      'ENCRYPTION_KEY/ENCRYPTION_SALT do not match the pair that encrypted the existing rows ' +
      `(decrypting a known-good row failed: ${error instanceof Error ? error.message : String(error)}). ` +
      'Refusing to write — this would overwrite recoverable ciphertext with ciphertext nobody can decrypt.',
    )
  }
}

export async function runBackfill(pool: QueryablePool, options: BackfillOptions): Promise<BackfillResult> {
  const { rows } = await pool.query<DestinationSecretRow>(
    `SELECT id, webhook_url, secret FROM dingtalk_group_destinations`,
  )

  verifyEncryptionConfig(rows, options.allowFirstRun)

  let encrypted = 0
  let alreadyEncrypted = 0
  let skippedConcurrent = 0

  for (const row of rows) {
    const webhookNeedsEncrypting = !isEncryptedSecretValue(row.webhook_url)
    const secretNeedsEncrypting = typeof row.secret === 'string'
      && row.secret.length > 0
      && !isEncryptedSecretValue(row.secret)

    if (!webhookNeedsEncrypting && !secretNeedsEncrypting) {
      alreadyEncrypted += 1
      continue
    }

    if (options.dryRun) {
      encrypted += 1
      console.log(`[dry-run] would encrypt destination ${row.id} (webhook=${webhookNeedsEncrypting}, secret=${secretNeedsEncrypting})`)
      continue
    }

    // Compare-and-swap on the exact values this run read: a credential rotated by an
    // admin between the SELECT and this UPDATE must NOT be overwritten with the
    // re-encryption of the stale value we are holding. (Encrypt-on-write means the
    // concurrent writer already stored ciphertext — the row no longer needs us.)
    const updated = await pool.query<{ id: string }>(
      `UPDATE dingtalk_group_destinations
          SET webhook_url = $2,
              secret = $3
        WHERE id = $1
          AND webhook_url = $4
          AND secret IS NOT DISTINCT FROM $5
        RETURNING id`,
      [
        row.id,
        normalizeStoredSecretValue(row.webhook_url),
        row.secret ? normalizeStoredSecretValue(row.secret) : null,
        row.webhook_url,
        row.secret,
      ],
    )
    if (updated.rows.length === 0) {
      skippedConcurrent += 1
      console.log(`skipped destination ${row.id}: concurrently modified since this run read it`)
      continue
    }
    encrypted += 1
    console.log(`encrypted destination ${row.id}`)
  }

  return { encrypted, alreadyEncrypted, skippedConcurrent, total: rows.length }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const allowFirstRun = process.argv.includes('--confirm-first-run')

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  assertEncryptionConfigPresent()

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 })
  try {
    const result = await runBackfill(pool, { dryRun, allowFirstRun })
    console.log(
      `${dryRun ? '[dry-run] ' : ''}done: ${result.encrypted} row(s) ${dryRun ? 'would be' : ''} encrypted, ` +
      `${result.alreadyEncrypted} already encrypted, ${result.skippedConcurrent} skipped (concurrently modified — re-run to re-check), ` +
      `${result.total} total`,
    )
  } finally {
    await pool.end()
  }
}

// Run only when invoked directly (tsx scripts/encrypt-dingtalk-destination-secrets.ts) — NOT
// when imported by the test, so importing the pure helpers never opens a DB connection.
if (process.argv[1]?.includes('encrypt-dingtalk-destination-secrets')) {
  main().catch((err) => {
    console.error('backfill failed:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
