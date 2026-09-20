/**
 * 「使用模板」安装去重(#5861)。
 *
 * 事故(客户反馈 2026-09-18 第 5 条):客户端 DELETE 到不了服务器、「使用模板」看起来
 * 「无响应」,用户反复点;服务端**零去重**,同一个模板被实例化 4 次,「可访问的 Base」里
 * 出现 4 个同名 Base(222 只读核对:4 个不同 base 各含一张来自模板的表)。
 *
 * 口径:同一个「安装意图」在窗口内只落一个 Base。第二次及以后的请求**不报错**,而是
 * 原样重放第一次那条 201 响应 —— 用户看到的就是他刚才想要的那个 Base,这正是 issue 的要求
 * (「窗口内重复实例化返回同一个 Base 而不是新建」),也比回一个红色错误更接近用户意图。
 *
 * ── 意图指纹(硬边界) ────────────────────────────────────────────────────────
 * scope = (tenantId, actorId, templateId, workspaceId, baseName)。
 *   - tenantId 只能是 `req.authenticatedTenantId`(JWT 校验挂上的),调用方**不能**用
 *     x-tenant-id 兼容头改写它;路由侧由 resolveTemplateTenantId() 统一取,与自定义模板
 *     的租户口径同源。绝不用 `req.user.tenantId`(那一条在无租户声明的 token 上会被
 *     兼容头填进去 —— 本仓历史上的跨租户值泄漏就出在那里)。
 *   - actorId 是鉴权解析出的 userId,不是 body 里的任何东西。
 *   - workspaceId / baseName 进指纹是为了「换个落点/换个名字 = 另一次意图」:想再建一个
 *     同模板的 Base,给它另一个名字即可,不必等窗口过期。
 * 指纹是 sha256,但**租户/用户隔离不依赖 sha256 不碰撞**:读到行之后还会逐列核对
 * tenant_id / actor_id / template_id / workspace_id 与当前作用域相等,不等就当没命中
 * (见 rowMatchesScope)。
 *
 * ── 并发保证(不是「先查后插」) ──────────────────────────────────────────────
 * 三层,从强到弱:
 *   1. `pg_advisory_xact_lock(hashtextextended(scope_digest, 0))` —— 事务级咨询锁,
 *      在**同一个安装事务的第一条语句**取,commit/rollback 时由 PG 自己释放。两个并发的
 *      同意图请求里,后到的那个在这条语句上阻塞,直到先到的那个提交;它随后读账本必然
 *      看得见已提交的那一行,于是走重放。跨进程、跨实例都成立(锁在 PG 里,不在进程内)。
 *   2. `scope_digest` 是 PRIMARY KEY,写回走 `ON CONFLICT (scope_digest) DO UPDATE` ——
 *      即使锁被绕过(例如有人把第 1 层删了),也不可能出现同一指纹两行。
 *   3. 整段(锁 → 读账本 → 安装 → 写账本)在**一个事务**里。安装失败回滚时账本不留痕,
 *      所以失败后重试是真的重试,不会被自己上一次的失败卡住。
 * 刻意**不**用进程内 Map:单进程内的 Map 在多实例/重启后各记一份,而这条路径的失败模式
 * (用户反复点、页面刷新后再点)恰好会跨越重启与实例。
 *
 * ── 未迁移时(fail-open,有意为之) ─────────────────────────────────────────
 * 账本表不存在(SQLSTATE 42P01)→ 抛 TemplateInstallLedgerUnavailableError,路由退回
 * **改动前的**行为(照常安装,不去重),而不是 503。理由:这张表只服务于去重,不是安装的
 * 数据依赖;先部署代码后跑迁移的机器不该连模板都装不了。代价是迁移跑之前去重不生效 ——
 * 上线时必须跑 `pnpm --filter @metasheet/core-backend migrate`。
 */

import { createHash } from 'node:crypto'

export type TemplateInstallQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export const TEMPLATE_INSTALL_LEDGER_TABLE = 'meta_multitable_template_installs'

/**
 * 去重窗口:5 分钟,从**上一次安装成功**算起(不滑动 —— 窗口内的重放不会延长它)。
 *
 * 为什么是 5 分钟而不是几秒:事故里的重复点击不是「双击」。页面 → nginx 的
 * `proxy_read_timeout` 是 300s(docker/nginx.conf),所以一次卡住的安装请求最久会让转圈
 * 持续 5 分钟,用户在这期间刷新页面、重新点(刷新会清掉前端的 in-flight 闸门)。几秒的窗口
 * 只挡得住真·双击 —— 而真·双击前端闸门本来就挡住了。窗口必须覆盖「卡住 → 放弃 → 再点」
 * 这一整个周期,所以对齐到同一个 300s。
 *
 * 代价:同一个人在 5 分钟内想用同一个模板、在同一个工作区、用**同一个名字**再建一个 Base,
 * 会拿回第一个。规避方式有两条且都不用等:换一个 baseName(进指纹),或先把第一个删掉
 * (账本命中时会核对 Base 是否还在,不在就重新安装 —— 见 readRecentTemplateInstall 的调用处)。
 */
