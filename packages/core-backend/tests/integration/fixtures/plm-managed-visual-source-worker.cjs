// Independent stale source-manager process; no provider network calls.
const { EventEmitter } = require('node:events')
const { Pool } = require('pg')
const { Kysely, PostgresDialect } = require('kysely')
const { DataSourceManager } = require('../../../src/data-adapters/DataSourceManager.ts')
const { poolManager } = require('../../../src/integration/db/connection-pool.ts')
class NoDial extends EventEmitter {
  constructor(config) { super(); this.config = config }
  getConfig() { return this.config }
  isConnected() { return false }
  async disconnect() {}
}
async function main() {
  const pool = new Pool({ connectionString: process.env.PLM_VISUAL_SOURCE_TEST_DATABASE_URL,
    options: '-c search_path=' + process.env.PLM_VISUAL_OWNED_SCHEMA })
  const db = new Kysely({ dialect: new PostgresDialect({ pool }) })
  const manager = new DataSourceManager(); manager.registerAdapterType('plm', NoDial)
  await manager.initialize(db)
  process.on('message', async message => {
    if (message?.operation === 'stop') {
      await db.destroy(); await poolManager.close(); process.disconnect(); return
    }
    try {
      const config = manager.getDataSource(message.id).getConfig()
      await manager.updateDataSource(message.id, { ...config, name: 'stale worker rename' }, { actor: { userId: 'owner' } })
      process.send({ operation: 'result', admitted: true })
    } catch (error) { process.send({ operation: 'result', status: error.status, code: error.code }) }
  })
  process.send({ operation: 'ready', pid: process.pid })
}
main().catch(() => { process.exitCode = 1; process.disconnect() })
