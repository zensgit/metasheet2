# 钉钉单账号登录身份受控修复：设计与验证

日期：2026-11-02（Asia/Taipei）。独立 Draft 交付；未合并、部署、真实扫码、绑定、解绑或企业切换。未使用 Mac mini。

## 问题和范围

当前登录应用与历史目录应用可能不同，旧身份不能解析当前扫码者。重新绑定旧目录成员会再次写回旧标识；自助绑定又正确拒绝目录托管用户。不能靠显示名、邮箱相似、开放自动建号、关闭目录保护或抢占另一个管理员账号恢复登录。

本补丁提供仅受控主机／数据库运维人员使用的 CLI，优先复用现有密码哈希校验、OAuth profile 读取、用户访问图锁、加密存储、generation fencing 和会话撤销登记。没有新增公开绑定 API，也没有变更现有自助绑定和交接摘要规则。

基线：`f485ccae0d0a5735be2c395c81f8834ca3b657b3`。当前线上问题仍未执行真实修复；本补丁不是线上本人身份已核实的证明。

## 流程

1. `verify`：目标账号本地密码 + 当前应用新鲜授权码，同时检查有效平台管理员、目标启用／激活、本地密码可用、现有登录授权 enabled、唯一既有钉钉身份、同企业。复用提供方认证，要求 Open ID／Union ID 完整。返回五分钟 AES-GCM 加密证据，只写指定的 0600 新文件，不产生本地会话或业务写入。
2. `preview`：验证证据用途、时效、当前企业／应用、账号权限及绑定快照，检查另一账号占用、活动修复及未解决撤权副作用。只读业务状态，返回摘要，不自动接受漂移。
3. `apply`：精确 `confirm=apply` 和管理员批准摘要；重新加锁及复核。单事务更新该用户的登录身份、写加密旧身份审计日志及一次性 nonce，推进访问 generation。账号 ID／角色／权限／目录链接／审批／待办保持不变，不创建或启用登录授权。
4. `rollback`：精确操作确认和 apply 后摘要，权限、身份或链接有变化即拒绝。原身份与日志状态在单事务恢复，generation 单调推进，使用既有撤销登记失效该账号全部当前会话。恢复后的密码登录通道可重新使用。

双重控制权证明并不自动证明旧目录错配跨应用标识属于同一个人：运维仍须由本人和管理员确认正确目标。CLI 的 actorId 是受控运维身份留痕，不是公共接口凭空信任传入的管理员 ID。不得将此 CLI 直接包装成公开 API。

输入文件要求常规文件、0600／无组和其他用户权限、最大 64 KiB，严格字段集；证明输出不覆盖已有文件。凭据／授权码不放命令行。错误仅输出固定拒绝码。verify 会向当前配置的钉钉提供方交换一次授权码；真实执行同样需要事先明确批准，失败后的授权码不重放。

## 防旧来源覆盖及撤权边界

新增迁移 `zzzz20261102150000_dingtalk_login_repairs` 建日志、活动用户唯一索引及身份 INSERT／UPDATE 守卫。活动修复记录固定新的企业、Open ID、Union ID、external key、provider 与 local user ID；旧目录同步／重新绑定写回旧身份时拒绝整个事务。

修复推进 users tuple/generation，守卫对同一 users 行 FOR SHARE；旧 REPEATABLE READ 快照不能漏看日志后覆盖身份，必须 serialization-fail。

守卫允许正常同人 profile／登录遥测；**不阻止授权关闭或删除身份**，避免妨碍撤权。删除后旧来源重新插入旧身份仍拒绝。发生这类后续变化，自动回退拒绝，不能重新启用已撤销的授权。

活动 pin 保持到批准回退；没有自动释放或 finalize。旧来源写入被拒绝可能导致其整批同步事务失败，需要运维另行处理旧来源；不得自动关闭守卫、迁移目录或打开同步。非空修复历史时迁移 down 拒绝，不能降级到缺少此守卫的旧运行版本。

## 锁、审计与会话影响

复用 canonical 用户锁；现有部分角色写入未参与同一用户 mutex，因此少见的运维事务对相关权限／身份表使用 SHARE ROW EXCLUSIVE NOWAIT，失败立即拒绝。该锁会影响其他组织的相关写入，应单独维护窗口；lock_timeout 5 秒、statement_timeout 30 秒。

