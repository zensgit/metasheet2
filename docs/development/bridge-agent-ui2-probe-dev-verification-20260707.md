# BA-UI-2 — Bridge Agent values-free 一键探测 · 开发/验证报告 — 2026-07-07

> Design-lock: `docs/development/bridge-agent-admin-page-design-lock-20260707.md`(#3792,RATIFIED;
> owner granted the full BA-UI ladder 2026-07-07)§3 BA-UI-2。前置:BA-UI-1 = #3824
> (`bridge-agent-ui1-observability-dev-verification-20260707.md`)。Demand anchor:#3746(保持 OPEN)。
> 本片 = 纯只读、用户触发、顺序 early-stop 的 values-free smoke:零写路径、零凭据路径变更、零新路由、
> 零持久化(证据是组件短暂状态)。BA-UI-3(配置校验 + 变更建议清单)是后续独立切片,本片不实现其任何部分。

## 1. 范围与做法(vs lock §3 BA-UI-2 逐条)

| lock §3 BA-UI-2 条款 | 实现 |
| --- | --- |
| 每系统「一键探测」按钮 | 每张 Agent 状态卡新增 `bridge-agent-probe-<id>` 按钮(与既有「检查连接」并列),用户触发,无轮询/调度。 |
| health→objects→schema 顺序执行 | `runProbe()` 顺序 `await`:step1 health、step2 objects、step3 schema-of-sampled-object;上一步不 ok 直接 `return`,后一步的 service 调用**根本不发生**。 |
| 走 BA-UI-1 既有通用端点 | 复用同三个 service 函数:`testExternalSystemConnection`(POST `/:id/test`)、`listExternalSystemObjects`(GET `/:id/objects`)、`getExternalSystemSchema`(GET `/:id/schema?object=`)。**零新路由**(见 §2)。 |
| 每步证据 = ok/durationBucket/counts/coarse code | 见 §3 证据词表。 |
| overall PASS \| FAIL(哪一步) + 固定 values-free 指引 | `overallLabel()` → `PASS` 或 `FAIL: <失败步>`;失败步渲染 IU-1 label + 固定/IU-6-hint 指引行。 |
| 复用既有 values-free evidence 词表,不另造词表 | 错误显示与指引全部经既有 `errorCodeLabels.ts`(`integrationErrorCodeDisplayLabel` / `integrationErrorCodeHint`);计数/布尔/桶为通用显示 idiom,无新词表模块。 |
| raw errorMessage 永不渲染 | 沿用 BA-UI-1 纪律:step.code 只透传 health 的注册码;objects/schema 抛错**不捕获 message**(code 恒为 `null`→降级通用「未知错误」label)。 |

## 2. 零新路由确认(zero-new-route)

**采用:ZERO new backend routes,ZERO backend files touched。** 唯一改动文件 =
`IntegrationBridgeAgentSection.vue` + 其 spec(add-only)。探测的三步全部落在 BA-UI-1 已在消费的三条**通用**
只读端点上,无任何新 service 函数、无新 `apiFetch` URL 形状:

| 探测步 | 复用的既有 service | 落到的既有路由 | BA-UI-1 已用? |
| --- | --- | --- | --- |
| health(step 1) | `testExternalSystemConnection` | `POST /api/integration/external-systems/:id/test` | ✅(状态卡「检查连接」) |
| objects(step 2) | `listExternalSystemObjects` | `GET /api/integration/external-systems/:id/objects` | ✅(对象列表自动加载) |
| schema(step 3) | `getExternalSystemSchema` | `GET /api/integration/external-systems/:id/schema?object=` | ✅(schema 预览按需) |

`POST /query/:object`(数据面取数)**不被本片调用**(lock §4)——happy-path 测试断言探测发出的每个 URL 都
匹配 `test|objects|schema` 三端点之一,且 `object=material`(采样对象名)。

## 3. 证据词表(evidence vocabulary:key → type → source)

全部 values-free:count / boolean / 粗粒度桶 / coarse label。无 host/credential/tenant/config-id/row 值,
无 raw errorMessage。

| 证据 key | 类型 | 来源(值从哪来) | 备注 |
| --- | --- | --- | --- |
| `overallPass` | boolean(`PASS`/`FAIL: <步>`) | 派生:所有步 ok 且无 failedStep | 渲染为 `data-result=pass\|fail` + 文本 |
| `step` | 闭集枚举 `health\|objects\|schema` | 探测器自身流程 | 渲染为人话 label(`健康检查`/`对象列表`/`Schema 预览`) |
| `ok` | boolean | health:`result.ok===true`;objects/schema:`!threw` | 渲染 `ok: true\|false` + `data-ok` |
| `durationBucket` | 闭集 `<1s\|1-5s\|>5s` | `Date.now()` 差值经 `bucketFor()` 分桶 | **粗粒度桶,绝不渲染原始毫秒**(避免为 infra 指纹);skip 的 schema 步无此字段 |
| `objectCount` | number | objects 步:`objects.value.length`(仅成功时) | 计数,非对象名/值 |
| `fieldCount` | number | schema 步:采样对象的 `schema.fields.length`(仅成功时) | 单个**采样**对象的字段数;非字段名/值 |
| `skipped` | boolean(schema 步专属) | objectCount===0 时置真 | 空 allowlist 无对象可采样 = **不是失败**,标记 skipped;overall 仍 PASS |
| 失败步 error label | string(闭集 label) | `integrationErrorCodeDisplayLabel(step.code, locale)` | health 传注册码→其 label;objects/schema code 恒 `null`→通用「未知错误」 |
| 失败步 guidance | string(闭集/固定文案) | 注册码有 hint 则取 `integrationErrorCodeHint`(IU-6 hint 风格),否则固定 per-step fallback | 保证失败必渲染一行 values-free 指引 |

