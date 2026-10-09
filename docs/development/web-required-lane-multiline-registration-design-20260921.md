# 必跑 web 泳道登记行多行化 — 设计（Q8 / C4 P1）

- 日期：2026-09-21（UTC）
- 分支：`chore/web-required-lane-multiline-registration`
- 目标文件：`apps/web/scripts/run-required-web-tests.sh`
- values-free：本文与全部改动只涉及仓内脚本文本与 token 名，不含主机 / IP / 凭据。

## 1. 问题

`apps/web/scripts/run-required-web-tests.sh` 末尾那条 `exec npx vitest run …` 在 `origin/main`
（96cd7b57c）上是**一条 11410 字节的单物理行**，携带 **397 个 token**。它是全仓并发冲突最密集的一行：

- 2026-09-01 → 2026-09-20 之间被改动 **76 次**；
- 每条新增 web spec 的分支都要往这**同一条物理行**追加 token；
- 于是 n 条在飞分支两两冲突 —— **O(n²)** 次三方合并，且每次冲突的"冲突块"就是整条 11KB 行，
  人工/自动 resolve 极易丢 token（丢 token = 某个 spec 从必跑泳道静默消失，而泳道仍然绿）。

插件侧的同类问题（`package.json` 的 `scripts.test` 巨行）已由 **#5420** 用
`test-chain.txt` + `merge=union` 根治。本 PR 是同一处方的 web 版。

## 2. 方案

### 2.1 主防线：一行一个 token + 大小写不敏感字母序

```
exec npx vitest run \
  amountAutoSum \
  approval-amount-in-words \
  …
  xlsx-mapping \
  --reporter=dot
```

