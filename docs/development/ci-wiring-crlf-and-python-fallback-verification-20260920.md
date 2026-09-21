# ci-wiring 守卫：CRLF 归一 + Python ENOENT 回退（验证）

- 日期：2026-09-20（`date` 实测 `Sun, Sep 20, 2026 11:08:58 AM`）
- 基线：`origin/main` = `1a6663a41`
- 本机：Windows 11、node v25.9.0、检出为 CRLF（`file` 报 `with CRLF line terminators`）、
  `python3` 不在 PATH（`py -3` 与 `python` 可用，均带 PyYAML）

值面说明：本文件只出现仓库内路径、退出码与计数，不含主机 / IP / 凭据。

## 1. 基线复现（改动前，`1a6663a41`）

整批 `node --test --test-reporter=tap scripts/ops/*-ci-wiring.test.mjs`：**38 个里 36 个红。**

典型报错两类：

```
Error: real-DB step contract: failing CLOSED — python3 could not be spawned for the YAML parse
       (spawnSync python3 ENOENT).
```

```
AssertionError: test.exclude must contain the exact quoted entry
                'tests/integration/directory-account-external-key-collision-mechanism.db.test.ts'
```

CRLF 解析退化的直接计数（真实 `packages/core-backend/vitest.config.ts`）：

```
CRLF entries: 462   LF entries: 400
CRLF junk (entry contains CR or NL): 201
```

## 2. 改动后本机整批结果

`node --test --test-reporter=tap` 逐文件（pass / fail）：

| 守卫 | 改动前 | 改动后 |
| --- | --- | --- |
| approval-browser-ci-wiring | 0 / 1 | 0 / 1（**未修，见残余 R1**） |
| approval-data-closure-ci-wiring | 12 / 0 | 12 / 0 |
| attendance-w4c2-ci-wiring | 16 / 26 | 260 / 2（**余 2 = 残余 R2**） |
| b4-department-bindings-ci-wiring | 2 / 1 | 3 / 0 |
| b5a-routing-policy-ci-wiring | 2 / 1 | 3 / 0 |
| b5b-failclose-ci-wiring | 2 / 1 | 3 / 0 |
| b5b-routing-resolver-ci-wiring | 2 / 1 | 3 / 0 |
| b5c-routing-routes-ci-wiring | 2 / 1 | 3 / 0 |
| b6-equivalence-ci-wiring | 2 / 1 | 3 / 0 |
| b7-reconciliation-ci-wiring | 2 / 1 | 3 / 0 |
| b7-round2-ci-wiring | 2 / 2 | 4 / 0 |
| dingtalk-worker-drain-ci-wiring | 2 / 0 | 2 / 0 |
| directory-access-graph-mutex-ci-wiring | 2 / 1 | 3 / 0 |
| directory-activation-source-lock-ci-wiring | 2 / 1 | 3 / 0 |
| directory-deprovision-ledger-ci-wiring | 2 / 1 | 3 / 0 |
| directory-deprovision-writer-ci-wiring | 2 / 1 | 3 / 0 |
| directory-grant-table-ci-wiring | 2 / 1 | 3 / 0 |
| elearning-admin-access-ci-wiring | 3 / 1 | 4 / 0 |
| elearning-assignment-lifecycle-ci-wiring | 3 / 1 | 4 / 0 |
| elearning-batch-assignment-ci-wiring | 3 / 1 | 4 / 0 |
| elearning-jobs-ci-wiring | 5 / 1 | 6 / 0 |
| elearning-media-ci-wiring | 11 / 4 | 15 / 0 |
| elearning-notification-delivery-ci-wiring | 3 / 1 | 4 / 0 |
| elearning-notification-worker-ci-wiring | 5 / 1 | 6 / 0 |
| elearning-training-plan-assignment-ci-wiring | 3 / 1 | 4 / 0 |
| elearning-training-plan-ci-wiring | 3 / 1 | 4 / 0 |
| elearning-v01-auth-ci-wiring | 2 / 1 | 3 / 0 |
| elearning-v01-content-assessment-ci-wiring | 6 / 2 | 8 / 0 |
| multitable-d2-archive-ci-wiring | 4 / 2 | 6 / 0 |
| multitable-exact-anchor-ci-wiring | 31 / 6 | 37 / 0 |
| pb4-2-archive-readonly-ci-wiring | 2 / 1 | 3 / 0 |
| pb4-3-cycle-detection-ci-wiring | 2 / 1 | 3 / 0 |
| pb4-4-reactivation-ci-wiring | 2 / 1 | 3 / 0 |
| stock-preparation-p4-repair-ci-wiring | 2 / 1 | 3 / 0 |
| stock-prep-browser-ci-wiring | 0 / 1 | 0 / 1（**未修，见残余 R1**） |
| t1-org-transfer-ci-wiring | 2 / 1 | 3 / 0 |
| t2gate-collision-mechanism-ci-wiring | 6 / 20 | 40 / 0 |
| t2-source-freeze-ci-wiring | 4 / 2 | 6 / 0 |

