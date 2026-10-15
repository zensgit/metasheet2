# #6404 / #6400 身份解析修复验证

基准日：2026-10-14。基线 PR head e264eb952210ae8591210314db45795ad70c1bfd，main 2fc0527bd6。用户批准修复和隔离验证；没有批准合并、部署或启用。设计约束见 `attendance-import-identity-6404-fix-design-lock-20261014.md`。

## 已实现

新增独立 CJS 身份模块；严格活动成员过滤不随别名字段兼容性降级。跨字段、全角、尾部空白及数据库 locale 差异按 JS 规则终判，不遗漏历史多 owner；正常与碰撞密集输入均线性构建、最多保留两个不同 owner。Scope 授权与执行复用内部 Map，raw profile 不被改写；CSV/rows 混合输入按执行原有优先级统一授权与大小估算。Warnings 和数据库错误保持固定解释。模板新表头与回退行为保留，手改/非法 JSON payload 不被覆盖。

新真实 SQL spec 接入 required Node 20 考勤主矩阵、unit exclude、考勤本地脚本和 EXACT CI corpus；原有测试链保持并集。没有新增数据库迁移或 flag。

## Mac mini 合成隔离证据（迭代记录，最终协调以末节及最终 CI 为准）

| 检查 | 结果 |
|---|---|
| 3 文件核心单元 | 协调后 183 PASS / 0 skipped；含三入口 UUID/邮箱/用户名/手机号正控、拒绝零写、混合源与空 CSV 大小回归 |
| 3 文件邻近单元 | 23 PASS / 0 skipped；导入权限、raw evidence 与 calculation graph |
| 4 文件前端 | 79 PASS / 0 skipped；回退文件 BOM/内容和 payload 原值保护，picker/prefs 不减断言 |
| 真 PostgreSQL SQL | 24 PASS / 0 skipped；现代/缺可选列、必需授权列缺失、NULL/停用/其他组织、Unicode 与格式化手机号碰撞 |
| 真 HTTP 完整集成 | 完整文件 167 PASS / 0 skipped；含邮箱预览/提交/未知邮箱跳过/批次撤销，scope UUID/邮箱及范围外 403；大 payload 保留 5001 行/500 活动普通员工，实际写入 5001 条、零失败行，幂等及回滚通过 |
| 全新迁移及重放 | 两轮 HTTP 场景均 exit 0；owned 集群已停止，源文件状态未漂移 |
| 守卫 mutation | 在独立副本去掉活动过滤或歧义拒绝，各产生 6 个真实 PG 断言失败；匹配目标反例，无 lookup failure；原模块 SHA 未变 |
| SQL inventory + CI wiring | 完整 63 + 294 = 357 PASS / 0 skipped。首轮缺 PyYAML，隔离 runtime 补齐后全部通过；不修改或豁免守卫 |
| validate/provenance | `pnpm validate:all`、sealed-export-package-provenance test 均 exit 0；lint 为仓库 curated 范围 |
| 独立复审 | sol 6.1 high 实现；Astra ultra 实际 JS/stub 29/29 PASS，无范围内未解决源码阻断；其探针不替代真实 PG/HTTP |
| 最终 CI | 推送后重跑 13 项必需检查，以当前 PR 和最终交付 MD 为准 |

手机号补丁阶段模块 SHA-256：`23ba81dc1759c879696aedfd18ba6abcf796bd0e3b395ae61dee688b9b312dbb`；index SHA-256：`f6958ca663605da39ed8c68df05804b50ce932d3a75308ed71e85a38b30eef3c`。

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

## 手机号候选补验（2026-10-15）

等待 CI 期间发现 SQL 未覆盖 JS 既有的 country-digits / 带加号国家码等价规则。新增单独查询的国际号码、+86 短号码、非 1 开头本地号码正控与跨 username/mobile 碰撞负控。首轮 17 项中 2 项变红；进一步补验 24 项中 4 项变红。SQL 增加去掉加号的紧凑候选及去掉开头 +86 的候选，最终仍由原 JS 规则分类；没有扩展产品手机号语义。3 项无效加号号码测试证明数据库确实返回候选，而 JS 将其排除。

全新隔离 PostgreSQL 迁移和重放均 exit 0；最终 SQL 24 + HTTP 167 = 191 PASS / 0 skipped，集群停止。定向单元 183、前端 79 再次全部通过。Astra ultra 使用实际 JS 与 SQL 等价谓词模拟检查 7290 对输入，其中 219 对有效匹配均被覆盖；该源码模拟不替代真实 PostgreSQL。

## 37c CI 失败及压力夹具隔离（2026-10-15）

37c39084b7 的必需检查 12/13，通过旧 head 不作为最终验收。Node 20 考勤主矩阵有 8 项失败：两个 CSV 异步用例未完成/回滚 404，六个后续日历/打卡用例 30 秒超时；日志含真实数据库锁等待超时。新压力用例在共享 default 组织写入 5001 条后，撤销保留不可变历史，会增加后续全组织源校验成本。本地同一环境后续单项出现约 9–20 秒耗时，CI 更慢；隔离夹具以消除该干扰，不把锁错误当作可豁免超时。