规则：两个空格缩进、行尾 ` \` 续行、最后一行 `  --reporter=dot`（无续行）。

**字母序是承重的，不是洁癖。** 如果新 token 可以落在任何位置，所有人都会往末尾追加，末尾就成了新的
争用行，多行化白做。排序让"我的 token 落在哪一行"成为其名字的**纯函数**，两条分支只有在两个新
token 名字字母序相邻时才可能碰到同一个 hunk。因此排序是**断言**而非 lint 偏好。

> 先例：本文件里早已有**两处**多行形式的 vitest 调用
> （`apps/web/scripts/run-required-web-tests.sh:501-538` 与 `:566-596`）。本 PR 是把该形状推广到
> 争用最严重的那条（`:1257-1655`，397 个 token）。

### 2.2 兜底：`.gitattributes` 的 `merge=union`

```
apps/web/scripts/run-required-web-tests.sh text eol=lf merge=union
```

- `eol=lf`：这是 shell 脚本，且多处守卫按物理行解析它；CRLF 检出会让 `endsWith('\')` 类续行判定
  全部失效。`core.autocrlf=true` 的 Windows 检出没有这条规则就会写回 CRLF。
- `merge=union`：**仅作本地 `git merge` / `git rebase` 的兜底**。
  **GitHub 服务端合并是否读取仓库 merge driver，本仓未做实证，故不作保证**（这一点在
  `.gitattributes` 的注释里也写明了）。它是字母序多行之外的第二层，不是主防线。

### 2.3 解析契约：去注释 → 拼接续行 → 取唯一 exec 逻辑行

多行化会**打断所有按物理行解析该文件的守卫**：`line.startsWith('exec npx vitest run ')` 现在只匹配
到 header，其唯一"token"是续行反斜杠。本 PR 在同一 commit 内转换了三处：

| 守卫 | 路径 |
| --- | --- |
| 备料 web 覆盖枚举 | `packages/core-backend/tests/unit/stock-prep-web-ci-coverage-enumeration.test.ts` |
| G2 web 证人入册 | `plugins/plugin-integration-core/__tests__/stock-preparation-handoff.test.cjs:2884` |
| 考勤 web 守卫契约 | `apps/web/tests/attendance-web-guard-workflow.spec.ts` |

**亲读确认无需改动**（已拼接续行或不依赖该形状）：

- `packages/core-backend/tests/unit/approval-ci-coverage-enumeration.test.ts:118-131`
- `packages/core-backend/tests/unit/network-unavailable-copy-ci-wiring.test.ts:63-66`
- `scripts/ops/elearning-media-ci-wiring.test.mjs:253-268`（`joinContinuedLines`）
- `apps/web/tests/AttendanceReportFieldsSection.spec.ts:137`

`scripts/ops/integration-guard-required-wiring-contract.test.mjs` 经 grep 全仓确认**不引用**
`run-required-web-tests`，无需改动。

### 2.4 结构守卫

新增 `packages/core-backend/tests/unit/required-web-lane-registration-shape.test.ts`（18 项）：

1. `bash -n` 通过（Windows 无 bash 时 skip、CI 上必须有，见文件内注释）；
2. 恰好一条 `exec npx vitest run` **逻辑行**（bash 只会到达第一条 exec，后面的全是死代码）；
3. 一行一个参数、两空格缩进、以 `--reporter=dot` 收尾、块必须终止（无 EOF 悬挂续行）；
4. token 无重复；
5. **大小写不敏感字母序**；
6. 尾部 flag 只有 `--reporter=dot`（混进 `-t` 会静默收窄泳道）；
7. `.gitattributes` 里那条 pin 仍在；
8. 第二登记点 `scripts/ops/integration-guard-run-web-specs.sh` 仍是单条 vitest 调用、可被同一套解析读取；
9. parser decoys + **M1–M5 内存级变异自证**（见验证文档）。

### 2.5 集合等价的机械证明

新增 `scripts/ops/required-web-lane-token-set-diff.mjs`：比较任意两个 revision 的 token **集合**
（不是序列 —— 序列变成字母序正是本次的目的）。重排只有在交给 vitest 的 filter 集合**逐字相等**时
才安全；少一个 token = 某 spec 静默不再跑而泳道仍绿，是这类"卫生"改动最坏的结局。

## 3. 明确不做

- **不改第二登记点的 token 集合。** 实测：两点集合既不相等也不互相包含；第二点 54 个 token 里有 37 个
  收集到的 spec 文件是必跑泳道 397 个 token **完全收不到**的。这是一个真实覆盖缺口，但它**早于**本次
  改动，补齐意味着往必跑泳道加 37 个 token —— 那是覆盖决策、不是形状决策，应当单独开 PR 并逐 token
  给"隔离跑绿"证据。此处只断言第二点仍活、记录缺口。
- **不碰 #5898 的文件。** 见下。

## 4. 与 #5898 的协调

`#5898`（OPEN，`test(web): guard run-required-web-tests.sh shape (exactly one live exec line)`）
同时在改这条登记行，并新增 `apps/web/tests/run-required-web-tests-shape.spec.ts`。按边界规则，本 PR
**不触碰它的任何文件**。两者会在 `apps/web/scripts/run-required-web-tests.sh` 上冲突，后合并者按下列
方式 rebase：

1. **保留本 PR 的多行块**（它是本 PR 的全部内容）；
2. 把 #5898 的新 token `run-required-web-tests-shape` **按字母序插入**到块内
   （实测字母序邻居：`routePreviewErrors` 之后、`searchApprovalDirectoryUsers` 之前；注意 #5898
   当前把它写在 `--reporter=dot` **之后**，多行形状要求它回到 flag 之前）；
3. 把 #5898 的 `parseExecLines` 由物理行解析改为"去注释 → 拼接续行 → 取唯一 exec 逻辑行"
   （可直接照抄 `apps/web/tests/attendance-web-guard-workflow.spec.ts` 里
   `requiredLaneExecCommand` 的实现，同在 `apps/web` 下）；
4. 跑 `node scripts/ops/required-web-lane-token-set-diff.mjs origin/main` 确认集合只多了那一个 token。

#5898 的 "exactly one live exec line" 断言与本 PR 的第 2 条守卫是同一不变量，合并后二者共存不冲突。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
