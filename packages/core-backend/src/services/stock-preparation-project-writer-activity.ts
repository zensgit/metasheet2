import type { Pool } from 'pg'
import type { PluginServices } from '../types/plugin'

/** Checked-out sessions here never come from the pool used by business queries. */
export function createStockPreparationProjectWriterActivity(
  getPool: () => Pool,
): NonNullable<PluginServices['stockPreparationProjectWriterActivity']> {
  return {
    async withConnection(operation) {
      const client = await getPool().connect()
      let discard = true
      try {
        const result = await operation({
          query: async (sql, params) => (await client.query(sql, params)).rows,
        })
        discard = false
        return result
      } finally {
        // A rejected operation or a failed unlock must not return a session holding a lock.
        client.release(discard)
      }
    },
  }
}
