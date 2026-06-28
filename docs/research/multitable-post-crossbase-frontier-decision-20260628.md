# 多维表 — cross-base 弧收工后的前沿状态 + 下一弧决策图 — 2026-06-28

> Status: **决策输入 / 状态note**(内部对标，可引用飞书）。总目标 `multitable-benchmark-surpass-goal`。
> 本文**不重导** `docs/research/multitable-vs-feishu-benchmark-refresh-20260627.md`（那份是能力面全取证 + web 核验，仍是底账）；
> 本文只做一件事：在 cross-base 做深弧（候选 A）**已收工**后，刷新"还剩什么、各自什么门、推荐先开哪个"，并把决策交回 owner。
> 取证根：originally grounded at `b3ac8c692`；rechecked against `43ef71ed9` / 当前 `origin/main`——自动化触发器清单（§2）firsthand 复核于代码、仍无 date-field 相对触发原语，结论不变。验证遵循既有纪律（verify-against-main → 权限敏感处 fail-first leak gate → 全量非 watch 套件 → real-DB goldens）。

## 0. 一句话结论

**非 gated、无需产品决策即可建的前沿已经空了。** cross-base 做深弧是"最后一条不需要 owner 拍板就能开"的弧，已合并 + 验证。
现在所有"剩余未做项"都落在三类门后：**owner-decision（需一句 GO）**、**security-DARK（默认关有安全理由，逐项 staging-first，绝不 sweep）**、**parallel-owned（其它 session 在推）**。
所以"完成所有（在范围内、非 gated 的）开发"——**已经达成**。下一步不是"继续建"，而是 owner 在下面的 forks 里点一个。

## 1. 候选 A（cross-base 做深）已收工 — 不重测，指向既有验证

06-27 refresh 推荐的主弧 = A。本轮已全部落地到 `origin/main`，各自带 dev/verification MD（不在此重跑）：

| 子项 | PR | 落地 | 验证 MD |
|---|---|---|---|
| (b) 跨 base 条件关系聚合 `#PERM!` 修复 + 路由化 | #3300 | merged | `docs/development/multitable-crossbase-relagg-perm-fix-dev-verification-20260627.md` |
| (c) 悬挂边引用完整性（repair-on-read + sheet-delete cascade） | #3306 | merged | `docs/development/...dangling-link-repair-dev-verification-20260627.md` |
| (a) 只读跨 base mirror v1（lift twoWay 跨 base 拒 + base-read 遮罩 + push defer） | #3312 | merged `b3ac8c692` | `docs/development/multitable-crossbase-readonly-mirror-dev-verification-20260627.md` |
| (d) 跨 base 视图按外字段 live 筛排 | — | **定论不开发** | 物化 lookup/rollup/link 筛选已跨 base 可用 + 遮罩；live 外遍历会重新引入 match-count/排序 oracle |
| 弧收口 | #3308 | merged | cross-base deepen arc closeout + sheet-permissions CI-invisible debt 显式化 |

> (a) 的 v1 边界仍然成立且已写进代码/MD：**不引入 editable mirror、不接 `evaluateCrossBaseWrite`、不做跨 base realtime push**（read-time 现算 + 遮罩）。这三者是各自独立治理的后续，不在本弧。

## 2. 剩余前沿（post-A 重排）— 逐项门状态

> 图例：OWNER=需产品决策一句 GO · DARK=代码全但默认关（安全/成熟度，逐项 staging-first） · PARALLEL=其它 session 在推 · BIG=独立大工程

| 候选 | 项 | 价值 | 门 | 备注 |
|---|---|---|---|---|
| C 头部 | **日期提醒**（按记录日期字段提前 N 天触发） | 高（飞书有"截止前 N 天"，我们**无任何日期触发原语**） | **OWNER**（便宜、新触发原语 → flow-governance 需求门：命名用例=飞书 deadline 提醒对标） | 已核验当前 main **仍 ABSENT**（firsthand 复核代码）：自动化规则触发器 = `record.*`(created/updated/deleted) / `field.value_changed` / `schedule.cron` / `schedule.interval` / `webhook.received` / （后端，编辑器未暴露）`form.submitted`；`comment.created` 属 webhook/订阅/realtime 体系、**非**自动化规则触发器；无任何 date-field 相对触发 |
| B 便宜档 | 暴露 BACKEND-ONLY UI（`delete_record`/`start_approval` 动作、`form.submitted` 进编辑器） | 中（点亮已建） | **OWNER**（每个暴露=flow-governance 需求门，需命名用例） | 能力后端就绪，缺编辑器入口 |
| B 便宜档 | 死 `/dashboard/query` 清理 · 原子批量删端点 · 真 cron 解析器 · `webhook.received` 入站入口 | 低-中 | **OWNER**（含 API 消费者移除风险 / 入站=安全面） | 非"干净免费"，advisor 提醒清理仍带消费者移除风险 |
| B DARK | 配置恢复 Tier1/2、PIT Reset（+接孤儿 `ResetConfirmDialog.vue`）、行级读权、AI、Yjs | 高 | **DARK**（默认关有安全理由） | **逐项 staging-first acceptance-harness 放量，绝不一键 sweep** |
| C | API 写回（把 INERT 写 scope 接上 token 可达路径） | 高（企业集成） | **OWNER**（写路径=安全 + 配额决策） | 飞书服务端 API 读写全；我们只读 |
| C / 飞书强项 | 实时共编 productionize（Yjs DARK→GA） | 高 | **PARALLEL + BIG** | POC 范围窄（逐记录、不含 create/delete/字段权限），productionize 是独立大弧 |
| C / 飞书强项 | 模板平台（存为模板/市场/分享）、移动端 | 高 | **BIG** | 各自独立大工程，本轮不建议 |
| 图表 | 词云/雷达/地图/电池/排行榜 + 多数据源（§A web-verified 飞书略领先） | 中 | **OWNER** | 真落后项，但属增量补齐 |

**净**：没有"非 gated 且无需决策"的可建项了。最便宜、最干净的**对标补齐** = 日期提醒（新原语、非安全、飞书有我们无）；最便宜的**成熟度收益** = B 便宜档的"点亮"（但每个走需求门）。其余要么 DARK（逐项放量）、要么大工程、要么 parallel-owned。

## 3. 推荐（净）

1. **若要继续推对标，先开「日期提醒」。** 它是剩下最便宜、最干净的一条：飞书有、我们 0 原语、非安全敏感、自包含、fail-first 容易（触发时机 golden）。命名用例（飞书 deadline 提醒对标）即满足 flow-governance 需求门；治理门=继承既有自动化触发 substrate。**这是我推荐的下一条轻量弧。**
2. **B 便宜档的"点亮"可作并行快弧**，但**逐项**走需求门（每个暴露的动作/触发要有命名集成用例），不是一键全亮。
3. **刚建的配置恢复 Tier1/2 等 DARK 项**：如果你想把它们从 DARK→可用，那是**逐项 staging-first 放量**决策，不混进任何对标弧。
4. **大工程**（实时共编 productionize / 模板平台 / 移动端 / API 写回）= 各自独立弧，需单独立项，本轮不开。

## 4. 待 owner 拍板（post-A 更新版）

1. 下一条轻量弧 = **日期提醒**？（推荐）确认就开（设计锁 → 触发原语 + 调度 → fail-first 触发时机 golden → real-DB → PR）。
2. B 便宜档要不要并行插一两个"点亮"？要的话点名哪个动作/用例（走需求门）。
3. 配置恢复 Tier1/2（DARK）要不要排 staging-first 放量？
4. 还是说：**本轮就此打住**，对标账记到这，等具体业务需求再点 fork。

## 5. 方法/纪律声明（为什么是"摆 forks"而不是"自动开建"）

`/goal` 我读作 **standing 指令**（持续"完成剩余开发"）。但按你反复确立、我也记在 memory 的规矩——**`/goal` 不等于对 gated / owner-deferred / security-DARK 项的解封许可，应 surface forks、不静默自启**——加上你本轮刚说的"剩余未做项**都不是本弧开发范围**"（即你自己也把它们定位成下一弧 forks），所以本文**只摆决策、不自动开建**任何 §2 项。
非 gated 的开发本轮确已做完（cross-base 弧）。要继续，就在 §4 点一个 GO，我立刻按既有纪律开做。
