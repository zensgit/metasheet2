# Metasheet 平台发布与部署实施策略

Date: 2026-04-03  
Scope: 考勤 + 多维表共存场景下的 on-prem / 客户现场实施、升级、灰度、回滚策略

## 1. 文档目标

本文档用于统一 Metasheet 在客户现场的发布与部署策略，解决以下问题：

1. 同一台机器上同时承载考勤和多维表时，如何统一版本管理
2. 多客户、多现场分布更新时，如何控制风险
3. 如何在普通客户与关键客户之间采用不同部署方式
4. 如何将“代码部署”和“功能启用”拆开管理
5. 如何建立标准升级、灰度、回滚、验收流程

## 2. 适用范围

适用于以下场景：

1. 单机 on-prem 部署
2. 已从考勤单线切换到平台模式的现场
3. 同时承载考勤和多维表的客户环境
4. 内部 pilot、普通客户、关键客户的分级发布

不适用于以下场景：

1. attendance-only 老旧壳长期单独维护
2. 完全独立的多套产品分别发版
3. 尚未完成平台模式切换的历史环境

## 3. 核心原则

1. 统一平台版本，不再分别维护“考勤版本”和“多维表版本”
2. 统一平台升级入口，不再分别维护“考勤升级链”和“多维表升级链”
3. 统一代码包，但功能启用可按客户灰度
4. 普通客户采用最小中断升级，关键客户采用 blue-green
5. 数据库变更默认要求向后兼容
6. 先预检、再升级、再验收、最后开放业务
7. 没有回滚预案的版本，不进入客户现场

## 4. 平台版本模型

### 4.1 统一版本

从平台模式开始，每个客户环境只维护一个版本号：

- `Metasheet Platform vX.Y.Z`

不再单独记录：

- “考勤版 vA.B.C”
- “多维表版 vD.E.F”

### 4.2 统一运行模式

客户现场统一要求：

- `PRODUCT_MODE=platform`
- `DEPLOYMENT_MODEL=onprem`

参考模板：

- [app.env.multitable-onprem.template](/Users/huazhou/Downloads/Github/metasheet2/docker/app.env.multitable-onprem.template)

### 4.3 统一升级入口

平台模式环境统一使用以下升级链：

- 预检：
  [multitable-onprem-preflight.sh](/Users/huazhou/Downloads/Github/metasheet2/scripts/ops/multitable-onprem-preflight.sh)
- 升级：
  [multitable-onprem-package-upgrade.sh](/Users/huazhou/Downloads/Github/metasheet2/scripts/ops/multitable-onprem-package-upgrade.sh)
- 健康检查：
  [multitable-onprem-healthcheck.sh](/Users/huazhou/Downloads/Github/metasheet2/scripts/ops/multitable-onprem-healthcheck.sh)

## 5. 发布分层策略

### 5.1 环境/客户分层

| 层级 | 类型 | 目标 | 部署策略 | 风险容忍度 |
|---|---|---|---|---|
| L1 | 内部测试 | 快速发现问题 | 标准升级 | 高 |
| L2 | 内部 pilot | 验证真实业务链 | 标准升级 + 功能灰度 | 中高 |
| L3 | 普通客户 | 稳定交付 | 最小中断升级 SOP | 中 |
| L4 | 关键客户 | 高 SLA / 关键现场 | Blue-Green | 低 |

### 5.2 发布顺序

固定顺序如下：

1. 内部测试
2. 内部 pilot
3. 普通客户
4. 关键客户

禁止同一版本直接全量推送到所有客户。

## 6. 部署方式分级

### 6.1 普通客户

采用“最小中断升级”：

1. 提前准备新版本
2. 提前完成 env 校验和预检
3. 低峰时段执行升级
4. 中断时间控制在分钟级
5. 升级后立刻完成 smoke

适用条件：

1. 可接受短维护窗口
2. 客户没有严格零中断要求
3. 单机部署为主
4. 运维团队规模有限

### 6.2 关键客户

采用 Blue-Green：

1. 同时维护 blue 和 green 两套应用实例
2. 外层反向代理负责切流
3. 新版本先在 green 完整预检和 smoke
4. 验证通过后再切流
5. 失败时切回 blue

适用条件：

1. 白天不能接受停机
2. 有明确 SLA
3. 业务量高
4. 现场具备较成熟运维能力

## 7. 功能启用策略

代码部署与功能启用必须分离。

### 7.1 原则

1. 代码可以先部署到客户环境
2. 多维表功能不一定立即对所有客户开放
3. 新功能优先对内部租户或 pilot 客户启用
4. 只有稳定后才扩展到普通客户

### 7.2 推荐启用顺序

1. 平台版本部署完成
2. 保持新功能默认关闭或受限
3. 对内部租户开启
4. 对 pilot 客户开启
5. 对普通客户开启
6. 对关键客户最后开启

### 7.3 好处

1. 降低一次性发布风险
2. 将“版本问题”和“功能问题”拆开定位
3. 可以在不重新部署的情况下逐步放量

## 8. 数据库变更策略

### 8.1 默认规则

生产环境数据库变更默认要求向后兼容。

### 8.2 推荐模式

采用：

- `expand -> deploy -> switch -> contract`

含义如下：

1. `expand`
   - 新增表、字段、索引
   - 不删除旧结构
