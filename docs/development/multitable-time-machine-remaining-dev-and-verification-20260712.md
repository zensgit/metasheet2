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

### 3.1 四个前端 spec 跑在**零个** workflow 里 —— 其中一个是**纵深防御的前端那一层**

> **⚠️ 严重性更正（owner 复审 P2，2026-07-12）**：本节初版称「这个泄漏会**全绿上线**」——**那是过度声称，已撤回**。
> 见下方「真实严重性」。测试本身的价值不变，接线仍然正确；被更正的是我对其**安全影响**的表述。

- **实证（不变）**：全文 grep `.github/workflows/` 无命中；`multitable-web-guard.yml` 的 `vitest run` 过滤器无这些 token；
  **required** 的 `run-required-web-tests.sh`（backing required `web-tests` 检查）也没有。且 required `test (20.x)`
  对 apps/web **只 build 不跑 vitest**。⇒ 这 4 个 spec（30 测，全绿、无 DB 依赖）**在任何 CI 里都没跑过**。
- **它守的是什么**：`historyFieldDiffs()`（`MetaRecordDrawer.vue:791`）**必须**遍历 `item.changedFieldIds`，
  **不能**遍历原始 snapshot。LEAK-LOCK 钉住这条**渲染侧**属性。
- **突变实证（结论仍成立，但只在其正确的作用域内）**：把遍历源换成 `Object.keys(item.snapshot ?? {})`
  ⇒ LEAK-LOCK **变红**，DOM 渲染出 `TOP_SECRET`。⇒ **这个守卫是承重的、不是装饰性的**（它确实会因该回归而红）。基线恢复后 6/6 绿。
- **真实严重性 = 纵深防御的前端那一层，不是「单靠 FE 突变就能造成线上泄漏」**：
  - 该 spec 的 fixture **刻意构造了一个服务端契约不会产生的 payload**（snapshot 里有秘密字段、而 `changedFieldIds` 不含它）。
    spec 自己的 docstring（`meta-record-drawer-history-diff.spec.ts:4-8`）就写明：`patch` / `snapshot` / `changedFieldIds`
    **三者服务端都已掩码**，本测只钉「该属性的 **FE 那一半**」。
  - 后端金测（`multitable-record-history-field-mask.test.ts`，**在 required CI 里**）R1 明确钉住
    「被拒的 layer-3 字段值**不出现在 patch 与 snapshot 里**」。**故服务端根本不会下发那种形状。**
  - ⇒ 正确表述：LEAK-LOCK 证明的是「**万一后端掩码发生部分回归**，FE 仍不会渲染出未在 `changedFieldIds` 里的字段」。
    **单独一个 FE 突变不足以造成真实线上泄漏**——后端那层仍然拦着。
  - ⇒ 接线的正当性依然充分：**一个两层安全属性的前端那层此前没有任何 CI**（纵深防御的一层是哑的）。但严重性应记为
    **「补回纵深防御的一层」**，而**不是**「一个 live 泄漏差一次编辑就上线」。
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
| **LEAK-LOCK 是承重守卫（非装饰性）** | **突变实证**：改遍历源为 `Object.keys(snapshot)` ⇒ spec 红，且 DOM 渲染出 `TOP_SECRET`；还原后 6/6 绿 |
| **但它证明的是纵深防御的 FE 那一层，不是「FE 突变即造成线上泄漏」**（owner 复审 P2 更正） | fixture 刻意构造服务端契约**不会下发**的形状（snapshot 有秘密、`changedFieldIds` 无）；spec docstring `:4-8` 自陈三者服务端均已掩码；后端金测 `multitable-record-history-field-mask.test.ts` **R1** 钉住「被拒字段不出现在 patch 与 snapshot」⇒ **后端那层仍然拦着**。见 §3.1「真实严重性」 |
| 真库测试从未执行过断言 | 不在 plugin-tests 白名单；`describeIfDatabase` 在 DATABASE_URL 未设处 skip-green；哨兵嵌套在同一 describe 内故一并跳过 |
| 该真库测试并未损坏 | **真跑**：全新 pg + 全量迁移 ⇒ **9/9 通过** |
| capture-point-3 的 cap-check 义务已履行 | `assertWithinCaptureCap` 在 `univer-meta.ts:6407` 调用前、同一 `isTombstoneCaptureEnabled()` 门内 ⇒ **无 bug** |
| 四个历史「疑似残留」均不成立 | 见 §2 表，逐条 file:line 复核 |
| 未破坏现有门 | backend `tsc` 0 error；`plugin-tests.yml` YAML 可解析；required 门 shell 语法有效、4 个新 token 精确解析；`tombstone-capture` 单测 5/5 |

## 5. 余下开发与**谁能解锁**（如实）

| 项 | 门 | 谁解锁 |
|---|---|---|
| **#4004 D-2**（side-door delete recoverability 设计锁，PROPOSED） | owner-gated，watch-only（R11 directive 明列不随轮次开） | **owner ratify** |
| **O-2 运维启用**（`MULTITABLE_TOMBSTONE_CAPTURE_ENABLED` → `..._RECORD_UNDELETE_INBOUND` → `..._PIT_UNDELETE`；retention） | 部署 host 的 env，**非 CI 可设**。**代码默认 OFF**（flag 缺省即关）；**但「production 当前是否为 OFF」是外部环境状态，本次代码审阅/本文均未独立核验**（owner 复审指出，2026-07-12）——不要把「代码默认 OFF」当作「线上已 OFF」的证据 | **owner/operator**（runbook 见 o2-ladder + R11 收官 MD） |
| **person diff before 侧名称解析** | 设计锁 PROPOSED（随 #4127 上 main），OD-P1/P2/P3 待裁 | **owner ratify** → 之后可建（S/M） |
| **4d**：已删字段列的**值级**恢复 | **红线，永不承诺** | — |

**收官口径**：本轮**自主池已清空**（3 个缺口全修，#4147）；功能面**无**新的未 gated 开发；其余全部需 owner 动作。
**并非「这条线开发完了」。**
