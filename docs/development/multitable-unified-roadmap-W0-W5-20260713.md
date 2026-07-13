# 多维表统一路线 · W0–W5(owner 定线 2026-07-13)

**类型**:路线图 / 规划真源(docs-only,零 runtime)。
**地位**:**本文取代**「后端 / UI / AI 各自排队」的分头规划,成为多维表线的**单一执行真源**。既有各子系统的 design-lock 仍是各自的技术合同,但**排期与波次以本文为准**。
**来源**:owner 2026-07-13 定线指令(逐字采纳,见 §7)。**本文零裁决**——所有仍需 owner 拍板的项在 §6 明列。

---

## §0 一句话

把多维表统一成一条路线:**可信数据底座 → 飞书级工作台 → 业务应用化 → 受治理 AI → 分档启用**。先把「可信」做实(W0),再谈观感与能力。

---

## §1 波次总表

| 波次 | 目标 | 主要开发内容 | 完成标准 |
|---|---|---|---|
| **W0 可信性** | 任何历史、权限、CI 结果都可信 | ratify #4187;分批补齐 8 类 revision 写入口;`HISTORY_INCOMPLETE` preview/execute 共用预检;revision-disposition 守卫;修第 4 个红 web spec、7 个隔离 spec、全量 workflow 清单;回收站保留策略 | **不存在无 revision 的权威数据写**;**历史不完整时恢复零写入**;**每个 spec 属于明确 CI lane** |
| **W1 信息架构** | 从技术控制台变成业务工作区 | UI 术语映射;P2-2a 左栏抽取;P2-2b 数据表/视图树;P2-2c 响应式;高级管理动作收入「设置/更多」 | 5 秒识别 工作区/数据表/视图;1024px 无溢出;主操作 ≤ 7 个 |
| **W2 记录工作区** | 围绕一条业务记录完成工作 | T5 决策;统一右侧检查器;详情/评论/动态/审批/历史合一;字段分区、空字段折叠;PIT Revert UI;历史授权 UI | 普通编辑无需离开当前视图;危险动作(删除/恢复)有预览 + 明确确认 |
| **W3 业务应用化** | 隐藏底座,面向角色提供业务页面 | 搭建模式 / 使用模式;角色化首页;表单/仪表盘/审批/自动化成为导航节点;W3-6 dashboard widgets;移动端记录详情 | 一线用户不接触 Base/Sheet/API;管理员仍能进高级设置 |
| **W4 受治理 AI** | AI 从功能按钮变成业务协作者 | S3 陈旧度血缘;S4 成本可见性;S5 normalize;L0.5 租户 live gate;右侧 AI 工作区;修改预览 / 成本 / 来源 / 审批 / 撤销 | AI 不允许无预览写入;成本与来源可见;租户级 cap + kill-switch 生效 |
| **W5 启用** | 把已开发但默认关闭的能力安全上线 | T9-W、PIT Reset/Undelete、permission-revert 等**逐 flag** smoke;并发 TOCTOU;监控 / 回滚 / 运行手册 | 每个 flag 独立验收、独立回滚,**不做「一键全开」** |

## §2 执行顺序(owner 指定)

1. **先裁 #4187,完成 W0。**
2. 立即进入 **P2-2a/b/c**,解决用户第一观感。
3. 统一**记录检查器**与**应用模式**。
4. 并行开发 **S3 / S4 / S5** 和 **W3-6**。
5. **L0.5** 完成后再做 **AI canary**。
6. 最后逐项启用已有默认关闭能力。

---

## §3 两条不变量(owner 划定,贯穿全程)

1. **Base / Sheet / recordId 继续作为后端和 API 的稳定合同,不重命名。** 任何 UI 术语映射发生在**展示层**,不动数据模型、不动 API 契约。
2. **普通 UI 只显示「工作区 / 数据表 / 视图 / 记录」。** 底层 ID、API、配置历史**只在管理员高级设置**出现。

> 落地含义:W1 的「UI 术语映射」是一张**展示层词典**,不是重构。`baseId`/`sheetId`/`recordId` 在代码、路由、API、config-history 里原样保留。

