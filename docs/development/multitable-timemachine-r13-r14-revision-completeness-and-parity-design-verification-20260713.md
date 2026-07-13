# Time Machine — R13/R14 收尾主线：Revision 完整性 + 飞书对标缺口 — 设计与验证 MD（2026-07-13）

> **性质**：owner `/goal`「R12 基础工程收口 + R13/R14 飞书对标缺口」一轮的设计+验证交付。ultracode，模型按难度分派（Opus=安全/设计/对抗审；Sonnet=锁定规格的实现切片；Fable=纯 FE/文案）。
> **主线定位（owner 定，如实）**：R12 从「最终收官」降级为**基础工程收口**；刚发现的飞书对标缺口接成 R13（revision 完整性）/ R14（产品面 + 规模化）。**合并后的准确终点不是「再做几项运维就结束」**，而是：**先补齐 revision 链 → 再补完整 T-state 产品面与规模化恢复 → 最后跑 O-2**。中小型场景届时可认真宣称媲美；再补 base-wide 原子恢复，才适合宣称接近飞书 Time Machine 完整产品能力。
> **权威边界**：本 MD 是**当前收口索引**；**代码与既有 canonical Global History 文档才是语义权威**。旧台账（#4148/#4155/#4185）将加 superseded 指针；#4147 本身不是台账（真正对应的旧验证 MD 是 **#4148**）。

## 0. 现状与本轮进度

| 线 | 状态 |
|---|---|
| **R12-B #4197**（确定性并发 barrier + OD-7 措辞 + #4161 注释） | ✅ **MERGED `904cf4aa0`** |
| **R12-C #4199**（O-2 operator-contract：19-flag manifest + `--strict` + 源码派生完整性测试 + required CI + o2-ladder 修） | ✅ **MERGED 2026-07-13 09:09Z** |
| **R12 #4186**（AS-BUILT 台账） | ⏸ 保持 Draft，**最后重写**（删「代码开发全部落地」结论；稳定事实；作唯一收口索引） |
| **R13-A #4187**（form/plugin/automation revision 完整性设计锁） | ✅ **RATIFIED 2026-07-13**（§0.5；见 §2） |
| **R13-A 实现 lanes A/B/C** | 🔄 **进行中**（3 条隔离 Sonnet lane，Draft PR，见 §2.3） |
| **R13-A OD-6 guard** | ⬜ 独立 rung（见 §2.4） |
| **R13-B T-state 产品面** | ⬜ 设计（见 §3） |
| **R13-C retention+reset 共存 / 异步>5000** | ⬜ 先设计锁 + 真实数据量基准（见 §4） |
| **R14 产品路线** | 🔒 **owner 决策**（方案 A base-wide atomic restore vs 方案 B granular 定位，见 §5） |
| **O-2 上线验证** | 🔒 owner/ops（flag-off 基线 → 分级 flag-on → 证据 → 单租户 pilot，见 §6） |

## 1. R13/R14 开发顺序（owner「规划开发顺序」）

```
R13-A revision 链补齐  ──┬─ lane A (form CRUD+attachment+link)   [Sonnet impl + Opus gate]
  (先修锁→再实现)        ├─ lane B (plugin create/update)         [Sonnet impl + Opus gate]   ← 可并行
                         └─ lane C (automation CRUD+writeback)    [Sonnet impl + Opus gate]
                         └─ OD-6 revision-disposition CI guard    [Opus 设计 + Sonnet impl]   ← lanes 落后接
R13-B T-state 产品面    ──── 完整 T 状态 API/页面（含 T 后被删记录）+ History Center 直接预览/恢复
                            [Sonnet API + Fable FE + Opus gate]    ← 可与 R13-A 并行
R13-C 运维与规模        ──── retention+reset 共存 / >5000 异步任务  [Opus 设计锁 + 真实基准，先设计不改热事务]
R14 产品路线           ──── owner 决策 → base-wide atomic restore（若方案 A）
O-2 上线              ──── flag-off 基线 → 分级 flag-on → 证据 → 单租户 pilot   [owner/ops]
最后：重写并合 #4186（唯一收口索引），旧台账降指针
```

**并行性**：R13-A 的 A/B/C 三 lane **文件隔离**（A=univer-meta 路由；B=records.ts；C=automation-executor+automation-service），可立即并行。R13-B 可与 R13-A 并行。**R13-C 先做设计锁 + 真实数据量基准**，避免直接改高风险恢复事务。R14 是 owner 产品决策，其结果决定 automation/workflow/dashboard config-history 是否进 config revision。

