import { metrics } from '../metrics/metrics'
import type { Db } from '../notifications/recipient-resolver'

export type TopicTakeover = { state: 'none' | 'paused' | 'unreadable' }
  | { state: 'active'; revision: number; defaultConnectionId: string | null }
export type TakeoverOutcome = TopicTakeover['state'] | 'probe_absent'

/** One cache per database runner; absence expires sooner so newly migrated tables become visible. */
export function createTopicTakeoverReader(options: {
  now?: () => number
  count?: (outcome: TakeoverOutcome) => void
} = {}) {
  const probes = new WeakMap<Db, { present: boolean; expires: number }>()
  const now = options.now ?? Date.now
  const count = options.count ?? (outcome => metrics.notificationTakeoverReadTotal.inc({ outcome }))
  return async (db: Db, orgId: string, topic = 'task_reminder'): Promise<TopicTakeover> => {
    const finish = (result: TopicTakeover, outcome: TakeoverOutcome = result.state) => { count(outcome); return result }
    try {
      let probe = probes.get(db)
      if (!probe || probe.expires <= now()) {
        const result = await db.query("SELECT to_regclass('org_notification_topic_policies') IS NOT NULL AS present")
        if (typeof result.rows[0]?.present !== 'boolean') return finish({ state: 'unreadable' })
        probe = { present: result.rows[0].present, expires: now() + (result.rows[0].present ? 300_000 : 15_000) }
        probes.set(db, probe)
      }
      if (!probe.present) return finish({ state: 'none' }, 'probe_absent')
      const result = await db.query(`SELECT state, revision, default_connection_id::text AS default_connection_id
        FROM org_notification_topic_policies WHERE org_id = $1 AND topic = $2`, [orgId, topic])
      const row = result.rows[0]
      if (!row) return finish({ state: 'none' })
      if (row.state === 'paused') return finish({ state: 'paused' })
      if (row.state !== 'active' || !Number.isSafeInteger(Number(row.revision)) || Number(row.revision) < 1) return finish({ state: 'unreadable' })
      return finish({ state: 'active', revision: Number(row.revision), defaultConnectionId: row.default_connection_id === null ? null : String(row.default_connection_id) })
    } catch (error) {
      if ((error as { code?: string }).code === '42P01') {
        probes.delete(db)
        return finish({ state: 'none' })
      }
      return finish({ state: 'unreadable' })
    }
  }
}
export const readTopicTakeover = createTopicTakeoverReader()
