/**
 * E —— 通知中心保留期清理,真库。形状照 `tests/integration/multitable-tombstone-retention-realdb.test.ts`
 * 的 keep-days sweep 那条(describeIfDatabase + sentinel + 建行/扫/查存活)。
 *
 * 这里证的是**单测证不到的那一半**:`created_at < now() - make_interval(days => $1)` 在真
 * Postgres 上确实只命中老行,`id IN (SELECT ... ORDER BY created_at LIMIT $2)` 确实是有界的。
 * 单测(tests/unit/multitable-notification-retention.test.ts)证分支与 SQL 形状。
 *
 * 注意两点,别把它当成比实际更强的保证:
 *  1. sweep 是**表级**的(和既有 tombstone retention 同形,没有 sheet 作用域)—— 所以断言写成
 *     "我这张 sheet 的两条老行没了、那条新行还在" + "整表至少删了 2 行",而不是"整表恰好删 2 行";
 *     共享测试库里别的用例留下的老通知也会被这一轮扫掉,那正是这把刀的本意。
 *  2. **两点接线只落了一点**(fix r1-B2)。第一点已补:本文件被 packages/core-backend/vitest.config.ts
 *     的 exclude 列入,所以它不会再在无 DB 的必需 lane 里被收集然后 skip-green(那种"5 skipped、
 *     退出码 0"的假绿,仓库在 vitest.config.ts:1206-1207 自己定性为缺陷类)。第二点**仍然缺**:
 *     .github/workflows/plugin-tests.yml 的真库 lane 是显式文件清单,本文件还没被列进去,而这把刀
 *     不允许改 .github/workflows —— 必须由有权改 workflow 的一方补那一行。
 *     在那一行落地之前:**本文件跑在任何地方都没有,这 5 条用例不构成任何证据**,DELETE 语句也
 *     从未被真 PostgreSQL 解析过;CI 证据全在单测那条(它现在对整条 SQL 做等值断言)。
 */
import { describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import {
  resolveNotificationRetentionDays,
  sweepNotificationRetention,
} from '../../src/multitable/notification-retention'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const SHEET = `sheet_notifret_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const rowIds = async (): Promise<string[]> => {
  const result = await q(
    `SELECT record_id FROM meta_record_subscription_notifications WHERE sheet_id = $1 ORDER BY record_id`,
    [SHEET],
  )
  return (result.rows as Array<{ record_id: string }>).map((row) => row.record_id)
}

async function insertNotification(recordId: string, ageDays: number): Promise<void> {
  await q(
    `INSERT INTO meta_record_subscription_notifications
       (id, sheet_id, record_id, user_id, event_type, actor_id, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'record.updated', $4, now() - ($5::int * interval '1 day'))`,
    [SHEET, recordId, `u_notifret_${TS}`, `a_notifret_${TS}`, ageDays],
  )
}

async function cleanup(): Promise<void> {
  await q('DELETE FROM meta_record_subscription_notifications WHERE sheet_id = $1', [SHEET])
}

describeIfDatabase('E 通知保留期清理 (real DB)', () => {
  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('keep-days:2 条老行被删、1 条新行留下(窗口口径在真库上成立)', async () => {
    await cleanup()
    await insertNotification('old1', 400)
    await insertNotification('old2', 45)
    await insertNotification('fresh1', 5)

    const result = await sweepNotificationRetention(q, { retentionDays: 30 })

    expect(result.deleted).toBeGreaterThanOrEqual(2)
    expect(result.drained).toBe(true)
    expect(await rowIds()).toEqual(['fresh1'])
    await cleanup()
  })

  test('未读也删:read_at IS NULL 的老行照样被回收(owner 默认口径)', async () => {
    await cleanup()
    await insertNotification('unread_old', 400)
    await q(
      `UPDATE meta_record_subscription_notifications SET read_at = NULL WHERE sheet_id = $1`,
      [SHEET],
    )

    await sweepNotificationRetention(q, { retentionDays: 30 })

    expect(await rowIds()).toEqual([])
    await cleanup()
  })

  test('默认关:没配天数 ⇒ resolve 出 null,调用方根本不会进 sweep,行一条不少', async () => {
    await cleanup()
    await insertNotification('kept_because_disabled', 400)

    expect(resolveNotificationRetentionDays(undefined)).toBeNull()
    expect(resolveNotificationRetentionDays('0')).toBeNull()

    expect(await rowIds()).toEqual(['kept_because_disabled'])
    await cleanup()
  })

  test('有界批量:5 条积压 + batchSize=2/单轮 1 批 ⇒ 一轮只删 2,剩下的留给下一轮', async () => {
    await cleanup()
    for (let i = 0; i < 5; i++) await insertNotification(`backlog${i}`, 400)

    const first = await sweepNotificationRetention(q, { retentionDays: 30, batchSize: 2, maxBatchesPerRun: 1 })
    expect(first.deleted).toBe(2)
    expect(first.batches).toBe(1)
    expect(first.drained).toBe(false)
    expect(await rowIds()).toHaveLength(3)

    const second = await sweepNotificationRetention(q, { retentionDays: 30, batchSize: 2, maxBatchesPerRun: 10 })
    expect(second.deleted).toBe(3)
    expect(await rowIds()).toHaveLength(0)
    await cleanup()
  })
})
