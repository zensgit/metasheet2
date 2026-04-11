# MetaSheet 考勤 vs Frappe HR / OrangeHRM / Kimai 差距矩阵

Date: 2026-04-04

## 1. 结论

当前 `main` 上的考勤能力，已经达到：

- **可交付、可试点、可 on-prem 部署**

但还没有达到：

- **成熟 HR/考勤产品级完整度**

更准确地说，当前状态属于：

- **核心链路可用**
- **管理员能力较完整**
- **员工自助与报表体系还有明显深化空间**

如果审批中心由另一条线程独立推进，那么本线程完全可以继续深化考勤，但应聚焦：

1. 员工自助工作台
2. 总览 / 报表真正分层
3. 导入导出和设备接入能力
4. 计薪与周期汇总产品化

## 2. 判断基准

本矩阵基于两类事实：

1. **当前主仓实际代码状态**
   - `apps/web/src/views/attendance/**`
   - `apps/web/src/views/AttendanceView.vue`
   - `packages/core-backend/**`
   - 当前 `main` 上已经通过的 release / smoke / on-prem 交付链
2. **当前仍活跃的开源产品能力表述**
   - Frappe HR
   - OrangeHRM
   - Kimai（含审批扩展生态）

不把另一个窗口正在开发中的“完整审批中心”算入本线程当前成果。

## 3. 当前主仓考勤能力概览

### 3.1 已落地的主要前端入口

- `/attendance`
- `AttendanceExperienceView.vue`
- `AttendanceOverview.vue`
- `AttendanceAdminCenter.vue`
- `AttendanceWorkflowDesigner.vue`
- `AttendanceView.vue`

### 3.2 已落地的主要能力

- 员工侧总览
  - summary / records / requests / anomalies / holidays
- 申请能力
  - leave
  - overtime
  - missed_check_in
  - missed_check_out
- 状态机
  - pending / approved / rejected / cancelled
- 管理端
  - 班次
  - 排班
  - 轮班规则 / 轮班排班
  - 节假日
  - 请假类型
  - 规则集 / 规则模板 / 结构化规则构建器
  - 导入批次 / 导入工作流
  - 审计日志
  - 计薪模板 / 计薪周期
- on-prem 交付
  - attendance 包
  - platform/multitable 包
  - smoke / preflight / package verify / release gate

### 3.3 当前已经可交付的部分

- 核心 attendance API
- 核心审批状态机
- request -> approve -> records settlement
- 导入模板 / preview / commit / export smoke
- 权限隔离
- 平台包下普通员工 attendance 自助权限
- `ENABLE_PLM=0` 的 platform 壳

## 4. 最值得参考的开源软件

### 4.1 Frappe HR

官方仓库：

- <https://github.com/frappe/hrms>

官方资料：

- <https://frappe.io/hr/shifts-and-attendance>
- <https://frappe.io/hr/leave-management>
- <https://github.com/frappe/biometric-attendance-sync-tool>

最适合借鉴：

- 班次 / 轮班 / 自动考勤
- 请假与考勤规则的结合
- 打卡设备与生物考勤同步
- HR 配置面板的信息架构

### 4.2 OrangeHRM

官方仓库：

- <https://github.com/orangehrm/orangehrm>

官方资料：

- <https://help.orangehrm.com/hc/en-us/articles/360036161154-How-to-use-Leave-Module>
- <https://help.orangehrm.com/hc/en-us/articles/49813414590617-How-to-use-OrangeHRM-Attendance-Module-Admin>

最适合借鉴：

- 员工自助入口
- 请假 / 审批 / 门户式 UX
- HR 管理导航分层
- 员工与管理员视角分离

### 4.3 Kimai

官方仓库：

- <https://github.com/kimai/kimai>

官方资料：

- <https://www.kimai.org/documentation/>
- <https://www.kimai.org/documentation/permissions.html>
- <https://github.com/KatjaGlassConsulting/ApprovalBundle>

最适合借鉴：

- timesheet / export / report 结构
- 权限模型和角色隔离
- 审批列表与周期间统计体验

### 4.4 OpenHRMS

官方仓库：

- <https://github.com/CybroOdoo/OpenHRMS>

官方资料：

- <https://www.openhrms.com/leave-and-attendance-manager/>

定位判断：

- OpenHRMS 更像 **Odoo 上的一组 HR 插件模块集合**
- 它不是 MetaSheet 这种“平台壳 + feature flag + on-prem 包”的产品形态

最适合借鉴：

- attendance regularization（补卡/考勤修正）流程
- shift / overtime / holiday / vacation 的模块拆分
- leave policy / leave approval 规则拆分

不适合作为主参考：

- 平台壳信息架构
- 前端导航设计
- on-prem 发布与交付链
- 非 Odoo 体系下的应用承载方式

## 5. 差距矩阵