**36 红 → 3 红，且剩余 3 个的红与本 PR 的根因无关（R1 / R2）。**

另外两个受同一桥影响的非 `*-ci-wiring` 守卫：

| 守卫 | 改动前 | 改动后 |
| --- | --- | --- |
| `python-interpreter.test.mjs`（新增） | — | 11 / 0 |
| `integration-guard-required-wiring-contract.test.mjs` | 进程级崩溃（0 / 1） | 56 / 6（余 6 = 残余 R3） |

## 3. CI（Linux / LF）行为不变的证明

### 3.1 仓库内断言

`t2gate-collision-mechanism-ci-wiring.test.mjs` 新增三条用例，随守卫在 CI 上跑：

1. `synthetic: a CRLF fixture parses byte-identically to the same fixture with LF endings`
   —— 同一夹具的 CRLF / LF 两版，数组体 `assert.equal`（逐字节）、条目 `deepEqual`、条数相等、
   任何条目都不含行终止符。
2. `synthetic: LF input is passed through untouched — the returned body is a literal substring of
   the ORIGINAL source` —— 断言返回体**原样出现在未经改动的 LF 源里**。若归一在 LF 上改了任何一个
   字节，这条必红。
3. `synthetic: the real vitest.config.ts parses identically whether the checkout is CRLF or LF`
   —— 同样的对照跑在真实 `packages/core-backend/vitest.config.ts` 上，不会随夹具腐化。

### 3.2 与 `origin/main` 的逐字节对照（离线脚本，内存加载两个版本）

把 `origin/main` 的 `ci-realdb-step-contract.mjs` 与 HEAD 版本各自以 `data:` URL 导入，喂同一批
LF 输入：

```
LF-identical: packages/core-backend/vitest.config.ts (body 150826 chars, 400 entries)
LF-identical: packages/core-backend/vitest.integration.config.ts (body 53 chars, 2 entries)

OK — 8 LF inputs parse IDENTICALLY on origin/main and HEAD (CI behavior unchanged)
```

8 个输入 = 2 个真实配置 + 6 个合成边角（空串、无 `exclude`、注释里带撇号、只有
`coverage.exclude`、行尾注释、`test :` / `exclude:[` 间距变体）。对照项为
`extractTestExcludeArrayBody` 的返回值（`assert.equal`，字符串逐字节）、`quotedExcludeEntries`
的数组、以及每个条目的 `isQuotedInTestExclude`。

## 4. PyYAML 桥 stdin 改动在 UTF-8 locale 下是恒等变换

对 `.github/workflows` 下**全部 136 个** yml，分别用旧表达式 `sys.stdin.read()` 与新表达式
`sys.stdin.buffer.read().decode("utf-8")` 跑同一段桥程序，`PYTHONIOENCODING=utf-8 PYTHONUTF8=1`
（模拟 ubuntu-latest 的 locale）：

```
OK — 136 workflow files: old and new stdin expressions produce IDENTICAL output under a UTF-8 locale
```

对照项是 exit status 与 stdout 全文。

反向对照（本机原生 cp936 locale，`plugin-tests.yml`）：

```
native locale: OLD exit=4 (YAML_PARSE_ERROR: ReaderError('<unicode string>', 2157, 56468, 'unicode', 'special charact…)
native locale: NEW exit=0
```