旧身份加密保存，密码、权限内容只参与摘要不写入日志。日志记录创建／回退 actor、时间、nonce 和摘要。应用及回退推进 generation，原 generation 不倒退。**apply 使原访问 generation 的会话失效；rollback 撤销目标账号全部当前会话（包括密码登录会话），不只本次扫码会话。** 执行前必须告知影响并批准，不能声称仅撤一个会话。

权限变化、其他账号占用、同一证明重复消费、并发抢占、摘要漂移、未解决撤权副作用或企业变化均失败关闭。不会绕过 E4 在途审批交接阻断，也不会更改产品交接摘要。

## 运维命令（仅说明，不授权执行）

在批准的运维窗口、正确构建及专用加密材料环境中：

```sh
pnpm ops:dingtalk-login-repair verify /restricted/verify.json /restricted/proof.json
pnpm ops:dingtalk-login-repair preview /restricted/proof.json
pnpm ops:dingtalk-login-repair apply /restricted/apply.json
pnpm ops:dingtalk-login-repair rollback /restricted/rollback.json
```

verify 输入：userId/password/code/actorId。preview：proof。apply：proof/digest/confirm。rollback：id/actorId/digest/confirm。不得在聊天、PR、日志或命令行中传递实际密码、授权码、证明或身份标识。

## 本机合成验证

环境：Node 20.20.2、独占临时 PostgreSQL 15，仅回环地址、三个新建合成数据库；提供方认证仅测试桩，无 Docker／SSH／线上／Mac mini 调用。依赖复用已有安装，无安装升级。首次 PG 初始化遇沙箱共享内存限制后，在获准本机隔离范围内重启初始化。

最终新库完整迁移安装及重放通过；仅排除仓库既知 Draft backfill `zzzz20260919090000_create_approval_template_group_backfill_batches`。本地最终库台账 461 项；不沿用 staging 台账。

九文件真实数据库组合 **201 项通过，0 失败／跳过**：原目录／权限／审批八文件 185 项，加本功能 16 项（含 DB 必须存在哨兵）。本功能覆盖核验／预览零业务写、真实 bcrypt、密码／管理员／启用／授权拒绝、合成提供方异常、跨企业／跨应用／过期证明、另一账号冲突、OAuth 服务解析到原账号、实际目录重新绑定被 guard 拒绝、角色和审批记录严格保持（实际待办服务仍返回可操作条目）、权限漂移拒绝回退、会话撤销生效、并发 apply 一成功、故障注入整事务回滚、旧 RR 写入拒绝、撤权删除允许但旧身份重插拒绝、非空日志拒绝 migration down。

TypeScript noEmit 和定向 ESLint 通过。测试文件已登记现有 approval real-DB CI，并排除无 DB 单元套件，未降低任何必需检查。

复现（在独立本机合成数据库迁移完成后）：

```sh
# DATABASE_URL 仅指向本机合成库；设置 DB_SSL=false、EXPECT_DB=1。
cd packages/core-backend
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/dingtalk-login-repair.db.test.ts
../../node_modules/.bin/tsc --noEmit --pretty false
../../node_modules/.bin/eslint src/auth/dingtalk-identity-repair.ts src/db/migrations/zzzz20261102150000_dingtalk_login_repairs.ts scripts/dingtalk-login-repair.ts
```

准确的冻结 head、CI 结论和完整组合命令以 PR 及本地 FINAL-VERIFICATION.md 为准；本地绿不等于当前 head 的 13 项必需 CI 全绿。

## 未执行／限制

未做真实扫码、本人确认、线上读写或真实绑定；未验收新镜像／正式包，不构建候选、不发布镜像；未执行 staging 升级、E4 交接、审批处置、退役或同步。没有迁移旧身份数据或批量补角色。

当前 first-login 可能改变权限摘要的产品风险继续保留；本流程遇到权限漂移拒绝 rollback，不重新计算摘要强行回退。上线前仍需独立复审、CI、完整迁移台账及维护窗口／备份／会话影响批准。
