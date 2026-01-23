# 考勤模块验证报告（2026-01-23）

## 基础信息
- Web URL: http://142.171.239.56:8081
- API Base: http://142.171.239.56:8081/api
- 测试用户: admin@metasheet.app（角色：admin）
- 认证方式: `POST /api/auth/login` 自动获取 JWT
- 验证方式: API 直连 + Playwright 自动化截图

## 验证结论
- 考勤插件加载与核心功能 **可用** ✅
- API 鉴权 **可用** ✅（token 已自动获取）
- 关键流程（打卡 / 请求 / 审批 / 管理设置） **可用** ✅
- 频控校验 **生效** ✅（minPunchIntervalMinutes=1 导致首次 check_out 429）

## 验证明细（API）

### 登录与鉴权
- `POST /api/auth/login` ✅ 200
  - 返回 admin 用户信息 + JWT Token

### 考勤读接口
- `GET /api/attendance/summary` ✅ 200
  - 今日摘要：`total_days=1`, `total_minutes=395`, `early_leave_days=1`
- `GET /api/attendance/records` ✅ 200
  - 今日 total=1
- `GET /api/attendance/requests` ✅ 200
  - 最新请求状态：`approved`

### 打卡流程
- `POST /api/attendance/punch`（check_in）✅ 200
- `POST /api/attendance/punch`（check_out）⚠️ 首次 429
  - 原因：`minPunchIntervalMinutes=1`
  - 使用 `occurredAt + 2min` 重试 ✅ 200

### 调整申请与审批
- `POST /api/attendance/requests` ✅ 201
- `POST /api/attendance/requests/:id/approve` ✅ 200

### 管理员接口（只读）
- `GET /api/attendance/settings` ✅ 200
- `GET /api/attendance/rules/default` ✅ 200

### 管理员接口（写入 + 清理）
- Shift：创建 ✅ / 删除 ✅
- Assignment：创建 ✅ / 删除 ✅
- Holiday：创建 ✅ / 删除 ✅

## UI 验证（截图）
- `artifacts/attendance-check-token-new.png`（有效 token 后页面正常）
- 参考对比：
  - `artifacts/attendance-check.png`（未登录：Missing Bearer token）
  - `artifacts/attendance-check-token.png`（旧 token：Invalid token）

## 遗留数据说明
- 今日（2026-01-23）创建了：
  - 1 条打卡记录（check_in / check_out 事件）
  - 1 条已审批的调整请求
- 以上记录在当前 API 中无删除接口，如需清理需 DB 侧处理。

## 建议/后续
1. 若需要持续自动化测试，建议使用独立 orgId（如 `qa-attendance`）隔离测试数据。
2. 若要避免 429，测试中应考虑 `minPunchIntervalMinutes` 配置或自动化延时。
3. 后续如需 UI 完整回归，可追加 Playwright 流程脚本（打卡/请求/审批）。

## UI 自动化验证（Playwright）
- Check In: ✅ 成功（提示 "Check in recorded."）
- Check Out: ⚠️ 提示 "Punch interval too short"（minPunchInterval=1 生效）
- Submit Request: ✅ 成功（提示 "Request submitted."）
- Approve Request: ✅ 成功（提示 "Request approved."）
- Admin Console: ✅ 可加载

### UI 证据截图
- `artifacts/attendance-ui-validation.png`
