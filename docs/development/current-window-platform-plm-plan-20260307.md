# 当前窗口平台/PLM开发计划

日期: 2026-03-07

## 文档目的

本文档用于固化当前窗口的开发边界、任务优先级和产品/平台推进方法。

当前共识如下:

- 考勤继续在另一个开发窗口推进，作为当前交付主线。
- 当前窗口优先负责平台硬化、PLM 联邦工作台演进、插件/契约/SDK 收口。
- Univer 仅保留最小孵化投入，不抢占主线资源。

## 系统当前判断

- 平台底座已成形，后端插件、联邦、工作流、审批、视图、Univer Meta 都已是主路由级能力。
- 考勤是当前最成熟、最接近交付的产品线。
- PLM 是重型联邦业务台，具备第二产品线潜力，但尚未完全并入平台通用审批/工作流内核。
- 前端平台化弱于后端平台化，插件前端装配仍有较强本地映射色彩。
- Athena/Dedup/AI/Vision 目前代码成熟度明显低于 PLM，不适合按同等级产品线叙述。

## 当前窗口任务清单

### P0

1. 先做联邦契约基线，把 `PLM/Athena` 的返回结构、错误码、分页和降级行为统一下来。
   起点文件:
   - `packages/core-backend/src/routes/federation.ts`
   - `packages/core-backend/src/data-adapters/PLMAdapter.ts`
   - `packages/openapi/src`

2. 把 PLM 前端从巨页拆成域模块，先拆搜索详情、BOM、审批、CAD、预设导出五块。
   主手术点:
   - `apps/web/src/views/PlmProductView.vue`

3. 做 `PLM 审批 -> 平台审批/工作流` 的桥接设计和最小落地，不要让 ECO 审批长期独立于平台通用内核。
   关联文件:
   - `packages/core-backend/src/routes/approvals.ts`
   - `packages/core-backend/src/routes/workflow.ts`
   - `packages/core-backend/src/data-adapters/PLMAdapter.ts`

4. 把“适配器真实能力”显式化。
   当前只有 `PLMAdapter` 为真实实现，`Athena/Dedup/AI/Vision` 仍是 stub。
   需要明确表达的文件:
   - `packages/core-backend/src/di/container.ts`
   - 管理端能力说明与系统文档

### P1

5. 补前端插件装配层，不再长期依赖本地硬编码映射。
   关键文件:
   - `apps/web/src/plugins/viewRegistry.ts`
   - `apps/web/src/views/PluginViewHost.vue`
   - `apps/web/src/composables/usePlugins.ts`

6. 对齐前后端工作流入口。
   当前后端已有完整能力，但主前端尚无真正的平台级 `/workflows` / `/approvals` 入口。
   关键文件:
   - `apps/web/src/main.ts`
   - `apps/web/src/App.vue`
   - `packages/core-backend/src/routes/workflow.ts`
   - `packages/core-backend/src/routes/approvals.ts`

7. 给 SDK 增补 PLM 联邦 helper，把前端零散 `fetch` 收进统一 client。
   入口:
   - `packages/openapi/dist-sdk`

8. 做部署剖面整理，明确 `platform`、`attendance`、未来 `plm-workbench` 三种模式各自启哪些能力。
   关键文件:
   - `apps/web/src/stores/featureFlags.ts`

9. 给联邦层补 contract/smoke 验证，重点覆盖:
   - `PLM query/mutate/detail`
   - `Athena query/detail`

### P2

10. Univer 只保留最小孵化投入，守住 `univer-meta` 的 API 和 smoke，不做全站迁移，不抢主线资源。
    关键文件:
    - `packages/core-backend/src/routes/univer-meta.ts`

## 产品开发方法

1. 把需求分三层管理:
   - 考勤交付
   - 平台硬化
   - 孵化验证

2. 每个新功能立项前先过 6 个门:
   - 产品归属
   - API 契约
   - 权限模型
   - 测试入口
   - 部署故事
   - 回滚方案

3. 不再接受“继续往巨页里加区块”的开发方式。
   以下文件应以拆分为前提:
   - `apps/web/src/views/AttendanceView.vue`
   - `apps/web/src/views/PlmProductView.vue`

4. 先做“可卖的组合”，不要先做“超级应用叙事”。
   当前真正能打的组合是:
   - `考勤`
   - `平台 + PLM 工作台`

5. 外部系统接入一律走防腐层和版本契约，不允许前端直接理解上游系统原始 shape。

6. 孵化线只做高价值样板，不做全面铺开。
   当前优先样板:
   - `BOM/ECO 评审`

## 两个版本建议

### 下一版本

- 联邦契约
- PLM 拆页
- SDK 收口
- 插件前端装配补课

### 下下版本

- 统一审批/工作流
- 把 PLM 收成 `ECO/BOM 评审工作台`
- 再决定是否正式升为第二产品线

## PLM 开发环境分层

### 1. 本地开发层

目标:

- 保证日常开发不被上游 PLM 阻塞
- 支持前端拆分、状态收口、导出、筛选、深链接、交互优化

边界:

- 前端默认依赖联邦层稳定输出
- 不默认强绑真实上游 PLM

### 2. 契约集成层

目标:

- 验证联邦层与适配器返回结构稳定
- 锁定错误码、分页、降级策略、字段兼容

### 3. 真实验收层

目标:

- 确认上游 Yuantus PLM 没有漂移
- 做 BOM、审批动作、文档、CAD、where-used、compare 的真实回归

## 哪些任务必须联调

