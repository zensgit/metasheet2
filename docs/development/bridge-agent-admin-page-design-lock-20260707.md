# Bridge Agent 管理页 — DESIGN-LOCK(PROPOSED)— 2026-07-07

> **状态:PROPOSED,等 owner ratify。** 本文锁原则与切片阶梯,不实现任何代码。
> 需求来源:#3746(现场 PLM/ERP/K3/备料 连接层缺可视化配置/诊断页,owner triage ACCEPTED
> 2026-07-07)。运维底座:`scripts/ops/bridge-agent-readonly.ps1`(BA-M1 MVP,`127.0.0.1` 绑定,
> `GET /health` `GET /objects` `GET /schema/<object>` `POST /query/<object>`,只读 allowlist)+
> runbook `docs/operations/bridge-agent-readonly-runbook-20260521.md`。UX 落位:骑 IU-2 骨架
> (integration-ux-workbench-redesign-design-lock-20260706.md)作为数据工厂内新分区/邻页,不重复造壳。

## 0. 定位与非目标

**定位**:让业务/实施人员在系统内**看得见、查得清、可验证** Bridge Agent 的运行与暴露面——第一阶段
纯只读可观测 + values-free smoke,不做前端可改的本机服务管理器。

**第一版明确不做**(与 #3746 §备注一致):
- 前端 start/stop 计划任务;
- 前端直改本机 config;
- 任何写路径(Agent 只读模型 BA-M1 不破);
- 凭据回显/前端保存;
- raw SQL 编辑器。

## 1. 三条原则(锁定)

1. **只读优先、写路径缺席**:第一版所有能力止于观测与 values-free 探测;配置变更只产出"变更建议/
   实施清单",由受控后端或运维脚本(现有 .ps1 / Scheduled Task)应用,前端不直写。
2. **凭据后端持有、前端零回显**:host/tenant/private config id/token/secret/connection string/
   authorityCode 一律脱敏;前端最多显示"已配置/未配置"布尔。
3. **values-free 诊断**:页面展示、探测证据、导出、issue 回贴全部只含 count/字段形状/布尔/coarse
   状态——绝不含原始业务行、payload、真实物料/BOM 值。

## 2. 采纳自 #3746 的硬锁(逐条并入)

### 2.1 安全边界(§安全边界原样锁定)

```text
禁:前端显示/保存 password/token/shared secret/SQL connection string/authorityCode/原始 K3-PLM
    payload rows/客户业务数据行
凭据:仅经后端凭据库或本机 secret/env 写入;前端最多显示"已配置/未配置"
禁:raw SQL 编辑器;只能选 allowlist 对象 + 受控字段映射
默认只读;不得经本页触发 K3 Save/Submit/Audit、ERP 写、PLM 写、生产写
issue 回复/诊断报告/页面导出必须 values-free / data-redacted
```

### 2.2 验收标准(§验收标准转为 exit criteria)

```text
管理员可见 Bridge Agent 是否可达
管理员可见 Agent 暴露的只读对象列表 + schema 形状
页面明确提示 Agent↔数据源/数据库/对象 的绑定关系
页面可执行 values-free health/objects/schema smoke,显示通过/失败原因
页面不回显任何凭据/连接串/token/secret/原始业务行
页面可生成新增对象/字段映射的配置建议或实施清单(供后续受控落地)
既有脚本/runbook 仍为底层运维路径,不破坏 BA-M1 只读安全模型
```

## 3. 切片阶梯(各自单独 opt-in)

```text
BA-UI-0 ✅ 本 design-lock(采纳 #3746 边界+验收为锁条款)
BA-UI-1 🔒 只读可观测页(门:BA-UI-0 ratify + IU-2 骨架落地)
        Agent 状态卡片(在线/离线/协议版本/最近健康检查时间/只读标识)+ 实例列表(endpoint
        别名/用途/状态,敏感字段脱敏)+ 对象列表(复用 /objects 形状:对象名/label/keyField/
        字段数)+ schema 预览(字段名/类型/required,不展示业务行)。零配置写路径。
BA-UI-2 🔒 values-free 只读探测(门:BA-UI-1)
        health/objects/schema/sample-shape smoke → 只返 count/字段形状/布尔状态;证据词表复用
        既有 read-source probe 的 values-free evidence 纪律(单一来源,不另造词表)。
BA-UI-3 🔒 配置校验 + 变更建议清单(门:BA-UI-2;受控落地,不做前端直改)
        校验必填/limits/auth mode/localhost-proxy 边界/raw-SQL 禁止/对象 allowlist 完整性 →
        新增对象/字段映射生成"变更建议",管理员确认后由后端或 .ps1 应用。
BA-UI-4 🔒 计划任务运行态提示(门:BA-UI-1;第一版只读显示,不 start/stop)
```

## 4. 后端契约(BA-UI-1 起,后续锁细化)

- Bridge Agent 的 `/health` `/objects` `/schema/<object>` 为**只读 GET**,天然适配可观测页;
  `POST /query/<object>` 在本线**不被本页调用**(那是数据面取数,归 read-source 数据面,非诊断页)。
- 页面经 MetaSheet 后端**代理**这些只读端点(后端持凭据/host,前端只见脱敏结果)——不新开前端到
  Agent 的直连,不新开凭据前端写路径。代理层的注册/鉴权走既有 external-system + `integration:write`
  权限门,不碰中央 rbac/auth。

## 5. 模型分派

| 件 | 分派 |
| --- | --- |
| BA-UI-0 锁 / 各片 design 裁量 / 脱敏与 values-free 审查 | Fable 5 主循环 |
| BA-UI-1 卡片/列表页机械实现 / BA-UI-2 探测证据渲染 | Sonnet 5 agent + 质量闸 |

## 6. 边界(本锁零开门)

本文 authorizes nothing:无 runtime、无路由、无后端代理实现、无凭据路径变更。BA-UI-1+ 各需独立
opt-in;第一版 out 项(start/stop/本机 config 直改/写路径)维持冻结。骑 IU-2 骨架,不与其文件面冲突。
