# 运行详情轮询两处请求竞争修复——验证记录（#5950 复审 N1/N2）

日期：2026-09-21 · 设计：`integration-run-detail-polling-races-design-20260921.md`

## 新增的真实行为反例

`apps/web/tests/IntegrationRunDetail.spec.ts` 的 `Q4b auto-polling` 下新增 4 例。全部走真实 Vue
视图 + apiFetch/URL 接缝（与 owner 探针 `polling-review.config.cjs` 同一接缝），用手动 resolve 的
deferred promise 决定响应到达顺序；fake 只作用于 `setInterval`/`clearInterval`。

| 用例 | 交错 | 断言 |
|---|---|---|
| N1 初次读 | 打开详情、GET 挂起 → 卸载 → GET 返回 running | `vi.getTimerCount()===0`；推进 10 秒 GET 次数仍为 1 |
| N1 后台 tick | tick GET 挂起 → 卸载 → 返回 running | 同上，GET 次数仍为 2 |
| N1 溯源重拉 | 溯源已展开，tick 的 run 读已回、溯源重拉挂起 → 卸载 → 重拉返回 | 同上 |
| N2 | 手动刷新挂起 → tick 发出并先返回 → 手动返回 | 刷新按钮可用、loading 提示消失；再推进 5 秒仍会轮询（GET 次数 4） |

## 旧代码红（c919db1c4 的视图 + 新 spec）

视图文件在 c919db1c4 与本分支基线 1746f9606 之间无差异（`git diff --stat` 为空），先只落 spec
不改视图跑：

```
cd apps/web && pnpm exec vitest run tests/IntegrationRunDetail.spec.ts --watch=false --silent --reporter=verbose
× N1: an initial read still in flight at unmount cannot re-arm polling when it lands
  AssertionError: no interval may be armed after unmount: expected 1 to be +0
× N1: a background tick in flight at unmount cannot re-arm polling when it lands
  AssertionError: no interval may be armed after unmount: expected 1 to be +0
× N1: a provenance re-pull in flight at unmount cannot re-arm polling when it lands
  AssertionError: no interval may be armed after unmount: expected 1 to be +0
× N2: a background tick that lands before a pending manual refresh does not leave the button stuck
  AssertionError: a completed manual refresh must release its loading state: expected true to be false
Tests  4 failed | 17 passed (21)
```

## 新代码绿

```
cd apps/web && pnpm exec vitest run tests/IntegrationRunDetail.spec.ts tests/IntegrationWorkbenchView.spec.ts --watch=false --silent --reporter=verbose
Test Files  2 passed (2)
Tests  82 passed (82)
```

其中 `IntegrationRunDetail.spec.ts` 21/21（原 17 + 新 4）。`cd apps/web && pnpm exec vue-tsc -b`
退出码 0。

## 登记

未新增 spec 文件，`IntegrationRunDetail` 已在 `run-required-web-tests.sh` 与
`scripts/ops/integration-guard-run-web-specs.sh` 中登记，两处未改动。

## 本记录不证明的

- 未跑 `run-required-web-tests.sh` 全量，只跑了上面两个直接相关的 spec。
- 未在浏览器或 222 上复现；证据仅为 jsdom 下的真实视图测试。
- N1 的两道闸（token 失效与 `runDetailDisposed`）在当前三个迟到分支上是冗余的，测试不区分哪一道
  单独生效。
