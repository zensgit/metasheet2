# 验证:可回退 legacy Binding 改指向必须同写 connectionId(MIN-PR2-i / PERM-05)

- 日期:2026-09-16
- 分支:`fix/legacy-binding-datasource-change-requires-canonical`
- worktree:`C:/Users/zhou/Downloads/dev/metasheet-wt-w5l`
- 基线 HEAD:`38caaf17bfc8eeca23e23f6dfe796683d35ab525`(= `origin/main`)
- 设计文档:`docs/development/legacy-binding-canonical-invariant-design-20260916.md`

## 0. 环境

`pnpm install --frozen-lockfile` 在本 worktree 跑通(pnpm v9.15.9,`Done in 1m 21.9s`,`pnpm-lock.yaml`
未变)。两点注意:

- Git Bash 的 `PATH` 里没有 `pnpm`(`pnpm: command not found`,exit 127),要用
  `C:/Users/zhou/AppData/Roaming/npm/pnpm.cmd` 全路径。
- 装之前本 worktree 完全没有 `node_modules`。本次涉及的插件套件除
  `sealed-export-s6a-product-runtime`(需要 `pg`)外都是零依赖的纯 `node` 脚本,装前装后结论一致;
  装完之后连 `sealed-export-s6a-product-runtime` 也一起绿。CI 仍是裁判。

## 1. 改动文件

```
 .../__tests__/external-systems.test.cjs            | 38 ++++++----
 .../lib/external-systems.cjs                       | 82 +++++++++++++++++++++-
 plugins/plugin-integration-core/test-chain.txt     |  1 +
 3 files changed, 107 insertions(+), 14 deletions(-)
```

外加两个新文件:`plugins/plugin-integration-core/__tests__/legacy-binding-canonical-invariant.test.cjs`、
本文与设计文档。`package.json` 未动(它整文件被 `runtimeFiles.pluginPackageJson` 钉住)。

## 2. 先红

### 2.1 基线行为探针(内存,零落盘)

在 `origin/main` 的代码上,回滚形态的行被静默改指向:

```
BEFORE  {"pointer":"ds-1","connection_id":null,"legacy":true}
UPSERT   RESOLVED (no refusal)
AFTER   {"pointer":"ds-2","connection_id":null,"legacy":true}
```

改动后同一探针:

```
BEFORE  {"pointer":"ds-1","connection_id":null,"legacy":true}
UPSERT   REJECTED LEGACY_BINDING_DATASOURCE_CHANGE_REQUIRES_CONNECTION_ID
AFTER   {"pointer":"ds-1","connection_id":null,"legacy":true}
```

### 2.2 新套件对 `origin/main` 的 lib(从 git 对象库读出、只进 `require.cache`,不落盘)

```
[baseline] origin/main copy of plugins/plugin-integration-core/lib/external-systems.cjs injected (61669 bytes)
✗ legacy-binding-canonical-invariant FAILED
AssertionError [ERR_ASSERTION]: expected the canonical-invariant refusal, got: null
    at testRepointWithoutConnectionIdIsRefused (.../__tests__/legacy-binding-canonical-invariant.test.cjs:195:10)
```

("got: null" = upsert 根本没抛,即静默改指向。)

### 2.3 被改写的既有套件对 `origin/main` 的 lib

```
✗ external-systems FAILED
AssertionError [ERR_ASSERTION]: Missing expected rejection: even the owner cannot silently repoint a rollback-eligible legacy binding
```

> 说明:`__tests__/external-systems.test.cjs` 的 `testBridgeEditPreservesFullConfig` 第 4 组原本断言
> "an owner may repoint the binding"(owner 可以直接改指向)。那正是本规则要禁的行为,所以这组被改写成
> "拒绝 + 存量原样",并在注释里指向新套件承载转 canonical 的正路。这是本 PR 唯一一处**改写既有断言**,
> 方向是收紧。

## 3. 后绿

```
legacy-binding-canonical-invariant: silent re-point refused OK
legacy-binding-canonical-invariant: migrated dual-reference re-point refused OK
legacy-binding-canonical-invariant: connectionId converts the row to canonical OK
legacy-binding-canonical-invariant: same-pointer and pointer-free edits unaffected OK
legacy-binding-canonical-invariant: clearing allowed, clear-then-set bypass closed OK
legacy-binding-canonical-invariant: canonical rows keep their existing refusal OK
legacy-binding-canonical-invariant: non sql-readonly kinds untouched OK
legacy-binding-canonical-invariant: ownership still refused first OK
✓ legacy-binding-canonical-invariant: MIN-PR2-i tests passed
```

八组的对应关系:

| # | 断言 | 对应设计条款 |
| --- | --- | --- |
| 1 | 回滚形态(connection_id NULL + 标记 TRUE)改指向 → 抛新码;零 `updateRow`;指针/标记/canonical id 全不变;错误消息与 details 不含 `ds-1`/`ds-2`/行 id/租户/名称/object | §2、§4 values-free |
| 2 | 迁移双引用形态(connection_id 已写 + 标记 TRUE)改指向 → 同一个码,不再是顺带的 `CONNECTION_BINDING_MISMATCH` | §2 |
| 3 | 同写 `connectionId` → `connection_id` 更新、标记置 FALSE、旧指针被清、`dataSourceOwnerId` 重新盖章、其余 config 保留;之后的无关编辑不会让标记复活 | §4 后两条 |
| 4 | 重复提交同一指针 / 不提指针 / 完全不带 config → 行为与改前一致,仍是 legacy | §5 |
| 5 | 显式清空仍允许;"先清后设"第二步照样被拒 | §5 最后一行 |
| 6 | 标记 FALSE 的 canonical 行仍然拿 `CONNECTION_BINDING_MISMATCH`(本守卫对它零影响) | §5 |
| 7 | `data-source:sql-write-gated` 行照常改指针;且对它提供 `connectionId` 会被既有校验拒(证明补救手段对该 kind 不存在,所以守卫必须分 kind) | §5、§7 与 #5449 |
| 8 | 非 owner 仍先被 binder 的 "not found" 拦下,拿不到新错误码,零写入 | §4 调用点位置 |

