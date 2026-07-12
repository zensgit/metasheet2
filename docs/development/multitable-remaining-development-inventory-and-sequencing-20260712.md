# 多维表线 · 剩余开发总盘 + 排序 + 并行车道(2026-07-12)

**类型**:盘点与排序(docs-only,零 runtime)。
**方法**:三条**只读**审计车道并行,全部对着 **`origin/main` 已落地代码**核验(`db2eb8a57`),**不看任何脏 WIP**、**不信任何文档头部**——头部与代码不符时,**以代码为准**并记为发现。
**触发**:owner /goal「审阅多维表开发代码及目标文档,还有哪些未开发,排剩余开发顺序」。

---

## §0 一句话结论

**这条线的缺口,主要不是「没写的 runtime」,而是「文档系统性少报了已经上线的东西」+ 一批「已授权但没建」的切片。**

三条审计合起来:**零个虚假的「已完成」声明**——所有文档错误都是**反方向**的(说没做,其实做了)。这个方向本身是安全的(不会让人误以为有防护),但它有两个真实代价:① 已授权的活被误当成 gated,**没人去做**;② 有些**已上线**的能力没有对应的验证记录,**没人在看它**。

**同时:`origin/main` 此刻正带着 3 个红的多维表 spec,而 CI 结构性看不见它们。**这是全盘最急的一条。

---

## §1 🔴 最急:CI 在谎报(两个独立的洞,都不需要 owner 决策)

| # | 洞 | 实证 | 状态 |
|---|---|---|---|
| **G1** | **159 个多维表 `apps/web` spec 跑在零个 workflow**。其中 **3 个此刻在 main 上是红的**——包括 `multitable-comment-inbox-realtime.spec.ts` **在收集阶段就失败(零个测试执行)**;另有 `multitable-client.spec.ts:786`(客户端契约变更**带着红 spec 上线**)、`multitable-comment-affordance.spec.ts:137` | 审计代理实跑全部 159 个(正控:`multitable-grid` 62 ✓) | **车道在跑** |
| **G2** | **19 个真库 spec 被收在「无 DB」步骤**(`plugin-tests.yml:144`;Postgres 到 `:167` 才起)⇒ 在**必需的 `test (20.x)`** 里走 skip 分支 = **绿,但零断言**。其中 **6 个属多维表 = 67 个测试从未执行过一次** | 实跑 67/67 全过,且不碰被排除的 `views` 簇 ⇒ **今天就能干净接线** | **车道在跑** |

**尖锐子案(值得单独记住)**:`meta-record-labels.ts`(i18n 单一真源)**是** web-guard 的 path-trigger,但**它的 spec 不在任何 run-list 里**。于是:你改了它 → 门禁触发 → 跑了约 50 个**别的** spec → **绿** → **从未跑过你改的那个文件的 spec**。
⇒ **「被触发」≠「被验证」。两点接线必须两点都验,只验一点等于没验。**

---

## §2 ✅ 已授权但没建(RATIFIED but UNBUILT)——**现在就能开工,不需要任何 owner 一句话**

> 判据:锁已 RATIFIED **且**该锁自身的解锁阶梯对这一格是开的。
> ⚠ **RATIFIED ≠ 全部可建**:部分锁明写「**ratify 本锁 ≠ 解锁 A,每一格独立 owner opt-in**」——那些格子仍是 gated,见 §3。

