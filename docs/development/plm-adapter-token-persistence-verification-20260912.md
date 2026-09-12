# 验证:PLMAdapter Bearer 令牌不再写回 config.connection(#5648 F02)

日期:2026-09-12
worktree:`C:\Users\zhou\Downloads\dev\metasheet-wt-w4d`(分支 `fix/plm-adapter-token-not-persisted-in-connection`,基线 `origin/main` = 9fb29831c)
命令一律在 `packages/core-backend` 下用仓库自带 vitest 1.6.1 执行。

## 1. 新增 spec

`packages/core-backend/tests/unit/plm-adapter-token-not-persisted.test.ts`(7 个用例)

纯单测:起一个 `127.0.0.1:0` 的本机 `http.createServer` 当上游 PLM(与 `tests/unit/dingtalk-transport-resilience.test.ts` 同款),不需要数据库。
两个测试环境坑,已在 spec 里写明:

- `connect()` 的 mock 判定看 `configService('plm.url')` / `PLM_BASE_URL`,**不是** `connection.url`;不给 `plm.url` 就会进 mock 模式,连 axios 客户端都不建。
- `tests/setup.ts:26` 全局 `vi.stubGlobal('fetch', vi.fn())`,而 yuantus 登录走全局 `fetch`;spec 在模块求值时抓住真 `fetch`,每个用例 `vi.stubGlobal` 装回、`afterEach` 还原。

| # | 用例 | 钉住什么 |
| --- | --- | --- |
| 1 | legacy:认证后 `getConfig().connection` 里没有 Authorization | 令牌不进公共配置 |
| 2 | legacy:请求仍带 `Authorization: Bearer …` | 不回归认证(在 wire 上看) |
| 3 | legacy:连接里遗留的旧 Authorization 不得盖掉刚解析的令牌 | 优先级与修前等价(老行回读) |
| 4 | yuantus:登录令牌只进请求头,不进 connection;`x-tenant-id` 不变 | 令牌 + 租户头两件事一起看 |
| 5 | 手工 `x-tenant-id` 仍是服务租户 | `getEffectiveTenantId()` 行为不变 |
| 6 | 整链:PUT 深合并 + 真实 `configToRecord` 后落库 JSON 无令牌 | 落库链复现 |
| 7 | 连接日志不回显 URL userinfo | #5648 F01 相邻点 |

## 2. 修前基线(先红)

```
 × legacy 模式:认证后 getConfig().connection 里没有 Authorization,也不含令牌串
   → expected [ 'Authorization' ] to deeply equal []
 ✓ legacy 模式:请求仍带 Authorization: Bearer …(不回归认证)
 ✓ legacy 模式:连接里遗留的旧 Authorization 头不得盖掉刚解析出的令牌(落库遗留行的回读)
 × yuantus 模式:登录拿到的令牌只进请求头,不进 connection;x-tenant-id 行为不变
   → expected [ 'Authorization' ] to deeply equal []
 ✓ 手工设置的 x-tenant-id 仍然是服务租户(getEffectiveTenantId 不变)
 × 整链:PUT 的深合并 + configToRecord 之后,落库 JSON 里没有令牌
   → expected '{"connection":{"url":"http://127.0.0.…' not to contain 'fake-static-token-for-tests-0001'
 × 连接日志不得回显 URL 里的 userinfo(#5648 F01 相邻点)
   → expected 'PLM Adapter connecting to http://plm-…' not to contain 'not-a-real-secret'

 Test Files  1 failed (1)
      Tests  4 failed | 3 passed (7)
```

4 条红正是本单要修的四点;3 条绿是"不回归"守卫,修前修后都必须绿。

## 3. 修后

```
pnpm exec vitest run tests/unit/plm-adapter-token-not-persisted.test.ts
 Test Files  1 passed (1)
      Tests  7 passed (7)
```

相邻套件(`grep -rl "PLMAdapter" packages/core-backend/tests` 里所有能离库跑的):

```
vitest run tests/unit/plm-adapter-bom-multitable.test.ts tests/unit/plm-adapter-capabilities.test.ts \
  tests/unit/plm-adapter-effective-tenant.test.ts tests/unit/plm-adapter-yuantus.test.ts \
  tests/unit/plm-embed-routes.test.ts tests/unit/federation.contract.test.ts \
  tests/unit/plm-embed-discussion-routes.test.ts tests/unit/plm-embed-discussion-read-routes.test.ts
 Test Files  8 passed (8)
      Tests  187 passed (187)

vitest run tests/unit/data-source-a5-adapter-conformance.test.ts tests/unit/data-source-connect-refusal.test.ts \
  tests/unit/data-source-credential-encryption.test.ts tests/unit/data-source-scope.test.ts \
  tests/unit/plm-workbench-routes.test.ts tests/unit/plm-disable-routes.test.ts \
  tests/contract/plm-adapter-yuantus.pact.test.ts
 Test Files  7 passed (7)
      Tests  120 passed (120)
```

