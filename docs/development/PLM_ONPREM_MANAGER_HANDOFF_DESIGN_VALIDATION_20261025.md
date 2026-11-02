# On-prem manager 与新登录 token 交接：设计验证（2026-10-25）

状态：shell 契约验收通过，未完成实际安装或产品整链验收。保持 Draft。

源码提交 `908126779a345f65d484457154e37fca95c374a1`，基于实时核对的 main `8a426818804897a20f7674c39c56b3a445909c3a`。脚本路径 `scripts/ops/multitable-onprem-deploy-easy.sh`，SHA256 `1894f187dee638fdedb548d7885f117fdd35fac25464c802287a7ff3c6e82865`。一次收尾文档 SHA 由外部状态记录，不自引用。

## 触发与行为

调用者指定 SERVICE_MANAGER=none，原 deploy 脚本在两条最终 health 分支都改为 auto；实际下游 health 因而可能探测共享 PM2/systemd。另一个问题是 bootstrap 后第二次登录取不到本次 token 时，默认 VERIFY_LOGIN=1 仍可进入弱化的无 token health，或继承外部 AUTH_TOKEN。

两条最终 health 现在原值透传 manager；默认或显式 VERIFY_LOGIN=1 必须取得本次 HTTP200 登录返回的非空白字符串 token，否则在 health 前失败。非字符串/空白结果不转为字符串；合法字符串保持原字节，不发明 JWT 格式规则。实际签名、用户权限仍由真实产品端点校验。

显式 VERIFY_LOGIN=0 的有限旧模式保留；其无 token / 继承 token 分支不能算本次登录、个人授权或完整安装验收。此改动只涉及安装管理员会话交接，不创造 Yuantus 业务授权。

## 与已有 provider 及 main 的关系

已交付的固定 provider `02b2151aa19559996dfbc9f9bf53f5c47e489173` 包含 API readiness barrier 和 executable-only 日志脱敏，脚本 hash 为 `2cd32b9bf2d9dfc609e98d891fb62db4ba43e83b243ea77b3d245adfdc6c37fe`。这些旧 Draft/不可变证据保持。main8a 尚未包含该脚本及两份既有测试的完整变更，本分支基于 main 保留这些已接受的契约；没有用旧 main 脚本替换并丢失它们。

相对已使用的02b脚本，新逻辑仅 decoder 类型/非空白检查、required fresh token guard 和两处 manager 赋值。五个源码/测试/CI文件：一个 deploy脚本、原readiness/private-log两测试、新manager-handoff测试和既有Node20 workflow。旧private-log测试逐字不变；readiness只把登录 fixture 的空JSON补成有效合成token，原断言和VERIFY_LOGIN设置不改。CI保留旧权限/门槛，增加新文件路径触发及实际三文件 node --test。

固定产品源码仍是 Meta `0cae1b88b3961bfcc718a63a3ead185e98c7bc81` / Native `117a310a955203248f48d101fa5beae5f0ee2e10`。当前包若消费新脚本，必须另行用本真实 Source/hash 生成显式 provider overlay 和新 manifest；不得重贴旧 archive/workspace/packet。Native DEFAULT legacy02b 兼容及镜像门禁不在此提交中改变。

## 真实验证与计数归属

| 验证 | 结果 |
| --- | --- |
| Root 保留02b基线两文件 | 8 PASS / 0 SKIP，4569ms |
| 作者改 shell 前的行为反例 | 59例：3 PASS / 56 FAIL / 0 SKIP，46865ms |
| 作者修复后真实三文件 | 68 PASS / 0 FAIL / 0 SKIP，36981ms，含旧8例 |
| 作者针对性变异 | force-auto、删除fresh guard、恢复String(token)均被杀死；过滤运行的58/59个pattern skips不冒充全量0skip |
| 独立审阅 | 28组自有真实shell控制及原8项readiness/privacy通过；与作者计数分开 |
| Root额外实际下游health控制 | 6组通过：旧02b确有manager探测/继承token接受；新脚本none无探测、缺新token拒绝、错误feature mode仍拒绝 |
| 静态检查 | bash -n、shellcheck0.11.0、actionlint1.7.12、git diff --check通过 |

Node固定为v20.20.2，binary SHA256 `38de4fc456c0c439bac48c727d378f749abb4e31f4116703bb1ee9a746fccbb6`。命令为该Node的 `--test scripts/ops/multitable-onprem-startup-readiness.test.mjs scripts/ops/multitable-onprem-private-command-logs.test.mjs scripts/ops/multitable-onprem-manager-handoff.test.mjs`，PATH同样前置该Node bin。

作者最初一次新fixture的JS模板语法错误在有效行为RED前修复，没有将加载失败冒充产品反例。行为RED后新增一项正常字符串原字节保留正例，故最终新测试60、全量68。

Root的6组控制运行真实deploy和真实multitable/attendance health脚本、真实curl与Node JSON解析，目标是自有loopback HTTP；bootstrap/admin和PM2/systemctl是隔离替身。旧script探测仅命中fake manager，未触共享manager；所有临时HTTP/进程/目录均清理。这些测试不证明真实应用登录、数据库迁移、OS服务/镜像安装、完整动态依赖或生产可用。

Root创建新稀疏隔离树时曾出现空索引导致的staged删除；作者立即报告并停写。Root仅read-tree/index flags修正，五路径文件逐hash不变，未hard reset或覆盖；提交只包含核对的五文件。记录保留，不涉及canonical/Claude或旧工作树改写。

## 证据及未验收项

精简结果：[verification.json](../../artifacts/plm-onprem-manager-handoff-20261025/verification.json)。不可变packet manifest SHA256 `d23e84dcbb1ad0848911cfc7f248726b8928ae3aaa91f624a8edf63a67577315`；独立源码审阅 SHA256 `35d9969c78a631e23b503d83dfd45a8ad7f4558d6ce29207f6051507d5a61ce9`；Root实际health控制 SHA256 `4c9911f6e564e3dfe5b4a9685e83669876f53d621e57e92572ef3cb9901929e3`。本Source尚未推送，remote CI为NOT_RUN，发布后必须核对准确head。

实际解包backend/SPA/API、依赖延迟路径、安装升级/健康、许可/迁移/备份恢复/停用、统一Yuantus入口、浏览器及长时仍需逐项真实验收。Docker503不通过伪造imageID或放开paired gate绕过。Stage A/RG/#249继续Claude HOLD，perf冻结，同collection再授权及ECO独立复核/合并口令不因本切片改变。无合并、部署、生产启用、真实业务通知或issue关闭。
