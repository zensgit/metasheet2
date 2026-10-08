import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * 字段类型转换（带值迁移）第 3 刀 —— 放宽 `meta_field_value_tombstones.reason` 的 CHECK，多收一个值 `'retype_convert'`。
 * 设计锁：docs/development/multitable-field-retype-first-batch-adr-20260926.md §3.6。
 *
 * 为什么要改：转换执行在改写单元格之前，把**每一条** live 行的原值写成前镜像（整列撤销靠它），`reason = 'retype_convert'`。
 * 建表时的 CHECK（zzzz20260708090000）只收 `'field_delete'` / `'lossy_retype'`，不放宽则第一条前镜像就违反约束、
 * 整个转换事务回滚。
 *
 * ── 先迁移、后切代码，是安全的 ─────────────────────────────────────────────────────────────────────────
 * 新 CHECK 是旧 CHECK 的**超集**：旧代码只写旧的两个值，仍然全部合法；新值只有第 3 刀的执行路径会写，而那条路径还要
 * `MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT === 'true'`（默认关）。迁移跑完、代码未切的窗口里，行为与今天逐字节相同。
 *
 * ── 不改写任何既有行 ───────────────────────────────────────────────────────────────────────────────────
 * 只动约束，不 UPDATE / DELETE / INSERT 任何一行。新约束先以 `NOT VALID` 加上（不扫表、只需极短的表锁），再
 * `VALIDATE CONSTRAINT`（扫表但只持 SHARE UPDATE EXCLUSIVE，不挡读写）。既有行的 reason 都在旧集合里，校验必过。
 *
 * ── 约束按定义找，不按名字猜 ───────────────────────────────────────────────────────────────────────────
 * 建表时 CHECK 是列内联写法，名字由 PG 自动生成（通常是 `meta_field_value_tombstones_reason_check`）。这里在
 * `pg_constraint` 里找这张表上**定义里引用 reason 列**的 CHECK 逐个删掉，再加回一条名字固定的。`conkey` 按列号判定，
 * 不解析约束文本、不依赖服务端语言环境。
 *
 * 可重复执行：第二次跑时删掉的就是上次加的那条，再原样加回。
 */

export const FIELD_VALUE_TOMBSTONE_REASON_CHECK = 'meta_field_value_tombstones_reason_check'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    DECLARE
      c record;
    BEGIN
      FOR c IN
        SELECT con.conname
          FROM pg_constraint con
          JOIN pg_attribute att
            ON att.attrelid = con.conrelid
           AND att.attname = 'reason'
           AND att.attnum = ANY (con.conkey)
         WHERE con.conrelid = 'meta_field_value_tombstones'::regclass
           AND con.contype = 'c'
      LOOP
        EXECUTE format('ALTER TABLE meta_field_value_tombstones DROP CONSTRAINT %I', c.conname);
      END LOOP;

      ALTER TABLE meta_field_value_tombstones
        ADD CONSTRAINT meta_field_value_tombstones_reason_check
        CHECK (reason IN ('field_delete', 'lossy_retype', 'retype_convert')) NOT VALID;
      ALTER TABLE meta_field_value_tombstones
        VALIDATE CONSTRAINT meta_field_value_tombstones_reason_check;
    END $$
  `.execute(db)
}

/**
 * 回滚 = 收回到旧的两个值。**fail-closed**：只要表里还有 `reason = 'retype_convert'` 的行就抛错、什么都不改——
 * 那些行是某次转换唯一的前镜像，收紧约束本身不删它们，但「约束说不存在、表里却有」的状态会让之后任何读这张表的人
 * 误判。要回滚 schema，先确认没有未撤销的转换、并按 runbook 处理前镜像。
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM meta_field_value_tombstones WHERE reason = 'retype_convert') THEN
        RAISE EXCEPTION 'meta_field_value_tombstones still holds retype_convert pre-images; refusing to narrow the reason CHECK';
      END IF;
      ALTER TABLE meta_field_value_tombstones
        DROP CONSTRAINT IF EXISTS meta_field_value_tombstones_reason_check;
      ALTER TABLE meta_field_value_tombstones
        ADD CONSTRAINT meta_field_value_tombstones_reason_check
        CHECK (reason IN ('field_delete', 'lossy_retype'));
    END $$
  `.execute(db)
}
