/**
 * Runs before permission-ux-scope-witness.db.test.ts imports the privilege reader.
 * tests/setup.integration.ts sets RBAC_TOKEN_TRUST=true. This lane does not use it.
 * This file does not load a developer .env and does not open a database.
 */
process.env.RBAC_BYPASS = 'false'
process.env.RBAC_TOKEN_TRUST = 'false'
process.env.PRODUCT_MODE = 'plm-workbench'
process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error'
delete process.env.RBAC_OPTIONAL

if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'permission-ux-scope-witness-jwt-secret-32'
}

if (process.env.RBAC_BYPASS !== 'false' || process.env.RBAC_TOKEN_TRUST !== 'false') {
  throw new Error('permission-ux scope witness setup must force token trust off before imports')
}

if (!process.env.DATABASE_URL) {
  throw new Error(
    'permission-ux scope witness requires DATABASE_URL; EXPECT_DB refuses a skip-shaped green',
  )
}