`step.code` 字段说明(纪律):只有 health 失败会带真实注册码(其响应含 `.code`);objects/schema 失败抛出的
`Error` **不携带** machine-readable code(BA-UI-1 scout 结论:`workbench.ts` 的 `parseIntegrationResponse`
只保留 `.message`),故 code 恒 `null`。把 `null` 经同一 IU-1 label helper 仍得到 coarse values-free
「未知错误」label —— **刻意不特判**,复用既有降级路径。

## 4. Early-stop 证明

- **代码**:`runProbe()` 中 health 不 ok → `failedStep='health'; return`(objects/schema 的 `await` 从不到达);
  objects 不 ok → `failedStep='objects'; return`(schema 的 `getExternalSystemSchema` 从不调用)。
- **测试**(`probe: a failure at the objects step early-stops before schema`):objects mock 返回 500,断言
  (a)overall = `FAIL: Objects`;(b)`bridge-agent-probe-step-schema-<id>` DOM 节点**不存在**(该步从未 push);
  (c)`apiFetchMock.mock.calls` 中**无** `/schema` 调用。三条同时成立 = early-stop 证据。
- **区分 skip vs 失败**:objects 返回 `[]`(空 allowlist)→ schema 步标 `skipped`、overall 仍 `PASS`、
  且 `/schema` 同样不发(nothing to sample),与失败 early-stop 是两条不同路径(各有独立测试)。

## 5. Sentinel 说明

探测证据是新的渲染面,故新增两个 sentinel 断言(在 BA-UI-1 既有 sentinel 之上,ADD-ONLY):
`SENTINEL via probe`(成功 + 失败双路径)与 `zh copy: probe evidence` 顺带覆盖。

- **成功路径**:默认 fixtures 已带敌意载荷 —— objects payload 的 `connectionString` 额外 key
  (`SENTINEL.objectExtra`)、schema payload 的 `defaultValue`/`raw.leaked`(`SENTINEL.schemaExtra`)、
  test 响应的 secret-laden `message`(`SENTINEL.testMessage`)。跑完探测后断言 `SENTINEL` 全部 9 条在
  `innerHTML` 与 `textContent` 双面均不出现。
- **失败路径**:health mock 返回敌意非闭集 `code`(`SENTINEL.hostileCode`,内嵌 `secret=`)+ secret-laden
  `message`,断言同样零泄漏,且 error label 降级为「Unknown error」。
- 机制:计数/布尔/桶从不透传字符串值;objects/schema 抛错走 catch 但**不读 message**;error label 只出
  IU-1 映射结果(`code=null`→「未知错误」);durationBucket 是闭集桶,非原始毫秒。

## 6. Mutation 证明(基线 commit 后注入→跑→红→精确 revert)

| # | 变体 | 预期 | 结果 |
| --- | --- | --- | --- |
| M1 | 删除 objects 步的 `return`(保留 `failedStep='objects'` 但去掉 early-stop,schema 步继续跑) | early-stop 测试红 | **RED**(1 failed:schema 步节点出现 + `/schema` 被调用)✅ killed |
| M2 | objects 步 render 追加 `raw: {{ (objects[0] as any)?.connectionString }}`(把敌意额外 key 泄漏进 DOM) | SENTINEL-via-probe 测试红 | **RED**(1 failed:`SENTINEL.objectExtra` 出现在 DOM)✅ killed |

### 6.1 执行记录

两变体各单独注入 → `vitest run IntegrationBridgeAgentSection` 确认 **RED**(各 1 failed / 15 skipped)→
精确路径 `git checkout -- IntegrationBridgeAgentSection.vue` 复原 → 重跑确认 **GREEN**(16/16)。基线在两次
mutation **之前**已 commit(52f5f93cb),两次 revert 后工作树回到基线、无残留。

## 7. 测试与构建矩阵

| 面 | Node 25(默认) | Node 20(nvm,CI 同版) |
| --- | --- | --- |
| `IntegrationBridgeAgentSection` spec(BA-UI-1 10 + BA-UI-2 6 = 16 tests) | ✅ 16/16 | ✅ 16/16 |
| integration-guard 19-spec 全列表 | ✅ 229/229 | ✅ 229/229 |
| ui-foundation-style-guard(TARGET_FILES 已含本组件,token-only) | ✅ 77/77 | —(纯 fs 扫描,版本无关) |
| `vue-tsc -b` | ✅ clean | — |
| `pnpm build`(apps/web) | ✅ built | — |

CI 面:`integration-guard.yml` 的 pull_request/push `paths` 与 vitest run 列表**在 BA-UI-1(#3824)已收编**本
组件 + 本 spec —— 本片仅编辑既有文件(非新增),无需改 workflow/style-guard TARGET_FILES/新注册。

## 8. 改动清单

| 文件 | 类型 |
| --- | --- |
| `apps/web/src/components/integration/IntegrationBridgeAgentSection.vue` | 编辑(add-only:探测按钮 + 证据卡 + probe 逻辑 + import `integrationErrorCodeHint` + 局部样式) |
| `apps/web/tests/IntegrationBridgeAgentSection.spec.ts` | 编辑(add-only:6 个 BA-UI-2 tests) |
| `docs/development/bridge-agent-ui2-probe-dev-verification-20260707.md` | 新增(本文) |

## 9. 边界外(维持冻结)

BA-UI-3(配置校验 + 变更建议清单)/ BA-UI-4(计划任务运行态)各需独立 opt-in;本片未实现其任何部分。
本片无导出、无持久化、无写路径、无凭据路径变更、无新路由(lock §6 零开门维持)。