---

## §4 W0 是硬门:先做实「可信」,再谈其余

W0 之所以排第一,是因为**上面每一层都建立在「历史可信、权限可信、CI 可信」之上**——底座撒谎时,做得越漂亮越危险(W2 的恢复 UI 会把编造的历史当真、W4 的 AI 会基于污染的历史做决策)。

### §4.1 W0 的安全脊柱:`HISTORY_INCOMPLETE` 零写入预检(owner 2026-07-13 新增)

**问题**:8 类 `meta_records` 写入口里有若干**不写 revision**(见 §4.2)。在它们全部补齐之前,历史会有「洞」。而恢复类操作(sheet revert / reset / PIT)以 `reconstructRecordsAtT` 为读原语——**基于有洞的历史执行写操作 = 可能静默回滚成员的真实编辑(已实测,不可恢复,见 #4187)**。

**owner 裁定的机制**:preview 与 execute **共用一个预检**;检测到相关范围历史不完整时——

- **preview**:明确标注 `HISTORY_INCOMPLETE`,不承诺能忠实恢复;
- **execute**:**零写入**(fail-closed),拒绝在不可信历史上动手。

这条**先于** 8 入口补齐落地就能保护现存数据,是 W0 的第一道闸,不是 8 入口修完的副产品。

### §4.2 8 类 revision 写入口(#4187 gate-front 实证的那一类)

`meta_records` 的写路径里,以下**不写 revision**(D-1 当年只补了 side-door 的**删除**半边)。**实测复现 2 个**(表单提交 EDIT、plugin-SDK `patchRecord`),**源码核实 6 个**(automation `update`/`create`、plugin `createRecord`、form-submit CREATE、approval `resultWriteback`、attachment-delete cell-strip)。owner 路线的完成标准「不存在无 revision 的权威数据写」= **8 个全补,分批**。

### §4.3 revision-disposition 守卫

本线已有「每个 `meta_records` 变更点必须声明 **lock** 处置」的 rank-8 守卫。W0 增一条对称的:**每个 `meta_records` 变更点必须声明 revision 处置**(写 / 显式豁免 + 理由)。**两个诚实的警告**(#4187 gate 提出):① rank-8 的 regex 忽略 `INSERT`,revision 守卫必须覆盖 INSERT;② 「revision-豁免」比「lock-豁免」判断更模糊,是它中心的真问题。⚠ **顺序**:守卫要等 8 入口补齐后才能落,否则它会把 8 个未修点标成违规、CI 长红——所以守卫是 W0 的**收尾**,不是开头。

### §4.4 CI 可信(不需裁决,已开工)
- 修第 4 个红 web spec + 隔离 spec 分诊(车道在跑)。
- **全量 CI-lane 清单**:每个 spec 归属唯一 lane,消灭「被触发但不跑 / skip-green」(车道在跑)。
- 完成标准「每个 spec 属于明确 CI lane」以该清单为验收基准。

---

## §5 已就绪的下游(各波的 buildable 锚点)

> 这些不是「现在就做」,而是标明**每波开工时手上已有什么**,避免重复造。

- **W1**:P2-2a/2b/2c 结构刀(锁已在);UI 术语映射(展示层词典,§3 约束)。
- **W2**:T5 决策(brief 已备 = #4175);PIT Revert 能力**已上线、无 flag、零 UI**(F1);history-audit-grant 能力已上线、**目前只能裸 HTTP 签发**(F4)。
- **W3**:W3-6b/6c dashboard widgets(锁已在);automation 整次重试无 UI(其兄弟 resume 有 UI)。
- **W4**:S3 血缘 / S4 成本 / S5 normalize / L0.5 租户 gate(各自锁已在;S3 存储门已满足)。
- **W5**:7 个默认关闭 flag 的逐档 smoke——**PIT_RESET 的 STOP-SHIP 门 = 保持 `MULTITABLE_META_REVISION_RETENTION_ENABLED` 关闭**(owner 勘误 2026-07-13:该门是这个**真实存在的 revision-retention flag**,不是一个尚不存在的 trash sweep;回收站 v1 = 无限期保留、无自动清理,见 G-8)。

---

## §6 owner 决策台账 — ✅ G-1..G-10 全部已裁(2026-07-13)

> 原「仍需 owner 拍板」表保留问题框架;裁决如下,**逐字为准**。

| # | 裁决(owner 2026-07-13) |
|---|---|
| **G-1..G-7** | **随 #4187 一并裁定并 RATIFIED**(post re-review):OD-1=全量 A1–A8 分 **5 独立 slice**(form→plugin→automation→approval→attachment);OD-2 source=写入入口(form=`public-form`/plugin/automation/approval/**attachment**);OD-3 已知 actor 必写、匿名 CREATE=null、禁伪 system;OD-4 link-edge history=独立锁(标 UNSOLVED);OD-5 前向、禁 backfill;OD-6 守卫独立 slice、**最后落**、须可靠扫描+稳定 site ID;§0.6 `HISTORY_INCOMPLETE`=**先行独立实现**,execute=零写入,goldens 门=**对应 runtime 合并前**(非 ratify 前)。既有 R13 lane PR(#4216/#4219/#4220/#4227)保持 **Draft 不合不 rebase**,按 owner 逐 PR 修正后按五刀回收(**(b) 三车道交付不接受**;#4216 须 concurrent-delete fail-closed+golden)。 |
| **G-8** | **v1 = 无限期保留、无自动清理**。未来有限期清理**另立设计锁**。同时勘误文档:PIT_RESET 的真实门 = 保持 `MULTITABLE_META_REVISION_RETENTION_ENABLED` 关闭,**不是**一个不存在的 trash sweep(本文 §5-W5 行已同步勘误)。 |
| **G-9** | **T5 已裁**(见 `…t5-recorddrawer-decision-brief…` §3.5):OD-T5a/b/c=A、OD-T5d 放行;T5-safe 已实现落地(#4223);comment-affordance 锁已 RATIFIED(OD-CA-1=A 琥珀三元组 / OD-CA-2=A Grid 蓝属漂移收敛 / OD-CA-3=B 先 token+一致性、Drawer 迁移另开小刀)。 |
| **G-10** | **术语词典定稿**:产品名=**多维表**;Base=**工作区**、Sheet=**数据表**、View=**视图**、Record=**记录**。**底层 API/代码仍保留 Base/Sheet/recordId**(§3 不变量 1 不动)——映射只在展示层。W1 术语映射据此可开工。 |

**红线不变**:#4187 等一切设计锁**由 owner ratify**,我只机械记录你的裁决,绝不自裁;flag 生产启用是 W5 的独立运维阶梯,永不「一键全开」;AI L1 / C 簇路 2/3 在各自 owner 门前不动。

---

## §7 owner 定线原文(逐字存档 2026-07-13)

> 建议把多维表统一成一条「可信数据底座 → 飞书级工作台 → 业务应用化 → 受治理 AI → 分档启用」路线,不再按后端、UI、AI 各自排队。
> 推荐执行顺序:先裁 #4187,完成 W0;立即进入 P2-2a/b/c;统一记录检查器与应用模式;并行开发 S3/S4/S5 和 W3-6;L0.5 完成后再做 AI canary;最后逐项启用已有默认关闭能力。
> 两个边界:Base/Sheet/recordId 继续作为后端和 API 稳定合同,不需要重命名;普通 UI 只显示「工作区/数据表/视图/记录」,底层 ID、API、配置历史只在管理员高级设置出现。

---

## §8 本文不主张什么

- 不主张任何波次已完成。~~「W0 未开工等 G-1」~~ → **2026-07-13 起 G-1..G-10 全部已裁**(§6):W0-CI 半已收(#4213/#4217),§0.6 实现已开工;5 slices 等 §0.6 落地后按序开。
- ~~「倾向待确认」~~ → §6 现在记录的是 owner 裁决本身,不再是我的读法。
- 不主张改动了 Base/Sheet/recordId 契约——恰相反,§3 把不重命名钉为不变量。
- 不主张 flag 会被打开——W5 逐档、独立回滚,永不一键全开。