2. `deploy`
   - 新版本上线，兼容旧数据结构
3. `switch`
   - 应用切换到新逻辑
4. `contract`
   - 稳定后再删除旧结构和旧逻辑

### 8.3 禁止事项

1. 禁止把破坏性 schema 变更直接塞进一次普通升级
2. 禁止没有回滚预案的 migration 进入关键客户
3. 禁止仅回代码、不回数据库地处理不兼容升级失败

## 9. 标准升级 SOP

### 9.1 升级前

1. 确认目标版本和升级范围
2. 备份 `app.env`
3. 备份数据库
4. 备份存储目录
5. 运行预检
6. 提前准备镜像或构建产物
7. 准备 smoke 清单

### 9.2 升级执行

1. 通知业务方进入维护窗口
2. 再做一次数据库快照
3. 执行平台升级
4. 跑健康检查
5. 跑人工 smoke
6. 确认业务恢复

### 9.3 升级命令示例

```bash
ENV_FILE=/opt/metasheet/docker/app.env \
bash /Users/huazhou/Downloads/Github/metasheet2/scripts/ops/multitable-onprem-preflight.sh

ENV_FILE=/opt/metasheet/docker/app.env \
BASE_URL=http://your-host-or-domain \
API_BASE=http://your-host-or-domain/api \
bash /Users/huazhou/Downloads/Github/metasheet2/scripts/ops/multitable-onprem-package-upgrade.sh

BASE_URL=http://your-host-or-domain \
API_BASE=http://your-host-or-domain/api \
bash /Users/huazhou/Downloads/Github/metasheet2/scripts/ops/multitable-onprem-healthcheck.sh
```

## 10. 升级后验收清单

### 10.1 平台级

1. 根入口 `/` 正常
2. 登录正常
3. API 正常
4. 后台服务进程正常
5. 数据库和 Redis 正常

### 10.2 考勤级

1. 考勤首页可打开
2. 导入入口正常
3. 列表和报表正常
4. 已有关键业务链路正常

### 10.3 多维表级

1. `/multitable` 可打开
2. Grid open 正常
3. Search 正常
4. Form / Drawer 正常
5. Comments / unread / mention 正常
6. 附件上传正常

## 11. 版本更新分类与处理方式

| 更新类型 | 是否仍走平台升级链 | smoke 重点 | 是否需要灰度 |
|---|---|---|---|
| 仅考勤改动 | 是 | 考勤为主，多维表轻量冒烟 | 建议 |
| 仅多维表改动 | 是 | 多维表为主，考勤轻量冒烟 | 建议 |
| 平台公共能力改动 | 是 | 考勤 + 多维表都要重点验证 | 强烈建议 |
| 含 migration 改动 | 是 | 双侧重点验证 | 必须 |

结论：

即使这次“只有考勤改动”，如果客户现场已经是平台模式，也必须继续走平台升级链。

## 12. 回滚策略

### 12.1 回滚触发条件

1. 健康检查失败
2. 核心 smoke 失败
3. 客户现场出现关键业务阻断
4. migration 导致兼容性问题

### 12.2 回滚原则

1. 先止血，不边线上修边试
2. 回滚时同时考虑代码、配置、数据库
3. 如果 migration 不兼容，必须恢复数据库备份
4. 关键客户优先通过切流回退，普通客户优先恢复上一稳定包

### 12.3 回滚顺序

1. 停止继续升级动作
2. 恢复上一版本应用
3. 必要时恢复数据库
4. 恢复服务
5. 重新跑健康检查
6. 输出事故记录

## 13. Blue-Green 采用门槛

当客户满足以下任意两条时，建议进入 Blue-Green 方案：

1. 不能接受 1 到 5 分钟维护窗口
2. 白天业务持续活跃
3. 有明确 SLA
4. 发布频率较高
5. 现场具备较成熟运维能力
6. 单次回滚代价较高

不满足时，默认仍采用标准升级 SOP。

## 14. 组织分工建议

| 角色 | 责任 |
|---|---|
| 产品负责人 | 决定版本范围与启用策略 |
| 研发负责人 | 决定代码是否进入发布 |
| 发布负责人 | 决定分批顺序与发布窗口 |
| 运维负责人 | 执行预检、升级、健康检查、回滚 |
| 实施/交付 | 负责客户沟通与现场验收 |
| QA | 负责 smoke 清单与结果签收 |

## 15. 推荐最终策略

面向当前阶段，推荐策略如下：

1. 所有客户环境统一切到平台模式
2. 所有版本统一按平台版本发布
3. 所有升级统一走 multitable/platform 升级链
4. 普通客户使用最小中断升级
5. 关键客户单独建设 blue-green
6. 新功能通过功能开关逐步启用
7. 数据库变更默认要求向后兼容
8. 每次发布固定走“预检 -> 升级 -> 健康检查 -> smoke -> 签收”

## 16. 最终结论

对当前 Metasheet 来说，最佳方案不是“所有客户都立即做零中断”，而是：

- 统一平台版本
- 分批发布
- 分级部署
- 功能开关
- 向后兼容数据库策略

这套方案兼顾了：

1. 运维可执行性
2. 客户实施稳定性
3. 多系统共存下的管理复杂度
4. 后续演进到 blue-green 的空间