## 2. R13-A Revision 完整性（RATIFIED #4187）

### 2.1 缺口（独立审计确认，primary-source）
`meta_records` 全仓 **37 个写入点**；**恰 8 个真实用户数据内容路径不写 revision**（owner「8 不是 2」= 确认），另有 **1 个** config-lane 结构性残余（整表 FK-cascade drop）。8 个路径喂同一 `reconstructRecordsAtT` ⇒ PIT view / restore / revert / **Reset** 全基于错误历史；Reset-to-T 会**静默销毁**本应存在于 T 的记录。审计 `/tmp/r13-revision-disposition-audit-20260713.md`。

### 2.2 两处 draft 纠错（owner P2，审计证实）
- **link 分支**："link-only 编辑 ⇒ patch 空 ⇒ 不 UPDATE" = **错**。`patch[fieldId]=ids` @`univer-meta.ts:14306` ⇒ patch 非空 ⇒ 进入 UPDATE + bump version ⇒ link 编辑是真实 data 变更、同样 UNCAPTURED。**OD-4 改为 IN SCOPE**（lane A 加 revision↔meta_links 恢复一致性 golden）。
- **CREATE 风险**：draft §0 写「kept / 非破坏 / 历史不完整」= **低估**。created-before-reset-T 且 create 未捕获 ⇒ `reconstructRecordsAtT`(record-reconstructor.ts:34) 无 ≤T revision ⇒ absent ⇒ `computeSheetReset`(univer-meta.ts:10031-10037) 无条件推入 delete-set（分不清「T 后创建」与「T 前创建但未捕获」）⇒ **Reset-to-T 销毁本应存在于 T 的记录**。CREATE **是破坏性的**，与 EDIT 同类。

### 2.3 8 路径 → 3 lane（OD-1 = 全量 bucket-A，拆三刀）

| Lane | 站点 | source (OD-2) | actor (OD-3) | PR |
|---|---|---|---|---|
| **A** form | `univer-meta.ts:14470`(create) · `:14423`(edit,含 link) · `:15693`(attachment-delete) | `'public-form'` / attachment `'rest'` | 已知 actor;匿名表单 CREATE=null | 🔄 lane A |
| **B** plugin | `records.ts:546`(create) · `:507`(patch) | `'plugin'` | actor-less=null | 🔄 lane B |
| **C** automation | `automation-executor.ts:2475`(create) · `:2217`(update) · `automation-service.ts:2818`(resultWriteback) | `'automation'` | context.actorId / chainActorId / null | 🔄 lane C |

**每 lane 证明义务**：真实入口 golden · **同事务** `recordRecordRevision` + 完整 snapshot · PIT 修正后正确 · 失败回滚（无半写）· **源码突变→红**。**事务边界逐 lane 重验**（D-1「偏差1」：这些 lane 曾非统一事务；D-2 §0 称现已事务化——**逐站点证明，不假设**；非原子的站点 STOP 上报）。UNFLAGGED 纯正确性（同 D-1），无 env flag。

### 2.4 OD-6 revision-disposition guard（独立 rung）
审计给出矩阵：**22 must-write / 15 exempt**；guard 对 **INSERT/UPDATE/DELETE** 强制每个 `meta_records` sink 声明 disposition（rank-8 锁 guard 忽略 INSERT，故不能复用）。今日对 8 个 lane 站点开火。**特判**：`univer-meta.ts:6521` field-undelete rehydration = **owner 裁定 MUST-WRITE**（审计标 debatable-EXEMPT，owner 定必写）；`approval-record-projection-service.ts:223` 派生投影 = **EXEMPT**；整表 cascade #9(`univer-meta.ts:12519`) 归 **config guard**、不在本 record guard 射程。marker-based（rank-8 形态）优于 lint（clever fingerprint 有 6521 漏洞）。

## 3. R13-B 历史版本体验（完整 T-state 产品面）
- **完整 T 状态 API/页面**：PIT view 纳入「当前已删除但 T 时存在」的记录 —— 需 reconstruct 保留 T 时存在、now 已删的行（当前 `reconstructRecordsAtT` 基于 revision，删除后有 delete revision ⇒ 可判 T 时存在；但 UI 目前只显示影响数量）。
- **History Center 直接预览并恢复**：从时间线直接 preview/restore 单条，而非只显示「影响 N 条」。复用既有 restore-preview/execute + PIT-undelete 面；FE 增量。
- 模型：Sonnet API + Fable FE + Opus gate。**依赖 R13-A**（T-state 正确性依赖 revision 链完整——否则 T-state 本身在 8 路径上是错的）。

