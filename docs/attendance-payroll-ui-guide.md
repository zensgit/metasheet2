# 计薪周期 UI 操作指引

日期：2026-02-03

## 入口
Attendance 页面 → Payroll 区块

## 1) 创建计薪模板（Payroll Templates）
1. 点击 **Reload templates**
2. 填写模板参数：
   - Name：`CN Payroll 26-25`
   - Timezone：`Asia/Shanghai`
   - Start Day：`26`
   - End Day：`25`
   - End Month Offset：`1`
   - Auto Generate：✅
   - Default：✅
3. 点击 **Create template**

## 2) 生成计薪周期（Payroll Cycles）
1. 选择模板（上一步创建的模板）
2. Anchor Date 填写：`2026-02-02`
3. 点击 **Create cycle**（生成单周期）

> 多周期生成目前仅 API 支持（`/api/attendance/payroll-cycles/generate`）。

## 3) 生成摘要 / 导出
1. 选择某个 cycle 并点击 **Load summary**
2. 点击 **Export summary** 下载 CSV

## 常见问题
- 若提示已存在周期：同一 `startDate~endDate` 只能存在一次（系统会跳过重复周期）。
