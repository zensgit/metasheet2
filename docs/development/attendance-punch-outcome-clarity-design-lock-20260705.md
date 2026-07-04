# 考勤打卡结果清晰化（frontend-only）design-lock — 2026-07-05

> **Status: PROPOSED（delegated-execution）** — owner 2026-07-05 授权的自主执行窗口内推进的
> humanization 微切片；范围硬性锁定为 **frontend-only / 默认行为不变 / 不新增 wire 字段采集**。
> owner 回来后可修订或追认；"自动兜底"的后端半边是产品决策，全部进 §6 deferred。
> 依据：benchmark refresh v3 §3.1（自动兜底 > 手动切换）+ 2026-07-05 现状审计（§2）。

## 1. 问题（三个既有死角，全部前端可修）

1. **202 pendingApproval 被误标**：外勤审批开启的组织里，`POST /api/attendance/punch` 在
   围栏外自动转成 pending `outdoor_punch` 并返回 202 `{ pendingApproval: true, request }`
   （**不写打卡事实**）——但前端 `punch()` 把它当普通成功处理，用户以为"已打卡"，实际在等审批。
   这是正确性级别的展示 bug。
2. **`OUTDOOR_NOTE_REQUIRED` 422 死胡同**：`requireNote` 开启时缺备注被拒，但 UI 只给通用
   错误 + "重试刷新"，没有就地补备注重试的出路。
3. **`LOCATION_RESTRICTED` 403 死胡同（默认配置）**：外勤审批未开启的组织，围栏外打卡是硬
   403，UI 只给通用错误——用户不知道为什么被拒、该找谁。

## 2. 现状锚点（2026-07-05 实证）

- 前端 `punch()`：`AttendanceView.vue` ~L19391-19412——只发 `{ eventType, timezone(, orgId) }`，
  **无 location / 无 meta**；非 OK 走 `setStatusFromError(...,'refresh')` → 唯一动作 =
  通用"重试刷新"（~L13796）。员工端无内/外勤选择 UI（~L5526 hint 明言留待后续契约）。
- 后端 `enforcePunchConstraints`：`index.cjs` ~L19535-19541——`requireApproval !== true` 时
  围栏外直接 `403 LOCATION_RESTRICTED`（**先于** outdoor 分支，`meta.outdoor` 不被咨询）；
  `requireApproval === true` 时同一请求进 outdoor 分支（~L24208-24215）自动建 pending
  request 返回 202，**无需**客户端额外字段。`meta.outdoor` 只是围栏内主动外勤的备用触发。
- `isGeoAllowed` ~L5888-5897：无 location 视为围栏外 → **配置了围栏的组织，web 端每一次打卡
  都是"围栏外"**（现状行为，本切片不改变它——改变它需要采集地理位置，见 §6）。
- punch schema ~L21548-21557 接受可选 `location`/`meta`；`OUTDOOR_NOTE_REQUIRED` 的备注键名
  **由实现者从该路由实读确认**（lock 不猜键名），测试钉死。

## 3. 范围（frontend-only 三件）

| # | 改动 | 口径 |
|---|---|---|
| G1 | `punch()` 成功路径按 `data.pendingApproval === true` 分支：状态文案改为"外勤打卡已提交审批，通过后计入考勤"（info 级，非成功级），并刷新申请列表（若该 surface 已加载）；**绝不**显示"已打卡/已记录" | 纠正误导，零 wire 变化 |
| G2 | 捕获 `OUTDOOR_NOTE_REQUIRED`：就地出现备注输入 + 一键重试（重试请求 = 原 payload + 后端已接受的备注字段，**字段名以路由实读为准**）；仅该错误码触发 | 用既有契约补出路；enum-strict：未知码走原通用路径 |
| G3 | 捕获 `LOCATION_RESTRICTED`：文案升级为口径解释——"当前位置在允许打卡范围外，且本组织未启用外勤审批；如需外勤打卡请联系管理员"；**不提供**必然失败的重试按钮 | 死胡同 → 可理解的死胡同；不承诺能力 |

## 4. 硬边界

- **不采集地理位置**（`navigator.geolocation` 是隐私/产品决策 → §6）；不注入 `meta.outdoor`；
  不新增/修改任何后端行为、路由、settings；重试只携带后端**已接受**的字段。
- G2 的重试仅在后端显式 422 索要备注后发生（用户主动点击），不自动重试。
- 错误码分支 enum-strict：只对 §3 列出的两个码特判，其余保持现状通用路径（测试含未知码负例）。
- 文案 zh/en 双语走 `tr()`，不写竞品名。

## 5. 完成口径

- 前端实现（纯逻辑抽独立 `.ts` 模块——`<script setup>` 不能 export 纯函数）+ web 测试：
  202 pendingApproval 分支文案与不误标断言；`OUTDOOR_NOTE_REQUIRED` → 备注输入出现 →
  重试 payload 精确断言（含备注字段名）；`LOCATION_RESTRICTED` 文案断言；未知错误码走
  通用路径的负例；**mutation 自检**：砍掉 pendingApproval 分支 → 对应测试必须翻红。
- **新 spec 接入 `attendance-web-guard.yml`**（run 列表 + 两处 path-filter）。
- 对抗审阅 0 P1/P2 后合并。frontend-only 不设 staging 门（与 MP-5 同档）。

## 6. Deferred（owner 决策，不随本切片）

- web 端采集 `navigator.geolocation` 并随 punch 发送（隐私披露 + 权限 UX + "每次打卡都围栏外"
  现状的真正解法）；
- `requireApproval` 关闭时后端是否应受理显式 `meta.outdoor`（默认行为变更）；
- 打卡入口的状态驱动模式切换 UI（内/外勤自动感知）；
- 移动端外勤体验整线。
