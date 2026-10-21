/**
 * Dedicated setup for the e-learning V0.1 auth/tenant/RBAC gate.
 *
 * Must run before any import of auth / rbac / elearning-pilot-runtime.
 * rbac.ts caches RBAC_TOKEN_TRUST at module load; the global integration
 * setup must stay untouched (it sets both flags true).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.RBAC_BYPASS = 'false'
process.env.RBAC_TOKEN_TRUST = 'false'
process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error'
// Not 'platform'/'attendance': AuthService otherwise backfills attendance
// self-service roles during verifyToken. Attendance code is out of scope.
process.env.PRODUCT_MODE = 'plm-workbench'

function applyDotEnv(filePath: string): void {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch {
    return
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (key === '' || process.env[key] !== undefined) continue
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}

applyDotEnv(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env'))

if (!process.env.DATABASE_URL) {
  throw new Error(
    'elearning V0.1 auth/tenant/RBAC gate requires DATABASE_URL; refusing skip-shaped green',
  )
}

if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'elearning-pilot-auth-gate-jwt-secret-min-32b'
}

process.env.ELEARNING_ENABLED = 'true'
process.env.ELEARNING_CONTENT_ENABLED = 'true'
process.env.ELEARNING_ASSIGNMENT_ENABLED = 'true'
process.env.ELEARNING_ASSESSMENT_ENABLED = 'true'
process.env.ELEARNING_MEDIA_ENABLED = 'true'
process.env.ELEARNING_MEDIA_PLAYBACK_SIGNING_SECRET =
  process.env.ELEARNING_MEDIA_PLAYBACK_SIGNING_SECRET
  || 'elearning-playback-signing-secret-min-32b!'

process.env.ELEARNING_PILOT_AUTH_GATE_SETUP = '1'

if (process.env.RBAC_BYPASS !== 'false') {
  throw new Error('elearning auth gate setup must set RBAC_BYPASS=false before auth/RBAC import')
}
if (process.env.RBAC_TOKEN_TRUST !== 'false') {
  throw new Error('elearning auth gate setup must set RBAC_TOKEN_TRUST=false before auth/RBAC import')
}
if (process.env.PRODUCT_MODE !== 'plm-workbench') {
  throw new Error('elearning auth gate setup must pin PRODUCT_MODE=plm-workbench to keep attendance self-service backfill off')
}
