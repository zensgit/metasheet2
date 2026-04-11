#!/usr/bin/env tsx
import pg from 'pg'
import { normalizeStoredSecretValue } from '../src/security/encrypted-secrets'

const { Pool } = pg as any

type IntegrationRow = {
  id: string
  config: Record<string, unknown> | null
}

function normalizeConfig(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {}
}

function readSecret(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

async function rewriteDirectoryIntegrations(pool: any): Promise<number> {
  const { rows } = await pool.query<IntegrationRow>('SELECT id, config FROM directory_integrations')
  let updated = 0

  for (const row of rows) {
    const config = normalizeConfig(row.config)
    const appSecret = readSecret(config.appSecret)
    if (!appSecret) continue

    const nextSecret = normalizeStoredSecretValue(appSecret)
    if (nextSecret === appSecret) continue

    config.appSecret = nextSecret
    await pool.query(
      'UPDATE directory_integrations SET config = $2::jsonb, updated_at = NOW() WHERE id = $1',
      [row.id, JSON.stringify(config)],
    )
    updated += 1
  }

  return updated
}

async function rewriteAttendanceIntegrations(pool: any): Promise<number> {
  const { rows } = await pool.query<IntegrationRow>('SELECT id, config FROM attendance_integrations')
  let updated = 0

  for (const row of rows) {
    const config = normalizeConfig(row.config)
    const appSecret = readSecret(config.appSecret ?? config.appsecret ?? config.app_secret)
    if (!appSecret) continue

    const nextSecret = normalizeStoredSecretValue(appSecret)
    if (nextSecret === appSecret) continue

    config.appSecret = nextSecret
    delete config.appsecret
    delete config.app_secret

    await pool.query(
      'UPDATE attendance_integrations SET config = $2::jsonb, updated_at = NOW() WHERE id = $1',
      [row.id, JSON.stringify(config)],
    )
    updated += 1
  }

  return updated
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required')
  }

  const pool = new Pool({ connectionString: databaseUrl })
  try {
    const [directoryUpdated, attendanceUpdated] = await Promise.all([
      rewriteDirectoryIntegrations(pool),
      rewriteAttendanceIntegrations(pool),
    ])
    console.log(JSON.stringify({
      ok: true,
      directoryUpdated,
      attendanceUpdated,
    }))
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
