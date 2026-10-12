# 考勤多时区：本轮模型分工及验证记录

日期：2026-10-12
状态：局部验证通过，完整收尾未完成。保持 Draft；未合并、未部署、未启用。
本地提交基线：bc7ac1273de1fe85e1b81afb2daa9461cae068e5，加当前定时缺勤修复、native 测试和门禁未提交改动。远端 Draft #6350 的旧 CI 不覆盖这些改动。

## 设计

保持一个统一条件选择：关闭用组织默认；开启按有效批准出差 > 管理员员工配置 > 计算考勤组 > 组织默认。时间点 UTC 存储；班次开始后冻结上下文。关联上下班及请假等使用目标班次；整班边界及同日多上下文拒绝保持。首版不加入管理员单据矩阵、通用任务联动或规则引擎。

完整设计：attendance-multitimezone-design-lock-20261012.md。
模型计划：attendance-multitimezone-model-and-verification-plan-20261012.md。

## 实际分工

| 模型 | 本轮实际状态 | effort |
| --- | --- | --- |
| Astra | 定时缺勤三个源文件修复及 native 测试已交付；主审独立运行真实验证 | high |
| Sol 6.1 | 常规实现/测试首选；前轮调用存在额度限制，不冒称本轮成功交付 | 按难度 medium/high |
| Luna | 文档及证据整理首选；前轮额度限制，不将失败调用记作交付 | 按难度 medium/high |
| Grok 4.7 | CLI models 验证可用；已完成本轮只读 diff 快照审查，主审回完整代码核对；专属会话已关闭 | TUI 实际显示 xhigh |
| Kimi K3 | provider 默认别名 kimi-code/k3，显式别名调用 exit 0，已返回只读快照意见；主审继续核对 | CLI 未暴露独立 effort，配置默认 |

Grok 的缺少 frame.workDate 假设被 runtime prepareRelatedRecordContext 的显式字段排除；既有记录继续计算的假设被 authoritative 的 resolvedParent.kind === 'skip' 分支排除；多行旧记录假设有已迁移 UNIQUE(user_id,work_date,org_id) 约束。审查只看快照，不能称为整 PR PASS，其余并发及 recovery 建议继续纳入最终门槛核对。真实三用户批量绑定及 shadow/authoritative 7 项验证排除了“每事务只绑定第一人”和“发行指纹恒冲突”的对应假设。完整代码复核也排除了五项假设：W4 finalization 同事务写事件 outbox，由既有 dispatcher 发送；RUNNING recovery 同事务重算目标集合并比较冻结 fingerprint；pluginShapedTrx 每次返回新对象；readTargetTimezoneContext 成功路径覆盖本目标 facts；authoritative 保存点失败后直接取消/记录失败并返回，不再次发行。终态 recovery 返回本次零处理量不修改持久计数。本轮 native 未证明 dispatcher 实际送达，仍需最终门槛验证。模型意见不是测试证明。

## 本轮验证

| 检查 | 结果 | 证据目录 |
| --- | --- | --- |
| 四点 CI 接线实际检查 | 292/292，通过，exit 0 | reports/d4-scheduled-ci-wiring-root-v1 |
| native v1 完整迁移及重放 | 均 exit 0 | reports/d2-scheduled-native-root-v1 |
| native v1 业务测试 | 6 通过 / 1 失败；保留原失败证据 | 同上 |
| native v2 完整迁移及重放 | 均 exit 0 | reports/d2-scheduled-native-root-v2 |
| native v2 业务测试 | 7/7，通过，exit 0 | 同上 |
| v2 源码漂移及清理 | sourceDrift=[]；cleanup exit 0；七项日志哈希核对通过 | 同上 |

执行方法：Mac mini 专属 runner 新建隔离 PostgreSQL 16 库，使用 Node 20/pnpm，执行 src/db/migrate.ts 两次，再用单文件串行 Vitest 执行 attendance-timezone-scheduled.db.test.ts。真实 MetaSheetServer/HTTP/PG；factory observation 原样委托生产 factory，没有模拟 DB 或自动缺勤处理器。

覆盖：OFF 所有员工组织默认；ON 员工不同区及真实创建/最终批准出差；旧 legacy 行全行保留且不造 companion；真实 companion INSERT 故障后整批回滚并可重试；shadow/authoritative 真实计算 ID 与冻结内容关联；completed exact recovery 缺策略表仍成功、fresh 明确拒绝。

v1 失败来自合成出差行程在洛杉矶 16:00 边界切班；首次断言没有保存实际 error.code，因此只记录原因分析。v2 将合成员工基础时区改东京，使 UTC 午夜边界在东京和新加坡都不切班，并增加 error.code 诊断。生产限制没有放宽。

## 剩余门槛

完整 MT01–MT20、最终迁移/回滚说明、最终源码哈希与 provenance、validate:all、完整 checkpoint 四 CLEAN/零扫描、最新 main 对齐、最终提交 13 必需 CI、整 PR 独立终审及最终验证 MD 均需完成或重新冻结确认。当前局部结果不能授权 Ready、合并、部署或启用。


## main 389c9d71 对齐后的收尾验证

集成提交为 6053bc518683c3376a4312e288107185537ad831，当前还有未提交的 UI、测试及文档改动。Draft #6350 远端仍是 foundation b000424；不得将其 CI 当作本次实现的验证。

- 真实浏览器 v14：7/7，完整迁移、重放、停止自有 PG 均 exit 0，sourceDrift=[]；新增冲突 UI 场景的下一轮仍在执行。
- Sol 6.1/high 的 UUID 接线及组织 URL fixture 修复：128/128，0 跳过；第二轮使用标准最小环境，sourceDrift=[]。
- 当前定时任务 native：10/10，包含真实锁竞争和部分 RUNNING 回放。整个扩展 runner 尚未结束，最终 source hash/cleanup 回执待收取。
- 当前 runtime 旧 55 项通过，新增 3 项 fixture 失败：两个缺 updated_by，另一个误读多段发布条件；最小修正已准备，尚未重跑。不能写成 58/58。
- 单元测试 419 通过、2 失败：六个 Intl 调用未精确登记；均已核实为仅年月日或时区校验，保留原扫描和反例的登记补丁待应用。
- SELECT inventory 61/62：新增定时物理 parent 前置读取未登记；精确登记及邻居负例已准备，不能宽泛豁免。
- validate:all、OpenAPI build/guard、provenance 测试 exit 0；CI 接线通过。最终代码修改后仍需核对适用范围。
- 独立终审的未来员工时区边界与跨日请假尚待真实反例确认。第一轮未来边界复现在 beforeAll 启动阶段超时，cases=[]，不能按 Vitest numPassedTests=2 宣称业务通过；必须检查 success、suite failure、实际断言与证据。

本节为进行中记录，不是最终验收 MD。最终 CI、Linux checkpoint、整份 PR verdict 和 MT01–MT20 闭环仍待完成。