| # | 项 | 规模 | 备注 |
|---|---|---|---|
| **A1** | **UI-P2-1c tail 剩余**:T1 尚有 **10 处在锁枚举范围内的 close-×** 未迁;T4 的 **8 个 manager 里 6 个 `MtButton` 用量仍为 0** | 中 | **本轮已在做**(#4178 / #4180) |
| **A2** | UI-P2-2a 左栏抽取 | 小-中 | 结构刀,与 P2-1c 不冲突 |
| **A3** | UI-P2-2b / 2c 布局 | 中 | 依赖 A2 |
| **A4** | **W3-6b / 6c 仪表盘 widget** | 小-中 | 独立,可并行 |
| **A5** | **S4 AI 成本可见性** | 中 | **无迁移**;注意:属 AI 线但**不是** L1 点亮,不碰 owner 红线 |
| **A6** | **S3 陈旧度血缘** | 中 | 其存储闸门**已满足**——锁自己写明「Ratifying this lock = greenlighting that one narrow table」 |
| **A7** | S5-1 per-kind normalize | 中 | |
| **A8** | L0.5-1 租户 live gate | **大 · 安全面** | **须 Opus 对抗审前置** |
| **A9** | **B-系列小修**(见 §5) | 小 | 前端审计挖出的一串 |

---

## §3 🔒 卡 owner 的(**只等一句话,不等代码**)

| # | 决策点 | 我的建议 | 出处 |
|---|---|---|---|
| **D1** | **T5 · MetaRecordDrawer 的 toggle / glyph 处理**(OD-T5a..d) | **拆两半**:4 个零发明按钮现在迁;watch toggle 与 comment 按钮各留一票 | `…t5-recorddrawer-decision-brief-20260712.md`(#4175) |
| **D2** | **PIT Revert 的 UI**(能力**已上线、无 flag**,却**零前端入口**;而它的兄弟 Reset 是 flag-gated 却**有完整 UI**) | 要不要建 UI?若建,挂哪个 flag? | 前端审计 F1 |
| **D3** | history-audit-grant 的 UI(4 条路由,capability-gated 且**无 admin 绕过** ⇒ 目前**只能靠裸 HTTP 签发**) | 治理决策 | 前端审计 F4 |
| **D4** | `variant="plain"` 的裁定是否**外推**到剩余 6 个 `__btn-inline` sharer | 建议外推(否则同 class 两种外观) | 前端审计 |
| **D5** | **表单提交「编辑」分支不写 revision**(见 §4)——修不修?`source` 用 `'public-form'`?是否**顺带重开**锁里推迟的 CREATE 半边? | 建议 **EDIT-only 先修**,CREATE 维持推迟 | 后端审计 P1(one-pager 单独提) |
| **D6** | 回收站保留期(`meta_records_trash` **永不清理**——只在 restore 时 DELETE 一次) | 需要一条保留策略 | 后端审计 P3 |
| **D7** | 若干「每格独立 opt-in」的格子:跨页分组、非网格物化、S1b | 逐格 opt-in | 各锁自身阶梯 |

**不动的(owner 明令)**:AI L1 点亮 · C 簇路 2/3 · O-2 生产启用 · 4d(**物理不可能**,不是活)。

---

## §4 🔴 后端 P1:历史链中间有个洞(**已派 gate-front 车道,零 runtime**)

**已认证的表单提交「编辑」分支**直接 raw-`UPDATE` `meta_records`,`version` 1→2,**不写任何 revision**。真库实证:活行 = `v2-edited-via-form`(version 2),而 `reconstructRecordsAtT` 返回 `v1-original`(version 1)。

`reconstructRecordsAtT` 是 **restore-preview 与 PIT 视图**的读原语 ⇒ **运维在恢复预览里看到编辑前的值,点确认就静默回滚掉成员的编辑**。

**必须分清的区别**(这决定了它是不是能自主修):
- D-1 锁 §5 **显式推迟**的是 public-form 的 **CREATE** 覆盖 = 「历史缺个**头**」;
- **EDIT 这一半任何文档都没提过** = 「历史链**中间有洞**,而且历史在**撒谎**」。

因为它落在锁**刻意推迟**的子系统里,**不自主实现**;走 gate-front:真库复现 + 可一句话 ratify 的 one-pager。

**同类系统性缺口(建议一并考虑)**:本线已有「每个 `meta_records` 变更点必须声明 **lock** 处置」的守卫(rank-8),但**没有**对应的「必须声明 **revision** 处置」守卫。有了它,这一整类洞都不可能再出现。

---

## §5 前端审计的其余发现(全部 buildable,无需 owner)

| # | 发现 | 规模 |
|---|---|---|
| **B1** | 修 main 上 3 个红 spec(**先诊断再修**:产品错就修产品,不许为了绿而删断言) | 小 |
| **B2** | 把 5 个**突变已证有效**的安全 spec 提升进 workflow(逐个 neuter 其**源**,5/5 全红 ⇒ 确非空测) | 小 |
| **B3** | 补 web-guard 的 path-trigger 洞(见 §1 尖锐子案) | 小 |
| **B4** | **只读谓词漂移**:服务端 `isFieldAlwaysReadOnly` 认 `property.mirrorOf` / `property.readOnly`,而 FE 的 `MetaGridTable.isEditable` / `MetaRecordDrawer` **从不读 `field.property`**(`mirrorOf` 在整个 `apps/web` 里 **0 命中**)⇒ **镜像 link 单元格渲染成可编辑,保存时报错** | 小 |
| **B5** | **i18n 真 bug**:`MetaRichLongTextEditor.vue:161-162` 的 `ariaToolbar`/`ariaContent` **无条件是中文** ⇒ **英文环境的读屏器念中文** | 小 |
| **B6** | strict-zero 的**源码扫描守卫**目前**根本不存在**(17 个 i18n spec 里 15 个跑在零 workflow) | 中 |
| **B8** | automation **整次执行重试**无 UI(其兄弟 *resume* 有完整 UI) | 中 |

**审计代理自己否掉的两个候选**(值得记,因为它证明了这轮不是在凑数):`AutomationExecutionsView` 的 "retry" 看着像 stub,实际在 `v-if="loadError"` 里 = 合法的「重载」;B4 曾被怀疑该升 P2(若 ExtAPI/plugin-SDK 能造出这种字段),**实跑核查后反向**——`OAPI_WRITE_ROUTES` 是 5 条的 lockstep 白名单、**不含** `POST /fields`,plugin SDK 也无建字段能力 ⇒ 只能靠手工 session 请求或 SQL 造出,**维持 P3**(哪天双向 link 编辑 UI 或只读开关上线,当天升 P2)。

---

## §6 排序与并行车道

**排序原则**:先让**看得见**(CI 谎报 → 修红),再做**已授权**(不需要等人),最后把**卡 owner 的**推到「只差一句话」的位置。

| 波次 | 车道(可并行) | 依赖 |
|---|---|---|
| **W1(急)** | ① 修 3 个红 spec + 接线 · ② 接线 6 个从未执行的真库 spec(67 测) | 无 |
| **W2(在做)** | ③ T1 剩余批次(#4178/#4180 + 后续)· ④ 表单-edit revision one-pager(gate-front) | 无 |
| **W3** | ⑤ B4 只读谓词 · ⑥ B5 中文 aria · ⑦ B2 安全 spec 提升 · ⑧ B3 门禁洞 | W1 落后更干净 |
| **W4** | ⑨ A4 仪表盘 widget · ⑩ A6 S3 血缘 · ⑪ A5 S4 成本可见性 | 互不相干,可三路并行 |
| **W5** | ⑫ A2/A3 P2-2a/b/c 结构刀 | 建议等 P2-1c tail 收干净,否则同文件互撞 |
| **W6** | ⑬ A8 L0.5-1 租户 gate | **安全面 · Opus 审前置** |
| **🔒** | D1–D7 | **等 owner** |

**并行安全提醒(本轮实测踩到)**:多条车道同改 `apps/web/scripts/run-required-web-tests.sh` 会撞——它是**一行** `exec npx vitest run …` 的 token 行,**冲突解错会静默丢 token 且 CI 零信号**。**冲突一律解成 UNION**。

---

## §7 本文不主张什么

- **不主张多维表线「开发完了」。** 164 个 raw `<button>` 未分诊;7 个隔离的 workbench spec(92 个失败测试里的 84 个)是**有记录但没解决**;3 个红 spec 在 main 上;§2 的 8 项已授权工作**一项未动**;§3 的 7 个 owner 决策点全开着。
- 不主张任何 flag 被打开,也不建议打开——生产启用是独立的 O-2 运维阶梯。
- 不主张 §5 的「buildable」估算是承诺;规模是审计代理的判断,落地时以实际为准。
- **不主张文档头部可信。** 本文正是因为不信头部才写出来的——凡本文与某份锁的头部冲突,**以本文引用的代码 file:line 为准**。
