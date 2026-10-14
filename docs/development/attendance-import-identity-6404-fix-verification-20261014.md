# #6404 / #6400 身份解析修复验证

基准日：2026-10-14。基线 PR head e264eb952210ae8591210314db45795ad70c1bfd，main 2fc0527bd6。用户批准修复和隔离验证；没有批准合并、部署或启用。设计约束见 `attendance-import-identity-6404-fix-design-lock-20261014.md`。

## 已实现

新增独立 CJS 身份模块；严格活动成员过滤不随别名字段兼容性降级。跨字段、全角、尾部空白及数据库 locale 差异按 JS 规则终判，不遗漏历史多 owner；正常与碰撞密集输入均线性构建、最多保留两个不同 owner。Scope 授权与执行复用内部 Map，raw profile 不被改写；CSV/rows 混合输入按执行原有优先级统一授权与大小估算。Warnings 和数据库错误保持固定解释。模板新表头与回退行为保留，手改/非法 JSON payload 不被覆盖。

新真实 SQL spec 接入 required Node 20 考勤主矩阵、unit exclude、考勤本地脚本和 EXACT CI corpus；原有测试链保持并集。没有新增数据库迁移或 flag。

## Mac mini 合成隔离证据

| 检查 | 结果 |
|---|---|
| 3 文件核心单元 | 协调后 183 PASS / 0 skipped；含三入口 UUID/邮箱/用户名/手机号正控、拒绝零写、混合源与空 CSV 大小回归 |
| 3 文件邻近单元 | 23 PASS / 0 skipped；导入权限、raw evidence 与 calculation graph |
| 4 文件前端 | 79 PASS / 0 skipped；回退文件 BOM/内容和 payload 原值保护，picker/prefs 不减断言 |
| 真 PostgreSQL SQL | 15 PASS / 0 skipped；现代/缺可选列、必需授权列缺失、NULL/停用/其他组织、Unicode 与格式化手机号碰撞 |
| 真 HTTP 完整集成 | 完整文件 167 PASS / 0 skipped；含邮箱预览/提交/未知邮箱跳过/批次撤销，scope UUID/邮箱及范围外 403；大 payload 保留 5001 行/500 活动普通员工，实际写入 5001 条、零失败行，幂等及回滚通过 |
| 全新迁移及重放 | 两轮 HTTP 场景均 exit 0；owned 集群已停止，源文件状态未漂移 |
| 守卫 mutation | 在独立副本去掉活动过滤或歧义拒绝，各产生 6 个真实 PG 断言失败；匹配目标反例，无 lookup failure；原模块 SHA 未变 |
| SQL inventory + CI wiring | 完整 63 + 294 = 357 PASS / 0 skipped。首轮缺 PyYAML，隔离 runtime 补齐后全部通过；不修改或豁免守卫 |
| validate/provenance | `pnpm validate:all`、sealed-export-package-provenance test 均 exit 0；lint 为仓库 curated 范围 |
| 独立复审 | sol 6.1 high 实现；Astra ultra 实际 JS/stub 29/29 PASS，无范围内未解决源码阻断；其探针不替代真实 PG/HTTP |
| 最终 CI | 推送后重跑 13 项必需检查，以当前 PR 和最终交付 MD 为准 |

生产模块 SHA-256：`4ede4bbb81ee81ede5e06d567688d177f048268b4e3bec6c28431056d12da3d1`；index SHA-256：`f6958ca663605da39ed8c68df05804b50ce932d3a75308ed71e85a38b30eef3c`。

## 失败迭代与边界

首轮新混合源正控夹具遗漏既有 SET LOCAL statement_timeout 查询，补完整 exact fixture 后全量单元通过；没有吞未知 SQL。两处前端旧表头断言遗漏 UserId，补齐完整数量/字段断言。首轮 HTTP 新用例遗漏 tenantId=default，已用正确认证组织测试批次撤销；H1 负控改为该作用域已有可用的精确状态/错误码断言，不改生产权限。

#6400 原邮箱 CSV 故障已在隔离环境用真实 HTTP 验证修复，不代表原上机包已更新。Issue 保留，不用 closing keyword 自动关闭。

#6051 的认证组织 selector 绑定及 worker 写前会员锁仍未合入 main。本次 alias lookup 不能替代它们；发布前需另行批准合入 #6051，再对齐 #6404 复验。没有触碰实际业务环境，所有合并、部署、启用仍先批后动。

## 远端更新协调

推送时远端新增 `28931ad9e5`，已普通合并保留提交历史，不强推。该提交的 opaque ID 直接透传无法通过真实 W4 UUID 写入约束；本修复保留严格 canonical 输出，未知文本 ID 为无效行/跳过，不声称旧文本 ID 可写。前端仍保留服务器 CSV 优先、网络故障回退和手改 payload 保护；远端正文所述与实际删除回退的源码差异已复审。协调后的源文件与 CI 证据以最终验证 MD 为准。

协调后新增 1 个 resolver 及 3 个 scoped 路由回归，核心三文件共 183 PASS；commit/legacy 正控调用真实 W4 UUID parser。Astra ultra 对最终协调差异复审 PASS，生产模块及 index 哈希与前一验证轮相同。

## CI 首轮收尾修正（2026-10-15）

`f3ddaa7cf8` 的 12/13 必需检查通过；Node 20 的后端全套唯一失败是 W7 清单漏登新身份模块（21115 PASS / 1 FAIL，1751 为既有跳过，不算通过）。新模块现已加入 `CALCULATION_PATH`，两项 aggregate 禁止规则均适用，未添加排除。既有真实扫描正控增加该模块，分别证明违规 require、HTTP 调用及两者组合都会被发现。Mac mini 的守卫与身份/路由三个文件共 175 PASS、零 skip。清理步骤的连接拒绝是前序失败导致 PG 尚未启动；没有放宽 workflow。最终 CI 在补齐登记的新 head 上重新运行。

## 完整 HTTP 补验与夹具修正（2026-10-15）

完整 167 项补验首轮 166 PASS / 1 FAIL：大 rows 用例的 500 名员工是不存在的非 UUID 文本标识，因此本修复按安全语义将它们跳过，processedRows 为 0。该用例的目标是大 payload 完整保留，不是允许未知标识写入；现使用随机 UUID 的真实活动普通成员，复用已有种子与清理登记，保留 5001 行/500 人规模。断言加强为 processedRows=5001、failedRows=0，并直接查询批次实际写入 5001 条记录；幂等重试和 rollback 200 保留。Astra ultra 只读复审 PASS。

在全新自有 PG 集群迁移及重放后，整个文件 167 PASS / 0 skipped（测试 252.931 秒）；集群已停止，源文件状态未漂移。自有隔离数据库及日志保留，不声称业务历史被物理删除或吞异常的既有 fixture 清理零残留。测试 runtime 的 Git 基线为 e264 加同步修复源文件，不能冒称 clean 的最终提交；生产两模块哈希和同步测试文件作为对应证据，最终 Git 合并树由 CI 验证。

`3c1a47e91e` 的 CI 在本地发现该已知后续失败后主动取消，不能计为 13/13 全绿；该轮已通过后端全套、drain 和 checkpoint。最终验收只使用夹具修正后的新 head 全套 CI。
