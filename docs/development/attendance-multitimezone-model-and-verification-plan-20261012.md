# 考勤多时区：模型分工与验证计划

日期：2026-10-12
范围：已批准首版；Mac mini 专属工作区；允许 Draft PR 和 CI；合并、部署、启用另行审批。

## 保持简单的设计

关闭时使用组织默认考勤时区；开启时按有效批准出差、管理员员工配置、计算考勤组、组织默认依次选择。时间点使用 UTC；已开始班次沿用冻结上下文。首版保留完整班次边界和同日多上下文拒绝，不引入通用规则引擎、单据配置矩阵或通用任务联动。完整合同见 attendance-multitimezone-design-lock-20261012.md。

## 按风险选择模型

| 任务 | 模型 | effort | 验收 |
| --- | --- | --- | --- |
| 文档、证据索引、CI 清单 | Luna | medium；复杂证据归因用 high | 对照实际日志和提交，不能凭摘要判断通过 |
| 常规 API、UI、定向测试 | Sol 6.1 | high；明确小改动用 medium | 类型检查、相关测试和相邻测试 |
| 事务、锁、历史冻结、定时缺勤与回放 | Astra | high；仅复杂竞态未收敛时升 xhigh/max | 实际 HTTP/PostgreSQL、并发和回滚负例 |
| 独立检查优先级及状态泄漏 | Kimi K3 | CLI 未暴露独立 effort，使用配置默认 | 只读建议，由主审复现后决定修复 |
| 独立检查事务及 canonical/shadow 计算身份 | Grok 4.7 | 本次 TUI 显示 xhigh | 只读建议，由主审复现后决定修复 |
| 最终整份 PR 反证审阅 | Astra | high；出现跨域复杂缺陷再升档 | 设计锁门槛、最终 diff 和精确 head 证据 |

此表是任务选择策略，不表示每项已完成或每个模型已成功调用。不可用或额度不足时记录实际情况，改用可用模型继续，不冒称使用目标模型。不让多个实现代理同时修改相同文件。主审负责集成、实际测试与最终结论。

## 本轮已确认的调用

- Astra/high：事务、冻结、定时任务及独立整份 diff 审阅；定时任务新 10 项真实 PostgreSQL 测试通过。独立审阅的员工配置边界和跨日请假向量仍待实测，不把假设写成缺陷。
- Sol 6.1/high：完成 UUID 工具接线和三个旧组织 URL fixture 修正；三文件定向测试 128/128 通过，后续出差 fixture 组织参数补丁待合入验证。
- Luna/medium：已完成 MT01–MT20 验证报告草稿和来源索引，仅归纳实际证据，不参与批准通过。
- Kimi CLI 2.1.1：provider list 核对模型 kimi-code/k3，显式选择后完成只读快照审查。CLI 未暴露独立 effort，本次使用配置默认。
- Grok CLI 1.0.50 / Runtime 0.8.11：核对 grok-4.7 可用并完成只读审阅，TUI 显示 xhigh；会话已关闭。
- 早期 Sol/Luna 额度失败不计交付；上面是后来实际成功的任务。模型建议由主代理核对源码和原始结果，不代替测试或最终审阅。

## 收尾顺序

1. 补定时缺勤真实数据库回归：OFF 默认、ON 员工/出差、旧记录保留、失败回滚、shadow/authoritative 计算关联与完成后回放。
2. 独立核对 Kimi/Grok 建议；有可复现缺陷再做最小修复。
3. 在最终代码上完成 MT01–MT20、迁移及重放/回滚说明、哈希与 provenance、前端双门禁、validate:all、完整 checkpoint。
4. 核对最新 main、普通合并并保留测试链并集；更新 Draft PR，运行最终 head 的 13 项必需 CI。
5. 交付设计 MD 和验证 MD：逐门槛列出命令、exit、提交、日志/截图及限制。局部绿灯、旧 head CI 和模型意见均不能替代最终验证。

最终验证报告目前未完成；本文件是计划与调用记录。保持 Draft，不合并、不部署、不启用。

## 较早阶段验证记录

四点 CI 接线 292/292，通过；定时缺勤真实数据库 v2 7/7，通过（完整迁移、重放、清理 exit 0，sourceDrift=[]）。Kimi K3 与 Grok 4.7 均已返回静态意见；已对完整实现核对 W4 outbox、running recovery、WeakMap wrapper、目标 facts 覆盖和保存点控制流，所列五项假设没有形成新 P0/P1；仍不据此宣称整 PR 通过或 dispatcher 实际送达。详见 attendance-multitimezone-model-verification-progress-20261012.md。
