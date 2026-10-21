import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * 「复制数据表（含数据）」provenance 三列（设计锁 ADR
 * docs/development/multitable-copy-sheet-with-data-adr-20260926.md CS-14 / §6）。
 *
 * 复制物是**非托管快照**：它不登记 `plugin_multitable_object_registry`、不随 PLM 刷新、可删可改。
 * 但读侧需要知道「这张表是从哪里、以什么身份复制来的」：
 *   - UI 徽标「快照副本」/「不随 PLM 刷新」只依赖这三列（不猜名字、不看 registry）；
 *   - 插件作用域 hook 对 `copied_from_kind = 'plugin-managed'` 的表在**任何模式**下拒绝
 *     （§6「S8 修正」：registry 无行的表在默认 observe 模式下任何插件都可达，这三列是唯一能把
 *     「托管表的快照」从「普通表」里区分出来的服务端信号）。
 *
 * 全部可空、惰性：既有行保持 NULL（= 不是复制物）。`copied_from_sheet_id` 不加外键——源表可被软删/
 * 硬清除，快照仍然成立；读侧对能读源表者才透出该 id。
 *
 * 只 ALTER 一张表、全部 IF NOT EXISTS，可重复执行；`down` 只删自己加的三列。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE meta_sheets
      ADD COLUMN IF NOT EXISTS copied_from_sheet_id text
  `.execute(db)
  await sql`
    ALTER TABLE meta_sheets
      ADD COLUMN IF NOT EXISTS copied_from_kind text
  `.execute(db)
  await sql`
    ALTER TABLE meta_sheets
      ADD COLUMN IF NOT EXISTS copied_at timestamptz
  `.execute(db)
  // 词表由 CHECK 钉住：'user'（普通表的快照）| 'plugin-managed'（托管表的快照）。NULL = 不是复制物。
  // 用 DO $$ 包一层是为了 IF NOT EXISTS 语义（PG 的 ADD CONSTRAINT 没有 IF NOT EXISTS）。
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'meta_sheets_copied_from_kind_check'
      ) THEN
        ALTER TABLE meta_sheets
          ADD CONSTRAINT meta_sheets_copied_from_kind_check
          CHECK (copied_from_kind IS NULL OR copied_from_kind IN ('user', 'plugin-managed'));
      END IF;
    END $$
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE meta_sheets DROP CONSTRAINT IF EXISTS meta_sheets_copied_from_kind_check`.execute(db)
  await sql`ALTER TABLE meta_sheets DROP COLUMN IF EXISTS copied_at`.execute(db)
  await sql`ALTER TABLE meta_sheets DROP COLUMN IF EXISTS copied_from_kind`.execute(db)
  await sql`ALTER TABLE meta_sheets DROP COLUMN IF EXISTS copied_from_sheet_id`.execute(db)
}
