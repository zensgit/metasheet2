# 考勤节假日策略与规则引擎 - 验证报告

日期：2026-02-04

## 环境
- Web：`http://142.171.239.56:8081`
- API：`http://142.171.239.56:8081/api`

## 验证步骤
1. UI 进入 `Attendance` 页面，刷新规则集列表。
2. 打开默认规则集 `考勤规则-正式`，确认规则中包含模板 `节假日首日基准工时`。
3. 读取系统配置（API）：确认节假日同步与策略字段存在。
4. 通过 `PUT /api/attendance/settings` 写入“春节覆盖模板”（含考勤组/角色/用户/天数过滤），随后 `GET` 回读核对。
5. 在 DB 中确认节假日数据包含 `春节-2`（2026-02-16）。
6. 调用导入预览接口：验证覆盖策略在 `春节-2` 上按过滤条件生效。

## 结果
- UI：规则集包含 `节假日首日基准工时` ✅
- API：`holidayPolicy` 与 `holidaySync` 配置字段可读 ✅
- API：`holidayPolicy.overrides` 可读且可写（含过滤字段） ✅
- 规则引擎：`holiday_policy_enabled` 可用于跳过模板 ✅
- 导入预览：覆盖项命中 `春节-2` 时工时调整为 8 小时，含提示 `节假日第2天按8小时` ✅
- 导入预览：`单休车间 + 仓库员（非熊洪州）` 命中“按实际出勤”覆盖，`workMinutes=0`、无节日补贴 ✅

## 覆盖项验证记录
- `PUT /api/attendance/settings` 写入覆盖模板（顺序优先）：
  - 例外补贴：`roles=[工段长]` / `userNames=[熊洪州]` / `attendanceGroups=[单休办公]`（`dayIndexStart=1`~`6`，`firstDayBaseHours=8`）
  - 管理岗补贴：`roles=[总经理助理, 财务部经理, ...]`（`dayIndexStart=1`~`6`，`firstDayBaseHours=8`）
  - 按实际出勤：`attendanceGroups=[保安]`、`attendanceGroups=[单休车间]`、`roles=[仓库员, 下料]`（`firstDayEnabled=false`）
  - `GET /api/attendance/settings` 回读：覆盖项存在且值一致 ✅

## 预览样例
- `2026-02-16 (春节-2)` + `单休办公 / 工段长` ⇒ `workMinutes=480`、`warnings=[节假日第2天按8小时]`
- `2026-02-16 (春节-2)` + `单休车间 / 仓库员 / 李四` ⇒ `workMinutes=0`、`warnings=[]`

### API Preview 摘要
```json
{
  "items": [
    {
      "workDate": "2026-02-16",
      "workMinutes": 480,
      "status": "adjusted",
      "warnings": ["节假日第2天按8小时"]
    },
    {
      "workDate": "2026-02-16",
      "workMinutes": 0,
      "status": "off",
      "warnings": []
    }
  ]
}
```

## 备注
- 本次验收未运行自动化测试，仅进行 UI 与 API 级别核验。
- 已补充导入预览验证（`/api/attendance/import/preview`）。
- 如需回归验证：建议补充 import 提交与批处理规则验证。

## 验收产物
- UI 截图：`artifacts/ui/attendance-holiday-overrides.png`
- 覆盖区截图：`artifacts/ui/attendance-holiday-overrides-section.png`
- API settings：`artifacts/api/attendance-settings.json`
- API preview：`artifacts/api/attendance-preview.json`

### UI 截图说明
! 详见 `artifacts/ui/attendance-holiday-overrides.png` 与 `artifacts/ui/attendance-holiday-overrides-section.png`
