if (!process.env.DATABASE_URL) {
  throw new Error('tasks enablement walk requires DATABASE_URL; refusing skip-shaped green')
}

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  process.env.JWT_SECRET = 'tasks-enablement-walk-jwt-secret-min-32b!'
}

process.env.NODE_ENV = 'test'
process.env.LOG_LEVEL = 'error'
process.env.RBAC_BYPASS = 'false'
process.env.RBAC_TOKEN_TRUST = 'false'
process.env.TASKS_ENABLED = 'true'
process.env.TASKS_ENABLEMENT_SETUP = '1'

if (process.env.RBAC_TOKEN_TRUST !== 'false') {
  throw new Error('tasks enablement setup must set RBAC_TOKEN_TRUST=false before auth/RBAC import')
}
if (process.env.RBAC_OPTIONAL === '1') {
  throw new Error('tasks enablement setup must not set RBAC_OPTIONAL=1')
}
if (process.env.TASKS_ENABLED !== 'true') {
  throw new Error('tasks enablement setup must set TASKS_ENABLED=true')
}
