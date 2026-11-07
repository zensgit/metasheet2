# Automation A：日期失败请求的显式关联重读（SA06AU）

状态：本地候选已实施；专项、完整原生回归及日期retry Chromium同链已通过（2026-10-07，SA06AV完整126/126），主线整合与发布验收未完成；T 层 Ratified-by-default-2026-10-02。证据见代码工作树`docs/development/automation-read-date-linked-retry-verification-20261007.md`及`automation-read-date-linked-retry-browser-verification-20261007.md`。承接已批准的 Automation A 与目标 SA-06，不授权真实客户读取、外部发送、提交/PR/合并、发布或部署。本片不是后台自动 retry，也不修改旧手动关联重试的权限。

## 1. 范围与不变式

只扩展原 `automatic + schedule.date_field` 请求的 `blocked/failed/cancelled/outcome_unknown` 四种终态。父请求必须有已持久的不可变日期 occurrence receipt 和原日期 activation；queued/running/succeeded、record、cron/interval、standalone schedule，以及日期 retry 子请求继续延链均不在本片开放。旧 manual 的原合同和继续延链行为保持。

当前原 Connection owner ∩ integration admin 在可信 tenant、workspace=null 下，明确确认新的单次读取和新期限/预算。子授权 `purpose=retry`、`triggers=['schedule']`、单项目、maxExecutions=1；子请求仍为 schedule，不转换为 manual，也不要求或伪造 allowManual。普通 submit 不接受 retry grant。

原 grant 的过期、撤销或次数耗尽不阻止 owner 重新作出新决定；新决定不复活原 grant，不更新其状态、期限、用量或原 request。当前 rule revision、日期定义/字段/schema、source incarnation/authority key、owner/admin 和目标完整读权限仍须成立；变化即拒绝。本片不是对原记录日期的重新判断：只重读原固定项目，不重新扫描日期值、不按当前行或当前时间伪造旧 occurrence。

新预算不生成或重置 B2a 一次性来源许可。若旧尝试耗尽唯一登记，新请求可以登记但不得新增来源读取；实际二读还需来源围栏内另一份独立有效许可。所有客户许可/读取仍另批。取消或 unknown 均不证明此前来源读取未发生或已经物理停止。

## 2. 入口与用户确认

复用现有 owner `GET requests/:id/retry-context` 和 `POST requests/:id/retry`，不新增路由。POST仍严格只有 retryKey、budget、expiresAt、acknowledgeNewRead:true；parent仅来自路径，不接受客户端 trigger、日期证明、source、selector 或 owner。

GET继续只观察、不改变期限/状态、不读来源、不预留预算、不承诺可执行。针对有真实日期来源的父/子上下文，增加可选闭合集 `dateScheduleOrigin: { definition, ruleRevision }`：definition仅原 `schedule.date_field` 公开配置与field/type/schema确认；不输出recordId、实际日期值、occurrence、私有授权摘要或来源材料。manual及其它历史上下文保持原形状，不凭字段缺省猜日期资格。

UI必须展示原日期定义与规则版本、固定项目、新期限/预算，并明确“重新读取一次；不重新扫描日期，不恢复原计划；原读取可能已发生，来源许可仍独立”。只有直接automatic日期父请求及完整日期来源说明可提出此确认。原key/完整命令用于结果未知时恢复，scope/session变化丢弃旧响应；有既有子尝试只查看该尝试，不创建第二份预算。

## 3. 持久关联与每次执行重验

追加144000迁移，不改写142000/143000：扩展retry闭合形状，保留父唯一、子唯一、scope内key唯一、不可变身份、同事务新grant/request/audit/outbox/link及提交时拒孤儿。日期关联明确引用原日期receipt，不能给cron/record造日期身份，不能以第二个grant重新插入旧receipt；旧receipt及原activation不变。

新准入、claim、每次IO checkpoint与结果发布均验证：子与原父的tenant/owner/selector/source/authority/project精确一致、原父automatic日期身份及原receipt有效、当前规则/日期定义/schema/权限仍匹配。原grant的使用计数和期限不作为新grant的预算；新grant独立受当前上限、新期限与单次消费约束。worker不反向更新或锁住祖先grant/request；冻结祖先关联仅观察验证，当前元数据门仍使用真实事务。

同key只恢复原不可变尝试，错误key/父/body冲突拒绝；恢复历史回执用原Connection观察权，不要求旧版本仍可执行，但不允许重新准入。新登记与runtime stop信号、取消/fence及outbox原子性沿用原合同。只输出canApply=false状态/计数，不产生apply token、业务写入或发送。

## 4. 验证与回滚

先验证真实调用路径，再做有限降级。需包含：实际日期父receipt→owner新确认→新grant/队列→当前权限native合成预览；原grant过期/撤销/耗尽不复活；allowManual=false仍仅schedule；日期/schema/rule/source或owner变化各拒绝；原日期后来变化不重算；无来源第二许可零新增native读；same-key/并发/父唯一/取消/停止/失去回执；数据库错scope/错receipt/孤儿/重写/延链拒绝；手动回归保持。

所有DB执行只在owned disposable合成PG，外部IO与.env由隔离runner阻止。真实迁移/锁影响和发布另行授权，代码依赖迁移先行。若已有日期retry历史，down拒绝；无历史才还原旧manual约束/函数，不能删关联或篡改旧migration凑回滚。验证结果、失败现场、有限变异和冻结范围另入代码验证报告，未执行的项目不得记为通过。