export const TEMPLATE_INSTALL_DEDUPE_WINDOW_MS = 300_000

export interface TemplateInstallScope {
  /** 只来自 req.authenticatedTenantId;无租户声明的部署是 null,null 与任何具体租户互不命中。 */
  readonly tenantId: string | null
  /** 鉴权解析出的 userId。 */
  readonly actorId: string
  readonly templateId: string
  readonly workspaceId: string | null
  /** 请求里显式给的 Base 名(trim 后);没给是 null。 */
  readonly baseName: string | null
}

/** 账本表不存在。路由据此退回「不去重」的旧行为,而不是把安装打成 500/503。 */
export class TemplateInstallLedgerUnavailableError extends Error {
  constructor() {
    super(`${TEMPLATE_INSTALL_LEDGER_TABLE} is not migrated yet; template install ran without dedupe`)
    this.name = 'TemplateInstallLedgerUnavailableError'
  }
}

/** PG 缺表 SQLSTATE。中文 locale 下 PG 散文被翻译,散文匹配会漏判 —— 只认 code。 */
function isUndefinedTable(err: unknown): boolean {
  return (err as { code?: unknown } | null | undefined)?.code === '42P01'
}

/**
 * 安装意图的指纹。
 *
 * JSON 数组做拼接:每一段都被引号 + 转义包起来,任何分隔符都无法被字段值伪造出来
 * (`a|b` 与 `a` + `b` 不会拼成同一个字符串)。首段是常量命名空间,避免与别处的摘要撞用途。
 */
export function buildTemplateInstallScopeDigest(scope: TemplateInstallScope): string {
  const canonical = JSON.stringify([
    'mt-template-install',
    scope.tenantId,
    scope.actorId,
    scope.templateId,
    scope.workspaceId,
    scope.baseName,
  ])
  return createHash('sha256').update(canonical).digest('hex')
}

interface LedgerRow {
  base_id?: unknown
  response?: unknown
  tenant_id?: unknown
  actor_id?: unknown
  template_id?: unknown
  workspace_id?: unknown
}

function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * 逐列核对 —— 纵深防御。指纹已经把这些列编进去了,所以这几条等式按构造恒成立;显式再查一遍
 * 是为了让「租户/用户不串」这条硬边界不依赖「sha256 不碰撞」这个假设。任何一列不等 → 当没命中,
 * 走正常安装(绝不把别人的 Base 重放给当前请求)。
 */
function rowMatchesScope(row: LedgerRow, scope: TemplateInstallScope): boolean {
  return (
    asText(row.tenant_id) === scope.tenantId &&
    asText(row.actor_id) === scope.actorId &&
    asText(row.template_id) === scope.templateId &&
    asText(row.workspace_id) === scope.workspaceId
  )
}

async function ledgerQuery(
  query: TemplateInstallQueryFn,
  sql: string,
  params: unknown[],
): Promise<{ rows: unknown[]; rowCount?: number | null }> {
  try {
    return await query(sql, params)
  } catch (err) {
    // 只有**账本自己**的缺表才翻译成 fail-open;别的表缺失照常往上抛,
    // 否则会把一个真的坏掉的库伪装成「去重不可用」然后重跑一次安装。
    if (isUndefinedTable(err)) throw new TemplateInstallLedgerUnavailableError()
    throw err
  }
}

export interface TemplateInstallFreshResult {
  /** 新建出来的 Base id —— 写进账本,重放时用来核对这个 Base 还在不在。 */
  readonly baseId: string
  /** 这次安装要回给客户端的完整响应 body。重放时原样回放。 */
  readonly body: unknown
}

export interface DeduplicatedTemplateInstall {
  /** true = 命中窗口内的上一次安装,这次**一行都没建**。 */
  readonly replayed: boolean
  readonly baseId: string
  readonly body: unknown
}