- 修改 `PLMAdapter.ts` 的字段映射、鉴权、token 刷新、审批动作
- 修改 `federation.ts` 的 PLM/Athena query/mutate 契约
- 验证真实 BOM compare / where-used / approvals / documents / CAD 结果
- 上线前回归真实 PLM 相关验证脚本

## 哪些任务可以离线做

- 拆 `PlmProductView.vue`
- 抽前端域服务、类型、组件、状态模块
- 做导出、筛选、预设、深链接、列配置、错误展示
- 给 SDK 增 PLM helper
- 补 contract fixture 和 mock payload
- 补测试、smoke、文档
- 设计 PLM 审批桥接方案

## 本周可开工的 8 个任务

1. 把 PLM 请求从巨页里抽成前端服务层。
   先收成 `products / bom / documents / approvals / where-used / compare / substitutes / cad` 八组方法。

2. 先拆 `PlmProductView` 的审批区块。
   目标是把审批列表、审批历史、通过/拒绝动作从巨页里抽走。

3. 拆 BOM 与 where-used 区块。
   把筛选、树表切换、导出、预设管理从巨页里拿出去。

4. 给 PLM 联邦接口补 contract fixture 和最小测试。
   先锁定:
   - `products`
   - `bom`
   - `approvals`
   - `approval_history`
   - `where_used`
   - `bom_compare`

5. 给 SDK 补 PLM helper。
   建议优先增加:
   - `listProducts`
   - `getProduct`
   - `getBom`
   - `listApprovals`
   - `getApprovalHistory`
   - `getWhereUsed`
   - `compareBom`
   - `listSubstitutes`

6. 做 `PLM 审批 -> 平台审批/工作流` 的桥接设计稿。
   先产出映射表和最小桥接接口。

7. 清理联邦适配器真实能力标识。
   至少把 `PLM real / Athena stub / Dedup stub / AI stub / Vision stub` 讲清楚。

8. 安排一次集中真实联调。
   只针对适配器和联邦层改动做上游验证，不把真实 PLM 变成日常开发依赖。

## 推荐执行顺序

1. 先做可离线的大头:
   - 拆前端
   - 抽服务
   - 补契约
   - SDK 收口

2. 再做桥接设计:
   - PLM approvals
   - platform approvals/workflow

3. 最后做集中联调:
   - 适配器
   - 联邦接口
   - 上游真实验证

## 可执行开发排期

### 本周

目标:

- 先把 PLM 巨页拆分和联邦契约基线启动起来
- 保证大部分工作可以脱离上游 PLM 持续推进

任务:

1. 抽离 PLM 前端服务层，统一封装 `products / bom / documents / approvals / where-used / compare / substitutes / cad` 请求。
2. 从 `PlmProductView.vue` 中先拆审批区块，形成独立组件和状态模块。
3. 从 `PlmProductView.vue` 中拆 BOM 与 where-used 区块，收走筛选、导出、预设逻辑。
4. 为联邦层补第一批 contract fixture，先覆盖 `products / bom / approvals / approval_history / where_used / bom_compare`。
5. 梳理 `container.ts` 中真实适配器能力状态，并把 `stub vs real` 的现状文档化。

交付物:

- 一个可复用的 PLM 前端请求层
- 两到三个拆出的 PLM 域模块
- 第一批联邦 fixture/contract 测试
- 一份真实适配器能力说明

### 下周

目标:

- 把 SDK 和平台桥接补上
- 把“能拆”推进成“能复用”

任务:

1. 给 SDK 增补 PLM helper，把前端零散 `fetch` 收进统一 client。
2. 产出 `PLM 审批 -> 平台审批/工作流` 的桥接设计稿，并完成最小接口落地。
3. 对齐前后端工作流入口，决定补齐平台级 `/workflows` / `/approvals`，还是删除悬空入口定义。
4. 开始补前端插件装配层，降低对本地 `viewRegistry.ts` 的长期依赖。
5. 补部署剖面说明，明确 `platform / attendance / plm-workbench` 模式边界。

交付物:

- 一组可被前端直接消费的 PLM SDK helper
- 一份审批/工作流桥接设计与最小实现
- 一份模式剖面说明
- 一版更可维护的插件装配结构

### 下个版本

目标:

- 把 PLM 从“重型联邦页面”推进到“第二产品线雏形”
- 把平台能力从并列模块拉向统一内核

任务:

1. 收口联邦契约，补齐 PLM/Athena 的 contract/smoke 验证。
2. 推进统一审批/工作流，把 ECO 审批逐步接入平台通用能力。
3. 把 PLM 收敛成 `ECO/BOM 评审工作台` 的明确产品切片。
4. 继续补前端插件平台能力，让视图装配从“半动态”走向“可扩展”。
5. Univer 仅保留最小 API 和 smoke，继续作为孵化样板而非主线前端。

交付物:

- 统一后的联邦契约与 smoke 验证
- 一条更清晰的 PLM 第二产品线雏形
- 更稳的平台工作流/审批内核边界

### 排期原则

1. 本周优先做不依赖上游的结构治理和契约收口。
2. 下周再集中做 SDK、桥接和入口对齐。
3. 下个版本再推进统一审批/工作流与产品切片收敛。
4. 真实上游联调只在适配器或契约变更完成后集中执行，不作为日常开发依赖。

## 当前窗口的边界

- 不与考勤主线抢资源
- 不启动全站 Univer 重写
- 不把 Athena/Dedup/AI/Vision 按已成熟产品线推进
- 不在巨页中继续堆区块式需求

## 结论

当前窗口最合理的职责不是继续扩散功能面，而是:

- 平台硬化
- PLM 收敛
- 契约标准化
- 前端结构治理
- 为未来第二产品线做准备
