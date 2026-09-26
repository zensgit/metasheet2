if (!process.env.DATABASE_URL) {
  throw new Error('tasks auth gate requires DATABASE_URL; refusing skip-shaped green')
}

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  process.env.JWT_SECRET = 'tasks-auth-gate-jwt-secret-min-32b!'
}

process.env.RBAC_BYPASS = 'false'
process.env.RBAC_TOKEN_TRUST = 'false'
process.env.PRODUCT_MODE = 'plm-workbench'
process.env.TASKS_ENABLED = 'true'
process.env.TASKS_AUTH_GATE_SETUP = '1'

if (process.env.RBAC_BYPASS !== 'false') {
  throw new Error('tasks auth gate setup must set RBAC_BYPASS=false before auth/RBAC import')
}
if (process.env.RBAC_TOKEN_TRUST !== 'false') {
  throw new Error('tasks auth gate setup must set RBAC_TOKEN_TRUST=false before auth/RBAC import')
}
if (process.env.PRODUCT_MODE !== 'plm-workbench') {
  throw new Error('tasks auth gate setup must pin PRODUCT_MODE=plm-workbench')
}
if (process.env.RBAC_OPTIONAL === '1') {
  throw new Error('tasks auth gate setup must not set RBAC_OPTIONAL=1')
}
if (process.env.TASKS_ENABLED !== 'true') {
  throw new Error('tasks auth gate setup must set TASKS_ENABLED=true')
}
