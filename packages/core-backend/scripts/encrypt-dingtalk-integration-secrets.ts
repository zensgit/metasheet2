#!/usr/bin/env tsx
/**
 * DT-HARDEN-03 — backfill: encrypt plaintext `config.appSecret` values on
 * `directory_integrations` and `attendance_integrations`.
 *
 * Shares the destination-backfill's safety posture (see
 * encrypt-dingtalk-destination-secrets.ts for the full rationale):
 *
 * - PRE-FLIGHT before any write: both halves of the KDF input must be present
 *   (pbkdf2(ENCRYPTION_KEY, ENCRYPTION_SALT)), and the pair is proven against a
 *   canary — an already-`enc:`-prefixed appSecret the application itself wrote.
 *   A wrong-salt run otherwise "succeeds" while writing ciphertext nobody can
 *   ever decrypt, and this script overwrites the WHOLE config JSON. If no
 *   encrypted row exists yet (first run ever), pass --confirm-first-run after
 *   independently confirming the env pair matches the application's.
 * - CAS on the config: the UPDATE applies only if `config` is still exactly what
 *   this run read (jsonb equality), so a concurrent admin save is never clobbered
 *   with a stale re-encrypted copy. Skipped rows are reported; re-run to re-check.
 * - Idempotent: `enc:`-prefixed values are left untouched.
 *
 * Usage:
 *   DATABASE_URL=… ENCRYPTION_KEY=… ENCRYPTION_SALT=… pnpm dlx tsx \
 *     packages/core-backend/scripts/encrypt-dingtalk-integration-secrets.ts [--dry-run] [--confirm-first-run]
 */
import pg from 'pg'
import { decryptStoredSecretValue, isEncryptedSecretValue, normalizeStoredSecretValue } from '../src/security/encrypted-secrets'
import { assertEncryptionConfigPresent, type QueryablePool } from './encrypt-dingtalk-destination-secrets'

export type IntegrationConfigRow = {
  id: string
  config: Record<string, unknown> | null
}

export interface IntegrationBackfillOptions {
  dryRun: boolean
  allowFirstRun: boolean
}

export interface TableBackfillResult {
  encrypted: number
  alreadyEncrypted: number
  skippedConcurrent: number
  total: number
}

export function normalizeConfig(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {}
}

function readSecret(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

const SECRET_KEYS = ['appSecret', 'appsecret', 'app_secret'] as const

function readAnySecret(config: Record<string, unknown>): string {
  for (const key of SECRET_KEYS) {
    const value = readSecret(config[key])
    if (value) return value
  }
  return ''
}

/** An already-`enc:` appSecret from either table proves the running KEY/SALT pair. */
export function findIntegrationCanary(rowSets: IntegrationConfigRow[][]): string | undefined {
  for (const rows of rowSets) {
    for (const row of rows) {
      const secret = readAnySecret(normalizeConfig(row.config))
      if (isEncryptedSecretValue(secret)) return secret
    }
  }
  return undefined
}

/**
 * Pre-flight, BEFORE any UPDATE on either table — same contract as the destination
 * backfill's verifyEncryptionConfig: throw (write nothing) on a KEY/SALT mismatch or an
 * unacknowledged first run.
 */
export function verifyIntegrationEncryptionConfig(rowSets: IntegrationConfigRow[][], allowFirstRun: boolean): void {
  const canary = findIntegrationCanary(rowSets)
  if (!canary) {
    if (allowFirstRun) return
    throw new Error(
      'No already-encrypted appSecret found to verify ENCRYPTION_KEY/ENCRYPTION_SALT against, so this run cannot ' +
      'prove they match the application. If every appSecret really is still plaintext (first run ever), re-run with ' +
      '--confirm-first-run after independently confirming ENCRYPTION_KEY/ENCRYPTION_SALT match the application env.',
    )
  }
  try {
    decryptStoredSecretValue(canary)
  } catch (error) {
    throw new Error(
      'ENCRYPTION_KEY/ENCRYPTION_SALT do not match the pair that encrypted the existing rows ' +
      `(decrypting a known-good appSecret failed: ${error instanceof Error ? error.message : String(error)}). ` +
      'Refusing to write — this would overwrite recoverable ciphertext with ciphertext nobody can decrypt.',
    )
  }
}

export async function rewriteIntegrationTable(
  pool: QueryablePool,
  table: 'directory_integrations' | 'attendance_integrations',
  rows: IntegrationConfigRow[],
  options: IntegrationBackfillOptions,
): Promise<TableBackfillResult> {
  let encrypted = 0
  let alreadyEncrypted = 0
  let skippedConcurrent = 0

  for (const row of rows) {
    const config = normalizeConfig(row.config)
    const appSecret = readAnySecret(config)
    if (!appSecret) continue

    if (isEncryptedSecretValue(appSecret)) {
      alreadyEncrypted += 1
      continue
    }

    if (options.dryRun) {
      encrypted += 1
      console.log(`[dry-run] would encrypt ${table} ${row.id}`)
      continue
    }

    const nextConfig = { ...config, appSecret: normalizeStoredSecretValue(appSecret) }
    delete (nextConfig as Record<string, unknown>).appsecret
    delete (nextConfig as Record<string, unknown>).app_secret

    // CAS on the whole config (jsonb equality is semantic): a concurrent admin save —
    // which under encrypt-on-write already stored ciphertext — must never be replaced
    // by this run's stale re-encrypted copy of the ENTIRE config object.
    const updated = await pool.query<{ id: string }>(
      `UPDATE ${table}
          SET config = $2::jsonb,
              updated_at = NOW()
        WHERE id = $1
          AND config = $3::jsonb
        RETURNING id`,
      [row.id, JSON.stringify(nextConfig), JSON.stringify(row.config ?? {})],
    )
    if (updated.rows.length === 0) {
      skippedConcurrent += 1
      console.log(`skipped ${table} ${row.id}: concurrently modified since this run read it`)
      continue
    }
    encrypted += 1
    console.log(`encrypted ${table} ${row.id}`)
  }

  return { encrypted, alreadyEncrypted, skippedConcurrent, total: rows.length }
}

export async function runIntegrationBackfill(
  pool: QueryablePool,
  options: IntegrationBackfillOptions,
): Promise<{ directory: TableBackfillResult; attendance: TableBackfillResult }> {
  const [directoryRows, attendanceRows] = await Promise.all([
    pool.query<IntegrationConfigRow>('SELECT id, config FROM directory_integrations').then((r) => r.rows),
    pool.query<IntegrationConfigRow>('SELECT id, config FROM attendance_integrations').then((r) => r.rows),
  ])

  verifyIntegrationEncryptionConfig([directoryRows, attendanceRows], options.allowFirstRun)

  const directory = await rewriteIntegrationTable(pool, 'directory_integrations', directoryRows, options)
  const attendance = await rewriteIntegrationTable(pool, 'attendance_integrations', attendanceRows, options)
  return { directory, attendance }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const allowFirstRun = process.argv.includes('--confirm-first-run')

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  assertEncryptionConfigPresent()

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 })
  try {
    const { directory, attendance } = await runIntegrationBackfill(pool, { dryRun, allowFirstRun })
    console.log(JSON.stringify({ ok: true, dryRun, directory, attendance }))
  } finally {
    await pool.end()
  }
}

// Run only when invoked directly — NOT when imported by the test, so importing the pure
// helpers never opens a DB connection.
if (process.argv[1]?.includes('encrypt-dingtalk-integration-secrets')) {
  main().catch((err) => {
    console.error('backfill failed:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
