# MetaSheet 云课堂 L5 新员工培训验证报告（2026-08-31）

> 当前结论：PASS FOR LOCAL LANDING CANDIDATE
>
> 非结论：不是 exact-head CI、Ready、merge、flag、UAT、deploy、production 或 L0–L6 完成证明。
>
> 被测代码：`6e2a1c8b5e7550f5ab39e724aaef577b680f33a0`
>（tree `742dfb90da1b197c5cdea1375a59bee9eb3a0e78`）。
>
> 后续报告提交只更新开发/验证文档，不改变上述被测代码树。

## 1. Exact topology

| 检查 | 结果 |
|---|---|
| branch | `codex/elearning-l5-onboarding-20260831` |
| first parent | `75c451311809870a8ec177011ace625a9a3012d2` |
| second parent / main | `25635e67db5145a5998499c4adc8f030e156daf7` |
| product merge head/tree | `21f3d489c8...` / `6f75b039af...` |
| shared landing candidate head/tree | `f8f2900737...` / `1a91fbcf4f...` |
| review fix head/tree | `bbaa4149b4...` / `2f20a81a6a...` |
| Web contract fix head/tree | `6e2a1c8b5e...` / `742dfb90da...` |
| merge conflict | 0 |
| pre-merge path overlap | 0 |
| manual resolution files | 0 |
| relative-second-parent product files | 44 |
| `git diff --check` | PASS |

## 2. Exact-head 本地门

| 面 | 命令/范围 | 结果 |
|---|---|---|
| Core unit | 12 个 onboarding/目录/激活/pilot 邻接文件 | 12/12 files，98/98 tests PASS |
| Web | onboarding client/admin + admin view | 3/3 files，48/48 tests PASS |
| Plugin | onboarding worker + reminder/stats 邻接 | 3/3 files PASS |
| OpenAPI | `dist-sdk/tests/elearning-paths.test.ts` | 17/17 PASS |
| Core typecheck | `@metasheet/core-backend type-check` | PASS |
| Web typecheck | Web build + verification approval config | PASS |
| Source ESLint | Core package config + Web package config | PASS |
| OpenAPI build/guard | official build + SDK generation + codegen guard | PASS，生成物零 tracked drift |
| Shared wiring | `elearning-media-ci-wiring.test.mjs` | 15/15 PASS |
| Backend onboarding + port neighbors | 8 个 whole-file | 8/8 files，59/59 tests PASS；其中 7 个 canary 为 54/54 |
| Required Web | canonical required-Web script | 410/410 files，5244/5244 tests PASS |
| E-learning Web lane | 29 个 whole-file spec | 29/29 files，376/376 tests PASS |
| Plugin package chain | plugin-elearning package tests | 14 suites PASS，0 intentional exclusion |
| Provenance / S5 | official pin + full sealed-export S5 | old pin RED，new pin GREEN，frozen/live differenceCount=0，full S5 PASS |
| diff/status | diff-check + clean worktree | PASS |

说明：产品源文件已使用各 package 的 canonical ESLint 配置通过。shared 尾窗对 `vitest.config.ts` 的直接 ESLint 因该 package 的 ESLint project 不包含配置文件而在解析前拒绝；该文件由 core typecheck、wiring、真实 Vitest 运行和 diff-check 覆盖。根目录脚本无 ESLint 配置，使用 `node --check`；shell 使用 `bash -n`。这些是工具适用边界，不被记为源码通过证据。

## 3. PostgreSQL authority

使用本机 PostgreSQL 15 的唯一 scratch 数据库，未接触共享或客户数据库。

### 3.1 专属 authority suite

- `elearning-onboarding.db.test.ts`：6/6 PASS。
- migration apply + replay：PASS。
- schema drift（constraint/function）：RED as expected，canonical restore GREEN。
- policy closed rules、request replay/conflict、one-way retirement：PASS。
- policy replay 在读取既有 request 前重验 active same-org actor；revoked-membership replay：values-free forbidden。
- assignment global effect serialization 与 cross-org negative：PASS。
- assignment effect 的 `source_key` 由数据库 trigger 精确绑定被引用 training-plan assignment。
- `hire_date` fill-only-null 与调用方外层事务回滚：PASS。
- 周报小样本抑制与 append-only：PASS。
- 周报 producer 只 enqueue 上一个已闭合 UTC 周，job 在周结束后 24 小时到期；已入队报告在 policy 后续退役时仍可完成。
- nonempty down fail-closed；empty down/reapply：PASS。
- `scratchDrain=CLEAN`，`residualBackends=0`。

### 3.2 完整迁移流

- fresh full migration：388 migrations PASS。
- second migration replay：PASS，无新增待执行项。
- exact scratch database residue：0。
- onboarding/full-migration prefix residue：0。
- DB window：released。

## 4. 判别 mutation 证据

### 4.1 本轮 exact/pre-merge 产品修复门

