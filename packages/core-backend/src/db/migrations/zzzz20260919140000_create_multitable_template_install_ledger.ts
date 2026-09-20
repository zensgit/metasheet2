import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * 「使用模板」安装去重账本(#5861)。
 *
 * 事故:客户端 DELETE 到不了服务器、「使用模板」看起来没反应,用户反复点;服务端**没有**
 * 任何去重,同一个模板被实例化 4 次,「可访问的 Base」里出现 4 个同名 Base(222 只读核对)。
 * 这张表让同一次「安装意图」在窗口内只落一个 Base:第二次及以后的请求原样重放第一次的响应。
 *
 * 只**新建**一张表 + 一个索引,不 ALTER 任何既有表、不写任何既有表的数据 —— 迁移风险面
 * 限定在这张新表自己身上;`down` 只删自己建的东西。全部 IF NOT EXISTS / IF EXISTS,可重复执行。
 * 回滚 = 执行 `down`(DROP 这张表),既有的 Base/表/字段/视图一行不受影响;回滚后安装路由
 * 自动退回「不去重」的旧行为(见 multitable/template-install-dedupe.ts 的缺表 fail-open 说明)。
 *
 * scope_digest:安装意图的指纹 = sha256(['mt-template-install', tenantId, actorId, templateId,
 * workspaceId, baseName])。做 PRIMARY KEY —— 唯一索引本身就是并发下「同一意图只留一行」的
 * 兜底(UPSERT 的 ON CONFLICT 目标);真正的互斥来自安装事务开头的
 * `pg_advisory_xact_lock(hashtextextended(scope_digest, 0))`。
 *
 * tenant_id / actor_id:**不只是**给人看的。读侧在拿到行之后会再核对这四列与当前请求的
 * 作用域是否逐一相等,不相等就当没命中 —— 租户/用户边界因此不依赖「sha256 不碰撞」这个假设。
 * tenant_id 只来自 JWT 校验挂上的 `req.authenticatedTenantId`(不是可被 x-tenant-id 兼容头
 * 改写的 `req.user.tenantId`),与 meta_multitable_custom_templates 同一个口径。
 *
 * response:第一次安装那条 201 响应的完整 body。重放时原样回放,所以重复点击拿到的
 * base/sheet/view id 与第一次**逐字节相同**,前端照常跳转到那个 Base。
 * 只存结构(模板定义 + 新建出来的 base/sheet/field/view 元数据),不含任何记录值 ——
 * 安装本身一行记录都不写。
 *
 * installed_at:窗口起点。过期行由安装路径顺手清理(DELETE ... WHERE installed_at < now() - 窗口),
 * 所以这张表的稳态行数 ≈ 窗口内的安装次数,不会无界增长。
 */

export const MULTITABLE_TEMPLATE_INSTALL_LEDGER_TABLE = 'meta_multitable_template_installs'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS meta_multitable_template_installs (
      scope_digest text PRIMARY KEY,
      tenant_id text,
      actor_id text NOT NULL,
      template_id text NOT NULL,
      workspace_id text,
      base_id text NOT NULL,
      response jsonb NOT NULL,
      installed_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  // 过期清理走这个索引(DELETE ... WHERE installed_at < ...)。
  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_multitable_template_installs_installed_at
    ON meta_multitable_template_installs(installed_at)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX IF EXISTS idx_meta_multitable_template_installs_installed_at
  `.execute(db)

  await sql`
    DROP TABLE IF EXISTS meta_multitable_template_installs
  `.execute(db)
}
