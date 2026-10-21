# 必跑 web 泳道登记行多行化 — 验证（Q8 / C4 P1）

- 日期：2026-09-21（UTC，`date -u` 取时）
- 基线：`origin/main` = `96cd7b57c`（已含 #5925）
- 分支：`chore/web-required-lane-multiline-registration`
- values-free：全部证据只含仓内路径、token 名与计数。

## 1. 集合等价（最要命的那条）

重排的唯一致命失败是"少了一个 token"——某个 spec 从必跑泳道静默消失，而泳道**仍然绿**。
用 `scripts/ops/required-web-lane-token-set-diff.mjs` 机械比对：

```
$ node scripts/ops/required-web-lane-token-set-diff.mjs origin/main
before (origin/main):        397 tokens, 397 distinct
after  (<working tree>): 397 tokens, 397 distinct
SET IDENTICAL — every filter the old invocation handed vitest is still handed to it.
```

- 397 → 397，集合**逐字相等**，双方均无重复。
- 该脚本比对的是**集合**而非序列：序列变成字母序正是本次改动的目的，序列 diff 必然非空。
- 脚本用同一套"去注释 → 拼接续行 → 取唯一 exec 逻辑行"解析**两种形状**（旧单行 / 新多行），
  所以它既能读 `origin/main` 的旧文件也能读工作树的新文件。
- 改动结束后**再跑一次**，仍为 `SET IDENTICAL`。

块边界实测（node 扫描）：

```
block lines  501-538  | header: npx vitest run \      | entries: 37   (改前已存在)
block lines  566-596  | header: npx vitest run \      | entries: 30   (改前已存在)
block lines 1257-1655 | header: exec npx vitest run \ | entries: 398  (本 PR 新形状 = 397 token + --reporter=dot)
```

前两块是**改动前就存在**的多行 vitest 调用 —— 本 PR 不是发明新写法，是把文件里已有的写法推广到
争用最严重的那一条。

