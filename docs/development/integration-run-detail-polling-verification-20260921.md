# 运行详情面板轮询刷新（Q4b）— 核验（简版）

日期：2026-09-21（UTC）

## 测试

`apps/web/tests/IntegrationRunDetail.spec.ts` 新增 `describe('Q4b auto-polling', …)`，3 例，
`vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })`（`flushUi` 自己的
`setTimeout(…, 0)` 微任务泵留在真实定时器上，否则挂载/展开序列本身走不完）：

1. `re-fetches the run after RUN_DETAIL_POLL_MS while it is still non-terminal (running)` ——
   `status: 'running'` 打开面板后只有 1 次 GET；`advanceTimersByTimeAsync(5000)` 后变 2 次，
   且第二次仍打在 `DETAIL_URL`（同一 runId 路径），标签显示 `Auto-refreshing`。
2. `does not poll again once the run reaches a terminal status (succeeded)` —— 第一次读回
   `running`，定时器触发的第二次读回 `succeeded`；再推进一个 `RUN_DETAIL_POLL_MS` 后调用次数
   仍停在 2（没有第三次），标签变回 `stopped`。
3. `clears the timer when the dialog is closed, so no further reads happen` —— 打开
   （`running`，1 次调用）后点击关闭按钮，再推进 5000ms，调用次数仍是 1。

```
npx vitest run tests/IntegrationRunDetail.spec.ts --reporter=dot
# ✓ 17 tests passed (14 pre-existing SC-04/Q4a + 3 new Q4b)
```

## 变异验证

把 `isTerminalRunStatus` 临时改成恒 `return true`（`apps/web/src/views/IntegrationWorkbenchView.vue`），
重跑同一文件：

```
npx vitest run tests/IntegrationRunDetail.spec.ts -t "Q4b" --reporter=dot
# ✗ 2 failed | 1 passed | 14 skipped
#   - re-fetches the run after RUN_DETAIL_POLL_MS ...        FAIL (expected 2 got 1)
#   - does not poll again once the run reaches a terminal ... FAIL (expected 2 got 1)
```

即：把「非终态」判定坏成「永远终态」后，定时器从一开始就不会被 `scheduleRunDetailPollingIfNeeded`
启动，两条依赖“确实又拉了一次”的用例应声变红——`isTerminalRunStatus` 是这两个测试的真实断言点，
不是摆设。变异已还原（diff 对照临时备份文件确认逐字节一致），复跑同一命令回到 17/17 绿。

## 类型检查

```
npx vue-tsc -b
# 无输出（干净）
```

## 前端必跑套件（run-required-web-tests.sh）

`IntegrationRunDetail` 已经是 `apps/web/scripts/run-required-web-tests.sh` 与
`scripts/ops/integration-guard-run-web-specs.sh` 两处登记里的既有 token（#5895 落地时已加），
本次只是在同一个 spec 文件里加测试用例，没有新增 spec 文件名，因此两处登记文件都**未改动**——
按边界条款的“保留 main 行 + 追加缺的 token”规则，这里没有缺的 token 需要追加。

跑了一遍 `apps/web/scripts/run-required-web-tests.sh` 全量（约 710 例）：709 passed / 1 failed。
唯一失败是 `tests/approval-member-bar-operation-policy.spec.ts` 的
`POSITIVE CONTROL: with every flag allowed, all four deferred affordances render`，报错
`There is already an app instance mounted on the host container` + 15s 超时——单独重跑该文件
23/23 全绿（`npx vitest run tests/approval-member-bar-operation-policy.spec.ts`），确认是与本
PR 无关的并发批跑隔离性抖动（pre-existing flake），不是本变更引入的问题。

## 未跑 / 越界的检查

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/stock-prep-web-ci-coverage-enumeration.test.ts`：
  未跑。这条枚举守卫只覆盖 stock-preparation 前端 spec；`IntegrationRunDetail.spec.ts` 不在其
  枚举范围内（读过该文件确认：只登记 `Stock*` 系列组件），与本 PR 无关。
- 后端 vitest（`pnpm --filter @metasheet/core-backend test:unit`）未跑：本 PR 未改任何后端/
  packages/openapi 代码。
