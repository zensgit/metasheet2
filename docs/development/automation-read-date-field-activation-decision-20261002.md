# Automation A：日期字段只读激活决策（SA06AS）

状态：本地实现、分层验证及日期owner面板 Chromium→实际scheduler→原生合成预览同链完成（SA06AT）；真实环境部署、完整应用登录/日期规则编辑器DOM未验收，未提交或发布。承接用户批准的 Automation A、目标文件 SA-06；不是客户读取、外发、提交/PR/合并或部署授权。设计与运行时代码保持不同工作树，后续按 GOV-08 分开交付。本文件不替代原 schedule/record/retry 决策。

## 决策登记

| 项 | 决定 |
|---|---|
| 层级 | T：已批准只读方案内的日期触发实现；Ratified-by-default-2026-10-02，owner 可否决 |
| 作用域 | 无 conditions 的 schedule.date_field，固定一个已授权项目，当前 Connection owner ∩ integration admin，可信 tenant、workspace=null |
| 运行许可 | 必须新建明确的日期 activation；旧 standalone/record/cron/interval grant 不升级。真实客户源读取仍另批 |
| 非目标 | 行内项目号推导、任意条件、自动 retry、外部发送、业务表写入、新调度引擎、无限量日期扫描 |

## 1. 用户体验与授权

复用已有 Automation 日期规则编辑器，不复制一套字段/偏移/时间/时区配置页面。在只读 owner 面板的定时模式显示当前日期字段、date/dateTime 类型、提前/延后天数、实际时间和时区，绑定当前 rule revision 与 schema revision。保存规则不代表授权；授权本身不读记录日期或客户源。

日期 activation 在既有 schedule-activations 端点要求额外闭合的 expectedDateField 确认（fieldId、fieldType、schemaRevision）；服务器重取当前真实元数据比较，客户端字段不是权限证明。非日期请求不能携带该确认，日期请求缺确认拒绝。回执仍只有 activationId/grantId。

明确告诉 owner：每条合格记录的每个到期 occurrence 各消耗一次该固定项目读取；同日多条到期记录可能多次预览同一个项目。项目绝不从记录内容推导。期限、次数、配置/来源版本和每次读取预算沿用原 grant；既有 B2a 一次来源许可不因新 grant 而增加。

恢复不确定回执时，保留原 key、rule revision、日期确认、项目及预算，不自动改参或创建新授权。field type/schema/config改变即清除前端确认；后端当前事实不匹配拒绝。旧客户端不能无感启用日期读取。

## 2. 调度、日期来源与去重

复用真实 AutomationScheduler 的日期 timer 和已有启动 catch-up；callback 只传服务端唤醒时刻，不是逐记录 occurrence 或来源授权。缺只读 runtime/activation 不回退普通执行器，也不先消耗普通日期提醒 claim 表。

先做有界元数据候选发现，再在同一 READ COMMITTED 事务完成当前 actor、grant、规则、Connection、目标、日期 schema/field 和读权限检查，之后才读取记录 ID＋单日期字段的有界投影；不先读取整份 data。日期字段只允许原生 date/dateTime，镜像/特殊投影拒绝。沿用现有完整读门：非平台 admin 且行级读限制开启则拒绝，平台 admin 也不绕过字段隐藏。事务内 SHARE NOWAIT 锁原记录，确保取值到 admission 期间不能变更/删除。

严格校验受控配置，不使用普通日期 helper 对错误 offset/timezone 的 clamp/fallback 取得权限；通过后复用其 civil-day、timeOfDay、DST gap/overlap 计算。date 为浮动日历日，dateTime 为明确时区的 instant；非法日期/格式不作为 due。规则 effectiveAt 与 createdAt 仍生效，且 occurrence 必须严格晚于本次 DB 签发的 activated_at，不借 48 小时窗口回填授权前记录。

稳定身份为 activation＋recordId＋计算出的 UTC occurrence，不含扫描 tick 或当前记录版本；同一日内改时间不产生新身份。同 ID、同 occurrence 删除重建按既有提醒语义视为同次，不虚称已有 record incarnation。不同 activation 是独立的显式许可，不提供跨授权全局去重。