即：旧写法在 CI 上正确、在本机假红；新写法两边都正确。

## 5. 变异自证（内存级，零落盘）

每个变异把被测模块源码在**内存里**改一处，编码成 `data:text/javascript` URL 再 `import`，工作树
全程未被写入。控制组 = 未变异模块，必须绿。

| # | 变异 | 结果 |
| --- | --- | --- |
| CONTROL | 不变异 | **GREEN** ✅ |
| M1 | 去掉 `extractTestExcludeArrayBody` 首行的 `src.replace(/\r\n?/g, '\n')` | **RED** ✅ |
| M2 | `quotedExcludeEntries` 注释剥离退回 `/\/\/.*$/` | **RED** ✅ |
| M3 | 桥的 stdin 退回 `sys.stdin.read()` | **RED** ✅（本机 locale 下 exit 4） |
| M4 | `spawnPythonSync` 改成"任何失败都回退"（`res.error \|\| res.status !== 0`） | **RED** ✅ |
| M5 | 去掉回退循环（只试 `python3`） | **RED** ✅ |
| M6 | 转发时丢掉 `py -3` 的 `prefixArgs` | **RED** ✅ |

M4 是本 PR 唯一的绿色旁路风险点，单列一条：变异后 `python3` 上 exit 4（真实 YAML 解析失败）会被
拿去 `python` 重试，探针断言"只调用了 python3"因此红。

`scripts/ops/python-interpreter.test.mjs` 的 11 条 stub 驱动用例把同一组判据固化进 CI：
候选顺序、ENOENT 逐级回退、`py -3` 前缀位置、status 3 / 4 不回退、EACCES 不回退、
全 ENOENT 时返回最后一个仍带 `.error` 的结果、options 原样透传、调用方 args 不被变异。

## 6. 残余

- **R1 `approval-browser` / `stock-prep-browser`**：`Cannot find module 'js-yaml'`。这两个守卫依赖
  npm 包，需要先 `pnpm install`（在 CI 里它们跑在装过依赖的泳道）。与本 PR 的三个根因无关，未动。
- **R2 `attendance-w4c2` 余 2 条**：`EPERM: operation not permitted, symlink …`
  （`scripts/ops/attendance-w4c2-ci-wiring.test.mjs:3308` 与 `:3786`）。Windows 未开开发者模式时
  建符号链接需要权限，与解析无关。Linux CI 无此问题。
- **R3 `integration-guard-required-wiring-contract` 余 6 条**：`classify()` / `resolve-diff` 两组
  CLI 用例（`:1446`、`:1707` 起）。它们 spawn node 脚本并检查 `$GITHUB_OUTPUT` 写入，属于另一类
  Windows 环境差异；本 PR 只改了该文件的 YAML 桥，其余 56 条由崩溃变为通过。
- **R4 其它仍直接 `spawnSync('python3', …)` 的脚本**未接入共享解析：
  `scripts/ops/dingtalk-interactive-card-stream-staging-uat-contract.test.mjs:1360`、
  `scripts/ops/dingtalk-lifecycle-staging-canary-contract.test.mjs`（5 处）、
  `scripts/ops/dingtalk-oauth-stability-metrics-only-contract.test.mjs:44`、
  `scripts/ops/github-dingtalk-oauth-stability-summary.test.mjs:18`（用的是异步 `spawn`）。
  同一改法可以照搬，另开一波。
- **R5 `dist-sdk` / `build.mjs`**：本波未涉及，按分工另开（Q7b）。
- **R6** `multitable-exact-anchor-ci-wiring.test.mjs` 与 `ci-realdb-step-contract.mjs` 仍各持一份
  `maskCommentsAndStrings` / exclude 解析。本 PR 只把两份都修对，没有做收敛——收敛会动断言面，
  应当单独一 PR。

## 7. 复跑方式

```sh
# 整批守卫
for f in scripts/ops/*-ci-wiring.test.mjs; do node --test --test-reporter=tap "$f"; done

# 新模块自身
node --test scripts/ops/python-interpreter.test.mjs

# 托管它的已接线守卫（CI 走这条）
node --test scripts/ops/t2gate-collision-mechanism-ci-wiring.test.mjs
```
