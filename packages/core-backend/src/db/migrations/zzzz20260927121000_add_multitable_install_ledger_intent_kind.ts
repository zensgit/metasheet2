import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * 去重账本一般化：`meta_multitable_template_installs` 从「模板安装专用」变成「意图去重账本」
 * （设计锁 ADR docs/development/multitable-copy-sheet-with-data-adr-20260926.md CS-16 / §7.7：
 * 「账本 `templateId` 一般化为 `intent_kind + intent_key`」）。
 *
 * 只加一列：
 *   intent_kind text NOT NULL DEFAULT 'template-install'
 * 既有行全部落在默认值上（它们确实都是模板安装）。`template_id` 列**不改名**：对
 * `intent_kind = 'template-install'` 它仍然是模板 id；对别的 kind（第一个是 `copy-sheet`）它存的是
 * 该 kind 自己的意图键（一段 JSON 文本）。列名保留是为了不碰任何既有语句与索引；语义在读侧
 * （multitable/template-install-dedupe.ts）按 kind 解释。
 *
 * 读侧把 `intent_kind` 与 tenant/actor/template_id/workspace_id 一起逐列核对，所以两种 kind 的
 * 意图即使 sha256 撞车也不会互相重放。
 *
 * 迁移未跑时（列不存在，SQLSTATE 42703）：去重模块把它当成「账本不可用」fail-open——模板安装与
 * 复制都退回「不去重」的旧行为，而不是 500。这和账本缺表（42P01）的既有姿态一致。
 *
 * 只 ALTER 一张表、IF NOT EXISTS，可重复执行；`down` 只删自己加的这一列。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE meta_multitable_template_installs
      ADD COLUMN IF NOT EXISTS intent_kind text NOT NULL DEFAULT 'template-install'
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE meta_multitable_template_installs
      DROP COLUMN IF EXISTS intent_kind
  `.execute(db)
}
