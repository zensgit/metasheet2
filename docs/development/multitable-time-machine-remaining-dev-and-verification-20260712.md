# Time Machine（Multitable Global History）— 余下开发 + 设计与验证 MD（2026-07-12）

> **性质**：owner `/goal`「这条 timemachine 功能还有哪些开发要完成，完成后给出设计及验证 MD，自动处理开发任务」一轮的交付。
> **口径先行（如实）**：本轮**自主可开发的池 = 3 项 CI/文档缺口**（全落 **#4147**）。功能面**没有**新增的未 gated 开发——
> 剩余全部是 owner 门（#4004 D-2 / O-2 运维 / person 名称解析 ratify / 4d 红线）。**不是「这条线开发完了」。**

## 1. 方法

对 `origin/main` 只读审计（Sonnet 广度 survey + 我逐条实证复核，不采信未验证断言）。
**最关键的一条：我把「从未真正跑过」的那个测试，真的跑起来了**（见 §3.2）——而不是只看它在不在白名单。

## 2. 线的现状

R11（2026-07-11）落地后：#4117 vintage-exact PIT-resurrect 锚 · #4119 masked cross-table `fieldNames` ·
#4120 tombstone 地板决策 · #4124 restore 回链 `restored_from_version` · #4127 轮次文档。

本轮审计**逐条复核了 4 个历史「疑似残留」，结论：全部不成立**（如实报告，不制造 finding）：

| 疑似残留 | 复核结论 |
|---|---|
| `meta_link_tombstones.sheet_id` 在 `reason='record_delete'` 行存的是**被删记录**的 sheet，而 `field_id`/`record_id` 属于**邻居**的 sheet | 数据事实为真，但**无任何消费方按 sheet_id 过滤**（`inbound-link-replay.ts:105-160`、`record-service.ts:980-984`、`meta-revision-retention.ts:232-234` 一律只按 `source_revision_id`/`reason` 过滤），且 `inbound-link-replay.ts:30-32` 已显式写明「NEVER filter by sheet_id」。**非 live 缺陷** |
| `meta_records_trash` 永不清理 | 属实，但是**已 ratify 的有意设计**（`meta-revision-retention.ts:223-227`：trash 是保护活 tombstone 不被过早清理的**地板**，唯一出口是 restore 时的 DELETE）——与 R11 `#4120` floor-A 决策一致。**非残留** |
| retention 清理按无序 `LIMIT` 切片 ⇒ 撕裂的 tombstone 集 | 旧 4c-2 形态确曾如此，**4c-3 §6 已修**：现按**整个 anchor 组**清理（`GROUP BY anchorColumn`，`LIMIT` 限组不限行），且带「仍被活 trash 行引用的 anchor 不清」的地板谓词。**已修** |
| `TrashModal.vue` 只用 `scopedAllFields`（layer-3 单层）播种标题 = #4007 那类字段名泄漏 | **已修**：调用点 `MultitableWorkbench.vue:525-530` 传的是 `twoLayerVisibleFields`（layer-2 ∩ layer-3，:1346 计算），并由 `multitable-workbench-history-field-scope-wiring.spec.ts` 回归锁死（该 spec **在 CI 里**）。**非 live** |

另：`restored_from_version` / `batch_id` / `delete_revision_id` 三列的**写→读→渲染**全链路均已审，**无只写不读或只读不写的孤儿列**。
死代码扫描（7 个模块 29 个导出 + FE label/util/composable）：**零死代码**。

## 3. 本轮实质发现（全部已修，#4147）

### 3.1 四个前端 spec 跑在**零个** workflow 里 —— 其中一个是**唯一的**字段掩码渲染守卫

- **实证**：全文 grep `.github/workflows/` 无命中；`multitable-web-guard.yml` 的 `vitest run` 过滤器无这些 token；
  **required** 的 `run-required-web-tests.sh`（backing required `web-tests` 检查）也没有。且 required `test (20.x)`
  对 apps/web **只 build 不跑 vitest**。⇒ 这 4 个 spec（30 测，全绿、无 DB 依赖）**在任何 CI 里都没跑过**。
- **最要紧的那个 = `meta-record-drawer-history-diff.spec.ts` 的 LEAK-LOCK**：它是 `MetaRecordDrawer` History 页
  **掩码渲染属性的唯一前端守卫**。后端对照测（`multitable-record-history-field-mask.test.ts`，在 CI 里）只证明
  **服务端响应**被掩码——**从不触碰渲染器**。而 `historyFieldDiffs()`（`MetaRecordDrawer.vue:791`）**必须**遍历
  `item.changedFieldIds`，**绝不能**遍历原始 snapshot。
