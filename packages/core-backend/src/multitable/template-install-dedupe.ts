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
 * ── 重放前的存活核对(硬要求) ───────────────────────────────────────────────
 * 重放**交还给用户的是什么,就核对什么**:账本里记的 base_id + 那次安装建出来的每一个
 * sheet_id,都必须还是 live(deleted_at IS NULL)才敢重放。
 * 为什么不能只看 Base 行还在不在:产品里**没有**删 Base 的路由(repo 内写 meta_bases 的只有
 * routes/univer-meta.ts 的改名 UPDATE),用户消灭一个多余的模板 Base 的唯一办法是删掉里面
 * 那张表 —— 而那是**软删**(UPDATE meta_sheets SET deleted_at = now())。删完之后 Base 行还在、
 * 但「可访问的 Base」列表已经看不到它了(列表要求 Base 至少还有一张可读的 live 表),
 * 用户眼里那个 Base 已经没了。此时若只核对 Base 行,就会把一条指向**已软删表**的 201 重放回去:
 * 前端 router.push 到一个不存在的 sheetId,列表里也什么都没多出来 —— 正好复现 issue 要终结的
 * 「看起来没反应 → 再点一次」循环。所以 ③ 必须连 sheet 一起核对。
 * 任何一项不 live → 删掉这条陈账、**真的再装一次**(新安装会 mint 新 baseId,stableChildId
 * 由 baseId 派生,所以不会和那张已删的表撞 id)。
 *
 * ── 并发保证(不是「先查后插」) ──────────────────────────────────────────────
 * 三层,从强到弱:
 *   1. pg_try_advisory_xact_lock(hashtextextended(scope_digest::text, 0)) —— 事务级咨询锁,
 *      在**同一个安装事务的第一条语句**取,commit/rollback 时由 PG 自己释放。两个并发的
 *      同意图请求里,后到的那个拿不到锁就退避重试,直到先到的那个提交;它随后读账本必然
 *      看得见已提交的那一行,于是走重放。跨进程、跨实例都成立(锁在 PG 里,不在进程内)。
 *      用 try + 有界重试而不是阻塞版 pg_advisory_xact_lock:阻塞版把等待算进**同一条语句**的
 *      耗时,而连接池给每条语句设了 statement_timeout/query_timeout(默认 30s,见
 *      integration/db/connection-pool.ts),于是「第一次安装卡住」时,后面那几次点击会在 30s
 *      后被取消、落到 500 —— 改动前它们是 201。有界 try 把等待拆成很多条短语句:等满上限就
 *      退回「不加锁」的老路径(读账本 → 没有就照常安装),最坏情况等同**改动前**的行为,
 *      而不是把一次重复点击变成红色错误;顺带把占住池连接的时间从 30s 压到上限内。
 *   2. scope_digest 是 PRIMARY KEY,写回走 ON CONFLICT (scope_digest) DO UPDATE ——
 *      即使没拿到锁(第 1 层退化),也不可能出现同一指纹两行。
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
 * proxy_read_timeout 是 300s(docker/nginx.conf),所以一次卡住的安装请求最久会让转圈
 * 持续 5 分钟,用户在这期间刷新页面、重新点(刷新会清掉前端的 in-flight 闸门)。几秒的窗口
 * 只挡得住真·双击 —— 而真·双击前端闸门本来就挡住了。窗口必须覆盖「卡住 → 放弃 → 再点」
 * 这一整个周期,所以对齐到同一个 300s。窗口长度是 owner 可推翻的取值。
 *
 * 代价:同一个人在 5 分钟内想用同一个模板、在同一个工作区、用**同一个名字**再建一个 Base,
 * 会拿回第一个。规避方式有两条且都不用等:换一个 baseName(进指纹),或先把第一个里的表删掉
 * (账本命中时会核对 Base **和它建出来的每张表**是否都还 live,不 live 就重新安装)。
 */
export const TEMPLATE_INSTALL_DEDUPE_WINDOW_MS = 300_000

/**
 * 咨询锁的**有界**等待上限。默认 15s = 连接池默认 statement_timeout(30s)的一半 ——
 * 留出余量,使锁等待永远不会由 statement_timeout 来结束(那会变成 500)。
 * 等满仍拿不到就带着 lockHeld=false 往下走(退化到第 2 层:PK + ON CONFLICT)。
 */
export const TEMPLATE_INSTALL_LOCK_WAIT_MS = 15_000
/** 第一次重试的退避;之后翻倍,封顶 TEMPLATE_INSTALL_LOCK_POLL_MAX_MS。 */
export const TEMPLATE_INSTALL_LOCK_POLL_MS = 25
export const TEMPLATE_INSTALL_LOCK_POLL_MAX_MS = 250

/** 过期行清理一次最多删多少行 —— 清理跑在安装事务里,不能是一条无界的 DELETE。 */
const TEMPLATE_INSTALL_SWEEP_LIMIT = 200

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
  sheet_ids?: unknown
  response?: unknown
  tenant_id?: unknown
  actor_id?: unknown
  template_id?: unknown
  workspace_id?: unknown
}