以下 mutation 在 `81d0d0fcb5` 所属产品树执行；main replay 与该 44 文件投影零交集，因此 `f8f2900737` 保留相同产品字节。

1. 绕过 disabled hire-date isolation：目录/生命周期测试精确 RED；恢复 GREEN。
2. 移除 pending activation onboarding enqueue：activation 事务测试 RED；恢复 GREEN。
3. 移除 null-hire-date 的不符合条件分支：lifecycle 测试 RED；恢复 GREEN。
4. outer transaction 中提前提交 first enqueue 或吞掉第二次 authority failure：real-DB 回滚断言 RED；恢复 GREEN。
5. 移除 `hire_date IS NULL` 更新条件：保留已有日期断言 RED；恢复 GREEN。
6. 将 active actor 校验移回 request replay 之后：revoked-membership replay negative RED；恢复 GREEN。
7. 删除 production weekly producer start：plugin runtime wiring RED；恢复 GREEN。
8. 删除 closed-week enqueue guard：未来周 negative RED；恢复 GREEN。
9. 恢复“retired policy 不可完成已入队报告”：retired materialization negative RED；恢复 GREEN。
10. 删除 effect trigger 的 assignment `source_key` 比较：真库 wrong-source insert negative RED；恢复后 authority 6/6 GREEN。
11. 将管理端默认周恢复为本周周一：默认闭合周断言精确 RED（`2026-08-31` 而非 `2026-08-24`）；恢复 GREEN。
12. 删除 `failedCount + deadCount <= enqueuedCount`：不可能响应被接受，客户端 negative 精确 RED；恢复 GREEN。

### 4.2 OpenAPI

1. 将周报 response 指向错误 schema：focused test RED；恢复后 17/17 GREEN。
2. 删除 suppressed 判别分支：focused test RED；恢复后 17/17 GREEN。

### 4.3 Shared selector / provenance

1. 7 个 onboarding backend unit canary 逐一从 `plugin-tests.yml` 删除：每项 wiring 精确 RED；逐一恢复 GREEN。
2. 删除 real-DB no-DB exclude 或 post-migrate whole-file 参数：两项分别 RED；恢复 GREEN。
3. 两个 onboarding Web spec 分别从 domain guard 和 required-Web 删除：四项分别 RED；恢复 GREEN。
4. 删除 onboarding service、view 或两个 spec trigger path：四项分别 RED；恢复 GREEN。
5. 恢复旧 `pluginTestsWorkflow` digest：package provenance RED；官方新 pin 恢复后 GREEN，完整 S5 GREEN。

## 5. 尚缺的 landing 证据

| 证据 | 当前状态 |
|---|---|
| backend unit whole-file canary union | PASS，7/7 files / 54 tests |
| onboarding real-DB no-DB exclude + post-migrate arg | PASS，双点 selector + 删除 mutation |
| Web guard + required-Web 双点 selector | PASS，29-file domain lane + required-Web 410/5244 |
| wiring contract deletion mutations | PASS，15/15 restored |
| official provenance old RED / new GREEN / full S5 | PASS |
| merge-head Sol review | bounded cutoff；无 terminal verdict，不作为通过依据 |
| pre-fix shared-head Sol/Terra review | 发现 1 P1 / 3 P2，已在 `bbaa4149b4` 逐项修复 |
| `bbaa4149b4` Sol/Terra exact-code review | 0 P1 / 1 P2 / 1 P3；两项均在 `6e2a1c8b5e` 修复 |
| final `6e2a1c8b5e` Sol review | PASS，0 P1 / 0 P2 / 0 P3；只读，未运行 PostgreSQL |
| remote exact-head CI | NOT RUN |
| merged-main CI | NOT APPLICABLE |
| browser UAT / real tenant | NOT AUTHORIZED |
| flags / dispatch / deploy / production | OFF / NOT AUTHORIZED |

## 6. 当前 P1/P2/P3

- P1：本地产品、数据库与 landing selector 为 0；fresh `6e2a1c8b5e` Sol exact-head 复门为 0。
- P2：默认闭合周和聚合计数缺口已修复并具备判别 mutation；fresh `6e2a1c8b5e` Sol exact-head 复门为 0。
- P3：未做真实目录 tenant、通知通道、浏览器 UAT 或生产容量/运维验收；这些不由本地 unit/DB 证明。

## 7. 发布状态

| 动作 | 状态 |
|---|---|
| local product + OpenAPI checkpoint | 完成 |
| local focused/unit/Web/plugin/DB gates | 完成 |
| shared CI/provenance tail | 完成，`f8f2900737` |
| push / Draft PR | 未执行 |
| Ready / merge | 未授权、未执行 |
| feature flags | 全部默认 OFF |
| UAT / dispatch / deploy / production | 未授权、未执行 |

因此当前候选可进入 final exact-head 审阅与 Draft/HOLD publication；不能据此宣称 onboarding 已发布或 L0–L6 整体完成。