## 4. R13-C 运维与规模（先设计锁 + 真实基准，勿直接改热事务）
- **retention 与 Reset 在保留窗口内共存**：当前 `PIT_RESET_RETENTION_BLOCKED`（retention='1' ⇒ reset 409）是**互斥**。目标改为**保留窗口内可恢复**：retention 开启时，只要目标 T 在保留窗口内，reset/restore 仍可执行。**先设计锁**（定义窗口语义、与 anchor/floor 交互），**用真实数据量基准**验证，再动恢复事务。
- **超过 5000 条改异步任务**：`SHEET_REVERT_MAX_RECORDS`(默认 5000) 现为 fail-closed 拒绝。目标：超限转**异步任务**，提供**进度/失败/取消**语义。设计锁 + 基准先行。

## 5. 🔒 R14 产品路线（owner 一次决策）
- **方案 A（推荐）**：实现 **base-wide atomic restore** —— 与飞书「一键恢复整个多维表格」直接对等，同时保留我们更强的按记录/字段/sheet 恢复。
- **方案 B**：不做整库恢复，正式定位 **Granular History & Recovery**（更安全、更细粒度，不宣称完整 Time Machine 对等）。
- **连带**：automation/workflow/dashboard 配置历史——选方案 A（完整对标）则也进 config revision；选 granular 则明确排除。**放 R14 后半段。**

## 6. O-2 上线验证（owner/ops）
当前镜像 **flag-off 基线** → 按破坏性从低到高**逐项 flag-on** → 同时归档 **API/浏览器/DB/回收站证据** → **先单租户 pilot**，生产**每个 flag 单独签核**，不直接全量。（部署 host env + 全栈，本会话不可达；runbook 见 o2-ladder + #4199 manifest `--strict`。）

## 7. 最终验收（owner 明定）
1. **所有用户数据写入口都产生正确 revision**（R13-A + OD-6 guard 锁死）。
2. 历史时点页面能展示**完整 T 状态**（R13-B）。
3. preview/execute/权限/锁/漂移/原子性**全部有 mutation-proven goldens**。
4. retention 开启时仍可在保留窗口内恢复（R13-C）。
5. 主干镜像完成 **flag-off → 分级 flag-on → 浏览器/API/DB staging 证据**（O-2）。
6. 生产仅**单租户 pilot**，不直接全量开启。
7. **最后重写并合入 #4186**（唯一收口索引），旧台账降历史指针。

## 8. 验证台账（随 lane/gate 完成滚动更新）

| 项 | 证据 |
|---|---|
| R12-B #4197 | Opus gate APPROVE-with-fixes；G17 barrier 正控独立复跑（neuter 锁再验→50ms assertion 红）；MERGED `904cf4aa0` |
| R12-C #4199 | Opus gate APPROVE-with-hardening 0P1/0P2；19-flag 源码派生完整性测试 mutation-proven；接 required CI；MERGED 09:09Z |
| R13-A 缺口 8 路径 | 独立审计 37 站点、8 UNCAPTURED 确认；link-branch + CREATE-reset 两纠错 primary-source 证实 |
| R13-A 锁 | #4187 RATIFIED §0.5（OD-1..6）；audit synthesis `/tmp/r13-revision-disposition-audit-20260713.md` |
| R13-A lanes A/B/C | 🔄 进行中 — 每 lane 待 Opus gate 验：真实入口/同事务/完整 snapshot/PIT 正确/失败回滚/突变红 |
| R13-A OD-6 guard | ⬜ 待建（矩阵 22/15） |
| R13-B/C · R14 · O-2 | ⬜/🔒 见上 |

## 9. 收官口径（如实，不掩盖未完成代码）
R12 基础工程收口**已落**（#4197/#4199 MERGED）。**revision 链尚未补齐**（R13-A 3 lane 进行中 + OD-6 guard 未建）——在此之前，PIT/History/Reset 在 8 条用户数据路径上**仍基于错误历史**，且 Reset 有静默数据销毁向量。**因此现在既不能宣称「Time Machine 完成」，也不能宣称「媲美飞书」**。诚实终点见 §主线定位。**#4186 最后重写并合，作唯一收口索引；本 MD 为当前进度索引，代码 + canonical 文档为语义权威。**