- **突变实证（本轮最硬的一条证据）**：把 `item.changedFieldIds.map(...)` 换成 `Object.keys(item.snapshot ?? {}).map(...)`
  ⇒ LEAK-LOCK **变红**，且**渲染出的 DOM 里真的出现了 `TOP_SECRET`**——一个在 snapshot 里、但不在 `changedFieldIds` 里的字段，
  正是 actor 绝不该看到的被掩码字段。**在本 PR 之前，这个泄漏会「全绿上线」**，因为唯一能抓到它的测试跑在零个 workflow 里。
  基线恢复后 6/6 绿。
- **修**：4 个 spec 全部接入 **required** `web-tests` 门（`run-required-web-tests.sh`）。

### 3.2 一个真库测试**自诞生起从未执行过它的断言**

- `multitable-history-before-hydration-realdb.test.ts` **不在** `plugin-tests.yml` 的真库白名单里。
- 机制（**skip-when-unreachable 陷阱**）：它只会在默认 test 步骤里被收集，而那一步 `DATABASE_URL` **未设置**
  ⇒ `describeIfDatabase` 整体 **skip-green**；它自己的 `sentinel: DATABASE_URL set` 哨兵**嵌套在同一个 describe 里**，
  所以**连哨兵都一起被跳过**——这正是「哨兵保护不了自己」的经典形态。
- ⇒ 它**从未真正跑过断言**，其中包括一条 **`field_permissions` 掩码 parity 金测**。
- **我没有只看白名单就下结论**：起了全新 postgres、跑完整迁移、真的执行它 ⇒ **9/9 通过**（它没坏，只是从没被强制过）。
- **修**：加入 `plugin-tests.yml` 真库白名单。

### 3.3 文档漂移（**复核后确认无 bug**，仅注释）

`tombstone-capture.ts` capture-point-3 的 docstring 仍写着 *"RESERVED SEAM — NOT wired to any retype path in this PR …
4c-1 must add [a cap-check] when it wires this in"*。但 4c-1 早已落地：该函数由 `applyLossyRetypeCellRewrite`
（`univer-meta.ts:6407`）**实时调用**。
**我顺着 docstring 里那句「调用方必须自己做 cap-check」去查了是否真有 bug**——`assertWithinCaptureCap(preImages.length)`
就在调用前一行、同在 `isTombstoneCaptureEnabled()` 门内，**义务已履行，无 bug**。故只修正会把它读成死代码的过时注释
（含单元测试头部同一处过时声明）。

## 4. 验证台账

| 断言 | 证据 |
|---|---|
| 4 个 FE spec 此前跑在零 workflow | grep `.github/workflows/` 无命中；`run-required-web-tests.sh` 无 token；`test (20.x)` 对 apps/web 只 build |
| **LEAK-LOCK 真的会抓到泄漏（非装饰性守卫）** | **突变实证**：改遍历源为 `Object.keys(snapshot)` ⇒ spec 红，且 DOM 渲染出 `TOP_SECRET`；还原后 6/6 绿 |
| 真库测试从未执行过断言 | 不在 plugin-tests 白名单；`describeIfDatabase` 在 DATABASE_URL 未设处 skip-green；哨兵嵌套在同一 describe 内故一并跳过 |
| 该真库测试并未损坏 | **真跑**：全新 pg + 全量迁移 ⇒ **9/9 通过** |
| capture-point-3 的 cap-check 义务已履行 | `assertWithinCaptureCap` 在 `univer-meta.ts:6407` 调用前、同一 `isTombstoneCaptureEnabled()` 门内 ⇒ **无 bug** |
| 四个历史「疑似残留」均不成立 | 见 §2 表，逐条 file:line 复核 |
| 未破坏现有门 | backend `tsc` 0 error；`plugin-tests.yml` YAML 可解析；required 门 shell 语法有效、4 个新 token 精确解析；`tombstone-capture` 单测 5/5 |

## 5. 余下开发与**谁能解锁**（如实）

| 项 | 门 | 谁解锁 |
|---|---|---|
| **#4004 D-2**（side-door delete recoverability 设计锁，PROPOSED） | owner-gated，watch-only（R11 directive 明列不随轮次开） | **owner ratify** |
| **O-2 运维启用**（`MULTITABLE_TOMBSTONE_CAPTURE_ENABLED` → `..._RECORD_UNDELETE_INBOUND` → `..._PIT_UNDELETE`；retention） | 部署 host 的 env，**非 CI 可设**；production 保持 OFF | **owner/operator**（runbook 见 o2-ladder + R11 收官 MD） |
| **person diff before 侧名称解析** | 设计锁 PROPOSED（随 #4127 上 main），OD-P1/P2/P3 待裁 | **owner ratify** → 之后可建（S/M） |
| **4d**：已删字段列的**值级**恢复 | **红线，永不承诺** | — |

**收官口径**：本轮**自主池已清空**（3 个缺口全修，#4147）；功能面**无**新的未 gated 开发；其余全部需 owner 动作。
**并非「这条线开发完了」。**
