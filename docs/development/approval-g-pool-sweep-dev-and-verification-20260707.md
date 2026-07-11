# 审批线 G 池清扫（wave-A）+ as-built 对账 · 设计与验证 MD — 2026-07-07

> `/goal`「以审批及流程自动化线余下开发为总目标池」的本波收官交付。方法：ultracode 多路盘点
> （4 代理并扫 docs 余项 / GitHub 开放面 / 记忆断言裁决 / 收官菜单差分）→ 真池裁定 → 无 gate
> 项并行清扫 + design-lock-first 项立锁 + 漂移对账。

## 1. 盘点结论（真池裁定）

- **记忆三断言全过期并已修正**：T3-5/T1-4 实为 SHIPPED（#3506/#3505）；PR-A₂/PR-B 实为
  LANDED（#3620/#3641/#3650）；W1-3 write-gate 实为 FIXED（#3676）。真尾巴 = T1-4b 与
  T3-5-FU（均 gated）。
- **真池** = 19 个 batch-2 G 项（§7.2 锦上添花，无 gate）+ B3-05/06（§7.4 定位高于打磨，
  design-lock-first）+ 5 处文档漂移；其余全部 gated-needs-ratify / blocked-on-owner，纪律性不碰
  （B-0 一键卡片 Slice B、T36-3、T3-2 日历 SLA、T3-3 强制、移动 later-slices、A3 egress 授权等）。
- 清扫中又核出 **2 处池账虚项**：G-B2-02 已在 #3640 落地（benchmark 表未翻转）、G-B2-20 已在
  #3804 落地——池账 −2。

## 2. 本波交付（7 件）

| 件 | 内容 | 验证 |
|---|---|---|
| #3804 | M1 尾巴：StatusTag forceLocale（6 个纯中文 admin 视图钉 zh）+ 管理员委托双选人器 | 180/180 + forceLocale 变异 RED |
| #3810 | 5 处 checklist 漂移 as-built 翻转（一键锁 A-1..A-4/A-5 拆分、participant-directory D-1/2、canvas D-0、T3-6 ballot HELD 超越注记、joinMode-any 追认挂账）| docs-only，逐处 PR 号溯源 |
| #3813 | **B3-05/06 路由预览 design-lock（PROPOSED）**：预览=真实创建管线只读切片、零写构造、preview===create 一致性金测、RP-1..3 阶梯 | 等 owner ratify |
| #3819 | G-B2-19 条件人话摘要：纯函数 conditionSummary（操作符全词表与 conditionEdit 锁步）+ 四表面（authoring 摘要/编辑器分支头/NewView 流程预览/DetailView upcoming）| 161/161 + 且/或变异 RED |
| #3825 | G-B2-09/10：时间线 cc→抄送 + 首字母头像；成功处理后「下一条 →」（点击时计算、排除刚处理单、深链空列表不渲染）；**顺带修真潜伏 bug**：detail→detail 参数导航不刷新（onMounted 抽 loadDetailPage + watch）| 61/61 + exclude-current 变异恰红 2 |
| #3827 | G-B2-14 草稿自动保存（storage 注入纯 helpers、schema 签名漂移守卫、附件永不入草稿、prefill 优先、提交/丢弃即清）+ G-B2-16 金额大写（分制整数运算、跨组零全规则、声明总额字段专属不猜标签）| 6/6+6/6+104/104 + 签名守卫变异 RED |
| 本 MD | 收官设计与验证记录 | — |

全部：vue-tsc 0 · 生产 build 绿 · lint 绿 · UF-6 风格守卫绿 · 两点 CI 接线 · push 回读验证。

## 3. 设计要点（沉淀口径）

- **不猜语义**：金额大写只挂模板声明的 `amountConsistencyCheck` 总额字段；草稿签名只认字段
  id:type 集合；条件摘要遇未知操作符/缺 label 诚实回退原文——G 池的「锦上添花」也守 fail-safe。
- **prefill > draft**：再次提交预填是显式意图，草稿恢复让位（同表单两个"帮你填"机制的优先级
  已钉死）。
- **点击时计算**：「下一条」目标在点击瞬间从 store 现值算（列表随时变，缓存即误导）——与路由
  预览锁的「绝不缓存」同一条原则。
- **params 导航必须显式 reload**：router 复用组件实例，onMounted-only 的 detail 视图在
  params-only 跳转下必然脏——本波修掉一处，此模式列入 review 检查项。

## 4. 流程事实（不粉饰）

- **限量三杀三顶**：三个 Sonnet 实现代理先后阵亡于 session 限量（均在 grounding 早期、worktree
  干净），主循环直接接管实现全部 6 个切片——模型回退口径（Fable 不可用→Opus，不降级）同日由
  owner 固化。
- 盘点的价值再证：本波 8 处「文档说没做、实际已落地」（3 记忆断言 + 5 checklist + 2 池账虚项，
  部分重叠）——**每次开工前的 as-built 盘点不是仪式，是防重复劳动的硬门**。

## 5. 余下池（后续波次菜单，非分母）

- **wave-B（无 gate G 项，13 个）**：B2-06 线性脊柱插入 / B2-11 刷新 pill / B2-12 催办状态 /
  B2-17 requester 画廊 / B2-18 目录选择器 / B2-21 发起人预览 / B2-22..27 自动化编辑器打磨组。
- **等 owner**：#3813 ratify（RP-1..3 解锁，fusion 优先）· A-5 真钉钉 UAT · joinMode-any 追认 ·
  T0-1 部署签收 · A3 egress 目的地授权 · merge queue。
- **gated**：B-0/B-1..4、T36-3、T3-6-REAUTO/FORM、T1-4b、T3-5-FU、T3-2、T3-3-ENF、移动 later
  slices、B3-01..14 各自 opt-in。

---

**一句话**：先把账盘真（8 处虚账清零），再把无 gate 的池一波清干净（6 切片全带变异级验证），
把该立锁的立成 PROPOSED（路由预览双件）——审批线的「余下」从模糊清单变成三栏干净台账：
本波已清 / 等 owner 口令 / gated 待 ratify。
