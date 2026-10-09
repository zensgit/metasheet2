import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * 字段类型转换（带值迁移）第 3 刀 —— 转换作业表 `meta_field_retype_conversions`。
 * 设计锁：docs/development/multitable-field-retype-first-batch-adr-20260926.md §3.9（局部关联）/ §3.10（Tier-2 拒绝）。
 *
 * 一行 = 一次已提交的转换。`convert_revision_id` 是三半的公共锚：
 *   - 配置半：`meta_config_revisions.id = convert_revision_id`；
 *   - 前镜像：`meta_field_value_tombstones.config_revision_id = convert_revision_id`（reason `'retype_convert'`）；
 *   - 记录半：`meta_record_revisions.batch_id = convert_revision_id`。
 * 撤销成功后写 `undone_at` 与 `undo_revision_id`（撤销那条配置修订的 id）。
 *
 * ── 故意没有的东西 ─────────────────────────────────────────────────────────────────────────────────────
 *   - **没有 `operation_id`**：零记录事件的转换（空表）不写 endpoint，打了标签就会在 COMMIT 违反 endpoint 的 FK；
 *     且保留期清理只删 `operation_id IS NULL` 的组，打标签 = 前镜像永不过期。
 *   - **没有任何外键**：字段 / 表 / 修订行都可能先于本行被删或被清理，作业行要活得比它们久——前镜像过期后撤销要答
 *     `PRE_IMAGE_EXPIRED` 而不是 404。
 *   - **不参与保留期清理**：没有任何 DELETE 指向这张表。
 *
 * `source_property` / `target_property` 是字段 property 的整份快照（含选项序列，即单元格文本）。它们是库内数据，
 * 与 `meta_config_revisions.before/after` 同一敏感级；任何响应、日志、审计行都不回显这两列。
 *
 * 只**新建**一张表与两个索引，不 ALTER 任何既有表、不写任何既有表的数据；全部 IF NOT EXISTS，可重复执行。
 * 先迁移、后切代码是安全的：旧代码不认识这张表。
 */

export const FIELD_RETYPE_CONVERSIONS_TABLE = 'meta_field_retype_conversions'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS meta_field_retype_conversions (
      convert_revision_id uuid PRIMARY KEY,
      sheet_id text NOT NULL,
      field_id text NOT NULL,
      source_type text NOT NULL,
      source_property jsonb NOT NULL,
      target_type text NOT NULL,
      target_property jsonb NOT NULL,
      record_count integer NOT NULL CHECK (record_count >= 0),
      actor_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      undone_at timestamptz,
      undo_revision_id uuid,
      CONSTRAINT meta_field_retype_conversions_undo_pair_check
        CHECK ((undone_at IS NULL) = (undo_revision_id IS NULL))
    )
  `.execute(db)

  // 撤销的第 0 步按 (convert_revision_id, field_id, sheet_id) 定位——主键已覆盖。这个索引给「这一列有过哪些转换」。
  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_field_retype_conversions_sheet_field
    ON meta_field_retype_conversions(sheet_id, field_id, created_at DESC)
  `.execute(db)

  // Tier-2 拒绝按 `convert_revision_id = $1 OR undo_revision_id = $1` 查：前一半走主键，后一半走这个索引。
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_field_retype_conversions_undo_revision
    ON meta_field_retype_conversions(undo_revision_id)
    WHERE undo_revision_id IS NOT NULL
  `.execute(db)
}

/**
 * 回滚 = 删这张表。**fail-closed**：表里只要有行就抛错、什么都不删——作业行是「这一列被转换过、前镜像在哪」的唯一
 * 记录，删了之后整列撤销不可达，而 Tier-2 配置回滚会重新放行转换修订（把字段翻回文本、单元格却仍是选项形）。
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    BEGIN
      IF to_regclass('meta_field_retype_conversions') IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM meta_field_retype_conversions) THEN
          RAISE EXCEPTION 'meta_field_retype_conversions is not empty; refusing to drop the conversion job table';
        END IF;
      END IF;
    END $$
  `.execute(db)
  await sql`DROP INDEX IF EXISTS idx_meta_field_retype_conversions_undo_revision`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_meta_field_retype_conversions_sheet_field`.execute(db)
  await sql`DROP TABLE IF EXISTS meta_field_retype_conversions`.execute(db)
}
