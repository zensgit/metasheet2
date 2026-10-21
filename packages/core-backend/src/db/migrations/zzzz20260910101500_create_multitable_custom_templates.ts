import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * 用户自定义多维表模板(「把这张 Base 存为模板」)。
 *
 * 只**新建**一张表 + 一个索引,不 ALTER 任何既有表、不写任何既有表的数据 —— 迁移风险面
 * 限定在这张新表自己身上;`down` 只删自己建的东西。全部 IF NOT EXISTS / IF EXISTS,可重复执行。
 *
 * definition:模板结构 JSON `{ sheets: [...] }`,由 `multitable/custom-template-store.ts` 的
 * `extractTemplateSheets` 从 meta_sheets/meta_fields/meta_views 三张**结构**表抽取,
 * 不含任何记录值(meta_records 一次都不查),字段/视图 id 全部重编号为模板内局部 id。
 *
 * tenant_id:来自 JWT 校验挂上的 `req.authenticatedTenantId`(不是可被 x-tenant-id 兼容头
 * 影响的 `req.user.tenantId`)。读写两侧统一用 `tenant_id IS NOT DISTINCT FROM $n`,
 * 所以 NULL(单租户部署)与具体租户互不可见。故意允许 NULL:多维表现有的
 * meta_bases/meta_sheets 本来就没有租户列,这里强制 NOT NULL 会让无租户声明的部署一条也存不进来。
 *
 * visibility:'private'(默认)或 'tenant'。模板带着表名与全部字段名,而多维表的读面是按
 * 表级权限的 —— 所以默认只有建模板的人看得见,「共享给本租户」必须显式勾选。
 */

export const MULTITABLE_CUSTOM_TEMPLATES_TABLE = 'meta_multitable_custom_templates'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS meta_multitable_custom_templates (
      id text PRIMARY KEY,
      tenant_id text,
      workspace_id text,
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      category text NOT NULL DEFAULT 'Custom',
      icon text,
      color text,
      definition jsonb NOT NULL,
      created_by text,
      visibility text NOT NULL DEFAULT 'private',
      created_at timestamptz DEFAULT now() NOT NULL,
      updated_at timestamptz DEFAULT now() NOT NULL,
      deleted_at timestamptz
    )
  `.execute(db)

  // visibility 是这张表**自己的**列,补加语句只为「CREATE TABLE IF NOT EXISTS 跳过了
  // (表在加这列之前就被建过)」的开发库准备;IF NOT EXISTS → 可重复执行,不碰任何既有表。
  await sql`
    ALTER TABLE meta_multitable_custom_templates
    ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'private'
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_multitable_custom_templates_tenant
    ON meta_multitable_custom_templates(tenant_id, created_at DESC)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX IF EXISTS idx_meta_multitable_custom_templates_tenant
  `.execute(db)

  await sql`
    DROP TABLE IF EXISTS meta_multitable_custom_templates
  `.execute(db)
}
