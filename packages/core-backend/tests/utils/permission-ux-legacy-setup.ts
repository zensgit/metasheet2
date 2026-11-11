/**
 * Runs before the permission-ux legacy test imports auth or RBAC.
 * Does not load a developer .env. An unset DATABASE_URL fails closed.
 * rbac.ts caches RBAC_TOKEN_TRUST at module load, so the flags are set here.
 */
const priorEnv = {
  RBAC_BYPASS: process.env.RBAC_BYPASS,
  RBAC_TOKEN_TRUST: process.env.RBAC_TOKEN_TRUST,
  PRODUCT_MODE: process.env.PRODUCT_MODE,
  NODE_ENV: process.env.NODE_ENV,
  LOG_LEVEL: process.env.LOG_LEVEL,
  JWT_SECRET: process.env.JWT_SECRET,
  RBAC_OPTIONAL: process.env.RBAC_OPTIONAL,
}

function restoreEnvKey(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}

export function restorePermissionUxLegacyEnv(): void {
  restoreEnvKey('RBAC_BYPASS', priorEnv.RBAC_BYPASS)
  restoreEnvKey('RBAC_TOKEN_TRUST', priorEnv.RBAC_TOKEN_TRUST)
  restoreEnvKey('PRODUCT_MODE', priorEnv.PRODUCT_MODE)
  restoreEnvKey('NODE_ENV', priorEnv.NODE_ENV)
  restoreEnvKey('LOG_LEVEL', priorEnv.LOG_LEVEL)
  restoreEnvKey('JWT_SECRET', priorEnv.JWT_SECRET)
  restoreEnvKey('RBAC_OPTIONAL', priorEnv.RBAC_OPTIONAL)
}

process.env.RBAC_BYPASS = 'false'
process.env.RBAC_TOKEN_TRUST = 'false'
process.env.PRODUCT_MODE = 'plm-workbench'
process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error'
delete process.env.RBAC_OPTIONAL

if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'permission-ux-legacy-realdb-jwt-secret-32b'
}

if (process.env.RBAC_BYPASS !== 'false' || process.env.RBAC_TOKEN_TRUST !== 'false') {
  throw new Error('permission ux legacy setup must force RBAC_BYPASS and RBAC_TOKEN_TRUST false before auth import')
}

if (process.env.PRODUCT_MODE !== 'plm-workbench') {
  throw new Error('permission ux legacy setup must pin PRODUCT_MODE=plm-workbench')
}

if (!process.env.DATABASE_URL) {
  throw new Error('permission ux legacy real-DB suite requires DATABASE_URL; EXPECT_DB refuses a skip-shaped green')
}

const databaseUrl = new URL(process.env.DATABASE_URL)
const databaseHost = databaseUrl.hostname
const databaseName = decodeURIComponent(databaseUrl.pathname.replace(/^\//, ''))
const allowed = databaseName === 'metasheet_test'
  || databaseName === 'permission_boundaries_synthetic'
  || databaseName.startsWith('admin_review_synthetic')
if (databaseHost !== 'localhost' && databaseHost !== '127.0.0.1') {
  throw new Error('permission ux legacy suite refuses a non-loopback DATABASE_URL')
}
if (!allowed) {
  throw new Error('permission ux legacy suite refuses a database outside the synthetic allowlist')
}
