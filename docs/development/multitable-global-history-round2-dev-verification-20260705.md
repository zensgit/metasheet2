# Multitable Global History — 固定节奏并行开发第 2 轮:设计 + 验证(2026-07-05)

**Round scope:** 第 1 轮(见 `multitable-global-history-parallel-round-dev-verification-20260705.md`)收官后,从目标池新掘出的 2 个非闸门项,双车道并行建设、逐条评审、auto-merge 落地。owner 决策菜单(7 flag 启用 / T-source / 破坏性 tier FE / 4c 不可逆 slice)继续零触碰。

| PR | 内容 | Merge |
|---|---|---|
| #3626 | feat: T1b — history batch detail 补齐 masked per-field `before`(Lane D) | `19e467e73` |
| #3627 | fix: 漂移历史迁移加固 — FK 类型 guard + 去吞错条件约束(Lane E) | `b312ce2a2` |

**Cadence & model(同第 1 轮):** 编排/评审 = 主会话(高推理);两条实现车道 = 并行隔离 worktree 子代理(标准实现模型);每车道 mutation-proven + docker 真跑 + 诚实报告,过主会话逐点人审后落地。

---

## 1. Lane D — T1b before-hydration(#3626)

**依据:** `history-projection.ts` 自 #2961 起注明的只读 refinement(`before: null // T1b … detail refinement`),属已授权只读 MVP 范围,非闸门;第 1 轮 Lane C(#3608)FE 内联 diff 的诚实缺口自然闭环——落地后 FE before→after 行自动点亮,零 FE 代码改动。

**设计(schema 实证,非猜测):**
- `create` → `before: null`(无先前状态)
- `update` → **最近幸存前一 revision** 的 `snapshot`(写入方证据:revision 自身 `patch`/`snapshot` 只含 post-update 值);取"最近幸存"而非 `version-1`,因 retention sweep 可掏空日志中段
- `delete` → 该 revision **自带**的 `snapshot` 列(`deleteRecord` 在 DELETE 前捕获,无需 lookup)
- **整批一次额外查询**(绝无 per-change N+1):`unnest` 批量 + `JOIN LATERAL … LIMIT 1`,仅对 batch 内 `update` 行,骑 `(sheet_id, record_id, version DESC)` 既有索引;denied 行在 lookup **之前**剔除(其 version 根本不进查询)
- **掩码奇偶(关键不变量):** `before` 与 `after` 走同一 `filterDataByAllowedFields(…, allowed)`;`changedFieldIds` 保持 post-mask 不扩集;wire 契约不变(`before: object|null`)

**验证:** 新 realdb golden 套件 7 条(update 双侧值 / 掩码奇偶(control+denial)/ create-null / delete-snapshot / 多 revision 取紧邻前一条)。**Mutation 证据:** ①读错 revision → 恰好值断言 goldens 红;②仅对 `before` 跳过掩码 → 恰好掩码奇偶 golden 红(其余 6 条保持绿,隔离性成立);均复原后 **85/85**(7 新 + 78 既有 events/hasMore/audit-grant/reveal/taint/field-mask 全套)。`tsc --noEmit` 干净;OpenAPI 未触(该路由不在 base.yml,grep 验证,零 dist 漂移);FE spec 6/6(一条以"服务端恒 null"为前提的 spec 重定向到仍真实的 create-action 形状,渲染覆盖不变)。

**诚实缺口(承接,未隐藏):** retention 开启(默认关)且中段被清时,`before` 反映最近幸存旧态而非紧邻前态——retention 固有取舍,已注释;update 行完全无前 revision 的手工播种边角未单独 golden(代码路径安全退化为 null)。

## 2. Lane E — 漂移历史迁移加固(#3627)

**依据:** 第 1 轮 Lane B 落在 #3609 评论里的 2 个预存迁移缺陷;repo 卫生,非闸门。

**关键诚实重定性(调查推翻任务前提):** 当前 main 上原味空库 `db:migrate` 实际**干净**(237/237, exit 0)——两 bug 咬合的是**漂移/乱序历史**路径(repo 以 `allowUnorderedMigrations: true` 明确支持,`migrate.ts:32`);且 CI `migration-replay.yml:75` 对 bug 1 一直以 MIGRATION_EXCLUDE **绕过而非修复**(workflow 注释自证"legacy owner_id FK assumes pre-text user ids")。

**修法(两界安全,in-place,不改名不重编号):**
- **Bug 1** `20250925_create_view_tables.sql`(7 个 FK 块):存在性 guard 上 AND 类型兼容检查(`information_schema.columns` data_type join)。两界推理:现有 schema 上 `users.id`(text)与本地 integer 列类型从不匹配 → FK 本来就从未加上 → 修改在所有既往成功路径上 no-op-equivalent,仅把漂移路径的 42804 crash(`EXCEPTION WHEN duplicate_object` 接不住)变成同样的安全 skip;已应用环境按名跳过永不重跑
- **Bug 2** `zzzz20260411120100_…`:吞错 `.catch(() => undefined)`(任何失败毒化事务 → 下一语句 "current transaction is aborted")→ 换成 repo 既有 precedent 的 `pg_constraint` 存在检查 `DO $$` guard;终态等价(两 FK 仍到位),零吞错

**验证:** 空 PG16 全链 replay exit 0(`Applied: 237, Pending: 0`);7 张触及表 `\d` 终态与修前成功基线逐一比对一致;guard 手工重放 2-3 次(含约束预存在)幂等;CI migration-replay 配方(同 EXCLUDE、双跑)绿;**额外证明:把 `20250925_create_view_tables.sql` 从 exclude 摘除后双跑也绿**——CI 绕过的根因已修,摘除动作留作独立 maintainer 决策(workflow 未动);`tsc --noEmit` 干净。

**额外发现(记录不修,出界):** `MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL=true`(默认关的调试旗)下,`20250924120000_create_views_view_states.ts` 先撞 uuid/text FK(legacy 051/052 SQL 建的 `views.id` 是 text)。

## 3. 目标池余量

至此 Global History 线在可建范围内**再次清空**:read 面(含 T1b)完整、写面全部建成且 default-off、harness/runbook/goldens 齐备。余量与第 1 轮 MD §5 完全一致 = owner 决策菜单(per-flag 启用、T-source、破坏性 tier FE、4c 逐项签核、4d 不可能项),外加 2 个新的可选 maintainer 决策:① migration-replay exclude 摘除;② legacy-SQL 调试旗下的 uuid/text FK(修/弃)。

## 4. 值守纪要(本轮期间)

#3612 P1 TOCTOU 修复(confirm-time fingerprint 复查 + 2 条 mutation-proven golden)随 PR 合入 `2031b8b3b`;#3610/#3597 auto-merge 按 owner 指示解除,#3597 经 30 分钟哨兵确认稳定 disarmed;#3611 审阅 APPROVE-as-DRAFT 交 owner 定时机;#3577 决策菜单原样。