export interface RunDeduplicatedTemplateInstallInput {
  /** 必须是**事务内**的 query —— 咨询锁是事务级的,脱离事务立刻就释放了。 */
  readonly query: TemplateInstallQueryFn
  readonly scope: TemplateInstallScope
  /** 真的去安装。只有没命中账本时才会被调用。 */
  readonly install: () => Promise<TemplateInstallFreshResult>
  /** 窗口长度;默认 TEMPLATE_INSTALL_DEDUPE_WINDOW_MS。测试用来压缩/拉长窗口。 */
  readonly windowMs?: number
}

/**
 * 去重外壳。调用方必须把它整个放进一个事务里(见文件头「并发保证」)。
 *
 * 顺序是有意的:
 *   ① 先取咨询锁 —— 在任何读/写之前,后到的同意图请求从这里开始排队;
 *   ② 读账本(窗口内)→ 命中且 Base 还在 → 重放,install() 一次都不调用;
 *   ③ 命中但 Base 已经被删了 → 删掉这条陈账,继续正常安装(删了再装必须真的装出来);
 *   ④ 安装 → 写账本(UPSERT)→ 顺手清理过期行。
 */
export async function runDeduplicatedTemplateInstall(
  input: RunDeduplicatedTemplateInstallInput,
): Promise<DeduplicatedTemplateInstall> {
  const { query, scope, install } = input
  const windowMs = input.windowMs ?? TEMPLATE_INSTALL_DEDUPE_WINDOW_MS
  const digest = buildTemplateInstallScopeDigest(scope)

  // ① 事务级咨询锁。hashtextextended 把 64 位指纹压成 bigint;不同指纹撞同一把锁只会
  // 多排一会儿队(正确性不受影响),同一指纹**必然**同一把锁。
  await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [digest])

  // ② 窗口内的上一次安装。
  const priorResult = await ledgerQuery(
    query,
    `SELECT base_id, response, tenant_id, actor_id, template_id, workspace_id
       FROM ${TEMPLATE_INSTALL_LEDGER_TABLE}
      WHERE scope_digest = $1
        AND installed_at > now() - ($2::bigint * interval '1 millisecond')`,
    [digest, windowMs],
  )
  const prior = (priorResult.rows?.[0] ?? null) as LedgerRow | null
  if (prior && rowMatchesScope(prior, scope)) {
    const priorBaseId = asText(prior.base_id)
    if (priorBaseId) {
      // ③ 那个 Base 还在吗?用户把它删掉之后再点「使用模板」,必须真的再建一个 ——
      // 否则重放会把客户端送到一个已经不存在的 Base 上。
      const stillThere = await query('SELECT id FROM meta_bases WHERE id = $1', [priorBaseId])
      // 存下来的 body 必须还是个对象才敢重放。jsonb 列是 NOT NULL,所以 `'null'::jsonb`
      // 这种形状只可能来自将来某次写入回归 —— 真撞上就当没命中、正常安装,
      // 而不是把一个 `null` body 当成 201 回给客户端。
      const replayable = typeof prior.response === 'object' && prior.response !== null
      if ((stillThere.rows?.length ?? 0) > 0 && replayable) {
        return { replayed: true, baseId: priorBaseId, body: prior.response }
      }
      await ledgerQuery(query, `DELETE FROM ${TEMPLATE_INSTALL_LEDGER_TABLE} WHERE scope_digest = $1`, [digest])
    }
  }

  // ④ 真安装 + 记账。
  const fresh = await install()
  await ledgerQuery(
    query,
    `INSERT INTO ${TEMPLATE_INSTALL_LEDGER_TABLE}
       (scope_digest, tenant_id, actor_id, template_id, workspace_id, base_id, response, installed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
     ON CONFLICT (scope_digest) DO UPDATE SET
       tenant_id = EXCLUDED.tenant_id,
       actor_id = EXCLUDED.actor_id,
       template_id = EXCLUDED.template_id,
       workspace_id = EXCLUDED.workspace_id,
       base_id = EXCLUDED.base_id,
       response = EXCLUDED.response,
       installed_at = EXCLUDED.installed_at`,
    [
      digest,
      scope.tenantId,
      scope.actorId,
      scope.templateId,
      scope.workspaceId,
      fresh.baseId,
      JSON.stringify(fresh.body ?? null),
    ],
  )

  // 过期行清理 —— 稳态行数 ≈ 窗口内的安装次数。跑在同一个事务里,失败一起回滚。
  await ledgerQuery(
    query,
    `DELETE FROM ${TEMPLATE_INSTALL_LEDGER_TABLE}
      WHERE installed_at < now() - ($1::bigint * interval '1 millisecond')`,
    [windowMs],
  )

  return { replayed: false, baseId: fresh.baseId, body: fresh.body }
}