## 2. 跑过的测试

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/required-web-lane-registration-shape.test.ts` | **18 passed** |
| `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/stock-prep-web-ci-coverage-enumeration.test.ts` | **5 passed** |
| `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-ci-coverage-enumeration.test.ts` | **342 passed** |
| `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/network-unavailable-copy-ci-wiring.test.ts` | **7 passed** |
| `node --test plugins/plugin-integration-core/__tests__/stock-preparation-handoff.test.cjs`（含 G2） | **1 file / pass 1, fail 0** |
| `node --test scripts/ops/elearning-media-ci-wiring.test.mjs` | **15 passed** |
| `pnpm --filter @metasheet/web exec vitest run AttendanceReportFieldsSection` | **passed** |
| `pnpm --filter @metasheet/web exec vue-tsc -b` | **exit 0** |
| `bash -n apps/web/scripts/run-required-web-tests.sh` | **exit 0** |
| `git diff --cached origin/main \| grep -cP '\x08'` | **0**（无 0x08 控制字符） |

### 2.1 一条已知的 Windows 本机假红（非本 PR 引入）

`apps/web/tests/attendance-web-guard-workflow.spec.ts` 的 `creates one stable check for every
pull request`（:184）在本机红，71 项里 70 项绿。**根因是本机检出的 CRLF，与本 PR 无关**：

```
worktree (CRLF checkout) -> "\n  pull_request:\r"  FAIL
origin/main blob (LF)    -> "\n  pull_request:"    PASS
```

- 该断言读的是 `.github/workflows/attendance-web-guard.yml`，`file(1)` 报 `CRLF line terminators`；
- `git diff --stat origin/main -- .github/` 为**空**——本 PR 一个 `.github/` 文件都没碰；
- 同一断言对 `origin/main` 的 LF blob 直接 PASS。

CI（ubuntu，LF 检出）是裁判。本 PR 在该 spec 里**新增**的两项断言（多行解析契约）本机即绿。

## 3. 变异自证（M1–M5，全部内存级）

写在 `packages/core-backend/tests/unit/required-web-lane-registration-shape.test.ts` 的
`mutation self-proof` describe 块里：读真实脚本文本，**在内存中**施加破坏，断言对应探测器触发。
**磁盘上的目标文件全程未被改动**，因此与同 worktree 的任何并发活动都不会互相污染
（对应"并行反驳者同树变异互撞"的教训）。

| # | 变异 | 期望 | 实测 |
| --- | --- | --- | --- |
| baseline | 不变 | 无重复 + 已排序 | ✅ |
| M1 | 复制一个 token 行（union 两侧加了同一个 token 的产物） | `no duplicate tokens` 红 | ✅ 重复被检出 |
| M2 | 把字母序第一个 token 移到 `--reporter=dot` 前（"往末尾追加"的习惯） | `is sorted` 红，且 `no duplicate` **不**误报、token 数不变 | ✅ 三条同时成立 |
| M3 | 解析器退回物理行（即"把续行拼接改掉"） | token 只剩 `['\\']`，`StockPreparation*` 为 **0 个** → 枚举类守卫全盲 | ✅ 实测 `[]`；拼接解析下 `StockPreparation*` > 20 |
| M4 | union 复制整个 exec 块（两侧都改了 header） | `exactly one exec logical line` 抛 `found 2` | ✅ |
| M5 | union 把一条**非列表行**变两行 | 见下（**范围受限的结论**） | ✅ 按下表分情况成立 |

### 3.1 M5：对抗回合要求的"union 两侧改同一非列表行"案例

任务书里的措辞是"证明 `bash -n` + 唯一 exec 行守卫会红"。**这个绝对化说法是假的**，实测后改写为
分情况的受限结论（对应"绝对断言必须先穷尽证伪"的教训）：

| union 撕裂的那条行 | `bash -n` | 唯一-exec 守卫 | 其它守卫 | 实际危害 |
| --- | --- | --- | --- | --- |
| (a) 语法承重行（`if` / `for` / `fi`） | **红** | — | — | 脚本不可解析，真故障 |
| (b) `exec npx vitest run \` header | 绿 | **红**（M4） | — | 后一条 exec 全是死代码，真故障 |
| (c) 某条 token 行 | 绿 | 绿 | **红**（M1 重复 / M2 乱序） | 真故障 |
| (d) 自足的简单命令（如 `npx vitest run someBatch --reporter=dot \|\| exit $?`） | **绿** | 绿 | 绿 | **无害**：要么幂等地多跑一遍，要么落在 exec 之后属不可达死代码 |

(a) 与 (d) 在 M5 里用 `bash --noprofile --norc -n -s` 实测过：

```
if true; then / echo ok / fi                        -> exit 0
if true; then / if false; then / echo ok / fi       -> exit != 0   (a) 被 bash -n 抓住
<同一条简单命令重复两遍>                              -> exit 0      (d) 语法上合法
```

**(d) 是诚实的残留**：四条结构断言不是 union 输出的全覆盖保证。之所以可以接受，是因为 (d) 这一类
在语义上确实无害。这一点同时写进了测试注释与本文，避免后来者把四条断言读成"union 全保险"。

### 3.2 另一条被实测推翻的顺带说法

`bash -n` **不会**拒绝以反斜杠续行结尾的文件（截断的 token 块）：

```
printf 'exec npx vitest run \\\n  alpha \\\n' | bash --noprofile --norc -n -s   -> exit 0
```

所以"块必须终止"这一条不能靠 `bash -n`，得由 shape 守卫里显式走到 EOF 的
`toBeLessThan(lines.length)` 断言兜住。该反例作为一条独立的 decoy 测试常驻。

## 4. 解析器清点（否定性结论给 path:line）

**改了**（原本按物理行解析，多行化后会瞎）：

- `packages/core-backend/tests/unit/stock-prep-web-ci-coverage-enumeration.test.ts`
- `plugins/plugin-integration-core/__tests__/stock-preparation-handoff.test.cjs:2884`（G2）
- `apps/web/tests/attendance-web-guard-workflow.spec.ts`

**亲读后确认无需改**（已拼接续行 / 不依赖该形状）：

- `packages/core-backend/tests/unit/approval-ci-coverage-enumeration.test.ts:118-131`
- `packages/core-backend/tests/unit/network-unavailable-copy-ci-wiring.test.ts:63-66`
- `scripts/ops/elearning-media-ci-wiring.test.mjs:253-268`（`joinContinuedLines`）
- `apps/web/tests/AttendanceReportFieldsSection.spec.ts:137`

**确认不引用该脚本**：`scripts/ops/integration-guard-required-wiring-contract.test.mjs`
（全仓 grep `run-required-web-tests`，命中 40 个文件中代码类只有上述 7 个 + 脚本自身 + `.gitattributes`
+ 新增的两个文件，其余全是 `docs/development/*.md`）。

## 5. 登记面影响

- 本 PR **不新增任何 `apps/web` spec**，因此"两点登记"（`run-required-web-tests.sh` 与
  `scripts/ops/integration-guard-run-web-specs.sh`）**不需要追加 token**——这也正是第 1 节里
  token 集合必须 397 → 397 的原因。
- 新增的守卫在 `packages/core-backend/tests/unit/`，由后端 unit 套件自动收集，无需登记。
- `tests/unit` 内**未使用** `request(app)`（#4154 零容忍 tripwire）：新文件只读脚本文本 +
  `spawnSync('bash', ['-n'])`。

## 6. 残留 / 待办

1. **第二登记点的 37 个 token 覆盖缺口**（早于本 PR）：`scripts/ops/integration-guard-run-web-specs.sh`
   的 54 个 token 里有 37 个所收集的 spec，必跑泳道的 397 个 token 完全收不到（例如
   `tests/IntegrationWorkbenchView.spec.ts`、`tests/fieldHints.spec.ts`、`tests/bomSnapshotDiff.spec.ts`）。
   这些 spec 只在路径过滤的 integration guard 里跑，常开泳道里从不跑。补齐是**覆盖决策**，需单独 PR +
   逐 token 隔离跑绿证据。本 PR 只断言第二点仍活并记录缺口。
2. **`merge=union` 的服务端行为未证实**：GitHub 服务端合并是否读取仓库 merge driver，本仓没做过实证。
   字母序多行才是主防线；union 只是本地 rebase 兜底。
3. **union 残留 (d)**：见 3.1 表，语义无害但未被守卫覆盖。
4. **与 #5898 的 rebase**：两条 PR 都改这条登记行，后合并者按设计文档第 4 节的四步处理。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