function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** text[] 列读回来是 string[];任何别的形状都当「记不全」处理(= 不敢重放)。 */
function asTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) return []
    out.push(item)
  }
  return out
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

/**
 * 咨询锁语句。`$1::text` 显式写类型 —— 与本仓既有的咨询锁先例同形
 * (attendance/w4c0-identity.ts 的 `hashtext($1::text)`),不依赖 PG 对无类型参数的推断。
 * 这条语句**不**走 ledgerQuery:它与账本表无关,账本的缺表 fail-open 不该吞它的错。
 */
export const TEMPLATE_INSTALL_LOCK_SQL =
  'SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 0)) AS locked'

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 有界地取锁。拿到 → true;等满上限仍拿不到 → false(调用方带着 lockHeld=false 继续,
 * 退化成「PK 兜底」级别的互斥,也就是改动前的并发行为)。
 */
async function acquireScopeLock(
  query: TemplateInstallQueryFn,
  digest: string,
  waitMs: number,
  pollMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const deadline = Date.now() + waitMs
  let backoff = Math.max(1, pollMs)
  for (;;) {
    const res = await query(TEMPLATE_INSTALL_LOCK_SQL, [digest])
    const locked = (res.rows?.[0] as { locked?: unknown } | undefined)?.locked
    if (typeof locked !== 'boolean') {
      // PG 恒回一行一列的 boolean。只有**假的** query 面会走到这里 —— 与其静默地一路
      // 退避到上限(看起来像挂住),不如立刻大声失败,让那个 fake 自己去补。
      throw new Error('pg_try_advisory_xact_lock did not return a boolean `locked` column')
    }
    if (locked) return true
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await sleep(Math.min(backoff, remaining))
    backoff = Math.min(backoff * 2, TEMPLATE_INSTALL_LOCK_POLL_MAX_MS)
  }
}

/**
 * 重放前的存活核对:账本记下的 Base **和**每一个 sheet 都必须 live。
 * 少一个都不重放 —— 重放交还的就是这些 id,它们死了等于把用户送到一个空壳上。
 */
async function priorInstallIsStillLive(
  query: TemplateInstallQueryFn,
  baseId: string,
  sheetIds: readonly string[],
): Promise<boolean> {
  const base = await query('SELECT id FROM meta_bases WHERE id = $1 AND deleted_at IS NULL', [baseId])
  if ((base.rows?.length ?? 0) === 0) return false
  const live = await query(
    'SELECT id FROM meta_sheets WHERE id = ANY($1::text[]) AND deleted_at IS NULL',
    [[...sheetIds]],
  )
  return (live.rows?.length ?? 0) === sheetIds.length
}

export interface TemplateInstallFreshResult {
  /** 新建出来的 Base id —— 写进账本,重放时核对它还 live 不 live。 */
  readonly baseId: string
  /** 这次安装建出来的**全部** sheet id —— 重放前逐个核对 live。 */
  readonly sheetIds: readonly string[]
  /** 这次安装要回给客户端的完整响应 body。重放时原样回放。 */
  readonly body: unknown
}

export interface DeduplicatedTemplateInstall {
  /** true = 命中窗口内的上一次安装,这次**一行都没建**。 */
  readonly replayed: boolean
  readonly baseId: string
  readonly body: unknown
  /** false = 有界等待内没拿到咨询锁,这一次只有 PK 兜底(路由据此打一条 warn)。 */
  readonly lockHeld: boolean
}

