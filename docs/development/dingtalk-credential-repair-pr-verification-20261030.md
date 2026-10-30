# 钉钉群机器人凭据修复补丁：PR验证记录

日期：2026-10-30（Asia/Taipei）。基线：`a03d804d60d83717feaedce099e5ff14216afc58`。分支：`codex/dingtalk-credential-repair-20261030`。

## 交付与边界

本PR把已经完成固定范围演练和实际受控修复的核心工具纳入版本管理，包含明确的真实数据库测试入口与GitHub CI。它只更新两个群机器人存储字段；调用方仍须提供目标绑定、批准、私有计划和备份，不能从源码或CLI参数推断生产执行授权。

保留源码：

- `scripts/ops/repairs/dingtalk-group-credentials-20261030.cjs`：固定49行／97字段、4个独立应用密文canary、材料检查、数据库及scope绑定、目标表锁、逐行CAS、整批事务、原始字节保持、提交前解密比对、幂等零写、提交未知先verify。
- `scripts/ops/repairs/dingtalk-group-backup-restore-check.py`：要求TABLE与TABLE DATA，实际隔离恢复后验证scope；禁止自定义恢复代码项；活动连接清理及私有清理记录，失败阻止重试。

环境专用SSH入口、主机标识、批准记录、私有计划、业务ID、应用标识、密钥、原始凭据、密文、真实备份及scope／环境指纹均不在PR中。没有迁移、新运行开关或启动时自动回填，也不改变现有通用回填CLI的调用行为。

本PR保持Draft，合并、部署和其他线上变更另批。本轮仅整理PR及运行CI，不再执行生产修复，不恢复推送。

## 冻结源码与历史执行证据

| 文件 | 已验证源码SHA-256 |
| --- | --- |
| 修复核心 | `a81efd56a731378abfc3e5f7cd035cb106c15353d952a3b7ff27e9ebf90b4f98` |
| 恢复检查 | `7f4f0475ba3239770f3a86972c90be28878a6fccb3e117bf9fbdde5dd803c499` |

两文件与已通过Astra ultra独立复审及受控执行的源码字节相同。审阅曾发现的目标容器替换、备份缺少数据证明、包装器提交未知及临时恢复残留问题已经在该冻结候选中处理；环境专用入口不在本PR中，不能把本PR当作完整生产执行器。

此前实际操作单独批准完成：目标表49个URL和48个签名密钥已加密；原值一致性、真实运行读取器及HTTP200核验通过，临时恢复资源已清理。该历史操作不由本PR或CI执行，也不证明整个安全事项已关闭。

历史Mac mini合成隔离证据：

| 范围 | 结果与归属 |
| --- | --- |
| 核心真实PG回归 | 原补丁交付路径17项通过 |
| 原备份／执行入口 | 12项通过；含5项真实pg_dump／pg_restore场景，入口未提交到本PR |
| 交付路径恢复回归 | 原补丁5项通过 |
| 原6文件指纹 | 与Mac mini当时受测文件一致 |
| 本PR核心及恢复检查 | 与原冻结源码完全一致 |

历史测试不是当前PR head的CI结果。原恢复测试固定Homebrew PG16路径；本PR仅增加测试侧`PG_BIN_DIR`，默认路径行为保留，Linux路径与当前head由新CI复验。

## 本轮检查与Mac mini空档

Mac mini仍处于让出状态。本轮没有连接它，没有启动其测试、计时、SSH、同步、安装或环境变更。使用独立本地稀疏工作树以减少磁盘占用；没有安装本地依赖或改动原工作树。

本轮本地完成：冻结核心／恢复检查字节比对、Node和Python语法、工作流YAML结构与嵌入shell语法、diff空白检查。它们不替代真实数据库执行。

## 当前head CI

独立工作流：`.github/workflows/dingtalk-credential-repair.yml`，job `credential-repair (PG16)`。固定`ubuntu-22.04` GitHub-hosted runner、Node20、pnpm10.16.1及PostgreSQL16，不使用Mac mini、自建runner、SSH或任何应用环境。

- 实跑核心17项真实PG测试，缺`DATABASE_URL`必须失败，重试为0。
- 实跑5项备份恢复测试：49／97一致、schema-only拒绝、同计数错值拒绝、活动连接清理、删库失败仍清目录及拒绝重试。
- 使用当前PG16客户端；客户端或服务端不是16则失败。
- 上传合成测试结果；不上传真实计划、备份或凭据。

工作流复用仓库已有`ankane/setup-postgres@v1`方式，版本与用户设置依据[该action的官方说明](https://github.com/ankane/setup-postgres)。

当前head执行结果以Draft PR检查页和[本分支独立工作流运行记录](https://github.com/zensgit/metasheet2/actions/workflows/dingtalk-credential-repair.yml?query=branch%3Acodex%2Fdingtalk-credential-repair-20261030)为准；PR正文记录绑定head的结果快照。本MD中的历史17＋5或工作流定义本身不作为本轮CI通过证据。

## 后续边界

生产旧镜像的默认材料回退保护升级、生产／staging共享目录应用隔离、提供商侧凭据轮换、历史备份安全及演示机验收仍单独处理。应用此补丁或合并PR不会自动执行它们。未在本PR中重新出产品包或更新latest。
