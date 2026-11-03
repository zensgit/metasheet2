import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * 审批投影表 `system_kind` 的**窄回填**（证据绑定）。
 * 设计锁：docs/development/multitable-field-retype-first-batch-adr-20260926.md §3.11 表行 19 / §8 r5 S5。
 *
 * ── 要补的洞 ───────────────────────────────────────────────────────────────────────────────────────────
 * 审批投影服务在 `meta_sheets.system_kind` 列还不存在的部署窗口里，退回不带 kind 的 INSERT 建表
 * （approval-record-projection-service.ts `ensureFamilySheet` 的 catch 分支）；两条 INSERT 都是
 * `ON CONFLICT (id) DO NOTHING`，所以之后每一次重投影都**不会**把 kind 补上。那个窗口里建出来的投影表
 * `system_kind` 永远是 NULL，`isSystemManagedSheet` 认不出它。字段类型转换已经用并集 (e)
 * `approval_projection_sheet`（按 `approval_record_projection` 有行判定、不依赖 kind）兜住；这条回填把 kind 本身补齐。
 *
 * ── 为什么这不是「哨兵回填」 ───────────────────────────────────────────────────────────────────────────
 * L5 迁移故意**不**回填（owner P1：按用户可写的 description / base_id 回填，会让迁移前伪造的表洗出可信身份）。
 * 这里的判据是三条同时成立，其中没有一条来自客户端请求可写的内容：
 *   1. `system_kind IS NULL` —— 只补空，从不改写已有的 kind；
 *   2. `base_id` 等于审批系统 base 的**常量**（approval-projection-constants.ts `APPROVAL_PROJECTION_BASE_ID`）——
 *      读的是 `meta_sheets` 行自己的 base_id，不是投影行里记的那一份；
 *   3. `approval_record_projection` 里有行指向这张表 —— 这张表只有投影服务在自己的事务里写
 *      （`reconcile` 里与 `meta_records` 的 upsert 同事务），没有任何路由接受它的内容。
 * 名字、描述哨兵都**不**参与判定。
 *
 * ── 改写范围 ───────────────────────────────────────────────────────────────────────────────────────────
 * 只写 `meta_sheets.system_kind` 这一列，只写满足上面三条的行；不碰 `updated_at`、不碰任何别的列或别的表。
 * 没有这种残留的库（绝大多数）更新 0 行。可重复执行：第二次跑时条件 1 已不成立。
 *
 * ── 先迁移、后切代码，是安全的 ─────────────────────────────────────────────────────────────────────────
 * 被补上 kind 的表本来就是投影服务的系统表；旧代码对 `system_kind = 'approval_projection'` 的处理（拒绝删表、
 * 不进用户历史连续性模型）正是这些表从一开始就该有的待遇。
 *
 * 两张表任一不存在（极早期的库）⇒ 什么都不做：没有投影表，就没有可回填的残留。
 */

export const APPROVAL_PROJECTION_BACKFILL_BASE_ID = 'base_apr_projection'
export const APPROVAL_PROJECTION_BACKFILL_KIND = 'approval_projection'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    BEGIN
      IF to_regclass('approval_record_projection') IS NULL THEN
        RETURN;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'meta_sheets' AND column_name = 'system_kind'
           AND table_schema = ANY (current_schemas(false))
      ) THEN
        RETURN;
      END IF;
      UPDATE meta_sheets AS s
         SET system_kind = 'approval_projection'
       WHERE s.system_kind IS NULL
         AND s.base_id = 'base_apr_projection'
         AND EXISTS (SELECT 1 FROM approval_record_projection p WHERE p.sheet_id = s.id);
    END $$
  `.execute(db)
}

/**
 * 回滚 = 空操作，是故意的。被回填的行在回填之后与「一开始就带 kind 建出来的投影表」无法区分，按条件把它们改回 NULL
 * 会连带清掉后者的 kind——那是放宽，不是回滚。确需还原个别表时按 runbook 逐表处理。
 */
export async function down(_db: Kysely<unknown>): Promise<void> {
  // intentionally empty — see the doc comment above.
}
