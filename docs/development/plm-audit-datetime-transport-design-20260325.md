# PLM Audit Datetime Transport Design

## 背景
- `PLM Audit` 的 `from/to` 过滤同时穿过了 4 层：`datetime-local` 输入、route query、team view state、client save/list round-trip。
- 现状里这 4 层并没有统一合同：
  - `PlmAuditView.vue` 内部直接把 `datetime-local` 字符串保存在本地 state。
  - `buildPlmWorkbenchTeamViewShareUrl()` 和多数 team-view fixture 已经把 audit 时间当作 ISO transport。
  - `loadLogs()/exportCsv()` 又在提交前临时 `new Date(...).toISOString()`。
- 结果是同一份 audit 时间在不同层可能出现两种编码：
  - 本地输入串：`2026-03-11T15:00`
  - canonical transport：`2026-03-11T07:00:00.000Z`

## 目标
- 把 `route query`、`team view state`、`client request/response` 统一成单一 canonical transport。
- 保留 `datetime-local` 输入体验，不把 ISO `Z` 直接灌进输入框。
- 保证 share URL、saved team view、audit route replay 和 client save/list 的时间语义稳定可回放。

## 方案
- 新增 [`plmAuditDateTimeTransport.ts`](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditDateTimeTransport.ts) 作为唯一 helper。
  - `normalizePlmAuditDateTimeTransport(value)`：
    - 空值返回空串。
    - 合法时间一律转成 `Date(...).toISOString()`。
    - 非法值返回空串。
  - `formatPlmAuditDateTimeInputValue(value)`：
    - 把 canonical transport 格式化回浏览器本地 `YYYY-MM-DDTHH:mm` 输入串。

## 状态合同
- `PlmAuditRouteState.from/to`：
  - 内部和 route transport 一律保存 canonical ISO transport。
- `PlmAuditTeamViewState.from/to`：
  - 一律保存 canonical ISO transport。
- `PlmAuditView.vue`：
  - `from/to` ref 保存 canonical transport。
  - `fromInput/toInput` ref 专门服务 `datetime-local` 输入。
  - route/team-view hydration 时，先写 canonical transport，再格式化输入值。
- `plmWorkbenchClient.ts`：
  - audit team-view list/save round-trip 统一走 canonical transport。

## 实现点
- [`plmAuditQueryState.ts`](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditQueryState.ts)
  - `parsePlmAuditRouteState()` 规范化 `auditFrom/auditTo`
  - `buildPlmAuditRouteQuery()` 输出 canonical transport
  - `buildPlmAuditTeamViewState()` / `buildPlmAuditRouteStateFromTeamView()` 规范化时间字段
- [`PlmAuditView.vue`](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue)
  - 输入层切到 `fromInput/toInput`
  - `loadLogs()` / `exportCsv()` 直接使用 canonical `from/to`
- [`plmWorkbenchClient.ts`](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/services/plm/plmWorkbenchClient.ts)
  - audit team view state 的 `from/to` 在 list/save 两侧都归一化

## 不做的事
- 不改 saved view 存储结构。
- 不改后端 API 合同。
- 不新增秒级输入精度，继续以 `datetime-local` 的分钟粒度为准。
