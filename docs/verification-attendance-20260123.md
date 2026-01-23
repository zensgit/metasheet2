# MetaSheet2 Attendance 验证报告 (2026-01-23)

## 基础信息
- 环境: 测试 / 预发
- Web URL: http://142.171.239.56:8081
- API Base: http://142.171.239.56:8081/api
- 版本/Commit: 92ae0962
- 插件: plugin-attendance (Active)

## 验证范围与结果
- 登录认证: ✅ Pass
- Grid 核心: ✅ Pass
- 插件加载: ✅ Pass (11 个插件)
- 考勤模块 API (读写): ✅ Pass
- 考勤模块 UI (MCP): ✅ Pass

## API 验证 (读)
- /api/attendance/summary ✅
- /api/attendance/records ✅
- /api/attendance/requests ✅
- /api/attendance/rules/default ✅
- /api/attendance/settings ✅
- /api/attendance/shifts ✅
- /api/attendance/assignments ✅
- /api/attendance/holidays ✅
- /api/attendance/export ✅ (CSV 正常输出)

## API 验证 (写)
### Punch
- check_in ✅
  - event id: 074fcb02-b72a-4bc7-a4f2-75b05606100e
- check_out ✅
  - event id: 729ce899-3a3d-40ed-af65-fd6633f91ec5

### Requests
- 创建 time_correction ✅
  - id: 698e39dd-4a6b-43e6-a74a-ad6e0a148c4c
  - approve ✅
- 创建 missed_check_out ✅
  - id: ec0f9c26-9233-4218-9fc6-7b53f90a42a5
  - reject ✅

### Settings
- minPunchIntervalMinutes: 1 → 2 → 1 ✅ (更新与回滚)

## UI 验证 (MCP)
- 进入 /attendance
- MCP 写入 auth_token 并刷新
- Summary 区块已加载: Total days=1, Total minutes=360, Early leave=1
- Records 表格显示 1 条记录: 2026-01-23, Work 360, Status Early leave
- 未出现 Missing/Invalid token 提示

## 数据清理
已清理本次验证写入的测试数据:
- attendance_requests: 3
- attendance_events: 2
- approval_records: 3
- approval_instances: 3

清理后计数复核均为 0。

## 结论
Attendance 插件后端/前端功能正常，读写接口与 UI 均通过验证，可进入下一阶段联调或验收。
