// Owned integration process: the actual authentication middleware and managed router.
const express = require('express')
const { jwtAuthMiddleware, isWhitelisted } = require('../../../src/auth/jwt-middleware')
const { closeRedisClient } = require('../../../src/db/redis')
const { poolManager } = require('../../../src/integration/db/connection-pool')
const router = require('../../../src/routes/plm-managed-companion').default
const url = process.env.PLM_MANAGED_DISCUSSION_TEST_PG_URL
if (!process.send || !url || url !== process.env.DATABASE_URL ||
    !new URL(url).searchParams.get('host')?.startsWith('/tmp/plm-mdpg-s-')) {
  throw new Error('Owned managed Discussion worker only')
}
const app = express()
app.use(express.json())
app.use((req, res, next) => isWhitelisted(req.path) ? next() : jwtAuthMiddleware(req, res, next))
app.use('/api/plm/managed-login', router)
const server = app.listen(0, '127.0.0.1', () => {
  process.send({ type: 'ready', pid: process.pid, port: server.address().port })
})
process.once('SIGTERM', async () => {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await closeRedisClient()
  await poolManager.close()
  process.send({ type: 'stopped', pid: process.pid }, () => process.exit(0))
})
