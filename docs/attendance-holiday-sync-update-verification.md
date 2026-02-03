# 考勤节假日同步与规则模板更新（验证记录）

日期：2026-02-03

## 验证步骤
1. **更新自动同步配置**
   - API: `PUT /api/attendance/settings`
   - Payload: `holidaySync.years=[]`, `holidaySync.auto={ enabled:true, runAt:"02:30", timezone:"Asia/Shanghai" }`
2. **空 payload 同步（验证默认年份策略）**
   - API: `POST /api/attendance/holidays/sync` with `{}`
   - 预期：服务端返回 `years=[currentYear, currentYear+1]`
3. **模板导出检查**
   - 文件存在：`docs/attendance-rule-template-holiday-first-day.json`

## 验证结果
- ✅ Settings 更新成功：`holidaySync.years=[]`，`auto.enabled=true`，`runAt=02:30`，`timezone=Asia/Shanghai`。
- ✅ 空 payload 同步返回 `years=[2026, 2027]`，2026 抓取 39/应用 39；2027 源站暂无数据（抓取 0/应用 0）。
- ✅ 模板导出文件已生成并可直接用于导入。

## 备注
- 2027 年数据依赖 `holiday-cn` 源站发布，当前仍为 0；后续发布后自动同步即可覆盖。