| 能力域 | 当前 MetaSheet 状态 | 推荐参考 | 差距等级 | 优先级 |
|---|---|---|---|---|
| 员工自助首页 | 基础可用，但更像数据页，不像员工工作台 | OrangeHRM | 中 | 高 |
| 总览 vs 报表分层 | 已分入口，但产品语义仍偏近 | Kimai / OrangeHRM | 中到高 | 高 |
| 申请创建与状态机 | 已可用 | Frappe HR / OrangeHRM | 低 | 低 |
| 审批中心统一产品 | 正在另一线程推进 | OrangeHRM / ApprovalBundle | 高 | 由另一线程处理 |
| 班次 / 排班 / 轮班 | 已具备核心能力 | Frappe HR | 中 | 高 |
| 自动考勤与设备接入 | 规则具备，但设备同步链仍薄 | Frappe HR | 高 | 高 |
| 请假类型 / 政策建模 | 已有基础模型 | Frappe HR / OrangeHRM | 中 | 中 |
| 导入模板 / CSV 全流程 | 已有基础，但实施体验仍可加强 | Frappe HR | 中 | 高 |
| 导出 / 统计 / 周期报表 | 已有基础，但管理报表深度不足 | Kimai | 中到高 | 高 |
| 计薪模板 / 计薪周期 | 已有基础 API 与管理面 | Kimai / Frappe HR | 中 | 中到高 |
| 审计与操作追踪 | 已具备 | Kimai | 低到中 | 中 |
| 员工移动端体验 | 可访问，但并非产品级移动 UX | OrangeHRM | 高 | 中 |
| 通知 / inbox / 催办 | 仍较薄 | OrangeHRM / Frappe HR | 高 | 中 |
| 实施与交付链 | 已较强 | 当前已领先多数开源方案 | 低 | 低 |

## 6. 已经接近成熟产品的部分

### 6.1 管理后台 breadth

当前 MetaSheet 的管理端 breadth 已经很高：

- 班次
- 排班
- 轮班
- 规则集
- 节假日
- 请假类型
- 导入
- 审计
- 计薪

这意味着现在的主要问题不是“没有模块”，而是：

- 模块之间的产品闭环不够强
- 员工视角完成度不够高
- 报表和实施体验还能更顺

### 6.2 on-prem 交付链

与很多开源 HR/考勤系统相比，当前仓库在：

- package build
- package verify
- preflight
- smoke
- release gate
- operator artifact

这条链已经非常完整，属于当前优势项。

## 7. 差距最大的部分

### 7.1 员工自助体验

当前 `/attendance` 虽然可用，但更像“功能集合页”，不是员工真正的工作台。

仍缺：

- 更强的个人首页叙事
- 我的问题 / 我今天 / 我这周 / 待处理事项
- 申请与结果回写的清晰反馈
- 面向员工的低认知负担路径

这块最值得参考 OrangeHRM。

### 7.2 总览与报表产品语义

目前“总览”和“报表”已经不是同一页面，但仍偏近：

- 总览还承载了部分报表性信息
- 报表还不够像管理分析台

这块最值得参考 Kimai：

- 周期统计
- 人员/项目/类型维度切片
- 导出即分析

### 7.3 设备接入与自动考勤深度

当前规则引擎和班次/轮班已在，但设备接入和自动考勤产品化深度不够。

仍缺：

- 更明确的打卡源接入策略
- 生物设备同步工具链
- 自动考勤异常闭环
- 补卡后规则重算 / 追溯更新的可解释性

这块最值得参考 Frappe HR。

## 8. 本线程建议避免的写入范围

因为另一个窗口正在做“完整审批中心”，本线程应避免直接改这些区域：

- `apps/web/src/views/ApprovalInboxView.vue`
- `packages/core-backend/src/routes/approvals.ts`
- `packages/core-backend/src/routes/approval-history.ts`

本线程更适合改：

- `apps/web/src/views/attendance/**`
- `apps/web/src/views/AttendanceView.vue`
- attendance import/export/report/scheduling/payroll 相关 API 与 UI

## 9. 建议的下一阶段路线

### Phase A: 员工自助工作台

目标：

- 让 `/attendance` 更像员工首页，而不是功能集合页

建议内容：

- 我的今日状态
- 我的异常
- 最近打卡
- 我的申请状态
- 待处理事项提示

主要参考：

- OrangeHRM

### Phase B: 总览 / 报表彻底分层

目标：

- 总览 = 即时状态
- 报表 = 周期分析 / 导出 / 管理视角

建议内容：

- 总览保留 summary / anomalies / recent records
- 报表集中 request report / payroll summary / manager filters / CSV export

主要参考：

- Kimai

### Phase C: 导入导出 + 设备接入深化

目标：

- 让实施与真实考勤接入更顺

建议内容：

- 更清晰的 mapping profile
- 模板下载与错误回显强化
- 生物考勤/打卡源同步链
- 导入后影响报告和追溯解释

主要参考：

- Frappe HR

## 10. 综合判断

### 如果目标是：

**“继续把考勤做深，但不和审批中心撞车”**

结论：

- **完全可以继续**

### 如果目标是：

**“下一条最值钱的深化开发”**

结论：

- **先做员工自助工作台 + 总览/报表分层**

### 如果目标是：

**“下一条最值得参考的开源主样板”**

结论：

- **主参考选 Frappe HR**
- **员工自助 UX 补看 OrangeHRM**
- **报表/导出/统计体验补看 Kimai**

## 11. 参考优先级建议

建议的参考优先级：

1. **Frappe HR**
   - 主参考
   - 重点看班次、自动考勤、设备接入
2. **OrangeHRM**
   - 补员工自助和 HR 门户 UX
3. **Kimai**
   - 补报表、导出、统计体验
4. **OpenHRMS**
   - 只作为流程与模块拆分补充参考

一句话判断：

- **OpenHRMS 值得看**
- **但更适合抄“业务流程点子”**
- **不适合当 MetaSheet 考勤的主产品蓝本**

## 12. 推荐外部口径

建议内部表述为：

> MetaSheet 当前考勤已经具备可交付的核心链路和较完整的管理后台；下一阶段应从“功能可用”转向“员工自助、报表体系、设备接入和产品完成度”。

不建议表述为：

> 考勤已经做完，只剩审批中心。
