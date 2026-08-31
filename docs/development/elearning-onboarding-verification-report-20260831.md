# MetaSheet 云课堂 L5 新员工培训验证报告（2026-08-31）

> 当前结论：PASS FOR LOCAL PRE-SHARED CHECKPOINT
>
> 非结论：不是 exact-head CI、Ready、merge、flag、UAT、deploy、production 或 L0–L6 完成证明。
>
> 被测代码：`21f3d489c8d376aa656c411bb04b1a9bc285617e`
>（tree `6f75b039afbf57efa74f232c9f362f345e5c1e15`）。
>
> 报告提交只增加开发/验证文档；后续 shared-CI 尾提交形成后必须更新本报告绑定的 exact head。

## 1. Exact topology

| 检查 | 结果 |
|---|---|
| branch | `codex/elearning-l5-onboarding-20260831` |
| first parent | `75c451311809870a8ec177011ace625a9a3012d2` |
| second parent / main | `25635e67db5145a5998499c4adc8f030e156daf7` |
| merge head/tree | `21f3d489c8...` / `6f75b039af...` |
| merge conflict | 0 |
| pre-merge path overlap | 0 |
| manual resolution files | 0 |
| relative-second-parent product files | 44 |
| `git diff --check` | PASS |

## 2. Exact-head 本地门

| 面 | 命令/范围 | 结果 |
|---|---|---|
| Core unit | 12 个 onboarding/目录/激活/pilot 邻接文件 | 12/12 files，98/98 tests PASS |
| Web | onboarding client/admin + admin view | 3/3 files，46/46 tests PASS |
| Plugin | onboarding worker + reminder/stats 邻接 | 3/3 files PASS |
| OpenAPI | `dist-sdk/tests/elearning-paths.test.ts` | 17/17 PASS |
| Core typecheck | `@metasheet/core-backend type-check` | PASS |
| Web typecheck | Web build + verification approval config | PASS |
| Source ESLint | Core package config + Web package config | PASS |
| OpenAPI build/guard | official build + SDK generation + codegen guard | PASS，生成物零 tracked drift |
| diff/status | diff-check + clean worktree | PASS |

说明：第一次从仓库根执行 source ESLint 时根 `tsconfig.json` 不包含 package 文件，解析前失败；改用各 package 的 canonical ESLint 工作目录后有效门通过。第一次 OpenAPI 定向测试误指定了不存在的包内 Vitest config；随后使用 workflow 的 canonical `packages/openapi/dist-sdk` 命令通过。两者均是命令姿态纠正，不是代码绿转红。

## 3. PostgreSQL authority

使用本机 PostgreSQL 15 的唯一 scratch 数据库，未接触共享或客户数据库。

### 3.1 专属 authority suite

- `elearning-onboarding.db.test.ts`：6/6 PASS。
- migration apply + replay：PASS。
- schema drift（constraint/function）：RED as expected，canonical restore GREEN。
- policy closed rules、request replay/conflict、one-way retirement：PASS。
- assignment global effect serialization 与 cross-org negative：PASS。
- `hire_date` fill-only-null 与调用方外层事务回滚：PASS。
- 周报小样本抑制与 append-only：PASS。
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

以下 mutation 在 `81d0d0fcb5` 所属产品树执行；main replay 与该 44 文件投影零交集，因此 `21f3d489c8` 保留相同产品字节。最终 shared head 仍须重跑承重 selector/provenance mutation。

1. 绕过 disabled hire-date isolation：目录/生命周期测试精确 RED；恢复 GREEN。
2. 移除 pending activation onboarding enqueue：activation 事务测试 RED；恢复 GREEN。
3. 移除 null-hire-date 的不符合条件分支：lifecycle 测试 RED；恢复 GREEN。
4. outer transaction 中提前提交 first enqueue 或吞掉第二次 authority failure：real-DB 回滚断言 RED；恢复 GREEN。
5. 移除 `hire_date IS NULL` 更新条件：保留已有日期断言 RED；恢复 GREEN。

### 4.2 OpenAPI

1. 将周报 response 指向错误 schema：focused test RED；恢复后 17/17 GREEN。
2. 删除 suppressed 判别分支：focused test RED；恢复后 17/17 GREEN。

## 5. 尚缺的 landing 证据

| 证据 | 当前状态 |
|---|---|
| backend unit whole-file canary union | PENDING shared window |
| onboarding real-DB no-DB exclude + post-migrate arg | PENDING shared window |
| Web guard + required-Web 双点 selector | PENDING shared window |
| wiring contract deletion mutations | PENDING shared window |
| official provenance old RED / new GREEN / full S5 | PENDING shared window |
| merge-head Sol review | bounded cutoff；无 terminal verdict，不作为通过依据 |
| final shared-head Sol review | NOT RUN |
| remote exact-head CI | NOT RUN |
| merged-main CI | NOT APPLICABLE |
| browser UAT / real tenant | NOT AUTHORIZED |
| flags / dispatch / deploy / production | OFF / NOT AUTHORIZED |

## 6. 当前 P1/P2/P3

- P1：本地已知产品 P1 为 0；shared selector 缺口是尚未完成的 landing gate，不被记成已关闭。
- P2：本地已知产品 P2 为 0；等待 fresh exact-head 独立审阅确认。
- P3：未做真实目录 tenant、通知通道、浏览器 UAT 或生产容量/运维验收；这些不由本地 unit/DB 证明。

## 7. 发布状态

| 动作 | 状态 |
|---|---|
| local product + OpenAPI checkpoint | 完成 |
| local focused/unit/Web/plugin/DB gates | 完成 |
| shared CI/provenance tail | 未完成 |
| push / Draft PR | 未执行 |
| Ready / merge | 未授权、未执行 |
| feature flags | 全部默认 OFF |
| UAT / dispatch / deploy / production | 未授权、未执行 |

因此当前候选只可进入 shared-CI 尾窗与 final exact-head 审阅；不能据此宣称 onboarding 已发布或 L0–L6 整体完成。
