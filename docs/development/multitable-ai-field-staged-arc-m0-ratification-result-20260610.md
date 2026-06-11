# AI 字段 staged 主线 — M0 批准结果(ratification result)— 2026-06-10

> Status: **RATIFIED(决策批准记录;实现解锁另行显式授予,见 §3)**
> 批准对象:`multitable-phase3-lane-a1-ratification-table-20260515.md`(#1571,该表保持 as-landed 只读,不改写;本文档即批准行为本身的落档)
> 批准人:owner(2026-06-10,会话内逐项确认)· 配套:arc 计划/TODO `multitable-ai-field-staged-arc-*.md`

## 1. Owner 修正(两条,构成批准的一部分)

**修正一(批准 ≠ 实现解锁)**:#1571 自身明确为 "read-only decision packet / not ratified",且其 K3 宏观门是独立门。因此:本文档完成的是**决策批准**;**A1(M1)实现开工额外需要 owner 显式解除/覆盖 AI 线的旧 defer gate**(原 Phase 3 冻结姿态)。在该显式解锁落档前,M0 状态 = "决策已批准、实现仍 deferred"。设计锁定(docs-only)不属实现,可在批准后先行。

**修正二(R-2/内部路由的适用范围限定)**:admin-only RBAC 与 OpenAPI Option B(internal route)**仅适用于 A1 readiness / operator config 面**。A2/A3 的 preview/run/display 是**产品路径**,不得继承 admin-only / internal-route 心智——届时必须在各自 design-lock 中按 sheet/field/record 权限与写入边界重新设计(写入走 RecordWriteService 权威路径;读回显遵守字段读闸)。

## 2. 批准矩阵(全部按推荐 + 上述修正)

| 项 | 决议 |
|---|---|
| R-1(平台 JWT 中间件) | **接受** |
| R-2(admin 标志) | **接受,仅限 A1**(修正二) |
| R-3(不建新权限原语) | **接受** |
| OpenAPI | **B(internal route),仅限 A1**;A2/A3 在各自 design-lock 重评(修正二) |
| 响应 shape | **defer 到实现 PR**(跟 main 先例) |
| E-1..E-12(env 变量名契约) | **全部接受** |
| P-1(provider 白名单) | **接受 anthropic + openai**;Azure/Bedrock 后续需另过 key-shape/redaction 审查 |
| Q-1..Q-4(默认配额) | **接受 100k/500k tokens、30 rpm、$10/day**;A1 声明、A2 执行(数值 A2 时可复议,变量名即刻定死) |
| T-framing | **确认**:A1 不关闭 T1/T3/T6;A2 关 T1/T6;A3 关 T3 展示 |

## 3. 实现解锁记录

- [x] ✅ **M1 实现解锁 — 已授予(2026-06-10)**:owner 同日在会话内显式回复 **"解锁"**,解除 AI 线旧 defer gate、授权 M1 实现。自此 M1b 实现 PR 的唯一前置 = M1a 设计锁定合并。
- M1 **设计锁定**(docs-only)不受此格阻塞,依据 §1 修正一在批准后先行(已同日落档:`multitable-ai-provider-readiness-a1-design-20260610.md`)。

## 4. 效力边界

本批准只覆盖 A1 声明层决策;不授权 A2/A3 任何实现;不触碰 central RBAC/auth;真实 provider 调用另受 `MULTITABLE_AI_CONFIRM_LIVE_REQUESTS` 双确认门(M2 起)。