## 4. 相邻套件

所有引用 `upsertExternalSystem` 或 `legacy_connection_fallback_eligible` 的插件套件(34 支)全绿:

```
b2a-trial-registry-wiring                            PASS
external-systems                                     PASS
external-systems-list-workspace-fallback             PASS
gip-connector-kind-registry                          PASS
http-routes                                          PASS
http-routes-plm-k3wise-poc                           PASS
integration-connection-binding-migration             PASS
integration-hub-overview                             PASS
k3-external-write-permanent-fence                    PASS
k3-sqlserver-external-write-fence-parity             PASS
legacy-binding-canonical-invariant                   PASS
plugin-runtime-smoke                                 PASS
schema-mapping-copilot-routes                        PASS
stock-preparation-carry-confirm                      PASS
stock-preparation-carry-hardening                    PASS
stock-preparation-carry-target-binding               PASS
stock-preparation-customer-pack-routes               PASS
stock-preparation-dry-run-target-field-probe-routes  PASS
stock-preparation-ext-field-mapping-wiring           PASS
stock-preparation-handoff                            PASS
stock-preparation-large-bom-installed-fields-wiring  PASS
stock-preparation-mvp-persist-target-field-probe-routes PASS
stock-preparation-mvp-repair-routes                  PASS
stock-preparation-operator-project-directory         PASS
stock-preparation-operator-pull-gate                 PASS
stock-preparation-operator-scope-tripwires           PASS
stock-preparation-operator-value-read-scope          PASS
stock-preparation-own-base                           PASS
stock-preparation-permission-matrix                  PASS
stock-preparation-preflight                          PASS
stock-preparation-prep-line-export                   PASS
stock-preparation-project-board                      PASS
stock-preparation-source-binding-routes              PASS
stock-preparation-source-preflight                   PASS
```

pin 与测试链守卫:

```
sealed-export-package-provenance.test.cjs OK
sealed-export-s6a-product-runtime                    PASS
✓ test-chain-completeness: 222 suites, all executed by `pnpm test` (0 intentional exclusions)
```

`sealed-export-package-provenance` 会把冻结清单里的 40 条逐文件 sha256 重算比对;它在改动后仍然 OK,
就是"本 PR 没碰任何被 pin 的文件"的经验证据(静态核查见设计文档 §8.2)。
`test-chain-completeness` 从 221 变 222,正是新增的这一支。

## 5. 变异(内存级 `require.cache` 注入,零落盘)

做法:把 `lib/external-systems.cjs` 读进内存、按锚点改一处、`Module._compile` 后塞进
`require.cache[<真实路径>]`,再 `require` 套件。工作树里该文件是 CRLF(`core.autocrlf=true`),
探针先归一成 LF 再匹配锚点;锚点必须**唯一**命中一次,否则探针以 exit 2 自曝而不是假绿。
(M1 本身能变红,反过来也证明 `require.cache` 注入确实生效——注入失败的话跑的就是未变异的源码,只会变绿。)

| 变异 | 去掉什么 | 结果 | 首个失败断言 |
| --- | --- | --- | --- |
| M1 | 守卫调用(:729) | RED | `expected the canonical-invariant refusal, got: null` |
| M2 | 标记退役(:742 置 false) | RED | `a proven canonical re-bind retires the rollback marker in the same write` |
| M3 | 旧指针清理改回读 `existing.` 标记(:760) | RED | `and the legacy pointer goes with it: marker FALSE must never coexist with a legacy pointer` |
| M4 | 守卫的 kind 判断 | RED | 守卫误伤 `data-source:sql-write-gated`,抛 `LEGACY_BINDING_DATASOURCE_CHANGE_REQUIRES_CONNECTION_ID` |
| M5 | 守卫的"指针未变"早返 | RED | 同上错误,误伤"改名时重复提交同一指针" |
| M6 | 守卫的"写入为空即放行"早返 | RED | 同上错误,误伤显式清空 |
| M7 | 守卫的 legacy 标记判断 | RED | `and it refuses with the pre-existing resolver code, so this guard changed nothing for it`(canonical 行被误伤) |
| M8 | 守卫对"已显式给 connectionId"的放行 | RED | 同上错误,转 canonical 的正路被自己的守卫堵死 |

另外 M1 对**既有**套件也红:

```
✗ external-systems FAILED
AssertionError: Missing expected rejection: even the owner cannot silently repoint a rollback-eligible legacy binding
```

未变异时 8/8 组全绿(§3),即每一条判断都有"去掉它就红"的证据,且每条早返也都有"删掉它就误伤"的证据。

## 6. 没做的事

- 没有 push,没有开 PR。
- 没碰 `lib/http-routes.cjs`、`package.json`、`.github/`、任何 stock-prep 文件、任何 pin 文件。
- 没有新增 HTTP 路由用例:400 来自 `inferHttpStatus` 既有的类名规则(设计文档 §6),加路由用例要动
  `http-routes` 相关的夹具,收益不抵 pin/冲突风险。
- 没有对存量数据做巡检或修复(设计文档 §9)。
- 没有跑完整 222 支链(只跑了 34 支相关套件 + 3 支 pin/链守卫);完整链交给 CI。