export interface RunDeduplicatedTemplateInstallInput {
  /** 必须是**事务内**的 query —— 咨询锁是事务级的,脱离事务立刻就释放了。 */
  readonly query: TemplateInstallQueryFn
  readonly scope: TemplateInstallScope
  /** 真的去安装。只有没命中账本时才会被调用。 */
  readonly install: () => Promise<TemplateInstallFreshResult>
  /** 窗口长度;默认 TEMPLATE_INSTALL_DEDUPE_WINDOW_MS。测试用来压缩/拉长窗口。 */
  readonly windowMs?: number
  /** 咨询锁等待上限;默认 TEMPLATE_INSTALL_LOCK_WAIT_MS。 */
  readonly lockWaitMs?: number
  /** 第一次退避;默认 TEMPLATE_INSTALL_LOCK_POLL_MS。 */
  readonly lockPollMs?: number
  /** 退避实现;默认 setTimeout。测试注入。 */
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * 去重外壳。调用方必须把它整个放进一个事务里(见文件头「并发保证」)。
 *
 * 顺序是有意的:
 *   ① 先(有界地)取咨询锁 —— 在任何读/写之前,后到的同意图请求从这里开始排队;
 *   ② 读账本(窗口内)→ 命中且 Base 与它建出来的每张表都还 live → 重放,install() 一次都不调用;
 *   ③ 命中但那次安装已经被用户删掉(Base 软删 / 任一 sheet 软删 / 行记不全)→ 删掉这条陈账,
 *      继续正常安装(删了再装必须真的装出来);
 *   ④ 安装 → 写账本(UPSERT)→ 顺手清理过期行。
 */
export async function runDeduplicatedTemplateInstall(
  input: RunDeduplicatedTemplateInstallInput,
): Promise<DeduplicatedTemplateInstall> {
  const { query, scope, install } = input
  const windowMs = input.windowMs ?? TEMPLATE_INSTALL_DEDUPE_WINDOW_MS
  const digest = buildTemplateInstallScopeDigest(scope)

  // ① 事务级咨询锁(有界)。hashtextextended 把指纹压成 bigint;不同指纹撞同一把锁只会
  // 多排一会儿队(正确性不受影响),同一指纹**必然**同一把锁。
  const lockHeld = await acquireScopeLock(
    query,
    digest,
    input.lockWaitMs ?? TEMPLATE_INSTALL_LOCK_WAIT_MS,
    input.lockPollMs ?? TEMPLATE_INSTALL_LOCK_POLL_MS,
    input.sleep ?? defaultSleep,
  )

  // ② 窗口内的上一次安装。
  const priorResult = await ledgerQuery(
    query,
    `SELECT base_id, sheet_ids, response, tenant_id, actor_id, template_id, workspace_id
       FROM ${TEMPLATE_INSTALL_LEDGER_TABLE}
      WHERE scope_digest = $1
        AND installed_at > now() - ($2::bigint * interval '1 millisecond')`,
    [digest, windowMs],
  )
  const prior = (priorResult.rows?.[0] ?? null) as LedgerRow | null
  if (prior && rowMatchesScope(prior, scope)) {
    const priorBaseId = asText(prior.base_id)
    const priorSheetIds = asTextArray(prior.sheet_ids)
    // 存下来的 body 必须还是个对象才敢重放。jsonb 列是 NOT NULL,所以 `'null'::jsonb`
    // 这种形状只可能来自将来某次写入回归 —— 真撞上就当没命中、正常安装,
    // 而不是把一个 `null` body 当成 201 回给客户端。
    const replayable = typeof prior.response === 'object' && prior.response !== null
    // sheet_ids 为空 = 这行不知道自己建过哪些表 → 没法核对 → 不重放(退回改动前的行为)。
    const alive = priorBaseId !== null
      && replayable
      && priorSheetIds.length > 0
      && await priorInstallIsStillLive(query, priorBaseId, priorSheetIds)
    if (alive && priorBaseId) {
      return { replayed: true, baseId: priorBaseId, body: prior.response, lockHeld }
    }
    // ③ 陈账:删掉,继续往下真安装。
    await ledgerQuery(query, `DELETE FROM ${TEMPLATE_INSTALL_LEDGER_TABLE} WHERE scope_digest = $1`, [digest])
  }

  // ④ 真安装 + 记账。
  const fresh = await install()
  await ledgerQuery(
    query,
    `INSERT INTO ${TEMPLATE_INSTALL_LEDGER_TABLE}
       (scope_digest, tenant_id, actor_id, template_id, workspace_id, base_id, sheet_ids, response, installed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::jsonb, now())
     ON CONFLICT (scope_digest) DO UPDATE SET
       tenant_id = EXCLUDED.tenant_id,
       actor_id = EXCLUDED.actor_id,
       template_id = EXCLUDED.template_id,
       workspace_id = EXCLUDED.workspace_id,
       base_id = EXCLUDED.base_id,
       sheet_ids = EXCLUDED.sheet_ids,
       response = EXCLUDED.response,
       installed_at = EXCLUDED.installed_at`,
    [
      digest,
      scope.tenantId,
      scope.actorId,
      scope.templateId,
      scope.workspaceId,
      fresh.baseId,
      [...fresh.sheetIds],
      JSON.stringify(fresh.body ?? null),
    ],
  )

  // 过期行清理 —— 稳态行数 ≈ 窗口内的安装次数。它跑在安装事务里(失败一起回滚),所以
  // **不能**去等别人的行锁:子查询 FOR UPDATE SKIP LOCKED + LIMIT 让它只删当下没人占着的
  // 那一批,永不阻塞,也就不可能和另一个安装事务互相等成死锁。
  await ledgerQuery(
    query,
    `DELETE FROM ${TEMPLATE_INSTALL_LEDGER_TABLE}
      WHERE scope_digest IN (
        SELECT scope_digest FROM ${TEMPLATE_INSTALL_LEDGER_TABLE}
         WHERE installed_at < now() - ($1::bigint * interval '1 millisecond')
         ORDER BY installed_at
         LIMIT ${TEMPLATE_INSTALL_SWEEP_LIMIT}
         FOR UPDATE SKIP LOCKED
      )`,
    [windowMs],
  )

  return { replayed: false, baseId: fresh.baseId, body: fresh.body, lockHeld }
}
