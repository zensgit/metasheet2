# 外接数据源「被引用 N」列 — 设计 (2026-09-10)

叠加在「外接数据源并入数据工厂」(PR #5587, `feat/data-sources-fold-into-workbench` @ 7eff1e8d2) 之上。

## 1. 为什么

删除守卫早就存在:`DELETE /api/data-sources/:id` 在源仍被数据工厂绑定引用时答 409
`DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS`。但这个事实只在**点了删除之后**才出现,
而且以英文散文的形式点名内部表 `integration_external_systems.config.dataSourceId`,
还顺带宣传了平台管理员专属的 `force=true`。列表页对此一无所知。

本次把同一个事实提前到列表上,并把 409 翻成一线能执行的两件事:被几个绑定占着、去哪儿解除。

## 2. SQL 形状:两条 GROUP BY 覆盖整页

`DataSourceManager.countExternalSystemReferencesByIds(ids)` —— 无论页面有多少行,
只发**两条**查询(不是每行一对):

- canonical:`select connection_id, count(*)::int from integration_external_systems
  where connection_id in (...) group by connection_id`
- legacy:`select config->>'dataSourceId', config->>'dataSourceOwnerId', count(*)::int
  from integration_external_systems where connection_id is null
  and config->>'dataSourceId' in (...) group by 1, 2`

JSON 路径表达式与单条版 `countExternalSystemReferences`(DataSourceManager.ts:652)**逐字相同**:
`sql\`config->>'dataSourceId'\`` 与 `sql\`config->>'dataSourceOwnerId'\``。

### 归属判定为什么留在 TS 里

单条版把 owner 写进 WHERE(`config->>'dataSourceOwnerId' = ownerId`)。批量版做不到:
一条查询服务多个 id,每个 id 有**各自的** owner,谓词不是常量。所以按
`(dataSourceId, dataSourceOwnerId)` **成对**分组,再在 TS 里逐组比对该 id 自己的 scope owner。
算术上是同一个过滤,只是从逐行变成逐组。

放宽成裸 `dataSourceId` 匹配会重新打开 P2-A:任何租户的 `integration:write` 持有者
pin 一个别人的源 id,就能让计数虚高、并让所有者看到一个自己无法解释的数字。
未盖章(stamp 为 NULL)的行同样不计——归属不可知的引用不该替所有者背书。

### 失败姿态

与单条版一致:无 db → 全 0(内存态管理器,没有任何持久化的东西能引用它,0 是精确值);
**首条**查询 SQLSTATE 42P01 → 全 0(集成 schema 未安装,引用层不存在);其余异常一律上抛,
第二条查询的 42P01 也上抛(已观测到的 canonical 计数不能被 DDL 竞态丢掉)。

## 3. unknown ≠ 0

路由层 `referenceCountsForDisplay` 吞掉计数查询的异常,但**省略字段**而不是填 0。
理由:0 会被读成「未被引用,可以放心删」,而这次删除仍会被 409 拒绝。
列表本身的数据是完好的,不该因为计数失败整页 500;但也不能拿一个我们并不知道的数字去背书。
权威判定始终在删除守卫,它会重算并对同样的错误 fail closed。

## 4. values-free

响应里只有整数。被引用方的名称、租户、owner、配置从不过线——服务器只发计数。
失败路径不落日志(错误消息可能点名引用行)。SQL 里出现的 owner id 只在进程内用于比对,
不进任何响应。

## 5. UI 三态

| referenceCount | 显示 | 删除确认 |
| --- | --- | --- |
| `> 0` | 「N 个绑定」+「去看绑定」 | 点名 N,说明会被 409 拒绝,请先解除引用 |
| `0` | 「未被引用」 | 原文案逐字不变 |
| 缺失 | 「未知」 | 原文案(不预告一个我们预测不了的拒绝) |

「去看绑定」:嵌入时是本页锚点 `#int-sec-connection`,并 emit `show-bindings` 请求宿主展开
「已配置连接」清单(默认折叠,只跳锚点会落在一个答案还藏着的分区);独立页薄壳下是到
`/integrations/workbench#int-sec-connection` 的真实跳转,不拦截。
`changed` 语义不变;`show-bindings` 是独立的请求型事件。

## 6. 刻意不做

- **前端不暴露 force**。`force=true` 是平台管理员的 API 级动作,会被审计成有意断引用;
  在这个面板上给入口等于教一线去够一个 UI 不会发、角色也会被 403 的开关。
- **不动 openapi**。`GET /api/data-sources` 的 200 响应本就没有声明 schema
  (`description: OK`),加字段是契约兼容的,不需要重建 dist-sdk。
- **不合并两个计数方法**。删除守卫继续走单条版(它的 fail-closed 姿态是真正的闸门),
  批量版只服务读面;两者由一条等价性测试绑死,漂移即红。