压力用例改用随机自有组织及 UTC 默认规则；操作者和 500 名普通员工显式加入该组织；prepare、commit、retry、poll、rollback 使用相同组织选择器。5001 行规模、实际写入查询、零失败、幂等及回滚断言保留，查询加强组织条件。仓库 timeout 和生产时区源校验均未放宽，发布依赖 #6051 不变。完整主矩阵和最终 CI 以最终验证 MD 为准。

夹具隔离迭代：独立复审先发现 prepare/poll selector 与 actor membership 漏配，已补齐。真实 PG 再拒绝 prefix+UUID 组织键（W4C0_ROLLOUT_ORG_KEY_INVALID），现用 canonical randomUUID 组织键，不更改生产解析器。中止的 v6（误混入独立矩阵）、v7（本地启动 hook 超时）、v10（非法组织夹具）均不计通过；其自有 PG 已停止。最终本地完整矩阵只抽取 workflow 第一条命令的 128 文件，多时区第二条命令保持独立环境；本地启动 hook 180 秒适配 Mac，单项 testTimeout 仍为 CI 的 30 秒。最终 CI 必须在仓库原 15 秒 hook 下通过。

## 第二次远端协调（2026-10-15）

远端新增 3cef519159，正常合并保留提交历史。其输入派生的单字符 Unicode translate 漏掉 İ 的多字符小写、希腊 final sigma 上下文、ẞ 和 Deseret 字符；独立复审四类 wrong-owner 反例成立，现全部加入真实 PG 回归（SQL 总 28 项）。保留现代 schema 直接列查询及可选列缺失 JSON fallback，每次都保留用户及成员活动过滤；恢复非 ASCII 候选超集，再由 JS 终判。未采用输入 Unicode 条件裁剪，避免 Node/PostgreSQL Unicode 版本差异漏 owner；也保留完整格式化手机号候选。

未采用其旧 null-version 队列预事务 alias Map 缓存：此分支不作用于本次 V1 大 payload，不作为超时根因证据；移动读取时机扩大等待锁期间的撤权窗口。index 保持前一修复相同哈希，#6051 依赖不变。性能结论仅限实际合成演练，不把直接列查询视作并发授权绑定。

旧同步版本的完整 128 文件 Mac 演练 v11 已在 HTTP 167 PASS 后出现独立 CLI 工具用例失败；新远端协调使该版本不再是最终候选，因此中止并停止 PG，不计主矩阵全绿。最终协调版重新迁移/重放和定向完整 HTTP/SQL；最终 head 的 CI 负责验证完整主矩阵及独立多时区矩阵。

最终协调模块 SHA-256：`3dd6015bd8e20f55816eeb0cf1b15eed28da59f6c6bf3604339cf1fe8b6fbe65`；index：`f6958ca663605da39ed8c68df05804b50ce932d3a75308ed71e85a38b30eef3c`。独立源码复审 PASS；最终协调后的 28 项 SQL、完整 HTTP 与 13 项必需 CI 尚待最终验证，不沿用此前 24 项或中间候选的通过结果。Mac mini 连接中断期间不声称最后运行完成或集群已停止；恢复连接后检查 receipt 和停止状态，再补验最终源。

## 压力成员收尾（2026-10-15）

深读 calendar settings writer 证实，它枚举所有组织并校验活动成员，只有组织隔离仍会扫描压力历史。9ee 干净源虽然本地 HTTP 全过，后续全局日历用例仍约 20 秒；不把组织隔离声称为全局扫描成本修复。压力用例在成功回滚后，仅将种子登记返回的 500 个自有成员关系设为 inactive，并断言更新数量恰为 500。5001 条记录及不可变 companions 不删除，生产源守卫与超时不变。正常身份与后台任务终态、写入及回滚断言均先完成；之后让这些合成压力成员退场，避免干扰后续无关语义测试。最终验收在此新提交上重跑。
# 2026-10-15 latest-main combination addendum

Normal merges include #6407/#6408/#6409 and main `d1e77dd41c` (#6398/#6402), with both workflow/config test chains retained. Candidate `97c8fd043b` passed all 13 required checks on the earlier `fa784a2d9f` base; that evidence does not cover #6398.

On the new combination, the Mac mini run passed 397 core and 430 frontend tests (23 web files). Fresh migrations and replay passed. The four-suite PG/HTTP run passed 254 tests and failed one governing-SHA golden: only the completed public job's elapsed time and throughput differed from frozen zero. The rollback suite passed. Wall-clock timing can legitimately be positive while the fixture freezes Date; this is a timing-sensitive test projection, not evidence of a rollback regression.

The test-only repair checks finite/nonnegative integer duration and row count plus the exact two-decimal throughput formula before normalizing only the completed public job's two timing fields. The committed golden bytes/checksum and every other field remain locked. Numeric and formula negatives, guard mutations, the full PG/HTTP combination and final-head CI must pass before final acceptance. No production code or timeout changes are part of this repair. Final exact-head results belong in the final verification MD and PR evidence after execution. Merge, deployment, backfill and enablement remain owner-gated.
