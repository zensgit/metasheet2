# 宜搭本地目标与不可变预演身份

日期：2026-10-09；基线 afd32b704c6ff4c82dbfe90b94066fcaf3fc0074 当前候选。T层内部机制决定 `Ratified-by-default-2026-10-09`。仅本地代码与合成测试，不批准在线消费者、真实读取/发送或部署。

## 目的与不能证明的事

现有 planner 产生本地业务键与data-only预演，不产生持久operation/row身份。规则模板主动剥离目标/数据；旧内部runner的operationId/rowKey由调用者传入。新增机制将完整预演输入和结果冻结入库、服务端生成身份，并支持重新计算核验。不是远端组织/表单归属证明，状态始终 `unverified / local-unverified / canSend:false`。

091新增四表：本地targets、不可变operations、rows及审计。没有修改088/089/090或PLM/K3权限，没有读取凭据、调用token、插入发送账本、runtime注册、网络默认实现或环境开关。所有普通UPDATE/DELETE/TRUNCATE拒绝；未来保留、清理和迁移上线须另裁，不能把删除本地历史用作重复发送恢复。

## 输入和真实计算

闭集输入 `{config, rowsText, allocation}`，config只收现有v2；原样模式是 `{mode:'original'}`。按实际 `parseYidaStaticRows + buildYidaStaticPlan` 整批计算，不能逐行计算后漏掉跨行重复。整数/精确小数均分使用实际 `buildYidaProjectAllocationPreview`，保存完整项目列表、设置和原始行文本，不重新实现分配。

0行、无效行、重复键、不整除或展开超限不能保存成有效操作。实际planner原有100行/128KiB等限制保留；另设输入2MiB/depth12/20000节点、计算输出4MiB/depth16/50000节点上限，超限明确拒绝、不截断。不声称支持所有理论UI配置组合。先拒绝Proxy/getter/稀疏数组/环/非有限数/负零，再用现有strict canonical codec复制并冻结，避免规范化掩盖非法值。

## 本地稳定身份

- locator仅取规范化appType/formUuid，服务端计算SHA256；唯一域为tenant + 显式workspace + locatorDigest。owner、凭据代次、业务键定义、计划版本不能分裂同声明目标；同域不同owner固定冲突，不暴露原owner。同租户不同workspace仍是不同本地域，**不宣称物理form跨workspace全局防重**。摘要不是凭据，也不是远端真实性证明，不放进普通投影。
- targetRef服务端UUID，第一次登记固定业务键定义：`yida-protocol-v2`算法、映射后的目标字段ID/类型/空键等价策略，按目标ID排序。源别名、输入键顺序不能改身份；改变定义拒绝，不能另建同目标版本绕开089。没有用客户端org字符串或token成功伪装核验。
- 每行businessKeyDigest取实际planner localBusinessKey的SHA256；预演payloadDigest取intent/formUuid及canonical data-only DTO。**它不等于**旧runner包含grant/期限等内容的执行payloadDigest。
- planDigest取locator/固定键定义/intent与按业务键排序的行摘要。源别名、行排序和凭据轮换不产生新operation；实际payload变化新建操作但保留同target与业务键域。首次快照保留完整source/config/分配输入和actual plan，内容相同的后续保存返回首次operation及rowKey，不覆盖快照。
- operationId/rowKey均服务端生成；index仅是冻结快照中的位置，不是身份。新operation不能解释为获准重发；未来真实消费者还必须经过独立授权和089历史占位。

## 加密、事务与内部API

`createYidaDraftPlanStore({db,security,context:{tenantId,workspaceId,ownerId}})` 未注册；context必须来自未来可信宿主，不由请求体/header声称。宿主security必需，复用平台enc，不读明文/v1；目标和操作封包分别绑定purpose/schemaVersion/精确scope及server IDs。平台主密钥重包尚未覆盖新表。

- `createDraft(input)`：实际编译在任何持久化前；READ COMMITTED事务先锁声明目标，核owner/固定键定义，查同计划。不存在则一次提交目标/操作/全部行/审计；相同则读验证原快照并复用。只对精确目标唯一索引23505允许回滚后的新事务重读一次；不在aborted事务查，不把COMMIT丢回包当回滚或自动重建。
- `inspect({operationId})`：不可解密/投影未经精确父target scope/owner行锁校验的操作。子表FK且引用不可变；没有workspace回退/admin旁路。
- `replay({operationId})`：解封完整source，重新跑实际planner，核目标/planDigest、完整plan以及全部行数量/index/业务键/载荷摘要，再输出values-free计数和server IDs。持久结果不是受信的预计算授权对象。

三个方法均不返回原始config/行、payload、locator、摘要、凭据、token或权限标记；不能提升状态。审计仅身份/固定事件/DB时间，业务数据加密。普通结果始终不可发送、不可应用、未发token/未外写。scope相等和成功重演都不等于数据来源权限或执行owner批准。

## 验证和后续门槛

Node验证严格输入/真实compiler三种模式/别名及行序复用/固定键域/密文封包。真实owned PostgreSQL验证并发相同目标、跨owner唯一性、审计或子行失败整事务回滚、COMMIT回包丢失、真实host加密、不可变DML与重演。真实guard断线需先证明进入生产路径，再观察行为致红；失败日志不展开原数据或token。

新增runtime消费者、远端核验方式、有限发送grant与最后授权至socket的线性化仍待GOV-08。当前本地未核验目标不能直接升级为远端可信target；旧账本无法反推归属，不猜测回填、合并或删除。暂不发布/迁移部署；最终目标仍包括业务收据、未知结果恢复与客户授权验收，本片不以离线草稿替代它们。

## 本地完成证据及限制

实现见目标文件§127和当前candidate `artifacts/yida-draft-20261009/verification.md`。381路径manifest `037641f3befe727fcd37ecbf17da98c72325cf0a166eeb4051a79dded08c79c4`：正式provider457迁移+重放、四完整PG文件307/307、Node220/220、链门4/4与四测试strict TSC通过，五组实际ESM降级被行为断言捕获。不存在新在线消费者、授权或外发。

同版本重放不校验/自修预存同名错误索引；任意DDL漂移/恶意DB管理员不在当前威胁保证内。输出预算门没有自然可达合法输入打满的变异证明。审计降级原始PG日志包含合成UUID/时间/schema，仅本地诊断，分享使用固定码/计数摘要；未来Node失败断言也可能打印合成预演，不能泛称原始失败日志都values-free。