采用 keyset 分页，单页最多100条日期投影、每次唤醒最多100页。唤醒时刻固定为所有页的 occurrence 上界；每页真实DB时钟独立判48小时下界，不借旧唤醒延长窗口，也不纳入唤醒后才到期的记录。每页重新授权，错误不能变成空页成功；各页已提交的请求不回滚为“从未受理”。超过有限扫描上限显式不可用，不声明所有记录已处理或无漏触发。扫描前权限不满足时零日期值读取；没有新增读取任意字段的能力。

同页预算耗尽只停止剩余准入，保留本页先前合法request/receipt/outbox，返回显式budgetExhausted；它不代表扫描完成。数据库错误、撤权、过期或取消仍使当前页整体回滚。日期值仅接受100–9999年的合法日历日期，date限定YYYY-MM-DD，dateTime/effectiveAt须带Z或明确offset，避免Date.UTC对0–99年及本地时区解析的隐式转换。历史scanIntervalMs仅原样保留，不控制扫描节奏或授权上限。

## 3. 持久事实与执行重验

日期准入与 read request/outbox 在同一事务保存私有、不可变的 activation/recordId/occurrence→request 关联；不在公共 payload/历史DTO加入日期值。grant/请求唯一键继续约束同一次唤醒重投与并发，不能只在内存去重。

入队后的请求按已持久证明的到期事件执行，不用后来日期值重新解释或改投项目。claim、每次源 IO checkpoint、发布结果仍重验当前 owner/admin、tenant、权限、schema/type、规则/来源版本、activation期限及预算。撤权、schema变动或配置变动拒绝；只读输出仍是有限状态/计数、canApply=false、无 apply token、无业务写/发送。

尚未入队的日期扫描有既有48小时窗口，不承诺无限 catch-up 或端到端恰好一次；已入队后复用原 durable worker。outcome_unknown 不自动二读。

## 4. 数据库与回滚

新增独立迁移，不重写已存在的 cron/interval migration；日期确认与私有准入关联有闭集形状、唯一键/关联和不可变约束。旧 activation 字节和用途保持不变。存在日期历史时 down 拒绝，不删除历史或清空关联以凑回滚。迁移先于新代码；部署及真实锁影响验证另批。

## 5. 验收

必须包含：真实日期配置/字段类型；无授权零记录值读取；当前隐藏字段/行级限制/撤权拒绝；schema/type及规则ABA；授权前、未来、窗口外、非法日期；时区与闰日；同刻不同record、同日漂移、并发/重复/COMMIT回执恢复；取消/停机排空；旧cron/interval不升级；关联缺失/伪造拒绝；真实owner HTTP/面板→scheduler→准入→native合成预览与业务快照不变。

单元、真实PG、HTTP/DOM及有限变异分别记录，先证明真路径，再证明降级致红。只使用owned合成数据库；历史稳定性和Windows旧恢复限制不因本片通过而销账。尚未完成的项不得写成已交付。

SA06AS阶段先分别验证真实owner HTTP→scheduler→native合成链与日期面板jsdom，当时日期Chromium同链未完成。该阶段完整authority122/122、新日期PG16/16、旧schedulePG126/126、unit649/649与前端807/807均通过，六个有限降级被拒绝；前端扩大lint集合仍有基线诊断，不报全绿。命令、首次失败、33＋1项列举hash、CI接线统一记录于CodeWT `docs/development/automation-integration-read-primitives-verification-20261001.md` §51；本记录不代表远端CI或部署许可。

SA06AT补齐真实日期owner面板的Chromium同链，冻结版完整authority123/123、零跳过；精确DOM定义/预算与POST日期确认、真实日期receipt/队列/native preview、完整业务表快照不变均已验证。三项有限内存降级由实际DOM断言/HTTP409/typed生产拒绝捕获；最终types/所选lint及provenance/66pin通过，临时PG清理。仅改测试/helper/本地runner，13个所列生产文件字节不变，详细边界/11项列举hash归同报告§52和目标§105。隔离挂载生产面板不等于完整应用登录/导航，真实createRule创建规则不等于日期编辑器DOM验收；历史限制及外部执行授权原样保留。
