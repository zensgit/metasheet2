# 多维表 Cross-base — 治理墙(②a)+ 能力(②b)— 设计锁定 — 2026-06-11

> Status: **DESIGN-LOCK(docs-only,无运行时代码)** · 阶梯 rank 19;owner Q1 决策:baseline 顺推期间并行出此设计供审,**实现等 owner 审过 + baseline 清完**。
> 地基:2026-06-11 cross-base 勘察(8 问,file:line)。两前提已核验满足(D3 golden 进 CI #1827/#1831/#2028/#2044;post-GATE 治理,cross-base 属多维表内核非 integration-core)。
> 总纲依据:§9.3 "权限矩阵稳定 + GATE PASS 双前提" + benchmark §4 Gap 4。

## 0. 范围一句话与关键判断

**勘察颠覆了 cross-base 的性质**:它不是"加功能",而是 **"后端今天已半可达且零治理"** 的安全债 + XL 数据模型变更。因此拆成两阶段,**②a 治理墙必须先于、且可独立于 ②b 启动**:

- **②a 治理墙(enterprise-baseline,先行)**:把"无意中已可跨 base"收口为"显式、受治理的跨 base"——base 级权限原语 + 链接 base 校验 + **跨 base export 掩码修补**。即使永不做 ②b,②a 也应做(它修的是现存安全洞)。
- **②b 跨 base 能力(differentiation,后置)**:在 ②a 的墙之上显式开放 `foreignBaseId` 链接 + 跨 base 自动化,飞书招牌的跨部门工作流(申请→审批→履约 across bases)。

## 1. 承重事实(勘察,实现必须遵守)

| 事实 | 含义 | 出处 |
|---|---|---|
| 链接字段**零 base 边界校验**(`record-service.ts:495` 只按 sheet_id 查存在);`meta_links.foreign_record_id` **无 FK** | 后端今天接受任意跨 base sheetId;"不能跨 base"仅 UI 惯例 | record-service.ts:495-512;db/types.ts:673 |
| lookup/rollup hydration(`applyLookupRollup`)+ FOL-1 传播 + automation `update_record`/`create_record` 全 **base-agnostic** | 有目标 sheet 写权限即可跨 base 操作,无 base 策略 | univer-meta.ts:1825;automation-actions.ts:34-42 |
| **lookup 外表字段级权限缺失**(核验重定位):`applyLookupRollup` 只 gate 外表 sheet 可读,raw 取 targetFieldId 不查外表字段权限 → read/JSON 路径泄漏外表无权字段值;且 formula 物化使"formula 引用跨 base lookup"可被 export | enterprise 安全洞,**同 base 也存在、跨 base 放大**;非 export-via-lookup-列(那条不成立,lookup 不物化) | routes/univer-meta.ts:1843-1860;record-write-service.ts:942(formula 物化) |
| 权限模型 **纯 sheet 级**;无 base 级原语;`workspace_id` 仅咨询性 | ②a 需新增 base 级权限主体 + workspace 边界检查 | permission-service.ts:54-105;migrations…:14 |
| 实时房间 `sheet:{sheetId}` **base-agnostic** | 跨 base fan-out 无需新房间协议(FOL-1 同款失效信号可跨 base 工作) | CollabService.ts:146 |
| base 删除 = sheets.base_id `SET NULL`(无级联) | 跨 base 链接 + base 删除 = 悬挂 meta_links | migrations…:45 |

## 2. ②a 治理墙(锁定设计 — enterprise-baseline,先行)

### 2a.1 base 级权限原语
- 新增 `multitable:base:read` / `:base:admin` 权限码(扩 permission-service.ts 的 code 集,**不动 central RBAC/auth**——多维表内核内);`meta_bases.owner_id` + `workspace_id` 纳入派生。
- **不引入新中间件**:沿用既有 sheet 级守卫,在其上叠加 base 可达性派生(`resolveBaseReadable(req, baseId)`,镜像 `resolveReadableSheetIds` 模式)。

### 2a.2 链接 base 校验(收口"无意可达")
- 链接字段写路径(create/update field + record link 写)新增:`foreignSheetId` 的 `base_id` 必须等于源 sheet 的 `base_id`,**除非**该链接字段显式带 `foreignBaseId`(②b 开放的标志)。无标志的跨 base 链接 → 4xx。**这把现状从"静默可跨"改为"显式才跨"**。
- 不加 `meta_links` FK(避免级联删除风险,见 §2a.4);改在写路径校验 + 提供悬挂清理 ops。

### 2a.3 lookup 外表字段级权限修补(本墙的安全核心 — **核验后重定位**)
> **核验纠正(2026-06-11 fact-check)**:原稿把洞钉在 export-xlsx 经 lookup 列,**不成立**——lookup/rollup 值从不物化(`formula-engine.ts:282`/`record-service.ts:623`/`record-write-service.ts:942` 三处确认),export 路径(`routes/univer-meta.ts:6430-6508`)不调 `applyLookupRollup`,lookup 列导出为空。真漏在**两处别的 sink**,下面两条分别收口。

- **read-sink(主洞)**:`applyLookupRollup`(`routes/univer-meta.ts:1825/1843-1860`)只 gate **外表 sheet 可读**,raw 取 `data[targetFieldId]` **不查外表字段级权限**;read/JSON 路径随后用**源表**权限掩码,catch 不到外表值。→ **在 `applyLookupRollup` 内对外表 targetFieldId 施加外表 field-permission 掩码**(一处修复覆盖全部 read/JSON 消费者:`:2731`/`:8160` 等)。注:此洞**同 base 也存在**(lookup 投影是否受目标字段权限约束=产品语义问题,见 §2a.3-决策);跨 base 把它从"单权限域内"放大到"跨域",更明确是漏。
- **export-sink(次洞,核验新发现)**:**formula 值会物化**(`record-write-service.ts:942`),故"formula 引用 (跨 base) lookup"的结果落库且**能被 export-xlsx 导出**——**lookup-only 修复堵不住它**。→ 独立守:formula 引用了对 actor 字段级不可读的(跨 base)lookup 时,该 formula 的物化/导出按掩码处理(或拒算);单列 canary。
- **②a.3-决策(需 owner 拍板)**:read-sink 的"lookup 是否受目标字段级权限约束"在**同 base** 可能是 by-design 投影(飞书等多按"字段作者选择暴露"处理);**跨 base** 则更明确应受约束。建议:跨 base lookup 一律施掩码(墙的一部分);同 base 维持现状或加可选字段 flag——此点上交 owner。
- 这条(至少其跨 base 部分)**即使 ②b 永不做也应落**(修现存洞);测试:GA-T2a read/JSON 跨 base lookup+外表字段 deny→值不出现;GA-T2b formula-over-cross-base-lookup export canary。

### 2a.4 base 删除 / 悬挂语义
- base 删除时:若存在指向其 sheets 的跨 base 链接,**阻止删除或显式告警 + 提供解链**(不静默 SET NULL 留悬挂)。ops 脚本扫悬挂 meta_links。

### 2a.5 ②a 测试矩阵(真库)
GA-T1 无标志跨 base 链接写 → 4xx · **GA-T2a read/JSON 跨 base lookup + 外表字段 deny → 值不出现(承重)** · **GA-T2b formula-over-cross-base-lookup export canary(承重)** · GA-T3 base 级权限派生(read/admin) · GA-T4 同 base 链接 + 同 base lookup 现状回归(按 §2a.3-决策)· GA-T5 base 删除悬挂告警 · GA-T6 OpenAPI/迁移边界。

## 3. ②b 跨 base 能力(锁定设计 — differentiation,后置)

### 3b.1 schema
- 链接字段 property 加 `foreignBaseId?`(缺省=同 base,向后兼容);codec/validation/OpenAPI parity + wire round-trip(drift 纪律)。
- 自动化 action 加 `targetBaseId?`(`update_record`/`create_record`);执行期校验触发 actor 对目标 base 的写权限(②a 的 base 原语)。

### 3b.2 权限语义(D3 golden 扩展)
- 跨 base 读:reader 需源表读 **且** 外表 base read;跨 base 写(automation):actor 需目标 base write。作为 D3 golden-matrix 的**新维度**落测(非新框架)。

### 3b.3 实时/Yjs
- FOL-1(#2464)的一跳 base 内失效已建;跨 base 复用同款失效信号(房间 base-agnostic),只需 fan-out 覆盖跨 base 相关表——无新协议。

### 3b.4 配额/滥用
- 跨 base automation 的 base 级速率限制(防 Base A 触发器 thrash Base B);复用 reserve-then-settle 式主体键思路。

### 3b.5 ②b 边界
单跳跨 base 链接 + 单 action targetBase;无递归跨 base 图;UI(链接选择器跨 base 列 + base 切换)单独 frontend 环。

## 4. 风险清单(勘察 §8,设计必答,均已在 §2/§3 收口)

lookup hydration 越权(②a.3)· export 掩码绕过(②a.3,核心)· 级联删除(②a.4 不加 FK)· automation 跨 base 无 gate(②b.1 执行期校验)· workspace 边界(②a.1)· Yjs 跨 base(②b.3 复用)· 悬挂链接(②a.4)· base 删除语义(②a.4)。

## 5. 执行序(owner 审本设计后)

②a 先行(3-4 个 PR:base 权限原语 → 链接校验 → **lookup 外表字段掩码修补(可最先单独发,见下)** → 删除语义)→ owner 确认墙稳固 → ②b(schema → 权限 golden 扩展 → automation → UI),每步独立 opt-in。
**建议:§2a.3 修补可作为独立安全 PR 抢先落**(核验确认:它不依赖 §2a.1/2a.2/2a.4,自包含)——但落地前需 owner 拍 §2a.3-决策(同 base lookup 是否受目标字段权限约束:by-design 投影 vs 加约束)。**跨 base 部分无歧义应修;同 base 部分是产品语义决策**。该 PR 含 read-sink(applyLookupRollup 内掩码)+ export-sink(formula 物化守)两条,GA-T2a/T2b 钉死。

## 6. 不在本设计

跨 base 递归派生 · 跨 base 模板 · base 间数据迁移 · UI 实现(单独 frontend 环)· central RBAC/auth(永不,多维表内核内解决)。