类型与 lint:

```
pnpm exec tsc --noEmit        # 退出码 0,无输出
pnpm exec eslint src/data-adapters/PLMAdapter.ts   # 0 errors
```

## 4. 变异探针(内存级,不落盘)

探针用一个临时 vitest config(放在会话 scratchpad,不在仓库内)挂一个 `enforce: 'pre'` 的 vite 插件,在 `transform` 钩子里改 `PLMAdapter.ts` 的**内存源码**后再跑同一个 spec;工作树文件一个字节没动。插件在目标串找不到时直接抛错,所以"探针本身失效"不会伪装成绿。

| 变异 | 改了什么 | 结果 |
| --- | --- | --- |
| M1 | `cacheAuthToken()` 里把 `config.connection.headers.Authorization` 写回来(撤销 F02 守卫) | 3 failed / 4 passed —— 点名用例 1、4、6 |
| M2 | 日志改回打印原始 `connection.url`(撤销 F01 脱敏) | 1 failed / 6 passed —— 点名用例 7 |
| M3 | 删掉 `applyAuthTokenToClient()` 调用(令牌到不了请求) | 2 failed / 5 passed —— 点名用例 2、3 |

M1 原样输出(节选):

```
 × legacy 模式:认证后 getConfig().connection 里没有 Authorization,也不含令牌串
   → expected [ 'Authorization' ] to deeply equal []
 × yuantus 模式:登录拿到的令牌只进请求头,不进 connection;x-tenant-id 行为不变
   → expected [ 'Authorization' ] to deeply equal []
 × 整链:PUT 的深合并 + configToRecord 之后,落库 JSON 里没有令牌
   → expected '{"connection":{"url":"http://127.0.0.…' not to contain 'fake-static-token-for-tests-0001'
      Tests  3 failed | 4 passed (7)
```

M3 原样输出(节选,说明"不回归认证"的两条守卫确实带电):

```
 × legacy 模式:请求仍带 Authorization: Bearer …(不回归认证)
   → expected undefined to be 'Bearer fake-static-token-for-tests-00…'
 × legacy 模式:连接里遗留的旧 Authorization 头不得盖掉刚解析出的令牌(落库遗留行的回读)
   → expected 'Bearer stale-token-from-a-persisted-r…' to be 'Bearer fake-static-token-for-tests-00…'
      Tests  2 failed | 5 passed (7)
```

M3 下"yuantus 模式"用例仍绿,是**真实**语义:yuantus 模式的令牌由 `setTokenProvider` 的请求拦截器逐请求注入,不依赖客户端默认头;客户端默认头这条路只对 legacy/静态令牌是唯一通道。

## 5. CI 收不收(结论:目前不收,需一行 workflow 改动,本单不允许做)

- 包脚本 `packages/core-backend/package.json` 的 `test:unit` = `vitest run tests/unit`,能收本 spec;`vitest.config.ts` 的 `exclude` 里没有匹配它的条目(用默认 config 单跑已验证能被收集)。
- 但 `.github/workflows/` 里**没有**"跑整个 tests/unit"的 lane:必跑的 `test (18.x/20.x)`(`plugin-tests.yml` 的 `test` job)是逐条点名 spec 的清单(125 条 `tests/unit/...`,没有 plm-adapter-*);改 `PLMAdapter.ts` 会触发的 `yuantus-pact-consumer.yml` 只跑 `tests/contract/**` + `tests/unit/plm-adapter-yuantus.test.ts`。
- 因此本 spec 目前不会在任何 CI 检查里执行。最小接线是在 `.github/workflows/yuantus-pact-consumer.yml` 的
  `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-adapter-yuantus.test.ts` 后追加本 spec 路径(该 workflow 的 `paths` 已含 `PLMAdapter.ts`)。本单硬边界禁止改 `.github/workflows/*`,所以留给 owner/协调方决定。

## 6. 没验证 / 不确定

1. **真机未跑**:没有对接真实 PLM 验证过 legacy 静态令牌与 yuantus 登录两条链路;wire 层证据来自本机 http 服务,axios 是真的(1.8.x),但上游是假的。
2. **axios 头合并次序**靠的是本 spec 用例 3 的实测(扁平默认头赢过手工 `authorization`),不是 axios 文档承诺;axios 大版本升级时这条用例就是探针。
3. **`resolvedUrl` 写回未改**,消费者清单见设计文档 §4.1;我 grep 过 `packages/**`(ts/tsx/vue)与 `plugins/**`(ts/js/cjs)里的 `connection.headers`:除 `PLMAdapter.ts` 自身外只有 `HTTPAdapter.ts:140`(建 axios 客户端)一处;`connection.url`/`baseURL` 的消费者更多,设计文档 §4.1 只列了我实读到的那几处,不排除还有按 `getConfig()` 整体转发的调用方。
4. **历史脏数据**:库里已有的明文令牌不在本 PR 处理范围。
