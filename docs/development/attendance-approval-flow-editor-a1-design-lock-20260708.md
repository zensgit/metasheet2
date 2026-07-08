# 考勤审批流·结构化步骤编辑器(档 A1)design-lock — 2026-07-08

> **Status: RATIFIED（owner 2026-07-08 拍板启动档 A、A1 范围锁死;基于 3 路调研
> `attendance-approval-convergence-analysis-20260708.md` + owner 三处纠正）。** display/authoring 层,
> **考勤执行引擎与后端 approval-flow 端点零改动**。

## 1. 问题(owner 纠正后的准确表述)

考勤页「审批流」创建流程 = 裸 JSON 文本框(`步骤(JSON)` textarea)。真痛点**不是**"JSON 必炸"(FE `parseApprovalStepsInput` 挡非法 JSON、后端 normalize)——
而是 **UX 太差 / 语义弱 / 不可发现 / 易配成空审批或兜底 admin**。且暴露一个真 bug:
后端 `REQUEST_TYPES` 有 8 种,FE 下拉只暴露 6 种(**漏 `outdoor_punch`/`schedule_dispatch`**),
外勤表单却提示"去审批流建 outdoor_punch 类型"——该类型不在下拉里,无法创建。

## 2. 架构定位(owner 纠正后)

- 底座:考勤与审批中心**共用 `approval_instances` 表**(桥接迁移),但**同池 ≠ 同一流程定义系统**——
  考勤有自己的 `attendance_approval_flows` + steps + request-type finalizer;审批中心是 `approval_templates`→graph。
- 「子集」限定:仅**审批人/步骤表达能力**层面考勤 ⊂ 审批中心;**终态副作用不是子集**(补卡/外勤/换班/调度
  在终态事务写考勤事实/排班/成员/记录,中央 graph 不可替代)。
- 故 A1 **不碰执行**:只把 authoring 从 JSON 升级为结构化,产出仍落 `attendance_approval_flows.steps`(形状不变)。

## 3. A1 范围（owner 逐条锁定）

新组件 `AttendanceApprovalFlowStepsEditor.vue`(仿 `AttendanceUserPickerField` 独立可测),替换 JSON textarea:
- **步骤增删改 + 上下移**(顺序即审批级次)。
- **审批人·用户**:复用既有 `AttendanceUserPickerField`(真目录选择)。
- **审批人·角色**:角色为字符串 ID(本系统无角色目录),chip/tag 输入(回车/逗号分隔,展示为标签)。
- **活跃/停用**:沿用 `approvalFlowForm.isActive`。
- **request type 完整暴露**:下拉列全部 8 种 `REQUEST_TYPES`(补 `outdoor_punch`/`schedule_dispatch`);
  `formatRequestType` 补这两个 label。
- **保存前预览最终 steps JSON**(只读代码块)——owner 明确要;让管理员确认将写入的内容。
- **authoring 期护栏(不改 runtime)**:空步骤列表 / 某步既无用户又无角色 → 保存前**可见警告**
  (surfacing owner 关切的"空审批/兜底 admin",但不改后端 finalize 语义;是否硬 block 由 owner 定,默认软警告 + 允许保存)。

产出 payload 与 `saveApprovalFlow` 现状**逐字节一致**(`{name,requestType,steps,isActive,orgId}`);
后端 `/api/attendance/approval-flows` POST/PUT、执行 `resolveRequest`、`loadApprovalFlow` **零改动**。

## 4. 保全 / fail-closed

- step 模型 = `{name?, approverUserIds?, approverRoleIds?}`(现状),结构化编辑器**无损往返**。
- 防未来漂移:编辑既有 flow 若 steps 含编辑器未建模的键 → **保留原值不丢**(round-trip 透传未知键)+
  提供"查看原始 JSON"只读逃生口(镜像审批中心 fail-closed 不静默拍扁纪律)。v1 现模型不会触发,属防御。
- 不新增后端字段/迁移/OpenAPI;不改 request 提交与审批执行。

## 5. 明确 OUT（= A2 / 档 B,不混入 A1）

- 直属上级 / 部门主管 / 多级上级 resolver = **A2**(动考勤引擎路由 + 运行时兜底语义,独立设计锁 + 反向测试)。
- 会签/或签/条件/并行/表单 schema = 审批中心能力,考勤引擎不支持 → 编辑器**不呈现**(不假装支持)。
- 考勤请求发起中央模版 + 终态回写闭环 = **档 B**(战略候选,治理门冻结,另起)。

## 6. 测试契约

`AttendanceApprovalFlowStepsEditor.spec.ts`:步骤增删改/上下移;用户 picker 值进 approverUserIds;角色 chip 进 approverRoleIds;
往返(load 既有 steps → 编辑 → emit 等价 steps)无损;未知键透传保留;空步骤/空审批人警告。
`attendance-admin-regressions`(挂载):审批流区渲染结构化编辑器、request type 下拉含 8 种(断言 outdoor_punch/schedule_dispatch 在)、
预览块显示 steps、保存 payload 形状不变。Mutation:拆 request-type 补全 → 8-种断言红;拆往返未知键透传 → 保留断言红。
接入 attendance-web-guard(新 spec 进 run-list + 双 path 块)。

## 7. 完成口径

实现 → opus 对抗审阅 0 P1/P2 → 三红线 → 验证 MD。FE 串行车道。A2/档 B 各自 owner 决策后另起。
