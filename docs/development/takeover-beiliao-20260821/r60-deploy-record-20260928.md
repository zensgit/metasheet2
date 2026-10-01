# R60 上机记录（2026-09-28，旧机/运维机）

> values-free：不含主机地址、口令、令牌、项目号；只指位置与计数。演示机 = 222（地址在运维机 ssh 配置）。承接 `handoff-r59-two-machine-20260924.md`。

## 1. 结果

| 项 | 值 |
|---|---|
| 包 | `583dfdf1a`（tag `onprem-r60`，= #6131 合入提交；按开发机 09-28 09:01 指示，复制数据表 S1 #6116/#6112 留 R61） |
| CI | run `36404197524`，`expected_sha` 由 CI 复核 |
| 迁移 | r59 之后 6 条，按名核对 6/6（`kysely_migration` 共 421 行）；复制数据表两条 = 0 |
| 升级 | 子进程经 WMI 在 ssh 会话外运行 160 s；473 个插件文件哈希 OK；`pm2 restart not found` → #6071 回退自动接管（启动 `MetaSheet-PM2`、`pm2 kill` 会话内空守护、第 7 次探测应答、维护标志自动撤除）；维护页约 2.5 分钟 |
| 验证 | 后端 200、nginx 200、前端 smoke PASS、#6078/#6065/#6039 标记 True、`app.env` 逐字节未变、远端 PowerShell 错误记录 0 |
| nginx #6097 | `location = /index.html` no-cache 已加：`GET /` → `no-cache, must-revalidate`；`/assets/*` 仍 30 天 |
| 密钥 | `ENCRYPTION_KEY`/`ENCRYPTION_SALT` 由 owner 授权在演示机本地生成并写入 `app.env`（各 1 行、64 hex；值未出现在任何会话）；`system_configs.is_encrypted` = 0 |
| PLM 源 | 重启后仍 S2d：新密钥被接受（缺失/默认密钥错误 0），但库内密码是旧公开默认密钥加密的，解密鉴权失败 → 只能由属主在 UI「数据源 → 凭据」重存（顺带换新密码）后恢复 |
| 备份 | `pre-r60-20260928-175917.dump`（2.65 MB）、`upgrade-backup-20260928-175924`、`nginx.conf.pre-r60-20260928-183312`、`app.env.before-key-20260928-112907` |

只读复核（#6067 Q0–Q6、#6125 错误码、1c Q2、健康快照、#6109 预检端点定位）结论见 #6079 09-28 回帖：记录 3 的两轮连锁 = 合法「删除→恢复→再删」，不是重复发出；#6125 路由失败行 `code = CONNECTION_CANONICAL_UNAVAILABLE`、`UNLISTED` 0。

## 2. 脚本形态（运维机 `metasheet-ops/releases/r60/`，不入库：含主机地址）

- `r60-build-and-ship.sh`：`build | ship | all | gates | resume <stamp>`。build 按 tag 取 sha、CI 打包、校验 sha256/gitSha/前端 base path、生成迁移名单；`local_gates` 在任何上传前跑字节/BOM/预检自测/版本/sha 门；ship 走 `ssh -n` + keepalive + 75 分钟上限，远端尾加 `; exit $LASTEXITCODE`，日志经 `redact()`（JWT、pg URL、中英 libpq 文本、IPv4、pg DETAIL/HINT 行、项目号）。
- `upgrade-222-r60.ps1`（纯 ASCII）：密钥预检（与后端 loader 同口径：trim → 去一对引号 → trim；重复键 / Machine-User 环境覆盖 → exit 3，什么都不动）→ pg_dump 按退出码 + 大小 + `pg_restore -l` 判 → **WMI `Win32_Process.Create` 启动批处理 launcher**（`chcp 65001`；日志、stderr、退出码哨兵各落文件）→ 轮询 PID + 哨兵 → 从文件读结果（共享读、大小写敏感过滤、丢 pg 详情行）→ 健康 / 标记 / smoke / 试拉。ssh 掉线用 `-ResumeStamp` 续收。
- `selftest-preflight.ps1`：从 wrapper 原文切出预检块，20 例 + EnvVal + 16 个变异（每个必须杀红），是 ship 门。
- `apply-nginx-6097.ps1`：字节级插入、候选先 `nginx -t`、reload 走与 `MetaSheet-Nginx` 同身份（SYSTEM）的一次性计划任务、reload 后验证头、失败自动还原。

## 3. 本次沉淀的教训（已进运维机记忆，值得进仓库文档）

1. **R59 18 分钟 503 的真机制**：wrapper 把升级子进程接在 `| Select-String | Select-Object -First 30` 活管道后，第 30 条匹配时 PS 5.1 杀掉子进程，`finally` 里删维护标志的代码没跑到；升级脚本错误处理里的 `pm2 stop` 又在会话里拉起默认 home 守护进程并继承了 stdout 管道，ssh 因此挂到 reset。`PM2_HOME` 只是第一跳。**远端长任务一律会话外启动 + 哨兵文件轮询。**
2. `Start-Process` 带重定向时 `.ExitCode` 恒 `$null`（先取 `.Handle` 才有）——升级成功也会被判失败。
3. 批处理里 `echo %ERRORLEVEL%>file` 是「句柄 7 重定向」，哨兵里没数字；写 `>file echo %ERRORLEVEL%`。
4. PS 5.1 + `$ErrorActionPreference='Stop'`：nginx / pm2 写 stderr 就是终止错误；判定用 `$LASTEXITCODE`，日志错误数用 `FullyQualifiedErrorId`，别用 `$Error.Count`。
5. `& cmd.exe /d /c ('"exe" args 2>&1')` 拼接在 PS 里会被再加一层引号、cmd 拆散后丢参数——干跑时因此真的启动了第二个 nginx 主进程并覆盖 `logs/nginx.pid`（已清理：停掉当天启动的进程、按父进程判原主进程、回写 pid）。nginx 直接 `&` 调用。
6. 现网 nginx 由 `MetaSheet-Nginx` 以 SYSTEM 运行，ssh 会话 `nginx -s reload` 报 Access denied；用同身份一次性计划任务 reload。
7. 预检读 `app.env` 要检测重复键：后端 loader（`ecosystem.config.cjs`）先出现者优先，朴素解析器后出现者优先；模板自带空的 `ENCRYPTION_KEY=` 行时「末尾追加真值」会让预检绿、后端读空值。
8. Workflow 工具里的代理是前台请求，用户一发消息就全部从零重跑；交互会话里的长核验一律后台 Agent。
9. `KeyLines` 类辅助函数返回单元素数组时会被 PowerShell 拆成字符串，`$m[0]` 变成首字符——调用处必须 `@()`（自测抓到）。

## 4. 待办

- 属主在 UI 重存 PLM 只读密码（客户 DBA 先换）→ 运维机手动触发 `metasheet-stock-prep-scheduled-dry-run`，预期 `400 CONNECTION_CANONICAL_UNAVAILABLE` → `200 ready`。
- 2b 混表清理：owner 已批「置无效」，等客户确认保留哪个项目。
- #6109 预检 `ownershipState`：owner 以管理员登录 `/stock-prep`「看看还缺什么」在 Network 面板读，或签只读探针令牌；不再借用定时试拉服务令牌。
- R61 = main 头（含复制数据表 S1，多 2 条迁移；**先迁移再切代码**）；打包用 `R60_REF`/`R60_DISPATCH_REF` 指向新 tag。
- 仓库侧：`docker/app.env.multitable-onprem.template` 空密钥行 vs #5711 守卫（owner 待定）；升级脚本第 2 步停服到变更窗口之间的错误无失败处理器（#6131 复核记下）。
